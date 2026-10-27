using System;
using System.Linq;
using System.Collections.Generic;
using System.Text;
using Xunit;

namespace OneLobby.Tests
{
    public class ReadyTests
    {
        private static byte[] B(string s) => Encoding.UTF8.GetBytes(s);

        [Fact]
        public void ReliableSendsMadeAtPeerJoinedAreQueuedAndDeliveredInOrder()
        {
            var rig = new Rig();
            var hc = rig.NewClient("h", SyncMode.Raw);
            var h = rig.Await(hc.HostAsync(new LobbyOptions("raw", 4)));
            var ready = new List<int>();
            h.PeerReady += p => ready.Add(p.PeerId);
            h.PeerJoined += p =>
            {
                h.Send(p.PeerId, B("one"));
                h.Send(p.PeerId, B("fast-lost"), Channel.Fast);
                h.Broadcast(B("two"));
            };
            var gc = rig.NewClient("g", SyncMode.Raw);
            var g = rig.Await(gc.JoinAsync(h.Code));
            var got = new List<string>();
            g.MessageReceived += (_, p, c) => got.Add(Encoding.UTF8.GetString(p.Span) + ":" + c);
            g.Send(1, B("early")); // before the link to the host is open
            var atHost = new List<string>();
            h.MessageReceived += (_, p, _) => atHost.Add(Encoding.UTF8.GetString(p.Span));
            Assert.True(rig.Until(() => got.Count >= 2 && atHost.Count >= 1));
            Assert.Equal(new[] { "one:Reliable", "two:Reliable" }, got.ToArray());
            Assert.Equal(new[] { "early" }, atHost.ToArray());
            Assert.Equal(new[] { 2 }, ready.ToArray());
        }

        [Fact]
        public void JoinerGetsReadyEventAndTaskWhenTheHostLinkIsUp()
        {
            var rig = new Rig();
            var host = rig.Host();
            Assert.True(host.Lobby.ReadyAsync.IsCompleted);
            var g = rig.NewPlayer("g");
            var lobby = rig.Await(g.Client.JoinAsync(host.Lobby.Code));
            g.Attach(lobby);
            var peers = new List<int>();
            lobby.PeerReady += p => peers.Add(p.PeerId);
            Assert.False(lobby.ReadyAsync.IsCompleted);
            Assert.True(rig.Until(() => lobby.ReadyAsync.IsCompleted));
            Assert.True(lobby.IsReady);
            Assert.Equal(new[] { 1 }, peers.ToArray());
        }

        [Fact]
        public void ChatAndCommandsSentBeforeTheLinkOpensArriveAfterIt()
        {
            var rig = new Rig();
            var host = rig.Host();
            var g = rig.NewPlayer("g");
            g.Attach(rig.Await(g.Client.JoinAsync(host.Lobby.Code)));
            var lines = new List<string>();
            host.Lobby.Chat.Received += l => lines.Add(l.Text);
            g.Lobby.Chat.Send("first words");
            Assert.True(rig.Until(() => lines.Count == 1));
            Assert.Equal("first words", lines[0]);
        }
    }
}

namespace OneLobby.Tests
{
    /// <summary>OneLobbyConfig.ReadyTimeout: a joiner that cannot reach the host gives up (mirrors the JS readyTimeoutMs).</summary>
    public class ReadyTimeoutTests
    {
        private static (Rig Rig, Lobby Host, LobbyClient Joiner) Setup(TimeSpan? timeout = null)
        {
            var rig = new Rig();
            var hc = rig.NewClient("h", SyncMode.Raw);
            var h = rig.Await(hc.HostAsync(new LobbyOptions("raw", 4)));
            var cfg = Rig.Config("g", mode: SyncMode.Raw);
            if (timeout is { } t) cfg = cfg with { ReadyTimeout = t };
            var gc = new LobbyClient(cfg, rig.Net.CreateTransport());
            rig.Clients.Add(gc);
            return (rig, h, gc);
        }

        [Fact]
        public void DefaultIsFifteenSeconds() =>
            Assert.Equal(TimeSpan.FromSeconds(15), Rig.Config().ReadyTimeout);

