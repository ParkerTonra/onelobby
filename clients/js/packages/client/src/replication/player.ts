/**
 * The networked player layer (spec/net-player.md): players in the world with no player sync of your own. One replicated
 * entity of type {@link PLAYER_TYPE_ID} per seated peer, whose state is the player preset; action events (jump, shoot,
 * melee ...) that arrive exactly once and play at the right moment; the host's limits; prediction and hit rewind.
 *
 * `"owner"`: each peer places its own player (the state travels as the bytes of the input message). `"host"`: the input
 * preset travels, the host steps every player with the game's `step` function and the owner predicts the same step.
 */
import type { ChannelName } from "../transport.js";
import { Emitter } from "../emitter.js";
import type { Lobby } from "../lobby.js";
import type { NetReader } from "./bits.js";
import { HistoryRing, PredictionSmoother, Reconciler } from "./helpers.js";
import {
  ACTION_EVENTS, KIND_PLAYER_EVENTS, MAX_EVENT_MESSAGE_BYTES, PLAYER_TYPE_ID, PlayerCodec, TELEPORT_MODULO,
  actionById, actionByName, decodePlayerEvents, defaultPlayerInput, defaultPlayerState, encodePlayerEvents,
  type ActionArgs, type ActionName, type PlayerInput, type PlayerSpace, type PlayerState, type PlayerWireConfig, type WireEvent,
} from "./player-wire.js";
import { ReplicationSession, type ReplicationConfig } from "./session.js";

/** Who places a player: its own peer (`"owner"`, the default) or the host (`"host"`). */
export type PlayerAuthority = "owner" | "host";

/** The host's limits (spec/net-player.md "Limits"). A limit that is not set is not checked. */
export interface PlayerLimits {
  /** Top speed in units per second (owner mode). */
  maxSpeed?: number;
  /** Furthest one accepted update may move a player, in units (owner mode). */
  maxStep?: number;
  /** Shortest time between two `shoot` events of one player, ms. */
  minShotIntervalMs?: number;
  /** Shortest time between two `melee` events of one player, ms. */
  minMeleeIntervalMs?: number;
}

/** The shape of `blueprint.sync.player`. */
export interface PlayerBlueprint {
  authority: PlayerAuthority;
  space: PlayerSpace;
  range: number;
  velocityRange: number;
  limits: PlayerLimits;
  omit: readonly string[];
}

export interface NetPlayersOptions extends Partial<Omit<PlayerBlueprint, "limits">> {
  limits?: PlayerLimits;
  /** Host mode: one movement step for one player. Runs on the host for everyone and on the owner for prediction. */
  step?: (state: PlayerState, input: PlayerInput, dt: number) => PlayerState;
  /** Host mode, host side: where a player starts. Default: the origin. */
  spawn?: (peerId: number) => Partial<PlayerState>;
  /** Session settings when the layer creates the session (`adaptiveDelay` is on unless you turn it off). */
  session?: Partial<ReplicationConfig>;
}

/** Numbers of spec/net-player.md; all of them are constants of the wire contract except where the spec says "option". */
export const NET_PLAYER = {
  /** An action event is sent on `fast` in this many consecutive ticks (and once on `reliable`). */
  eventRepeats: 4,
  /** A player is carried on by its velocity for at most this long past the newest snapshot, then held. */
  carryOnMaxMs: 250,
  /** Owner mode: a claimed move may be this much faster than `maxSpeed` (network bunching) before it counts. */
  speedTolerance: 1.25,
  /** Owner mode with limits: an owner-raised teleport is accepted at most this often. */
  teleportMinIntervalMs: 1000,
  /** A rate limit allows this fraction of its interval, less one tick (clock noise). */
  rateTolerance: 0.9,
  /** Host mode: a correction is blended over this long. */
  correctionBlendMs: 100,
  /** Host mode: a correction past this on the ground plane snaps. */
  snapHorizontal: 2.0,
  /** Host mode: a correction past this vertically snaps. */
  snapVertical: 0.5,
  /** The claimed tick of an event may be at most this many ticks older than the host's tick when it arrives. */
  claimMaxAgeTicks: 15,
} as const;

/**
 * The host raises the teleport counter by this much (an owner raises it by 1): the two can never be mistaken for each
 * other when an owner teleports in the same moment the host puts it back.
 */
export const HOST_TELEPORT_STEP = 4;

/** One action event, as the game sees it. */
export interface ActionEvent<N extends ActionName = ActionName> {
  /** Peer id of the player it belongs to. */
  player: number;
  name: N;
  args: ActionArgs[N];
  /** Host tick it happened. */
  tick: number;
  /** Per-player number (the host's numbering for events that travelled through the host). */
  seq: number;
  /** True when it arrived after the render time had passed its tick and was played at once. */
  late: boolean;
  /** True for this peer's own events (played at once, never relayed back). */
  local: boolean;
}

