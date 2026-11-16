using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;
using Xunit.Abstractions;

namespace OneLobby.Replication.Tests
{
    /// <summary>
    /// An input with ack 0 from a client that had acked: its session started over (spec/replication.md "Resync"). The host sends it
    /// a full snapshot at once and its input bookkeeping starts over. Same cases as the JS and GDScript tests.
    /// </summary>
    public class Ack0Tests
    {
        private const ushort AlienType = 7;
        private const int WorldSize = 5;
        private readonly ITestOutputHelper _out;
        public Ack0Tests(ITestOutputHelper output) { _out = output; }

        private static (Rig Rig, Player Host, Player A) World(double latency = 100, double jitter = 20, double loss = 0.03)
        {
            var rig = new Rig(new ReplicationConfig { KeyframeSeconds = 0 }, latency, loss, jitter);
            var host = rig.StartHost();
            var a = rig.Join("a");
            for (var i = 0; i < WorldSize; i++) host.Session.Spawn(AlienType, 0, new Alien { X = i });
            a.MakeInput = t => new[] { (byte)t };
            rig.HostTick = tick => host.Session.TryGetInput(a.PeerId, out InputFrame discard);
            return (rig, host, a);
        }

        /// <summary>The client's session starts over on the same lobby: a new session object, sequence numbers from 1, no snapshot.</summary>
        private static void Restart(Player a)
        {
            a.Session.Dispose();
            a.Attach(new ReplicationConfig { KeyframeSeconds = 0 });
        }

        private static int WorldSizeOf(Player a)
        {
            var w = a.Session.ClientWorlds.LastOrDefault();
            return w == null ? 0 : w.Ents.Count;
        }

        private static void SendInput(Player a, uint ack, uint newest) =>
            a.Lobby.Send(a.Lobby.HostPeerId, Proto.EncodeInput(ack, newest, new List<(ulong, byte[])> { (0, new byte[] { 1 }) }, 1, new ByteWriter()), Channel.Fast);

        [Fact]
        public void ASecondSessionGetsTheFullWorldWithinAFewTicksThenDeltasResume()
        {
            var (rig, host, a) = World();
            rig.Run(3);
            Assert.True(host.Session.AckedTick(a.PeerId) > 0);
            var fulls0 = host.Session.Stats.FullSnapshotsSent;
            Restart(a);
            Assert.Equal(0, WorldSizeOf(a));
            var sent0 = host.Session.BytesSentTo(a.PeerId);
            var t0 = rig.NowMs;
            long ms = -1;
            for (var i = 0; i < 250; i++)
            {
                if (WorldSizeOf(a) == WorldSize) { ms = rig.NowMs - t0; break; }
                rig.Step();
            }
            var ticks = ms / host.Session.Clock.TickMs;
            _out.WriteLine($"ack0 second session: world after {ms} ms ({ticks:F1} ticks), extra full snapshots {host.Session.Stats.FullSnapshotsSent - fulls0}, {host.Session.BytesSentTo(a.PeerId) - sent0} snapshot bytes sent to it meanwhile");
            Assert.True(ms >= 0 && ticks <= 12, $"ticks until the second session has the world: {ticks:F1}");
            rig.Run(1);
            var fulls = host.Session.Stats.FullSnapshotsSent;
            var bytes = host.Session.BytesSentTo(a.PeerId);
            rig.Run(1.5);
            Assert.Equal(fulls, host.Session.Stats.FullSnapshotsSent); // deltas resume: no full snapshot in 1.5 s
            _out.WriteLine($"ack0 deltas: {(host.Session.BytesSentTo(a.PeerId) - bytes) / 45.0:F1} bytes per snapshot sent to it");
            Assert.True(host.Session.AckedTick(a.PeerId) > 0);
        }

