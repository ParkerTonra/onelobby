/**
 * Pure rules of the room layer (spec/room.md): names, per-player data, seats, ban matching, auto start, the countdown
 * time base and join admission. No I/O, no clock: every function is pinned by spec/vectors/room.json.
 */

export type RoomRole = "player" | "spectator";
export type RoomState = "lobby" | "countdown" | "started";
export type RoomStatus = "connected" | "reconnecting";
export type LateJoinPolicy = "allow" | "spectate" | "refuse";
export type AutoStartMode = "off" | "all_ready" | "players";
export type SeatDroppedPolicy = "window" | "immediate";

/** Stable codes of the room layer (`nack.code`, `deny.code`, `OneLobbyError.code`). */
export type RoomErrorCode =
  | "bad_value" | "unknown_key" | "not_allowed" | "too_large" | "rate_limited" | "wrong_state" | "not_enough_players"
  | "lobby_full" | "spectators_full" | "in_game" | "banned" | "bad_password" | "kicked" | "disconnected"
  | "room_unsupported" | "password_required";

// ---- names (spec/room.md 4.1) ------------------------------------------------------------------------------------

/** A character class from code point ranges (kept numeric: the source holds no raw control or bidi characters). */
const classOf = (ranges: [number, number][]): string => "[" + ranges.map(([a, b]) => String.fromCodePoint(a) + (b > a ? "-" + String.fromCodePoint(b) : "")).join("") + "]";
const STRIP = new RegExp(classOf([[0x0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]]), "g");
const SPACE_RUN = new RegExp(classOf([[0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000]]) + "+", "g");

/** Steps 1-2 of the name rules: strip control, bidi and zero-width characters, collapse whitespace, trim. */
export function cleanText(s: string): string {
  return String(s ?? "").replace(STRIP, "").replace(SPACE_RUN, " ").trim();
}

/** `s` cut to at most `n` code points. */
export function clampCodePoints(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length <= n ? s : cps.slice(0, n).join("");
}

export function codePointLength(s: string): number {
  return Array.from(s).length;
}

export type TextFilter = (text: string, kind: "name" | "chat") => string;

/** Runs a host filter hook; a hook that throws or returns a non-string counts as no hook. */
export function applyFilter(filter: TextFilter | null | undefined, text: string, kind: "name" | "chat"): string {
  if (!filter) return text;
  try {
    const out = filter(text, kind);
    return typeof out === "string" ? out : text;
  } catch {
    return text;
  }
}

/** Steps 1-5 of the name rules (no dedupe). `peerId` makes the default `Player N`. */
export function baseName(input: string, peerId: number, maxLength = 24, filter?: TextFilter | null): string {
  const max = Math.max(1, Math.min(24, maxLength));
  let n = clampCodePoints(cleanText(input), max);
  if (filter) n = clampCodePoints(cleanText(applyFilter(filter, n, "name")), max);
  if (n === "" || n === "Player") n = `Player ${peerId}`;
  return n;
}

const lower = (s: string) => s.toLowerCase();

