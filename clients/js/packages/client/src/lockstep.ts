import { CHUNK_PAYLOAD, splitChunks } from "./chunking.js";
import { PROTO, type FrameCommand, type Message } from "./codec.js";
import { deflate, deflateAvailable, inflate } from "./deflate.js";
import { Emitter } from "./emitter.js";
import type { Hub } from "./hub.js";

export interface Frame {
  tick: number;
  commands: FrameCommand[];
}

export interface DesyncInfo {
  tick: number;
  hostHash: bigint;
  yourHash: bigint;
}

export type LockstepEvents = {
  desync: [DesyncInfo];
  /** A snapshot was applied (late join, desync, falling too far behind). */
  restored: [tick: number];
  /** First frame (or snapshot) of the game reached this peer: the session is in game. */
  started: [];
  error: [Error];
};

export const MAX_DESYNCS = 3;
export const MAX_RESTORE_RETRIES = 3;
export const HOST_SILENCE_MS = 3000;
export const PEER_HASH_SILENCE_MS = 10_000;
/** Commands one remote peer may have waiting for the host's next frame; the excess is dropped. */
export const MAX_PENDING_PER_PEER = 256;
const SNAPSHOT_COMPRESS_MIN = 1024;

export interface LockstepOptions {
  hashEveryTicks: number;
  /** Frames kept for replays (late join, migration). Default 30 s of ticks. */
  historyFrames?: number;
}

/**
 * Host-ordered lockstep (spec/binary.md, DESIGN s.8). One class for both roles: the host emits `frame(T)` on a fixed
 * cadence and never waits; joiners queue frames and hand them out through `nextFrame()`.
 *
 * Ticks: the initial state is tick 0 and has no frame; `frame(T)` produces tick T. `reportHash(tick, h)` is called
 * after applying `frame.tick` (the library only sends when `tick % hashEveryTicks == 0`, tick > 0). `snapshot()` must
 * return the state after the last frame returned by `nextFrame()`; `restore(tick, bytes)` receives that tick, and the
 * next frame applied is `tick + 1`.
 */
export class Lockstep extends Emitter<LockstepEvents> {
  snapshot: (() => Uint8Array) | null = null;
  restore: ((tick: number, bytes: Uint8Array) => void) | null = null;

  readonly hashEveryTicks: number;
  /** Chunk body size used when serving snapshots. */
  chunkSize = CHUNK_PAYLOAD;
  private historyMax: number;

  private queue: Frame[] = [];
  private history: Frame[] = [];
  /** Highest frame tick received/emitted; -1 = no state (a fresh joiner). */
  private lastFrameTick = -1;
  /** Tick of the state the game holds (last frame returned by nextFrame, or a restored snapshot). */
  private consumedTick = 0;
  private cmdSeq = 1;
  private awaitingSnapshot = false;
  private lastFrameRx = 0;
  private lastSnapshotReq = -Infinity;
  private restoreFailures = 0;

  // host side
  private hosting = false;
  private _started = false;
  private pending: FrameCommand[] = [];
  private _droppedCommands = 0;
  private ready = new Set<number>();
  private snapshotting = new Set<number>();
  private cancelTicker: (() => void) | null = null;
  private baseTime = 0;
  private emitted = 0;
  private ownHashes = new Map<number, bigint>();
  private peerHashes = new Map<number, Map<number, bigint>>();
  private desyncs = new Map<number, number>();
  private lastHashRx = new Map<number, number>();
  /** Hashes a peer sent for ticks up to this were computed before it restored a snapshot: stale, not evidence. */
  private staleUpTo = new Map<number, { from: number; to: number }>();

  // joiner side
  private pendingSnapshot: { tick: number; total: number; flags: number } | null = null;

  constructor(private hub: Hub, opts: LockstepOptions) {
    super();
    this.hashEveryTicks = Math.max(1, opts.hashEveryTicks);
    this.historyMax = opts.historyFrames ?? Math.max(60, hub.tickRate * 30);
    this.lastFrameRx = hub.clock.now();
  }

