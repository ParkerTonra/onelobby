/// <reference types="node" />
/**
 * LAN discovery (spec/lan-discovery.md): a host answers a broadcast question on the local network, and the player's game
 * (the finder) lists the answers. Question and answer only; a host never announces. Opt-in: nothing here opens a socket
 * unless the game turned it on (`hosting.lan` in onelobby.json, or the `lan` option of `hostDirect`).
 *
 * The codec, the host's answering rules and the finder's list are plain code over a small UDP seam (`LanUdp`), so a test
 * drives them with no socket at all; `nodeLanUdp()` is the Node implementation, found without a static import so a
 * browser bundle never pulls in `node:dgram`.
 */
import { Emitter } from "./emitter.js";

export const LAN_DEFAULT_PORT = 47840;
export const LAN_WIRE_VERSION = 1;
export const LAN_MAX_DATAGRAM = 512;
export const LAN_LIMITS = { gameId: [1, 64], netVersion: [1, 32], lobbyName: [0, 72], hostName: [0, 72] } as const;
export const LAN_NAME_UNITS = 24;
/** Finder timers (spec s.4/s.6). */
export const LAN_ASK_INTERVAL_MS = 1000;
export const LAN_MIN_GAP_MS = 400;
export const LAN_ROW_TIMEOUT_MS = 4000;
export const LAN_MAX_ROWS = 64;
export const LAN_NONCES_KEPT = 8;
/** Host limits (spec s.3). */
export const LAN_RATE_PER_SOURCE = 3;
export const LAN_RATE_TOTAL = 50;
export const LAN_RATE_WINDOW_MS = 1000;
export const LAN_DUPLICATE_MS = 5000;
export const LAN_DUPLICATES_KEPT = 32;

const MAGIC = [0x4f, 0x4c, 0x41, 0x4e];
const TYPE_QUESTION = 1;
const TYPE_ANSWER = 2;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export interface LanQuestion {
  nonce: Uint8Array;
  gameId: string;
}
export interface LanAnswer {
  nonce: Uint8Array;
  port: number;
  players: number;
  maxPlayers: number;
  password: boolean;
  gameId: string;
  netVersion: string;
  lobbyName: string;
  hostName: string;
}

const header = (type: number, nonce: Uint8Array): number[] => {
  if (nonce.length !== 8) throw new RangeError("nonce is 8 bytes");
  return [...MAGIC, LAN_WIRE_VERSION, type, ...nonce];
};
const str = (s: string, [min, max]: readonly [number, number]): number[] => {
  const b = enc.encode(s);
  if (b.length < min || b.length > max) throw new RangeError(`string of ${b.length} bytes is outside ${min}..${max}`);
  return [b.length, ...b];
};

export function encodeLanQuestion(nonce: Uint8Array, gameId: string): Uint8Array {
  return Uint8Array.from([...header(TYPE_QUESTION, nonce), ...str(gameId, LAN_LIMITS.gameId)]);
}

export function encodeLanAnswer(a: LanAnswer): Uint8Array {
  if (!(a.port >= 1 && a.port <= 65535)) throw new RangeError("port");
  if (!(a.maxPlayers >= 1 && a.maxPlayers <= 255 && a.players >= 0 && a.players <= a.maxPlayers)) throw new RangeError("players");
  return Uint8Array.from([
    ...header(TYPE_ANSWER, a.nonce),
    a.port >> 8, a.port & 255, a.players, a.maxPlayers, a.password ? 1 : 0,
    ...str(a.gameId, LAN_LIMITS.gameId), ...str(a.netVersion, LAN_LIMITS.netVersion),
    ...str(a.lobbyName, LAN_LIMITS.lobbyName), ...str(a.hostName, LAN_LIMITS.hostName),
  ]);
}

