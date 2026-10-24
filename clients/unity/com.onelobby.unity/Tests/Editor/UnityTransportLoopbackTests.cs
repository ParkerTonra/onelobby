#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace OneLobby.Unity.Tests
{
    /// <summary>
    /// Two UnityTransport peers in one editor, through a real onelobby-server:
    ///   dotnet run --project server/OneLobby.Server -- --listen :8080
    /// Override the URL with the environment variable ONELOBBY_TEST_SERVER. Ignored (not failed) when no server answers.
    /// Peer ids and codes come from the server; the WebRTC link is real (host candidates on loopback).
    /// </summary>
    public sealed class UnityTransportLoopbackTests
    {
        private const int TimeoutMs = 20000;

        private static string ServerUrl =>
            Environment.GetEnvironmentVariable("ONELOBBY_TEST_SERVER") is { Length: > 0 } s ? s : "ws://127.0.0.1:8080/ws";

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
        public IEnumerator TwoUnityPeersConnectAndExchangeReliableAndFast()
        {
            var cfg = new OneLobbyConfig("com.onelobby.unitytest", "1", new Uri(ServerUrl), SyncMode.Raw);
            var hostClient = new LobbyClient(cfg with { DisplayName = "UnityHost" }, new UnityTransport());
            var joinClient = new LobbyClient(cfg with { DisplayName = "UnityJoiner" }, new UnityTransport());
            Lobby? host = null, joiner = null;
            void Pump()
            {
                if (host != null) host.Pump(); else hostClient.Pump();
                if (joiner != null) joiner.Pump(); else joinClient.Pump();
            }

            var hostTask = hostClient.HostAsync(new LobbyOptions("unity loopback", MaxPlayers: 2));
            var start = DateTime.UtcNow;
            while (!hostTask.IsCompleted)
            {
                Pump();
                if ((DateTime.UtcNow - start).TotalMilliseconds > 5000) break;
                yield return null;
            }
            if (!hostTask.IsCompleted || hostTask.IsFaulted)
            {
                var why = hostTask.IsFaulted ? hostTask.Exception!.GetBaseException().Message : "no answer";
                Assert.Ignore("no onelobby-server at " + ServerUrl + " (" + why + ")");
            }
            host = hostTask.Result;
            Debug.Log("[OneLobby test] hosted " + host.Code + " as peer " + host.LocalPeerId);

            var got = new List<(int From, string Text, Channel Ch)>();
            host.MessageReceived += (from, payload, ch) => got.Add((from, Encoding.UTF8.GetString(payload.ToArray()), ch));
            var joinerGot = new List<string>();

            var joinTask = joinClient.JoinAsync(host.Code);
            yield return Await(joinTask, Pump, "join");
            joiner = joinTask.Result;
            joiner.MessageReceived += (from, payload, ch) => joinerGot.Add(Encoding.UTF8.GetString(payload.ToArray()));
            yield return Await(joiner.ReadyAsync, Pump, "joiner ready (WebRTC link to host open)");
            Debug.Log("[OneLobby test] joiner " + joiner.LocalPeerId + " ready");

            joiner.Send(host.LocalPeerId, Encoding.UTF8.GetBytes("hello from unity"));
            yield return Until(() => got.Exists(m => m.Ch == Channel.Reliable), Pump, "reliable message at host");
            Assert.AreEqual("hello from unity", got.Find(m => m.Ch == Channel.Reliable).Text);
            Assert.AreEqual(joiner.LocalPeerId, got.Find(m => m.Ch == Channel.Reliable).From);

            // fast channel is unreliable by design: resend until one arrives
            var sentAt = 0;
            yield return Until(() =>
            {
                if (sentAt++ % 10 == 0) joiner.Send(host.LocalPeerId, Encoding.UTF8.GetBytes("fast"), Channel.Fast);
                return got.Exists(m => m.Ch == Channel.Fast);
            }, Pump, "fast message at host");

            host.Broadcast(Encoding.UTF8.GetBytes("welcome from host"));
            yield return Until(() => joinerGot.Contains("welcome from host"), Pump, "broadcast at joiner");

            Assert.AreEqual(2, host.Peers.Count);
            Debug.Log("[OneLobby test] PASS reliable+fast+broadcast; host sees peers " + host.Peers.Count);

            yield return Await(joiner.LeaveAsync(), Pump, "leave");
            yield return Await(host.LeaveAsync(), Pump, "leave");
            yield return Await(joinClient.DisposeAsync().AsTask(), Pump, "dispose");
            yield return Await(hostClient.DisposeAsync().AsTask(), Pump, "dispose");
        }
    }
}
