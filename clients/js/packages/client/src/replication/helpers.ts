/**
 * Prediction and lag-compensation helpers: JS twins of `OneLobby.Replication` `Reconciler<TInput, TState>`,
 * `PredictionSmoother` and `HistoryRing<T>` (clients/dotnet/OneLobby.Replication/Helpers.cs), same behaviour and numbers.
 * Engine-free: plain numbers, no session. Sequence numbers are the ones `ReplicationSession.submitInput` returns.
 */

/**
 * Client-side prediction for the local player (Gambetta: sequence numbers, the host echoes the last input it processed,
 * the client re-applies the inputs the host has not seen yet). `step` is the game's own movement function, state and one
 * input to the next state; it must match what the host runs.
 */
export class Reconciler<TInput, TState> {
  private readonly pending: { seq: number; input: TInput }[] = [];
  /** The predicted state: render this for the local player. */
  current: TState;
  /** Corrections where the replayed state differed from the prediction (needs `equal`). */
  corrections = 0;
  /** Optional comparer used to count `corrections`. */
  equal: ((a: TState, b: TState) => boolean) | null = null;

  constructor(initial: TState, private readonly step: (state: TState, input: TInput) => TState) {
    this.current = initial;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Apply one local input now (call with the seq `submitInput` returned). Keeps at most 256 unconfirmed inputs. */
  predict(seq: number, input: TInput): TState {
    this.pending.push({ seq, input });
    if (this.pending.length > 256) this.pending.shift();
    this.current = this.step(this.current, input);
    return this.current;
  }

  /** The host says: after input `lastProcessedSeq` you were at `authoritative`. Replay the inputs it has not seen. */
  reconcile(authoritative: TState, lastProcessedSeq: number): TState {
    let keep = 0;
    for (const p of this.pending) if (p.seq > lastProcessedSeq) this.pending[keep++] = p;
    this.pending.length = keep;
    let s = authoritative;
    for (const p of this.pending) s = this.step(s, p.input);
    if (this.equal && !this.equal(s, this.current)) this.corrections++;
    this.current = s;
    return s;
  }
}

/**
 * Hides small prediction corrections. The sim adopts the corrected state at once; draw the local player at the sim
 * position plus `offset`, which starts at minus the correction and decays linearly to zero over `decayMs`. A correction
 * past the snap thresholds, or with a changed teleport sequence, snaps (offset cleared). Y is up. Call `update` once per
 * rendered frame.
 */
export class PredictionSmoother {
  private sx = 0;
  private sy = 0;
  private sz = 0;
  private leftMs = 0;
  private seq: number | null = null;
  /** Add this to the sim position when drawing. */
  offset = { x: 0, y: 0, z: 0 };
  /** Corrections that snapped instead of gliding. */
  snapCount = 0;

  /** `decayMs` default 100; `snapHorizontal` (X/Z plane) default 2.0; `snapVertical` (Y) default 0.5. */
  constructor(public decayMs = 100, public snapHorizontal = 2, public snapVertical = 0.5) {}

  /** Length of `offset` (for a debug overlay). */
  get offsetRemaining(): number {
    const o = this.offset;
    return Math.sqrt(o.x * o.x + o.y * o.y + o.z * o.z);
  }

  /**
   * Report a correction: `errorX..Z` is the corrected sim position minus the position before it. Pass the state's teleport
   * counter as `sequence` to snap whenever it differs from the last one seen (the first one only records it). Returns true
   * when it snapped.
   */
  correct(errorX: number, errorY: number, errorZ: number, sequence: number | null = null): boolean {
    const seqChanged = sequence !== null && this.seq !== null && sequence !== this.seq;
    if (sequence !== null) this.seq = sequence;
    if (seqChanged || Math.sqrt(errorX * errorX + errorZ * errorZ) > this.snapHorizontal || Math.abs(errorY) > this.snapVertical) {
      this.snap();
      this.snapCount++;
      return true;
    }
    if (errorX === 0 && errorY === 0 && errorZ === 0) return false;
    const o = this.offset;
    this.sx = o.x - errorX;
    this.sy = o.y - errorY;
    this.sz = o.z - errorZ;
    this.leftMs = this.decayMs;
    this.offset = this.decayMs > 0 ? { x: this.sx, y: this.sy, z: this.sz } : { x: 0, y: 0, z: 0 };
    return false;
  }

  /** Advance the decay by one frame's time. */
  update(deltaMs: number): void {
    if (this.leftMs <= 0) return;
    this.leftMs = Math.max(0, this.leftMs - deltaMs);
    const k = this.decayMs > 0 ? this.leftMs / this.decayMs : 0;
    this.offset = { x: this.sx * k, y: this.sy * k, z: this.sz * k };
  }

  /** Clear the offset now. */
  snap(): void {
    this.leftMs = 0;
    this.sx = this.sy = this.sz = 0;
    this.offset = { x: 0, y: 0, z: 0 };
  }
}

/**
 * Host-side lag compensation history: record each entity's hit volume (or pose) every tick, then ask for it at the tick
 * the shooter was seeing (`InputFrame.viewTick`, clamped by `ReplicationSession.rewindTick`). `lerp` blends two values.
 */
export class HistoryRing<T> {
  private readonly rings = new Map<number, ({ tick: number; value: T } | undefined)[]>();

  constructor(private readonly capacityTicks: number, private readonly lerp: (a: T, b: T, t: number) => T) {
    if (!(capacityTicks >= 2)) throw new RangeError("capacityTicks must be at least 2");
  }

  record(tick: number, id: number, value: T): void {
    let ring = this.rings.get(id);
    if (!ring) this.rings.set(id, (ring = new Array(this.capacityTicks)));
    ring[tick % this.capacityTicks] = { tick, value };
  }

  forget(id: number): void {
    this.rings.delete(id);
  }

  /** The value at a fractional tick, interpolated between the two recorded ticks around it; undefined when not held. */
  trySample(id: number, tick: number): T | undefined {
    const ring = this.rings.get(id);
    if (!ring || tick < 0) return undefined;
    const a = Math.floor(tick);
    const ea = ring[a % this.capacityTicks];
    if (!ea || ea.tick !== a || a === 0) {
      // nothing at a: accept an exact hit on the next tick only
      const eb0 = ring[(a + 1) % this.capacityTicks];
      if (eb0 && eb0.tick === a + 1 && Math.abs(tick - (a + 1)) < 1e-9) return eb0.value;
      return undefined;
    }
    const frac = tick - a;
    const eb = ring[(a + 1) % this.capacityTicks];
    return eb && eb.tick === a + 1 && frac > 0 ? this.lerp(ea.value, eb.value, frac) : ea.value;
  }
}
