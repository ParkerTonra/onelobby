import { BanList } from "./bans.js";
import { Emitter } from "./emitter.js";
import type { Hub } from "./hub.js";
import { OneLobbyError } from "./signaling.js";
import {
  CODE_PATTERN, DATA_KEY_PATTERN, admit, applyData, autoStartHolds, chooseSeat, countdownRemaining, dataDefaults, effectiveName,
  isEligible, isLoopbackIp, isPlayerId, mergeDataSpec, removalReason, safeEqual,
  type AutoStartMode, type DataSpec, type LateJoinPolicy, type RoomRole, type RoomState, type SeatDroppedPolicy, type TextFilter,
} from "./room-rules.js";
import { parseRoomBody, roomMessage, type CountdownInfo, type GoneWhy, type RoomEntry, type RoomMsg, type RoomSettings } from "./room-wire.js";

export type { RoomEntry, RoomSettings, CountdownInfo } from "./room-wire.js";
export type { RoomRole, RoomState, RoomStatus, LateJoinPolicy, AutoStartMode, SeatDroppedPolicy, DataSpec, DataDecl, TextFilter } from "./room-rules.js";

/** How long a joiner waits for the host's room reply, and a host for a peer's `join`, before calling the other side old. */
export const ROOM_JOIN_WAIT_MS = 3000;
/** Host: the `cd` countdown tick. */
export const COUNTDOWN_TICK_MS = 1000;
/** A replica asks for a fresh `snap` at most this often. */
export const RESYNC_GAP_MS = 1000;
/** Host: per peer, at most this many `join`/`set`/`ready`/`role`/`req` per second. */
export const ROOM_REQUESTS_PER_SECOND = 10;
const HOST_TICK_MS = 100;

/** What a host sets in code or in `onelobby.json` (`room`); every key is optional. */
export interface RoomOptions {
  autoStart?: AutoStartMode;
  autoStartPlayers?: number;
  minPlayers?: number;
  countdownSeconds?: number;
  /** Spectator cap (not counted in `maxPlayers`); 0 or none turns spectating off. */
  spectators?: number;
  lateJoin?: LateJoinPolicy;
  seatDropped?: SeatDroppedPolicy;
  rejoinWindowSeconds?: number;
  /** Per-player data keys beyond the built-ins `color`, `avatar` and `team`. */
  data?: DataSpec;
  /** `host()` throws `password_required` unless a password is given. */
  passwordRequired?: boolean;
  /** Longest effective name, at most 24. */
  maxNameLength?: number;
}

/** What a joiner brings: its role, starting data and the password it knows. */
export interface RoomJoinOptions {
  role?: RoomRole;
  data?: Record<string, string>;
  password?: string;
}

/** The settings a room starts with, from `RoomOptions` and the lobby's `maxPlayers`. */
export function resolveSettings(o: RoomOptions | undefined, maxPlayers: number, lateJoinFlag: boolean): RoomSettings {
  const r = o ?? {};
  const clampInt = (v: number | undefined, d: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(Number.isFinite(v as number) ? (v as number) : d)));
  return {
    maxPlayers,
    spectators: clampInt(r.spectators, 0, 0, 64),
    minPlayers: clampInt(r.minPlayers, 1, 1, Math.max(1, maxPlayers)),
    autoStart: r.autoStart ?? "off",
    autoStartPlayers: clampInt(r.autoStartPlayers, 2, 2, 64),
    countdownMs: clampInt(r.countdownSeconds, 3, 0, 60) * 1000,
    lateJoin: r.lateJoin ?? (lateJoinFlag ? "allow" : "refuse"),
    seatDropped: r.seatDropped ?? "window",
    rejoinWindowMs: clampInt(r.rejoinWindowSeconds, 60, 0, 600) * 1000,
    maxNameLength: clampInt(r.maxNameLength, 24, 1, 24),
    data: mergeDataSpec(r.data),
  };
}

/** A countdown as a replica sees it: `remaining()` counts down to the host's start in this peer's clock. */
export interface CountdownView {
  readonly seq: number;
  readonly total: number;
  /** In this peer's `clock.now()` base. */
  readonly deadline: number;
  /** Milliseconds left now. */
  remaining(): number;
}

export interface SeatDroppedInfo {
  seat: number;
  peerId: number;
  name: string;
  data: Record<string, string>;
  /** "timeout" (past the rejoin window), "left", "kicked", "disconnected". */
  reason: string;
  /** True when the rejoin window ran out; false when the hook fired at once (policy `immediate`, or a leave). */
  afterWindow: boolean;
}
export interface SeatRestoredInfo {
  seat: number;
  peerId: number;
  name: string;
  /** The same player (same player id) took its seat back. */
  returning: boolean;
}
/** Why this peer was removed from the lobby (spec/room.md s.5.1). */
export interface RemovalInfo {
  code: string;
  reason: string;
  ban: boolean;
}

/** An entry that has left the room (the last state a `playerLeft` listener sees). */
export type LeftEntry = Omit<RoomEntry, "status"> & { status: "left" };