  // ---- public game-facing surface -------------------------------------------------------------------------------

  /** Remote commands the host dropped because that peer already had MAX_PENDING_PER_PEER waiting. */
  get droppedCommands(): number {
    return this._droppedCommands;
  }
  get started(): boolean {
    return this._started;
  }
  get framesBuffered(): number {
    return this.queue.length;
  }
  /** True when the game should run ticks without rendering (> 2 frames behind). */
  get catchingUp(): boolean {
    return this.queue.length > 2;
  }
  /** Tick of the game's current state. */
  get currentTick(): number {
    return this.consumedTick;
  }
  /** Highest frame tick known to this peer (0 when none yet; the host's `welcome_dc.tick`). */
  get lastTick(): number {
    return Math.max(0, this.lastFrameTick);
  }
  /** What `hi.lastTick` carries: -1 until the first frame/snapshot. */
  get hiTick(): number {
    return this.lastFrameTick;
  }

  /** Queue a command. Host: into its own next frame. Joiner: to the host (reliable). */
  submit(bytes: Uint8Array): void {
    if (this.hosting) {
      this.pending.push({ peerId: this.hub.localPeerId, bytes: bytes.slice() });
    } else {
      this.hub.sendToHost({ type: "cmd", seq: this.cmdSeq++ >>> 0, bytes });
    }
  }

  nextFrame(): Frame | null {
    const f = this.queue.shift() ?? null;
    if (f) this.consumedTick = f.tick;
    return f;
  }

  reportHash(tick: number, hash: bigint): void {
    if (this.awaitingSnapshot || tick <= 0 || tick % this.hashEveryTicks !== 0) return;
    if (this.hosting) {
      this.ownHashes.set(tick, hash);
      this.prune(this.ownHashes);
      const theirs = this.peerHashes.get(tick);
      if (theirs) {
        this.peerHashes.delete(tick);
        for (const [peer, h] of [...theirs].sort((a, b) => a[0] - b[0])) this.compare(peer, tick, hash, h);
      }
    } else {
      this.hub.sendToHost({ type: "hash", tick, hash });
    }
  }

  // ---- role control (called by Lobby) ---------------------------------------------------------------------------

  /** Host role without emitting yet (lobby phase): peers may already say hi. */
  hostIdle(): void {
    this.hosting = true;
    if (this.lastFrameTick < 0) this.lastFrameTick = 0;
  }

  /** Host begins emitting frames (game start, or after winning a migration), continuing after the last known tick. */
  hostStart(): void {
    this.hostIdle();
    this._started = true;
    this.emitted = 0;
    this.baseTime = this.hub.clock.now();
    this.cancelTicker?.();
    const interval = 1000 / this.hub.tickRate;
    this.cancelTicker = this.hub.clock.setInterval(() => this.pump(interval), Math.max(1, Math.floor(interval / 2)));
  }

  /** Winning a migration: continue from our last received frame. Pending commands are lost by design. */
  becomeHost(): void {
    this.pending = [];
    this.ready.clear();
    this.snapshotting.clear();
    this.ownHashes.clear();
    this.peerHashes.clear();
    this.desyncs.clear();
    this.awaitingSnapshot = false;
    this.hostIdle();
    if (this._started) this.hostStart();
  }

  /** Losing a claim, or a new host appeared: stop emitting. Keep history; the new host decides replay vs snapshot. */
  becomeJoiner(): void {
    this.hosting = false;
    this.cancelTicker?.();
    this.cancelTicker = null;
    this.pending = [];
    this.ready.clear();
    this.lastFrameRx = this.hub.clock.now();
  }

  /** A joiner just learned the session is in game (first frame, snapshot, or phase from the server). */
  markStarted(): void {
    if (this._started) return;
    this._started = true;
    this.emit("started");
  }

  stop(): void {
    this.cancelTicker?.();
    this.cancelTicker = null;
  }

