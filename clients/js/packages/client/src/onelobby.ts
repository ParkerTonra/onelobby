import { systemClock, type Clock } from "./clock.js";
import { Emitter } from "./emitter.js";
import { normalizeCode } from "./crockford.js";
import { Lobby, type RateLimit, type RoomSetup } from "./lobby.js";
import { BanList } from "./bans.js";
import type { RoomJoinOptions, RoomOptions } from "./room.js";
import { fileStore, loadPlayerId, localStore, memoryStore, type KeyValueStore } from "./storage.js";
import {
  OneLobbyError,
  PROTO_ID,
  SignalingClient,
  type LobbyState,
  type LobbySummary,
  type WelcomeMsg,
} from "./signaling.js";
import {
  defaultSocketFactory,
  hasTurn,
  type IceServer,
  type LinkFactory,
  type SocketFactory,
} from "./transport.js";
import type { VoiceCodec, FrameSource, AudioSink } from "./voice-types.js";
import { WebAudioSink, WorkletMic, webCodecsOpus, webCodecsOpusAvailable } from "./voice-browser.js";
import { webRtcLinkFactory } from "./webrtc.js";
import { decodeJoinCode, encodeJoinCode, encodeRoomCodeFor, looksLikeJoinCode } from "./joincode.js";
import { NostrSocket } from "./nostr/socket.js";
import { DEFAULT_NOSTR_STUN, type RelayConnect } from "./nostr/relays.js";
import { DEFAULT_DIRECT_PORT, loopbackBindAddress, parseDirectAddress } from "./direct-address.js";
import { BlueprintError, parseBlueprint, type Blueprint } from "./blueprint.js";
import { hostNostr, type BrowserHostOptions } from "./direct/browser-host.js";
import { diagnose, type DiagnoseFacts, type Reached } from "./diagnose.js";
import { NetLog, maskText, netLogEnvPath } from "./netlog.js";
import { LanFinder, type LanFinderOptions } from "./lan.js";
import { checkConnection, probeRelay, type CheckOptions, type CheckResult } from "./connection-check.js";
import { PlayerSettings, RELAY_SKIPPED_WARNING, cleanLastCode, cleanName, redactUrl, type EnvSource, type SettingsUse } from "./settings.js";

export const LIB_NAME = "onelobby";
export const LIB_VERSION = "0.8.1";

/** Where `rememberSeat` keeps the resume token: the subset of the Web Storage API it uses. */
export interface SeatStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Seams for tests, adapters and non-browser runtimes. Every default is the browser implementation. */
export interface AdvancedOptions {
  socketFactory?: SocketFactory;
  linkFactory?: LinkFactory;
  clock?: Clock;
  /** Wall clock in unix ms, stamps chat lines. */
  wallClock?: () => number;
  /** Opus codec; defaults to WebCodecs when available. Provide a WASM-backed one elsewhere. */
  voiceCodec?: VoiceCodec | null;
  createMic?: (() => FrameSource) | null;
  createSink?: (() => AudioSink) | null;
  /** Storage for `rememberSeat`; defaults to `sessionStorage` when the page has one. null disables it. */
  storage?: SeatStorage | null;
  /** WebSocket to a Nostr relay (default: the runtime's `WebSocket`); for Node older than 22 or tests. */
  nostrConnect?: RelayConnect;
  /**
   * Where the per-install player id is kept (spec/room.md s.1). Default: `playerIdFile` when given, else `localStorage`
   * where the page has one, else memory (the id then lasts one process).
   */
  playerIdStore?: KeyValueStore | null;
  /** Where the host's ban list is kept (spec/room.md s.5.3). Default: `banFile` when given, else `localStorage`, else memory. */
  banStore?: KeyValueStore | null;
  /**
   * Where the player's settings are kept (spec/settings.md s.2). Default: `settingsFile` when given, else `localStorage`
   * where the page has one, else memory.
   */
  settingsStore?: KeyValueStore | null;
  /** The environment variables that override the saved settings (default: the Node process environment, none in a browser; null: none). */
  env?: EnvSource | null;
}

/** Diagnostics switches (spec/diagnostics.md): the net log, the report to the host, the relay probe. All have working defaults. */
export interface DiagnosticsOptions {
  /** Net log ring size, 50 to 5000 (default 500). */
  logSize?: number;
  /**
   * Node: where the masked log is written when the process exits or dies from an uncaught error, and where
   * `kit.netLog.save()` writes by default. Without it the log stays in memory.
   */
  logPath?: string;
  /**
   * A joiner whose link to the host fails tells that host why (cause, stage, how long, whether a relay was set; never an
   * address) over the signaling path. Default true; false sends nothing.
   */
  reportToHost?: boolean;
  /** Tells a refused relay login from a silent relay when ICE gathered no relay candidate (default: a raw TURN probe where UDP sockets exist; null: off). */
  relayProbe?: ((entry: IceServer) => Promise<"ok" | "refused" | "unreachable" | "unknown">) | null;
}

export interface OneLobbyOptions {
  gameId: string;
  netVersion: string;
  /** `ws://` / `wss://` URL of a onelobby-server. */
  lobbyServer: string;
  mode?: "lockstep" | "raw";
  tickRate?: number;
  /** Default: tickRate (once a second). */
  hashEveryTicks?: number;
  /** The player's name. Empty (the default): other players see "Player N", N being the seat number. */
  displayName?: string;
  relayOnly?: boolean;
  /**
   * Joiners give up on reaching the host after this many ms: `lobby.ready` rejects with code `ice_failed`, the kit
   * emits `error`, and the lobby is left. Half the time goes to a relay-only retry when the server offers TURN.
   * Default 15000; 0 waits forever.
   */
  readyTimeoutMs?: number;
  /**
   * Treat a peer as gone after this many ms of silence. Joiners ping the host every 2 s and the host answers, so the
   * host drops a silent joiner (`peerLeft`, "timeout") and a joiner handles a silent host as lost (a direct lobby
   * ends with "host_left"). Default 0 (off): a silently dead peer then surfaces when its link or signaling socket
   * times out, within about 30 s. Values under 6000 are raised to 6000.
   */
  peerTimeoutMs?: number;
  /**
   * Keep this tab's seat across a page reload (sessionStorage): `join(code)` and `resume()` take the seat back
   * instead of joining as a new player. Cleared when the session ends. Default true where sessionStorage exists.
   */
  rememberSeat?: boolean;
  /**
   * Node and other runtimes without `localStorage`: a JSON file path that keeps the per-install player id across runs.
   * It is a random id made once, not an account or a hardware id (spec/room.md s.1).
   */
  playerIdFile?: string;
  /** Node: a JSON file path that keeps the host's ban list across lobbies and runs (spec/room.md s.5.3). */
  banFile?: string;
  /**
   * The player's saved settings (name, relay line, last code, lobby server: spec/settings.md) are applied as defaults and
   * `lobbyServer` / `displayName` here win over them. `false` switches all of it off; `{ relay: false }` one default.
   */
  settings?: false | SettingsUse;
  /** Node: a JSON file path that keeps the player's settings across runs (the key/value file of `playerIdFile`). */
  settingsFile?: string;
  /** @internal `fromConfig`: the blueprint's rules for a saved name. */
  nameRules?: { max: number; allowed: boolean };
  /** The room layer's defaults for every lobby this kit hosts (`onelobby.json` `room` fills the same); `host()` options win. */
  room?: RoomOptions;
  /** The net log, the report to the host and the relay probe (see DiagnosticsOptions). */
  diagnostics?: DiagnosticsOptions;
  /** Test and runtime seams (see AdvancedOptions). */
  advanced?: AdvancedOptions;