function readHeader(b: Uint8Array, type: number): Uint8Array | null {
  if (b.length < 14 || b.length > LAN_MAX_DATAGRAM) return null;
  for (let i = 0; i < 4; i++) if (b[i] !== MAGIC[i]) return null;
  if (b[4] !== LAN_WIRE_VERSION || b[5] !== type) return null;
  return b.slice(6, 14);
}
function readStr(b: Uint8Array, at: number, [min, max]: readonly [number, number]): { s: string; next: number } | null {
  if (at >= b.length) return null;
  const n = b[at];
  if (n < min || n > max || at + 1 + n > b.length) return null;
  try {
    return { s: dec.decode(b.slice(at + 1, at + 1 + n)), next: at + 1 + n };
  } catch {
    return null;
  }
}

export function decodeLanQuestion(b: Uint8Array): LanQuestion | null {
  const nonce = readHeader(b, TYPE_QUESTION);
  if (!nonce) return null;
  const g = readStr(b, 14, LAN_LIMITS.gameId);
  if (!g || g.next !== b.length) return null;
  return { nonce, gameId: g.s };
}

export function decodeLanAnswer(b: Uint8Array): LanAnswer | null {
  const nonce = readHeader(b, TYPE_ANSWER);
  if (!nonce || b.length < 19) return null;
  const port = (b[14] << 8) | b[15];
  const players = b[16];
  const maxPlayers = b[17];
  if (port < 1 || maxPlayers < 1 || players > maxPlayers) return null;
  let at = 19;
  const out: string[] = [];
  for (const k of ["gameId", "netVersion", "lobbyName", "hostName"] as const) {
    const r = readStr(b, at, LAN_LIMITS[k]);
    if (!r) return null;
    out.push(r.s);
    at = r.next;
  }
  if (at !== b.length) return null;
  return { nonce, port, players, maxPlayers, password: (b[18] & 1) !== 0, gameId: out[0], netVersion: out[1], lobbyName: out[2], hostName: out[3] };
}

export type LanSourceClass = "loopback" | "private" | "link_local";

/** The class of an IPv4 source address, or null for a public (or non-IPv4) one. */
export function lanSourceClass(ip: string): LanSourceClass | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  if (p[0] === 127) return "loopback";
  if (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)) return "private";
  if (p[0] === 169 && p[1] === 254) return "link_local";
  return null;
}

/** Control characters and bidi overrides out, at most 24 UTF-16 units without splitting a pair (the hub's name rule). */
export function cleanLanName(s: string): string {
  let r = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch.length === 1 && (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069))) continue;
    r += ch;
  }
  if (r.length > LAN_NAME_UNITS) {
    r = r.slice(0, LAN_NAME_UNITS);
    const last = r.charCodeAt(r.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) r = r.slice(0, -1);
  }
  return r;
}

const nonceHex = (n: Uint8Array): string => Array.from(n, (x) => x.toString(16).padStart(2, "0")).join("");

/** True when a string fits its wire limit (bytes). */
export function lanFits(s: string, limit: readonly [number, number]): boolean {
  const n = enc.encode(s).length;
  return n >= limit[0] && n <= limit[1];
}

// ---- UDP seam ----------------------------------------------------------------------------------------------------

export interface LanUdp {
  /** Binds `address:port` (port 0 = the system picks) and resolves with the bound port. Rejects when it cannot. */
  bind(port: number, address: string, broadcast: boolean): Promise<number>;
  send(bytes: Uint8Array, host: string, port: number): void;
  onMessage: ((bytes: Uint8Array, fromAddress: string, fromPort: number) => void) | null;
  close(): void;
}

interface DgramSocket {
  bind(opts: { port: number; address: string; exclusive?: boolean }, cb: () => void): void;
  address(): { port: number };
  setBroadcast(on: boolean): void;
  send(msg: Uint8Array, port: number, host: string, cb?: (e: Error | null) => void): void;
  on(event: string, fn: (...a: any[]) => void): void;
  close(): void;
}

function builtin(id: string): unknown {
  const p = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  return p?.getBuiltinModule?.(["node", id].join(":"));
}

