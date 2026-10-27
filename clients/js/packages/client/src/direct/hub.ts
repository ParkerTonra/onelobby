/**
 * The signaling hub (protocol lk1) in TypeScript, for a Node process or a browser tab that hosts direct lobbies
 * (docs/direct-ip.md s.2): a line-by-line port of `server/OneLobby.Hub/Hub.cs`, held to the same rules by
 * `conformance/server`. Transport-agnostic: feed it text frames with `receive`, call `tick` about once a second.
 * Metrics (same names, labels and help text as C#, rendered by `metrics.render()`) are counted too, so every hub shape
 * looks the same from outside; everything else (codes, list, resume, private lobbies, kicks, migration claims, TURN
 * credentials, rate limits) behaves as in C#.
 */

import { Metrics } from "./metrics.js";
import { randomBelow, randomHex, shortHash, turnCredential } from "./sha1.js";

export { Metrics };
export const PROTO = "lk1";
const NAME_MAX = 24;
const LOBBY_NAME_MAX = 48;
const META_KEYS_MAX = 16;
const META_LEN_MAX = 64;
const PENDING_MAX = 8;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GAME_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The settings the hub reads; same names and defaults as C#'s `HubOptions`. */
export interface HubOptions {
  turnUrls: string[];
  turnSecret: string;
  stunUrls: string[];
  region: string;
  /** Empty = every gameId allowed. */
  allowedGames: string[];
  gameQuotas: Record<string, number>;
  maxLobbies: number;
  maxPeers: number;
  /** Default and advertised maxPlayers limit; create accepts 2..this. */
  hardMaxPlayers: number;
  rateScale: number;
  turnTtlSeconds: number;
  maxMessageBytes: number;
  disableIpLimits: boolean;
  createPerMin: number;
  joinPerMin: number;
  signalPerSec: number;
  openLobbiesPerIp: number;
  idleTimeoutMs: number;
  resumeWindowMs: number;
  codeReuseMs: number;
  listLimitMax: number;
  /** One lobby per hub (direct IP): later creates are refused, a join without a code joins it. */
  singleLobby: boolean;
  /** When set, join must carry the same password or gets bad_password. */
  password: string | null;
  /** False: lobby messages carry code "" and list is empty. */
  issueCodes: boolean;
}

export function defaultHubOptions(): HubOptions {
  return {
    turnUrls: [], turnSecret: "", stunUrls: ["stun:stun.l.google.com:19302"], region: "", allowedGames: [], gameQuotas: {},
    maxLobbies: 1000, maxPeers: 10000, hardMaxPlayers: 64, rateScale: 1, turnTtlSeconds: 3600, maxMessageBytes: 16 * 1024,
    disableIpLimits: false, createPerMin: 10, joinPerMin: 60, signalPerSec: 20, openLobbiesPerIp: 8, idleTimeoutMs: 30_000,
    resumeWindowMs: 60_000, codeReuseMs: 24 * 3600 * 1000, listLimitMax: 100, singleLobby: false, password: null, issueCodes: true,
  };
}

/** Settings for a hub inside the host's game (docs/direct-ip.md s.2): no codes, no list, no ICE servers. */
export function directHubOptions(maxPlayers: number, password?: string | null): HubOptions {
  const n = Math.min(250, Math.max(2, maxPlayers));
  return {
    ...defaultHubOptions(),
    singleLobby: true, issueCodes: false, password: password ? password : null, stunUrls: [], turnUrls: [],
    maxLobbies: 1, hardMaxPlayers: n, maxPeers: n + 8,
  };
}

/** Sliding-window counter: at most `limit` events per `windowMs`. */
export class RateWindow {
  private hits: number[] = [];
  constructor(readonly limit: number, readonly windowMs: number) {}
  tryHit(now: number): boolean {
    this.trim(now);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }
  retryAfterMs(now: number): number {
    this.trim(now);
    return this.hits.length < this.limit || this.hits.length === 0 ? 0 : Math.max(1, this.windowMs - (now - this.hits[0]));
  }
  isIdle(now: number): boolean {
    this.trim(now);
    return this.hits.length === 0;
  }
  private trim(now: number): void {
    while (this.hits.length > 0 && now - this.hits[0] >= this.windowMs) this.hits.shift();
  }
}

/** Control characters and bidi overrides out, then at most `max` UTF-16 units without splitting a surrogate pair. */
export function sanitize(s: string | null | undefined, max: number, fallback = ""): string {
  if (!s) return fallback;
  let r = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch.length === 1 && (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069))) continue;
    r += ch;
  }
  if (r.length > max) {
    r = r.slice(0, max);
    const last = r.charCodeAt(r.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) r = r.slice(0, -1);
  }
  return r.length === 0 ? fallback : r;
}

function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let out = "";
  for (const raw of input) {
    if (raw === " " || raw === "-") continue;
    let ch = raw >= "a" && raw <= "z" ? raw.toUpperCase() : raw;
    if (ch === "I" || ch === "L") ch = "1";
    else if (ch === "O") ch = "0";
    if (CROCKFORD.indexOf(ch) < 0 || out.length >= 6) return null;
    out += ch;
  }
  return out.length === 6 ? out : null;
}

type Json = Record<string, unknown>;

