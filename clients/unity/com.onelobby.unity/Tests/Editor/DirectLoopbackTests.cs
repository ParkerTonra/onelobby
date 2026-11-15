#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using NUnit.Framework;
using OneLobby.Direct;
using UnityEngine;
using UnityEngine.TestTools;

namespace OneLobby.Unity.Tests
{
    /// <summary>
    /// Host by IP with no server (OneLobby.Direct + the embedded hub): one UnityTransport peer hosts on loopback port
    /// 47832 without asking the router, the other joins by address. Needs nothing running, so it always runs.
    /// </summary>
    public sealed class DirectLoopbackTests
    {
        private const int TimeoutMs = 20000;
        private const int Port = 47832;

        private static IEnumerator Await(Task t, Action pump, string what)
        {
            var start = DateTime.UtcNow;
            while (!t.IsCompleted)
            {
                pump();
                if ((DateTime.UtcNow - start).TotalMilliseconds > TimeoutMs) Assert.Fail("timed out: " + what);
                yield return null;
            }
            if (t.IsFaulted) throw t.Exception!.GetBaseException();
        }

        private static IEnumerator Until(Func<bool> cond, Action pump, string what)
        {
            var start = DateTime.UtcNow;
            while (!cond())
            {
                pump();
                if ((DateTime.UtcNow - start).TotalMilliseconds > TimeoutMs) Assert.Fail("timed out: " + what);
                yield return null;
            }
        }

        [UnityTest]
        public IEnumerator HostDirectAndJoinByAddressExchangeMessagesThenHostLeaving()
        {
            // the lobby server URL is unused in direct mode
            var cfg = new OneLobbyConfig("com.onelobby.unitytest", "1", new Uri("ws://127.0.0.1:1/ws"), SyncMode.Raw);
            var hostClient = new LobbyClient(cfg with { DisplayName = "UnityHost" }, new UnityTransport());
            var joinClient = new LobbyClient(cfg with { DisplayName = "UnityJoiner" }, new UnityTransport());
            Lobby? host = null, joiner = null;
            void Pump()
            {
                if (host != null) host.Pump(); else hostClient.Pump();
                if (joiner != null) joiner.Pump(); else joinClient.Pump();
            }

            var hostTask = hostClient.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, Port = Port, MaxPlayers = 2, OpenPort = false });
            yield return Await(hostTask, Pump, "host direct");
            host = hostTask.Result;
            Assert.IsFalse(string.IsNullOrEmpty(host.JoinCode), "a direct host shows a join code");
            Debug.Log("[OneLobby test] hosted direct, " + host.JoinCodeKind + " code " + host.JoinCode);

            var got = new List<string>();
            host.MessageReceived += (from, payload, ch) => got.Add(Encoding.UTF8.GetString(payload.ToArray()));
            string? ended = null;

            var joinTask = joinClient.JoinDirectAsync("127.0.0.1:" + Port);
            yield return Await(joinTask, Pump, "join direct");
            joiner = joinTask.Result;
            joiner.SessionEnded += reason => ended = reason;
            yield return Await(joiner.ReadyAsync, Pump, "joiner ready (WebRTC link to host open)");

            joiner.Send(host.LocalPeerId, Encoding.UTF8.GetBytes("hello by ip"));
            yield return Until(() => got.Contains("hello by ip"), Pump, "reliable message at host");
            Assert.AreEqual(2, host.Peers.Count);

            // no host migration in direct mode: the host leaving ends the session for the joiner
            yield return Await(host.LeaveAsync(), Pump, "host leave");
            yield return Until(() => ended != null, Pump, "joiner session ended");
            Assert.AreEqual("host_left", ended);
            Debug.Log("[OneLobby test] PASS direct host/join, message, host_left");

            yield return Await(joinClient.DisposeAsync().AsTask(), Pump, "dispose");
            yield return Await(hostClient.DisposeAsync().AsTask(), Pump, "dispose");
        }

        /// <summary>The runner's JoinDirectAsync(code, JoinDirectOptions) takes the same adopt path: LobbyChanged fires, Lobby is set.</summary>
        [UnityTest]
        public IEnumerator RunnerJoinDirectWithOptionsAdoptsTheLobby()
        {
            // not Port + 1: GameConsoleServerTests owns 47833
            const int port = Port + 2;
            var cfg = new OneLobbyConfig("com.onelobby.unitytest", "1", new Uri("ws://127.0.0.1:1/ws"), SyncMode.Raw);
            var hostClient = new LobbyClient(cfg with { DisplayName = "UnityHost" }, new UnityTransport());
            var go = new GameObject("OneLobbyRunnerTest");
            var runner = go.AddComponent<OneLobbyRunner>();
            runner.KeepAcrossScenes = false;
            runner.BindAddress = "127.0.0.1";
            runner.DisplayName = "RunnerJoiner";
            runner.GameId = cfg.GameId;
            Lobby? host = null;
            var joining = false;
            // EditMode never calls the runner's Update, so the test pumps the runner's side too (once its join has made a client)
            void Pump()
            {
                if (host != null) host.Pump(); else hostClient.Pump();
                if (runner == null) return; // destroyed (Unity null)
                if (runner.Lobby != null) runner.Lobby.Pump(); else if (joining) runner.Client.Pump();
            }
            var changes = new List<Lobby?>();
            runner.LobbyChanged += l => changes.Add(l);
            var clean = false;

            try
            {
                var hostTask = hostClient.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, Port = port, MaxPlayers = 2, OpenPort = false, BindAddress = System.Net.IPAddress.Loopback });
                yield return Await(hostTask, Pump, "host direct");
                host = hostTask.Result;

                // a TURN entry nobody uses here: the options reach the join without breaking a direct link
                var turn = new IceServer(new[] { "turn:127.0.0.1:3478" }, "u", "p");
                var joinTask = runner.JoinDirectAsync("127.0.0.1:" + port, new JoinDirectOptions { IceServers = new[] { turn } });
                joining = true;
                yield return Await(joinTask, Pump, "runner join direct with options");
                Assert.AreSame(joinTask.Result, runner.Lobby, "the runner adopted the lobby");
                Assert.AreEqual(1, changes.Count, "LobbyChanged fired once");
                yield return Await(joinTask.Result.ReadyAsync, Pump, "joiner ready");

                yield return Await(runner.LeaveAsync(), Pump, "runner leave");
                Assert.IsNull(runner.Lobby);
                UnityEngine.Object.DestroyImmediate(go);
                yield return Await(host.LeaveAsync(), Pump, "host leave");
                yield return Await(hostClient.DisposeAsync().AsTask(), Pump, "dispose");
                clean = true;
            }
            finally
            {
                // a failed assert must not leave the host holding the port for the next test
                if (!clean)
                {
                    if (go != null) UnityEngine.Object.DestroyImmediate(go); // OnDestroy drops the runner's client
                    try { hostClient.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(3)); }
                    catch (Exception e) { Debug.LogWarning("[OneLobby test] host cleanup: " + e.Message); }
                }
            }
        }
    }
}