export type RoomEvents = {
  /** Anything in the room changed (after the matching specific events). */
  changed: [];
  playerJoined: [RoomEntry];
  /** `why`: "left", "kicked", "disconnected" or "timeout". The entry has status "left". */
  playerLeft: [LeftEntry, why: string];
  /** `keys`: "name", "role", "seat", "ready", "status", "legacy" and "data.<key>". */
  playerChanged: [RoomEntry, keys: string[]];
  stateChanged: [state: RoomState, prev: RoomState];
  /** The state became "started" (the lobby phase is in_game). */
  started: [];
  allReadyChanged: [allReady: boolean];
  /** A countdown began, or the host sent its once-a-second tick. */
  countdown: [CountdownView];
  /** "host", "too_few" or "condition". */
  countdownCancelled: [reason: string];
  /** The room went from started or countdown back to lobby (a rematch comes through here too). */
  backToLobby: [];
  settingsChanged: [RoomSettings];
  /** Host only: put a bot in this seat. */
  seatDropped: [SeatDroppedInfo];
  /** Host only: a player took a dropped seat; take the bot out. */
  seatRestored: [SeatRestoredInfo];
  /** Host only: a joiner asked for start, back to lobby or a rematch. Nothing changed. */
  requested: [peerId: number, what: "start" | "lobby" | "rematch"];
  /** This peer was removed from the lobby; `lobby.removal` holds the same. Fires once, before `sessionEnded`. */
  removed: [RemovalInfo];
  /** A request of this peer was refused by the host. */
  rejected: [code: string, re: string, key?: string];
  bansChanged: [];
  /** The host speaks the room layer (first `snap` arrived; the host itself is supported from the start). */
  supported: [];
  /** The host never answered: it predates the room layer. `room.players` lists the hub roster; calls throw `room_unsupported`. */
  unsupported: [];
};

export interface RoomDeps {
  hub: Hub;
  /** The latest round trip to the host in ms (0 when none). */
  rtt: () => number;
  /** The hub's name for a peer, or undefined when it is not in the roster. */
  peerName: (peerId: number) => string | undefined;
  /** Every peer id in the lobby roster, this peer included. */
  peerIds: () => number[];
  /** The lobby phase now. */
  phase: () => "lobby" | "in_game";
  /** Host: move the lobby phase to in_game (signaling `phase`, lockstep start). */
  startGame: () => void;
  /** Host: move the lobby phase back to lobby (signaling `phase`, lockstep reset). */
  endGame: () => void;
  /** Host: remove a peer: signaling `kick` with the code and reason, local roster and link. */
  removePeer: (peerId: number, o: { ban: boolean; code: string; reason: string }) => void;
  /** Host: tell the hub the banned player ids (`bans`), when the hub understands it. */
  syncBans: (ids: string[]) => void;
  /** Host: a peer's WebRTC remote address when known. */
  linkAddress: (peerId: number) => string | undefined;
  reportError: (e: Error) => void;
  /** This peer's removal reason became known (a room `deny`); the lobby keeps it as `lobby.removal`. */
  setRemoval: (info: RemovalInfo) => void;
}

export interface RoomConfig {
  /** The host's settings; a joiner's are replaced by the host's `snap`. */
  settings: RoomSettings;
  /** Host: the lobby password ("" = none). */
  password: string;
  /** This install's player id. */
  pid: string;
  bans: BanList;
  /** Joiner: what to send in `join`. */
  join: Required<RoomJoinOptions>;
}

interface View {
  entries: Map<number, string>;
  objs: Map<number, RoomEntry>;
  state: RoomState;
  cdSeq: number;
  settings: string;
  allReady: boolean;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function entryKeys(a: RoomEntry | undefined, b: RoomEntry): string[] {
  if (!a) return ["name", "role", "seat", "ready", "status"];
  const keys: string[] = [];
  for (const k of ["name", "role", "seat", "ready", "status", "legacy"] as const) if (a[k] !== b[k]) keys.push(k);
  for (const k of new Set([...Object.keys(a.data), ...Object.keys(b.data)])) if (a.data[k] !== b.data[k]) keys.push(`data.${k}`);
  return keys;
}

/**
 * The room layer (spec/room.md): one host-authoritative roster with per-player data, ready, a start countdown, spectators,
 * seats, a reconnecting state, kick and ban with reasons. The host holds the truth and replicates it to every peer over
 * the room frame (0x80); a joiner's calls are requests the host validates. `lobby.room` exists on every lobby.
 */
export class Room extends Emitter<RoomEvents> {
  /** Host only: filters names (kind "name") and chat lines (kind "chat"). Nothing is filtered by default. */
  filter: TextFilter | null = null;
  /** Host only: the persistent ban list (spec/room.md s.5.3). */
  readonly bans: BanList;
  /** undefined until known: true once the host answered (the host itself: always), false when it never did (an older host). */
  supported: boolean | undefined;

  private rev = 0;
  private _state: RoomState = "lobby";
  private _settings: RoomSettings;
  private roster = new Map<number, RoomEntry>();
  private cd: { seq: number; total: number; deadline: number } | null = null;
  private lastAllReady = false;
  private closed = false;
  private removedFired = false;

  // joiner
  private supportTimer: (() => void) | null = null;
  private lastResync = -Infinity;

  // host
  private cancelTick: (() => void) | null = null;
  private pids = new Map<number, string>();
  private seatMemory = new Map<string, number>();
  private droppedSeats = new Set<number>();
  private dropFired = new Set<number>();
  private reconnectUntil = new Map<number, number>();
  private legacyWait = new Map<number, number>();
  private requests = new Map<number, { start: number; n: number }>();
  private cdSeq = 0;
  private cdAuto = false;
  /** After back to lobby, auto start waits for the next roster or ready change. */
  private autoHold = false;
  private nextCd = 0;
  private offBans: () => void;

  constructor(private deps: RoomDeps, private cfg: RoomConfig) {
    super();
    this._settings = cfg.settings;
    this.bans = cfg.bans;
    this.offBans = this.bans.on("changed", () => {
      this.emit("bansChanged");
      if (this.hub.isHost) this.deps.syncBans(this.bans.hubIds());
    });
    if (this.hub.isHost) this.initHost();
  }

  private get hub(): Hub {
    return this.deps.hub;
  }
  private now(): number {
    return this.hub.clock.now();
  }

  // ---- reading ---------------------------------------------------------------------------------------------------