/** One signaling connection. The hub only calls `send` and `close`. */
export class Session {
  closed = false;
  lastSeen = 0;
  helloDone = false;
  gameId = "";
  netVersion = "";
  name = "";
  lobby: HubLobby | null = null;
  member: Member | null = null;
  pendingIn: HubLobby | null = null;
  pendingMember: Member | null = null;
  constructor(
    readonly id: number,
    readonly ip: string,
    readonly connId: string,
    readonly send: (text: string) => void,
    readonly close: () => void,
  ) {}
  /** One window per target peer: a host answering many joiners at once gets the full budget for each of them. */
  readonly signalRates = new Map<number, RateWindow>();
}

class Member {
  peerId = 0;
  name = "";
  joinedAt = 0;
  session: Session | null = null;
  detachedAt = 0;
  token = "";
  ip = "";
}

class HubLobby {
  code = "";
  gameId = "";
  netVersion = "";
  name = "";
  visibility = "public";
  mode = "lockstep";
  tickRate = 20;
  lateJoin = false;
  relayOnly = false;
  phase = "lobby";
  maxPlayers = 0;
  createdAt = 0;
  ownerIp = "";
  meta: Record<string, string> = {};
  members: Member[] = [];
  pending: Member[] = [];
  kicked = new Set<string>();
  hostId = 0;
  epoch = 0;
  /** Highest valid host_changed claim a member made while the host was still connected; applied when the host goes. */
  pendingClaimPeer = 0;
  pendingClaimEpoch = 0;
  nextPeerId = 1;
  find(peerId: number): Member | undefined {
    return this.members.find((m) => m.peerId === peerId);
  }
}

interface IpState {
  create: RateWindow;
  join: RateWindow;
  open: number;
  sockets: number;
}

const KNOWN_TYPES = new Set(["hello", "create", "join", "list", "leave", "signal", "meta", "phase", "kick", "approve", "ping", "host_changed", "path"]);

const str = (o: Json, k: string): string | null => (typeof o[k] === "string" ? (o[k] as string) : null);
const int = (o: Json, k: string): number | null => {
  const v = o[k];
  return typeof v === "number" && Number.isInteger(v) && Math.abs(v) < 2147483647 ? v : null;
};
const bool = (o: Json, k: string): boolean | null => (typeof o[k] === "boolean" ? (o[k] as boolean) : null);
const has = (o: Json, k: string): boolean => o[k] !== undefined && o[k] !== null;
const field = (name: string): Json => ({ field: name });
const hex = (n: number): string => randomHex(n);
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Not sanitised (spec/signaling.md): over the limits or non-string values are rejected. */
function readMeta(node: unknown): { meta: Record<string, string> } | { err: string } {
  if (node === undefined || node === null) return { meta: {} };
  if (typeof node !== "object" || Array.isArray(node)) return { err: "meta must be an object of strings" };
  const entries = Object.entries(node as Json);
  if (entries.length > META_KEYS_MAX) return { err: `meta allows at most ${META_KEYS_MAX} keys` };
  const meta: Record<string, string> = {};
  for (const [k, v] of entries.sort(([a], [b]) => byCode(a, b))) {
    if (typeof v !== "string") return { err: "meta values must be strings" };
    if (k.length > META_LEN_MAX || v.length > META_LEN_MAX) return { err: `meta keys and values are limited to ${META_LEN_MAX} chars` };
    meta[k] = v;
  }
  return { meta };
}

export interface HubDeps {
  /** Unix milliseconds; injected so tests drive time. */
  now?: () => number;
  /** Uniform integer in [0, n). */
  randomInt?: (n: number) => number;
  log?: (line: string) => void;
}

/** All signaling state and rules (DESIGN s.6, s.7, s.9, s.10, s.12; spec/signaling.md). */
export class SignalingHub {
  private readonly o: HubOptions;
  private readonly now: () => number;
  private readonly rand: (n: number) => number;
  private readonly log: (line: string) => void;
  private readonly lobbies = new Map<string, HubLobby>();
  private readonly retired = new Map<string, number>();
  private readonly tokens = new Map<string, { lobby: HubLobby; member: Member }>();
  private readonly sessions = new Map<number, Session>();
  private readonly gameLobbies = new Map<string, number>();
  private readonly ips = new Map<string, IpState>();
  private nextSession = 0;
  private createdOnce = false;
  private members = 0;
  private readonly logSalt = hex(8);
  readonly metrics = new Metrics();

  constructor(options: Partial<HubOptions> = {}, deps: HubDeps = {}) {
    this.o = { ...defaultHubOptions(), ...options };
    this.now = deps.now ?? (() => Date.now());
    this.rand = deps.randomInt ?? ((n) => randomBelow(n));
    this.log = deps.log ?? (() => {});
    const m = this.metrics;
    m.gauge("onelobby_lobbies", "Live lobbies.", () => this.lobbyCount);
    m.gauge("onelobby_sockets", "Open signaling sockets.", () => this.socketCount);
    m.gauge("onelobby_lobbies_retired", "Join codes held back from reuse.", () => this.retired.size);
    m.describe("onelobby_messages_total", "Client messages received, by type.");
    m.describe("onelobby_errors_total", "Error replies sent, by code.");
    m.describe("onelobby_path_total", "ICE path reports from peers: direct vs relayed (DESIGN s.10).");
    m.describe("onelobby_connections_total", "Sockets accepted since start.");
    m.describe("onelobby_lobbies_created_total", "Lobbies created since start.");
    m.describe("onelobby_rate_limit_hits_total", "Requests refused by a rate limit, by kind.");
  }

