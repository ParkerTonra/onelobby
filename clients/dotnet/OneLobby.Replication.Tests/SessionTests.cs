using System;
using System.Collections.Generic;
using System.Linq;
using OneLobby.Replication;
using Xunit;
using Xunit.Abstractions;

namespace OneLobby.Replication.Tests
{
    public class SessionTests
    {
        private readonly ITestOutputHelper _out;
        public SessionTests(ITestOutputHelper output) { _out = output; }

        private const ushort AlienType = 7, PlayerType = 1;

        private static void AssertWorldsMatchHost(ReplicationSession host, ReplicationSession client)
        {
            var n = 0;
            foreach (var w in client.ClientWorlds)
            {
                var hw = host.HostWorld(w.Tick);
                if (hw == null) continue; // older than the host's history
                Assert.Equal(hw.Ents.Select(e => e.Id), w.Ents.Select(e => e.Id));
                for (var i = 0; i < w.Ents.Count; i++)
                {
                    Assert.Equal(hw.Ents[i].Type, w.Ents[i].Type);
                    Assert.Equal(hw.Ents[i].Owner, w.Ents[i].Owner);
                    Assert.Equal(hw.Ents[i].State, w.Ents[i].State);
                }
                n++;
            }
            Assert.True(n > 10, "compared only " + n + " ticks");
        }

        [Fact]
        public void SpawnAndDespawnReachTheClientWithTypeAndOwner()
        {
            var rig = new Rig();
            var host = rig.StartHost();
            var a = rig.Join("a");
            var alien = new Alien { X = 10, Z = -4 };
            var avatar = new Alien { X = 1 };
            var alienId = host.Session.Spawn(AlienType, 0, alien);
            var avatarId = host.Session.Spawn(PlayerType, a.Lobby.LocalPeerId, avatar);
            Assert.True(rig.Until(() => a.Spawned.Count == 2));
            Assert.Contains(new EntityInfo(alienId, AlienType, 0), a.Spawned);
            Assert.Contains(new EntityInfo(avatarId, PlayerType, a.Lobby.LocalPeerId), a.Spawned);
            Assert.True(a.Session.IsMine(a.Session.Entities.Single(e => e.Id == avatarId)));
            Assert.True(a.Session.TrySample<AlienState>(alienId, out var s));
            Assert.Equal(10, s.X, 2);
            Assert.Equal(-4, s.Z, 2);

            host.Session.Despawn(alienId);
            Assert.True(rig.Until(() => a.Despawned.Count == 1));
            Assert.Equal(alienId, a.Despawned[0].Id);
            Assert.False(a.Session.TrySample<AlienState>(alienId, out _));
            Assert.Single(a.Session.Entities);
        }

        [Fact]
        public void DespawnShowsAtRenderTimeNotOnReceipt()
        {
            var rig = new Rig(latencyMs: 20);
            var host = rig.StartHost();
            var a = rig.Join("a");
            var id = host.Session.Spawn(AlienType, 0, new Alien());
            Assert.True(rig.Until(() => a.Spawned.Count == 1));
            rig.Run(0.5);
            host.Session.Despawn(id);
            uint despawnTick = host.Session.Clock.Tick + 1;
            Assert.True(rig.Until(() => a.Session.LatestTick >= despawnTick));
            Assert.Empty(a.Despawned); // received, but the render time is still ~100 ms behind
            Assert.True(rig.Until(() => a.Despawned.Count == 1));
            Assert.True(a.Session.RenderTick >= despawnTick);
        }