  onPeerLeft(peerId: number): void {
    this.ready.delete(peerId);
    this.snapshotting.delete(peerId);
    this.desyncs.delete(peerId);
    this.lastHashRx.delete(peerId);
    this.staleUpTo.delete(peerId);
    for (const m of this.peerHashes.values()) m.delete(peerId);
    this.pending = this.pending.filter((c) => c.peerId !== peerId);
  }

  // ---- host: frame emission ---------------------------------------------------------------------------------------

  private pump(interval: number): void {
    if (!this.hosting) return;
    const now = this.hub.clock.now();
    let due = Math.floor((now - this.baseTime + 1) / interval) - this.emitted;
    if (due > 10) {
      // Starved (e.g. a throttled tab): do not flood. Rebase rather than emit a burst of empty frames.
      this.baseTime = now - this.emitted * interval;
      due = 1;
    }
    for (let i = 0; i < due; i++) this.emitFrame();
  }

  private emitFrame(): void {
    // sorted by peerId, stable: one peer's commands keep their arrival order
    const commands = this.pending.splice(0).sort((a, b) => a.peerId - b.peerId);
    const frame: Frame = { tick: this.lastFrameTick + 1, commands };
    this.emitted++;
    this.lastFrameTick = frame.tick;
    this.record(frame);
    this.queue.push(frame);
    const msg: Message = { type: "frame", tick: frame.tick, commands };
    for (const p of this.ready) this.hub.sendTo(p, msg, 0);
    this.checkPeerSilence();
  }

  private record(f: Frame): void {
    this.history.push(f);
    if (this.history.length > this.historyMax) this.history.splice(0, this.history.length - this.historyMax);
  }

  /** The host drops a peer it has had no `hash` from for 10 s (scaled up when hashes are rare). */
  private checkPeerSilence(): void {
    if (this.ownHashes.size === 0) return;
    const now = this.hub.clock.now();
    const limit = Math.max(PEER_HASH_SILENCE_MS, (this.hashEveryTicks / this.hub.tickRate) * 1000 * 3);
    for (const p of [...this.ready]) {
      const last = this.lastHashRx.get(p) ?? now;
      if (now - last > limit) this.hub.dropPeer(p, "timeout");
    }
  }

  // ---- message handling -------------------------------------------------------------------------------------------

  handle(from: number, msg: Message): void {
    switch (msg.type) {
      case "cmd":
        if (this.hosting) {
          let waiting = 0;
          for (const c of this.pending) if (c.peerId === from) waiting++;
          if (waiting >= MAX_PENDING_PER_PEER) this._droppedCommands++;
          else this.pending.push({ peerId: from, bytes: msg.bytes });
        }
        break;
      case "frame":
        if (!this.hosting) this.onFrame(msg.tick, msg.commands);
        break;
      case "hash":
        if (this.hosting) this.onPeerHash(from, msg.tick, msg.hash);
        break;
      case "desync":
        if (!this.hosting) {
          this.awaitingSnapshot = true;
          this.queue = [];
          this.emit("desync", { tick: msg.tick, hostHash: msg.hostHash, yourHash: msg.yourHash });
        }
        break;
      case "snapshot_req":
        if (this.hosting) void this.sendSnapshot(from);
        break;
      case "snapshot":
        if (!this.hosting) {
          this.markStarted();
          this.pendingSnapshot = { tick: msg.tick, total: msg.total, flags: msg.flags };
        }
        break;
    }
  }

  /** True when a `snapshot` header was seen and its chunk set has not completed yet. */
  get snapshotPending(): boolean {
    return this.pendingSnapshot !== null;
  }

  /** The reassembled chunk set that follows a `snapshot` header. */
  onSnapshotPayload(payload: Uint8Array): void {
    const ps = this.pendingSnapshot;
    this.pendingSnapshot = null;
    if (!ps) return;
    if (payload.length !== ps.total) {
      // spec: a receiver that gets a different sum drops the snapshot and re-requests
      this.awaitingSnapshot = false;
      this.requestSnapshot();
      return;
    }
    void this.applySnapshot(ps, payload);
  }