  get lobbyCount(): number {
    return this.lobbies.size;
  }
  get socketCount(): number {
    return this.sessions.size;
  }
  private get scale(): number {
    return Math.max(1, this.o.rateScale);
  }

  // ---------------------------------------------------------------- connection lifecycle

  /** Registers a socket. Returns null (after sending server_full and closing) when over maxPeers. */
  connect(ip: string, send: (text: string) => void, close: () => void): Session | null {
    const s = new Session(++this.nextSession, ip, hex(6), send, close);
    s.lastSeen = this.now();
    this.metrics.inc("onelobby_connections_total");
    if (this.sessions.size >= this.o.maxPeers) {
      this.error(s, "server_full", "server is at its peer limit");
      s.close();
      return null;
    }
    this.sessions.set(s.id, s);
    this.ipOf(ip).sockets++;
    return s;
  }

  disconnect(s: Session): void {
    if (!this.sessions.delete(s.id)) return;
    s.closed = true;
    const st = this.ips.get(s.ip);
    if (st) st.sockets--;
    if (s.pendingIn) {
      s.pendingIn.pending = s.pendingIn.pending.filter((p) => p !== s.pendingMember);
      s.pendingIn = null;
      s.pendingMember = null;
    }
    const m = s.member;
    const lobby = s.lobby;
    if (m && lobby) {
      // The slot and token stay reserved for the resume window (tick expires them); others hear peer_left{timeout} now.
      m.session = null;
      m.detachedAt = this.now();
      s.member = null;
      s.lobby = null;
      this.logEvent("detach", lobby, s);
      this.broadcast(lobby, { t: "peer_left", peerId: m.peerId, reason: "timeout" });
      this.metrics.inc("onelobby_peers_left_total", "reason", "timeout");
      if (lobby.hostId === m.peerId) this.promoteHost(lobby, m.peerId);
    }
  }

  private closeSession(s: Session): void {
    s.close();
    this.disconnect(s);
  }

  // ---------------------------------------------------------------- time

  /** Call about once a second: idle timeouts, resume-window expiry, code retirement. */
  tick(): void {
    const now = this.now();
    for (const s of [...this.sessions.values()])
      if (now - s.lastSeen > this.o.idleTimeoutMs) {
        this.metrics.inc("onelobby_idle_timeouts_total");
        this.closeSession(s);
      }
    for (const lobby of [...this.lobbies.values()])
      for (const m of [...lobby.members]) if (m.detachedAt > 0 && now - m.detachedAt >= this.o.resumeWindowMs) this.removeMember(lobby, m, "timeout");
    for (const [code, at] of [...this.retired]) if (now - at >= this.o.codeReuseMs) this.retired.delete(code);
    for (const [key, st] of [...this.ips])
      if (st.sockets <= 0 && st.open <= 0 && st.create.isIdle(now) && st.join.isIdle(now)) this.ips.delete(key);
  }

  // ---------------------------------------------------------------- inbound

  receive(s: Session, text: string): void {
    if (s.closed) return;
    s.lastSeen = this.now();
    if (text.length > this.o.maxMessageBytes) {
      this.error(s, "bad_request", "message too large");
      this.closeSession(s);
      return;
    }
    let msg: Json | null = null;
    try {
      const v = JSON.parse(text) as unknown;
      msg = v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
    } catch {
      msg = null;
    }
    const t = msg ? str(msg, "t") : null;
    if (!msg || t === null) {
      this.error(s, "bad_request", "expected a JSON object with a string t", field("t"));
      return;
    }
    this.metrics.inc("onelobby_messages_total", "type", KNOWN_TYPES.has(t) ? t : "unknown");
    if (t === "hello") return this.hello(s, msg);
    if (!s.helloDone) {
      if (KNOWN_TYPES.has(t)) this.error(s, "bad_request", "send hello first");
      return;
    }
    switch (t) {
      case "create": return this.create(s, msg);
      case "join": return this.join(s, msg);
      case "list": return this.list(s, msg);
      case "leave": return this.leave(s);
      case "signal": return this.signal(s, msg);
      case "meta": return this.hostMeta(s, msg);
      case "phase": return this.hostPhase(s, msg);
      case "kick": return this.kick(s, msg);
      case "approve": return this.approve(s, msg);
      case "ping": {
        const n = int(msg, "n");
        if (n === null || n < 0) return this.error(s, "bad_request", "ping needs an integer n", field("n"));
        return this.send(s, { t: "pong", n });
      }
      case "host_changed": return this.claimHost(s, msg);
      case "path": return this.pathReport(s, msg);
      default: return; // unknown types are ignored
    }
  }

  // ---------------------------------------------------------------- hello / welcome