/** A UDP socket over node:dgram, or null where there is none (a browser). The bind is exclusive: a taken port rejects. */
export function nodeLanUdp(): LanUdp | null {
  const dgram = builtin("dgram") as { createSocket(o: { type: string; reuseAddr?: boolean }): DgramSocket } | undefined;
  if (!dgram) return null;
  const s = dgram.createSocket({ type: "udp4", reuseAddr: false });
  let closed = false;
  const out: LanUdp = {
    onMessage: null,
    bind: (port, address, broadcast) =>
      new Promise((resolve, reject) => {
        let bound = false;
        s.on("error", (e: Error) => {
          if (!bound) reject(e);
        });
        s.on("message", (m: Uint8Array, r: { address: string; port: number }) => {
          if (!closed) out.onMessage?.(new Uint8Array(m), r.address, r.port);
        });
        s.bind({ port, address, exclusive: true }, () => {
          bound = true;
          if (broadcast) s.setBroadcast(true);
          resolve(s.address().port);
        });
      }),
    send: (b, host, port) => {
      if (!closed) s.send(b, port, host, () => {});
    },
    close: () => {
      if (closed) return;
      closed = true;
      out.onMessage = null;
      try {
        s.close();
      } catch {
        /* already closed */
      }
    },
  };
  return out;
}

/**
 * The addresses a finder asks by default: the limited broadcast 255.255.255.255, plus the directed broadcast of every
 * network card that has a private or link-local IPv4 address (a PC with several cards sends the limited one out of one
 * card only). Empty-handed Node (no `os`) gives the limited one alone.
 */
export function lanBroadcastTargets(): string[] {
  const targets = ["255.255.255.255"];
  const os = builtin("os") as { networkInterfaces(): Record<string, { address: string; netmask: string; family: string | number; internal: boolean }[] | undefined> } | undefined;
  for (const list of Object.values(os?.networkInterfaces() ?? {})) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      const c = lanSourceClass(a.address);
      if (c !== "private" && c !== "link_local") continue;
      const ip = a.address.split(".").map(Number);
      const mask = a.netmask.split(".").map(Number);
      if (ip.length !== 4 || mask.length !== 4 || mask.some((x) => !(x >= 0 && x <= 255))) continue;
      const b = ip.map((x, i) => (x | (~mask[i] & 255)) & 255).join(".");
      if (!targets.includes(b)) targets.push(b);
    }
  }
  return targets;
}

const allLoopback = (targets: string[]): boolean => targets.length > 0 && targets.every((t) => /^127\.\d+\.\d+\.\d+$/.test(t));

// ---- the host's side ---------------------------------------------------------------------------------------------

export interface LanHostInfo {
  lobbyName: string;
  hostName: string;
  players: number;
  maxPlayers: number;
  password: boolean;
  /** The direct (TCP) port a joiner connects to. */
  port: number;
}

export type LanDrop = "bad_source" | "malformed" | "wrong_game" | "duplicate" | "rate_limited";
export interface LanHostStats {
  answered: number;
  bad_source: number;
  malformed: number;
  wrong_game: number;
  duplicate: number;
  rate_limited: number;
}

/** The answering rules (spec s.3), with no socket: `handle` gets a datagram and the address it came from. */
export class LanAnswerer {
  readonly stats: LanHostStats = { answered: 0, bad_source: 0, malformed: 0, wrong_game: 0, duplicate: 0, rate_limited: 0 };
  private seen: { key: string; at: number }[] = [];
  private winStart = 0;
  private winTotal = 0;
  private winBySource = new Map<string, number>();

  constructor(
    private readonly o: {
      gameId: string;
      netVersion: string;
      /** The lobby now, or null when none is open (nothing is answered). */
      info: () => LanHostInfo | null;
      /** Sends the answer to where the question came from. */
      reply: (bytes: Uint8Array, address: string, port: number) => void;
      now?: () => number;
    },
  ) {}

