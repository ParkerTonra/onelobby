using System;
using System.Collections.Generic;
using System.Linq;
using OneLobby.Replication;
using Xunit;
using Xunit.Abstractions;

namespace OneLobby.Replication.Tests
{
    /// <summary>
    /// D1 to D6 of spec/net-player.md section 11 on the in-memory rig (virtual clock, no socket): host and two clients, 100 ms one
    /// way, 20 ms jitter, 3% loss on the fast channel, a fixed seed, 16 ms frames, once for each authority. The measured numbers are
    /// written with ITestOutputHelper: <c>dotnet test ... --logger "console;verbosity=detailed"</c> shows them.
    /// </summary>
    // D1 holds, over the seeds below: per seed the mean and the 99th percentile of the per-frame error, over all seeds the worst frame. The
    // three clients hold the same numbers. Measured here (PreciseArrival, loss 3%, jitter 20 ms): see the lines the test writes.
    public class NetPlayerTests
    {
        private readonly ITestOutputHelper _out;
        public NetPlayerTests(ITestOutputHelper output) { _out = output; }

        private const double D1bMaxErrorM = 0.25, D1MaxErrorM = 0.45, D1MeanErrorM = 0.15, D1P99ErrorM = 0.4, CarryOnCapMs = 250, D3OnTimeTicks = 2;
        private static readonly int[] D1Seeds = { 1, 2, 7, 8 };

        [Theory, InlineData(PlayerAuthority.Owner), InlineData(PlayerAuthority.Host)]
        public void D1_WatchedPathStaysWithinAnErrorOfTheOwnersPath(PlayerAuthority mode)
        {
            double worst = 0;
            foreach (var seed in D1Seeds)
            {
                var s = Scene.Make(mode, seed: seed, precise: true);
                s.Drive();
                s.Rig.Run(3);
                var (owner, watched) = s.Record(20);
                var r = Scene.ComparePaths(owner, watched);
                _out.WriteLine($"D1 {mode} seed {seed}: lag {r.LagMs} ms, mean {r.Mean:F3} m, p99 {r.P99:F3} m, worst {r.Max:F3} m, delay {s.Bl.Session.InterpolationDelayMs:F1} ms jitter {s.Bl.Session.JitterMs:F1} ms");
                Assert.True(watched.Count > 1000);
                Assert.True(r.Mean < D1MeanErrorM, $"seed {seed} mean " + r.Mean);
                Assert.True(r.P99 < D1P99ErrorM, $"seed {seed} p99 " + r.P99);
                worst = Math.Max(worst, r.Max);
            }
            _out.WriteLine($"D1 {mode}: worst frame over all seeds {worst:F3} m");
            Assert.True(worst < D1MaxErrorM, "worst " + worst);
        }

        // A lost or late input leaves a tick on which the host has nothing new from the owner. Owner mode must not keep that tick as
        // extra delay for the rest of the run (loss 3%, no jitter, these seeds).
        [Theory, InlineData(4), InlineData(10), InlineData(13)]
        public void D1b_AStalledTickDoesNotStayAsDelay(int seed)
        {
            var s = Scene.Make(PlayerAuthority.Owner, jitterMs: 0, seed: seed, precise: true);
            s.Drive();
            s.Rig.Run(3);
            var (owner, watched) = s.Record(20);
            var r = Scene.ComparePaths(owner, watched);
            _out.WriteLine($"D1b seed {seed}: lag {r.LagMs} ms, mean {r.Mean:F3} m, worst {r.Max:F3} m");
            Assert.True(r.Max < D1bMaxErrorM, "worst " + r.Max);
        }