  private hello(s: Session, m: Json): void {
    if (s.helloDone) return this.error(s, "bad_request", "hello already sent");
    if (str(m, "proto") !== PROTO) {
      this.error(s, "bad_request", "unsupported proto, expected lk1", { supported: [PROTO] });
      this.closeSession(s);
      return;
    }
    if (has(m, "name") && str(m, "name") === null) return this.error(s, "bad_request", "name must be a string", field("name"));
    if (has(m, "client") && (typeof m.client !== "object" || Array.isArray(m.client)))
      return this.error(s, "bad_request", "client must be an object", field("client"));
    const gameId = str(m, "gameId");
    const netVersion = str(m, "netVersion");
    if (gameId === null || !GAME_ID.test(gameId)) return this.error(s, "bad_request", "gameId must match [A-Za-z0-9._-]{1,64}", field("gameId"));
    if (!netVersion || netVersion.length > 32) return this.error(s, "bad_request", "netVersion must be 1-32 characters", field("netVersion"));
    if (this.o.allowedGames.length > 0 && !this.o.allowedGames.includes(gameId)) {
      this.error(s, "game_not_allowed", "this server does not host that game");
      this.closeSession(s);
      return;
    }
    s.gameId = gameId;
    s.netVersion = netVersion;
    s.name = sanitize(str(m, "name"), NAME_MAX, "Player");
    s.helloDone = true;

    let resumed: Member | null = null;
    let rl: HubLobby | null = null;
    const token = str(m, "resumeToken");
    const entry = token !== null ? this.tokens.get(token) : undefined;
    if (entry && entry.lobby.gameId === gameId && entry.lobby.netVersion === netVersion) {
      // Validate first: a live socket (take-over) or a detached seat still inside the resume window. Only a valid
      // resume closes the old socket (it detaches normally, which starts the window anew).
      const old = entry.member.session;
      const takeOver = old !== null && old !== undefined && old !== s;
      const inWindow = entry.member.detachedAt > 0 && this.now() - entry.member.detachedAt < this.o.resumeWindowMs;
      if (takeOver || inWindow) {
        if (takeOver) this.closeSession(old!);
        resumed = entry.member;
        rl = entry.lobby;
      }
    }

    const w: Json = {
      t: "welcome",
      ice: this.iceList(s),
      serverTime: this.now(),
      limits: { maxMsg: this.o.maxMessageBytes, maxPlayers: this.o.hardMaxPlayers },
    };
    if (resumed) w.peerId = resumed.peerId;
    this.send(s, w);

    if (resumed && rl) {
      this.tokens.delete(resumed.token);
      resumed.token = hex(16);
      this.tokens.set(resumed.token, { lobby: rl, member: resumed });
      resumed.session = s;
      resumed.detachedAt = 0;
      s.lobby = rl;
      s.member = resumed;
      this.logEvent("resume", rl, s);
      this.metrics.inc("onelobby_resumes_total");
      for (const other of rl.members) if (other !== resumed) this.sendTo(other, { t: "peer_joined", peer: this.peerObj(resumed) });
      this.send(s, this.lobbyMsg(rl, resumed));
    }
  }

  private iceList(s: Session): Json[] {
    const ice: Json[] = [];
    if (this.o.stunUrls.length > 0) ice.push({ urls: [...this.o.stunUrls] });
    if (this.o.turnUrls.length > 0 && this.o.turnSecret.length > 0) {
      const expiry = Math.floor(this.now() / 1000) + this.o.turnTtlSeconds;
      const username = `${expiry}:${s.connId}`;
      const credential = turnCredential(this.o.turnSecret, username);
      ice.push({ urls: [...this.o.turnUrls], username, credential, ttl: this.o.turnTtlSeconds });
    }
    return ice;
  }

  // ---------------------------------------------------------------- create / join / list / leave

  private ipOf(ip: string): IpState {
    let st = this.ips.get(ip);
    if (!st) {
      st = { create: new RateWindow(this.o.createPerMin * this.scale, 60_000), join: new RateWindow(this.o.joinPerMin * this.scale, 60_000), open: 0, sockets: 0 };
      this.ips.set(ip, st);
    }
    return st;
  }

