using System;
using System.Collections.Generic;
using OneLobby.Replication;

namespace OneLobby.Replication.Tests
{
    internal struct Pt { public double T, X, Y, Z; }

    /// <summary>Host and two clients (A moves, B watches) on the in-memory rig: 100 ms one way, 20 ms jitter, 3% loss on the fast channel, 16 ms frames.</summary>
    internal sealed class Scene
    {
        public Rig Rig = null!;
        public Player Host = null!, A = null!, B = null!;
        public NetPlayers Hl = null!, Al = null!, Bl = null!;
        public PlayerAuthority Mode;

        /// <summary>Host mode movement: 6 m/s on X and Z, facing the input's yaw. The same function runs on the host and in the owner's prediction.</summary>
        public static PlayerState WalkStep(PlayerState s, NetPlayerInput i, double dt)
        {
            s.X += i.MoveX * 6 * dt; s.Z += i.MoveY * 6 * dt; s.Vx = i.MoveX * 6; s.Vz = i.MoveY * 6; s.Yaw = i.Yaw;
            return s;
        }

        public static Scene Make(PlayerAuthority mode, double latencyMs = 100, double jitterMs = 20, double loss = 0.03, PlayerLimits? limits = null,
            ReplicationConfig? session = null, string[]? omit = null, int spectators = 0, bool joinPeers = true, Func<int, PlayerState>? spawn = null, int seed = 1234, bool precise = false)
        {
            var cfg = (session ?? new ReplicationConfig()) with { AdaptiveDelay = true };
            var s = new Scene { Mode = mode, Rig = new Rig(cfg, latencyMs, loss, jitterMs, seed) };
            s.Rig.PreciseArrival = precise;
            var o = new NetPlayersOptions { Authority = mode, Step = WalkStep, Limits = limits ?? new PlayerLimits(null, null, null, null), Omit = omit ?? Array.Empty<string>(), Spawn = spawn };
            s.Host = s.Rig.StartHostLayer(o, spectators);
            s.Hl = s.Host.Layer!;
            if (joinPeers)
            {
                s.A = s.Rig.JoinLayer("a", o); s.Al = s.A.Layer!;
                s.B = s.Rig.JoinLayer("b", o); s.Bl = s.B.Layer!;
            }
            return s;
        }

        /// <summary>A smooth path in metres at a time in ms: a lap of a 12 m circle every ~8 s with a bob, so speed is about 9 m/s at most.</summary>
        public static PlayerState PathAt(double ms, double phase = 0)
        {
            var t = ms / 1000;
            var w = 0.8;
            var s = new PlayerState
            {
                X = 12 * Math.Sin(w * t + phase), Z = 12 * Math.Cos(w * t + phase), Y = 0.5 * Math.Sin(2 * t),
                Vx = 12 * w * Math.Cos(w * t + phase), Vz = -12 * w * Math.Sin(w * t + phase), Vy = 1.0 * Math.Cos(2 * t),
                Pitch = 0, Mode = 2,
            };
            s.Yaw = (Math.Atan2(s.Vx, s.Vz) * 180 / Math.PI + 360) % 360;
            return s;
        }

        /// <summary>Make a layer walk its path: its state each tick (owner mode) or its input each tick (host mode).</summary>
        public void Drive(NetPlayers l, double phase = 0)
        {
            if (l.Authority == PlayerAuthority.Owner) l.Tick += _ => l.SetLocalState(PathAt(Rig.NowMs, phase));
            else l.Tick += _ =>
            {
                var t = Rig.NowMs / 1000.0;
                l.SetLocalInput(new NetPlayerInput { MoveX = Math.Sin(0.8 * t + phase), MoveY = Math.Cos(0.8 * t + phase), Yaw = 90 });
            };
        }

        public void Drive(double phase = 0) => Drive(Al, phase);

        public static double Dist(Pt a, Pt b) => Math.Sqrt((a.X - b.X) * (a.X - b.X) + (a.Y - b.Y) * (a.Y - b.Y) + (a.Z - b.Z) * (a.Z - b.Z));

        /// <summary>The owner's path at time <paramref name="t"/>, interpolated between its frame samples.</summary>
        public static bool At(List<Pt> path, double t, out Pt r)
        {
            r = default;
            if (path.Count == 0 || t < path[0].T || t > path[path.Count - 1].T) return false;
            int lo = 0, hi = path.Count - 1;
            while (hi - lo > 1) { var m = (lo + hi) >> 1; if (path[m].T <= t) lo = m; else hi = m; }
            var a = path[lo]; var b = path[hi];
            var k = b.T == a.T ? 0 : (t - a.T) / (b.T - a.T);
            r = new Pt { T = t, X = a.X + (b.X - a.X) * k, Y = a.Y + (b.Y - a.Y) * k, Z = a.Z + (b.Z - a.Z) * k };
            return true;
        }

        /// <summary>The one constant lag (0 to 600 ms, 8 ms steps) at which the watched path is closest to the owner's on average, with the mean and worst distance there.</summary>
        public static (int LagMs, double Mean, double Max) ComparePaths(List<Pt> owner, List<Pt> watched)
        {
            var best = (LagMs: 0, Mean: double.PositiveInfinity, Max: double.PositiveInfinity);
            for (var lag = 0; lag <= 600; lag += 8)
            {
                double sum = 0, max = 0; var n = 0;
                foreach (var w in watched)
                {
                    if (!At(owner, w.T - lag, out var o)) continue;
                    var d = Dist(w, o);
                    sum += d; if (d > max) max = d; n++;
                }
                if (n > 20 && sum / n < best.Mean) best = (lag, sum / n, max);
            }
            return best;
        }

        /// <summary>Run <paramref name="seconds"/> of frames, recording A's own path and B's view of A each frame.</summary>
        public (List<Pt> Owner, List<Pt> Watched) Record(double seconds, double skipSeconds = 0)
        {
            var owner = new List<Pt>();
            var watched = new List<Pt>();
            var frames = (int)(seconds * 1000 / Rig.FrameMs);
            for (var i = 0; i < frames; i++)
            {
                Rig.Step();
                var t = Rig.NowMs;
                if (Al.TryGet(Al.LocalPeerId, out var mine)) owner.Add(new Pt { T = t, X = mine.X, Y = mine.Y, Z = mine.Z });
                if (Bl.TryGet(A.PeerId, out var seen) && i * Rig.FrameMs >= skipSeconds * 1000) watched.Add(new Pt { T = t, X = seen.X, Y = seen.Y, Z = seen.Z });
            }
            return (owner, watched);
        }
    }
}