        [Fact]
        public void ReadyFaultsWithIceFailedLeavesAndEndsTheSessionWhenTheLinkNeverOpens()
        {
            var (rig, host, gc) = Setup();
            rig.Net.CanConnect = (_, _) => false; // no ICE path at all
            var errors = new List<LobbyError>();
            gc.Error += e => errors.Add(e);
            var g = rig.Await(gc.JoinAsync(host.Code));
            var ended = new List<string>();
            g.SessionEnded += r => ended.Add(r);
            var left = new List<int>();
            host.PeerLeft += (p, _) => left.Add(p.PeerId);
            var t0 = rig.Net.NowMs;
            Assert.True(rig.Until(() => g.ReadyAsync.IsCompleted, 1000));
            var waited = rig.Net.NowMs - t0;
            Assert.InRange(waited, 14_900, 15_100);
            Assert.True(g.ReadyAsync.IsFaulted);
            var ex = Assert.IsType<OneLobbyException>(g.ReadyAsync.Exception!.InnerException);
            Assert.Equal("ice_failed", ex.Code);
            Assert.Contains("15 s", ex.Message);
            Assert.Equal(new[] { "ice_failed" }, ended.ToArray());
            Assert.Equal(new[] { "ice_failed" }, errors.Select(e => e.Code).ToArray());
            Assert.True(rig.Until(() => left.Count == 1, 40));
            Assert.Equal(2, left[0]);
            Assert.False(g.IsReady);
        }

        [Fact]
        public void SecondHalfIsOneRelayOnlyRetryWhenTheServerOffersTurn()
        {
            var (rig, host, gc) = Setup(TimeSpan.FromSeconds(10));
            rig.Net.IceServers.Add(new IceServer(new[] { "turn:turn.example.org:3478" }, "u", "p"));
            rig.Net.CanConnect = (a, b) => a.RelayOnly || b.RelayOnly; // only the relay gets through
            var g = rig.Await(gc.JoinAsync(host.Code));
            var hostReady = new List<int>();
            host.PeerReady += p => hostReady.Add(p.PeerId);
            var t0 = rig.Net.NowMs;
            Assert.True(rig.Until(() => g.ReadyAsync.IsCompleted, 1000));
            Assert.True(g.ReadyAsync.IsCompletedSuccessfully);
            Assert.InRange(rig.Net.NowMs - t0, 5_000, 5_500); // the retry starts at half the budget
            Assert.Equal(new[] { 2 }, hostReady.ToArray());
            rig.Step(800); // well past the full budget: the session stays up
            Assert.True(g.IsReady);
            Assert.True(host.IsPeerReady(2));
        }

        [Fact]
        public void ZeroWaitsForever()
        {
            var (rig, host, gc) = Setup(TimeSpan.Zero);
            rig.Net.CanConnect = (_, _) => false;
            var g = rig.Await(gc.JoinAsync(host.Code));
            var ended = new List<string>();
            g.SessionEnded += r => ended.Add(r);
            rig.Step(2400); // 60 s
            Assert.False(g.ReadyAsync.IsCompleted);
            Assert.Empty(ended);
        }
    }
}

namespace OneLobby.Tests
{
    public class PeerFailedTests
    {
        private static (Rig Rig, Lobby Host, List<string> Seen) HostWith(TimeSpan timeout)
        {
            var rig = new Rig();
            var cfg = Rig.Config("h", mode: SyncMode.Raw) with { ReadyTimeout = timeout };
            var hc = new LobbyClient(cfg, rig.Net.CreateTransport());
            rig.Clients.Add(hc);
            var h = rig.Await(hc.HostAsync(new LobbyOptions("raw", 4)));
            var seen = new List<string>();
            h.PeerFailed += (p, r) => seen.Add($"failed {p.PeerId} {r}");
            h.PeerLeft += (p, r) => seen.Add($"left {p.PeerId} {r}");
            return (rig, h, seen);
        }

        private static Lobby JoinWith(Rig rig, string code, string name, TimeSpan timeout)
        {
            var gc = new LobbyClient(Rig.Config(name, mode: SyncMode.Raw) with { ReadyTimeout = timeout }, rig.Net.CreateTransport());
            rig.Clients.Add(gc);
            return rig.Await(gc.JoinAsync(code));
        }