  /** @deprecated use `advanced.socketFactory` */
  socketFactory?: SocketFactory;
  /** @deprecated use `advanced.linkFactory` */
  linkFactory?: LinkFactory;
  /** @deprecated use `advanced.clock` */
  clock?: Clock;
  /** @deprecated use `advanced.wallClock` */
  wallClock?: () => number;
  /** @deprecated use `advanced.voiceCodec` */
  voiceCodec?: VoiceCodec | null;
  /** @deprecated use `advanced.createMic` */
  createMic?: (() => FrameSource) | null;
  /** @deprecated use `advanced.createSink` */
  createSink?: (() => AudioSink) | null;
}

/** Per-launch settings for `OneLobby.fromConfig`; everything else comes from the blueprint. */
export interface FromConfigOverrides {
  /** The player's name. Checked against `players.identity` and `players.maxNameLength`. */
  displayName?: string;
  /** Wins over `hosting.lobbyServer` (the file is the bottom layer: put `?lobby=` / storage / `<meta>` lookups here). */
  lobbyServer?: string;
  /** Default: `lobby.rejoin` from the file. */
  rememberSeat?: boolean;
  advanced?: AdvancedOptions;
}

export interface HostOptions {
  name: string;
  maxPlayers: number;
  /**
   * "unlisted" (default): anyone with the code or link can join, but the lobby is not in `list()`.
   * "public": also listed. "private": the host approves each join.
   */
  visibility?: "public" | "unlisted" | "private";
  lateJoin?: boolean;
  meta?: Record<string, string>;
  /** Per-joiner cap on incoming raw messages, e.g. `{ messages: 60, perMs: 1000 }`; the excess is dropped before `message` fires or is relayed. */
  rateLimit?: RateLimit;
  /**
   * Joiners must give this password (at most 64 characters) or get `bad_password`: the hub checks it when it knows
   * (`welcome.features` has "room"), and the host's room layer checks it on every route (spec/room.md s.6).
   */
  password?: string;
  /** Room layer settings: ready, countdown, auto start, spectators, late join policy, per-player data (`RoomOptions`). */
  room?: RoomOptions;
}

/** What a joiner brings to `join()`. */
export interface JoinOptions extends RoomJoinOptions {
  /** The lobby's password, if it has one; a wrong one fails with `bad_password`. */
  password?: string;
}

export interface ListOptions {
  meta?: Record<string, string>;
  limit?: number;
  cursor?: string;
}

export interface JoinDirectOptions {
  /** The host's password, if it set one; a wrong one fails with `bad_password`. */
  password?: string;
  /** Join as a spectator instead of a player (when the host allows spectators). */
  role?: "player" | "spectator";
  /** Your starting per-player data (colour, avatar, team, game keys); the host validates it (spec/room.md s.4.2). */
  data?: Record<string, string>;
  /** Port for an address typed without one (default 47810, docs/design/direct-ip.md s.2). */
  defaultPort?: number;
  /** No answer on the host's TCP port within this long fails with `direct_unreachable` (default 5000). */
  connectTimeoutMs?: number;
  /** Nostr relays for a Nostr code (version 1); default the blueprint's `hosting.nostrRelays`, else the library list. */
  nostrRelays?: string[];
  /** STUN servers for a Nostr code when the host offers none; default Google's and Cloudflare's public ones. */
  stun?: string[];
  /**
   * Extra ICE servers (a TURN relay), added to the list the host's `welcome` offers (the host's own `iceServers` reach every
   * joiner already). For a joiner behind a strict NAT whose host gave none. See spec/nostr-signaling.md s.5.
   */
  iceServers?: IceServer[];
}

/** Where a direct join goes: a host address (TCP) or a Nostr room. */
interface DirectTarget {
  /** The display form of the version 1 code, or null for an address. */
  nostr: string | null;
  url: string;
  joinedWith: string;
  links: LinkFactory;
}

/** @internal How onelobby/direct makes a host lobby: its own socket and link factory, and direct mode. */
export interface DirectLobbyHooks {
  socketFactory: SocketFactory;
  /** Wraps the kit's own link factory (port pin, no ICE servers). */
  wrapLinks: (inner: LinkFactory) => LinkFactory;
}

/** `warning`: a plain sentence for the player (a saved relay line that is skipped); it never holds a credential. */
export type OneLobbyEvents = { error: [Error]; warning: [string] };

export const DEFAULT_READY_TIMEOUT_MS = 15_000;

function hasMic(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== "undefined";
}

function browserStorage(): SeatStorage | null {
  try {
    const s = (globalThis as { sessionStorage?: SeatStorage }).sessionStorage;
    return s ?? null;
  } catch {
    return null; // storage access can throw (sandboxed iframe, blocked cookies)
  }
}

type Route = "server" | "ip" | "nostr";

/** The error codes a connect failure carries a diagnosis for (spec/diagnostics.md s.9). */
const DIAGNOSED_CODES = new Set(["connect_failed", "direct_unreachable", "version_mismatch", "server_closed", "closed"]);

function errCode(e: unknown): string {
  return e instanceof OneLobbyError ? e.code : "error";
}

