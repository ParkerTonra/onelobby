using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace OneLobby.Replication.Tests
{
    public class KeyframeTests
    {
        private const ushort AlienType = 7;

        [Fact]
        public void ALateJoinerGetsAReliableFullSnapshotEvenIfEveryFastPacketIsLost()
        {
            var rig = new Rig(latencyMs: 30, lossRate: 1.0);
            var host = rig.StartHost();
            host.Session.Spawn(AlienType, 0, new Alien { X = 5 });
            rig.Run(0.5);
            var a = rig.Join("a");
            Assert.True(rig.Until(() => a.Session.LatestTick > 0, 200));
            Assert.Equal(1, host.Session.Stats.KeyframesSent);
            Assert.True(a.Session.TryGetLatest<AlienState>(new NetId(1), out var s, out _));
            Assert.Equal(5, s.X, 2);
        }

        [Fact]
        public void KeyframesRepeatEveryKeyframeSecondsAndStopWhenItIsZero()
        {
            var rig = new Rig(new ReplicationConfig(KeyframeSeconds: 1), latencyMs: 20);
            var host = rig.StartHost();
            var a = rig.Join("a");
            host.Session.Spawn(AlienType, 0, new Alien());
            rig.Run(3.5);
            Assert.InRange(host.Session.Stats.KeyframesSent, 3, 5);
            Assert.True(host.Session.Stats.FullSnapshotsSent >= host.Session.Stats.KeyframesSent);

            var off = new Rig(new ReplicationConfig(KeyframeSeconds: 0), latencyMs: 20);
            var h2 = off.StartHost();
            var b = off.Join("b");
            h2.Session.Spawn(AlienType, 0, new Alien());
            off.Run(3);
            Assert.Equal(0, h2.Session.Stats.KeyframesSent);
            Assert.True(off.Until(() => b.Spawned.Count == 1));   // full snapshots on fast until the first ack, as before
        }

        [Fact]
        public void RatesCountPayloadBytesPerKindOverTheLastSecond()
        {
            var rig = new Rig(latencyMs: 20);
            var host = rig.StartHost();
            var a = rig.Join("a");
            host.Session.Spawn(AlienType, 0, new Alien());
            a.MakeInput = t => new byte[] { (byte)t, 1, 2 };
            rig.Run(2);
            var before = host.Session.BytesSentTo(a.Lobby.LocalPeerId);
            rig.Run(1);
            var perSecond = host.Session.BytesSentTo(a.Lobby.LocalPeerId) - before;
            var hr = host.Session.Rates;
            Assert.InRange(hr.SnapshotsSent, perSecond * 0.85, perSecond * 1.15);
            Assert.Equal(hr.SnapshotsSent + hr.InputsSent + hr.EventsSent, hr.TotalSent);
            Assert.True(hr.InputsReceived > 0);
            Assert.True(a.Session.Rates.InputsSent > 0);
            Assert.InRange(a.Session.Rates.SnapshotsReceived, hr.SnapshotsSent * 0.85, hr.SnapshotsSent * 1.15);

            host.Session.SendEvent(new byte[10]);
            rig.Run(0.1);
            Assert.True(host.Session.Rates.EventsSent >= 13);
            Assert.True(a.Session.Rates.EventsReceived >= 13);
            rig.Run(1.2);
            Assert.Equal(0, host.Session.Rates.EventsSent);
        }

        [Fact]
        public void PacketLogWritesOneJsonLinePerPacketAtACappedRate()
        {
            var rig = new Rig(new ReplicationConfig(PacketLogPerSecond: 5), latencyMs: 20);
            var host = rig.StartHost();
            var a = rig.Join("a");
            host.Session.Spawn(AlienType, 0, new Alien());
            rig.Run(1);
            var lines = new List<string>();
            a.Session.PacketLog = l => lines.Add(l);
            a.MakeInput = t => new byte[] { (byte)t };
            rig.Run(1);
            Assert.InRange(lines.Count, 5, 10);                // 5 a second, the window may straddle two
            foreach (var l in lines)
            {
                var parts = l.Split(' ', 5);
                Assert.Equal("rep", parts[0]);
                Assert.Contains(parts[1], new[] { "in", "out" });
                Assert.Contains(parts[3], new[] { "fast", "reliable" });
                var doc = JsonDocument.Parse(parts[4]).RootElement;
                Assert.Contains(doc.GetProperty("kind").GetString(), new[] { "snapshot", "input" });
            }
        }
    }
}
