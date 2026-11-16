#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using NUnit.Framework;
using OneLobby;
using OneLobby.Direct;
using OneLobby.Direct.Nostr;
using OneLobby.Unity;
using UnityEngine;
using UnityEngine.TestTools;
using Debug = UnityEngine.Debug;

namespace OneLobbyGame.Tests
{
    /// <summary>
    /// Two OneLobby clients in this one process, on 127.0.0.1 only (a direct host that listens on loopback, the WebRTC sockets bound to
    /// loopback, no Nostr, no public server): one hosts, the other joins by its address, and each sends the other one message. The test
    /// logs <c>MULTIPLAYER_OK</c> or <c>MULTIPLAYER_FAIL &lt;what&gt;</c>. Written by create-onelobby.
    ///   Unity.exe -batchmode -nographics -projectPath . -runTests -testPlatform PlayMode -assemblyNames OneLobbyGame.Tests -testResults R.xml -logFile L.log
    /// <c>create-onelobby verify</c> runs its other routes through this same test, with arguments after the Unity ones (Unity ignores them):
    ///   --route=config   load Assets/Resources/onelobby.json and print what verify needs
    ///   --route=direct   (default) two peers on 127.0.0.1
    ///   --route=nostr    through the local Nostr relay at --relay=ws://127.0.0.1:PORT
    ///   --route=turn     relay-only through the TURN login in --turn="turn:127.0.0.1:PORT user pass" (and --relay=... when Nostr is on)
    ///   --route=server   host and join by code on the lobby server --server=ws://127.0.0.1:PORT/ws
    /// A route other than direct logs <c>MULTIPLAYER_OK &lt;route&gt; ...</c> or <c>MULTIPLAYER_FAIL &lt;route&gt; &lt;what&gt;</c>.
    /// </summary>
    public sealed class MultiplayerTests
    {
        LobbyClient? _hostClient, _guestClient;
        Lobby? _host, _guest;
        string _route = "direct";
        readonly Stopwatch _clock = Stopwatch.StartNew();

        static Dictionary<string, string> Args()
        {
            var map = new Dictionary<string, string>();
            foreach (var a in Environment.GetCommandLineArgs())
            {
                if (!a.StartsWith("--", StringComparison.Ordinal)) continue;
                var eq = a.IndexOf('=');
                if (eq < 0) map[a.Substring(2)] = "1";
                else map[a.Substring(2, eq - 2)] = a.Substring(eq + 1);
            }
            return map;
        }

        [UnityTest]
        public IEnumerator TwoPeersExchangeOneMessageEachWay()
        {
            var args = Args();
            _route = args.TryGetValue("route", out var r) ? r : "direct";
            var limitMs = (args.TryGetValue("timeout", out var t) && int.TryParse(t, out var s) ? s : 60) * 1000;
            var run = Run(args);
            while (!run.IsCompleted)
            {
                // events fire on this thread; a client is pumped until it holds a lobby, the lobby after that
                if (_host != null) _host.Pump(); else _hostClient?.Pump();
                if (_guest != null) _guest.Pump(); else _guestClient?.Pump();
                if (_clock.ElapsedMilliseconds > limitMs) { Finish(false, "timed out after " + limitMs / 1000 + " s"); break; }
                yield return null;
            }
            // dispose both clients (their sockets close) before the test ends
            foreach (var c in new[] { _guestClient, _hostClient })
            {
                if (c == null) continue;
                var d = c.DisposeAsync().AsTask();
                var until = _clock.ElapsedMilliseconds + 5000;
                while (!d.IsCompleted && _clock.ElapsedMilliseconds < until)
                {
                    if (_host != null) _host.Pump();
                    if (_guest != null) _guest.Pump();
                    yield return null;
                }
            }
            if (_failed != null) Assert.Fail(_failed);
        }

        string? _failed;

        static string Describe(Exception e) => e is OneLobbyException ox ? ox.Code + ": " + ox.Message : e.GetType().Name + ": " + e.Message;

        // the result line is logged once; a failure is also remembered, and the test fails after both clients are closed
        void Finish(bool ok, string what)
        {
            if (_logged) return;
            _logged = true;
            var line = (ok ? "MULTIPLAYER_OK" : "MULTIPLAYER_FAIL") + (_route == "direct" ? "" : " " + _route) + (ok && _route == "direct" ? "" : " " + what);
            Debug.Log(line.TrimEnd());
            if (!ok) _failed = line;
        }

        bool _logged;

        async Task<bool> Until(Func<bool> cond, int ms = 20000)
        {
            var t0 = _clock.ElapsedMilliseconds;
            while (_clock.ElapsedMilliseconds - t0 < ms)
            {
                if (cond()) return true;
                await Task.Yield();
            }
            return cond();
        }

        // a random port in a quiet range, not the OS's next free one: Windows keeps blocks of consecutive ports back (Hyper-V, WSL, Docker), and the
        // next free port is usually inside one of them. A port that is busy or reserved makes the host say port_in_use; RunRoute asks for another.
        static int RandomPort() => new System.Random().Next(20000, 47000);