  /** Returns "answer" when an answer was sent, the drop counter name when the datagram was dropped, or "no_lobby". */
  handle(bytes: Uint8Array, address: string, port: number): "answer" | LanDrop | "no_lobby" {
    const drop = (k: LanDrop): LanDrop => {
      this.stats[k]++;
      return k;
    };
    if (lanSourceClass(address) === null) return drop("bad_source");
    const q = decodeLanQuestion(bytes);
    if (!q) return drop("malformed");
    if (q.gameId !== this.o.gameId) return drop("wrong_game");
    const info = this.o.info();
    if (!info) return "no_lobby";
    const now = (this.o.now ?? Date.now)();
    const key = `${address}/${nonceHex(q.nonce)}`;
    this.seen = this.seen.filter((e) => now - e.at < LAN_DUPLICATE_MS);
    if (this.seen.some((e) => e.key === key)) return drop("duplicate");
    if (now - this.winStart >= LAN_RATE_WINDOW_MS || now < this.winStart) {
      this.winStart = now;
      this.winTotal = 0;
      this.winBySource.clear();
    }
    const bySource = this.winBySource.get(address) ?? 0;
    if (bySource >= LAN_RATE_PER_SOURCE || this.winTotal >= LAN_RATE_TOTAL) return drop("rate_limited");
    this.winBySource.set(address, bySource + 1);
    this.winTotal++;
    this.seen.push({ key, at: now });
    if (this.seen.length > LAN_DUPLICATES_KEPT) this.seen.shift();
    const answer = encodeLanAnswer({
      nonce: q.nonce,
      port: info.port,
      players: Math.min(Math.max(0, info.players), Math.min(255, Math.max(1, info.maxPlayers))),
      maxPlayers: Math.min(255, Math.max(1, info.maxPlayers)),
      password: info.password,
      gameId: this.o.gameId,
      netVersion: this.o.netVersion,
      lobbyName: cleanLanName(info.lobbyName),
      hostName: cleanLanName(info.hostName),
    });
    this.stats.answered++;
    this.o.reply(answer, address, port);
    return "answer";
  }
}

export interface LanHostOptions {
  gameId: string;
  netVersion: string;
  info: () => LanHostInfo | null;
  /** UDP port to answer on (default 47840). */
  port?: number;
  /** "127.0.0.1" for a host that listens on the loopback only; default "0.0.0.0". */
  bindHost?: string;
  udp?: () => LanUdp | null;
  now?: () => number;
  /** Net log lines. */
  log?: (line: string) => void;
}

/** The host's answering socket. `start()` resolves true when it listens; false (with a log line) when it cannot. */
export class LanHost {
  readonly answerer: LanAnswerer;
  private udp: LanUdp | null = null;
  private closed = false;
  port = 0;

  constructor(private readonly o: LanHostOptions) {
    this.answerer = new LanAnswerer({
      gameId: o.gameId,
      netVersion: o.netVersion,
      info: o.info,
      now: o.now,
      reply: (b, a, p) => this.udp?.send(b, a, p),
    });
  }

  get listening(): boolean {
    return this.udp !== null;
  }

  async start(): Promise<boolean> {
    const port = this.o.port ?? LAN_DEFAULT_PORT;
    const bad = !lanFits(this.o.gameId, LAN_LIMITS.gameId) ? "game id is not 1 to 64 bytes" : !lanFits(this.o.netVersion, LAN_LIMITS.netVersion) ? "net version is not 1 to 32 bytes" : null;
    if (bad) {
      this.o.log?.(`LAN discovery is off for this lobby: ${bad}`);
      return false;
    }
    const udp = (this.o.udp ?? nodeLanUdp)();
    if (!udp) {
      this.o.log?.("LAN discovery is off for this lobby: no UDP sockets here");
      return false;
    }
    try {
      this.port = await udp.bind(port, this.o.bindHost ?? "0.0.0.0", false);
    } catch (e) {
      udp.close();
      const code = (e as { code?: string }).code;
      this.o.log?.(`LAN discovery is off for this lobby: UDP port ${port} ${code === "EADDRINUSE" ? "is taken" : `could not be opened (${(e as Error).message})`}`);
      return false;
    }
    if (this.closed) {
      udp.close();
      return false;
    }
    udp.onMessage = (b, a, p) => {
      if (!this.closed) this.answerer.handle(b, a, p);
    };
    this.udp = udp;
    this.o.log?.(`LAN discovery: answering questions for this lobby on UDP ${this.port}`);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.udp?.close();
    this.udp = null;
  }
}

