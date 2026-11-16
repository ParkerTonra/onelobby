using System;
using System.Collections.Generic;
using System.Linq;
using OneLobby.Replication;
using Xunit;
using Xunit.Abstractions;

namespace OneLobby.Replication.Tests
{
    /// <summary>D7 to D9 and the host's draw of the other players (spec/net-player.md sections 6 to 8), on the in-memory rig.</summary>
    public class NetPlayerHostTests
    {
        private readonly ITestOutputHelper _out;
        public NetPlayerHostTests(ITestOutputHelper output) { _out = output; }

        private static double Hyp(double a, double b) => Math.Sqrt(a * a + b * b);

        [Fact]
        public void D7_AnOwnerThatClaimsAMoveOverTheTopSpeedIsPutBack()
        {
            var s = Scene.Make(PlayerAuthority.Owner, limits: new PlayerLimits(12, null, null, null));
            double cheat = 0;
            s.Al.Tick += _ => { var p = Scene.PathAt(s.Rig.NowMs); p.X += cheat; s.Al.SetLocalState(p); cheat = 0; };
            var corrected = new List<long>();
            s.Al.Corrected += _ => corrected.Add(s.Rig.NowMs);
            s.Rig.Run(6);
            Assert.Equal(0, s.Hl.Stats.LimitViolations); // an honest path at 9.6 m/s under a 12 m/s limit
            cheat = 30; // one update claims a move of 30 m in one tick
            double worstHost = 0, worstWatched = 0;
            for (var i = 0; i < 120; i++)
            {
                s.Rig.Step();
                var now = Scene.PathAt(s.Rig.NowMs);
                var h = s.Hl.Latest(s.A.PeerId)!.Value;
                worstHost = Math.Max(worstHost, Hyp(h.X - now.X, h.Z - now.Z));
                var seen = s.Bl.Get(s.A.PeerId)!.Value;
                var old = Scene.PathAt(s.Rig.NowMs - 400);
                worstWatched = Math.Max(worstWatched, Hyp(seen.X - old.X, seen.Z - old.Z));
            }
            _out.WriteLine($"D7 speed: violations {s.Hl.Stats.LimitViolations}, owner told {corrected.Count}x, worst host distance from the true path {worstHost:F2} m, worst distance the watcher saw {worstWatched:F2} m");
            Assert.True(s.Hl.Stats.LimitViolations >= 1);
            Assert.True(corrected.Count >= 1);
            Assert.True(worstHost < 10); // never at the claimed +30 m
            Assert.True(worstWatched < 10);
            var before = s.Hl.Stats.LimitViolations; // and it goes on: the owner is accepted again after it took the host's state
            s.Rig.Run(3);
            Assert.Equal(before, s.Hl.Stats.LimitViolations);
            var hh = s.Hl.Latest(s.A.PeerId)!.Value;
            var n2 = Scene.PathAt(s.Rig.NowMs);
            Assert.True(Hyp(hh.X - n2.X, hh.Z - n2.Z) < 3);
        }

        [Fact]
        public void D7_ATeleportTheOwnerRaisesPassesASecondWithinASecondDoesNot()
        {
            var s = Scene.Make(PlayerAuthority.Owner, limits: new PlayerLimits(12, 3, null, null));
            double shiftX = 0, shiftZ = 0;
            s.Al.Tick += _ => { var p = Scene.PathAt(s.Rig.NowMs); p.X += shiftX; p.Z += shiftZ; s.Al.SetLocalState(p); };
            // a game that is put back takes the host's state as its own
            s.Al.Corrected += st => { var p = Scene.PathAt(s.Rig.NowMs); shiftX = st.X - p.X; shiftZ = st.Z - p.Z; };
            s.Rig.Run(3);
            void Jump(double x, double z)
            {
                var p = Scene.PathAt(s.Rig.NowMs);
                shiftX = x - p.X; shiftZ = z - p.Z;
                var st = s.Al.Local!.Value; st.X = x; st.Z = z;
                s.Al.Teleport(st);
            }
            Jump(80, 80);
            s.Rig.Run(1.5);
            Assert.Equal(0, s.Hl.Stats.LimitViolations);
            var h = s.Hl.Latest(s.A.PeerId)!.Value;
            Assert.True(Hyp(h.X - 80, h.Z - 80) < 14);
            Jump(-80, -80);
            s.Rig.Run(0.3);
            Jump(80, -80); // a second teleport inside the second
            s.Rig.Run(2);
            _out.WriteLine($"D7 teleport: violations {s.Hl.Stats.LimitViolations}");
            Assert.Equal(1, s.Hl.Stats.LimitViolations);
        }