        // no settings store: two clients in one process must not share a player id; the WebRTC sockets are bound to 127.0.0.1 (nothing leaves this PC)
        static LobbyClient MakeClient(Blueprint bp, string name, Func<OneLobbyConfig, OneLobbyConfig> configure, string? server = null) =>
            LobbyClient.FromBlueprint(bp, new UnityTransport { BindAddress = "127.0.0.1" }, name, server, configure);

        async Task Run(Dictionary<string, string> args)
        {
            try
            {
                await RunRoute(args);
            }
            catch (Exception e)
            {
                Finish(false, Describe(e));
            }
        }

        async Task RunRoute(Dictionary<string, string> args)
        {
            Blueprint bp;
            try
            {
                var text = Resources.Load<TextAsset>("onelobby");
                if (text == null) { Finish(false, "no Assets/Resources/onelobby.json"); return; }
                bp = Blueprint.Parse(text.text);
            }
            catch (Exception e)
            {
                Finish(false, "onelobby.json: " + e.Message);
                return;
            }
            if (_route == "config")
            {
                var h = bp.Hosting;
                Finish(true, $"sync={bp.Sync.Mode} direct={h.Direct} nostr={h.Nostr} server={h.Server} relay_only={h.RelayOnly}");
                return;
            }

            // the TURN login, when the route has one: relay-only for both clients, and the server list goes to the host and the joiner
            IceServer[]? ice = null;
            if (_route == "turn")
            {
                var parts = (args.TryGetValue("turn", out var tv) ? tv : "").Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length != 3 || !parts[0].StartsWith("turn:", StringComparison.Ordinal)) { Finish(false, "the --turn value is not 'turn:HOST:PORT user password'"); return; }
                ice = new[] { new IceServer(new[] { parts[0] }, parts[1], parts[2]) };
            }
            Func<OneLobbyConfig, OneLobbyConfig> configure = c => ice != null ? c with { RelayOnly = true } : c;
            var relay = args.TryGetValue("relay", out var rv) ? rv : "";
            var server = args.TryGetValue("server", out var sv) ? sv : "";

            _hostClient = MakeClient(bp, "Host", configure, _route == "server" ? server : null);
            _guestClient = MakeClient(bp, "Guest", configure, _route == "server" ? server : null);
            if (_route == "server")
            {
                _host = await _hostClient.HostAsync(new LobbyOptions("verify", 2));
                _guest = await _guestClient.JoinAsync(_host.Code);
            }
            else
            {
                // loopback only: the listener binds 127.0.0.1 on a random port, public STUN servers are switched off, no router request
                var nostr = relay.Length > 0 ? new NostrOptions { Enabled = true, Relays = new[] { relay }, Stun = Array.Empty<string>() } : new NostrOptions { Enabled = false };
                var port = 0;
                for (var attempt = 1; _host == null; attempt++)
                {
                    port = RandomPort();
                    try
                    {
                        _host = await _hostClient.HostDirectAsync(new DirectHostOptions { MaxPlayers = 2, Port = port, FallbackPorts = 0, BindAddress = IPAddress.Loopback, OpenPort = false, Nostr = nostr, IceServers = ice });
                    }
                    catch (OneLobbyException e) when (e.Code == "port_in_use" && attempt < 8)
                    {
                        // a free port can still be one Windows reserves (an excluded range): ask for another
                    }
                }
                if (relay.Length > 0 && _host.JoinCodeKind != JoinCodeKind.Nostr)
                {
                    Finish(false, "the host never got a Nostr code from the local relay");
                    return;
                }
                var address = relay.Length > 0 ? _host.JoinCode : $"127.0.0.1:{port}";
                var join = new JoinDirectOptions { Nostr = relay.Length > 0 ? new NostrOptions { Relays = new[] { relay }, Stun = Array.Empty<string>() } : null, IceServers = ice };
                _guest = await _guestClient.JoinDirectAsync(address, join);
            }

            var atHost = new List<(int From, string Text)>();
            var atGuest = new List<(int From, string Text)>();
            _host.MessageReceived += (from, bytes, _) => atHost.Add((from, Encoding.UTF8.GetString(bytes.Span)));
            _guest.MessageReceived += (from, bytes, _) => atGuest.Add((from, Encoding.UTF8.GetString(bytes.Span)));
            if (!await Until(() => _host.IsPeerReady(_guest.LocalPeerId) && _guest.IsReady)) { Finish(false, "the two peers never linked"); return; }
            _host.Send(_guest.LocalPeerId, Encoding.UTF8.GetBytes("hello guest"));
            _guest.Send(_host.LocalPeerId, Encoding.UTF8.GetBytes("hello host"));
            if (!await Until(() => atHost.Count > 0 && atGuest.Count > 0)) { Finish(false, $"messages did not arrive (host got {atHost.Count}, guest got {atGuest.Count})"); return; }
            if (atHost[0] != (_guest.LocalPeerId, "hello host") || atGuest[0] != (_host.LocalPeerId, "hello guest")) { Finish(false, $"wrong message: host got {atHost[0]}, guest got {atGuest[0]}"); return; }
            var code = _host.JoinCode;
            Finish(true, $"code={code}");
        }
    }
}
