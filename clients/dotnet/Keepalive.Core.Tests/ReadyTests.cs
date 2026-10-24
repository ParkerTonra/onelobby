using System.Linq;
using System.Collections.Generic;
using System.Text;
using Xunit;

namespace Keepalive.Tests
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

namespace Keepalive.Tests
{
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
            late.Game = new Keepalive.Gridpaint.GridpaintGame(late.Lobby.Code);
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
