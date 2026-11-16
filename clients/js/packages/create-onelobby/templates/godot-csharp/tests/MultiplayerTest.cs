using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;
using Godot;
using OneLobby;
using OneLobby.Direct;
using OneLobby.Direct.Nostr;
using OneLobby.Godot;

namespace {{ns}};

/// <summary>
/// Two OneLobby clients in this one process, on 127.0.0.1 only (a direct host that listens on loopback, no Nostr, no public server;
/// nothing listens beyond this machine): one hosts, the other joins by its address, and each sends the other one message.
/// Prints <c>MULTIPLAYER_OK</c> as its last line and exits 0, or <c>MULTIPLAYER_FAIL &lt;what&gt;</c> and exits 1.
///   dotnet build
///   godot --headless --audio-driver Dummy --path . res://tests/MultiplayerTest.tscn
/// Written by create-onelobby. <c>create-onelobby verify</c> runs its other routes through this same scene, with arguments after <c>--</c>
/// (a hidden folder is no place for a probe: MSBuild leaves folders that start with a dot out of the build):
///   --route=config   load res://onelobby.json and print what verify needs
///   --route=direct   (default) two peers on 127.0.0.1
///   --route=nostr    through the local Nostr relay at --relay=ws://127.0.0.1:PORT
///   --route=turn     relay-only through the TURN login in --turn="turn:127.0.0.1:PORT user pass" (and --relay=... when Nostr is on)
///   --route=server   host and join by code on the lobby server --server=ws://127.0.0.1:PORT/ws
/// A route other than direct prints <c>MULTIPLAYER_OK &lt;route&gt; ...</c> or <c>MULTIPLAYER_FAIL &lt;route&gt; &lt;what&gt;</c>.
/// </summary>
public partial class MultiplayerTest : Node
{
    private readonly Dictionary<string, string> _args = new();
    private string _route = "direct";
    private LobbyClient? _hostClient, _guestClient;
    private Lobby? _host, _guest;
    private ulong _started;
    private bool _done;

    public override void _Ready()
    {
        foreach (var a in OS.GetCmdlineUserArgs().Where(a => a.StartsWith("--")))
        {
            var eq = a.IndexOf('=');
            if (eq < 0) _args[a[2..]] = "1";
            else _args[a[2..eq]] = a[(eq + 1)..];
        }
        _route = _args.GetValueOrDefault("route", "direct");
        _started = Time.GetTicksMsec();
        _ = Run();
    }

    public override void _Process(double delta)
    {
        // events fire on this thread; a client is pumped until it holds a lobby, the lobby after that
        foreach (var (client, lobby) in new[] { (_hostClient, _host), (_guestClient, _guest) })
        {
            if (lobby != null) lobby.Pump();
            else client?.Pump();
        }
        var limit = long.Parse(_args.GetValueOrDefault("timeout", "60")) * 1000;
        if ((long)(Time.GetTicksMsec() - _started) > limit) Finish(false, $"timed out after {limit / 1000} s");
    }

    private void Finish(bool ok, string what)
    {
        if (_done) return;
        _done = true;
        var line = (ok ? "MULTIPLAYER_OK" : "MULTIPLAYER_FAIL") + (_route == "direct" ? "" : " " + _route) + (ok && _route == "direct" ? "" : " " + what);
        GD.Print(line.TrimEnd());
        GetTree().Quit(ok ? 0 : 1);
    }

    private async Task<bool> Until(Func<bool> cond, int ms = 20000)
    {
        var t0 = Time.GetTicksMsec();
        while ((int)(Time.GetTicksMsec() - t0) < ms && !_done)
        {
            await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);
            if (cond()) return true;
        }
        return cond();
    }

    // no settings store: two clients in one process must not share a player id, and nothing is written to user://
    private static LobbyClient MakeClient(Blueprint bp, string name, Func<OneLobbyConfig, OneLobbyConfig> configure, string? server = null) =>
        LobbyClient.FromBlueprint(bp, new GodotTransport(), name, server, configure);

    private static int FreeLoopbackPort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    private async Task Run()
    {
        try
        {
            await RunRoute();
        }
        catch (Exception e)
        {
            Finish(false, e is OneLobbyException ox ? $"{ox.Code}: {ox.Message}" : e.GetType().Name + ": " + e.Message);
        }
    }

    private async Task RunRoute()
    {
        Blueprint bp;
        try
        {
            bp = Blueprint.Parse(global::Godot.FileAccess.GetFileAsString("res://onelobby.json"));
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
            var parts = _args.GetValueOrDefault("turn", "").Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 3 || !parts[0].StartsWith("turn:")) { Finish(false, "the --turn value is not 'turn:HOST:PORT user password'"); return; }
            ice = new[] { new IceServer(new[] { parts[0] }, parts[1], parts[2]) };
        }
        Func<OneLobbyConfig, OneLobbyConfig> configure = c => ice != null ? c with { RelayOnly = true } : c;
        var relay = _args.GetValueOrDefault("relay", "");
        var server = _args.GetValueOrDefault("server", "");

        _hostClient = MakeClient(bp, "Host", configure, _route == "server" ? server : null);
        _guestClient = MakeClient(bp, "Guest", configure, _route == "server" ? server : null);
        if (_route == "server")
        {
            _host = await _hostClient.HostAsync(new LobbyOptions("verify", 2));
            _guest = await _guestClient.JoinAsync(_host.Code);
        }
        else
        {
            // loopback only: the listener binds 127.0.0.1 on a free port, public STUN servers are switched off, no router request
            var port = FreeLoopbackPort();
            var nostr = relay.Length > 0 ? new NostrOptions { Enabled = true, Relays = new[] { relay }, Stun = Array.Empty<string>() } : new NostrOptions { Enabled = false };
            _host = await _hostClient.HostDirectAsync(new DirectHostOptions { MaxPlayers = 2, Port = port, FallbackPorts = 0, BindAddress = IPAddress.Loopback, OpenPort = false, Nostr = nostr, IceServers = ice });
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
        await _guest.LeaveAsync();
        await _host.LeaveAsync();
        Finish(true, $"code={_host.Code}");
    }
}