  private onFrame(tick: number, commands: FrameCommand[]): void {
    this.lastFrameRx = this.hub.clock.now();
    this.markStarted();
    if (this.awaitingSnapshot) return;
    const expected = Math.max(0, this.lastFrameTick) + 1;
    if (tick < expected) return; // duplicate (replay overlap)
    if (tick > expected) {
      this.requestSnapshot(); // gap: the host changed under us
      return;
    }
    const f: Frame = { tick, commands };
    this.lastFrameTick = tick;
    this.record(f);
    this.queue.push(f);
    if (this.queue.length > this.hub.tickRate * 3) this.requestSnapshot();
  }

  /** Joiner asks the host for a snapshot (far behind, gap, silent host). Throttled while one is outstanding. */
  requestSnapshot(): void {
    const now = this.hub.clock.now();
    if (this.awaitingSnapshot && now - this.lastSnapshotReq < 2000) return;
    this.lastSnapshotReq = now;
    this.awaitingSnapshot = true;
    this.queue = [];
    this.hub.sendToHost({ type: "snapshot_req", sinceTick: this.lastFrameTick });
  }

  /** 3 s without frames: ask the host for a snapshot without discarding anything (a live host answers). */
  pokeHost(): void {
    this.hub.sendToHost({ type: "snapshot_req", sinceTick: this.lastFrameTick });
  }

  private async applySnapshot(ps: { tick: number; total: number; flags: number }, payload: Uint8Array): Promise<void> {
    try {
      let bytes = payload;
      if (ps.flags & 1) bytes = await inflate(payload);
      if (!this.restore) throw new Error("lockstep.restore is not set; cannot apply a snapshot");
      // Restore first: if the game's restore() throws, our bookkeeping must not have moved.
      this.restore(ps.tick, bytes);
      this.queue = [];
      this.history = [];
      this.lastFrameTick = ps.tick;
      this.consumedTick = ps.tick;
      this.awaitingSnapshot = false;
      this.restoreFailures = 0;
      this.markStarted();
      this.lastFrameRx = this.hub.clock.now();
      this.emit("restored", ps.tick);
    } catch (e) {
      this.hub.reportError(e instanceof Error ? e : new Error(String(e)));
      // The game's state is unknown after a failed restore: keep our tick where it was, drop frames, ask again.
      if (++this.restoreFailures <= MAX_RESTORE_RETRIES) {
        this.awaitingSnapshot = false;
        this.lastSnapshotReq = -Infinity;
        this.requestSnapshot();
      } else {
        this.hub.reportError(new Error(`snapshot restore failed ${this.restoreFailures} times; giving up`));
      }
    }
  }

  // ---- host: hello, hashes, snapshots -----------------------------------------------------------------------------

  /** Host: a peer said hi (welcome_dc and chat_history already sent). Decide: nothing, replay, or snapshot. */
  onPeerHi(peerId: number, lastTick: number): void {
    this.lastHashRx.set(peerId, this.hub.clock.now());
    const hostTick = this.lastFrameTick;
    const first = this.history.length ? this.history[0].tick : hostTick + 1;
    if (lastTick < 0) {
      // fresh joiner: initial state if no game is running, otherwise a snapshot
      if (this._started && hostTick > 0) void this.sendSnapshot(peerId);
      else this.ready.add(peerId);
      return;
    }
    if (lastTick <= hostTick && lastTick + 1 >= first) {
      // The peer's timeline is a prefix of ours: replay what it lacks, then go live.
      for (const f of this.history) {
        if (f.tick > lastTick) this.hub.sendTo(peerId, { type: "frame", tick: f.tick, commands: f.commands }, 0);
      }
      this.ready.add(peerId);
    } else {
      void this.sendSnapshot(peerId);
    }
  }

  private onPeerHash(peerId: number, tick: number, hash: bigint): void {
    this.lastHashRx.set(peerId, this.hub.clock.now());
    if (this.isStale(peerId, tick)) return;
    const own = this.ownHashes.get(tick);
    if (own === undefined) {
      let m = this.peerHashes.get(tick);
      if (!m) this.peerHashes.set(tick, (m = new Map()));
      m.set(peerId, hash);
      this.prune(this.peerHashes);
      return;
    }
    this.compare(peerId, tick, own, hash);
  }