export interface PlayerStats {
  actionsSent: number;
  actionsPlayed: number;
  /** Played at once because they arrived after their tick had been rendered. */
  actionsLate: number;
  /** Second copies dropped by sequence number. */
  actionsDuplicate: number;
  /** Dropped by the host's rate limit and not relayed. */
  actionsRateLimited: number;
  /** Dropped as not allowed (wrong sender, host-only event, left out, bad arguments). */
  actionsRejected: number;
  /** Owner states that did not decode. */
  statesRejected: number;
  /** Owner updates the host refused (a limit), each answered with a raised teleport counter. */
  limitViolations: number;
  /** Host raised the teleport counter and this owner took the host's state. */
  corrections: number;
}

export type NetPlayersEvents = {
  /** A player appeared (every peer sees every player, the local one included). */
  playerJoined: [peerId: number];
  /** A player is gone (its peer left, or it became a spectator). */
  playerLeft: [peerId: number];
  /** Every action event, in addition to the per-name subscription of {@link NetPlayers.onAction}. */
  action: [ActionEvent];
  /** Host: one local tick is about to run (step your own world here, before the snapshot). Client: one input tick. */
  tick: [tick: number];
  /** Owner mode: the host put this player back (a limit, or a teleport by the host); take `state` as yours. */
  corrected: [state: PlayerState];
  /** Host: an owner's update broke a limit. */
  limitViolation: [peerId: number, limit: "speed" | "step" | "teleportRate"];
};

interface HostPlayer {
  peer: number;
  entityId: number;
  state: PlayerState;
  spawned: boolean;
  /** Owner mode: ignore owner states until the owner shows the raised teleport counter. */
  awaiting: boolean;
  lastAcceptTick: number;
  lastTeleportMs: number;
  lastShotTick: number;
  lastMeleeTick: number;
  relaySeq: number;
  lastInput: PlayerInput;
}

interface Dedupe {
  floor: number;
  seen: Set<number>;
}

interface OutEntry {
  ev: WireEvent;
  left: number;
}

const PUMP_SAMPLE_MS = 100;

/** The networked player layer over one {@link ReplicationSession}. */
export class NetPlayers extends Emitter<NetPlayersEvents> {
  readonly session: ReplicationSession;
  readonly authority: PlayerAuthority;
  readonly codec: PlayerCodec;
  readonly limits: Readonly<PlayerLimits>;
  readonly stats: PlayerStats = {
    actionsSent: 0, actionsPlayed: 0, actionsLate: 0, actionsDuplicate: 0, actionsRateLimited: 0, actionsRejected: 0,
    statesRejected: 0, limitViolations: 0, corrections: 0,
  };
  /** Host mode: the movement step (also settable here after construction). */
  step: ((state: PlayerState, input: PlayerInput, dt: number) => PlayerState) | null;
  /** Smooths host-mode corrections of the local player (read `offset`; drawn position = `local` + `offset`). */
  readonly smoother: PredictionSmoother;

  private readonly lobby: Lobby;
  private readonly spawnFn: (peerId: number) => Partial<PlayerState>;
  private readonly actionHandlers = new Map<string, ((e: ActionEvent) => void)[]>();
  private readonly hostPlayers = new Map<number, HostPlayer>();
  private readonly history: HistoryRing<PlayerState>;
  private readonly known = new Map<number, number>(); // peer -> entity id (everyone's view of who is in the world)
  private readonly inDedupe = new Map<number, Dedupe>(); // host: per sending client
  private readonly relayDedupe = new Map<number, Dedupe>(); // client: per player
  private readonly outboxes = new Map<number, OutEntry[]>();
  private readonly queue: { ev: ActionEvent; at: number }[] = [];
  private readonly sentTeleport = new Map<number, number>(); // owner mode: input seq -> teleport counter I sent
  private readonly samples = new Map<number, { at: number; sent: number; received: number }[]>();
  private lastSampleMs = -1e9;
  private mySeq = 0;
  private lastPumpMs: number;
  private disposed = false;

  // local player
  private localState: PlayerState = defaultPlayerState();
  private haveLocal = false;
  private localInput: PlayerInput = defaultPlayerInput();
  private predictor: Reconciler<PlayerInput, PlayerState> | null = null;
  private lastCorrectTick = 0;
  private lastSentSeq = 0;
  private ignoreUntilSeq = 0;
  private offs: (() => void)[] = [];