        [Fact]
        public void LeavingBeforeReadyRaisesPeerFailedThenPeerLeftWithTheSameReason() => RunLeave();

        private static void RunLeave()
        {
            var (rig, host, seen) = HostWith(TimeSpan.Zero);
            rig.Net.CanConnect = (_, _) => false;
            var g = JoinWith(rig, host.Code, "g", TimeSpan.FromSeconds(10));
            Assert.True(rig.Until(() => g.ReadyAsync.IsCompleted, 1000)); // its own ice_failed: it leaves
            Assert.True(rig.Until(() => seen.Count >= 2, 100));
            Assert.Equal(new[] { "failed 2 left", "left 2 left" }, seen.ToArray());
            rig.Step(800);
            Assert.Equal(2, seen.Count);
        }

        [Fact]
        public void NotReadyInReadyTimeoutRaisesPeerFailedTimeoutOnceAndKeepsTheSeat() => RunTimeout();

        private static void RunTimeout()
        {
            var (rig, host, seen) = HostWith(TimeSpan.FromSeconds(5));
            var ready = new List<int>();
            host.PeerReady += p => ready.Add(p.PeerId);
            rig.Net.CanConnect = (a, b) => a.RemotePeerId != 2 && b.RemotePeerId != 2; // bob (2) never gets a link
            JoinWith(rig, host.Code, "bob", TimeSpan.Zero);
            var carol = JoinWith(rig, host.Code, "carol", TimeSpan.Zero);
            Assert.True(rig.Until(() => host.IsPeerReady(3), 100));
            rig.Step(196); // 4.9 s
            Assert.Empty(seen);
            rig.Step(8);
            Assert.Equal(new[] { "failed 2 timeout" }, seen.ToArray()); // carol got ready: no event
            rig.Step(800);
            Assert.Equal(new[] { "failed 2 timeout" }, seen.ToArray());
            Assert.Equal(new[] { 1, 2, 3 }, host.Peers.Select(p => p.PeerId).OrderBy(x => x).ToArray());
            Assert.True(carol.IsReady);
        }
    }

    public class LateJoinTickTests
    {
        [Xunit.Fact]
        public void SnapshotTickIsTheAppliedTickEvenWhenFramesWereEmittedButNotApplied()
        {
            var rig = new Rig();
            var host = rig.Host();
            _ = host.Lobby.StartAsync();
            rig.Step(40);
            host.Paused = true; // frames keep being emitted, the host game stops applying them
            rig.Step(10);
            Xunit.Assert.True(host.Lobby.Lockstep!.LastReceivedTick > host.Lobby.Lockstep.Tick);
            var appliedAtJoin = host.Lobby.Lockstep.Tick;
            var late = rig.NewPlayer("late");
            late.Paused = true;
            late.Lobby = rig.Await(late.Client.JoinAsync(host.Lobby.Code));
            long restoredAt = -1;
            late.Game = new OneLobby.Gridpaint.GridpaintGame(late.Lobby.Code);
            late.Lobby.Lockstep!.Restore = (t, b) => { restoredAt = t; late.Game.Restore(t, b.Span); };
            Xunit.Assert.True(rig.Until(() => restoredAt >= 0));
            Xunit.Assert.Equal(appliedAtJoin, restoredAt);
            late.Paused = false;
            host.Paused = false;
            rig.Step(60);
            Xunit.Assert.True(Rig.CompareHashes(host, late) > 20);
        }

        [Xunit.Fact]
        public void FreshJoinerWhenNothingIsAppliedYetGetsEveryFrameFromOne()
        {
            var rig = new Rig();
            var host = rig.Host();
            host.Paused = true;
            _ = host.Lobby.StartAsync();
            rig.Step(10);
            var late = rig.Join(host.Lobby.Code, "late");
            rig.Step(20);
            host.Paused = false;
            rig.Step(60);
            Xunit.Assert.True(Rig.CompareHashes(host, late) > 20);
            Xunit.Assert.Equal(1L, late.Hashes.Keys.Min());
        }
    }
}