/** Step 6: `name` made unique among `others` (case-insensitive): "Name 2", "Name 3", ... within `maxLength`. */
export function dedupeName(name: string, others: readonly string[], maxLength = 24): string {
  const max = Math.max(1, Math.min(24, maxLength));
  const taken = new Set(others.map(lower));
  if (!taken.has(lower(name))) return name;
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`;
    const base = clampCodePoints(name, Math.max(1, max - suffix.length)).trimEnd();
    const cand = base + suffix;
    if (!taken.has(lower(cand))) return cand;
  }
}

/** The whole name pipeline (spec/room.md 4.1). */
export function effectiveName(input: string, peerId: number, others: readonly string[], maxLength = 24, filter?: TextFilter | null): string {
  return dedupeName(baseName(input, peerId, maxLength, filter), others, maxLength);
}

// ---- reasons and codes (5.1) -------------------------------------------------------------------------------------

export const DEFAULT_REASONS: Readonly<Record<string, string>> = Object.freeze({
  kicked: "The host removed you from the game.",
  denied: "The host did not let you in.",
  disconnected: "The host disconnected you.",
  banned: "You are banned from this game.",
  bad_password: "Wrong password.",
  lobby_full: "The game is full.",
  spectators_full: "No spectator seats are free.",
  in_game: "The game has already started.",
});
const FALLBACK_REASON = "You were removed from the game.";
export const CODE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const REASON_MAX = 120;

/** The plain sentence for a removal: the host's text when it has one, else the default of the code. */
export function removalReason(code: string, text?: string | null): string {
  const t = clampCodePoints(cleanText(text ?? ""), REASON_MAX);
  return t || DEFAULT_REASONS[code] || FALLBACK_REASON;
}

// ---- player id and addresses -------------------------------------------------------------------------------------

export const PLAYER_ID_PATTERN = /^[0-9a-f]{32}$/;
export const isPlayerId = (s: unknown): s is string => typeof s === "string" && PLAYER_ID_PATTERN.test(s);

/** A fresh player id: 16 random bytes as 32 lower-case hex characters. */
export function newPlayerId(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  return Array.from(random(16), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lower-case; an IPv4-mapped IPv6 address becomes its IPv4 form. */
export function normalizeIp(ip: string): string {
  const s = String(ip ?? "").trim().toLowerCase();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  return m ? m[1] : s;
}

export function isLoopbackIp(ip: string): boolean {
  const s = normalizeIp(ip);
  return s === "::1" || s.startsWith("127.") || s === "localhost";
}

// ---- bans (5.3) --------------------------------------------------------------------------------------------------

export interface BanEntry {
  id?: string;
  ip?: string;
  name?: string;
  reason?: string;
  code?: string;
  at: number;
}
export interface BanCandidate {
  id?: string;
  ip?: string;
}

/** Whether `entry` bans `c`: equal ids, or equal addresses when at least one side has no id. */
export function banMatches(entry: BanEntry, c: BanCandidate): boolean {
  if (entry.id && c.id) return entry.id === c.id;
  if (entry.ip && c.ip && (!entry.id || !c.id)) return normalizeIp(entry.ip) === normalizeIp(c.ip);
  return false;
}

// ---- per-player data (4.2) ---------------------------------------------------------------------------------------

export type DataType = "string" | "int" | "enum" | "bool" | "color";
export interface DataDecl {
  type: DataType;
  min?: number;
  max?: number;
  maxLength?: number;
  values?: string[];
  default?: string;
  hostOnly?: boolean;
}
export type DataSpec = Record<string, DataDecl>;

export const DATA_KEY_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;
export const DATA_MAX_BYTES = 1024;
export const BUILTIN_DATA: Readonly<DataSpec> = Object.freeze({
  color: { type: "color" },
  avatar: { type: "int", min: 0, max: 255, default: "0" },
  team: { type: "int", min: 0, max: 15, default: "0" },
});

/** The built-ins with the game's declarations on top (a declaration of the same key replaces it). */
export function mergeDataSpec(custom?: DataSpec | null): DataSpec {
  const out: DataSpec = {};
  for (const [k, v] of Object.entries(BUILTIN_DATA)) out[k] = { ...v };
  for (const [k, v] of Object.entries(custom ?? {})) out[k] = { ...v };
  return out;
}

/** One value against its declaration: the stored text, or null when invalid. "" (unset) is always valid. */
export function checkDataValue(decl: DataDecl, value: string): string | null {
  if (typeof value !== "string") return null;
  if (value === "") return "";
  switch (decl.type) {
    case "string": {
      const v = cleanText(value);
      return codePointLength(v) <= Math.min(64, decl.maxLength ?? 32) ? v : null;
    }
    case "int": {
      if (!/^(0|-?[1-9][0-9]*)$/.test(value)) return null;
      const n = Number(value);
      if (!Number.isSafeInteger(n) || Math.abs(n) > 2147483647) return null;
      return n >= (decl.min ?? 0) && n <= (decl.max ?? 255) ? value : null;
    }
    case "enum":
      return (decl.values ?? []).includes(value) ? value : null;
    case "bool":
      return value === "true" || value === "false" ? value : null;
    case "color":
      return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
    default:
      return null;
  }
}

export type DataResult = { ok: true; data: Record<string, string> } | { ok: false; code: RoomErrorCode; key?: string };

/**
 * Applies `set` to `before` under `spec`, atomically. `byHost` lets hostOnly keys through. "" removes a key.
 */
export function applyData(spec: DataSpec, before: Readonly<Record<string, string>>, set: Readonly<Record<string, unknown>>, byHost: boolean): DataResult {
  const next: Record<string, string> = { ...before };
  for (const [key, raw] of Object.entries(set)) {
    const decl = DATA_KEY_PATTERN.test(key) ? spec[key] : undefined;
    if (!decl) return { ok: false, code: "unknown_key", key };
    if (decl.hostOnly && !byHost) return { ok: false, code: "not_allowed", key };
    const v = typeof raw === "string" ? checkDataValue(decl, raw) : null;
    if (v === null) return { ok: false, code: "bad_value", key };
    if (v === "") delete next[key];
    else next[key] = v;
  }
  if (new TextEncoder().encode(JSON.stringify(next)).length > DATA_MAX_BYTES) return { ok: false, code: "too_large" };
  return { ok: true, data: next };
}

/** The declared defaults, applied at admission to the keys a player did not set. */
export function dataDefaults(spec: DataSpec, data: Record<string, string>): Record<string, string> {
  const out = { ...data };
  for (const [k, d] of Object.entries(spec)) if (d.default !== undefined && d.default !== "" && !(k in out)) out[k] = d.default;
  return out;
}

// ---- seats (4.3) -------------------------------------------------------------------------------------------------

/**
 * The seat for a player entering. `held`: seats of connected or reconnecting players. `memory`: `pid -> seat` of everyone
 * the host remembers (the caller removes the entry it returns `takeOver` for). Returns -1 when every seat is held.
 */
export function chooseSeat(maxPlayers: number, held: ReadonlySet<number>, memory: ReadonlyMap<string, number>, pid: string): { seat: number; returning: boolean; takeOver?: string } {
  const mine = pid ? memory.get(pid) : undefined;
  if (mine !== undefined && mine >= 0 && mine < maxPlayers && !held.has(mine)) return { seat: mine, returning: true };
  const others = new Map<number, string>();
  for (const [p, s] of memory) if (p !== pid) others.set(s, p);
  for (let s = 0; s < maxPlayers; s++) if (!held.has(s) && !others.has(s)) return { seat: s, returning: false };
  for (let s = 0; s < maxPlayers; s++) if (!held.has(s)) return { seat: s, returning: false, takeOver: others.get(s) };
  return { seat: -1, returning: false };
}

// ---- auto start (4.5) --------------------------------------------------------------------------------------------

export interface StartPlayer {
  role: RoomRole;
  status: RoomStatus;
  ready: boolean;
  legacy?: boolean;
}
export interface AutoStartRule {
  mode: AutoStartMode;
  autoStartPlayers: number;
  minPlayers: number;
}

/** Players that count for starting: role player, connected, not legacy. */
export const isEligible = (p: StartPlayer): boolean => p.role === "player" && p.status === "connected" && !p.legacy;

/** True when the auto-start condition holds now (the caller checks the state is "lobby"). */
export function autoStartHolds(rule: AutoStartRule, players: readonly StartPlayer[]): boolean {
  if (rule.mode === "off") return false;
  const eligible = players.filter(isEligible);
  if (rule.mode === "players") return eligible.length >= Math.max(rule.autoStartPlayers, rule.minPlayers, 1);
  const reconnecting = players.some((p) => p.role === "player" && p.status === "reconnecting" && !p.legacy);
  return !reconnecting && eligible.length >= Math.max(rule.minPlayers, 1) && eligible.every((p) => p.ready);
}

// ---- countdown time base (4.5) -----------------------------------------------------------------------------------

export const MAX_ONE_WAY_MS = 2000;

/** Milliseconds from now until the countdown ends, for a receiver that got `left` and last measured `rtt` (null = none). */
export function countdownRemaining(left: number, rtt: number | null): number {
  const oneWay = Math.min(MAX_ONE_WAY_MS, Math.max(0, (rtt ?? 0) / 2));
  return Math.max(0, Math.round(left - oneWay));
}

// ---- admission (4.8) ---------------------------------------------------------------------------------------------

export interface AdmitInput {
  banned: boolean;
  hasPassword: boolean;
  passwordOk: boolean;
  state: RoomState;
  lateJoin: LateJoinPolicy;
  role: RoomRole;
  players: number;
  maxPlayers: number;
  spectators: number;
  spectatorCap: number;
}
export type Admission = { ok: true; role: RoomRole } | { ok: false; code: RoomErrorCode };

/** The order of checks on a `join`: banned, password, late join, capacity. */
export function admit(i: AdmitInput): Admission {
  if (i.banned) return { ok: false, code: "banned" };
  if (i.hasPassword && !i.passwordOk) return { ok: false, code: "bad_password" };
  let role = i.role;
  if (i.state === "started") {
    if (i.lateJoin === "refuse") return { ok: false, code: "in_game" };
    if (i.lateJoin === "spectate") role = "spectator";
  }
  if (role === "player" && i.players >= i.maxPlayers) return { ok: false, code: "lobby_full" };
  if (role === "spectator" && i.spectators >= i.spectatorCap) return { ok: false, code: "spectators_full" };
  return { ok: true, role };
}

/** Constant-time string comparison (length is not hidden; passwords are at most 64 characters). */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