        [Fact]
        public void DeltaStateIsExactAfterLossAndJitter()
        {
            var rig = new Rig(latencyMs: 40, lossRate: 0.2, jitterMs: 30);
            var host = rig.StartHost();
            var a = rig.Join("a");
            var b = rig.Join("b");
            var aliens = new List<(NetId Id, Alien A)>();
            for (var i = 0; i < 20; i++) { var al = new Alien { X = i }; aliens.Add((host.Session.Spawn(AlienType, 0, al), al)); }
            var r = new Random(7);
            rig.HostTick = tick =>
            {
                foreach (var (_, al) in aliens)
                {
                    al.X += (float)(r.NextDouble() - 0.5); al.Z += 0.05f; al.Yaw += 3;
                    if (r.Next(10) == 0) al.Anim = (byte)r.Next(16);
                }
                if (tick % 15 == 0) { var al = new Alien { X = -5 }; aliens.Add((host.Session.Spawn(AlienType, 0, al), al)); }
                if (tick % 20 == 0 && aliens.Count > 5) { host.Session.Despawn(aliens[0].Id); aliens.RemoveAt(0); }
            };
            rig.Run(6);
            Assert.True(a.Session.Stats.SnapshotsReceived > 100);
            Assert.True(host.Session.Stats.FullSnapshotsSent < host.Session.Stats.SnapshotsSent / 5);
            AssertWorldsMatchHost(host.Session, a.Session);
            AssertWorldsMatchHost(host.Session, b.Session);
            Assert.Equal(0, a.Session.Stats.Malformed);
            _out.WriteLine($"a: received {a.Session.Stats.SnapshotsReceived}, dropped (baseline gone) {a.Session.Stats.SnapshotsDropped}");
        }

        [Fact]
        public void LateJoinerGetsAFullSnapshotThenDeltas()
        {
            var rig = new Rig(latencyMs: 30);
            var host = rig.StartHost();
            var early = rig.Join("early");
            var ids = Enumerable.Range(0, 30).Select(i => host.Session.Spawn(AlienType, 0, new Alien { X = i })).ToList();
            rig.Run(1);
            for (var i = 0; i < 10; i++) host.Session.Despawn(ids[i]);
            rig.Run(1);
            var fullBefore = host.Session.Stats.FullSnapshotsSent;
            var late = rig.Join("late");
            Assert.True(rig.Until(() => late.Spawned.Count == 20));
            rig.Run(1);
            Assert.Equal(ids.Skip(10).OrderBy(x => x.Value), late.Session.Entities.Select(e => e.Id).OrderBy(x => x.Value));
            Assert.Empty(late.Despawned);
            Assert.True(host.Session.AckedTick(late.Lobby.LocalPeerId) > 0);
            var fulls = host.Session.Stats.FullSnapshotsSent - fullBefore;
            Assert.InRange(fulls, 1, 12); // full until the first ack comes back (~RTT), then deltas
            AssertWorldsMatchHost(host.Session, late.Session);
            Assert.Equal(20, early.Session.Entities.Count);
        }

        [Fact]
        public void HostCountsAClientOnlyOnceItsLinkIsUp()
        {
            var rig = new Rig(latencyMs: 30);
            var host = rig.StartHost();
            var ready = new List<int>();
            host.Session.ClientReady += p => ready.Add(p);
            host.Session.Spawn(AlienType, 0, new Alien { X = 1 });
            rig.Net.CanConnect = (_, _) => false; // this joiner's link never opens
            var stuck = rig.Join("stuck");
            rig.Run(2);
            Assert.False(stuck.Lobby.IsReady);
            Assert.Empty(host.Session.Clients);
            Assert.False(host.Session.IsClientReady(stuck.Lobby.LocalPeerId));
            Assert.Equal(0, host.Session.Stats.SnapshotsSent); // nothing streamed into a dead link
            Assert.True(rig.Until(() => stuck.Lobby.ReadyAsync.IsCompleted, 1200)); // ReadyTimeout gives up
            rig.Run(0.5);
            rig.Net.CanConnect = null;
            var ok = rig.Join("ok");
            Assert.True(ok.Lobby.IsReady);
            Assert.True(rig.Until(() => ok.Spawned.Count == 1));
            rig.Run(1);
            Assert.Equal(new[] { ok.Lobby.LocalPeerId }, host.Session.Clients.ToArray());
            Assert.Equal(new[] { ok.Lobby.LocalPeerId }, ready.ToArray());
            Assert.True(host.Session.IsClientReady(ok.Lobby.LocalPeerId));
            Assert.True(host.Session.Stats.FullSnapshotsSent >= 1); // its first snapshot was a full one
            AssertWorldsMatchHost(host.Session, ok.Session);
        }

