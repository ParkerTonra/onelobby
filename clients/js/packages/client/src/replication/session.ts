/**
 * Host-authoritative state replication over a raw-mode `Lobby` (spec/replication.md; the C# reference is
 * `OneLobby.Replication.ReplicationSession`, same behaviour and names in camelCase).
 *
 * Host: `spawn` entities, run one sim step per `clock.tryAdvance()`, read each client's input with `tryGetInput`, then
 * `sendSnapshot`. Each client gets a delta against the last snapshot it acknowledged, on the fast channel (a full one on
 * the reliable channel when it joins and every `keyframeSeconds`).
 *
 * Client: `submitInput` once per `clock` tick, render remote entities with `trySample` at `renderTick` (100 ms behind the
 * host), and reconcile the local player with `tryGetLatest` + `lastProcessedInput`.
 *
 * Call `pump()` every frame (requestAnimationFrame or a timer): the lobby delivers messages from the event loop on its
 * own, `pump()` advances render time, raises spawn/despawn events, keeps acks flowing and expires stream gaps.
 */
import type { ChannelName } from "../transport.js";
import { Emitter } from "../emitter.js";
import type { Lobby } from "../lobby.js";
import { NetReader, NetWriter } from "./bits.js";
import {
  ByteWriter, KIND_EVENT, KIND_INPUT, KIND_SNAPSHOT, KIND_STREAM_EVENT, MAX_STATE_BYTES, VERSION, ReplicationError,
  decodeEvent, decodeInput, decodeSnapshot, decodeStreamEvent, describe, encodeEvent, encodeInput, encodeSnapshot, encodeStreamEvent,
  indexOf, isReplication, peekSnapshot, sameBytes,
  type Ent, type InputEntry, type World,
} from "./protocol.js";

/** What every peer knows about an entity besides its state: id, the game's type id, owning peer (0 = host-owned). */
export interface EntityInfo {
  id: number;
  typeId: number;
  owner: number;
}

/** Host side: a game object the session reads every snapshot tick. Write the full, quantized state. */
export type ReplicatedEntity = { write(w: NetWriter): void } | ((w: NetWriter) => void);

/**
 * One entity type's state as the game sees it: `write` (host) and `read` (client) mirror each other bit for bit, `lerp`
 * blends two snapshots for rendering (t in [0, 1]).
 */
export interface StateSchema<T> {
  write(w: NetWriter, state: T): void;
  read(r: NetReader): T;
  lerp(a: T, b: T, t: number): T;
}

/** Bind a schema to a getter: the host-side entity that writes `get()` through `schema.write`. */
export function replicated<T>(schema: Pick<StateSchema<T>, "write">, get: () => T): ReplicatedEntity {
  return (w) => schema.write(w, get());
}

/** One input as the host receives it. */
export interface InputFrame {
  /** The client's input sequence number (1, 2, 3 ... one per client tick). */
  seq: number;
  /** Host tick the client was rendering when it made this input (interpolated view, for lag compensation). */
  viewTick: number;
  bytes: Uint8Array;
  /** True when no new input had arrived for this tick and the previous one is handed out again. */
  repeated: boolean;
}

/** Tunables. Defaults are the DESIGN s.18 decisions (30 Hz tick and send, 100 ms interpolation, 4x input redundancy). */
export interface ReplicationConfig {
  tickRate: number;
  snapshotEveryTicks: number;
  interpolationDelayMs: number;
  inputRedundancy: number;
  historyTicks: number;
  maxInputBuffer: number;
  maxRewindMs: number;
  snapshotWarnBytes: number;
  /** Client, 0 = off: an event newer than the newest snapshot waits for it, or at most this many ticks. */
  holdEventsForTicks: number;
  /** Host, 0 = off: a reliable full snapshot on join and every this many seconds. */
  keyframeSeconds: number;
  /** Cap for `packetLog`. */
  packetLogPerSecond: number;
}

export const DEFAULT_REPLICATION_CONFIG: Readonly<ReplicationConfig> = {
  tickRate: 30,
  snapshotEveryTicks: 1,
  interpolationDelayMs: 100,
  inputRedundancy: 4,
  historyTicks: 64,
  maxInputBuffer: 4,
  maxRewindMs: 250,
  snapshotWarnBytes: 1200,
  holdEventsForTicks: 0,
  keyframeSeconds: 5,
  packetLogPerSecond: 20,
};

/** A hole in a numbered stream that was given up on: events `firstMissing` up to (not including) `nextDelivered` never arrived. */
export interface StreamGap {
  from: number;
  stream: number;
  firstMissing: number;
  nextDelivered: number;
}

/** One received event. */
export interface ReplicatedEvent {
  /** Sender's peer id. */
  from: number;
  /** Sender's tick when sent (host: its clock tick; client: floor of its serverTick). */
  tick: number;
  /** 1-255 for a numbered stream, 0 for an unnumbered event. */
  stream: number;
  /** Sequence number within (stream, sender to me), from 1; 0 when unnumbered. */
  seq: number;
  payload: Uint8Array;
  channel: ChannelName;
}

/** Host: one client's input counters. */
export interface ClientInputStats {
  repeated: number;
  skipped: number;
  lost: number;
  bufferDepth: number;
}

/** Replication payload bytes per second over the last 1000 ms (no lobby header). Events include stream events. */
export interface TrafficRates {
  snapshotsSent: number;
  inputsSent: number;
  eventsSent: number;
  totalSent: number;
  snapshotsReceived: number;
  inputsReceived: number;
  eventsReceived: number;
  totalReceived: number;
}

