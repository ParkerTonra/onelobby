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