/** `stun,turn` from an ICE list: the kinds only, never a URL or a login. */
function iceKinds(ice: IceServer[]): string {
  const kinds = new Set<string>();
  for (const s of ice) for (const u of Array.isArray(s.urls) ? s.urls : [s.urls]) kinds.add(/^(stuns?|turns?):/i.exec(String(u))?.[1]?.toLowerCase() ?? "other");
  return [...kinds].join(",") || "none";
}

interface Seat {
  code: string;
  token: string;
  server: string;
}

/**
 * Lobbies alive in this page, by resume token. A remembered seat that is still in use here (two kits in one tab,
 * e.g. a local two-player demo) must not be taken over; after a reload this set starts empty.
 */
const liveSeats = new Set<Lobby>();
function seatInUse(token: string): boolean {
  for (const l of liveSeats) if (l.resumeToken === token) return true;
  return false;
}

/** Entry point (DESIGN s.11.2). */
export class OneLobby extends Emitter<OneLobbyEvents> {
  readonly options: Required<Pick<OneLobbyOptions, "gameId" | "netVersion" | "lobbyServer" | "mode" | "tickRate" | "hashEveryTicks" | "displayName" | "relayOnly" | "readyTimeoutMs" | "peerTimeoutMs">>;
  private socketFactory: SocketFactory;
  private linkFactory: LinkFactory;
  private clock: Clock;
  private wall: () => number;
  private voiceCodec: VoiceCodec | null;
  private createMic: (() => FrameSource) | null;
  private createSink: (() => AudioSink) | null;
  private storage: SeatStorage | null;
  private idStore: KeyValueStore | null;
  private banStore: KeyValueStore | null;
  private banList: BanList | null = null;
  /** The player's saved settings (spec/settings.md): `load()`, `effective()`, `save({...})`, `maskedRelay()`. */
  readonly settings: PlayerSettings;
  private readonly settingsUse: Required<SettingsUse>;
  private readonly nameRules: { max: number; allowed: boolean };
  private relayWarned = false;
  private pid: string | null = null;
  private roomOpts: RoomOptions;
  private nostrConnectFn: RelayConnect | undefined;
  private readonly diagOpts: Required<Pick<DiagnosticsOptions, "reportToHost">> & Pick<DiagnosticsOptions, "relayProbe">;
  private lastCheck: CheckResult | null = null;
  /**
   * The net log (spec/diagnostics.md s.5): a ring buffer of connection steps with timings. `kit.netLog.export()` is the
   * text to show under "Copy logs" (addresses masked; `export({ includeAddresses: true })` unmasks addresses only),
   * `save(path?)` writes it (Node), `download()` offers it as a file (browsers). Stays on this machine.
   */
  readonly netLog: NetLog;
  /** The validated, frozen onelobby.json this kit was built from (`OneLobby.fromConfig`); undefined for `new OneLobby`. */
  readonly blueprint?: Blueprint;

  /**
   * Build a kit from an onelobby.json (already parsed; docs/design/blueprint.md s.7). Throws `bad_config` for an
   * invalid file or name, `identity_anonymous` for a name when `players.identity` is "anonymous". Then `host()` and
   * `hostDirect()` default their options from the file and the file's chat/listing switches are enforced.
   */
  static fromConfig(json: unknown, overrides: FromConfigOverrides = {}): OneLobby {
    const bp = parseBlueprint(json);
    const name = (overrides.displayName ?? "").trim();
    if (name) {
      if (bp.players.identity === "anonymous") throw new OneLobbyError("identity_anonymous", "this game uses anonymous players: no display names");
      if (name.length > bp.players.maxNameLength)
        throw new BlueprintError("displayName", "length", `must be at most ${bp.players.maxNameLength} characters`);
    }
    const kit = new OneLobby({
      gameId: bp.game.id,
      netVersion: bp.game.netVersion,
      lobbyServer: overrides.lobbyServer ?? bp.hosting.lobbyServer,
      mode: bp.sync.mode === "lockstep" ? "lockstep" : "raw", // replication rides a raw lobby: build a ReplicationSession on it
      tickRate: bp.sync.tickRate,
      hashEveryTicks: bp.sync.hashEveryTicks,
      displayName: name,
      nameRules: { max: bp.players.maxNameLength, allowed: bp.players.identity !== "anonymous" },
      relayOnly: bp.hosting.relayOnly,
      readyTimeoutMs: bp.session.readyTimeoutMs,
      peerTimeoutMs: bp.session.peerTimeoutMs,
      rememberSeat: overrides.rememberSeat ?? bp.lobby.rejoin,
      room: blueprintRoom(bp),
      diagnostics: { reportToHost: bp.diagnostics.reportToHost, logSize: bp.diagnostics.logSize, ...(bp.diagnostics.relayProbe ? {} : { relayProbe: null }) },
      advanced: overrides.advanced,
    });
    (kit as { blueprint?: Blueprint }).blueprint = bp;
    return kit;
  }

  /** @internal Host options the blueprint implies (empty without one). */
  blueprintHostDefaults(): Partial<HostOptions> {
    const bp = this.blueprint;
    if (!bp) return {};
    const name = this.options.displayName;
    return {
      name: name ? `${name}'s game` : "Game",
      maxPlayers: bp.lobby.maxPlayers,
      visibility: bp.lobby.listed ? "public" : bp.lobby.approveJoins ? "private" : "unlisted",
      lateJoin: bp.lobby.lateJoin,
      meta: { ...bp.lobby.meta },
      ...(bp.session.rateLimit ? { rateLimit: { ...bp.session.rateLimit } } : {}),
    };
  }

  /** The room layer options for a lobby this kit hosts: the kit's (`room`, the blueprint) under the explicit ones. */
  roomOptionsFor(explicit?: RoomOptions): RoomOptions {
    return { ...this.roomOpts, ...definedOnly(explicit), ...(explicit?.data ? { data: { ...(this.roomOpts.data ?? {}), ...explicit.data } } : {}) };
  }

  /**
   * This install's player id for the game (32 hex characters, made once and kept: spec/room.md s.1). It is sent in
   * `hello` so hubs can refuse banned ids and hosts can keep a player's seat. Not an account or a hardware id.
   */
  get playerId(): string {
    return (this.pid ??= loadPlayerId(this.idStore, this.options.gameId));
  }

  /** The host-side ban list (also `lobby.room.bans`): persistent per game, see `banFile` and `advanced.banStore`. */
  get bans(): BanList {
    return (this.banList ??= new BanList(this.banStore, this.options.gameId));
  }