/** Counters for tests and debug overlays. Byte counts are replication payloads, before the 3-byte lobby header. */
export class ReplicationStats {
  snapshotsSent = 0;
  fullSnapshotsSent = 0;
  keyframesSent = 0;
  snapshotBytesSent = 0;
  largestSnapshot = 0;
  oversizeSnapshots = 0;
  snapshotsReceived = 0;
  snapshotsDropped = 0;
  inputsSent = 0;
  inputBytesSent = 0;
  inputsReceived = 0;
  inputsRepeated = 0;
  inputsSkipped = 0;
  inputsLost = 0;
  eventsSent = 0;
  eventsReceived = 0;
  eventsDuplicate = 0;
  eventsGap = 0;
  eventsOutOfOrder = 0;
  malformed = 0;
}

export type ReplicationEvents = {
  /** Client: an entity became visible at `renderTick` (create the game object here). */
  entitySpawned: [EntityInfo];
  /** Client: an entity is gone as of `renderTick` (destroy the game object here). */
  entityDespawned: [EntityInfo];
  /** A reliable or fast event: client: from the host; host: from a client. */
  eventReceived: [from: number, tick: number, payload: Uint8Array];
  /** Every event, like `eventReceived`, with its stream and sequence number. */
  eventDelivered: [ReplicatedEvent];
  /** A numbered stream skipped sequence numbers, raised after the hole stayed open for `STREAM_GAP_TIMEOUT_MS`. */
  eventGap: [StreamGap];
  /** Raw-mode payloads that are not replication messages (first byte other than 0x52), for the game's own use. */
  otherMessage: [from: number, bytes: Uint8Array, channel: ChannelName];
  /** Client: the host left. Host migration is not supported for replicated sessions: end the match. */
  hostLost: [];
  /** Host: a peer's link is up and it joined `clients` (spawn its avatar here). */
  clientReady: [peerId: number];
};

/** How long a numbered stream waits for a missing sequence number before `eventGap` skips it. */
export const STREAM_GAP_TIMEOUT_MS = 1000;
/** Most events one numbered stream holds while it waits for a missing one. */
export const MAX_STREAM_BUFFERED = 64;
/** Most payload bytes one numbered stream holds while it waits for a missing one. */
export const MAX_STREAM_BUFFERED_BYTES = 256 * 1024;
/** A sequence number further than this past the last delivered one is malformed and dropped. */
export const MAX_STREAM_AHEAD = 4096;

/**
 * Fixed-step tick clock over a monotonic millisecond source. The game runs one simulation step per `tryAdvance()` that
 * returns true, so the step rate is independent of frame rate.
 */
export class NetworkClock {
  private startMs = 0;
  private started = false;
  /** Last tick handed out (0 before the first). */
  tick = 0;
  /** At most this many ticks run back to back after a stall; older ones are skipped. */
  maxCatchUp = 5;

  constructor(readonly tickRate: number, private readonly nowFn: () => number) {
    if (!(tickRate >= 1 && tickRate <= 240)) throw new RangeError("tickRate must be 1..240");
  }

  get tickMs(): number {
    return 1000 / this.tickRate;
  }

  /** Fraction (0..1) of the way from `tick` to the next tick, for rendering a local sim smoothly. */
  get alpha(): number {
    if (!this.started) return 0;
    const t = (this.nowFn() - this.startMs) / this.tickMs - this.tick;
    return Math.min(1, Math.max(0, t));
  }

  /** True when the next tick is due; advances `tick`. Call in a while loop each frame. */
  tryAdvance(): boolean {
    const now = this.nowFn();
    if (!this.started) {
      this.started = true;
      this.startMs = now - Math.ceil(this.tickMs);
    }
    const due = Math.floor((now - this.startMs) / this.tickMs);
    if (due <= this.tick) return false;
    if (due - this.tick > this.maxCatchUp) this.startMs = now - Math.ceil((this.tick + this.maxCatchUp) * this.tickMs);
    this.tick++;
    return true;
  }
}

interface HostEnt {
  type: number;
  owner: number;
  source: ReplicatedEntity;
  last: Uint8Array;
}

interface ClientRec {
  peer: number;
  ack: number;
  inputs: Map<number, { view256: number; bytes: Uint8Array }>;
  lastConsumed: number;
  last: InputFrame | null;
  bytesSent: number;
  /** `sendFullSnapshot`: acks at or below this tick no longer count as a baseline. */
  ackFloor: number;
  repeated: number;
  skipped: number;
  lost: number;
  keyframeDue: boolean;
  nextKeyframeMs: number;
}

// buckets of the byte-rate meter: kind + (received ? 3 : 0)
const SNAPSHOT = 0;
const INPUT = 1;
const EVENT = 2;
const RECEIVED = 3;

class RateMeter {
  private q: { at: number; bucket: number; bytes: number }[] = [];
  add(now: number, bucket: number, bytes: number): void {
    this.q.push({ at: now, bucket, bytes });
    this.trim(now);
  }
  private trim(now: number): void {
    let n = 0;
    while (n < this.q.length && now - this.q[n].at >= 1000) n++;
    if (n) this.q.splice(0, n);
  }
  get(now: number): TrafficRates {
    this.trim(now);
    const b = [0, 0, 0, 0, 0, 0];
    for (const e of this.q) b[e.bucket] += e.bytes;
    return {
      snapshotsSent: b[0], inputsSent: b[1], eventsSent: b[2], totalSent: b[0] + b[1] + b[2],
      snapshotsReceived: b[3], inputsReceived: b[4], eventsReceived: b[5], totalReceived: b[3] + b[4] + b[5],
    };
  }
}