        [Fact]
        public void D7_ShotsOverTheRateLimitAreDroppedAndCountedAndTheOtherClientNeverSeesThem()
        {
            var s = Scene.Make(PlayerAuthority.Owner, limits: new PlayerLimits(null, null, 250, null));
            s.Drive();
            var atHost = new List<uint>(); var atB = new List<uint>();
            s.Hl.OnAction += e => { if (e.Name == PlayerAction.Shoot && e.Player == s.A.PeerId) atHost.Add(e.Seq); };
            s.Bl.OnAction += e => { if (e.Name == PlayerAction.Shoot && e.Player == s.A.PeerId) atB.Add(e.Seq); };
            s.Rig.Run(3);
            for (var i = 0; i < 10; i++) { s.Al.Action(PlayerAction.Shoot, new ActionArgs { Yaw = 5 }); s.Rig.Run(0.3); } // honest: one shot every 300 ms
            s.Rig.Run(1);
            Assert.Equal(0, s.Hl.Stats.ActionsRateLimited);
            Assert.Equal(10, atHost.Count);
            for (var i = 0; i < 30; i++) { s.Al.Action(PlayerAction.Shoot, new ActionArgs { Yaw = 5 }); s.Rig.Run(0.1); } // fast: one shot every 100 ms for 3 s
            s.Rig.Run(2);
            _out.WriteLine($"D7 shots: 40 sent, {atHost.Count} accepted at the host, {s.Hl.Stats.ActionsRateLimited} dropped and counted, {atB.Count} seen by the other client");
            Assert.True(s.Hl.Stats.ActionsRateLimited > 10);
            Assert.Equal(40, atHost.Count + s.Hl.Stats.ActionsRateLimited);
            Assert.Equal(atHost.Count, atB.Count);
        }

        // B shoots 30 times at A (strafing) on a 60 ms one-way link and the host judges each shot with TryRewound.
        private (List<double> Errors, List<double> Inside, List<double> Plain, int Past, double LimitMs) ShootAtStrafer(PlayerAuthority mode, double? maxRewindMs)
        {
            var cfg = maxRewindMs is double m ? new ReplicationConfig(MaxRewindMs: m) : null;
            var s = Scene.Make(mode, latencyMs: 60, session: cfg);
            s.Drive(); // A is the target, strafing
            s.Rig.Run(4);
            var limitMs = s.Hl.Session.Config.MaxRewindMs;
            (double x, double z)? seen = null;
            var errors = new List<double>(); var inside = new List<double>(); var plain = new List<double>(); var past = 0;
            s.Hl.OnAction += e =>
            {
                if (e.Name != PlayerAction.Shoot || e.Player != s.B.PeerId || seen == null) return;
                Assert.True(s.Hl.TryRewound(s.A.PeerId, e.Args.View, out var then));
                var now = s.Hl.Latest(s.A.PeerId)!.Value;
                var err = Hyp(then.X - seen.Value.x, then.Z - seen.Value.z);
                errors.Add(err);
                plain.Add(Hyp(now.X - seen.Value.x, now.Z - seen.Value.z));
                var ageMs = (s.Hl.Session.Clock.Tick - e.Args.View / 256.0) * s.Hl.Session.Clock.TickMs;
                if (ageMs <= limitMs) inside.Add(err); else past++;
                seen = null;
            };
            for (var i = 0; i < 30; i++)
            {
                s.Rig.Run(0.7);
                var v = s.Bl.Get(s.A.PeerId)!.Value;
                seen = (v.X, v.Z);
                s.Bl.Action(PlayerAction.Shoot, new ActionArgs()); // View is the tick B is rendering
                s.Rig.Run(0.5);
            }
            return (errors, inside, plain, past, limitMs);
        }

        [Theory, InlineData(PlayerAuthority.Owner), InlineData(PlayerAuthority.Host)]
        public void D8_TheHostFindsTheTargetWhereTheShooterSawIt(PlayerAuthority mode)
        {
            var (errors, inside, plain, past, limitMs) = ShootAtStrafer(mode, null);
            var worst = errors.Max();
            var worstInside = inside.Count > 0 ? inside.Max() : 0;
            _out.WriteLine($"D8 {mode}: {errors.Count} shots, error with rewind at most {worst:F3} m, without rewind {plain.Min():F2} to {plain.Max():F2} m");
            _out.WriteLine($"D8 {mode}: {past} of the shots were older than the {limitMs} ms rewind limit (the clamp cuts in); the others are off by at most {worstInside:F3} m");
            Assert.Equal(30, errors.Count);
            Assert.True(inside.Count >= 15);
            Assert.True(worstInside < 0.1);
            Assert.True(worst < 0.3);
            Assert.True(plain.Max() > 1);
        }

