using System;
using System.Linq;
using Xunit;

namespace OneLobby.Replication.Tests
{
    public class DiagnosticsTests
    {
        private const ushort AlienType = 7;

        [Fact]
        public void RttHostPeerIdAndSnapshotAgeAreExposed()
        {
            var rig = new Rig(latencyMs: 40);
            var host = rig.StartHost();
            var a = rig.Join("a");
            host.Session.Spawn(AlienType, 0, new Alien());
            rig.Run(3);
            Assert.Equal(host.Lobby.LocalPeerId, a.Session.HostPeerId);
            Assert.Equal(host.Lobby.LocalPeerId, host.Session.HostPeerId);
            Assert.InRange(a.Session.RttMs, 70, 140);                               // 2 x 40 ms one way, pumped at 16 ms
            Assert.InRange(host.Session.PeerRttMs(a.Lobby.LocalPeerId), 70, 140);
            Assert.Equal(0, host.Session.RttMs);
            Assert.InRange(a.Session.SnapshotAgeMs, 0, 60);                          // 30 Hz snapshots
        }

        [Fact]
        public void SendFullSnapshotResetsOneClientsBaselineThenDeltasResume()
        {
            var rig = new Rig(latencyMs: 30);
            var host = rig.StartHost();
            var a = rig.Join("a");
            var b = rig.Join("b");
            for (var i = 0; i < 10; i++) host.Session.Spawn(AlienType, 0, new Alien { X = i });
            rig.Run(2);
            var fullBefore = host.Session.Stats.FullSnapshotsSent;
            Assert.True(host.Session.AckedTick(a.Lobby.LocalPeerId) > 0);

            host.Session.SendFullSnapshot(a.Lobby.LocalPeerId);
            Assert.Equal(0u, host.Session.AckedTick(a.Lobby.LocalPeerId));
            rig.Run(1);
            var fulls = host.Session.Stats.FullSnapshotsSent - fullBefore;
            Assert.InRange(fulls, 1, 8);                                              // only a, until its next ack (~RTT)
            Assert.True(host.Session.AckedTick(a.Lobby.LocalPeerId) > 0);
            Assert.Equal(10, a.Session.Entities.Count);
            Assert.Empty(a.Despawned);
            Assert.Equal(10, b.Session.Entities.Count);
        }

        [Fact]
        public void InputStatsAreSplitPerClient()
        {
            var rig = new Rig(latencyMs: 30);
            var host = rig.StartHost();
            var a = rig.Join("a");
            var b = rig.Join("b");
            a.MakeInput = t => new[] { (byte)t };
            b.MakeInput = t => t % 2 == 0 ? new[] { (byte)t } : null;              // b sends every other tick: repeats
            rig.HostTick = tick =>
            {
                host.Session.TryGetInput(a.Lobby.LocalPeerId, out _);
                host.Session.TryGetInput(b.Lobby.LocalPeerId, out _);
            };
            rig.Run(3);
            var sa = host.Session.InputStatsFor(a.Lobby.LocalPeerId);
            var sb = host.Session.InputStatsFor(b.Lobby.LocalPeerId);
            Assert.True(sb.Repeated > 30, "b repeats " + sb.Repeated);
            Assert.True(sa.Repeated < sb.Repeated / 4, "a repeats " + sa.Repeated);
            Assert.InRange(sa.BufferDepth, 0, 4);
            Assert.Equal(sa.Repeated + sb.Repeated, host.Session.Stats.InputsRepeated);
            Assert.Equal(sa.Skipped + sb.Skipped, host.Session.Stats.InputsSkipped);
            Assert.Equal(default, host.Session.InputStatsFor(99));
        }
    }
}