/** A raw-mode lobby's replication layer. Construct one per lobby, after `ready` on a joiner. */
export class ReplicationSession extends Emitter<ReplicationEvents> {
  readonly config: Readonly<ReplicationConfig>;
  readonly isHost: boolean;
  /** Host: the authoritative sim tick. Client: the local input tick (same rate, its own count). */
  readonly clock: NetworkClock;
  readonly stats = new ReplicationStats();
  /**
   * Debug view: `true` writes one line per replication packet to the lobby's net log (`rep out|in <peer> <channel>
   * <json>`, at most `packetLogPerSecond` a second); a function receives the lines instead. The wire stays binary.
   */
  packetLog: boolean | ((line: string) => void) = false;

  private readonly lobby: Lobby;
  private readonly w = new ByteWriter();
  private readonly recs = new ByteWriter();
  private readonly nw = new NetWriter();
  private readonly nr = new NetReader();
  private disposed = false;
  private readonly rates = new RateMeter();
  private logWindowStart = 0;
  private logCount = 0;
  private offs: (() => void)[] = [];

  // reliable streams: last seq sent / delivered, per (peer, stream); a peer's entries go when it leaves or rejoins
  private readonly sendSeq = new Map<string, number>();
  private readonly recvSeq = new Map<string, number>();
  private readonly eventBytes = new Map<number, number>();
  private held: { ev: ReplicatedEvent; at: number }[] = [];
  private readonly early = new Map<string, { peer: number; stream: number; events: Map<number, ReplicatedEvent>; since: number }>();

  // host
  private readonly hostEnts = new Map<number, HostEnt>();
  private readonly clientRecs = new Map<number, ClientRec>();
  private readonly joining = new Set<number>();
  private readonly sent = new Map<number, World>();
  private sentOrder: number[] = [];
  private nextId = 1;

  // client
  private readonly ring = new Map<number, World>();
  private ringKeys: number[] = [];
  private readonly reported = new Map<number, EntityInfo>();
  private recentInputs: InputEntry[] = [];
  private ackTick = 0;
  private inputSeq = 0;
  private lastProcessed = 0;
  private newestTick = 0;
  private offsetMs = 0;
  private haveOffset = false;
  private lastSampleMs = 0;
  private renderTickValue = 0;
  private haveRender = false;
  private lastPumpMs: number;
  private lastInputSendMs = -1e15;
  private newestAtMs = -1;

  constructor(lobby: Lobby, config: Partial<ReplicationConfig> = {}) {
    super();
    if (!lobby) throw new TypeError("lobby required");
    if (lobby.mode !== "raw") throw new Error('replication runs on a raw-mode lobby (mode: "raw")');
    this.lobby = lobby;
    this.config = { ...DEFAULT_REPLICATION_CONFIG, ...config };
    this.isHost = lobby.isHost;
    this.clock = new NetworkClock(this.config.tickRate, () => lobby.nowMs);
    this.offs.push(
      lobby.on("message", (from, bytes, channel) => this.onMessage(from, bytes, channel)),
      lobby.on("hostChanged", () => {
        if (!this.isHost) this.emit("hostLost");
      }),
      lobby.on("peerJoined", (p) => {
        if (!this.isHost || p.peerId === this.localPeerId || this.clientRecs.has(p.peerId)) return;
        this.forgetPeer(p.peerId); // a rejoin under the same id starts its streams again at 1
        this.joining.add(p.peerId);
      }),
      lobby.on("peerReady", (p) => {
        if (this.isHost && p.peerId !== this.localPeerId) this.addClient(p.peerId);
      }),
      lobby.on("peerLeft", (p) => {
        this.clientRecs.delete(p.peerId);
        this.joining.delete(p.peerId);
        this.forgetPeer(p.peerId);
      }),
    );
    if (this.isHost) {
      const ready = new Set(lobby.connectedPeers);
      for (const p of lobby.peers) {
        if (p.peerId === lobby.localPeerId) continue;
        if (ready.has(p.peerId)) this.addClient(p.peerId);
        else this.joining.add(p.peerId);
      }
    }
    this.lastPumpMs = lobby.nowMs;
  }

  get localPeerId(): number {
    return this.lobby.localPeerId;
  }
  /** The host's peer id (same as `lobby.hostPeerId`). */
  get hostPeerId(): number {
    return this.lobby.hostPeerId;
  }
  /** Client: round trip to the host in ms (OneLobby's pings; 0 until the first pong). Host: 0. */
  get rttMs(): number {
    return this.isHost ? 0 : this.lobby.rtt;
  }
  /** Round trip to `peerId` in ms. Only a client's round trip to the host is measured; any other peer gives 0. */
  peerRttMs(peerId: number): number {
    return !this.isHost && peerId === this.lobby.hostPeerId ? this.lobby.rtt : 0;
  }
  /** Replication bytes per second sent and received over the last second, per kind (no lobby header). */
  get trafficRates(): TrafficRates {
    return this.rates.get(this.lobby.nowMs);
  }
  /** True for payloads this session owns (at least 3 bytes, first byte 0x52). Keep your own raw messages off that first byte. */
  static isReplicationPayload(payload: Uint8Array): boolean {
    return isReplication(payload);
  }
  /** One replication message as a plain JSON-able object (spec/replication.md "Debug view"). */
  describe(payload: Uint8Array, baseline: World | null = null): ReturnType<typeof describe> {
    return describe(payload, baseline);
  }