        // One runner hitch: a process that stalls for 4, 5 or 7 ticks mid-walk, then runs on. The owner's stall, or the host's, must not leave
        // the host's record of the walker a tick or more ahead for the rest of the run. As in the engine-smoke players run, the path judged is
        // the host's own record of the walker against the walker's own path (not a third peer's interpolated view). Samples are not taken while
        // the hitched process is stopped (a stopped process samples nothing) nor for two seconds after it (the stall itself is lost time and the path takes a moment to settle; it is
        // the lag that is left that counts). The whole of the rest is judged with the D1 bounds, one constant lag fitted over the run, and the
        // lag fitted after the hitch must be the lag fitted before it, give or take half a tick. No loss (jitter 20 ms as in D1): a lost command
        // is a step a host-mode host never takes whatever the hitch, which would bury the hitch in noise.
        [Theory]
        [InlineData(PlayerAuthority.Owner, true, 4), InlineData(PlayerAuthority.Owner, true, 5), InlineData(PlayerAuthority.Owner, true, 7)]
        [InlineData(PlayerAuthority.Owner, false, 4), InlineData(PlayerAuthority.Owner, false, 5), InlineData(PlayerAuthority.Owner, false, 7)]
        [InlineData(PlayerAuthority.Host, true, 4), InlineData(PlayerAuthority.Host, true, 5), InlineData(PlayerAuthority.Host, true, 7)]
        [InlineData(PlayerAuthority.Host, false, 4), InlineData(PlayerAuthority.Host, false, 5), InlineData(PlayerAuthority.Host, false, 7)]
        public void D1c_AHitchDoesNotLeaveTheHostsRecordAhead(PlayerAuthority mode, bool freezeOwner, int ticks)
        {
            double worst = 0, worstMean = 0;
            var maxShift = 0;
            foreach (var seed in D1Seeds)
            {
                var s = Scene.Make(mode, loss: 0, seed: seed, precise: true);
                s.Drive();
                s.Rig.Run(3);
                var victim = freezeOwner ? s.A : s.Host;
                var frozenFrames = (int)Math.Ceiling(ticks * 1000.0 / 30 / s.Rig.FrameMs);
                var owner = new List<Pt>();
                var before = new List<Pt>();
                var after = new List<Pt>();
                var frames = 20 * 1000 / s.Rig.FrameMs;
                var hitchAt = 10 * 1000 / s.Rig.FrameMs;
                var settle = 2000 / s.Rig.FrameMs;
                for (var i = 0; i < frames; i++)
                {
                    if (i == hitchAt) s.Rig.Frozen.Add(victim);
                    if (i == hitchAt + frozenFrames) s.Rig.Frozen.Remove(victim);
                    s.Rig.Step();
                    var stopped = i >= hitchAt && i < hitchAt + frozenFrames;
                    var t = s.Rig.NowMs;
                    if (!(stopped && freezeOwner) && s.Al.TryGet(s.Al.LocalPeerId, out var mine)) owner.Add(new Pt { T = t, X = mine.X, Y = mine.Y, Z = mine.Z });
                    if (!s.Hl.TryGet(s.A.PeerId, out var seen)) continue;
                    var pt = new Pt { T = t, X = seen.X, Y = seen.Y, Z = seen.Z };
                    if (i < hitchAt) before.Add(pt);
                    else if (i >= hitchAt + frozenFrames + settle) after.Add(pt);
                }
                var all = new List<Pt>(before);
                all.AddRange(after);
                var r = Scene.ComparePaths(owner, all);
                var rb = Scene.ComparePaths(owner, before);
                var ra = Scene.ComparePaths(owner, after);
                _out.WriteLine($"D1c {mode} {(freezeOwner ? "owner" : "host")} {ticks} ticks seed {seed}: lag {r.LagMs} ms, mean {r.Mean:F3} m, worst {r.Max:F3} m, n {all.Count}; lag before {rb.LagMs} ms, after {ra.LagMs} ms");
                Assert.True(all.Count > 600);
                worst = Math.Max(worst, r.Max);
                worstMean = Math.Max(worstMean, r.Mean);
                maxShift = Math.Max(maxShift, Math.Abs(ra.LagMs - rb.LagMs));
            }
            Assert.True(worstMean < D1MeanErrorM, "mean " + worstMean);
            Assert.True(worst < D1MaxErrorM, "worst " + worst);
            Assert.True(maxShift <= 16, "the lag moved by " + maxShift + " ms across the hitch");
        }