  private compare(peerId: number, tick: number, hostHash: bigint, yourHash: bigint): void {
    if (hostHash === yourHash) return;
    if (this.isStale(peerId, tick)) return;
    if (!this.ready.has(peerId) || this.snapshotting.has(peerId)) return; // already being resynced
    const n = (this.desyncs.get(peerId) ?? 0) + 1;
    this.desyncs.set(peerId, n);
    if (n >= MAX_DESYNCS) {
      this.hub.dropPeer(peerId, "desync");
      return;
    }
    this.hub.sendTo(peerId, { type: "desync", tick, hostHash, yourHash }, 0);
    void this.sendSnapshot(peerId, tick);
  }

  /** Hashes computed before a peer restored its snapshot (ticks after the strike, up to what we had emitted) are not evidence. */
  private isStale(peerId: number, tick: number): boolean {
    const w = this.staleUpTo.get(peerId);
    return !!w && tick > w.from && tick <= w.to;
  }

  private async sendSnapshot(peerId: number, strikeTick = Infinity): Promise<void> {
    if (this.snapshotting.has(peerId)) return;
    if (!this.snapshot) {
      this.hub.reportError(new Error("lockstep.snapshot is not set; cannot serve a snapshot"));
      return;
    }
    this.snapshotting.add(peerId);
    this.ready.delete(peerId); // live frames now flow only through the replay below
    try {
      const S = this.consumedTick;
      const raw = this.snapshot();
      let payload = raw;
      let flags = 0;
      if (raw.length >= SNAPSHOT_COMPRESS_MIN && deflateAvailable()) {
        payload = await deflate(raw);
        flags = 1;
      }
      if (!this.snapshotting.has(peerId)) return; // peer left while compressing
      // header + one contiguous chunk set + frames S+1... with nothing else in between
      this.hub.sendTo(peerId, { type: "snapshot", tick: S, total: payload.length, flags }, 0);
      for (const c of splitChunks(this.hub.nextChunkId(), payload, this.chunkSize)) this.hub.sendTo(peerId, c, 0);
      for (const f of this.history) {
        if (f.tick > S) this.hub.sendTo(peerId, { type: "frame", tick: f.tick, commands: f.commands }, 0);
      }
      if (strikeTick !== Infinity) this.staleUpTo.set(peerId, { from: strikeTick, to: this.lastFrameTick });
      else this.staleUpTo.delete(peerId);
      for (const m of this.peerHashes.values()) m.delete(peerId);
      this.ready.add(peerId);
      this.lastHashRx.set(peerId, this.hub.clock.now());
    } catch (e) {
      this.hub.reportError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      this.snapshotting.delete(peerId);
    }
  }

  private prune<T>(m: Map<number, T>): void {
    if (m.size <= 64) return;
    const keys = [...m.keys()].sort((a, b) => a - b);
    for (const k of keys.slice(0, keys.length - 64)) m.delete(k);
  }

  // ---- joiner watchdog --------------------------------------------------------------------------------------------

  /** Joiner: ms since the last frame from the host (only meaningful once in game). */
  get msSinceFrame(): number {
    return this.hub.clock.now() - this.lastFrameRx;
  }

  /** True when a started joiner has heard no frames for 3 s: the Lobby then runs the host-loss rule (s.9). */
  hostSilent(): boolean {
    return !this.hosting && this._started && this.msSinceFrame > HOST_SILENCE_MS;
  }

  /** Reset the silence timer, e.g. after the link to a new host opened. */
  touch(): void {
    this.lastFrameRx = this.hub.clock.now();
  }

  hiMessage(peerId: number): Message {
    return { type: "hi", proto: PROTO, peerId, lastTick: this.lastFrameTick };
  }

  get resyncCount(): Map<number, number> {
    return this.desyncs;
  }
}
