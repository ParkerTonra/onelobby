using System.Linq;
using System.Text.Json;
using Xunit;

namespace OneLobby.Tests
{
    /// <summary>A joiner takes offers only from its host (security: a rival joiner must not open a link to another player).</summary>
    public class SignalSourceTests
    {
        private static JsonElement Offer(int from) =>
            JsonDocument.Parse("{\"t\":\"signal\",\"from\":" + from + ",\"sdp\":{\"type\":\"offer\",\"sdp\":\"offer:x\"}}").RootElement;

        private static (Rig Rig, Lobby Victim, int Rogue) ThreePlayers(bool direct)
        {
            var rig = new Rig();
            var hc = rig.NewClient("h", SyncMode.Raw);
            var h = rig.Await(hc.HostAsync(new LobbyOptions("raw", 4)));
            var rc = rig.NewClient("r", SyncMode.Raw);
            var r = rig.Await(rc.JoinAsync(h.Code));
            var vc = rig.NewClient("v", SyncMode.Raw);
            if (direct) vc.UseDirect(t => t, new System.Uri("ws://mem/ws"), null);
            var v = rig.Await(vc.JoinAsync(h.Code));
            Assert.True(rig.Until(() => v.IsReady && v.Peers.Count == 3));
            return (rig, v, r.LocalPeerId);
        }

        private static bool HasLink(Lobby l, int peer) => l.PeerRecords().First(p => p.Id == peer).Link != null;

        [Fact]
        public void ServerLobbyJoinerIgnoresAnOfferFromAnotherJoinerWhileTheHostLinkIsOpen()
        {
            var (_, v, rogue) = ThreePlayers(false);
            v.OnSignalingMessage("signal", Offer(rogue));
            Assert.False(HasLink(v, rogue));
        }

        [Fact]
        public void DirectLobbyJoinerIgnoresAnOfferFromAnotherJoiner()
        {
            var (_, v, rogue) = ThreePlayers(true);
            v.OnSignalingMessage("signal", Offer(rogue));
            Assert.False(HasLink(v, rogue));
        }

        [Fact]
        public void ServerLobbyJoinerHoldsAnOfferFromARosterMemberAndAnswersItOnceTheHostLinkIsGone()
        {
            var (rig, v, rogue) = ThreePlayers(false);
            v.OnSignalingMessage("signal", Offer(rogue));
            Assert.False(HasLink(v, rogue));
            v.PeerRecords().First(p => p.Id == 1).Link!.Dispose(); // the host link dies; the lowest id (the rogue) is elected
            Assert.True(rig.Until(() => HasLink(v, rogue), 400));
        }
    }
}