  /**
   * `source` is a `ReplicationSession` you made (give it `adaptiveDelay: true` for smooth remote players) or a raw-mode
   * `Lobby` (the layer makes the session, with `adaptiveDelay` on). Options are `blueprint.sync.player`.
   */
  constructor(source: Lobby | ReplicationSession, opts: NetPlayersOptions = {}) {
    super();
    this.session = source instanceof ReplicationSession ? source : new ReplicationSession(source, { adaptiveDelay: true, ...(opts.session ?? {}) });
    this.lobby = this.session.lobbyHandle;
    this.authority = opts.authority ?? "owner";
    const wire: Partial<PlayerWireConfig> = {};
    if (opts.space !== undefined) wire.space = opts.space;
    if (opts.range !== undefined) wire.range = opts.range;
    if (opts.velocityRange !== undefined) wire.velocityRange = opts.velocityRange;
    if (opts.omit !== undefined) wire.omit = opts.omit;
    this.codec = new PlayerCodec(wire);
    this.limits = { ...(opts.limits ?? {}) };
    this.step = opts.step ?? null;
    this.spawnFn = opts.spawn ?? (() => ({}));
    this.smoother = new PredictionSmoother(NET_PLAYER.correctionBlendMs, NET_PLAYER.snapHorizontal, NET_PLAYER.snapVertical);
    this.history = new HistoryRing<PlayerState>(this.session.config.historyTicks, (a, b, t) => this.codec.lerp(a, b, t));
    this.lastPumpMs = this.lobby.nowMs;
    this.session.registerKind(KIND_PLAYER_EVENTS, (from, payload, channel) => this.onEvents(from, payload, channel));
    this.offs.push(
      this.lobby.on("peerLeft", (p) => {
        this.inDedupe.delete(p.peerId);
        this.outboxes.delete(p.peerId);
        this.samples.delete(p.peerId);
      }),
    );
  }

  /** `new NetPlayers` from a lobby and the blueprint (`kit.blueprint`): `sync.player` and `sync.tickRate`. */
  static fromBlueprint(lobby: Lobby, blueprint: { sync: { tickRate: number; player: PlayerBlueprint } }, extra: NetPlayersOptions = {}): NetPlayers {
    const p = blueprint.sync.player;
    return new NetPlayers(lobby, {
      authority: p.authority, space: p.space, range: p.range, velocityRange: p.velocityRange, limits: p.limits, omit: p.omit, ...extra,
      session: { tickRate: blueprint.sync.tickRate, adaptiveDelay: true, ...(extra.session ?? {}) },
    });
  }

  get isHost(): boolean {
    return this.session.isHost;
  }
  get localPeerId(): number {
    return this.session.localPeerId;
  }
  private get tickMs(): number {
    return this.session.clock.tickMs;
  }
  private get dt(): number {
    return 1 / this.session.config.tickRate;
  }

  // ================================================================== public API ==================================

  /** Peers whose player is in the world right now (as this peer sees it, the local one included). */
  get players(): number[] {
    return [...this.known.keys()];
  }

  /** Owner mode: give the layer your player's state. Sent every tick; call as often as you like (a partial patch is merged). */
  setLocalState(patch: Partial<PlayerState>): void {
    if (this.authority !== "owner") throw new Error('setLocalState is for authority "owner"; hand over input with setLocalInput');
    const first = !this.haveLocal;
    this.localState = { ...(first ? defaultPlayerState() : this.localState), ...patch, teleport: first ? (patch.teleport ?? 0) : (patch.teleport ?? this.localState.teleport) };
    this.haveLocal = true;
  }

  /** Host mode: the input of the current tick (a partial patch is merged); sent and stepped once per tick. */
  setLocalInput(patch: Partial<PlayerInput>): void {
    if (this.authority !== "host") throw new Error('setLocalInput is for authority "host"; give your state with setLocalState');
    this.localInput = { ...this.localInput, ...patch, buttons: { ...this.localInput.buttons, ...(patch.buttons ?? {}) } };
  }

  /** The local player's state: yours in owner mode, the predicted one in host mode (draw it at `local` + `smoother.offset`). */
  get local(): PlayerState {
    if (this.authority === "owner") return this.localState;
    if (this.isHost) return this.hostPlayers.get(this.localPeerId)?.state ?? this.localState;
    return this.predictor ? this.predictor.current : this.localState;
  }