        [Theory, InlineData(PlayerAuthority.Owner), InlineData(PlayerAuthority.Host)]
        public void D8_WithMaxRewindMs400OnTheSameLinkEveryShotFindsTheTarget(PlayerAuthority mode)
        {
            var (errors, _, _, past, limitMs) = ShootAtStrafer(mode, 400);
            var worst = errors.Max();
            _out.WriteLine($"D8 {mode} maxRewindMs {limitMs}: {errors.Count} shots, {past} past the limit, error at most {worst:F3} m");
            Assert.Equal(30, errors.Count);
            Assert.Equal(0, past);
            Assert.True(worst < 0.1);
        }

        [Fact]
        public void D8_ARewindIsClampedToTheSessionsMaxRewindMs()
        {
            var s = Scene.Make(PlayerAuthority.Owner, session: new ReplicationConfig(MaxRewindMs: 200), joinPeers: false);
            s.Rig.Run(1);
            double now = s.Hl.Session.Clock.Tick;
            Assert.Equal(now - 6, s.Hl.RewindTick(0), 6);
            Assert.Equal(now - 2.5, s.Hl.RewindTick((uint)((now - 2.5) * 256)), 6);
            Assert.Equal(now, s.Hl.RewindTick((uint)((now + 50) * 256)), 6);
        }

        [Fact]
        public void D9_PlayersComeAndGoByThemselves()
        {
            var s = Scene.Make(PlayerAuthority.Owner, spectators: 2);
            var rig = s.Rig;
            s.Drive(s.Hl, 0); s.Drive(s.Al, 1); s.Drive(s.Bl, 2);
            var joined = new List<int>(); var left = new List<int>();
            s.Hl.PlayerJoined += p => joined.Add(p);
            s.Hl.PlayerLeft += p => left.Add(p);
            rig.Run(4);
            var all = new[] { s.Host.PeerId, s.A.PeerId, s.B.PeerId }.OrderBy(x => x).ToArray();
            Assert.Equal(all, s.Hl.Players.OrderBy(x => x).ToArray());
            Assert.Equal(all, s.Al.Players.OrderBy(x => x).ToArray());
            Assert.Equal(all, s.Bl.Players.OrderBy(x => x).ToArray());

            // a late joiner
            var c = rig.JoinLayer("c", new NetPlayersOptions { Authority = PlayerAuthority.Owner });
            s.Drive(c.Layer!, 3);
            rig.Run(4);
            var withC = all.Append(c.PeerId).OrderBy(x => x).ToArray();
            Assert.Equal(withC, c.Layer!.Players.OrderBy(x => x).ToArray());
            Assert.Equal(withC, s.Al.Players.OrderBy(x => x).ToArray());
            Assert.True(c.Layer.TryGet(s.A.PeerId, out _));

            // a spectator has no player, and sees the others
            var d = rig.JoinLayer("d", new NetPlayersOptions { Authority = PlayerAuthority.Owner }, spectator: true);
            d.Layer!.Tick += _ => d.Layer.SetLocalState(Scene.PathAt(rig.NowMs, 4));
            rig.Run(4);
            Assert.DoesNotContain(d.PeerId, s.Hl.Players);
            Assert.DoesNotContain(d.PeerId, s.Al.Players);
            Assert.Equal(withC, d.Layer.Players.OrderBy(x => x).ToArray());

            // a leaver's player disappears
            rig.Leave(s.B);
            rig.Run(5);
            Assert.DoesNotContain(s.B.PeerId, s.Hl.Players);
            Assert.DoesNotContain(s.B.PeerId, s.Al.Players);
            Assert.DoesNotContain(s.B.PeerId, c.Layer.Players);
            Assert.Contains(s.B.PeerId, left);
            Assert.False(s.Hl.TryGet(s.B.PeerId, out _));
            _out.WriteLine($"D9: host saw joined {joined.Count}, left {left.Count}; late joiner saw {c.Layer.Players.Count} players; spectator saw {d.Layer.Players.Count}; host has {s.Hl.Players.Count} after the leaver");
        }

        [Fact]
        public void AHostWithNoClientsStepsItsOwnPlayerInHostMode()
        {
            var s = Scene.Make(PlayerAuthority.Host, joinPeers: false);
            s.Hl.Tick += _ => s.Hl.SetLocalInput(new PlayerInput { MoveX = 1 });
            s.Rig.Run(1);
            Assert.True(s.Hl.Get(s.Hl.LocalPeerId)!.Value.X > 3);
        }