  private create(s: Session, m: Json): void {
    if (s.lobby || s.pendingIn) return this.error(s, "bad_request", "already in a lobby");
    const ip = this.ipOf(s.ip);
    const now = this.now();
    if (!this.o.disableIpLimits) {
      if (!ip.create.tryHit(now)) return this.rateLimited(s, "create", ip.create.retryAfterMs(now), null);
      if (ip.open >= this.o.openLobbiesPerIp * this.scale) return this.rateLimited(s, "open_lobbies", 5000, "max_lobbies");
    }
    if (this.o.singleLobby && this.createdOnce) return this.error(s, "server_full", "this host runs one lobby");
    if (this.lobbies.size >= this.o.maxLobbies || this.members >= this.o.maxPeers) return this.error(s, "server_full", "server is at its lobby limit");
    const quota = this.o.gameQuotas[s.gameId];
    if (quota !== undefined && (this.gameLobbies.get(s.gameId) ?? 0) >= quota) return this.error(s, "server_full", "lobby quota for this game is reached");

    if (has(m, "name") && str(m, "name") === null) return this.error(s, "bad_request", "name must be a string", field("name"));
    const vis = str(m, "visibility") ?? "public";
    const mode = str(m, "mode") ?? "lockstep";
    if (vis !== "public" && vis !== "unlisted" && vis !== "private") return this.error(s, "bad_request", "visibility must be public, unlisted or private", field("visibility"));
    if (mode !== "lockstep" && mode !== "raw") return this.error(s, "bad_request", "mode must be lockstep or raw", field("mode"));
    if (has(m, "maxPlayers") && int(m, "maxPlayers") === null) return this.error(s, "bad_request", "maxPlayers must be an integer", field("maxPlayers"));
    const maxPlayers = int(m, "maxPlayers") ?? 8;
    if (maxPlayers < 2 || maxPlayers > this.o.hardMaxPlayers) return this.error(s, "bad_request", `maxPlayers must be 2-${this.o.hardMaxPlayers}`, field("maxPlayers"));
    if (has(m, "tickRate") && int(m, "tickRate") === null) return this.error(s, "bad_request", "tickRate must be an integer", field("tickRate"));
    const tick = int(m, "tickRate") ?? 20;
    if (tick < 1 || tick > 255) return this.error(s, "bad_request", "tickRate must be 1-255", field("tickRate"));
    if (has(m, "lateJoin") && bool(m, "lateJoin") === null) return this.error(s, "bad_request", "lateJoin must be a boolean", field("lateJoin"));
    if (has(m, "relayOnly") && bool(m, "relayOnly") === null) return this.error(s, "bad_request", "relayOnly must be a boolean", field("relayOnly"));
    const meta = readMeta(m.meta);
    if ("err" in meta) return this.error(s, "bad_request", meta.err, field("meta"));

    const code = this.newCode();
    if (code === null) return this.error(s, "server_full", "could not allocate a join code");

    const lobby = new HubLobby();
    Object.assign(lobby, {
      code, gameId: s.gameId, netVersion: s.netVersion, name: sanitize(str(m, "name"), LOBBY_NAME_MAX, `${s.name}'s lobby`),
      visibility: vis, mode, tickRate: tick, lateJoin: bool(m, "lateJoin") ?? false, relayOnly: bool(m, "relayOnly") ?? false,
      maxPlayers, createdAt: now, ownerIp: s.ip, meta: meta.meta,
    });
    this.lobbies.set(code, lobby);
    this.createdOnce = true;
    this.gameLobbies.set(s.gameId, (this.gameLobbies.get(s.gameId) ?? 0) + 1);
    ip.open++;
    this.metrics.inc("onelobby_lobbies_created_total");
    const host = this.addMember(lobby, s, null);
    lobby.hostId = host.peerId;
    this.logEvent("create", lobby, s);
    this.send(s, this.lobbyMsg(lobby, host));
  }

  private join(s: Session, m: Json): void {
    if (s.lobby || s.pendingIn) return this.error(s, "bad_request", "already in a lobby");
    const ip = this.ipOf(s.ip);
    const now = this.now();
    if (!this.o.disableIpLimits && !ip.join.tryHit(now)) return this.rateLimited(s, "join", ip.join.retryAfterMs(now), null);
    let lobby: HubLobby | undefined;
    if (this.o.singleLobby && !has(m, "code")) {
      // direct IP: the address is the invitation, so a join without a code means the one lobby
      lobby = this.lobbies.values().next().value;
      if (!lobby || lobby.gameId !== s.gameId) return this.error(s, "unknown_code", "this host has no open lobby for that game");
    } else {
      const code = normalizeCode(m.code);
      if (code === null) return this.error(s, "bad_request", "malformed join code", field("code"));
      lobby = this.lobbies.get(code);
      if (!lobby || lobby.gameId !== s.gameId) return this.error(s, "unknown_code", "no lobby with that code");
    }
    if (this.o.password !== null && str(m, "password") !== this.o.password) return this.error(s, "bad_password", "wrong password for this lobby");
    if (lobby.netVersion !== s.netVersion)
      return this.error(s, "version_mismatch", `host is on ${lobby.netVersion}, you are on ${s.netVersion}`, { hostNetVersion: lobby.netVersion, yourNetVersion: s.netVersion });
    if (lobby.kicked.has(s.ip)) return this.error(s, "kicked", "you were removed from this lobby");
    if (lobby.phase === "in_game" && !lobby.lateJoin) return this.error(s, "in_game", "the game has already started");
    if (lobby.members.length >= lobby.maxPlayers) return this.error(s, "lobby_full", "lobby is full");
    if (this.members >= this.o.maxPeers) return this.error(s, "server_full", "server is at its peer limit");

    if (lobby.visibility === "private") {
      if (lobby.pending.length >= PENDING_MAX) return this.error(s, "lobby_full", "too many pending requests");
      const pm = new Member();
      pm.peerId = lobby.nextPeerId++;
      pm.name = s.name;
      pm.session = s;
      pm.ip = s.ip;
      lobby.pending.push(pm);
      s.pendingIn = lobby;
      s.pendingMember = pm;
      const hs = lobby.find(lobby.hostId)?.session;
      if (hs) this.send(hs, { t: "join_request", peer: this.peerObj(pm) });
      this.logEvent("join_request", lobby, s);
      return;
    }
    this.admit(lobby, s, null);
  }

  private admit(lobby: HubLobby, s: Session, pending: Member | null): void {
    const joiner = this.addMember(lobby, s, pending);
    this.logEvent("join", lobby, s);
    for (const other of lobby.members) if (other !== joiner) this.sendTo(other, { t: "peer_joined", peer: this.peerObj(joiner) });
    // A lobby whose host slot is only reserved (host dropped, nobody was connected) hands over to the first newcomer.
    if (!lobby.find(lobby.hostId)?.session) this.promoteHost(lobby, lobby.hostId);
    this.send(s, this.lobbyMsg(lobby, joiner));
  }