  /**
   * One player's state to draw now. The local player: `local`. A remote player: its state at render time (about 100 ms behind,
   * more on a jittery link), turning on the shortest arc, carried on by its velocity for at most 250 ms past the newest
   * snapshot, then held. Undefined while the player is not in the world.
   */
  get(peerId: number): PlayerState | undefined {
    if (peerId === this.localPeerId) return this.known.has(peerId) || this.haveLocal || this.authority === "host" ? this.local : undefined;
    const id = this.known.get(peerId);
    if (id === undefined) return undefined;
    const s = this.session.trySample(id, this.schema);
    if (!s) return undefined;
    const overMs = (this.session.renderTick - this.session.latestTick) * this.tickMs;
    if (!this.isHost && overMs > 0 && this.codec.has("velocity")) {
      const k = Math.min(overMs, NET_PLAYER.carryOnMaxMs) / 1000;
      const R = this.codec.config.range;
      const clamp = (v: number) => Math.max(-R, Math.min(R, v));
      return { ...s, x: clamp(s.x + s.vx * k), y: clamp(s.y + s.vy * k), z: this.codec.is3d ? clamp(s.z + s.vz * k) : s.z };
    }
    return s;
  }

  /** The authoritative state of a player in the newest snapshot (not smoothed). Host: its own record. */
  latest(peerId: number): PlayerState | undefined {
    if (this.isHost) return this.hostPlayers.get(peerId)?.state;
    const id = this.known.get(peerId);
    return id === undefined ? undefined : this.session.tryGetLatest(id, this.schema)?.state;
  }

  /** Send an action event for the local player (arguments by the names of spec/net-player.md). It plays here at once. */
  action<N extends ActionName>(name: N, args: Partial<ActionArgs[N]> = {}): void {
    const def = actionByName(name);
    if (!def) throw new RangeError(`unknown action "${name}"`);
    if (!this.codec.hasEvent(name)) throw new Error(`action "${name}" is left out in this game's blueprint`);
    if (def.origin === "host" && !this.isHost) throw new Error(`"${name}" is raised by the host`);
    this.emitFrom(this.localPeerId, name, args as Record<string, number>);
  }

  /** Host: raise an action event for any player (`hit` and `death` come from here). */
  hostAction<N extends ActionName>(peerId: number, name: N, args: Partial<ActionArgs[N]> = {}): void {
    this.requireHost();
    if (!actionByName(name)) throw new RangeError(`unknown action "${name}"`);
    if (!this.codec.hasEvent(name)) throw new Error(`action "${name}" is left out in this game's blueprint`);
    this.emitFrom(peerId, name, args as Record<string, number>);
  }

