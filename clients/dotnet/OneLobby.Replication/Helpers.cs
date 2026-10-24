using System;
using System.Collections.Generic;

namespace OneLobby.Replication
{
    /// <summary>
    /// Fixed-step tick clock over a monotonic millisecond source (the lobby transport's clock). The game runs one
    /// simulation step per <see cref="TryAdvance"/> that returns true, so the step rate is independent of frame rate.
    /// </summary>
    public sealed class NetworkClock
    {
        private readonly Func<long> _now;
        private long _startMs;
        private bool _started;

        public NetworkClock(int tickRate, Func<long> nowMs)
        {
            if (tickRate < 1 || tickRate > 240) throw new ArgumentOutOfRangeException(nameof(tickRate));
            TickRate = tickRate;
            _now = nowMs;
        }

        public int TickRate { get; }
        public double TickMs => 1000.0 / TickRate;
        /// <summary>Last tick handed out (0 before the first).</summary>
        public uint Tick { get; private set; }
        /// <summary>At most this many ticks run back to back after a stall; older ones are skipped.</summary>
        public int MaxCatchUp { get; set; } = 5;

        /// <summary>Fraction (0..1) of the way from <see cref="Tick"/> to the next tick, for rendering a local sim smoothly.</summary>
        public float Alpha
        {
            get
            {
                if (!_started) return 0;
                var t = (_now() - _startMs) / TickMs - Tick;
                return (float)Math.Min(1, Math.Max(0, t));
            }
        }

        /// <summary>True when the next tick is due; advances <see cref="Tick"/>. Call in a while loop each frame.</summary>
        public bool TryAdvance()
        {
            var now = _now();
            if (!_started) { _started = true; _startMs = now - (long)Math.Ceiling(TickMs); }
            var due = (long)Math.Floor((now - _startMs) / TickMs);
            if (due <= Tick) return false;
            if (due - Tick > MaxCatchUp)
            {
                // a long stall: drop the backlog instead of racing through it
                _startMs = now - (long)Math.Ceiling((Tick + MaxCatchUp) * TickMs);
            }
            Tick++;
            return true;
        }
    }

    /// <summary>
    /// Host-side lag compensation history (Valve/Mirror pattern): record each entity's hit volume every tick, then ask for
    /// it at the tick the shooter was seeing (<see cref="InputFrame.ViewTick"/>, clamped by
    /// <see cref="ReplicationSession.RewindTick"/>). T is the game's pose or hitbox type; the constructor's lerp blends two.
    /// </summary>
    public sealed class HistoryRing<T>
    {
        private readonly int _capacity;
        private readonly Func<T, T, float, T> _lerp;
        private readonly Dictionary<uint, (uint Tick, T Value)[]> _rings = new();

        public HistoryRing(int capacityTicks, Func<T, T, float, T> lerp)
        {
            if (capacityTicks < 2) throw new ArgumentOutOfRangeException(nameof(capacityTicks));
            _capacity = capacityTicks;
            _lerp = lerp;
        }

        public void Record(uint tick, NetId id, T value)
        {
            if (!_rings.TryGetValue(id.Value, out var ring)) _rings[id.Value] = ring = new (uint, T)[_capacity];
            ring[tick % _capacity] = (tick, value);
        }

        public void Forget(NetId id) => _rings.Remove(id.Value);

        /// <summary>The value at a fractional tick, interpolated between the two recorded ticks around it.</summary>
        public bool TrySample(NetId id, double tick, out T value)
        {
            value = default!;
            if (!_rings.TryGetValue(id.Value, out var ring) || tick < 0) return false;
            var a = (uint)Math.Floor(tick);
            var ea = ring[a % _capacity];
            if (ea.Tick != a || a == 0)
            {
                // nothing at a: accept an exact hit on the next tick only
                var eb0 = ring[(a + 1) % _capacity];
                if (eb0.Tick == a + 1 && Math.Abs(tick - (a + 1)) < 1e-9) { value = eb0.Value; return true; }
                return false;
            }
            var frac = (float)(tick - a);
            var eb = ring[(a + 1) % _capacity];
            value = eb.Tick == a + 1 && frac > 0 ? _lerp(ea.Value, eb.Value, frac) : ea.Value;
            return true;
        }
    }

    /// <summary>
    /// Client-side prediction for the local player (Gambetta: sequence numbers, the host echoes the last input it
    /// processed, the client re-applies the inputs the host has not seen yet). The constructor's step is the game's own
    /// movement function: state + one input -&gt; next state, and must match what the host runs.
    /// </summary>
    public sealed class Reconciler<TInput, TState>
    {
        private readonly Func<TState, TInput, TState> _step;
        private readonly List<(uint Seq, TInput Input)> _pending = new();

        public Reconciler(TState initial, Func<TState, TInput, TState> step)
        {
            Current = initial;
            _step = step;
        }

        /// <summary>The predicted state (render this for the local player).</summary>
        public TState Current { get; private set; }
        public int PendingCount => _pending.Count;
        /// <summary>Corrections where the replayed state differed from the prediction (needs <see cref="Equal"/>).</summary>
        public int Corrections { get; private set; }
        /// <summary>Optional comparer used to count <see cref="Corrections"/>.</summary>
        public Func<TState, TState, bool>? Equal { get; set; }

        /// <summary>Apply one local input now (call with the seq <see cref="ReplicationSession.SubmitInput"/> returned).</summary>
        public TState Predict(uint seq, TInput input)
        {
            _pending.Add((seq, input));
            if (_pending.Count > 256) _pending.RemoveAt(0);
            Current = _step(Current, input);
            return Current;
        }

        /// <summary>Host says: after input <paramref name="lastProcessedSeq"/> you were at <paramref name="authoritative"/>. Replay the rest.</summary>
        public TState Reconcile(TState authoritative, uint lastProcessedSeq)
        {
            _pending.RemoveAll(p => p.Seq <= lastProcessedSeq);
            var s = authoritative;
            foreach (var p in _pending) s = _step(s, p.Input);
            if (Equal != null && !Equal(s, Current)) Corrections++;
            Current = s;
            return s;
        }
    }
}