  private addMember(lobby: HubLobby, s: Session, reuse: Member | null): Member {
    const mem = reuse ?? new Member();
    if (!reuse) mem.peerId = lobby.nextPeerId++;
    mem.name = s.name;
    mem.session = s;
    mem.ip = s.ip;
    mem.joinedAt = this.now();
    mem.detachedAt = 0;
    mem.token = hex(16);
    lobby.members.push(mem);
    this.members++;
    this.tokens.set(mem.token, { lobby, member: mem });
    s.lobby = lobby;
    s.member = mem;
    s.pendingIn = null;
    s.pendingMember = null;
    return mem;
  }

  private list(s: Session, m: Json): void {
    const vis = str(m, "visibility");
    if (!this.o.issueCodes) return this.send(s, { t: "lobbies", items: [] });
    if (vis !== "public") return this.error(s, "bad_request", "only public lobbies can be listed", field("visibility"));
    let limit = 50;
    if (has(m, "limit")) {
      const l = int(m, "limit");
      if (l === null || l < 1 || l > this.o.listLimitMax) return this.error(s, "bad_request", `limit must be 1-${this.o.listLimitMax}`, field("limit"));
      limit = l;
    }
    let offset = 0;
    if (has(m, "cursor")) {
      const c = str(m, "cursor");
      if (c === null || !/^\d+$/.test(c)) return this.error(s, "bad_request", "bad cursor", field("cursor"));
      offset = Number(c);
    }
    let filter: Record<string, string> | null = null;
    if (has(m, "meta")) {
      if (typeof m.meta !== "object" || Array.isArray(m.meta)) return this.error(s, "bad_request", "meta must be an object", field("meta"));
      filter = {};
      for (const [k, v] of Object.entries(m.meta as Json)) {
        if (typeof v !== "string") return this.error(s, "bad_request", "meta values must be strings", field("meta"));
        filter[k] = v;
      }
    }
    const all = [...this.lobbies.values()]
      .filter((l) => l.gameId === s.gameId && l.netVersion === s.netVersion && l.visibility === "public" && (l.phase !== "in_game" || l.lateJoin)
        && (filter === null || Object.entries(filter).every(([k, v]) => l.meta[k] === v)))
      .sort((a, b) => a.createdAt - b.createdAt || byCode(a.code, b.code));
    const page = all.slice(offset, offset + limit);
    const items = page.map((l) => ({
      code: l.code, gameId: l.gameId, netVersion: l.netVersion, name: l.name, hostName: l.find(l.hostId)?.name ?? "",
      players: l.members.length, maxPlayers: l.maxPlayers, phase: l.phase, meta: { ...l.meta }, region: this.o.region, createdAt: l.createdAt,
    }));
    const reply: Json = { t: "lobbies", items };
    if (offset + page.length < all.length) reply.cursor = String(offset + page.length);
    this.send(s, reply);
  }

  private leave(s: Session): void {
    if (s.pendingIn) {
      s.pendingIn.pending = s.pendingIn.pending.filter((p) => p !== s.pendingMember);
      s.pendingIn = null;
      s.pendingMember = null;
      return;
    }
    if (!s.lobby || !s.member) return;
    this.removeMember(s.lobby, s.member, "left");
  }

  // ---------------------------------------------------------------- relay + host-only

  private signal(s: Session, m: Json): void {
    const lobby = s.lobby;
    const me = s.member;
    if (!lobby || !me) return this.error(s, "bad_request", "not in a lobby");
    const to = int(m, "to");
    const target = to === null ? undefined : lobby.find(to);
    if (!target || !target.session || target === me) return this.error(s, "bad_request", "unknown signal target", field("to"));
    const now = this.now();
    if (!this.o.disableIpLimits) {
      const rate = this.signalRate(s, target.peerId, now);
      if (!rate.tryHit(now)) return this.rateLimited(s, "signal", rate.retryAfterMs(now), null);
    }
    if (!has(m, "sdp") && !has(m, "ice")) return this.error(s, "bad_request", "signal needs sdp or ice", field("sdp"));
    const o: Json = { t: "signal", from: me.peerId };
    if (has(m, "sdp")) o.sdp = m.sdp;
    if (has(m, "ice")) o.ice = m.ice;
    this.send(target.session, o);
    this.metrics.inc("onelobby_signals_relayed_total");
  }

  /** spec/signaling.md rate limits: `signal` is counted per sender and target, so the host's budget grows with its joiners. */
  private signalRate(s: Session, to: number, now: number): RateWindow {
    let w = s.signalRates.get(to);
    if (!w) {
      for (const [k, v] of s.signalRates) if (v.isIdle(now)) s.signalRates.delete(k);
      w = new RateWindow(this.o.signalPerSec * this.scale, 1000);
      s.signalRates.set(to, w);
    }
    return w;
  }

  private requireHost(s: Session): HubLobby | null {
    if (!s.lobby || !s.member) {
      this.error(s, "bad_request", "not in a lobby");
      return null;
    }
    if (s.lobby.hostId !== s.member.peerId) {
      this.error(s, "not_host", "only the host can do that");
      return null;
    }
    return s.lobby;
  }

  private hostMeta(s: Session, m: Json): void {
    const lobby = this.requireHost(s);
    if (!lobby) return;
    const meta = readMeta(m.meta);
    if ("err" in meta || !has(m, "meta")) return this.error(s, "bad_request", "err" in meta ? meta.err : "meta is required", field("meta"));
    lobby.meta = meta.meta;
    this.broadcastLobby(lobby);
  }