  /** Advances render time, raises spawn/despawn events, keeps acks flowing and expires stream gaps. Call every frame. */
  pump(): void {
    if (this.disposed) return;
    const now = this.lobby.nowMs;
    const elapsed = now - this.lastPumpMs;
    this.lastPumpMs = now;
    this.expireGaps(now);
    if (this.isHost) return;
    this.releaseHeld(now);
    this.updateRenderTick(elapsed);
    this.reportVisibility();
    if (this.newestTick > 0 && now - this.lastInputSendMs >= this.clock.tickMs) this.sendInputMessage(0); // ack-only heartbeat
  }

  // ================================================================== host ====================================

  /** Host: register an entity. `owner` is the controlling peerId, 0 = host-owned (AI, doors). Returns its id. */
  spawn(typeId: number, owner: number, entity: ReplicatedEntity): number {
    this.requireHost();
    if (!entity) throw new TypeError("entity required");
    const id = this.nextId++;
    this.hostEnts.set(id, { type: typeId, owner, source: entity, last: new Uint8Array(0) });
    return id;
  }

  /** Host: remove an entity; clients see it disappear at the snapshot tick it was last absent from. */
  despawn(id: number): boolean {
    this.requireHost();
    return this.hostEnts.delete(id);
  }

  setOwner(id: number, owner: number): void {
    this.requireHost();
    const e = this.hostEnts.get(id);
    if (e) e.owner = owner;
  }

  /** Host: the entities spawned with `spawn` and not yet despawned. Empty on a client (use `entitySpawned`). */
  hostEntities(): EntityInfo[] {
    return [...this.hostEnts].map(([id, e]) => ({ id, typeId: e.type, owner: e.owner }));
  }

  /** Host: peers receiving snapshots. A peer is added when its link is up (`peerReady`); its first snapshot is a reliable full one. */
  get clients(): number[] {
    return [...this.clientRecs.keys()];
  }

  isClientReady(peerId: number): boolean {
    return this.clientRecs.has(peerId);
  }

  /** Host: newest snapshot tick this client acknowledged (0 = none yet: it gets full snapshots). */
  ackedTick(peerId: number): number {
    return this.clientRecs.get(peerId)?.ack ?? 0;
  }

  /** Host: replication bytes sent to one client (payloads, no lobby header). */
  bytesSentTo(peerId: number): number {
    return this.clientRecs.get(peerId)?.bytesSent ?? 0;
  }

  /** Host: one client's input counters and how many of its inputs are buffered right now. All zero for an unknown peer. */
  inputStatsFor(peerId: number): ClientInputStats {
    const c = this.clientRecs.get(peerId);
    return c ? { repeated: c.repeated, skipped: c.skipped, lost: c.lost, bufferDepth: c.inputs.size } : { repeated: 0, skipped: 0, lost: 0, bufferDepth: 0 };
  }

  /**
   * Host: the next snapshot this client gets is a full one (no baseline), and deltas resume only once it acknowledges a
   * snapshot sent after this call. Use it when a client reports a gap or asks to resync.
   */
  sendFullSnapshot(peerId: number): void {
    this.requireHost();
    const c = this.clientRecs.get(peerId);
    if (!c) return;
    c.ack = 0;
    c.ackFloor = this.clock.tick;
  }

  /**
   * Host: this tick's input from a client. One call per client per tick. Returns the next input in sequence; when none
   * has arrived the previous one is repeated (`repeated`); null only before the first.
   */
  tryGetInput(peerId: number): InputFrame | null {
    this.requireHost();
    const c = this.clientRecs.get(peerId);
    if (!c) return null;
    // latency cap: a client that got ahead (a burst after a stall) skips its oldest inputs
    while (c.inputs.size > Math.max(1, this.config.maxInputBuffer)) {
      const k = firstKey(c.inputs);
      c.inputs.delete(k);
      c.lastConsumed = k;
      this.stats.inputsSkipped++;
      c.skipped++;
    }
    if (c.inputs.size > 0) {
      const k = firstKey(c.inputs);
      const v = c.inputs.get(k)!;
      c.inputs.delete(k);
      if (k > c.lastConsumed + 1) {
        this.stats.inputsLost += k - c.lastConsumed - 1;
        c.lost += k - c.lastConsumed - 1;
      }
      c.lastConsumed = k;
      c.last = { seq: k, viewTick: v.view256 / 256, bytes: v.bytes, repeated: false };
      return c.last;
    }
    if (!c.last) return null;
    this.stats.inputsRepeated++;
    c.repeated++;
    return { seq: c.last.seq, viewTick: c.last.viewTick, bytes: c.last.bytes, repeated: true };
  }

  /** Host: the tick to rewind hit volumes to for a shot in `input`, clamped to `maxRewindMs`. */
  rewindTick(input: Pick<InputFrame, "viewTick">): number {
    const now = this.clock.tick;
    const earliest = now - this.config.maxRewindMs / this.clock.tickMs;
    return Math.min(now, Math.max(earliest, input.viewTick));
  }