// ---- the finder --------------------------------------------------------------------------------------------------

/** One row of the list a menu draws (one per host). */
export interface LanGame {
  address: string;
  port: number;
  lobbyName: string;
  hostName: string;
  players: number;
  maxPlayers: number;
  hasPassword: boolean;
  /** False: another `netVersion` (the row shows why it cannot be joined). */
  sameVersion: boolean;
  netVersion: string;
  lastSeenMs: number;
}

export type LanFinderStatus = "idle" | "running" | "off" | "browser" | "socket_failed";
export type LanFinderDrop = "malformed" | "bad_source" | "wrong_nonce" | "wrong_game";

export interface LanFinderOptions {
  gameId: string;
  netVersion: string;
  /** Where to ask. Default: lanBroadcastTargets(). A test or a `--local` game passes `["127.0.0.1"]`. */
  targets?: string[];
  /** The hosts' answering port (default 47840). */
  port?: number;
  /** False: `start()` does nothing and `status` is "off" (the blueprint's `hosting.lan` is false). Default true. */
  enabled?: boolean;
  askIntervalMs?: number;
  minGapMs?: number;
  rowTimeoutMs?: number;
  udp?: () => LanUdp | null;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Finds LAN hosts. `start()` opens one UDP socket on a port the system picks and asks now and then; `stop()` closes it,
 * empties the list and drops any late datagram. `games` is the list; `on("changed")` fires when it changes.
 */
export class LanFinder extends Emitter<{ changed: [games: LanGame[]]; status: [status: LanFinderStatus, reason: string] }> {
  readonly stats = { kept: 0, malformed: 0, bad_source: 0, wrong_nonce: 0, wrong_game: 0, full: 0 };
  status: LanFinderStatus = "idle";
  statusReason = "";
  private rows: LanGame[] = [];
  private udp: LanUdp | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nonces: string[] = [];
  private lastAsk = -Infinity;
  private askHeld = false;
  private run = 0;

  constructor(private readonly o: LanFinderOptions) {
    super();
  }

  get games(): LanGame[] {
    return this.rows.map((r) => ({ ...r }));
  }