  get state(): RoomState {
    return this._state;
  }
  get settings(): RoomSettings {
    return clone(this._settings);
  }
  /** Every entry (players, spectators, reconnecting ones), by peer id. Before the host's `snap`, or on an older host, the hub roster. */
  get entries(): RoomEntry[] {
    if (this.hub.isHost || this.supported) return [...this.roster.values()].sort((a, b) => a.id - b.id).map(clone);
    return this.deps.peerIds().sort((a, b) => a - b).map((id) => ({
      id, name: this.deps.peerName(id) ?? `Player ${id}`, role: "player" as const, seat: -1, ready: false, status: "connected" as const, data: {},
    }));
  }
  /** Entries with role player, by seat. */
  get players(): RoomEntry[] {
    return this.entries.filter((e) => e.role === "player").sort((a, b) => a.seat - b.seat || a.id - b.id);
  }
  get spectators(): RoomEntry[] {
    return this.entries.filter((e) => e.role === "spectator");
  }
  player(peerId: number): RoomEntry | undefined {
    return this.entries.find((e) => e.id === peerId);
  }
  /** This peer's own entry. */
  get me(): RoomEntry | undefined {
    return this.player(this.hub.localPeerId);
  }
  /** The countdown now running, or null. */
  get countdown(): CountdownView | null {
    return this.cd ? this.view(this.cd) : null;
  }
  /** Every non-legacy player is connected and ready, and there is at least one. */
  get allReady(): boolean {
    const ps = [...this.roster.values()].filter((e) => e.role === "player" && !e.legacy);
    return ps.length > 0 && ps.every((e) => e.status === "connected" && e.ready);
  }
  /** Replica revision (spec/room.md s.1). */
  get revision(): number {
    return this.rev;
  }

  private view(cd: { seq: number; total: number; deadline: number }): CountdownView {
    const now = () => this.now();
    return { seq: cd.seq, total: cd.total, deadline: cd.deadline, remaining: () => Math.max(0, Math.round(cd.deadline - now())) };
  }

  // ---- player calls ----------------------------------------------------------------------------------------------

  /** Your own ready flag. Players only; the result is the next `playerChanged`, or `rejected`. */
  setReady(ready: boolean): void {
    this.requireSupport();
    if (this.hub.isHost) return this.hostReady(this.hub.localPeerId, ready, true);
    this.sendToHost({ t: "ready", ready: !!ready });
  }

  /** Flips your ready flag. */
  toggleReady(): void {
    this.setReady(!this.me?.ready);
  }

  /** Your own data (colour, avatar index, team, game keys). Atomic; "" unsets a key. The host can also pass a peer id first. */
  setData(values: Record<string, string>): void;
  setData(peerId: number, values: Record<string, string>): void;
  setData(a: number | Record<string, string>, b?: Record<string, string>): void {
    this.requireSupport();
    const peerId = typeof a === "number" ? a : this.hub.localPeerId;
    const values = typeof a === "number" ? b! : a;
    if (typeof a === "number" && a !== this.hub.localPeerId && !this.hub.isHost) throw new OneLobbyError("not_allowed", "only the host can set another player's data");
    if (this.hub.isHost) {
      const r = this.hostSet(peerId, values, true);
      if (r) throw new OneLobbyError(r.code, `data refused: ${r.code}${r.key ? ` (${r.key})` : ""}`);
      return;
    }
    this.sendToHost({ t: "set", data: values });
  }

  /** Become a spectator or a player (your own role). The host answers with `playerChanged` or `rejected`. */
  setRole(role: RoomRole): void {
    this.requireSupport();
    if (this.hub.isHost) {
      const r = this.hostRole(this.hub.localPeerId, role);
      if (r) throw new OneLobbyError(r, `cannot become a ${role}: ${r}`);
      return;
    }
    this.sendToHost({ t: "role", role });
  }

  /** Ask the host to start, go back to the lobby or rematch. It raises the host's `requested` event and changes nothing by itself. */
  request(what: "start" | "lobby" | "rematch"): void {
    this.requireSupport();
    if (this.hub.isHost) {
      this.emit("requested", this.hub.localPeerId, what);
      return;
    }
    this.sendToHost({ t: "req", what });
  }

  // ---- host calls ------------------------------------------------------------------------------------------------

  /** Host: move a player or spectator to the other role (the capacity rules apply; a failure throws its code). */
  moveTo(peerId: number, role: RoomRole): void {
    this.requireHost();
    const r = this.hostRole(peerId, role);
    if (r) throw new OneLobbyError(r, `cannot move player ${peerId} to ${role}: ${r}`);
  }

  /** Host: start the game, after the countdown when `countdownMs` is above 0. Throws `wrong_state` or `not_enough_players`. */
  start(): void {
    this.requireHost();
    if (this._state !== "lobby") throw new OneLobbyError("wrong_state", `the room is ${this._state}, not in the lobby`);
    if (this.eligible() < Math.max(1, this._settings.minPlayers)) throw new OneLobbyError("not_enough_players", `at least ${this._settings.minPlayers} connected player(s) needed`);
    this.beginStart(false);
  }

  /** Host: stop a running countdown (a no-op otherwise). */
  cancelCountdown(): void {
    this.requireHost();
    this.cancelStart("host");
  }

  /** Host: back to the lobby (ready flags reset, links and roster untouched). A no-op in the lobby. */
  backToLobby(): void {
    this.requireHost();
    if (this._state === "lobby") return;
    this.mutate((c) => {
      this._state = "lobby";
      this.cd = null;
      c.cancel = "host";
      c.hold = true;
      for (const e of this.roster.values()) if (e.role === "player") e.ready = false;
    });
    this.deps.endGame();
  }

  /** Host: back to the lobby, then start again (the countdown applies). Players keep their seats, data and names. */
  rematch(): void {
    this.requireHost();
    this.backToLobby();
    this.start();
  }

  /** Host: changes some settings for everyone (see spec/room.md s.9). */
  configure(s: Partial<Pick<RoomSettings, "autoStart" | "autoStartPlayers" | "minPlayers" | "countdownMs" | "lateJoin" | "seatDropped" | "rejoinWindowMs">>): void {
    this.requireHost();
    this.mutate(() => {
      const n = { ...this._settings };
      for (const [k, v] of Object.entries(s)) if (v !== undefined && k in n) (n as Record<string, unknown>)[k] = v;
      this._settings = n;
    });
  }