  constructor(o: OneLobbyOptions) {
    super();
    const self = this;
    const tickRate = o.tickRate ?? 20;
    const explicitServer = o.lobbyServer ?? "";
    const explicitName = (o.displayName ?? "").trim();
    // what the player saved fills in only what the game left empty; read on every use, so a new setting counts at once
    this.options = {
      gameId: o.gameId,
      netVersion: o.netVersion,
      get lobbyServer(): string {
        return explicitServer || self.savedServer();
      },
      mode: o.mode ?? "lockstep",
      tickRate,
      hashEveryTicks: o.hashEveryTicks ?? tickRate,
      get displayName(): string {
        return explicitName || self.savedName();
      },
      relayOnly: o.relayOnly ?? false,
      readyTimeoutMs: o.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      peerTimeoutMs: o.peerTimeoutMs ?? 0,
    };
    const a = o.advanced ?? {};
    const pick = <K extends keyof AdvancedOptions & keyof OneLobbyOptions>(k: K) => (a[k] !== undefined ? a[k] : o[k]);
    this.socketFactory = pick("socketFactory") ?? defaultSocketFactory;
    this.linkFactory = pick("linkFactory") ?? webRtcLinkFactory;
    this.clock = pick("clock") ?? systemClock;
    this.wall = pick("wallClock") ?? (() => Date.now());
    const codec = pick("voiceCodec");
    this.voiceCodec = codec !== undefined ? codec : webCodecsOpusAvailable() ? webCodecsOpus : null;
    const mic = pick("createMic");
    this.createMic = mic !== undefined ? mic : hasMic() ? () => new WorkletMic() : null;
    const sink = pick("createSink");
    this.createSink = sink !== undefined ? sink : typeof AudioContext !== "undefined" ? () => new WebAudioSink() : null;
    this.nostrConnectFn = a.nostrConnect;
    this.storage = o.rememberSeat === false ? null : a.storage !== undefined ? a.storage : browserStorage();
    const fallback = () => localStore() ?? memoryStore();
    this.idStore = a.playerIdStore !== undefined ? a.playerIdStore : o.playerIdFile ? fileStore(o.playerIdFile) : fallback();
    this.banStore = a.banStore !== undefined ? a.banStore : o.banFile ? fileStore(o.banFile) : fallback();
    const settingsStore = a.settingsStore !== undefined ? a.settingsStore : o.settingsFile ? fileStore(o.settingsFile) : fallback();
    this.settings = new PlayerSettings(settingsStore, o.gameId, a.env);
    const use = o.settings === false ? { name: false, relay: false, server: false, lastCode: false } : (o.settings ?? {});
    this.settingsUse = { name: use.name !== false, relay: use.relay !== false, server: use.server !== false, lastCode: use.lastCode !== false };
    this.nameRules = o.nameRules ?? { max: 24, allowed: true };
    this.roomOpts = { ...(o.room ?? {}) };
    const dg = o.diagnostics ?? {};
    this.diagOpts = { reportToHost: dg.reportToHost !== false, relayProbe: dg.relayProbe === undefined ? (s) => probeRelay(s) : dg.relayProbe };
    const proc = (globalThis as { process?: { platform?: string; arch?: string; versions?: { node?: string } } }).process;
    const asked = netLogEnvPath(); // ONELOBBY_NETLOG: this copy's own file, written line by line (wins over diagnostics.logPath)
    this.netLog = new NetLog({
      capacity: dg.logSize,
      clock: this.clock,
      path: asked ?? dg.logPath,
      live: asked !== null,
      storageKey: `onelobby.netlog.${o.gameId}`,
      meta: { client: `${LIB_NAME}-js ${LIB_VERSION}`, protocol: PROTO_ID, platform: proc?.versions?.node ? `node ${proc.platform ?? ""} ${proc.arch ?? ""}`.trim() : "browser" },
    });
    if (asked ?? dg.logPath) this.netLog.flushOnExit((asked ?? dg.logPath)!);
    this.netLog.add("info", `client ${LIB_NAME}-js ${LIB_VERSION} protocol ${PROTO_ID} game version ${o.netVersion}`);
  }

  // ---- saved settings (spec/settings.md s.5) -------------------------------------------------------------------------

  private savedName(): string {
    return this.settingsUse.name && this.nameRules.allowed ? cleanName(this.settings.effective().name, this.nameRules.max) : "";
  }

  private savedServer(): string {
    return this.settingsUse.server ? this.settings.effective().server : "";
  }

  /** This player's ICE list: `ice` (the host's `welcome` list) then the saved relay entry, unless it is already there. */
  private iceWithSettings(ice: IceServer[]): IceServer[] {
    if (!this.settingsUse.relay) return ice;
    const { entry, invalid } = this.settings.relayStatus();
    if (invalid && !this.relayWarned) {
      this.relayWarned = true;
      this.netLog.add("info", RELAY_SKIPPED_WARNING);
      this.emit("warning", RELAY_SKIPPED_WARNING);
    }
    if (!entry) return ice;
    const same = (e: IceServer) => [e.urls].flat().join(",") === [entry.urls].flat().join(",") && e.username === entry.username && e.credential === entry.credential;
    return ice.some(same) ? ice : [...ice, entry];
  }

  /** @internal Saves the code of a lobby this player hosted or joined as `lastCode` (a code that does not clean is not saved). */
  rememberCode(code: string): void {
    if (!this.settingsUse.lastCode) return;
    const c = cleanLastCode(code);
    if (c) this.settings.save({ lastCode: c });
  }

  /**
   * A finder for LAN games (spec/lan-discovery.md): `start()` asks the local network, `games` is the list, `on("changed")`
   * fires when it changes, `stop()` closes its socket. Nothing is opened before `start()`. With a blueprint whose
   * `hosting.lan` is false the finder stays off (`status` "off"); in a browser `status` is "browser". Options: `targets`
   * (default: the broadcast addresses; a test passes `["127.0.0.1"]`), `port`.
   */
  lanFinder(options: Partial<Omit<LanFinderOptions, "gameId" | "netVersion">> = {}): LanFinder {
    return new LanFinder({
      gameId: this.options.gameId,
      netVersion: this.options.netVersion,
      enabled: this.blueprint ? this.blueprint.hosting.lan : true,
      log: (line) => this.netLog.add("info", line),
      ...options,
    });
  }

