#nullable enable
using System;
using System.Collections;
using System.Linq;
using System.Threading.Tasks;
using NUnit.Framework;
using OneLobby.Direct;
using UnityEngine;
using UnityEngine.TestTools;

namespace OneLobby.Unity.Tests
{
    /// <summary>
    /// The runner fields (<c>BindAddress</c>, <c>DisplayName</c>, ...) are applied when the runner hosts or joins, not when its client is built:
    /// reading <c>runner.Client</c> (or a <c>client.Settings</c>) first must not turn a loopback host into an all-interfaces one. Every host here
    /// listens on 127.0.0.1 only: the first test would otherwise be the thing it guards against, so it never hosts without a BindAddress.
    /// </summary>
    public sealed class RunnerFieldsTests
    {
        private const int TimeoutMs = 20000;

        // EditMode never calls the runner's Update, so the test pumps the runner's side itself
        private static IEnumerator Await(OneLobbyRunner runner, Task t, string what)
        {
            var start = DateTime.UtcNow;
            while (!t.IsCompleted)
            {
                if (runner.Lobby != null) runner.Lobby.Pump(); else runner.Client.Pump();
                if ((DateTime.UtcNow - start).TotalMilliseconds > TimeoutMs) Assert.Fail("timed out: " + what);
                yield return null;
            }
            if (t.IsFaulted) throw t.Exception!.GetBaseException();
        }

        private static OneLobbyRunner NewRunner(out GameObject go)
        {
            go = new GameObject("OneLobbyRunnerFieldsTest");
            var runner = go.AddComponent<OneLobbyRunner>();
            runner.KeepAcrossScenes = false;
            runner.GameId = "com.onelobby.unitytest";
            runner.LobbyServer = "ws://127.0.0.1:1/ws"; // unused by a direct host
            runner.DisplayName = "FieldsHost";
            return runner;
        }

        // a free port the test picks itself: no fixed port, so another copy or an earlier run never collides
        private static DirectHostOptions Options() => new DirectHostOptions
        {
            Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, MaxPlayers = 2, OpenPort = false,
            Port = new System.Random().Next(20000, 47000), FallbackPorts = 9,
        };

        /// <summary>The trap: BindAddress set AFTER something read runner.Client. The host still listens on 127.0.0.1 only.</summary>
        [UnityTest]
        public IEnumerator BindAddressSetAfterTheClientWasReadStillBindsLoopback()
        {
            var runner = NewRunner(out var go);
            try
            {
                var early = runner.Client; // what a game does when it reads client.Settings in Awake
                // negative control: the client is built and nothing told its transport to stay on loopback (the old runner stopped here)
                Assert.IsNull(runner.Transport.BindAddress, "before the host call the transport has no bind address: the old runner would have kept it that way");
                runner.BindAddress = "127.0.0.1"; // set late, as the game parsed its own flag after reading the client

                var hostTask = runner.HostDirectAsync(Options()); // no BindAddress in the options: the runner field supplies it
                yield return Await(runner, hostTask, "host direct");
                var lobby = hostTask.Result;
                Assert.AreEqual("127.0.0.1", runner.Transport.BindAddress, "the WebRTC sockets are bound to loopback");
                Assert.IsNotEmpty(lobby.DirectAddresses);
                Assert.IsTrue(lobby.DirectAddresses.All(a => a.StartsWith("127.0.0.1:", StringComparison.Ordinal)),
                    "the listener is on loopback only, got " + string.Join(", ", lobby.DirectAddresses));
                Assert.AreSame(early, runner.Client, "a bind address alone needs no new client");
                yield return Await(runner, runner.LeaveAsync(), "leave");
            }
            finally { UnityEngine.Object.DestroyImmediate(go); }
        }

        /// <summary>A field the client is built from, changed after the client was read, gives a fresh client at the next host (and once, with a log line).</summary>
        [UnityTest]
        public IEnumerator FieldChangedAfterTheClientWasReadBuildsAFreshClientAtHost()
        {
            var runner = NewRunner(out var go);
            try
            {
                runner.BindAddress = "127.0.0.1";
                var early = runner.Client;

                // negative control: nothing changed, so the client is kept (no needless rebuild)
                var hostTask = runner.HostDirectAsync(Options());
                yield return Await(runner, hostTask, "host direct, nothing changed");
                Assert.AreSame(early, runner.Client, "unchanged fields keep the client");
                yield return Await(runner, runner.LeaveAsync(), "leave");

                runner.DisplayName = "FieldsLate"; // read when the client is built: set late
                var second = runner.HostDirectAsync(Options());
                yield return Await(runner, second, "host direct after the change");
                Assert.AreNotSame(early, runner.Client, "a changed field gives a fresh client");
                var me = second.Result.Peers.First(p => p.PeerId == second.Result.LocalPeerId);
                Assert.AreEqual("FieldsLate", me.Name, "the late DisplayName is the one that is used");
                yield return Await(runner, runner.LeaveAsync(), "leave");
            }
            finally { UnityEngine.Object.DestroyImmediate(go); }
        }

        /// <summary>A typo in BindAddress throws at the host call (before anything listens), not silently on all interfaces.</summary>
        [UnityTest]
        public IEnumerator BadBindAddressThrowsAtHostBeforeAnythingListens()
        {
            var runner = NewRunner(out var go);
            try
            {
                var early = runner.Client;
                runner.BindAddress = "localhost"; // not an IPv4 address
                var t = runner.HostDirectAsync(Options());
                var start = DateTime.UtcNow;
                while (!t.IsCompleted && (DateTime.UtcNow - start).TotalMilliseconds < TimeoutMs) yield return null;
                Assert.IsTrue(t.IsFaulted, "the host call failed");
                Assert.IsInstanceOf<ArgumentException>(t.Exception!.GetBaseException());
                Assert.IsNull(runner.Lobby, "nothing was hosted");
            }
            finally { UnityEngine.Object.DestroyImmediate(go); }
        }
    }
}
