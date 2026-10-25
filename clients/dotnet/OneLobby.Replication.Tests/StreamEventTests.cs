using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace OneLobby.Replication.Tests
{
    public class StreamEventTests
    {
        private static byte[] U32(uint v) => BitConverter.GetBytes(v);

        private static (Rig Rig, Player Host, Player A, List<ReplicatedEvent> Got, List<(byte Stream, uint Expected, uint Next)> Gaps) Setup(ReplicationConfig? cfg = null)
        {
            var rig = new Rig(cfg, latencyMs: 30);
            var host = rig.StartHost();
            var a = rig.Join("a");
            rig.Run(0.5);
            var got = new List<ReplicatedEvent>();
            var gaps = new List<(byte, uint, uint)>();
            a.Session.EventDelivered += e => got.Add(e);
            a.Session.EventGap += g => gaps.Add((g.Stream, g.FirstMissing, g.NextDelivered));
            return (rig, host, a, got, gaps);
        }

        [Fact]
        public void NumberedStreamIsExactlyOnceInOrderEvenWhenTheTransportDuplicatesAndReorders()
        {
            var (rig, host, a, got, gaps) = Setup();
            var on = false;
            rig.Net.DuplicateReliable = () => on && rig.Rng.NextDouble() < 0.2;
            rig.Net.ReorderReliable = () => on && rig.Rng.NextDouble() < 0.2;
            on = true;
            for (uint i = 1; i <= 200; i++)
            {
                host.Session.SendEvent(U32(i), a.Lobby.LocalPeerId, stream: 3);
                if (i % 10 == 0) rig.Step();
            }
            rig.Run(1);
            on = false;
            Assert.Equal(Enumerable.Range(1, 200).Select(i => (uint)i), got.Select(e => e.Seq));
            Assert.Equal(got.Select(e => e.Seq), got.Select(e => BitConverter.ToUInt32(e.Payload.Span)));
            Assert.All(got, e => Assert.Equal(3, e.Stream));
            Assert.Empty(gaps);
            Assert.True(a.Session.Stats.EventsDuplicate > 0);
            Assert.True(a.Session.Stats.EventsOutOfOrder > 0);
            Assert.Equal(0, a.Session.Stats.EventsGap);
        }

        [Fact]
        public void ALostEventIsReportedAsAGapAfterTheTimeoutAndTheStreamGoesOn()
        {
            var (rig, host, a, got, gaps) = Setup();
            var drop = new HashSet<uint> { 5, 6, 40 };
            uint sending = 0;
            rig.Net.DropReliable = () => drop.Contains(sending);
            for (sending = 1; sending <= 50; sending++) host.Session.SendEvent(U32(sending), a.Lobby.LocalPeerId, stream: 1);
            sending = 0;
            rig.Run(0.5);
            Assert.Equal(4, got.Count);                                    // 1-4; 7.. wait for 5
            rig.Run(2.5);
            Assert.Equal(47, got.Count);
            Assert.Equal(new[] { ((byte)1, 5u, 7u), ((byte)1, 40u, 41u) }, gaps.ToArray());
            Assert.Equal(2, a.Session.Stats.EventsGap);
            var seqs = got.Select(e => e.Seq).ToList();
            Assert.Equal(seqs.OrderBy(s => s), seqs);
        }

        [Fact]
        public void StreamsAreNumberedSeparatelyPerRecipientAndPlainEventsHaveNoSeq()
        {
            var (rig, host, a, got, _) = Setup();
            var b = rig.Join("b");
            var gotB = new List<ReplicatedEvent>();
            b.Session.EventDelivered += e => gotB.Add(e);
            host.Session.SendEvent(U32(1), stream: 1);                     // both clients: seq 1
            host.Session.SendEvent(U32(2), a.Lobby.LocalPeerId, stream: 1); // a only: seq 2
            host.Session.SendEvent(U32(3), stream: 2);
            host.Session.SendEvent(U32(4));
            host.Session.SendEvent(U32(5), stream: 1);                     // a: 3, b: 2
            rig.Run(0.5);
            Assert.Equal(new[] { (1, 1u), (1, 2u), (2, 1u), (0, 0u), (1, 3u) }, got.Select(e => ((int)e.Stream, e.Seq)).ToArray());
            Assert.Equal(new[] { (1, 1u), (2, 1u), (0, 0u), (1, 2u) }, gotB.Select(e => ((int)e.Stream, e.Seq)).ToArray());
            Assert.True(host.Session.ReliableEventBytesSentTo(a.Lobby.LocalPeerId) > host.Session.ReliableEventBytesSentTo(b.Lobby.LocalPeerId));
            Assert.Equal(5, a.Events.Count);                               // EventReceived still fires for every event

            a.Session.SendEvent(U32(9), stream: 7);                        // client to host
            var atHost = new List<ReplicatedEvent>();
            host.Session.EventDelivered += e => atHost.Add(e);
            rig.Run(0.5);
            Assert.Equal((7, 1u), ((int)atHost.Single().Stream, atHost.Single().Seq));
        }

        [Fact]
        public void NumberedStreamsAreReliableOnly()
        {
            var (_, host, a, _, _) = Setup();
            Assert.Throws<ArgumentException>(() => host.Session.SendEvent(U32(1), a.Lobby.LocalPeerId, Channel.Fast, stream: 1));
        }

        [Theory]
        [InlineData(0)]
        [InlineData(8)]
        public void HoldEventsForTicksLinesEventsUpWithTheirSnapshot(int hold)
        {
            var (rig, host, a, got, _) = Setup(new ReplicationConfig(HoldEventsForTicks: hold));
            rig.Net.ExtraDelayMs = ch => ch == PeerChannel.Fast ? 60 : 0;  // snapshots come in after the events
            var latestAtDelivery = new List<(uint Tick, uint Latest)>();
            a.Session.EventDelivered += e => latestAtDelivery.Add((e.Tick, a.Session.LatestTick));
            rig.HostTick = t => { if (t % 5 == 0) host.Session.SendEvent(U32(t), stream: 1); };
            rig.Run(3);
            Assert.True(latestAtDelivery.Count > 10);
            var early = latestAtDelivery.Count(x => x.Latest < x.Tick);
            if (hold == 0) Assert.True(early > latestAtDelivery.Count / 2, "unheld events beat their snapshot: " + early);
            else Assert.Equal(0, early);
            Assert.Equal(got.Select(e => e.Seq).OrderBy(s => s), got.Select(e => e.Seq));
        }

        // A joiner that breaks the stream contract on purpose (holes, huge jumps, the Fast channel) cannot make the host
        // hold its events without bound.
        private static void Forge(Player from, int to, byte stream, uint seq, int payloadBytes = 4, Channel channel = Channel.Reliable)
            => from.Lobby.Send(to, Proto.EncodeStreamEvent(1, stream, seq, new byte[payloadBytes], new ByteWriter()), channel);

        [Fact]
        public void AJoinerSendingOnlyHolesCannotGrowTheHostsBuffer()
        {
            var (rig, host, a, _, _) = Setup();
            var gaps = new List<StreamGap>();
            host.Session.EventGap += g => gaps.Add(g);
            for (uint seq = 2; seq <= 2000; seq += 2)
            {
                Forge(a, host.Lobby.LocalPeerId, 1, seq);
                if (seq % 100 == 0) rig.Step();
            }
            rig.Run(0.3);                                                  // well under the 1 s gap timeout
            Assert.InRange(host.Session.BufferedStreamEvents, 0, ReplicationSession.MaxStreamBuffered);
            Assert.NotEmpty(gaps);
        }

        [Fact]
        public void BigPayloadsHitTheByteCapBeforeTheCountCap()
        {
            var (rig, host, a, _, _) = Setup();
            for (uint seq = 2; seq <= 40; seq += 2) Forge(a, host.Lobby.LocalPeerId, 1, seq, payloadBytes: 64 * 1024);
            rig.Run(0.3);
            Assert.InRange(host.Session.BufferedStreamEvents, 0, ReplicationSession.MaxStreamBufferedBytes / (64 * 1024));
        }

        [Fact]
        public void AFarJumpOrTheFastChannelIsMalformed()
        {
            var (rig, host, a, _, _) = Setup();
            var got = new List<ReplicatedEvent>();
            host.Session.EventDelivered += e => got.Add(e);
            Forge(a, host.Lobby.LocalPeerId, 1, ReplicationSession.MaxStreamAhead + 1);
            Forge(a, host.Lobby.LocalPeerId, 2, 1, channel: Channel.Fast);
            Forge(a, host.Lobby.LocalPeerId, 3, 1);                        // a good one still arrives
            rig.Run(0.3);
            Assert.Equal(2, host.Session.Stats.Malformed);
            Assert.Equal(0, host.Session.BufferedStreamEvents);
            Assert.Equal(new byte[] { 3 }, got.Select(e => e.Stream));
        }
    }
}