  /** Host: remove a player; it may rejoin. `code` defaults to "kicked"; `reason` is shown to the player (default sentence of the code). */
  kick(peerId: number, o: { code?: string; reason?: string } = {}): void {
    this.requireHost();
    const code = this.checkCode(o.code ?? "kicked");
    this.deps.removePeer(peerId, { ban: false, code, reason: removalReason(code, o.reason) });
  }

  /** Host: remove a player and ban it for good (its player id, and its address when known); see `bans`, `unban`. */
  ban(peerId: number, o: { code?: string; reason?: string } = {}): void {
    this.requireHost();
    const code = this.checkCode(o.code ?? "banned");
    const reason = removalReason(code, o.reason);
    const e = this.roster.get(peerId);
    const pid = this.pids.get(peerId);
    const ip = this.deps.linkAddress(peerId);
    if (pid || (ip && !isLoopbackIp(ip))) this.bans.add({ id: pid, ip, name: e?.name, reason, code });
    // the hub gets ban:false: the persistent list (and `bans` for the hub's id check) is what bans here, so unban can lift it
    this.deps.removePeer(peerId, { ban: false, code, reason });
  }

  /** Host: lift a ban by player id or address; returns how many entries went. */
  unban(idOrIp: string): number {
    return this.bans.remove(idOrIp);
  }

  // ---- internals called by Lobby ----------------------------------------------------------------------------------

  /** A room frame arrived from `from`. */
  handleFrame(from: number, body: Uint8Array): void {
    const m = parseRoomBody(body);
    if (!m || this.closed) return;
    if (this.hub.isHost) this.hostHandle(from, m);
    else if (from === this.hub.hostPeerId) this.joinerHandle(m);
  }

  /** Joiner: the link to the host is open and `hi` went out: introduce ourselves. */
  onHostLink(): void {
    if (this.hub.isHost || this.closed) return;
    const j = this.cfg.join;
    this.sendToHost({
      t: "join", v: 1,
      ...(isPlayerId(this.cfg.pid) ? { pid: this.cfg.pid } : {}),
      role: j.role,
      ...(j.password ? { password: j.password } : {}),
      ...(Object.keys(j.data).length ? { data: j.data } : {}),
    });
    if (this.supported === undefined && !this.supportTimer) {
      this.supportTimer = this.hub.clock.setTimeout(() => {
        this.supportTimer = null;
        if (this.supported === undefined && !this.closed) {
          this.supported = false;
          this.emit("unsupported");
        }
      }, ROOM_JOIN_WAIT_MS);
    }
  }

  /** Host: a joiner finished its handshake (`hi`). It has ROOM_JOIN_WAIT_MS to send `join`. */
  onPeerHi(peerId: number): void {
    if (!this.hub.isHost || this.closed) return;
    const e = this.roster.get(peerId);
    if (e && e.status === "connected") return;
    this.legacyWait.set(peerId, this.now() + ROOM_JOIN_WAIT_MS);
  }

  /** A peer left the roster. `final`: it was removed for good (a kick, a drop), so there is no rejoin window. */
  onPeerLeft(peerId: number, reason: string, final: boolean): void {
    if (!this.hub.isHost || this.closed) return;
    this.legacyWait.delete(peerId);
    this.requests.delete(peerId);
    const e = this.roster.get(peerId);
    if (!e || peerId === this.hub.localPeerId) return;
    if (!final && reason === "timeout" && this._settings.rejoinWindowMs > 0 && !e.legacy) {
      this.mutate(() => {
        e.status = "reconnecting";
      });
      this.reconnectUntil.set(peerId, this.now() + this._settings.rejoinWindowMs);
      if (this._settings.seatDropped === "immediate") this.fireSeatDropped(e, "disconnected", false);
      return;
    }
    this.removeEntry(peerId, reason === "kicked" ? "kicked" : reason === "disconnected" ? "disconnected" : reason === "left" ? "left" : final ? "disconnected" : "timeout");
  }

  /** Host: the hub renamed a peer. */
  onRenamed(peerId: number, name: string): void {
    if (!this.hub.isHost || this.closed) return;
    const e = this.roster.get(peerId);
    if (!e) return;
    const next = this.nameFor(name, peerId, peerId);
    if (next !== e.name) this.mutate(() => void (e.name = next));
  }

  /** Host: the lobby phase changed under the room (a game that calls `lobby.start()` directly, or a hub echo). */
  onPhase(phase: "lobby" | "in_game"): void {
    if (!this.hub.isHost || this.closed) return;
    if (phase === "in_game" && this._state !== "started") {
      this.mutate((c) => {
        this._state = "started";
        this.cd = null;
        c.cancel = "host";
      });
    } else if (phase === "lobby" && this._state !== "lobby") {
      this.mutate((c) => {
        this._state = "lobby";
        this.cd = null;
        c.cancel = "host";
        c.hold = true;
        for (const e of this.roster.values()) if (e.role === "player") e.ready = false;
      });
    }
  }

  /** Host: a joiner's link address became known; a banned address is removed. */
  onLinkAddress(peerId: number, ip: string): void {
    if (!this.hub.isHost || this.closed || peerId === this.hub.localPeerId) return;
    const pid = this.pids.get(peerId);
    const hit = this.bans.match({ id: pid, ip });
    if (!hit) return;
    const code = hit.code && CODE_PATTERN.test(hit.code) ? hit.code : "banned";
    this.deps.removePeer(peerId, { ban: false, code, reason: removalReason(code, hit.reason) });
  }