        [Theory, InlineData(PlayerAuthority.Owner), InlineData(PlayerAuthority.Host)]
        public void D2_WatchedPlayerNeverStandsStillPastTheCarryOnCap(PlayerAuthority mode)
        {
            var s = Scene.Make(mode);
            s.Drive();
            s.Rig.Run(3);
            var (_, watched) = s.Record(20);
            var still = 0; var longest = 0;
            for (var i = 1; i < watched.Count; i++)
            {
                still = Scene.Dist(watched[i], watched[i - 1]) < 1e-4 ? still + s.Rig.FrameMs : 0;
                longest = Math.Max(longest, still);
            }
            _out.WriteLine($"D2 {mode}: longest stand-still {longest} ms over {watched.Count} frames");
            Assert.True(longest <= CarryOnCapMs);

            // the host stops sending: B's view of A carries on by its velocity for at most the cap, then holds
            s.Rig.Frozen.Add(s.Host);
            s.Rig.Run(0.8);
            var newest = s.Bl.Latest(s.A.PeerId)!.Value;
            var p1 = s.Bl.Get(s.A.PeerId)!.Value;
            s.Rig.Run(1.5);
            var p2 = s.Bl.Get(s.A.PeerId)!.Value;
            var carried = Math.Sqrt(Math.Pow(p1.X - newest.X, 2) + Math.Pow(p1.Y - newest.Y, 2) + Math.Pow(p1.Z - newest.Z, 2));
            var speed = Math.Sqrt(newest.Vx * newest.Vx + newest.Vy * newest.Vy + newest.Vz * newest.Vz);
            _out.WriteLine($"D2 {mode}: after the stop it held {carried:F3} m past the newest snapshot (speed {speed:F2} m/s, the cap allows {speed * 0.25:F3} m)");
            Assert.True(Math.Sqrt(Math.Pow(p2.X - p1.X, 2) + Math.Pow(p2.Y - p1.Y, 2) + Math.Pow(p2.Z - p1.Z, 2)) < 1e-6);
            Assert.True(carried <= speed * (CarryOnCapMs / 1000) + 0.05);
        }

        private struct Played { public string Name; public uint Seq, Tick; public bool Late; public double RenderTick; }

        private (Dictionary<string, int> Sent, List<Played> AtB, List<Played> AtHost) EventRun(PlayerAuthority mode, double loss)
        {
            var s = Scene.Make(mode, loss: loss);
            s.Drive();
            s.Rig.Run(3);
            var atB = new List<Played>();
            var atHost = new List<Played>();
            s.Bl.OnAction += e =>
            {
                if (e.Player == s.A.PeerId) atB.Add(new Played { Name = PlayerWire.Name(e.Name), Seq = e.Seq, Tick = e.Tick, Late = e.Late, RenderTick = s.Bl.Session.RenderTick });
            };
            s.Hl.OnAction += e =>
            {
                if (e.Player == s.A.PeerId) atHost.Add(new Played { Name = PlayerWire.Name(e.Name), Seq = e.Seq, Tick = e.Tick, Late = e.Late });
            };
            var sent = new Dictionary<string, int> { ["jump"] = 0, ["shoot"] = 0, ["melee"] = 0 };
            var names = new[] { PlayerAction.Jump, PlayerAction.Shoot, PlayerAction.Melee };
            var frames = 30 * 1000 / s.Rig.FrameMs;
            var every = (int)Math.Round(120.0 / s.Rig.FrameMs);
            for (var i = 0; i < frames; i++)
            {
                s.Rig.Step();
                if (i % every != 0) continue;
                var name = names[(i / every) % 3];
                s.Al.Action(name, name == PlayerAction.Melee ? new ActionArgs { Swing = sent["melee"] % 256 } : default);
                sent[PlayerWire.Name(name)]++;
            }
            s.Rig.Run(3); // let the last ones arrive
            return (sent, atB, atHost);
        }