  /**
   * Checks what this network allows (spec/diagnostics.md s.8): whether UDP gets out, the NAT type (two STUN servers from
   * one socket), and whether a relay takes its login. Contacts only the STUN servers it is given (default: the ones the
   * client connects with) and the TURN entry in `iceServers`. A menu runs it on demand; the library never does. The
   * result's `message` is one plain line ("Direct connections: likely to fail. A relay is recommended."); the kit
   * remembers it so a later failure diagnosis and the report to the host use the NAT type.
   */
  async checkConnection(options: CheckOptions = {}): Promise<CheckResult> {
    const r = await checkConnection(options);
    this.lastCheck = r;
    this.netLog.add("info", `connection check udp=${r.udp} nat=${r.natType} relay=${r.relay} verdict=${r.verdict}`);
    return r;
  }

  // ---- remembered seat -------------------------------------------------------------------------------------------

  private get seatKey(): string {
    return `onelobby.seat.${this.options.gameId}`;
  }

  private loadSeat(): Seat | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(this.seatKey);
      if (!raw) return null;
      const s = JSON.parse(raw) as Partial<Seat>;
      if (typeof s.code !== "string" || typeof s.token !== "string" || s.server !== this.options.lobbyServer) return null;
      return s as Seat;
    } catch {
      return null;
    }
  }

  private saveSeat(code: string, token: string): void {
    if (!this.storage || !token) return;
    try {
      this.storage.setItem(this.seatKey, JSON.stringify({ code, token, server: this.options.lobbyServer } satisfies Seat));
    } catch {
      /* quota or blocked storage: the seat just is not remembered */
    }
  }

  private clearSeat(code?: string): void {
    if (!this.storage) return;
    try {
      if (code !== undefined) {
        const s = this.loadSeat();
        if (s && s.code !== code) return;
      }
      this.storage.removeItem(this.seatKey);
    } catch {
      /* ignore */
    }
  }

  /** The lobby code of the seat this tab can take back (rememberSeat), or null. */
  get rememberedCode(): string | null {
    return this.loadSeat()?.code ?? null;
  }

  /**
   * Take back the seat remembered from before a page reload (host or joiner). Resolves null when there is none
   * or the server no longer holds it (the seat is forgotten then).
   */
  async resume(): Promise<Lobby | null> {
    const seat = this.loadSeat();
    if (!seat || seatInUse(seat.token)) return null;
    try {
      return await this.rejoin(seat.token);
    } catch (e) {
      if (e instanceof OneLobbyError && e.code === "invalid_token") {
        this.clearSeat();
        return null;
      }
      throw e;
    }
  }

  // ---- connecting ------------------------------------------------------------------------------------------------

  private helloMsg(resumeToken?: string): Record<string, unknown> {
    return {
      t: "hello",
      proto: PROTO_ID,
      gameId: this.options.gameId,
      netVersion: this.options.netVersion,
      client: { lib: LIB_NAME, ver: LIB_VERSION, platform: typeof navigator !== "undefined" ? "browser" : "node" },
      name: this.options.displayName.slice(0, 24),
      playerId: this.playerId,
      ...(resumeToken ? { resumeToken } : {}),
    };
  }

  private async connect(url = this.options.lobbyServer, factory = this.socketFactory, timeoutMs = 0, route: Route = "server"): Promise<{ sig: SignalingClient; welcome: WelcomeMsg }> {
    const t0 = this.clock.now();
    this.netLog.add("sig", `open route=${route}`, { addr: maskText(redactUrl(url), true) });
    let sig: SignalingClient;
    try {
      sig = await this.open(url, factory, timeoutMs);
    } catch (e) {
      this.netLog.add("error", errCode(e), { code: errCode(e) });
      throw this.diagnosed(e, route, "none", t0);
    }
    this.netLog.add("sig", "socket open, hello sent");
    try {
      const welcome = await sig.request<WelcomeMsg & { t: string }>(this.helloMsg(), "welcome");
      this.netLog.add("sig", `welcome features=${(welcome.features ?? []).join(",") || "none"} ice=${iceKinds(welcome.ice ?? [])}`);
      return { sig, welcome };
    } catch (e) {
      sig.close();
      this.netLog.add("error", errCode(e), { code: errCode(e) });
      throw this.diagnosed(e, route, "signaling", t0);
    }
  }

  /**
   * Puts the diagnosis on a connect failure (`error.diagnosis`; the code is unchanged), logs it, and returns the same
   * error. Errors that are not about reaching or matching the host pass through untouched.
   */
  private diagnosed(e: unknown, route: Route, reached: Reached, t0: number, extra: { relaysUp?: boolean | null; versions?: { mine: string; theirs: string } | null } = {}): unknown {
    if (!(e instanceof OneLobbyError) || e.diagnosis || !DIAGNOSED_CODES.has(e.code)) return e;
    const facts: DiagnoseFacts = {
      side: "joiner", route, error: e.code, reached,
      elapsedMs: Math.max(0, Math.round(this.clock.now() - t0)),
      versions: extra.versions ?? null, relaysUp: extra.relaysUp ?? null,
      stun: false, relay: "none", local: [], remote: [], retried: false, nat: "unknown", heard: null,
    };
    e.diagnosis = diagnose(facts);
    this.netLog.add("diag", `cause ${e.diagnosis.cause} stage ${e.diagnosis.stage} after ${facts.elapsedMs} ms`);
    return e;
  }

  /** `diagnosed` for a refused join: a version mismatch names both versions. */
  private diagnosedJoin(e: unknown, route: Route, t0: number): unknown {
    if (e instanceof OneLobbyError && e.code === "version_mismatch") {
      const d = e.data ?? {};
      const mine = typeof d.yourNetVersion === "string" ? d.yourNetVersion : this.options.netVersion;
      const theirs = typeof d.hostNetVersion === "string" ? d.hostNetVersion : "";
      return this.diagnosed(e, route, "signaling", t0, { versions: theirs ? { mine, theirs } : null });
    }
    return e;
  }

  /** The signaling socket only (no hello yet); with a timeout (direct IP), no answer is `direct_unreachable`. */
  private async open(url: string, factory: SocketFactory, timeoutMs: number): Promise<SignalingClient> {
    if (!url.trim() && factory === defaultSocketFactory) throw new OneLobbyError("no_server", "no lobby server address (set hosting.lobbyServer or pass lobbyServer)");
    const sig = new SignalingClient(url, factory, this.clock);
    if (timeoutMs > 0) {
      let cancel = () => {};
      const timeout = new Promise<never>((_, reject) => {
        cancel = this.clock.setTimeout(() => reject(new OneLobbyError("direct_unreachable", `no answer from ${url} within ${timeoutMs} ms`)), timeoutMs);
      });
      try {
        await Promise.race([sig.connect(), timeout]);
      } catch (e) {
        sig.close();
        if (e instanceof OneLobbyError && e.code === "connect_failed") throw new OneLobbyError("direct_unreachable", `no answer from ${url}`);
        throw e;
      } finally {
        cancel();
      }
    } else await sig.connect();
    return sig;
  }

  private makeLobby(sig: SignalingClient, welcome: WelcomeMsg, state: LobbyState, direct?: { links: LinkFactory }, rateLimit?: RateLimit, room?: RoomSetup, route: Route = "server"): Lobby {
    const lobby = new Lobby({
      signaling: sig,
      state,
      ice: this.iceWithSettings(welcome.ice ?? []),
      features: welcome.features ?? [],
      links: direct?.links ?? this.linkFactory,
      direct: !!direct,
      clock: this.clock,
      wall: this.wall,
      hashEveryTicks: this.options.hashEveryTicks,
      relayOnly: state.relayOnly ?? this.options.relayOnly,
      displayName: this.options.displayName,
      voice: { codec: this.voiceCodec, createSource: this.createMic, createSink: this.createSink },
      readyTimeoutMs: this.options.readyTimeoutMs,
      peerTimeoutMs: this.options.peerTimeoutMs,
      rateLimit,
      gameId: this.options.gameId,
      diag: { log: this.netLog, route, reportToHost: this.diagOpts.reportToHost, clientVersion: LIB_VERSION, lastCheck: () => this.lastCheck, probeRelay: this.diagOpts.relayProbe ?? null },
      room: { pid: this.playerId, bans: this.bans, ...(state.you === state.hostId ? { options: this.roomOptionsFor() } : {}), ...room },
    });
    lobby.errorSink = (e) => this.emit("error", e);
    if (this.blueprint) guardLobby(lobby, this.blueprint);
    if (this.storage && !direct) {
      liveSeats.add(lobby);
      this.saveSeat(lobby.code, lobby.resumeToken);
      lobby.seatSink = (token) => this.saveSeat(lobby.code, token);
      lobby.on("sessionEnded", () => {
        liveSeats.delete(lobby);
        this.clearSeat(lobby.code);
      });
    }
    return lobby;
  }

  /** With a blueprint (`fromConfig`) every option defaults from `lobby.*`; explicit options win. */
  async host(opts?: Partial<HostOptions>): Promise<Lobby> {
    const h = { name: "Game", maxPlayers: 4, ...this.blueprintHostDefaults(), ...definedOnly(opts) } as HostOptions;
    const room = this.checkRoomHost(h);
    const { sig, welcome } = await this.connect();
    try {
      const roomHub = (welcome.features ?? []).includes("room");
      const spectators = room.spectators ?? 0;
      const limit = welcome.limits?.maxPlayers ?? 64;
      if (h.maxPlayers + spectators > (roomHub ? 250 : limit)) throw new RangeError(`maxPlayers + spectators is more than the hub allows (${roomHub ? 250 : limit})`);
      const state = await sig.request<LobbyState>(
        {
          t: "create",
          name: h.name,
          // a hub without the room feature has no spectator slots: it gets the sum as its capacity and the room splits it
          maxPlayers: roomHub ? h.maxPlayers : h.maxPlayers + spectators,
          visibility: h.visibility ?? "unlisted",
          mode: this.options.mode,
          tickRate: this.options.tickRate,
          lateJoin: room.lateJoin !== undefined ? room.lateJoin !== "refuse" : (h.lateJoin ?? true),
          meta: h.meta ?? {},
          ...(this.options.relayOnly ? { relayOnly: true } : {}),
          ...(roomHub && h.password ? { password: h.password } : {}),
          ...(roomHub && spectators > 0 ? { spectators } : {}),
        },
        "lobby",
      );
      const lobby = this.makeLobby(sig, welcome, state, undefined, h.rateLimit, { options: room, password: h.password ?? "", maxPlayers: h.maxPlayers });
      this.rememberCode(lobby.code);
      return lobby;
    } catch (e) {
      sig.close();
      throw e;
    }
  }

  /** The room options of a host call, checked: `password_required` and the password length. */
  private checkRoomHost(h: HostOptions): RoomOptions {
    const room = this.roomOptionsFor(h.room);
    if (room.passwordRequired && !h.password) throw new OneLobbyError("password_required", "this game requires a lobby password (room.passwordRequired); pass `password`");
    if (h.password !== undefined && (typeof h.password !== "string" || h.password.length > 64)) throw new RangeError("password must be a string of at most 64 characters");
    return room;
  }

  async join(code: string, opts: JoinOptions = {}): Promise<Lobby> {
    const norm = normalizeCode(code);
    if (!norm) throw new OneLobbyError("bad_code", `"${code}" is not a valid join code`);
    const seat = this.loadSeat();
    if (seat && seat.code === norm && !seatInUse(seat.token)) {
      // Same tab, same lobby (a page reload): take the old seat back instead of joining as a new player.
      try {
        return await this.rejoin(seat.token);
      } catch (e) {
        this.clearSeat();
        if (!(e instanceof OneLobbyError && e.code === "invalid_token")) throw e;
      }
    }
    const t0 = this.clock.now();
    const { sig, welcome } = await this.connect();
    try {
      const state = await sig.request<LobbyState>({ t: "join", code: norm, ...(opts.password ? { password: opts.password } : {}) }, "lobby");
      const lobby = this.makeLobby(sig, welcome, state, undefined, undefined, { join: joinSetup(opts) });
      this.rememberCode(norm);
      return lobby;
    } catch (e) {
      sig.close();
      this.netLog.add("error", errCode(e), { code: errCode(e) });
      throw this.diagnosedJoin(e, "server", t0);
    }
  }

  /**
   * Join a direct-IP host (docs/design/direct-ip.md): a join code from the host's screen (`6B01-RGFE-P2B`, any case, spaces
   * or hyphens) or, advanced, an address (`ip`, `ip:port`, `[v6]:port`). No lobby server is involved: the code is
   * the host's address. A mistyped code fails at once with `bad_code`; nobody listening is `direct_unreachable`.
   * The address is also given to ICE as the host's UDP candidate. When the host leaves, `sessionEnded("host_left")`.
   */
  async joinDirect(codeOrAddress: string, opts: JoinDirectOptions = {}): Promise<Lobby> {
    const t = this.directTarget(codeOrAddress, opts);
    const t0 = this.clock.now();
    const { sig, welcome } = await this.connectDirect(t, opts);
    try {
      const state = await sig.request<LobbyState>({ t: "join", ...(opts.password ? { password: opts.password } : {}) }, "lobby");
      const lobby = this.makeLobby(sig, this.withStun(welcome, t, opts), state, { links: t.links }, undefined, { join: joinSetup(opts) }, t.nostr ? "nostr" : "ip");
      // a joiner's joinCode is what it joined with (normalized), so a HUD can show it on both sides
      lobby.joinCode = t.joinedWith;
      this.rememberCode(t.joinedWith);
      return lobby;
    } catch (e) {
      sig.close();
      this.netLog.add("error", errCode(e), { code: errCode(e) });
      throw this.diagnosedJoin(e, t.nostr ? "nostr" : "ip", t0);
    }
  }

  /**
   * Take a direct-IP seat back after a drop or a restart: the code (or address) joined before and that lobby's
   * `resumeToken` (save it after every join; it changes on each resume). The host keeps a dropped seat for 60 s and the
   * same peer id comes back. Rejects with `invalid_token` when the seat is gone: offer `joinDirect` then.
   */
  async rejoinDirect(codeOrAddress: string, resumeToken: string, opts: JoinDirectOptions = {}): Promise<Lobby> {
    const t = this.directTarget(codeOrAddress, opts);
    const lobby = await this.resumeAt(resumeToken, t.url, t.nostr ? 0 : opts.connectTimeoutMs ?? 5000, { links: t.links }, t.nostr ? this.nostrFactory(t, opts) : undefined, (w) => this.withStun(w, t, opts));
    lobby.joinCode = t.joinedWith;
    return lobby;
  }

  private nostrFactory(t: DirectTarget, opts: JoinDirectOptions): SocketFactory {
    const relays = opts.nostrRelays ?? (this.blueprint ? [...this.blueprint.hosting.nostrRelays] : undefined);
    return () =>
      new NostrSocket({ code: t.nostr!, relays: relays && relays.length > 0 ? relays : undefined, connect: this.nostrConnectFn, clock: this.clock, wall: this.wall });
  }

  /** Opens the signaling socket of a direct target: TCP to the host's address, or Nostr relays for a version 1 code. */
  private async connectDirect(t: DirectTarget, opts: JoinDirectOptions): Promise<{ sig: SignalingClient; welcome: WelcomeMsg }> {
    if (!t.nostr) return this.connect(t.url, this.socketFactory, opts.connectTimeoutMs ?? 5000, "ip");
    // the socket enforces its own deadlines (10 s to reach a relay, 15 s for the host to answer)
    let sock: NostrSocket | null = null;
    const factory = this.nostrFactory(t, opts);
    const t0 = this.clock.now();
    try {
      return await this.connect(t.url, (u) => (sock = factory(u) as NostrSocket), 0, "nostr");
    } catch (e) {
      const why = (sock as NostrSocket | null)?.failure;
      // same code as an IP host that does not answer, so a game handles one "could not reach the host" error
      if (e instanceof OneLobbyError && e.code === "connect_failed") {
        const out = new OneLobbyError("direct_unreachable", why || "no answer through the Nostr relays");
        throw this.diagnosed(out, "nostr", "none", t0, { relaysUp: !/no Nostr relay/i.test(why ?? "") });
      }
      throw e;
    }
  }

  /**
   * A Nostr joiner needs STUN; take the host's list (it comes in `welcome`), else the public defaults. The joiner's own
   * `iceServers` come last.
   */
  private withStun(welcome: WelcomeMsg, t: DirectTarget, opts: JoinDirectOptions): WelcomeMsg {
    let ice = welcome.ice ?? [];
    if (t.nostr && ice.length === 0) {
      const urls = opts.stun ?? [...DEFAULT_NOSTR_STUN];
      if (urls.length > 0) ice = [{ urls }];
    }
    if (opts.iceServers && opts.iceServers.length > 0) ice = [...ice, ...opts.iceServers.map((e) => ({ ...e }))];
    return ice === welcome.ice ? welcome : { ...welcome, ice };
  }

  private directTarget(codeOrAddress: string, opts: JoinDirectOptions): DirectTarget {
    let input = codeOrAddress.trim();
    if (looksLikeJoinCode(input)) {
      const d = decodeJoinCode(input);
      if ("error" in d)
        throw new OneLobbyError(d.error, d.error === "unknown_version" ? `"${input}" is a join code from a newer version of the game` : `"${input}" is not a valid join code: check for a typo`);
      if ("room" in d) {
        // version 1: a Nostr room; signaling runs over public relays (spec/nostr-signaling.md), WebRTC uses STUN
        const shown = encodeRoomCodeFor(d.room);
        return { nostr: shown, url: `nostr:${shown}`, joinedWith: shown, links: this.linkFactory };
      }
      input = `${d.ip}:${d.port}`;
    }
    const addr = parseDirectAddress(input, opts.defaultPort ?? DEFAULT_DIRECT_PORT);
    if (!addr) throw new OneLobbyError("bad_address", `"${codeOrAddress}" is not a join code or an address (try 6B01-RGFE-P2B or 192.168.1.20:47810)`);
    const inner = this.linkFactory;
    // an address needs no STUN: keep the TURN entries (host's and own) and drop the STUN-only ones
    // a host on this PC (127.x.x.x): bind the ICE sockets to loopback too
    const bindAddress = loopbackBindAddress(addr.host);
    const links: LinkFactory = { create: (o) => inner.create({ ...o, iceServers: o.iceServers.filter(hasTurn), extraRemoteCandidates: [addr.candidate], ...(bindAddress ? { bindAddress } : {}) }) };
    return { nostr: null, url: addr.url, joinedWith: joinedWith(addr), links };
  }

  /** @internal onelobby/direct's Nostr host: the relay seam and the kit's clocks. */
  nostrHostEnv(): { connect: RelayConnect | undefined; clock: Clock; wall: () => number } {
    return { connect: this.nostrConnectFn, clock: this.clock, wall: this.wall };
  }

  /** @internal onelobby/direct's host: create the one lobby on the embedded hub, in direct mode. */
  async hostDirectWith(h: HostOptions, hooks: DirectLobbyHooks): Promise<Lobby> {
    const room = this.checkRoomHost(h);
    const spectators = room.spectators ?? 0;
    const { sig, welcome } = await this.connect("onelobby-direct://host/", hooks.socketFactory, 0, "ip");
    try {
      // the hub's own password option guards joins; the host's room layer checks it too (spec/room.md s.6)
      const state = await sig.request<LobbyState>(
        { t: "create", name: h.name, maxPlayers: h.maxPlayers, visibility: "unlisted", mode: this.options.mode, tickRate: this.options.tickRate,
          lateJoin: room.lateJoin !== undefined ? room.lateJoin !== "refuse" : (h.lateJoin ?? true), meta: h.meta ?? {},
          ...(this.options.relayOnly ? { relayOnly: true } : {}), ...(spectators > 0 ? { spectators } : {}) },
        "lobby",
      );
      return this.makeLobby(sig, welcome, state, { links: hooks.wrapLinks(this.linkFactory) }, h.rateLimit, { options: room, password: h.password ?? "", maxPlayers: h.maxPlayers }, "ip");
    } catch (e) {
      sig.close();
      throw e;
    }
  }

  /**
   * Host a direct lobby from this browser tab (or any runtime with WebSocket and WebRTC): no Node process, no port.
   * The hub runs in the page and joiners find it through Nostr relays with `lobby.joinCode` (a dc1 version 1 code,
   * `joinCodeKind` "nostr"); they use `kit.joinDirect(code)`. Rejects with `direct_unreachable` when no relay answers
   * within 10 s (a browser has no IP fallback) and `nostr_disabled` when the blueprint has `hosting.nostr` false.
   * Keep the tab visible: hidden tabs are throttled (`lobby.hostHidden`, event `hostHiddenChanged`).
   */
  hostNostr(opts: BrowserHostOptions = {}): Promise<Lobby> {
    return hostNostr(this, opts);
  }

  async rejoin(resumeToken: string): Promise<Lobby> {
    return this.resumeAt(resumeToken, this.options.lobbyServer, 0);
  }

  private async resumeAt(
    resumeToken: string,
    url: string,
    timeoutMs: number,
    direct?: { links: LinkFactory },
    factory?: SocketFactory,
    tweakWelcome?: (w: WelcomeMsg) => WelcomeMsg,
  ): Promise<Lobby> {
    const sig = await this.open(url, factory ?? this.socketFactory, timeoutMs);
    try {
      // The server answers hello(resumeToken) with welcome then the full lobby state; listen for both up front.
      const lobbyP = sig.expect<LobbyState>("lobby");
      const welcomeP = sig.request<WelcomeMsg & { t: string }>(this.helloMsg(resumeToken), "welcome");
      lobbyP.catch(() => {}); // settled below or by close()
      const welcome = tweakWelcome ? tweakWelcome(await welcomeP) : await welcomeP;
      // spec: an unknown or expired token is ignored -> plain welcome (no peerId), and no lobby follows
      if (welcome.peerId === undefined) throw new OneLobbyError("invalid_token", "resume token unknown or expired");
      const state = await lobbyP;
      return this.makeLobby(sig, welcome, state, direct);
    } catch (e) {
      sig.close();
      throw e;
    }
  }

  async list(opts: ListOptions = {}): Promise<LobbySummary[]> {
    if (this.blueprint && !this.blueprint.hosting.server) throw new OneLobbyError("listing_disabled", "this game has no lobby server (hosting.server is false)");
    const { sig } = await this.connect();
    try {
      const res = await sig.request<{ t: string; items: LobbySummary[] }>(
        { t: "list", visibility: "public", meta: opts.meta ?? {}, limit: Math.min(100, opts.limit ?? 50), ...(opts.cursor ? { cursor: opts.cursor } : {}) },
        "lobbies",
      );
      return res.items ?? [];
    } finally {
      sig.close();
    }
  }
}