  private hostPhase(s: Session, m: Json): void {
    const lobby = this.requireHost(s);
    if (!lobby) return;
    const ph = str(m, "phase");
    if (ph !== "in_game" && ph !== "lobby") return this.error(s, "bad_request", "phase must be in_game or lobby", field("phase"));
    lobby.phase = ph;
    this.logEvent(`phase:${ph}`, lobby, s);
    this.broadcastLobby(lobby);
  }

  private kick(s: Session, m: Json): void {
    const lobby = this.requireHost(s);
    if (!lobby) return;
    const id = int(m, "peerId");
    const target = id === null ? undefined : lobby.find(id);
    if (id === null || id === s.member!.peerId || !target) return this.error(s, "bad_request", "unknown peerId", field("peerId"));
    // ban:false disconnects without the ban; closeCode / closeReason are passed to the removed peer (spec/signaling.md)
    const ban = bool(m, "ban");
    if (has(m, "ban") && ban === null) return this.error(s, "bad_request", "ban must be a boolean", field("ban"));
    const code = int(m, "closeCode");
    if (has(m, "closeCode") && (code === null || !(code === 1000 || (code >= 3000 && code <= 4999))))
      return this.error(s, "bad_request", "closeCode must be 1000 or 3000-4999", field("closeCode"));
    const closeReason = str(m, "closeReason");
    if (has(m, "closeReason") && (closeReason === null || closeReason.length > 120))
      return this.error(s, "bad_request", "closeReason must be a string of at most 120 characters", field("closeReason"));
    const data: Json = {};
    if (ban === false) data.ban = false;
    if (code !== null) data.closeCode = code;
    if (closeReason !== null) data.closeReason = closeReason;
    if (ban !== false) lobby.kicked.add(target.ip);
    this.removeMember(lobby, target, ban === false ? "disconnected" : "kicked", Object.keys(data).length ? data : undefined);
  }

  private approve(s: Session, m: Json): void {
    const lobby = this.requireHost(s);
    if (!lobby) return;
    const id = int(m, "peerId");
    const pm = id === null ? undefined : lobby.pending.find((p) => p.peerId === id);
    const js = pm?.session;
    if (!pm || !js) return this.error(s, "bad_request", "no such pending request", field("peerId"));
    if (has(m, "ok") && bool(m, "ok") === null) return this.error(s, "bad_request", "ok must be a boolean", field("ok"));
    lobby.pending = lobby.pending.filter((p) => p !== pm);
    js.pendingIn = null;
    js.pendingMember = null;
    if (bool(m, "ok") !== true) return this.error(js, "kicked", "the host declined your request", { reason: "denied" });
    if (lobby.members.length >= lobby.maxPlayers) return this.error(js, "lobby_full", "lobby is full");
    if (lobby.phase === "in_game" && !lobby.lateJoin) return this.error(js, "in_game", "the game has already started");
    this.admit(lobby, js, pm);
  }

  /** Peer-side migration (s.9) tells the server: the new host announces itself with a higher epoch. */
  private claimHost(s: Session, m: Json): void {
    const lobby = s.lobby;
    const me = s.member;
    if (!lobby || !me) return;
    const host = int(m, "hostId");
    const epoch = int(m, "epoch");
    if (host !== me.peerId || epoch === null || epoch <= lobby.epoch) return;
    if (this.o.singleLobby) return; // direct lobbies have no migration: the host leaving ends the session
    if (lobby.hostId !== me.peerId && lobby.find(lobby.hostId)?.session) {
      // The host is still here, so a member cannot take over. Remember the best claim for when the host goes.
      if (epoch > lobby.pendingClaimEpoch) {
        lobby.pendingClaimPeer = me.peerId;
        lobby.pendingClaimEpoch = epoch;
      }
      return;
    }
    lobby.hostId = me.peerId;
    lobby.epoch = epoch;
    lobby.pendingClaimPeer = lobby.pendingClaimEpoch = 0;
    this.broadcast(lobby, { t: "host_changed", hostId: lobby.hostId, epoch: lobby.epoch });
    this.metrics.inc("onelobby_host_changes_total");
    this.logEvent("host_claim", lobby, s);
  }

  private pathReport(s: Session, m: Json): void {
    const p = str(m, "path");
    if (p === "relayed" || p === "direct") this.metrics.inc("onelobby_path_total", "path", p);
    else this.error(s, "bad_request", "path must be relayed or direct", field("path"));
  }

  // ---------------------------------------------------------------- membership changes

  /** Removes a member for good. A member that is already detached was announced as left, so nothing is sent for it. */
  private removeMember(lobby: HubLobby, mem: Member, reason: string, kickData?: Json): void {
    const i = lobby.members.indexOf(mem);
    if (i < 0) return;
    lobby.members.splice(i, 1);
    this.members--;
    this.tokens.delete(mem.token);
    const ms = mem.session;
    const wasConnected = mem.detachedAt === 0;
    if (ms) {
      ms.lobby = null;
      ms.member = null;
    }
    if (wasConnected) {
      this.broadcast(lobby, { t: "peer_left", peerId: mem.peerId, reason });
      this.metrics.inc("onelobby_peers_left_total", "reason", reason);
      if ((reason === "kicked" || reason === "disconnected") && ms)
        this.error(ms, "kicked", reason === "kicked" ? "the host removed you from the lobby" : "the host disconnected you", kickData);
    }
    this.logEvent(reason, lobby, ms);
    if (lobby.members.length === 0) return this.closeLobby(lobby);
    if (lobby.hostId === mem.peerId) this.promoteHost(lobby, mem.peerId);
  }