        // ---- the contract the second port settled: the host draws the others ------------------------------------------

        [Theory, InlineData(PlayerAuthority.Owner), InlineData(PlayerAuthority.Host)]
        public void HostDrawsTheOthersOneTickBehindInterpolatedATeleportSnapsAndTheHostsOwnPlayerIsUnchanged(PlayerAuthority mode)
        {
            const double TickTravelM = 9.63 / 30;
            var s = Scene.Make(mode, loss: 0, jitterMs: 0);
            s.Drive();
            if (mode == PlayerAuthority.Owner)
            {
                s.Bl.Tick += _ => s.Bl.SetLocalState(Scene.PathAt(s.Rig.NowMs, 2));
                s.Hl.Tick += _ => s.Hl.SetLocalState(Scene.PathAt(s.Rig.NowMs, 4));
            }
            else s.Bl.Tick += _ =>
            {
                var t = s.Rig.NowMs / 1000.0;
                s.Bl.SetLocalInput(new PlayerInput { MoveX = Math.Sin(0.8 * t + 2), MoveY = Math.Cos(0.8 * t + 2), Yaw = 90 });
            };
            s.Rig.Run(3);
            var last = new Dictionary<int, Pt>();
            int frames = 0, repeats = 0, missing = 0; double biggest = 0;
            for (var i = 0; i < 300; i++)
            {
                s.Rig.Step();
                foreach (var peer in new[] { s.A.PeerId, s.B.PeerId })
                {
                    if (!s.Hl.TryGet(peer, out var v)) { missing++; continue; }
                    var cur = new Pt { X = v.X, Y = v.Y, Z = v.Z };
                    if (last.TryGetValue(peer, out var prev))
                    {
                        var dd = Scene.Dist(cur, prev);
                        frames++;
                        if (dd == 0) repeats++;
                        biggest = Math.Max(biggest, dd);
                    }
                    last[peer] = cur;
                }
                s.Hl.TryGet(s.Hl.LocalPeerId, out var own);
                Assert.Equal(s.Hl.Local!.Value, own); // the host's own player is its own record, as before
            }
            _out.WriteLine($"host draws others ({mode}): {frames} frames of 2 players, {repeats} repeated a position, largest step {biggest:F3} m (one tick of travel at most {TickTravelM:F3} m)");
            Assert.Equal(0, missing);
            Assert.Equal(0, repeats);
            Assert.True(biggest < TickTravelM);

            // a teleport of A snaps (once, no slide), B keeps moving
            var seen = new List<Pt>();
            for (var i = 0; i < 120; i++)
            {
                if (i == 30) { var st = s.Hl.Latest(s.A.PeerId)!.Value; st.X = 60; st.Z = 60; s.Hl.TeleportPlayer(s.A.PeerId, st); }
                s.Rig.Step();
                var v = s.Hl.Get(s.A.PeerId)!.Value;
                seen.Add(new Pt { X = v.X, Y = v.Y, Z = v.Z });
                if (mode == PlayerAuthority.Owner && i == 40) break; // the owner of A is told to take the host's state; the snap is what is tested here
            }
            var d = new List<double>();
            for (var i = 1; i < seen.Count; i++) d.Add(Scene.Dist(seen[i], seen[i - 1]));
            var big = d.Count(x => x > 40); var slide = d.Count(x => x > 1 && x < 40);
            _out.WriteLine($"host draws others ({mode}) teleport: {big} frame(s) jumped over 40 m, {slide} frame(s) slid between 1 and 40 m");
            Assert.Equal(1, big);
            Assert.Equal(0, slide);
        }

        [Fact]
        public void APlayerWithASingleRecordIsHeldWhereItIsAndAPlayerNotInTheWorldIsAbsent()
        {
            var cfg = new ReplicationConfig(AdaptiveDelay: true);
            var rig = new Rig(cfg, 100, 0, 0);
            var o = new NetPlayersOptions { Authority = PlayerAuthority.Host, Step = Scene.WalkStep };
            var host = rig.StartHostLayer(new NetPlayersOptions { Authority = PlayerAuthority.Host, Step = Scene.WalkStep, Spawn = peer => new PlayerState { X = 50 + peer } });
            var a = rig.JoinLayer("a", o);
            var hl = host.Layer!;
            // the layer has made A's player by now; A sends no input, so every record is the spawn point and the sampled state is held there
            Assert.True(hl.TryGet(a.PeerId, out var v));
            Assert.Equal(50 + a.PeerId, v.X, 1);
            Assert.True(Math.Abs(v.Vx) < 0.1);
            Assert.False(hl.TryGet(a.PeerId + 100, out _));
        }
    }
}