        [Fact]
        public void ASingleSessionWithJitterAndReorderingNeverTriggersOne()
        {
            var (rig, host, a) = World(60, 90, 0.05);
            rig.Run(2);
            var zeroed = 0;
            var was = host.Session.AckedTick(a.PeerId);
            var full0 = host.Session.Stats.FullSnapshotsSent;
            for (var i = 0; i < 120 * 1000 / rig.FrameMs; i++)
            {
                rig.Step();
                var now = host.Session.AckedTick(a.PeerId);
                if (was > 0 && now == 0) zeroed++;
                was = now;
            }
            _out.WriteLine($"ack0 long run: 120 s, jitter 90 ms, 5% loss: {zeroed} restarts, {host.Session.Stats.FullSnapshotsSent - full0} full snapshots");
            Assert.Equal(0, zeroed);
            Assert.Equal(full0, host.Session.Stats.FullSnapshotsSent);
        }

        [Fact]
        public void ALatePacketWithAck0RightAfterTheFirstAckIsNotARestartAndItIsNotATap()
        {
            var (rig, host, a) = World();
            Assert.True(rig.Until(() => host.Session.AckedTick(a.PeerId) > 0));
            var before = host.Session.AckedTick(a.PeerId);
            SendInput(a, 0, 2); // an input the old session sent before its first snapshot arrived, delivered after a newer one
            rig.Run(0.1);
            Assert.True(host.Session.AckedTick(a.PeerId) >= before);

            rig.Run(3);
            var restarts = 0;
            var was = host.Session.AckedTick(a.PeerId);
            const int seconds = 20;
            for (var i = 0; i < seconds * 1000 / rig.FrameMs; i++)
            {
                if (i % 3 == 0) SendInput(a, 0, 1); // an ack 0 every 48 ms between real acks
                rig.Step();
                var now = host.Session.AckedTick(a.PeerId);
                if (was > 0 && now == 0) restarts++;
                was = now;
            }
            var allowed = (int)Math.Ceiling(seconds * 30.0 / host.Session.Config.HistoryTicks);
            _out.WriteLine($"ack0 tap: {restarts} restarts in {seconds} s with an ack 0 every 48 ms (limit {allowed})");
            Assert.InRange(restarts, 1, allowed);
        }

        [Fact]
        public void TheInputsOfASecondSessionAreAppliedFromSequence1NothingCountedLost()
        {
            var (rig, host, a) = World();
            var handed = new List<(uint Seq, bool Repeated)>();
            rig.HostTick = tick => { if (host.Session.TryGetInput(a.PeerId, out var f)) handed.Add((f.Seq, f.Repeated)); };
            rig.Run(4); // the first session reaches sequence ~120
            Assert.True(handed.Where(h => !h.Repeated).Max(h => h.Seq) > 80);
            var lost0 = host.Session.InputStatsFor(a.PeerId).Lost;
            handed.Clear();
            Restart(a);
            rig.Run(2);
            // the first frames can still be the old session's queued inputs (sequence ~120); the new session's start at 1
            var second = handed.Where(h => !h.Repeated && h.Seq < 100).ToList();
            var lost = host.Session.InputStatsFor(a.PeerId).Lost - lost0;
            _out.WriteLine($"ack0 second session inputs: {second.Count} applied in 2 s (first seq {(second.Count > 0 ? second[0].Seq : 0)}), repeated frames {handed.Count(h => h.Repeated)}, lost {lost}");
            Assert.True(second.Count > 30);
            Assert.Equal(1u, second[0].Seq);
            Assert.InRange(lost, 0, 3);
        }

        [Fact]
        public void APacketOfTheOldSessionStillInFlightAfterTheRestartIsDroppedWhole()
        {
            var (rig, host, a) = World();
            rig.Run(3);
            Restart(a);
            rig.Until(() => host.Session.AckedTick(a.PeerId) == 0, 200); // the host saw the restart, the new session has not acked yet
            var handed = new List<uint>();
            rig.HostTick = tick => { if (host.Session.TryGetInput(a.PeerId, out var f) && !f.Repeated) handed.Add(f.Seq); };
            SendInput(a, host.Session.Clock.Tick - 20, 9000); // an old-session packet: ack of a tick sent before the restart
            rig.Run(1.5);
            Assert.True(handed.Count > 10);
            Assert.DoesNotContain(9000u, handed);
            Assert.True(handed[0] < 10);
        }
    }
}