  get running(): boolean {
    return this.status === "running";
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private setStatus(s: LanFinderStatus, reason = ""): void {
    this.status = s;
    this.statusReason = reason;
    this.emit("status", s, reason);
  }

  async start(): Promise<LanFinderStatus> {
    if (this.status === "running") return this.status;
    if (this.o.enabled === false) {
      this.setStatus("off", "hosting.lan is off");
      return this.status;
    }
    const udp = (this.o.udp ?? nodeLanUdp)();
    if (!udp) {
      this.setStatus("browser", "a browser cannot look for LAN games: it has no UDP sockets");
      return this.status;
    }
    const targets = this.o.targets ?? lanBroadcastTargets();
    const run = ++this.run;
    try {
      await udp.bind(0, allLoopback(targets) ? "127.0.0.1" : "0.0.0.0", !allLoopback(targets));
    } catch (e) {
      udp.close();
      this.setStatus("socket_failed", (e as Error).message);
      this.o.log?.(`LAN finder could not open its socket: ${(e as Error).message}`);
      return this.status;
    }
    if (run !== this.run) {
      udp.close(); // stop() came first
      return this.status;
    }
    this.udp = udp;
    udp.onMessage = (b, a, p) => this.onDatagram(run, b, a, p);
    this.setStatus("running");
    this.o.log?.(`LAN finder started (asking ${targets.join(", ")})`);
    this.ask();
    const every = Math.max(50, Math.min(this.o.askIntervalMs ?? LAN_ASK_INTERVAL_MS, this.o.minGapMs ?? LAN_MIN_GAP_MS) / 2);
    this.timer = setInterval(() => this.tick(), every);
    (this.timer as { unref?: () => void }).unref?.();
    return this.status;
  }

  stop(): void {
    this.run++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.udp?.close();
    const was = this.udp !== null;
    this.udp = null;
    this.nonces = [];
    this.askHeld = false;
    if (this.status === "running" || was) this.setStatus("idle");
    if (this.rows.length > 0) {
      this.rows = [];
      this.emit("changed", []);
    }
    if (was) this.o.log?.("LAN finder stopped");
  }

  /** Test seam: treat this nonce (16 hex characters) as one this finder sent. */
  rememberNonce(hex: string): void {
    this.nonces.push(hex);
    if (this.nonces.length > LAN_NONCES_KEPT) this.nonces.shift();
  }

  /** Asks at once (held until `minGapMs` after the last question when that is sooner). */
  askNow(): void {
    if (!this.udp) return;
    if (this.now() - this.lastAsk < (this.o.minGapMs ?? LAN_MIN_GAP_MS)) {
      this.askHeld = true;
      return;
    }
    this.ask();
  }

  private ask(): void {
    if (!this.udp) return;
    this.lastAsk = this.now();
    this.askHeld = false;
    const nonce = new Uint8Array(8);
    globalThis.crypto.getRandomValues(nonce);
    this.nonces.push(nonceHex(nonce));
    if (this.nonces.length > LAN_NONCES_KEPT) this.nonces.shift();
    const q = encodeLanQuestion(nonce, this.o.gameId);
    for (const t of this.o.targets ?? lanBroadcastTargets()) this.udp.send(q, t, this.o.port ?? LAN_DEFAULT_PORT);
  }

  private tick(): void {
    const now = this.now();
    if (this.askHeld || now - this.lastAsk >= (this.o.askIntervalMs ?? LAN_ASK_INTERVAL_MS)) {
      if (now - this.lastAsk >= (this.o.minGapMs ?? LAN_MIN_GAP_MS)) this.ask();
    }
    const keep = this.rows.filter((r) => now - r.lastSeenMs < (this.o.rowTimeoutMs ?? LAN_ROW_TIMEOUT_MS));
    if (keep.length !== this.rows.length) {
      this.rows = keep;
      this.emit("changed", this.games);
    }
  }

  /** The finder's rules for one datagram (spec s.4). Returns "ok", "other_version" or the drop reason. */
  receive(bytes: Uint8Array, address: string, port: number): "ok" | "other_version" | LanFinderDrop {
    const drop = (k: LanFinderDrop): LanFinderDrop => {
      this.stats[k]++;
      return k;
    };
    const a = decodeLanAnswer(bytes);
    if (!a) return drop("malformed");
    if (lanSourceClass(address) === null) return drop("bad_source");
    if (!this.nonces.includes(nonceHex(a.nonce))) return drop("wrong_nonce");
    if (a.gameId !== this.o.gameId) return drop("wrong_game");
    const sameVersion = a.netVersion === this.o.netVersion;
    const row: LanGame = {
      address,
      port: a.port,
      lobbyName: cleanLanName(a.lobbyName),
      hostName: cleanLanName(a.hostName),
      players: a.players,
      maxPlayers: a.maxPlayers,
      hasPassword: a.password,
      sameVersion,
      netVersion: a.netVersion,
      lastSeenMs: this.now(),
    };
    const i = this.rows.findIndex((r) => r.address === address && r.port === a.port);
    let changed = false;
    if (i >= 0) {
      const old = this.rows[i];
      changed = old.lobbyName !== row.lobbyName || old.hostName !== row.hostName || old.players !== row.players || old.maxPlayers !== row.maxPlayers || old.hasPassword !== row.hasPassword || old.sameVersion !== row.sameVersion || old.netVersion !== row.netVersion;
      this.rows[i] = row;
    } else if (this.rows.length < LAN_MAX_ROWS) {
      this.rows.push(row);
      changed = true;
    } else {
      this.stats.full++; // the table is full: the answer is ignored until a row expires
      return "ok";
    }
    this.stats.kept++;
    if (changed) this.emit("changed", this.games);
    return sameVersion ? "ok" : "other_version";
  }

  private onDatagram(run: number, bytes: Uint8Array, address: string, port: number): void {
    if (run !== this.run || !this.udp) return; // a late datagram after stop() reaches nothing
    this.receive(bytes, address, port);
  }
}