  /**
   * Host: capture every entity's state at `clock.tick` and send each client its delta. Call once at the end of each sim
   * tick; ticks not on `snapshotEveryTicks` are skipped.
   */
  sendSnapshot(): void {
    this.requireHost();
    const tick = this.clock.tick;
    if (tick === 0) throw new Error("advance the clock (clock.tryAdvance) before the first snapshot");
    if (tick % Math.max(1, this.config.snapshotEveryTicks) !== 0 || this.sent.has(tick)) return;
    const list: Ent[] = [];
    for (const [id, e] of this.hostEnts) {
      this.nw.reset();
      if (typeof e.source === "function") e.source(this.nw);
      else e.source.write(this.nw);
      if (this.nw.byteCount > MAX_STATE_BYTES) throw new Error("entity state over " + MAX_STATE_BYTES + " bytes: " + id);
      const now = this.nw.view();
      if (!sameBytes(now, e.last)) e.last = this.nw.toBytes(); // unchanged state keeps the same array
      list.push({ id, type: e.type, owner: e.owner, state: e.last });
    }
    const world: World = { tick, ents: list };
    this.sent.set(tick, world);
    this.sentOrder.push(tick);
    while (this.sentOrder.length > 0 && this.sentOrder[0] + this.config.historyTicks < tick) this.sent.delete(this.sentOrder.shift()!);

    const nowMs = this.lobby.nowMs;
    for (const c of this.clientRecs.values()) {
      let baseline: World | null = null;
      if (c.ack !== 0) baseline = this.sent.get(c.ack) ?? null;
      // keyframe: a full snapshot on the reliable channel instead of this tick's fast one
      const keyframe = this.config.keyframeSeconds > 0 && (c.keyframeDue || nowMs >= c.nextKeyframeMs);
      if (keyframe) {
        baseline = null;
        c.keyframeDue = false;
        c.nextKeyframeMs = nowMs + Math.floor(this.config.keyframeSeconds * 1000);
        this.stats.keyframesSent++;
      }
      const bytes = encodeSnapshot(world, baseline, c.lastConsumed, this.w, this.recs);
      const channel: "reliable" | "fast" = keyframe ? "reliable" : "fast";
      this.lobby.send(c.peer, bytes, { channel });
      this.rates.add(nowMs, SNAPSHOT, bytes.length);
      this.logPacket("out", c.peer, channel, bytes, baseline);
      c.bytesSent += bytes.length;
      this.stats.snapshotsSent++;
      if (baseline === null) this.stats.fullSnapshotsSent++;
      this.stats.snapshotBytesSent += bytes.length;
      if (bytes.length > this.stats.largestSnapshot) this.stats.largestSnapshot = bytes.length;
      if (bytes.length > this.config.snapshotWarnBytes) this.stats.oversizeSnapshots++;
    }
  }

  /**
   * Host: event to one client (`to`) or all (0 or unset). Client: event to the host (`to` ignored). Reliable by default
   * (ordered, exactly once per link); `fast` for cosmetic one-offs. Stamped with the current tick.
   * `stream` 1-255 (reliable only) numbers the event per (stream, recipient) so the receiver sees `seq`, drops duplicates
   * and reports a skipped number with `eventGap`. Stream 0 (the default) is unnumbered.
   */
  sendEvent(payload: Uint8Array, opts: { to?: number; channel?: "reliable" | "fast"; stream?: number } = {}): void {
    const channel = opts.channel ?? "reliable";
    const stream = opts.stream ?? 0;
    const toPeer = opts.to ?? 0;
    if (!Number.isInteger(stream) || stream < 0 || stream > 255) throw new RangeError("stream must be 0..255");
    if (stream !== 0 && channel !== "reliable") throw new Error("numbered streams are reliable only");
    const tick = this.isHost ? this.clock.tick : Math.max(0, Math.floor(this.serverTick));
    this.stats.eventsSent++;
    const body = payload.slice();
    const plain = stream === 0 ? encodeEvent(tick, body, this.w) : null;
    if (!this.isHost) {
      this.sendEventTo(this.lobby.hostPeerId, tick, stream, body, plain, channel);
      return;
    }
    if (toPeer !== 0) {
      this.sendEventTo(toPeer, tick, stream, body, plain, channel);
      return;
    }
    for (const c of this.clientRecs.keys()) this.sendEventTo(c, tick, stream, body, plain, channel);
    for (const c of this.joining) this.sendEventTo(c, tick, stream, body, plain, channel); // reliable ones are queued until the link opens
  }

  private sendEventTo(peer: number, tick: number, stream: number, body: Uint8Array, plain: Uint8Array | null, channel: "reliable" | "fast"): void {
    let bytes = plain;
    if (!bytes) {
      const key = peer + ":" + stream;
      const next = (this.sendSeq.get(key) ?? 0) + 1;
      this.sendSeq.set(key, next);
      bytes = encodeStreamEvent(tick, stream, next, body, this.w);
    }
    this.lobby.send(peer, bytes, { channel });
    this.rates.add(this.lobby.nowMs, EVENT, bytes.length);
    this.logPacket("out", peer, channel, bytes, null);
    if (channel === "reliable") this.eventBytes.set(peer, (this.eventBytes.get(peer) ?? 0) + bytes.length);
  }

  /** Reliable event bytes sent to one peer (payloads, no lobby header). Client: to the host. */
  reliableEventBytesSentTo(peerId: number): number {
    return this.eventBytes.get(peerId) ?? 0;
  }

  private forgetPeer(peer: number): void {
    this.eventBytes.delete(peer);
    const mine = (k: string) => k.startsWith(peer + ":");
    for (const k of [...this.sendSeq.keys()]) if (mine(k)) this.sendSeq.delete(k);
    for (const k of [...this.recvSeq.keys()]) if (mine(k)) this.recvSeq.delete(k);
    for (const k of [...this.early.keys()]) if (mine(k)) this.early.delete(k);
  }