/** The join code for an IPv4 address (a host name or IPv6 has none: its `host:port` instead). */
function joinedWith(addr: { host: string; port: number; isIPv6: boolean; display: string }): string {
  if (addr.isIPv6) return addr.display;
  try {
    return encodeJoinCode(addr.host, addr.port);
  } catch {
    return addr.display;
  }
}

/** The room settings an `onelobby.json` implies. */
function blueprintRoom(bp: Blueprint): RoomOptions {
  const r = bp.room;
  return {
    autoStart: r.autoStart,
    autoStartPlayers: r.autoStartPlayers,
    minPlayers: r.minPlayers,
    countdownSeconds: r.countdownSeconds,
    spectators: r.spectators,
    lateJoin: r.lateJoin,
    seatDropped: r.seatDropped,
    rejoinWindowSeconds: r.rejoinWindowSeconds,
    passwordRequired: r.passwordRequired,
    maxNameLength: bp.players.maxNameLength,
    data: Object.fromEntries(Object.entries(r.data).map(([k, v]) => [k, { ...v, ...(v.values ? { values: [...v.values] } : {}) }])),
  };
}

/** The room `join` a joiner sends: its role, starting data and the password it knows. */
function joinSetup(o: JoinOptions | JoinDirectOptions): RoomJoinOptions {
  return { role: o.role ?? "player", data: { ...(o.data ?? {}) }, password: o.password ?? "" };
}

