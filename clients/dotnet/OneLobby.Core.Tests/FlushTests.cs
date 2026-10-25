using System;
using System.Collections.Generic;
using System.Text;
using Xunit;

namespace OneLobby.Tests
{
    public class FlushTests
    {
        private static (Rig Rig, Lobby Host, Lobby Joiner) Pair(int simLatencyMs)
        {
            var rig = new Rig();
            rig.Net.LatencyMs = 10;
            var h = rig.Await(rig.NewClient("h", SyncMode.Raw).HostAsync(new LobbyOptions("flush", 4)));
            var sim = new NetSimTransport(rig.Net.CreateTransport(), new NetSimOptions(LatencyMs: simLatencyMs));
            var gc = new LobbyClient(Rig.Config("g", mode: SyncMode.Raw), sim);
            rig.Clients.Add(gc);
            var g = rig.Await(gc.JoinAsync(h.Code));
            Assert.True(rig.Until(() => g.ReadyAsync.IsCompleted));
            return (rig, h, g);
        }

        [Fact]
        public void FlushWaitsForQueuedReliableFramesThenLeaveLosesNothing()
        {
            var (rig, h, g) = Pair(200);
            var got = new List<string>();
            var left = false;
            h.MessageReceived += (_, p, _) => got.Add(Encoding.UTF8.GetString(p.Span));
            h.PeerLeft += (_, _) => { left = true; Assert.Equal(3, got.Count); };   // last words first, then the leave
            for (var i = 0; i < 3; i++) g.Send(h.LocalPeerId, Encoding.UTF8.GetBytes("bye" + i));
            Assert.True(g.ReliableBufferedBytes > 0);

            var flush = g.FlushAsync(TimeSpan.FromSeconds(2));
            Assert.False(flush.IsCompleted);
            Assert.True(rig.Until(() => flush.IsCompleted));
            Assert.True(rig.Await(flush));
            Assert.Equal(0, g.ReliableBufferedBytes);

            g.LeaveAsync();                                   // at once: the frames are still in flight
            Assert.True(rig.Until(() => left));
            Assert.Equal(new[] { "bye0", "bye1", "bye2" }, got);
        }

        [Fact]
        public void HostsLastBroadcastArrivesBeforeTheJoinerSeesItLeave()
        {
            var rig = new Rig();
            rig.Net.LatencyMs = 10;
            var sim = new NetSimTransport(rig.Net.CreateTransport(), new NetSimOptions(LatencyMs: 200));
            var hc = new LobbyClient(Rig.Config("h", mode: SyncMode.Raw), sim);
            rig.Clients.Add(hc);
            var h = rig.Await(hc.HostAsync(new LobbyOptions("flush", 4)));
            var g = rig.Await(rig.NewClient("g", SyncMode.Raw).JoinAsync(h.Code));
            Assert.True(rig.Until(() => g.ReadyAsync.IsCompleted));

            var got = new List<string>();
            var hostGone = false;
            g.MessageReceived += (_, p, _) => got.Add(Encoding.UTF8.GetString(p.Span));
            g.PeerLeft += (p, _) => { if (p.PeerId == h.LocalPeerId) { hostGone = true; Assert.Equal(new[] { "match over" }, got); } };
            h.Broadcast(Encoding.UTF8.GetBytes("match over"));
            var flush = h.FlushAsync(TimeSpan.FromSeconds(2));
            Assert.True(rig.Until(() => flush.IsCompleted));
            Assert.True(rig.Await(flush));
            h.LeaveAsync();
            Assert.True(rig.Until(() => hostGone));
        }

        [Fact]
        public void FlushTimesOutOrFailsWhenTheLobbyEnds()
        {
            var (rig, h, g) = Pair(500);
            g.Send(h.LocalPeerId, new byte[] { 1 });
            var shortWait = g.FlushAsync(TimeSpan.FromMilliseconds(100));
            Assert.True(rig.Until(() => shortWait.IsCompleted));
            Assert.False(rig.Await(shortWait));

            var pending = g.FlushAsync(TimeSpan.FromSeconds(5));
            g.LeaveAsync();
            Assert.True(pending.IsCompleted);
            Assert.False(rig.Await(pending));
            Assert.False(rig.Await(g.FlushAsync(TimeSpan.FromSeconds(1))));
        }

        [Fact]
        public void LinkWithoutABufferCountsAsFlushed()
        {
            var rig = new Rig();
            var h = rig.Await(rig.NewClient("h", SyncMode.Raw).HostAsync(new LobbyOptions("flush", 4)));
            var g = rig.Await(rig.NewClient("g", SyncMode.Raw).JoinAsync(h.Code));
            Assert.True(rig.Until(() => g.ReadyAsync.IsCompleted));
            g.Send(h.LocalPeerId, new byte[] { 1 });
            var flush = g.FlushAsync(TimeSpan.FromSeconds(1));
            Assert.True(flush.IsCompleted);
            Assert.True(rig.Await(flush));
        }
    }
}