  private addClient(peer: number): void {
    this.joining.delete(peer);
    if (this.clientRecs.has(peer)) return;
    // ack 0: the first snapshot it gets is a full one, on the reliable channel (keyframe)
    this.clientRecs.set(peer, {
      peer, ack: 0, inputs: new Map(), lastConsumed: 0, last: null, bytesSent: 0, ackFloor: 0, repeated: 0, skipped: 0, lost: 0,
      keyframeDue: true, nextKeyframeMs: 0,
    });
    this.emit("clientReady", peer);
  }

  private hostReceiveInput(from: number, payload: Uint8Array): void {
    const c = this.clientRecs.get(from);
    if (!c) return;
    const { ack, inputs } = decodeInput(payload);
    if (ack <= this.clock.tick && ack > c.ack && ack > c.ackFloor && this.sent.has(ack)) c.ack = ack;
    for (const { seq, view256, bytes } of inputs) {
      if (seq === 0 || seq <= c.lastConsumed || c.inputs.has(seq)) continue;
      c.inputs.set(seq, { view256, bytes });
      this.stats.inputsReceived++;
    }
  }

  // ================================================================== client ==================================

  /** Client: estimated current host tick (fractional). */
  get serverTick(): number {
    return this.haveOffset ? (this.lobby.nowMs + this.offsetMs) / this.clock.tickMs : 0;
  }

  /** Client: the host tick being rendered: `serverTick` minus the interpolation delay, smoothed. */
  get renderTick(): number {
    return this.renderTickValue;
  }

  /** Client: newest snapshot tick received. */
  get latestTick(): number {
    return this.newestTick;
  }

  /** Client: ms since the newest snapshot (`latestTick`) arrived; -1 before the first one. */
  get snapshotAgeMs(): number {
    return this.newestAtMs < 0 ? -1 : this.lobby.nowMs - this.newestAtMs;
  }

  /** Client: the last of my inputs the host had applied in the newest snapshot (for reconciliation). */
  get lastProcessedInput(): number {
    return this.lastProcessed;
  }

  /** Client: entities visible at `renderTick`. */
  get entities(): EntityInfo[] {
    return [...this.reported.values()];
  }

  isMine(e: EntityInfo): boolean {
    return e.owner === this.localPeerId;
  }

  /**
   * Client: queue one input for the host and send it with the previous `inputRedundancy - 1` inputs on the fast
   * channel. Call once per `clock` tick. Returns the input's sequence number.
   */
  submitInput(input: Uint8Array): number {
    if (this.isHost) throw new Error("the host applies its own input directly");
    if (input.length > 1024) throw new RangeError("input over 1024 bytes");
    this.inputSeq++;
    this.recentInputs.unshift({ view256: Math.max(0, Math.round(this.renderTickValue * 256)), bytes: input.slice() });
    const keep = Math.max(1, Math.min(255, this.config.inputRedundancy));
    if (this.recentInputs.length > keep) this.recentInputs.length = keep;
    this.sendInputMessage(this.recentInputs.length);
    return this.inputSeq;
  }

  private sendInputMessage(count: number): void {
    // keep the datagram small: drop redundant copies past ~1000 bytes
    let size = 0;
    let n = 0;
    for (; n < count; n++) {
      size += this.recentInputs[n].bytes.length + 6;
      if (n > 0 && size > 1000) break;
    }
    const bytes = encodeInput(this.ackTick, this.inputSeq, this.recentInputs, n, this.w);
    this.lobby.send(this.lobby.hostPeerId, bytes, { channel: "fast" });
    const now = this.lobby.nowMs;
    this.rates.add(now, INPUT, bytes.length);
    this.logPacket("out", this.lobby.hostPeerId, "fast", bytes, null);
    this.lastInputSendMs = now;
    if (n > 0) this.stats.inputsSent++;
    this.stats.inputBytesSent += bytes.length;
  }

  /** Client: an entity's state interpolated at `renderTick`; undefined if it is not visible then. */
  trySample<T>(id: number, schema: Pick<StateSchema<T>, "read" | "lerp">): T | undefined {
    return this.trySampleAt(id, this.renderTickValue, schema);
  }

  /** Client: an entity's state interpolated at any tick still in the snapshot buffer. */
  trySampleAt<T>(id: number, tick: number, schema: Pick<StateSchema<T>, "read" | "lerp">): T | undefined {
    if (this.ringKeys.length === 0) return undefined;
    const ai = this.floorIndex(tick);
    if (ai < 0) return undefined;
    const keys = this.ringKeys;
    const a = this.ring.get(keys[ai])!;
    const ia = indexOf(a, id);
    if (ia < 0) return undefined;
    const sa = this.decodeState(a.ents[ia].state, schema);
    if (ai + 1 < keys.length && tick > keys[ai]) {
      const b = this.ring.get(keys[ai + 1])!;
      const ib = indexOf(b, id);
      if (ib >= 0 && b.ents[ib].type === a.ents[ia].type) {
        const sb = this.decodeState(b.ents[ib].state, schema);
        const t = (tick - keys[ai]) / (keys[ai + 1] - keys[ai]);
        return schema.lerp(sa, sb, t);
      }
    }
    return sa; // newest known (or despawning next): hold, never extrapolate
  }

  /** Client: the entity's state in the newest snapshot (not interpolated), e.g. the local player's authoritative state. */
  tryGetLatest<T>(id: number, schema: Pick<StateSchema<T>, "read">): { state: T; tick: number } | undefined {
    if (this.ringKeys.length === 0) return undefined;
    const w = this.ring.get(this.ringKeys[this.ringKeys.length - 1])!;
    const i = indexOf(w, id);
    if (i < 0) return undefined;
    return { state: this.decodeState(w.ents[i].state, schema), tick: w.tick };
  }