        [Fact]
        public void InterpolationRendersAboutOneHundredMsBehindAndIsSmooth()
        {
            var rig = new Rig(latencyMs: 25, jitterMs: 10);
            var host = rig.StartHost();
            var a = rig.Join("a");
            var mover = new Alien();
            var id = host.Session.Spawn(AlienType, 0, mover);
            rig.HostTick = tick => mover.X = tick * 0.1f - 100; // 3 m/s along X
            rig.Run(2);
            var samples = new List<(double Render, float X)>();
            for (var i = 0; i < 120; i++)
            {
                rig.Step();
                Assert.True(a.Session.TrySample<AlienState>(id, out var s));
                samples.Add((a.Session.RenderTick, s.X));
                // interpolated X matches the host's function at the render tick (quantization step is ~0.8 cm)
                Assert.InRange(Math.Abs(s.X - (a.Session.RenderTick * 0.1 - 100)), 0, 0.02);
            }
            for (var i = 1; i < samples.Count; i++) Assert.True(samples[i].X >= samples[i - 1].X - 1e-3, "went backwards at " + i);
            var behindMs = (host.Session.Clock.Tick - a.Session.RenderTick) * 1000.0 / 30;
            _out.WriteLine($"render tick behind host: {behindMs:F0} ms (latency 25 + jitter <= 10 + interp 100)");
            Assert.InRange(behindMs, 100, 190);
            var est = (host.Session.Clock.Tick - a.Session.ServerTick) * 1000.0 / 30;
            Assert.InRange(est, 0, 70); // the server tick estimate trails by about the one-way latency
        }

        [Fact]
        public void RedundantInputsSurviveHeavyLoss()
        {
            (double Received, double Applied) Delivered(int redundancy)
            {
                var rig = new Rig(new ReplicationConfig(InputRedundancy: redundancy), latencyMs: 30, lossRate: 0.3);
                var host = rig.StartHost();
                var a = rig.Join("a");
                a.MakeInput = t => BitConverter.GetBytes(t);
                var got = new HashSet<uint>();
                rig.HostTick = _ =>
                {
                    if (host.Session.TryGetInput(a.Lobby.LocalPeerId, out var f) && !f.Repeated)
                    {
                        got.Add(f.Seq);
                        Assert.Equal(4, f.Bytes.Length);
                    }
                };
                rig.Run(20);
                var sent = a.SubmittedSeqs.Count(s => s < a.SubmittedSeqs.Max() - 10);
                var st = host.Session.Stats;
                // arrived = at least one copy reached the host; applied = handed to the game (the latency cap may skip a few after an outage)
                var applied = got.Count(s => s < a.SubmittedSeqs.Max() - 10) / (double)sent;
                _out.WriteLine($"redundancy {redundancy} at 30% loss: {got.Count} of {a.SubmittedSeqs.Count} inputs applied ({applied:P1}); never arrived {st.InputsLost}, skipped by the latency cap {st.InputsSkipped}, repeats {st.InputsRepeated}");
                return (1 - st.InputsLost / (double)a.SubmittedSeqs.Count, applied);
            }
            var one = Delivered(1);
            var four = Delivered(4);
            Assert.InRange(one.Received, 0.6, 0.8);       // ~70%: one copy, 30% loss
            Assert.True(four.Received >= 0.98, "4x redundancy: arrived " + four.Received); // 1 - 0.3^4 = 99.2%
            Assert.True(four.Applied >= 0.95, "4x redundancy: applied " + four.Applied);
        }