  /** Server mirror of the peer-side rule (s.9): new host is the lowest peerId still connected; epoch +1. */
  private promoteHost(lobby: HubLobby, leavingId: number): void {
    // A claim made while the old host was alive wins if its claimant is still connected.
    const claimant =
      lobby.pendingClaimEpoch > lobby.epoch && lobby.pendingClaimPeer !== leavingId
        ? lobby.members.find((x) => x.peerId === lobby.pendingClaimPeer && x.session)
        : undefined;
    const claimEpoch = lobby.pendingClaimEpoch;
    lobby.pendingClaimPeer = lobby.pendingClaimEpoch = 0;
    let next = claimant ?? lobby.members.filter((x) => x.session && x.peerId !== leavingId).sort((a, b) => a.peerId - b.peerId)[0];
    if (!next) {
      // Nobody connected. Keep a reserved host slot (it may resume); otherwise fall back to the lowest slot.
      if (lobby.find(leavingId)) return;
      next = [...lobby.members].sort((a, b) => a.peerId - b.peerId)[0];
      if (!next) return;
    }
    lobby.hostId = next.peerId;
    if (claimant) lobby.epoch = claimEpoch;
    else lobby.epoch++;
    this.broadcast(lobby, { t: "host_changed", hostId: next.peerId, epoch: lobby.epoch });
    this.metrics.inc("onelobby_host_changes_total");
    const hs = next.session;
    if (hs) for (const pm of lobby.pending) this.send(hs, { t: "join_request", peer: this.peerObj(pm) }); // the new host inherits the pending requests
    this.logEvent("host_changed", lobby, next.session);
  }

  private closeLobby(lobby: HubLobby): void {
    this.lobbies.delete(lobby.code);
    this.retired.set(lobby.code, this.now());
    const n = this.gameLobbies.get(lobby.gameId);
    if (n !== undefined) {
      if (n <= 1) this.gameLobbies.delete(lobby.gameId);
      else this.gameLobbies.set(lobby.gameId, n - 1);
    }
    const ip = this.ips.get(lobby.ownerIp);
    if (ip && ip.open > 0) ip.open--;
    for (const pm of [...lobby.pending]) {
      const ps = pm.session;
      if (ps) {
        ps.pendingIn = null;
        ps.pendingMember = null;
        this.error(ps, "unknown_code", "the lobby closed");
      }
    }
    lobby.pending = [];
    this.logEvent("close", lobby, null);
  }

  private newCode(): string | null {
    for (let i = 0; i < 100; i++) {
      let c = "";
      for (let k = 0; k < 6; k++) c += CROCKFORD[this.rand(32)];
      if (!this.lobbies.has(c) && !this.retired.has(c)) return c;
    }
    return null;
  }

  // ---------------------------------------------------------------- output helpers

  private lobbyMsg(l: HubLobby, you: Member): Json {
    const peers = l.members
      .filter((x) => x.detachedAt === 0)
      .sort((a, b) => a.peerId - b.peerId)
      .map((p) => ({ peerId: p.peerId, name: p.name, joinedAt: p.joinedAt }));
    return {
      t: "lobby", code: this.o.issueCodes ? l.code : "", gameId: l.gameId, netVersion: l.netVersion, hostId: l.hostId, you: you.peerId,
      mode: l.mode, tickRate: l.tickRate, lateJoin: l.lateJoin, phase: l.phase, meta: { ...l.meta }, peers, resumeToken: you.token,
      name: l.name, maxPlayers: l.maxPlayers, visibility: l.visibility, relayOnly: l.relayOnly,
    };
  }

  private broadcastLobby(l: HubLobby): void {
    for (const m of l.members) if (m.session) this.sendTo(m, this.lobbyMsg(l, m));
  }

  private broadcast(l: HubLobby, o: Json): void {
    for (const m of l.members) this.sendTo(m, o);
  }

  private peerObj(m: Member): Json {
    return { peerId: m.peerId, name: m.name };
  }

  private send(s: Session, o: Json): void {
    if (!s.closed) s.send(JSON.stringify(o));
  }

  private sendTo(m: Member, o: Json): void {
    if (m.session) this.send(m.session, o);
  }

  private error(s: Session, code: string, msg: string, data?: Json): void {
    this.metrics.inc("onelobby_errors_total", "code", code);
    const o: Json = { t: "error", code, msg };
    if (data !== undefined) o.data = data;
    s.send(JSON.stringify(o));
  }

  private rateLimited(s: Session, kind: string, retryAfterMs: number, reason: string | null): void {
    this.metrics.inc("onelobby_rate_limit_hits_total", "kind", kind);
    this.log(`rate_limit kind=${kind} ip=${this.hashIp(s.ip)}`);
    const data: Json = { retryAfterMs };
    if (reason !== null) data.reason = reason;
    this.error(s, "rate_limited", `too many ${kind} requests`, data);
  }

  private logEvent(ev: string, l: HubLobby, s: Session | null): void {
    this.log(`lobby ${ev} code=${l.code} game=${l.gameId} players=${l.members.length} ip=${s ? this.hashIp(s.ip) : "-"}`);
  }

  private hashIp(ip: string): string {
    return shortHash(this.logSalt + ip);
  }
}