        [Theory]
        [InlineData(PlayerAuthority.Owner, 0.03), InlineData(PlayerAuthority.Owner, 0.3), InlineData(PlayerAuthority.Host, 0.03), InlineData(PlayerAuthority.Host, 0.3)]
        public void D3_EveryJumpShootAndMeleeArrivesExactlyOnceAndOnTime(PlayerAuthority mode, double loss)
        {
            var (sent, atB, atHost) = EventRun(mode, loss);
            var total = sent.Values.Sum();
            Assert.True(total >= 200);
            foreach (var name in new[] { "jump", "shoot", "melee" })
            {
                Assert.Equal(sent[name], atB.Count(e => e.Name == name));
                Assert.Equal(sent[name], atHost.Count(e => e.Name == name));
            }
            var unique = atB.Select(e => e.Seq).Distinct().Count();
            Assert.Equal(total, unique);
            var late = atB.Count(e => e.Late);
            var onTime = atB.Where(e => !e.Late).Select(e => e.RenderTick - e.Tick).ToList();
            var worst = onTime.Max();
            _out.WriteLine($"D3 {mode} {loss * 100}%: sent {total}, at B {atB.Count}, at host {atHost.Count}, lost {total - unique}, doubled {atB.Count - unique}, late {late}, on-time ones played at most {worst:F2} ticks after their tick");
            if (loss <= 0.03)
            {
                Assert.True(late <= Math.Ceiling(total * 0.02));
                Assert.True(worst <= D3OnTimeTicks);
                Assert.True(onTime.Min() >= 0);
            }
        }

        [Theory, InlineData(PlayerAuthority.Owner), InlineData(PlayerAuthority.Host)]
        public void D4_BytesPerSecondPerPlayerStayUnderTheBudget(PlayerAuthority mode)
        {
            var s = Scene.Make(mode);
            s.Drive();
            // a busy second: a jump every 400 ms, a shot every 700 ms
            var n = 0;
            s.Al.Tick += _ =>
            {
                n++;
                if (n % 12 == 0) s.Al.Action(PlayerAction.Jump);
                if (n % 21 == 0) s.Al.Action(PlayerAction.Shoot, new ActionArgs { Yaw = 10 });
            };
            s.Rig.Run(8);
            double toClient = 0, toHost = 0; var k = 0;
            for (var i = 0; i < 300; i++)
            {
                s.Rig.Step();
                if (i % 6 != 0) continue;
                toClient += s.Hl.BytesPerSecond(s.A.PeerId).Sent;
                toHost += s.Al.BytesPerSecond(s.Al.Session.HostPeerId).Sent;
                k++;
            }
            toClient /= k; toHost /= k;
            _out.WriteLine($"D4 {mode}: host to client A {toClient:F0} B/s, client A to host {toHost:F0} B/s (3 players, state {s.Al.Codec.StateBytes} B, input {s.Al.Codec.InputBytes} B, jump every 400 ms and shot every 700 ms)");
            Assert.True(toClient < 1500);
            Assert.True(toHost < 3500);
            Assert.True(toClient > 100);
        }

        [Fact]
        public void D4_ReceivedBytesAreCountedToo()
        {
            var s = Scene.Make(PlayerAuthority.Owner);
            s.Drive();
            s.Rig.Run(4);
            var down = s.Al.BytesPerSecond(s.Al.Session.HostPeerId).Received;
            _out.WriteLine($"D4 owner: host to client A as A counts it {down:F0} B/s");
            Assert.True(down > 100 && down < 1500);
        }