  /** Client: info for an entity in the newest snapshot (owner, type), even before it is visible. */
  find(id: number): EntityInfo | undefined {
    if (this.ringKeys.length === 0) return undefined;
    const w = this.ring.get(this.ringKeys[this.ringKeys.length - 1])!;
    const i = indexOf(w, id);
    return i < 0 ? undefined : { id, typeId: w.ents[i].type, owner: w.ents[i].owner };
  }

  private decodeState<T>(bytes: Uint8Array, schema: Pick<StateSchema<T>, "read">): T {
    this.nr.reset(bytes);
    return schema.read(this.nr);
  }

  private floorIndex(tick: number): number {
    const keys = this.ringKeys;
    let lo = 0;
    let hi = keys.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] <= tick) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
  }

  private clientReceiveSnapshot(payload: Uint8Array): void {
    const h = peekSnapshot(payload);
    const hist = this.config.historyTicks;
    if (this.ring.has(h.tick) || (this.newestTick > hist && h.tick < this.newestTick - hist)) return;
    let baseline: World | null = null;
    if (h.baselineTick !== 0) {
      baseline = this.ring.get(h.baselineTick) ?? null;
      if (!baseline) {
        this.stats.snapshotsDropped++;
        return;
      }
    }
    const world = decodeSnapshot(payload, baseline);
    this.ring.set(h.tick, world);
    let at = this.ringKeys.length;
    while (at > 0 && this.ringKeys[at - 1] > h.tick) at--;
    this.ringKeys.splice(at, 0, h.tick);
    this.stats.snapshotsReceived++;
    const now = this.lobby.nowMs;
    if (h.tick > this.newestTick) {
      this.newestTick = h.tick;
      this.newestAtMs = now;
      this.ackTick = h.tick;
      this.lastProcessed = h.lastInput;
    }
    while (this.ringKeys.length > 0 && this.ringKeys[0] + hist < this.newestTick) this.ring.delete(this.ringKeys.shift()!);
    // clock: the least-delayed packet shows the host's clock best; let the estimate decay slowly towards later ones
    const sample = h.tick * this.clock.tickMs - now;
    if (!this.haveOffset || sample > this.offsetMs) this.offsetMs = sample;
    else this.offsetMs = Math.max(sample, this.offsetMs - (now - this.lastSampleMs) * 0.05);
    this.haveOffset = true;
    this.lastSampleMs = now;
  }

  private updateRenderTick(elapsedMs: number): void {
    if (!this.haveOffset) return;
    const tickMs = this.clock.tickMs;
    const target = this.serverTick - this.config.interpolationDelayMs / tickMs;
    if (!this.haveRender || Math.abs(target - this.renderTickValue) > 10) {
      this.renderTickValue = target;
      this.haveRender = true;
      return;
    }
    // advance with the local clock and close 10% of the error per pump; never run backwards
    let next = this.renderTickValue + elapsedMs / tickMs;
    next += (target - next) * 0.1;
    if (next > this.renderTickValue) this.renderTickValue = next;
  }

  private reportVisibility(): void {
    const ai = this.floorIndex(this.renderTickValue);
    if (ai < 0) return;
    const w = this.ring.get(this.ringKeys[ai])!;
    const gone: EntityInfo[] = [];
    for (const [id, info] of this.reported) {
      const i = indexOf(w, id);
      if (i < 0 || w.ents[i].type !== info.typeId) gone.push(info);
    }
    for (const g of gone) {
      this.reported.delete(g.id);
      this.emit("entityDespawned", g);
    }
    for (const e of w.ents) {
      const info = this.reported.get(e.id);
      if (info) {
        if (info.owner !== e.owner) this.reported.set(e.id, { ...info, owner: e.owner });
        continue;
      }
      const ni: EntityInfo = { id: e.id, typeId: e.type, owner: e.owner };
      this.reported.set(e.id, ni);
      this.emit("entitySpawned", ni);
    }
  }

  // ================================================================== shared ==================================

  private onMessage(from: number, payload: Uint8Array, channel: ChannelName): void {
    if (this.disposed) return;
    if (!isReplication(payload)) {
      this.emit("otherMessage", from, payload, channel);
      return;
    }
    if (payload[1] !== VERSION) {
      this.stats.malformed++;
      return;
    }
    const kind = payload[2];
    if (kind >= 1 && kind <= 4) {
      this.rates.add(this.lobby.nowMs, RECEIVED + (kind === KIND_SNAPSHOT ? SNAPSHOT : kind === KIND_INPUT ? INPUT : EVENT), payload.length);
      if (this.packetLog) this.logPacket("in", from, channel, payload, this.incomingBaseline(payload));
    }
    try {
      switch (kind) {
        case KIND_SNAPSHOT:
          if (!this.isHost && from === this.lobby.hostPeerId) this.clientReceiveSnapshot(payload);
          break;
        case KIND_INPUT:
          if (this.isHost) this.hostReceiveInput(from, payload);
          break;
        case KIND_EVENT: {
          if (!this.isHost && from !== this.lobby.hostPeerId) return;
          const { tick, payload: body } = decodeEvent(payload);
          this.arrive({ from, tick, stream: 0, seq: 0, payload: body, channel });
          break;
        }
        case KIND_STREAM_EVENT: {
          if (!this.isHost && from !== this.lobby.hostPeerId) return;
          if (channel !== "reliable") {
            this.stats.malformed++; // spec: reliable only
            return;
          }
          const { tick, stream, seq, payload: body } = decodeStreamEvent(payload);
          this.receiveStreamEvent({ from, tick, stream, seq, payload: body, channel });
          break;
        }
      }
    } catch (e) {
      if (e instanceof ReplicationError) this.stats.malformed++;
      else throw e;
    }
  }

  // Numbered streams: deliver in sequence order, once. Reliable links already do that, so the buffer below only fills
  // on a transport that breaks the contract (or a test that does); a hole still open after STREAM_GAP_TIMEOUT_MS is
  // reported as a gap and skipped.
  private receiveStreamEvent(e: ReplicatedEvent): void {
    const key = e.from + ":" + e.stream;
    const last = this.recvSeq.get(key) ?? 0;
    if (e.seq <= last) {
      this.stats.eventsDuplicate++;
      return;
    }
    if (e.seq - last > MAX_STREAM_AHEAD) {
      this.stats.malformed++;
      return;
    }
    if (e.seq === last + 1) {
      this.recvSeq.set(key, e.seq);
      this.arrive(e);
      this.drainEarly(key);
      return;
    }
    let buf = this.early.get(key);
    if (!buf) this.early.set(key, (buf = { peer: e.from, stream: e.stream, events: new Map(), since: this.lobby.nowMs }));
    if (buf.events.has(e.seq)) {
      this.stats.eventsDuplicate++;
      return;
    }
    buf.events.set(e.seq, e);
    this.stats.eventsOutOfOrder++;
    // a sender cannot make this buffer grow without bound: past the cap the hole is skipped now, not in a second
    let bytes = 0;
    for (const v of buf.events.values()) bytes += v.payload.length;
    if (buf.events.size > MAX_STREAM_BUFFERED || bytes > MAX_STREAM_BUFFERED_BYTES) this.skipHole(key);
  }

  private drainEarly(key: string): void {
    const buf = this.early.get(key);
    if (!buf) return;
    let last = this.recvSeq.get(key) ?? 0;
    for (;;) {
      const next = buf.events.get(last + 1);
      if (!next) break;
      buf.events.delete(++last);
      this.recvSeq.set(key, last);
      this.arrive(next);
    }
    if (buf.events.size === 0) this.early.delete(key);
    else buf.since = this.lobby.nowMs; // the hole moved: its timer starts again
  }

  private expireGaps(now: number): void {
    if (this.early.size === 0) return;
    for (const [key, buf] of [...this.early]) if (this.early.has(key) && now - buf.since >= STREAM_GAP_TIMEOUT_MS) this.skipHole(key);
  }

  private skipHole(key: string): void {
    const buf = this.early.get(key)!;
    const last = this.recvSeq.get(key) ?? 0;
    const first = Math.min(...buf.events.keys());
    this.stats.eventsGap++;
    this.emit("eventGap", { from: buf.peer, stream: buf.stream, firstMissing: last + 1, nextDelivered: first });
    this.recvSeq.set(key, first - 1);
    this.drainEarly(key);
  }

  private arrive(e: ReplicatedEvent): void {
    // holdEventsForTicks: keep arrival order; an event waits until its tick's snapshot is in, or the cap runs out
    if (!this.isHost && this.config.holdEventsForTicks > 0 && (this.held.length > 0 || e.tick > this.newestTick)) {
      this.held.push({ ev: e, at: this.lobby.nowMs });
      return;
    }
    this.deliver(e);
  }

  private releaseHeld(now: number): void {
    const capMs = this.config.holdEventsForTicks * this.clock.tickMs;
    while (this.held.length > 0) {
      const { ev, at } = this.held[0];
      if (ev.tick > this.newestTick && now - at < capMs) return;
      this.held.shift();
      this.deliver(ev);
    }
  }

  private deliver(e: ReplicatedEvent): void {
    this.stats.eventsReceived++;
    this.emit("eventReceived", e.from, e.tick, e.payload);
    this.emit("eventDelivered", e);
  }

  private logPacket(dir: "in" | "out", peer: number, channel: ChannelName, bytes: Uint8Array, baseline: World | null): void {
    const sink = this.packetLog;
    if (!sink) return;
    const now = this.lobby.nowMs;
    if (now - this.logWindowStart >= 1000) {
      this.logWindowStart = now;
      this.logCount = 0;
    }
    if (++this.logCount > Math.max(1, this.config.packetLogPerSecond)) return;
    const line = `rep ${dir} ${peer} ${channel === "fast" ? "fast" : "reliable"} ${JSON.stringify(describe(bytes, baseline))}`;
    if (typeof sink === "function") sink(line);
    else this.lobby.netLog?.add("info", line);
  }

  private incomingBaseline(payload: Uint8Array): World | null {
    if (payload[2] !== KIND_SNAPSHOT || this.isHost) return null;
    try {
      const h = peekSnapshot(payload);
      return h.baselineTick !== 0 ? this.ring.get(h.baselineTick) ?? null : null;
    } catch {
      return null;
    }
  }

  // test seams
  /** @internal */
  hostWorld(tick: number): World | undefined {
    return this.sent.get(tick);
  }
  /** @internal */
  clientWorlds(): World[] {
    return this.ringKeys.map((k) => this.ring.get(k)!);
  }
  /** @internal */
  get bufferedStreamEvents(): number {
    let n = 0;
    for (const b of this.early.values()) n += b.events.size;
    return n;
  }

  private requireHost(): void {
    if (!this.isHost) throw new Error("host only");
  }

  /** Stop listening to the lobby. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs = [];
  }
}

function firstKey<V>(m: Map<number, V>): number {
  let min = Infinity;
  for (const k of m.keys()) if (k < min) min = k;
  return min;
}