  /** Subscribe to one action event by name, for every player (the local one included). Returns the unsubscribe function. */
  onAction<N extends ActionName>(name: N, handler: (e: ActionEvent<N>) => void): () => void {
    const list = this.actionHandlers.get(name) ?? [];
    this.actionHandlers.set(name, list);
    list.push(handler as (e: ActionEvent) => void);
    return () => {
      const i = list.indexOf(handler as (e: ActionEvent) => void);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /**
   * Owner mode: put the local player somewhere else without sliding (raises the teleport counter). Host mode on the host:
   * same for the host's own player. For another player use {@link teleportPlayer}.
   */
  teleport(patch: Partial<PlayerState>): void {
    if (this.isHost) {
      this.teleportPlayer(this.localPeerId, patch);
      return;
    }
    if (this.authority !== "owner") throw new Error('on a client only authority "owner" can teleport itself; the host places a "host" player');
    this.localState = { ...this.localState, ...patch, teleport: (this.localState.teleport + 1) % TELEPORT_MODULO };
    this.haveLocal = true;
  }

  /** Host: place any player (respawn point, portal) without sliding. In owner mode the owner is told to take the host's state. */
  teleportPlayer(peerId: number, patch: Partial<PlayerState>): void {
    this.requireHost();
    const p = this.hostPlayers.get(peerId);
    if (!p) return;
    p.state = this.codec.quantize({ ...p.state, ...patch, teleport: (p.state.teleport + HOST_TELEPORT_STEP) % TELEPORT_MODULO });
    if (peerId === this.localPeerId) {
      this.localState = p.state;
      this.haveLocal = true;
      if (this.authority === "host") this.localInput = { ...this.localInput };
    } else if (this.authority === "owner") p.awaiting = true;
    p.lastTeleportMs = this.lobby.nowMs;
    p.lastAcceptTick = this.session.clock.tick;
    if (!p.spawned) this.spawnEntity(p);
  }

  /** Owner mode (and the host's own player): a teleport that also makes the player alive with full health, then the `respawn` event. */
  respawn(patch: Partial<PlayerState> = {}): void {
    if (this.isHost) {
      this.respawnPlayer(this.localPeerId, patch);
      return;
    }
    this.teleport({ alive: true, health: 100, ...patch });
    if (this.codec.hasEvent("respawn")) this.action("respawn");
  }

  /** Host: respawn any player (a teleport, alive, full health, and the `respawn` event). */
  respawnPlayer(peerId: number, patch: Partial<PlayerState> = {}): void {
    this.requireHost();
    this.teleportPlayer(peerId, { alive: true, health: 100, ...patch });
    if (this.codec.hasEvent("respawn")) this.emitFrom(peerId, "respawn", {});
  }

  /** Where a player was at a host tick (hit rewind). Host only; undefined when not recorded (too old, or never there). */
  stateAt(peerId: number, tick: number): PlayerState | undefined {
    this.requireHost();
    return this.history.trySample(peerId, tick);
  }

  /** Host: where a player was when a shooter saw the world at `view` (an action `shoot`'s `view`, in 1/256 ticks), clamped by the session's rewind limit. */
  rewound(peerId: number, view: number): PlayerState | undefined {
    this.requireHost();
    return this.history.trySample(peerId, this.session.rewindTick({ viewTick: view / 256 }));
  }

  /** The host tick a shooter was seeing, clamped to the session's `maxRewindMs`. */
  rewindTick(view: number): number {
    this.requireHost();
    return this.session.rewindTick({ viewTick: view / 256 });
  }

  /** Replication bytes per second to and from one peer over about the last second. Host: any client. Client: the host. */
  bytesPerSecond(peerId: number): { sent: number; received: number } {
    const list = this.samples.get(peerId);
    if (!list || list.length < 2) return { sent: 0, received: 0 };
    const a = list[0];
    const b = list[list.length - 1];
    const secs = (b.at - a.at) / 1000;
    return secs > 0 ? { sent: (b.sent - a.sent) / secs, received: (b.received - a.received) / secs } : { sent: 0, received: 0 };
  }

  /** Advance everything: call every frame instead of `session.pump()`. Runs the due ticks, snapshots, events and corrections. */
  pump(): void {
    if (this.disposed) return;
    const now = this.lobby.nowMs;
    const elapsed = now - this.lastPumpMs;
    this.lastPumpMs = now;
    this.session.pump();
    if (this.isHost) this.hostRoster();
    else this.clientRoster();
    while (this.session.clock.tryAdvance()) {
      const tick = this.session.clock.tick;
      this.emit("tick", tick);
      if (this.isHost) this.hostTick(tick);
      else this.clientTick();
      this.flushOutboxes();
    }
    if (!this.isHost) {
      this.clientCorrections();
      this.smoother.update(elapsed);
    }
    this.playQueue();
    this.sampleTraffic(now);
  }

  /** Stop listening. The session stays yours. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs = [];
  }

  // ================================================================== internals ==================================

  private readonly schema = {
    read: (r: NetReader): PlayerState => this.codec.readState(r),
    lerp: (a: PlayerState, b: PlayerState, t: number): PlayerState => this.codec.lerp(a, b, t),
  };

  private requireHost(): void {
    if (!this.isHost) throw new Error("host only");
  }

  private sampleTraffic(now: number): void {
    if (now - this.lastSampleMs < PUMP_SAMPLE_MS) return;
    this.lastSampleMs = now;
    const peers = this.isHost ? this.session.clients : [this.session.hostPeerId];
    for (const peer of peers) {
      const t = this.session.trafficWith(peer);
      let list = this.samples.get(peer);
      if (!list) this.samples.set(peer, (list = []));
      list.push({ at: now, sent: t.sent, received: t.received });
      while (list.length > 2 && now - list[1].at >= 1000) list.shift();
    }
  }

  // ---- roster ----------------------------------------------------------------------------------------------------

  private isSpectator(peer: number): boolean {
    try {
      return this.lobby.room.entries.find((e) => e.id === peer)?.role === "spectator";
    } catch {
      return false;
    }
  }

  private hostRoster(): void {
    const want = new Set<number>();
    for (const peer of [this.localPeerId, ...this.session.clients]) if (!this.isSpectator(peer)) want.add(peer);
    for (const peer of want) if (!this.hostPlayers.has(peer)) this.addHostPlayer(peer);
    for (const [peer, p] of [...this.hostPlayers]) {
      if (want.has(peer)) continue;
      if (p.spawned) this.session.despawn(p.entityId);
      this.history.forget(peer);
      this.hostPlayers.delete(peer);
      this.relayDedupe.delete(peer);
      if (this.known.delete(peer)) this.emit("playerLeft", peer);
    }
  }

  private addHostPlayer(peer: number): void {
    const state = this.codec.quantize({ ...defaultPlayerState(), ...this.spawnFn(peer) });
    const p: HostPlayer = {
      peer, entityId: 0, state, spawned: false, awaiting: false, lastAcceptTick: this.session.clock.tick, lastTeleportMs: -1e9,
      lastShotTick: -1e9, lastMeleeTick: -1e9, relaySeq: 0, lastInput: defaultPlayerInput(),
    };
    this.hostPlayers.set(peer, p);
    // host mode: the host places the player at once; owner mode: it appears with its first state
    if (this.authority === "host") this.spawnEntity(p);
  }

  private spawnEntity(p: HostPlayer): void {
    p.entityId = this.session.spawn(PLAYER_TYPE_ID, p.peer, (w) => this.codec.writeState(w, p.state));
    p.spawned = true;
    this.known.set(p.peer, p.entityId);
    this.emit("playerJoined", p.peer);
  }

  private clientRoster(): void {
    const present = new Map<number, number>();
    for (const e of this.session.entities) if (e.typeId === PLAYER_TYPE_ID) present.set(e.owner, e.id);
    for (const [peer, id] of present) {
      if (this.known.get(peer) === id) continue;
      const fresh = !this.known.has(peer);
      this.known.set(peer, id);
      if (fresh) this.emit("playerJoined", peer);
    }
    for (const peer of [...this.known.keys()]) {
      if (present.has(peer)) continue;
      this.known.delete(peer);
      this.relayDedupe.delete(peer);
      if (peer === this.localPeerId) this.predictor = null;
      this.emit("playerLeft", peer);
    }
  }

  // ---- host tick -------------------------------------------------------------------------------------------------

  private hostTick(tick: number): void {
    const now = this.lobby.nowMs;
    for (const [peer, p] of this.hostPlayers) {
      if (peer === this.localPeerId) this.hostLocal(p);
      else {
        const f = this.session.tryGetInput(peer);
        if (f && !f.repeated) {
          if (this.authority === "owner") this.acceptOwnerState(p, f.bytes, tick, now);
          else this.stepRemote(p, f.bytes);
        }
      }
      if (p.spawned) this.history.record(tick, peer, p.state);
    }
    this.session.sendSnapshot();
  }

  private hostLocal(p: HostPlayer): void {
    if (this.authority === "owner") {
      if (!this.haveLocal) return;
      p.state = this.codec.quantize(this.localState);
      this.localState = p.state;
    } else {
      const input = this.codec.quantizeInput(this.localInput);
      p.state = this.runStep(p.state, input);
      this.localState = p.state;
    }
    p.lastAcceptTick = this.session.clock.tick;
    if (!p.spawned) this.spawnEntity(p);
  }

  private runStep(s: PlayerState, input: PlayerInput): PlayerState {
    if (!this.step) throw new Error('authority "host" needs a step function: new NetPlayers(lobby, { authority: "host", step })');
    return this.codec.quantize(this.step(s, input, this.dt));
  }

  private stepRemote(p: HostPlayer, bytes: Uint8Array): void {
    const input = this.codec.decodeInput(bytes);
    if (!input) {
      this.stats.statesRejected++;
      return;
    }
    p.lastInput = input;
    p.state = this.runStep(p.state, input);
    p.lastAcceptTick = this.session.clock.tick;
  }

  private acceptOwnerState(p: HostPlayer, bytes: Uint8Array, tick: number, now: number): void {
    const s = this.codec.decodeState(bytes);
    if (!s) {
      this.stats.statesRejected++;
      return;
    }
    if (!p.spawned) {
      p.state = s;
      p.lastAcceptTick = tick;
      this.spawnEntity(p);
      return;
    }
    if (p.awaiting) {
      if (s.teleport !== p.state.teleport) return; // still the old counter: this state is from before the correction
      p.awaiting = false;
    }
    const prev = p.state;
    const raised = s.teleport !== prev.teleport;
    const lim = this.limits;
    let violation: "speed" | "step" | "teleportRate" | null = null;
    if (raised) {
      if (this.anyMoveLimit() && now - p.lastTeleportMs < NET_PLAYER.teleportMinIntervalMs) violation = "teleportRate";
      else p.lastTeleportMs = now;
    } else {
      const dist = this.distance(prev, s);
      if (lim.maxStep !== undefined && dist > lim.maxStep) violation = "step";
      else if (lim.maxSpeed !== undefined) {
        const secs = (Math.max(1, tick - p.lastAcceptTick) * this.tickMs) / 1000;
        const posStep = (2 * this.codec.config.range) / (2 ** this.codec.posBits - 1);
        if (dist > lim.maxSpeed * secs * NET_PLAYER.speedTolerance + 2 * posStep) violation = "speed";
      }
    }
    if (violation) {
      this.stats.limitViolations++;
      p.state = { ...prev, teleport: (prev.teleport + HOST_TELEPORT_STEP) % TELEPORT_MODULO };
      p.awaiting = true;
      p.lastAcceptTick = tick;
      this.emit("limitViolation", p.peer, violation);
      return;
    }
    p.state = s;
    p.lastAcceptTick = tick;
  }

  private anyMoveLimit(): boolean {
    return this.limits.maxSpeed !== undefined || this.limits.maxStep !== undefined;
  }

  private distance(a: PlayerState, b: PlayerState): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = this.codec.is3d ? b.z - a.z : 0;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // ---- client tick -----------------------------------------------------------------------------------------------

  private clientTick(): void {
    if (this.authority === "owner") {
      if (!this.haveLocal) return;
      const seq = this.session.submitInput(this.codec.encodeState(this.localState));
      this.lastSentSeq = seq;
      this.sentTeleport.set(seq, this.localState.teleport);
      this.sentTeleport.delete(seq - 256);
      return;
    }
    // host mode: send the input, predict the step at once
    const input = this.codec.quantizeInput(this.localInput);
    const seq = this.session.submitInput(this.codec.encodeInput(input));
    if (!this.predictor) {
      const r = new Reconciler<PlayerInput, PlayerState>(this.localState, (s, i) => this.runStep(s, i));
      const eq = (a: PlayerState, b: PlayerState): boolean => this.distance(a, b) <= 0.05;
      r.equal = eq;
      this.predictor = r;
    }
    this.predictor.predict(seq, input);
  }

  private clientCorrections(): void {
    const id = this.known.get(this.localPeerId);
    if (id === undefined) return;
    const latest = this.session.tryGetLatest(id, this.schema);
    if (!latest || latest.tick <= this.lastCorrectTick) return;
    this.lastCorrectTick = latest.tick;
    const auth = latest.state;
    if (this.authority === "owner") {
      // the host put me back when the snapshot shows another teleport counter than the one I sent in the input it applied
      const processed = this.session.lastProcessedInput;
      const sent = this.sentTeleport.get(processed);
      if (sent !== undefined && processed > this.ignoreUntilSeq && auth.teleport !== sent) {
        this.ignoreUntilSeq = this.lastSentSeq; // inputs already on their way still carry the old counter
        this.localState = auth;
        this.haveLocal = true;
        this.stats.corrections++;
        this.emit("corrected", auth);
      }
      return;
    }
    if (!this.predictor) return;
    const before = this.predictor.current;
    const after = this.predictor.reconcile(auth, this.session.lastProcessedInput);
    const dz = this.codec.is3d ? after.z - before.z : after.y - before.y;
    const snapped = this.smoother.correct(after.x - before.x, this.codec.is3d ? after.y - before.y : 0, dz, auth.teleport);
    if (snapped) this.stats.corrections++;
  }

  // ---- action events ---------------------------------------------------------------------------------------------

  private emitFrom(player: number, name: ActionName, args: Record<string, number>): void {
    const def = actionByName(name)!;
    if (name === "shoot" && args.view === undefined) args = { ...args, view: Math.max(0, Math.round(this.session.renderTick * 256)) };
    // what the others see is what the wire carries: quantised
    const bytes = this.codec.encodeArgs(name, args);
    const wire = this.codec.decodeArgs(name, bytes) ?? {};
    const tick = this.isHost ? this.session.clock.tick : Math.max(0, Math.floor(this.session.serverTick));
    this.stats.actionsSent++;
    if (this.isHost) {
      const p = this.hostPlayers.get(player);
      const seq = p ? ++p.relaySeq : ++this.mySeq;
      this.play({ player, name, args: wire as never, tick, seq, late: false, local: player === this.localPeerId });
      const ev: WireEvent = { player, seq, id: def.id, tick, args: bytes };
      for (const c of this.session.clients) this.enqueue(c, ev);
    } else {
      const seq = ++this.mySeq;
      this.play({ player, name, args: wire as never, tick, seq, late: false, local: true });
      this.enqueue(this.session.hostPeerId, { player, seq, id: def.id, tick, args: bytes });
    }
  }

  /** Queue an event for a peer: one copy on `reliable` now, and the next few ticks on `fast`. */
  private enqueue(peer: number, ev: WireEvent): void {
    this.session.sendExtension(peer, encodePlayerEvents([ev]), "reliable");
    let box = this.outboxes.get(peer);
    if (!box) this.outboxes.set(peer, (box = []));
    box.push({ ev, left: NET_PLAYER.eventRepeats });
  }

  private flushOutboxes(): void {
    for (const [peer, box] of this.outboxes) {
      if (box.length === 0) continue;
      const batch: WireEvent[] = [];
      let size = 8;
      for (const e of box) {
        const n = 12 + e.ev.args.length;
        if (batch.length > 0 && size + n > MAX_EVENT_MESSAGE_BYTES) break;
        batch.push(e.ev);
        size += n;
      }
      this.session.sendExtension(peer, encodePlayerEvents(batch), "fast");
      for (let i = 0; i < batch.length; i++) box[i].left--;
      while (box.length > 0 && box[0].left <= 0) box.shift();
    }
  }

  private dedupe(map: Map<number, Dedupe>, key: number, seq: number): boolean {
    let d = map.get(key);
    if (!d) map.set(key, (d = { floor: 0, seen: new Set() }));
    if (seq <= d.floor || d.seen.has(seq)) return false;
    d.seen.add(seq);
    while (d.seen.has(d.floor + 1)) d.seen.delete(++d.floor);
    if (d.seen.size > 512) {
      const lowest = Math.min(...d.seen);
      d.floor = lowest - 1;
      while (d.seen.has(d.floor + 1)) d.seen.delete(++d.floor);
    }
    return true;
  }

  private onEvents(from: number, payload: Uint8Array, _channel: ChannelName): void {
    if (!this.isHost && from !== this.session.hostPeerId) return;
    const events = decodePlayerEvents(payload);
    for (const w of events) {
      if (this.isHost) this.hostReceive(from, w);
      else this.clientReceive(w);
    }
  }

  private hostReceive(from: number, w: WireEvent): void {
    const def = actionById(w.id);
    const p = this.hostPlayers.get(from);
    if (!def || w.player !== from || def.origin === "host" || !this.codec.hasEvent(def.name) || !p) {
      if (this.dedupe(this.inDedupe, from, w.seq)) this.stats.actionsRejected++;
      else this.stats.actionsDuplicate++;
      return;
    }
    if (!this.dedupe(this.inDedupe, from, w.seq)) {
      this.stats.actionsDuplicate++;
      return;
    }
    const args = this.codec.decodeArgs(def.name as ActionName, w.args);
    if (!args) {
      this.stats.actionsRejected++;
      return;
    }
    const tick = this.session.clock.tick;
    const claimed = Math.min(tick + 1, Math.max(tick - NET_PLAYER.claimMaxAgeTicks, w.tick));
    if (!this.withinRate(p, def.name, claimed)) {
      this.stats.actionsRateLimited++;
      return;
    }
    const seq = ++p.relaySeq;
    this.play({ player: from, name: def.name as ActionName, args: args as never, tick, seq, late: false, local: false });
    const ev: WireEvent = { player: from, seq, id: w.id, tick, args: w.args };
    for (const c of this.session.clients) if (c !== from) this.enqueue(c, ev);
  }

  private withinRate(p: HostPlayer, name: string, claimedTick: number): boolean {
    const min = name === "shoot" ? this.limits.minShotIntervalMs : name === "melee" ? this.limits.minMeleeIntervalMs : undefined;
    if (min === undefined) return true;
    const last = name === "shoot" ? p.lastShotTick : p.lastMeleeTick;
    const gapMs = (claimedTick - last) * this.tickMs;
    if (gapMs < min * NET_PLAYER.rateTolerance - this.tickMs) return false;
    if (name === "shoot") p.lastShotTick = claimedTick;
    else p.lastMeleeTick = claimedTick;
    return true;
  }

  private clientReceive(w: WireEvent): void {
    const def = actionById(w.id);
    const args = def ? this.codec.decodeArgs(def.name as ActionName, w.args) : null;
    if (!def || !args || !this.codec.hasEvent(def.name)) {
      this.stats.actionsRejected++;
      return;
    }
    if (!this.dedupe(this.relayDedupe, w.player, w.seq)) {
      this.stats.actionsDuplicate++;
      return;
    }
    const ev: ActionEvent = { player: w.player, name: def.name as ActionName, args: args as never, tick: w.tick, seq: w.seq, late: false, local: false };
    const render = this.session.renderTick;
    if (w.player === this.localPeerId || render <= 0) {
      this.play(ev);
      return;
    }
    if (w.tick <= render) {
      ev.late = true;
      this.stats.actionsLate++;
      this.play(ev);
      return;
    }
    this.queue.push({ ev, at: w.tick });
  }

  private playQueue(): void {
    if (this.queue.length === 0) return;
    const render = this.session.renderTick;
    this.queue.sort((a, b) => a.at - b.at || a.ev.seq - b.ev.seq);
    while (this.queue.length > 0 && this.queue[0].at <= render) this.play(this.queue.shift()!.ev);
  }

  private play(e: ActionEvent): void {
    this.stats.actionsPlayed++;
    for (const h of [...(this.actionHandlers.get(e.name) ?? [])]) {
      try {
        h(e);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
    this.emit("action", e);
  }
}

export { ACTION_EVENTS };