  /** This peer is the host now (migration): the replica becomes the truth. */
  onBecameHost(): void {
    if (this.closed) return;
    this.supportTimer?.();
    this.supportTimer = null;
    const had = this.supported === true;
    this.supported = true;
    this.pids.clear();
    this.legacyWait.clear();
    this.reconnectUntil.clear();
    this.droppedSeats.clear();
    this.dropFired.clear();
    if (had) {
      const until = this.now() + this._settings.rejoinWindowMs;
      for (const e of this.roster.values()) {
        if (e.id === this.hub.localPeerId) continue;
        if (!this.deps.peerIds().includes(e.id)) this.roster.delete(e.id);
        else {
          e.status = "reconnecting";
          this.reconnectUntil.set(e.id, until);
        }
      }
      const me = this.roster.get(this.hub.localPeerId);
      if (me) {
        this.pids.set(me.id, this.cfg.pid);
        if (isPlayerId(this.cfg.pid) && me.seat >= 0) this.seatMemory.set(this.cfg.pid, me.seat);
      } else this.addHostEntry();
      if (this._state === "countdown") {
        this._state = "lobby";
        this.cd = null;
      }
      this.rev += 1;
    } else {
      this.roster.clear();
      this.rev = 1;
      this._state = this.deps.phase() === "in_game" ? "started" : "lobby";
      this.addHostEntry();
    }
    this.startTicker();
    this.deps.syncBans(this.bans.hubIds());
    this.emit("supported");
    this.emit("changed");
  }

  /** This peer lost a host claim: it is a joiner again. */
  onBecameJoiner(): void {
    this.cancelTick?.();
    this.cancelTick = null;
  }

  /** The signaling `error{kicked}` (or a room `deny`) reached this peer. */
  onRemoved(info: RemovalInfo): void {
    if (this.removedFired) return;
    this.removedFired = true;
    this.deps.setRemoval(info);
    this.emit("removed", info);
  }

  close(): void {
    this.closed = true;
    this.cancelTick?.();
    this.cancelTick = null;
    this.supportTimer?.();
    this.supportTimer = null;
    this.offBans();
  }

  // ---- host: roster ----------------------------------------------------------------------------------------------

  private initHost(): void {
    this.supported = true;
    this.rev = 1;
    this.addHostEntry();
    this.startTicker();
  }