function definedOnly<T extends object>(o: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (o) for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Blueprint switches that gate features on the lobby: voice and text chat; chat.voiceMode is the starting voice mode. */
function guardLobby(lobby: Lobby, bp: Blueprint): void {
  const rename = lobby.rename.bind(lobby);
  lobby.rename = async (name: string) => {
    if (bp.players.identity === "anonymous") throw new OneLobbyError("identity_anonymous", "this game uses anonymous players: no display names");
    if (String(name ?? "").trim().length > bp.players.maxNameLength)
      throw new BlueprintError("displayName", "length", `must be at most ${bp.players.maxNameLength} characters`);
    return rename(name);
  };
  lobby.voice.mode = bp.chat.voiceMode;
  if (!bp.chat.voice) {
    const voice = lobby.voice;
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(voice), "enabled");
    if (d?.get && d.set) {
      Object.defineProperty(voice, "enabled", {
        configurable: true,
        get: () => d.get!.call(voice) as boolean,
        set: (v: boolean) => {
          if (v) throw new OneLobbyError("voice_disabled", "this game has voice chat turned off (chat.voice is false)");
          d.set!.call(voice, v);
        },
      });
    }
  }
  lobby.pause.mode = bp.session.pause;
  if (!bp.chat.text) {
    lobby.chat.send = () => {
      throw new OneLobbyError("chat_disabled", "this game has text chat turned off (chat.text is false)");
    };
  }
}