        [Fact]
        public void InputsArriveInOrderWithViewTick()
        {
            var rig = new Rig(latencyMs: 30);
            var host = rig.StartHost();
            var a = rig.Join("a");
            host.Session.Spawn(AlienType, 0, new Alien());
            a.MakeInput = t => new[] { (byte)t };
            var seqs = new List<uint>();
            var views = new List<(double View, uint HostTick)>();
            rig.HostTick = tick =>
            {
                if (host.Session.TryGetInput(a.Lobby.LocalPeerId, out var f) && !f.Repeated) { seqs.Add(f.Seq); views.Add((f.ViewTick, tick)); }
            };
            rig.Run(3);
            Assert.True(seqs.Count > 60);
            for (var i = 1; i < seqs.Count; i++) Assert.Equal(seqs[i - 1] + 1, seqs[i]);
            var (view, at) = views.Last();
            var lagMs = (at - view) * 1000 / 30;
            _out.WriteLine($"shooter view lags host by {lagMs:F0} ms at consumption");
            Assert.InRange(lagMs, 120, 260); // interp 100 + one-way 30 + input travel 30 + buffering
            Assert.True(a.Session.LastProcessedInput > 0);
        }

        [Fact]
        public void ReliableEventsArriveOnceInOrderBothWays()
        {
            var rig = new Rig(latencyMs: 30, lossRate: 0.3);
            var host = rig.StartHost();
            var a = rig.Join("a");
            var b = rig.Join("b");
            for (byte i = 0; i < 20; i++) host.Session.SendEvent(new[] { i });
            host.Session.SendEvent(new byte[] { 99 }, toPeer: b.Lobby.LocalPeerId);
            a.Session.SendEvent(new byte[] { 42 });
            rig.Run(1);
            Assert.Equal(Enumerable.Range(0, 20).Select(i => (byte)i), a.Events.Select(e => e.Payload[0]));
            Assert.Equal(21, b.Events.Count);
            Assert.Equal(99, b.Events.Last().Payload[0]);
            Assert.Equal(new[] { (a.Lobby.LocalPeerId, (byte)42) }, host.Events.Select(e => (e.From, e.Payload[0])));
            Assert.All(a.Events, e => Assert.Equal(host.Lobby.LocalPeerId, e.From));
        }

        [Fact]
        public void OtherRawMessagesPassThrough()
        {
            var rig = new Rig();
            var host = rig.StartHost();
            var a = rig.Join("a");
            var got = new List<byte[]>();
            a.Session.OtherMessage += (f, p, c) => got.Add(p.ToArray());
            host.Lobby.Broadcast(new byte[] { 1, 2, 3 });
            rig.Run(0.2);
            Assert.Single(got);
            Assert.False(ReplicationSession.IsReplicationPayload(got[0]));
        }

        [Fact]
        public void PredictionReconcilesToTheHostsState()
        {
            var rig = new Rig(latencyMs: 50, lossRate: 0.1, jitterMs: 10);
            var host = rig.StartHost();
            var a = rig.Join("a");
            var avatar = new Alien();
            var id = host.Session.Spawn(PlayerType, a.Lobby.LocalPeerId, avatar);
            // movement: input byte = direction (+1 / -1 along X), 0.1 m per tick; same function on both sides
            static float Step(float x, sbyte dir) => Math.Max(-200, Math.Min(200, x + dir * 0.1f));
            var rec = new Reconciler<sbyte, float>(0, (x, d) => Step(x, d)) { Equal = (p, q) => Math.Abs(p - q) <= 0.05f };
            var r = new Random(3);
            sbyte dir = 1;
            a.MakeInput = t =>
            {
                if (t % 20 == 0) dir = (sbyte)(r.Next(2) == 0 ? -1 : 1);
                return new[] { unchecked((byte)dir) };
            };
            rig.HostTick = _ =>
            {
                if (host.Session.TryGetInput(a.Lobby.LocalPeerId, out var f))
                    avatar.X = Quantize.Dequantize(Quantize.Float(Step(avatar.X, unchecked((sbyte)f.Bytes.Span[0])), -256, 256, 16), -256, 256, 16);
            };
            var maxErr = 0f;
            for (var frame = 0; frame < 400; frame++)
            {
                var before = a.SubmittedSeqs.Count;
                rig.Step();
                for (var k = before; k < a.SubmittedSeqs.Count; k++) rec.Predict(a.SubmittedSeqs[k], dir);
                if (a.Session.TryGetLatest<AlienState>(id, out var auth, out _))
                    rec.Reconcile(auth.X, a.Session.LastProcessedInput);
                if (frame > 100) maxErr = Math.Max(maxErr, Math.Abs(rec.Current - avatar.X));
            }
            a.MakeInput = _ => new byte[] { 0 };
            rig.Run(1);
            Assert.True(a.Session.TryGetLatest<AlienState>(id, out var fin, out _));
            rec.Reconcile(fin.X, a.Session.LastProcessedInput);
            _out.WriteLine($"prediction: max |predicted - host| while moving {maxErr:F2} m (the host is behind by RTT), corrections {rec.Corrections}");
            Assert.Equal(avatar.X, rec.Current, 1);
            Assert.True(rec.PendingCount < 30);
        }