        [Fact]
        public void D5_HostModePredictionEndsEqualAndSmoothsOrSnaps()
        {
            double glitch = 0;
            PlayerState HostStep(PlayerState st, NetPlayerInput i, double dt)
            {
                var r = Scene.WalkStep(st, i, dt);
                if (glitch != 0 && i.Yaw > 89 && i.Yaw < 91) { r.X += glitch; glitch = 0; }
                return r;
            }
            var cfg = new ReplicationConfig(AdaptiveDelay: true);
            var rig = new Rig(cfg, 50, 0.1, 10);
            var host = rig.StartHostLayer(new NetPlayersOptions { Authority = PlayerAuthority.Host, Step = HostStep });
            var a = rig.JoinLayer("a", new NetPlayersOptions { Authority = PlayerAuthority.Host, Step = Scene.WalkStep });
            var hl = host.Layer!; var al = a.Layer!;
            var moving = true;
            double maxErr = 0;
            al.Tick += _ =>
            {
                var t = rig.NowMs / 1000.0;
                al.SetLocalInput(moving ? new NetPlayerInput { MoveX = Math.Sin(0.8 * t), MoveY = Math.Cos(0.8 * t), Yaw = 90 } : new NetPlayerInput { Yaw = 90 });
            };
            rig.Run(3);
            for (var i = 0; i < 400; i++)
            {
                rig.Step();
                if (hl.TryGetLatest(a.PeerId, out var h) && i > 100) maxErr = Math.Max(maxErr, Math.Sqrt(Math.Pow(al.Local!.Value.X - h.X, 2) + Math.Pow(al.Local!.Value.Z - h.Z, 2)));
            }
            moving = false;
            rig.Run(1.5);
            hl.TryGetLatest(a.PeerId, out var hf);
            var l = al.Local!.Value;
            var err = Math.Sqrt(Math.Pow(l.X - hf.X, 2) + Math.Pow(l.Y - hf.Y, 2) + Math.Pow(l.Z - hf.Z, 2));
            _out.WriteLine($"D5: max |predicted - host| while moving {maxErr:F2} m (the host is behind by the round trip); at rest {err:F4} m");
            Assert.True(err < 0.05);

            // a small disagreement of the host: blended over 100 ms, no snap
            moving = true;
            rig.Run(1);
            var before = al.Smoother.SnapCount;
            glitch = 0.5;
            double peak = 0;
            for (var i = 0; i < 40; i++) { rig.Step(); peak = Math.Max(peak, al.Smoother.OffsetRemaining); }
            rig.Run(0.3);
            _out.WriteLine($"D5: a 0.5 m disagreement of the host: offset peaked at {peak:F2} m, {al.Smoother.OffsetRemaining:F3} m left after 0.3 s, snaps {al.Smoother.SnapCount - before}");
            Assert.True(peak > 0.3);
            Assert.Equal(before, al.Smoother.SnapCount);
            Assert.True(al.Smoother.OffsetRemaining < 0.05);

            // a large one snaps
            rig.Run(0.5);
            var before2 = al.Smoother.SnapCount;
            glitch = 6;
            rig.Run(1);
            _out.WriteLine($"D5: a 6 m disagreement of the host: snaps {al.Smoother.SnapCount - before2}");
            Assert.Equal(before2 + 1, al.Smoother.SnapCount);
        }

        private static List<double> Steps(List<Pt> p)
        {
            var o = new List<double>();
            for (var i = 1; i < p.Count; i++) o.Add(Scene.Dist(p[i], p[i - 1]));
            return o;
        }

        [Theory, InlineData(PlayerAuthority.Owner), InlineData(PlayerAuthority.Host)]
        public void D6_ATeleportAndARespawnSnapOnTheOtherScreens(PlayerAuthority mode)
        {
            var s = Scene.Make(mode);
            // A's game keeps walking its path from wherever it was put: the path plus a shift that a teleport changes
            double shiftX = 0, shiftZ = 0;
            if (mode == PlayerAuthority.Owner)
                s.Al.Tick += _ => { var p = Scene.PathAt(s.Rig.NowMs); p.X += shiftX; p.Z += shiftZ; s.Al.SetLocalState(p); };
            else s.Drive();
            s.Rig.Run(4);
            var seenRespawn = new List<int>();
            s.Bl.OnAction += e => { if (e.Name == PlayerAction.Respawn) seenRespawn.Add(e.Player); };
            foreach (var kind in new[] { "teleport", "respawn" })
            {
                var watched = new List<Pt>();
                var (tx, tz) = kind == "teleport" ? (60.0, 60.0) : (-70.0, -70.0);
                for (var i = 0; i < 120; i++)
                {
                    if (i == 30)
                    {
                        if (mode == PlayerAuthority.Owner)
                        {
                            var p = Scene.PathAt(s.Rig.NowMs);
                            shiftX = tx - p.X; shiftZ = tz - p.Z;
                            var st = s.Al.Local!.Value; st.X = tx; st.Z = tz;
                            if (kind == "teleport") s.Al.Teleport(st); else s.Al.Respawn(st);
                        }
                        else
                        {
                            var st = s.Hl.Latest(s.A.PeerId)!.Value; st.X = tx; st.Z = tz;
                            if (kind == "teleport") s.Hl.TeleportPlayer(s.A.PeerId, st); else s.Hl.RespawnPlayer(s.A.PeerId, st);
                        }
                    }
                    s.Rig.Step();
                    var v = s.Bl.Get(s.A.PeerId)!.Value;
                    watched.Add(new Pt { T = s.Rig.NowMs, X = v.X, Y = v.Y, Z = v.Z });
                }
                var d = Steps(watched);
                var big = d.Count(x => x > 40);
                var slide = d.Count(x => x > 1 && x < 40);
                _out.WriteLine($"D6 {mode} {kind}: {big} frame(s) jumped over 40 m, {slide} frame(s) slid between 1 and 40 m; largest ordinary step {d.Where(x => x <= 1).Max():F2} m");
                Assert.Equal(1, big);
                Assert.Equal(0, slide);
                if (mode == PlayerAuthority.Host) s.Rig.Run(1);
            }
            Assert.Equal(new[] { s.A.PeerId }, seenRespawn);
        }

