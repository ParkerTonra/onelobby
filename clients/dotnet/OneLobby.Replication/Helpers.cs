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

    /// <summary>
    /// Hides small prediction corrections (Unreal/Overwatch practice). The sim adopts the corrected state at once; draw
    /// the local player at sim position + <see cref="Offset"/>, which starts at minus the correction and decays linearly to
    /// zero over <see cref="DecayMs"/>, so the player sees a short glide instead of a pop. Corrections past the snap
    /// thresholds, or with a changed teleport sequence, snap (offset cleared): a teleport or a desync must be visible.
    /// Y is up. Engine-free: plain floats, call <see cref="Update"/> once per rendered frame.
    /// </summary>
    public sealed class PredictionSmoother
    {
        private float _sx, _sy, _sz;          // offset when the current decay started
        private float _leftMs;
        private int? _seq;

        public PredictionSmoother(float decayMs = 100, float snapHorizontal = 2f, float snapVertical = 0.5f)
        {
            DecayMs = decayMs;
            SnapHorizontal = snapHorizontal;
            SnapVertical = snapVertical;
        }

        /// <summary>Time for an offset to reach zero (default 100 ms, the interpolation window).</summary>
        public float DecayMs { get; set; }
        /// <summary>A correction longer than this on the X/Z plane snaps (default 2.0).</summary>
        public float SnapHorizontal { get; set; }
        /// <summary>A correction longer than this on Y snaps (default 0.5).</summary>
        public float SnapVertical { get; set; }

        /// <summary>Add this to the sim position when drawing.</summary>
        public (float X, float Y, float Z) Offset { get; private set; }
        /// <summary>Length of <see cref="Offset"/> (for a debug overlay).</summary>
        public float OffsetRemaining => (float)Math.Sqrt(Offset.X * Offset.X + Offset.Y * Offset.Y + Offset.Z * Offset.Z);
        /// <summary>Corrections that snapped instead of gliding.</summary>
        public int SnapCount { get; private set; }

        /// <summary>
        /// Report a correction: <paramref name="errorX"/>..Z is the corrected sim position minus the position before it
        /// (zero is fine: nothing changes). Pass the state's teleport sequence as <paramref name="sequence"/> to snap
        /// whenever it differs from the last one seen. Returns true when it snapped.
        /// </summary>
        public bool Correct(float errorX, float errorY, float errorZ, int? sequence = null)
        {
            var seqChanged = sequence.HasValue && _seq.HasValue && sequence != _seq;
            if (sequence.HasValue) _seq = sequence;
            if (seqChanged || Math.Sqrt(errorX * errorX + errorZ * errorZ) > SnapHorizontal || Math.Abs(errorY) > SnapVertical)
            {
                Snap();
                SnapCount++;
                return true;
            }
            if (errorX == 0 && errorY == 0 && errorZ == 0) return false;
            var o = Offset;
            _sx = o.X - errorX; _sy = o.Y - errorY; _sz = o.Z - errorZ;
            _leftMs = DecayMs;
            Offset = DecayMs > 0 ? (_sx, _sy, _sz) : (0f, 0f, 0f);
            return false;
        }

        /// <summary>Advance the decay by one frame's time.</summary>
        public void Update(float deltaMs)
        {
            if (_leftMs <= 0) return;
            _leftMs = Math.Max(0, _leftMs - deltaMs);
            var k = DecayMs > 0 ? _leftMs / DecayMs : 0;
            Offset = (_sx * k, _sy * k, _sz * k);
        }

        /// <summary>Clear the offset now (respawn, teleport handled elsewhere).</summary>
        public void Snap()
        {
            _leftMs = 0;
            _sx = _sy = _sz = 0;
            Offset = (0f, 0f, 0f);
        }
    }
}
