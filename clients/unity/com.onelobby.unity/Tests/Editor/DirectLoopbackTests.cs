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
    }
}