        [Fact]
        public void HostAuthorityTheOwnerStartsWhereTheHostSpawnedIt()
        {
            const double SpawnX = 50;
            var cfg = new ReplicationConfig(AdaptiveDelay: true);
            var rig = new Rig(cfg, 100, 0.03, 20);
            var o = new NetPlayersOptions { Authority = PlayerAuthority.Host, Step = Scene.WalkStep, Spawn = _ => new PlayerState { X = SpawnX, Y = 1 } };
            var host = rig.StartHostLayer(o);
            var a = rig.JoinLayer("a", o);
            var hl = host.Layer!; var al = a.Layer!;
            var corrected = 0;
            al.Corrected += _ => corrected++;
            // the owner holds "walk right" from its very first tick, including the ticks before the host's first state arrives
            al.Tick += _ => al.SetLocalInput(new NetPlayerInput { MoveX = 1, Yaw = 90 });
            double? firstX = null; var minX = double.PositiveInfinity; var frames = 0; var without = 0; long inputsBefore = -1;
            for (var i = 0; i < 300; i++)
            {
                rig.Step();
                var l = al.Local;
                if (l == null) { without++; inputsBefore = al.Session.Stats.InputsSent; continue; }
                frames++;
                firstX ??= l.Value.X;
                minX = Math.Min(minX, l.Value.X);
            }
            _out.WriteLine($"host authority spawn x={SpawnX}: {without} frames without a local state, first local x {firstX:F3}, lowest local x {minX:F3}, snaps {al.Smoother.SnapCount}, corrections {al.Stats.Corrections}, corrected events {corrected}, inputs sent before the first state {inputsBefore}");
            Assert.True(frames > 200);
            Assert.True(minX > SpawnX - 1);
            Assert.True(Math.Abs(firstX!.Value - SpawnX) < 6.0 / 30 + 0.01);
            Assert.Equal(0, al.Smoother.SnapCount);
            Assert.Equal(0, al.Stats.Corrections);
            Assert.Equal(0, corrected);
            Assert.True(without > 0);
            Assert.Equal(0, inputsBefore);
            Assert.True(hl.Latest(al.LocalPeerId)!.Value.X > SpawnX);
        }

        [Fact]
        public void OwnerAuthorityTheLocalPlayerExistsAtOnceAndItsFirstStateIsSentBeforeAnyJoin()
        {
            var s = Scene.Make(PlayerAuthority.Owner, loss: 0, jitterMs: 0);
            // before the layer has been pumped even once: the owner has a state and can read itself
            s.Al.SetLocalState(new PlayerState { X = 5 });
            Assert.NotNull(s.Al.Local);
            Assert.True(s.Al.TryGet(s.A.PeerId, out var mine));
            Assert.Equal(5, mine.X);
            Assert.DoesNotContain(s.A.PeerId, s.Al.Players);
            s.Al.Tick += _ => s.Al.SetLocalState(new PlayerState { X = 5 });
            s.Rig.Run(1.5);
            // the other machines learned of the player from that state
            Assert.True(s.Hl.TryGetLatest(s.A.PeerId, out var onHost));
            Assert.Equal(5, onHost.X, 1);
            Assert.Contains(s.A.PeerId, s.Bl.Players);
        }
    }
}