  private addHostEntry(): void {
    const id = this.hub.localPeerId;
    const pid = this.cfg.pid;
    this.pids.set(id, pid);
    const role: RoomRole = "player";
    const seat = chooseSeat(this._settings.maxPlayers, new Set(), this.seatMemory, isPlayerId(pid) ? pid : "").seat;
    if (isPlayerId(pid)) this.seatMemory.set(pid, seat);
    let data: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.cfg.join.data)) {
      const r = applyData(this._settings.data, data, { [k]: v }, true);
      if (r.ok) data = r.data;
    }
    this.roster.set(id, {
      id, name: this.nameFor(this.deps.peerName(id) ?? "", id, id), role, seat, ready: false, status: "connected",
      data: dataDefaults(this._settings.data, data),
    });
    this.lastAllReady = this.allReady;
  }

  private startTicker(): void {
    this.cancelTick?.();
    this.cancelTick = this.hub.clock.setInterval(() => this.hostTick(), HOST_TICK_MS);
  }

  private nameFor(input: string, peerId: number, selfId: number): string {
    const others = [...this.roster.values()].filter((e) => e.id !== selfId).map((e) => e.name);
    return effectiveName(input, peerId, others, this._settings.maxNameLength, this.filter);
  }

  private eligible(): number {
    return [...this.roster.values()].filter(isEligible).length;
  }

  private checkCode(code: string): string {
    if (!CODE_PATTERN.test(code)) throw new RangeError("code must be lower-case letters, digits and underscores, starting with a letter, at most 32");
    return code;
  }

  private requireHost(): void {
    if (!this.hub.isHost) throw new Error("only the host can do that");
    this.requireSupport();
  }

  private requireSupport(): void {
    if (this.supported === false) throw new OneLobbyError("room_unsupported", "the host's version has no room layer (update the host)");
  }

  private sendToHost(m: RoomMsg): void {
    this.hub.sendToHost(roomMessage(m), 0);
  }

  private sendRoom(peerId: number, m: RoomMsg): void {
    this.hub.sendTo(peerId, roomMessage(m), 0);
  }

  /** Peers that can read room frames and have a link now (the host's own entry excluded). */
  private audience(except?: number): number[] {
    const open = new Set(this.hub.connectedPeers());
    return [...this.roster.values()].filter((e) => !e.legacy && e.id !== this.hub.localPeerId && e.id !== except && open.has(e.id)).map((e) => e.id);
  }

  private snapshot(): View {
    return {
      entries: new Map([...this.roster].map(([id, e]) => [id, JSON.stringify(e)])),
      objs: new Map([...this.roster].map(([id, e]) => [id, clone(e)])),
      state: this._state,
      cdSeq: this.cd?.seq ?? 0,
      settings: JSON.stringify(this._settings),
      allReady: this.allReady,
    };
  }

  /**
   * Host: run `fn` (which edits the roster, state, countdown or settings), then replicate one `upd` to everyone and raise
   * the local events. `except` is a peer that gets a `snap` instead (a fresh joiner).
   */
  private mutate(fn: (c: { gone: { id: number; why: GoneWhy }[]; cancel?: string; hold?: boolean }) => void, except?: number): void {
    const before = this.snapshot();
    const ctx: { gone: { id: number; why: GoneWhy }[]; cancel?: string; hold?: boolean } = { gone: [] };
    fn(ctx);
    const changed = [...this.roster.values()].filter((e) => before.entries.get(e.id) !== JSON.stringify(e));
    if (ctx.hold) this.autoHold = true;
    else if (changed.length || ctx.gone.length) this.autoHold = false;
    const settingsChanged = JSON.stringify(this._settings) !== before.settings;
    const stateChanged = this._state !== before.state;
    const cdChanged = (this.cd?.seq ?? 0) !== before.cdSeq;
    if (changed.length || ctx.gone.length || settingsChanged || stateChanged || cdChanged) {
      this.rev += 1;
      const upd: RoomMsg = {
        t: "upd", rev: this.rev,
        ...(changed.length ? { players: clone(changed) } : {}),
        ...(ctx.gone.length ? { gone: ctx.gone } : {}),
        ...(stateChanged ? { state: this._state } : {}),
        ...(cdChanged || stateChanged ? { countdown: this.cdInfo() } : {}),
        ...(settingsChanged ? { settings: clone(this._settings) } : {}),
        ...(ctx.cancel && (stateChanged || cdChanged) && this.cd === null ? { cancel: ctx.cancel } : {}),
      } as RoomMsg;
      for (const p of this.audience(except)) this.sendRoom(p, upd);
      this.emitChanges(before, ctx.gone, ctx.cancel);
    }
    this.evaluate();
  }

  private cdInfo(): CountdownInfo | null {
    return this.cd ? { seq: this.cd.seq, total: this.cd.total, left: Math.max(0, Math.round(this.cd.deadline - this.now())) } : null;
  }

  private snapMsg(): RoomMsg {
    return { t: "snap", v: 1, rev: this.rev, state: this._state, countdown: this.cdInfo(), settings: clone(this._settings), players: clone([...this.roster.values()]) };
  }

  // ---- host: requests --------------------------------------------------------------------------------------------

  private allowRequest(from: number): boolean {
    const now = this.now();
    let w = this.requests.get(from);
    if (!w || now - w.start >= 1000) this.requests.set(from, (w = { start: now, n: 0 }));
    return ++w.n <= ROOM_REQUESTS_PER_SECOND;
  }

  private hostHandle(from: number, m: RoomMsg): void {
    if (from === this.hub.localPeerId) return;
    switch (m.t) {
      case "join":
      case "set":
      case "ready":
      case "role":
      case "req": {
        if (!this.allowRequest(from)) {
          if (m.t !== "join") this.sendRoom(from, { t: "nack", re: m.t, code: "rate_limited" });
          return;
        }
        break;
      }
      case "resync": {
        if (this.roster.has(from) && !this.roster.get(from)!.legacy) this.sendRoom(from, this.snapMsg());
        return;
      }
      default:
        return;
    }
    if (m.t === "join") return this.hostJoin(from, m);
    const e = this.roster.get(from);
    if (!e || e.legacy) return;
    if (m.t === "set") {
      const r = this.hostSet(from, m.data && typeof m.data === "object" ? m.data : {}, false);
      if (r) this.sendRoom(from, { t: "nack", re: "set", code: r.code, ...(r.key ? { key: r.key } : {}) });
    } else if (m.t === "ready") {
      this.hostReady(from, m.ready === true, false);
    } else if (m.t === "role") {
      const r = m.role === "player" || m.role === "spectator" ? this.hostRole(from, m.role) : "bad_value";
      if (r) this.sendRoom(from, { t: "nack", re: "role", code: r });
    } else if (m.t === "req") {
      if (m.what === "start" || m.what === "lobby" || m.what === "rematch") this.emit("requested", from, m.what);
      else this.sendRoom(from, { t: "nack", re: "req", code: "bad_value" });
    }
  }

  private hostSet(id: number, values: Record<string, unknown>, byHost: boolean): { code: string; key?: string } | null {
    const e = this.roster.get(id);
    if (!e) return { code: "not_allowed" };
    const r = applyData(this._settings.data, e.data, values, byHost);
    if (!r.ok) return { code: r.code, key: r.key };
    this.mutate(() => void (e.data = r.data));
    return null;
  }

  private hostReady(id: number, ready: boolean, local: boolean): void {
    const e = this.roster.get(id);
    const fail = (code: string) => {
      if (local) throw new OneLobbyError(code, `cannot change ready: ${code}`);
      this.sendRoom(id, { t: "nack", re: "ready", code });
    };
    if (!e || e.role !== "player" || e.legacy) return fail("not_allowed");
    if (e.status !== "connected") return fail("not_allowed");
    if (e.ready === ready) return;
    this.mutate(() => void (e.ready = ready));
  }

  /** Returns an error code, or null when the move happened. */
  private hostRole(id: number, role: RoomRole): string | null {
    const e = this.roster.get(id);
    if (!e || e.legacy) return "not_allowed";
    if (e.role === role) return null;
    const entries = [...this.roster.values()];
    if (role === "spectator") {
      if (entries.filter((x) => x.role === "spectator").length >= this._settings.spectators) return "spectators_full";
    } else {
      if (entries.filter((x) => x.role === "player").length >= this._settings.maxPlayers) return "lobby_full";
      if (this._state === "started" && this._settings.lateJoin !== "allow") return this._settings.lateJoin === "refuse" ? "in_game" : "not_allowed";
    }
    this.mutate(() => {
      e.role = role;
      e.ready = false;
      if (role === "spectator") e.seat = -1;
      else this.giveSeat(e, this.pids.get(id) ?? "");
    });
    return null;
  }

  /** Gives a player entry its seat (4.3); raises `seatRestored` when it was a dropped one. */
  private giveSeat(e: RoomEntry, pid: string): void {
    const held = new Set([...this.roster.values()].filter((x) => x !== e && x.role === "player" && x.seat >= 0).map((x) => x.seat));
    const r = chooseSeat(this._settings.maxPlayers, held, this.seatMemory, isPlayerId(pid) ? pid : "");
    e.seat = r.seat;
    if (r.takeOver) this.seatMemory.delete(r.takeOver);
    if (r.seat >= 0 && isPlayerId(pid)) this.seatMemory.set(pid, r.seat);
    if (r.seat >= 0 && this.droppedSeats.delete(r.seat)) {
      this.emit("seatRestored", { seat: r.seat, peerId: e.id, name: e.name, returning: r.returning });
    }
  }

  // ---- host: admission -------------------------------------------------------------------------------------------

  private hostJoin(from: number, m: Extract<RoomMsg, { t: "join" }>): void {
    this.legacyWait.delete(from);
    const pid = isPlayerId(m.pid) ? m.pid : "";
    const existing = this.roster.get(from);
    if (existing && !existing.legacy && (!this.pids.get(from) || this.pids.get(from) === pid)) {
      // rebind: the same peer again (a new link after a drop, or a new host after migration)
      if (pid) this.pids.set(from, pid);
      const was = existing.status;
      this.mutate(() => void (existing.status = "connected"), from);
      this.reconnectUntil.delete(from);
      if (was === "reconnecting" && this.dropFired.delete(from) && this.droppedSeats.delete(existing.seat)) {
        this.emit("seatRestored", { seat: existing.seat, peerId: from, name: existing.name, returning: true });
      }
      this.sendRoom(from, this.snapMsg());
      return;
    }
    this.admitPeer(from, { pid, role: m.role === "spectator" ? "spectator" : "player", password: typeof m.password === "string" ? m.password : "", data: m.data && typeof m.data === "object" ? m.data : {} }, false);
  }

  private admitPeer(from: number, j: { pid: string; role: RoomRole; password: string; data: Record<string, unknown> }, legacy: boolean): void {
    const ip = this.deps.linkAddress(from);
    const entries = [...this.roster.values()];
    // a reconnecting entry of the same player id under another peer id: this peer takes its place
    const dup = j.pid ? entries.find((e) => e.id !== from && this.pids.get(e.id) === j.pid && e.status === "reconnecting") : undefined;
    const counted = entries.filter((e) => e !== dup && e.id !== from);
    const a = admit({
      banned: !!this.bans.match({ id: j.pid || undefined, ip }),
      hasPassword: this.cfg.password !== "",
      passwordOk: this.cfg.password === "" || safeEqual(j.password, this.cfg.password),
      state: this._state,
      lateJoin: this._settings.lateJoin,
      role: j.role,
      players: counted.filter((e) => e.role === "player").length,
      maxPlayers: this._settings.maxPlayers,
      spectators: counted.filter((e) => e.role === "spectator").length,
      spectatorCap: this._settings.spectators,
    });
    if (!a.ok) {
      const reason = removalReason(a.code);
      if (!legacy) this.sendRoom(from, { t: "deny", code: a.code, reason });
      this.deps.removePeer(from, { ban: false, code: a.code, reason });
      return;
    }
    this.mutate((c) => {
      if (dup) {
        this.roster.delete(dup.id);
        this.reconnectUntil.delete(dup.id);
        this.dropFired.delete(dup.id);
        this.pids.delete(dup.id);
        c.gone.push({ id: dup.id, why: "left" });
      }
      const e: RoomEntry = {
        id: from, name: this.nameFor(this.deps.peerName(from) ?? "", from, from), role: a.role, seat: -1, ready: false, status: "connected", data: {},
        ...(legacy ? { legacy: true } : {}),
      };
      let data: Record<string, string> = {};
      for (const [k, v] of Object.entries(j.data)) {
        const r = applyData(this._settings.data, data, { [k]: v }, false);
        if (r.ok) data = r.data;
      }
      e.data = dataDefaults(this._settings.data, data);
      this.roster.set(from, e);
      if (j.pid) this.pids.set(from, j.pid);
      if (a.role === "player") this.giveSeat(e, j.pid);
    }, from);
    if (!legacy) this.sendRoom(from, this.snapMsg());
  }

  private removeEntry(id: number, why: GoneWhy): void {
    const e = this.roster.get(id);
    if (!e) return;
    this.reconnectUntil.delete(id);
    this.mutate((c) => {
      this.roster.delete(id);
      c.gone.push({ id, why });
    });
    if (!this.dropFired.delete(id)) this.fireSeatDropped(e, why, why === "timeout");
    this.pids.delete(id);
  }

  private fireSeatDropped(e: RoomEntry, reason: string, afterWindow: boolean): void {
    if (e.role !== "player" || e.seat < 0 || e.legacy) return;
    this.droppedSeats.add(e.seat);
    this.dropFired.add(e.id);
    this.emit("seatDropped", { seat: e.seat, peerId: e.id, name: e.name, data: { ...e.data }, reason, afterWindow });
  }

  // ---- host: start, countdown, timers ----------------------------------------------------------------------------

  private beginStart(auto: boolean): void {
    if (this._settings.countdownMs <= 0) return this.startNow();
    this.cdSeq += 1;
    this.cdAuto = auto;
    this.nextCd = this.now() + COUNTDOWN_TICK_MS;
    this.mutate(() => {
      this._state = "countdown";
      this.cd = { seq: this.cdSeq, total: this._settings.countdownMs, deadline: this.now() + this._settings.countdownMs };
    });
  }

  private startNow(): void {
    this.mutate(() => {
      this._state = "started";
      this.cd = null;
    });
    this.deps.startGame();
  }

  private cancelStart(reason: string): void {
    if (this._state !== "countdown") return;
    this.mutate((c) => {
      this._state = "lobby";
      this.cd = null;
      c.cancel = reason;
    });
  }

  /** After every change: auto start, and countdown conditions. */
  private evaluate(): void {
    if (!this.hub.isHost || this.closed) return;
    const all = [...this.roster.values()];
    if (this._state === "lobby") {
      if (!this.autoHold && autoStartHolds({ mode: this._settings.autoStart, autoStartPlayers: this._settings.autoStartPlayers, minPlayers: this._settings.minPlayers }, all)) this.beginStart(true);
    } else if (this._state === "countdown") {
      if (this.eligible() < Math.max(1, this._settings.minPlayers)) this.cancelStart("too_few");
      else if (this.cdAuto && !autoStartHolds({ mode: this._settings.autoStart, autoStartPlayers: this._settings.autoStartPlayers, minPlayers: this._settings.minPlayers }, all)) this.cancelStart("condition");
    }
  }

  private hostTick(): void {
    if (this.closed || !this.hub.isHost) return;
    const now = this.now();
    for (const [id, until] of [...this.reconnectUntil]) {
      if (now >= until) {
        this.reconnectUntil.delete(id);
        if (this.roster.get(id)?.status === "reconnecting") this.removeEntry(id, "timeout");
      }
    }
    for (const [id, until] of [...this.legacyWait]) {
      if (now < until) continue;
      this.legacyWait.delete(id);
      const e = this.roster.get(id);
      if (e) {
        // a legacy peer that dropped and resumed
        if (e.legacy && e.status !== "connected") this.mutate(() => void (e.status = "connected"));
      } else if (this.deps.peerIds().includes(id)) {
        this.admitPeer(id, { pid: "", role: "player", password: "", data: {} }, true);
      }
    }
    if (this._state === "countdown" && this.cd) {
      const left = this.cd.deadline - now;
      if (left <= 0) this.startNow();
      else if (now >= this.nextCd) {
        this.nextCd += COUNTDOWN_TICK_MS;
        const m: RoomMsg = { t: "cd", seq: this.cd.seq, left: Math.round(left) };
        for (const p of this.audience()) this.sendRoom(p, m);
        this.emit("countdown", this.view(this.cd));
      }
    }
  }

  // ---- joiner: replica -------------------------------------------------------------------------------------------

  private joinerHandle(m: RoomMsg): void {
    switch (m.t) {
      case "snap":
        this.applySnap(m);
        break;
      case "upd":
        this.applyUpd(m);
        break;
      case "cd": {
        if (this.supported !== true || typeof m.seq !== "number" || typeof m.left !== "number") break;
        const deadline = this.now() + countdownRemaining(m.left, this.deps.rtt() || null);
        if (this.cd && this.cd.seq === m.seq) this.cd = { ...this.cd, deadline };
        else this.cd = { seq: m.seq, total: m.left, deadline };
        this.emit("countdown", this.view(this.cd));
        break;
      }
      case "deny": {
        const code = typeof m.code === "string" && CODE_PATTERN.test(m.code) ? m.code : "kicked";
        const reason = removalReason(code, typeof m.reason === "string" ? m.reason : "");
        this.onRemoved({ code, reason, ban: false });
        this.deps.reportError(new OneLobbyError(code, reason));
        break;
      }
      case "nack":
        if (typeof m.code === "string") this.emit("rejected", m.code, String(m.re ?? ""), m.key);
        break;
    }
  }

  private applySnap(m: Extract<RoomMsg, { t: "snap" }>): void {
    if (!Array.isArray(m.players) || typeof m.rev !== "number" || !m.settings) return;
    const before = this.snapshot();
    const first = this.supported !== true;
    this.supportTimer?.();
    this.supportTimer = null;
    this.supported = true;
    this.roster = new Map(m.players.map((e) => [e.id, clone(e)]));
    this._state = m.state;
    this._settings = clone(m.settings);
    this.setCd(m.countdown);
    this.rev = m.rev;
    if (first) this.emit("supported");
    this.emitChanges(before, [], undefined, first);
  }

  private applyUpd(m: Extract<RoomMsg, { t: "upd" }>): void {
    if (this.supported !== true || typeof m.rev !== "number") return;
    if (m.rev <= this.rev) return;
    if (m.rev !== this.rev + 1) return this.resync();
    const before = this.snapshot();
    for (const e of m.players ?? []) this.roster.set(e.id, clone(e));
    const gone = (m.gone ?? []).filter((g) => typeof g.id === "number");
    for (const g of gone) this.roster.delete(g.id);
    if (m.state) this._state = m.state;
    if (m.settings) this._settings = clone(m.settings);
    if ("countdown" in m) this.setCd(m.countdown ?? null);
    this.rev = m.rev;
    this.emitChanges(before, gone, typeof (m as { cancel?: unknown }).cancel === "string" ? (m as { cancel: string }).cancel : undefined);
  }

  private setCd(c: CountdownInfo | null | undefined): void {
    this.cd = c ? { seq: c.seq, total: c.total, deadline: this.now() + countdownRemaining(c.left, this.deps.rtt() || null) } : null;
  }

  private resync(): void {
    const now = this.now();
    if (now - this.lastResync < RESYNC_GAP_MS) return;
    this.lastResync = now;
    this.sendToHost({ t: "resync" });
  }

  // ---- events from a diff ----------------------------------------------------------------------------------------

  private emitChanges(before: View, gone: { id: number; why: GoneWhy }[], cancel?: string, quiet = false): void {
    const after = this.snapshot();
    const whys = new Map(gone.map((g) => [g.id, g.why]));
    let any = false;
    for (const [id, e] of after.objs) {
      const old = before.objs.get(id);
      if (!old) {
        any = true;
        this.emit("playerJoined", clone(e));
      } else if (before.entries.get(id) !== after.entries.get(id)) {
        any = true;
        this.emit("playerChanged", clone(e), entryKeys(old, e));
      }
    }
    for (const [id, old] of before.objs) {
      if (after.objs.has(id)) continue;
      any = true;
      this.emit("playerLeft", { ...clone(old), status: "left" }, whys.get(id) ?? "left");
    }
    if (after.settings !== before.settings) {
      any = true;
      this.emit("settingsChanged", this.settings);
    }
    if (after.state !== before.state) {
      any = true;
      this.emit("stateChanged", after.state, before.state);
      if (after.state === "started") this.emit("started");
      if (after.state === "lobby") this.emit("backToLobby");
    }
    if (after.cdSeq !== before.cdSeq) {
      any = true;
      if (this.cd) this.emit("countdown", this.view(this.cd));
      else if (before.cdSeq !== 0 && after.state !== "started") this.emit("countdownCancelled", cancel ?? "host");
    }
    if (after.allReady !== before.allReady) {
      any = true;
      this.emit("allReadyChanged", after.allReady);
    }
    this.lastAllReady = after.allReady;
    if (any || quiet) this.emit("changed");
  }
}
