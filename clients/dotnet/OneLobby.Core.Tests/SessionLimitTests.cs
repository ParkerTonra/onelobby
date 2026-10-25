using System;
using System.Collections.Generic;
using Xunit;

namespace OneLobby.Tests
{
    // OneLobbyConfig.PeerTimeout and LobbyOptions.RateLimit (blueprint session.peerTimeoutMs / session.rateLimit).
    public class SessionLimitTests
    {
        private static LobbyClient Client(Rig rig, string name, TimeSpan peerTimeout = default)
        {
            var c = new LobbyClient(Rig.Config(name, mode: SyncMode.Raw) with { PeerTimeout = peerTimeout }, rig.Net.CreateTransport());
            rig.Clients.Add(c);
            return c;
        }

        private static (Lobby host, Lobby joiner, List<string> left) Pair(Rig rig, TimeSpan peerTimeout, LobbyOptions? options = null)
        {
            var h = rig.Await(Client(rig, "h", peerTimeout).HostAsync(options ?? new LobbyOptions("t")));
            var j = rig.Await(Client(rig, "j").JoinAsync(h.Code));
            Assert.True(rig.Until(() => j.ReadyAsync.IsCompleted));
            var left = new List<string>();
            h.PeerLeft += (p, reason) => left.Add(reason);
            return (h, j, left);
        }

        [Fact]
        public void ShortPeerTimeoutDropsASilentJoinerBeforeTheBuiltInOne()
        {
            var rig = new Rig();
            var (_, _, left) = Pair(rig, TimeSpan.FromSeconds(6));
            rig.Net.DropReliable = rig.Net.DropUnreliable = () => true;
            rig.Step(5000 / 25);
            Assert.Empty(left);
            rig.Step(2500 / 25);   // 7.5 s: past 6 s, short of the built-in 10 s
            Assert.Equal(new[] { "timeout" }, left.ToArray());
        }

        [Fact]
        public void PeerTimeoutUnderTheFloorIsRaisedAndZeroKeepsTheBuiltIn()
        {
            var rig = new Rig();
            var (_, _, left) = Pair(rig, TimeSpan.FromSeconds(1));
            rig.Net.DropReliable = rig.Net.DropUnreliable = () => true;
            rig.Step(5000 / 25);
            Assert.Empty(left);     // 1 s was raised to 6 s

            var rig2 = new Rig();
            var (_, _, left2) = Pair(rig2, TimeSpan.Zero);
            rig2.Net.DropReliable = rig2.Net.DropUnreliable = () => true;
            rig2.Step(7500 / 25);
            Assert.Empty(left2);    // the built-in 10 s
            rig2.Step(3500 / 25);
            Assert.Equal(new[] { "timeout" }, left2.ToArray());
        }

        [Fact]
        public void RateLimitDropsTheExcessPerWindow()
        {
            var rig = new Rig();
            var (h, j, _) = Pair(rig, TimeSpan.Zero, new LobbyOptions("t") { RateLimit = new RateLimit(3, 1000) });
            Assert.Equal(new RateLimit(3, 1000), h.RateLimit);
            var got = 0;
            h.MessageReceived += (_, _, _) => got++;
            for (var i = 0; i < 10; i++) j.Send(h.HostPeerId, new byte[] { (byte)i });
            rig.Step(8);
            Assert.Equal(3, got);
            rig.Step(1000 / 25);
            for (var i = 0; i < 2; i++) j.Send(h.HostPeerId, new byte[] { 1 });
            rig.Step(8);
            Assert.Equal(5, got);
        }

        [Fact]
        public void NoRateLimitPassesEverything()
        {
            var rig = new Rig();
            var (h, j, _) = Pair(rig, TimeSpan.Zero);
            Assert.Null(h.RateLimit);
            var got = 0;
            h.MessageReceived += (_, _, _) => got++;
            for (var i = 0; i < 50; i++) j.Send(h.HostPeerId, new byte[] { 1 });
            rig.Step(8);
            Assert.Equal(50, got);
        }
    }
}