        [Fact]
        public void LagCompensatedHitscanHitsWhatTheShooterSaw()
        {
            var rig = new Rig(latencyMs: 60);
            var host = rig.StartHost();
            var a = rig.Join("a");
            var target = new Alien { X = 0, Z = 20 };
            var id = host.Session.Spawn(AlienType, 0, target);
            var history = new HistoryRing<float>(30, (p, q, t) => NetMath.Lerp(p, q, t));
            rig.HostTick = tick =>
            {
                target.X = (float)Math.Sin(tick * 0.2) * 3; // strafing 3 m left/right
                history.Record(tick, id, target.X);
            };
            rig.Run(2);
            // shooter aims exactly at what it renders this frame, then fires (input = aimed X as float)
            InputFrame? shot = null;
            a.MakeInput = _ =>
            {
                Assert.True(a.Session.TrySample<AlienState>(id, out var seen));
                a.MakeInput = null;
                return BitConverter.GetBytes(seen.X);
            };
            var hostSide = rig.HostTick;
            var unCompensatedMiss = 0f;
            var compensatedErr = float.MaxValue;
            rig.HostTick = tick =>
            {
                hostSide!(tick);
                if (shot == null && host.Session.TryGetInput(a.Lobby.LocalPeerId, out var f))
                {
                    shot = f;
                    var x = BitConverter.ToSingle(f.Bytes.Span);
                    unCompensatedMiss = Math.Abs(x - target.X);
                    Assert.True(history.TrySample(id, host.Session.RewindTick(f), out var then));
                    compensatedErr = Math.Abs(x - then);
                }
            };
            rig.Run(1);
            Assert.NotNull(shot);
            _out.WriteLine($"hitscan: error without rewind {unCompensatedMiss:F2} m, with rewind {compensatedErr:F3} m");
            Assert.True(compensatedErr < 0.1f, "rewound error " + compensatedErr);
        }

        [Fact]
        public void RewindIsClampedToMaxRewind()
        {
            var rig = new Rig(new ReplicationConfig(MaxRewindMs: 200));
            var host = rig.StartHost();
            rig.Run(1);
            var now = host.Session.Clock.Tick;
            Assert.Equal(now - 6, host.Session.RewindTick(new InputFrame(1, 0, default, false)), 6);
            Assert.Equal(now - 2.5, host.Session.RewindTick(new InputFrame(1, now - 2.5, default, false)), 6);
            Assert.Equal(now, host.Session.RewindTick(new InputFrame(1, now + 50, default, false)), 6);
        }

        [Fact]
        public void BandwidthFourPlayersFiftyAliensUnderBudget()
        {
            // Worst case for a 4-player co-op game: host + 3 clients, 50 aliens all moving every tick, 4 avatars, 5% loss, jitter.
            var rig = new Rig(latencyMs: 40, lossRate: 0.05, jitterMs: 15);
            var host = rig.StartHost();
            var clients = new[] { rig.Join("a"), rig.Join("b"), rig.Join("c") };
            var r = new Random(11);
            var all = new List<Alien>();
            for (var i = 0; i < 50; i++) { var al = new Alien { X = r.Next(-100, 100), Z = r.Next(-100, 100), Yaw = r.Next(360) }; all.Add(al); host.Session.Spawn(AlienType, 0, al); }
            var avatars = new List<Alien>();
            foreach (var p in clients.Select(c => c.Lobby.LocalPeerId).Prepend(host.Lobby.LocalPeerId))
            { var av = new Alien(); avatars.Add(av); host.Session.Spawn(PlayerType, p, av); }
            foreach (var c in clients) c.MakeInput = t => new byte[] { (byte)t, 0x10, 0x20, 0x30, 0x40, 0x50 }; // move x/y, look yaw/pitch, buttons
            rig.HostTick = tick =>
            {
                foreach (var al in all)
                {
                    // walk towards a player at ~4 m/s with a wobble; animation flips now and then
                    var rad = al.Yaw * Math.PI / 180;
                    al.Yaw += (float)(r.NextDouble() * 6 - 3);
                    al.X += (float)Math.Cos(rad) * 0.13f; al.Z += (float)Math.Sin(rad) * 0.13f;
                    al.Y = (float)Math.Sin(tick * 0.05 + al.Z) * 0.2f;
                    if (r.Next(30) == 0) al.Anim = (byte)r.Next(16);
                }
                foreach (var av in avatars) { av.X += 0.2f; av.Yaw += 1; }
                foreach (var c in clients) host.Session.TryGetInput(c.Lobby.LocalPeerId, out _);
            };
            rig.Run(2); // warm up: everyone acked, deltas flowing
            var hostTraffic = rig.Net.Traffic(host.Transport);
            hostTraffic.Reset();
            foreach (var c in clients) rig.Net.Traffic(c.Transport).Reset();
            var before = clients.Select(c => host.Session.BytesSentTo(c.Lobby.LocalPeerId)).ToArray();
            var snapsBefore = host.Session.Stats.SnapshotsSent;
            const double seconds = 10;
            rig.Run(seconds);

            var snapsPerClient = (host.Session.Stats.SnapshotsSent - snapsBefore) / (double)clients.Length;
            // replication payload + the 3-byte lobby header on every snapshot frame
            var perClient = clients.Select((c, i) => (host.Session.BytesSentTo(c.Lobby.LocalPeerId) - before[i] + 3 * snapsPerClient) / seconds).ToArray();
            var hostFastUp = hostTraffic.Bytes(PeerChannel.Fast) / seconds;
            var hostReliableUp = hostTraffic.Bytes(PeerChannel.Reliable) / seconds;
            var clientUp = clients.Select(c => rig.Net.Traffic(c.Transport).Bytes(PeerChannel.Fast) / seconds).Max();
            var avgSnap = (double)host.Session.Stats.SnapshotBytesSent / host.Session.Stats.SnapshotsSent;
            _out.WriteLine($"54 entities @30 Hz, 3 clients, 5% loss: snapshot avg {avgSnap:F0} B, largest {host.Session.Stats.LargestSnapshot} B");
            _out.WriteLine($"per-client downstream {perClient.Max() * 8 / 1000:F1} kbit/s ({perClient.Max():F0} B/s)");
            _out.WriteLine($"host upstream fast {hostFastUp * 8 / 1000:F1} kbit/s, reliable {hostReliableUp * 8 / 1000:F1} kbit/s");
            _out.WriteLine($"client upstream (inputs x4 + pings) {clientUp * 8 / 1000:F1} kbit/s");
            foreach (var c in clients) AssertWorldsMatchHost(host.Session, c.Session);

            // Budget (DESIGN s.18): 128 kbit/s per client down, 3 x 128 host up, 16 kbit/s client up, MTU-safe snapshots.
            Assert.All(perClient, b => Assert.True(b * 8 <= 128_000, $"client downstream {b * 8 / 1000:F1} kbit/s"));
            Assert.True(hostFastUp * 8 <= 3 * 128_000, $"host upstream {hostFastUp * 8 / 1000:F1} kbit/s");
            Assert.True(clientUp * 8 <= 16_000, $"client upstream {clientUp * 8 / 1000:F1} kbit/s");
            Assert.True(host.Session.Stats.LargestSnapshot <= 1200, "largest snapshot " + host.Session.Stats.LargestSnapshot);
        }
    }
}
