/**
 * The player's own multiplayer settings (spec/settings.md): a name, a relay line, the last join code and a lobby server
 * address, kept on the player's machine in the same key/value store as the player id, and applied by `OneLobby` as
 * defaults. Nothing here is sent anywhere: a setting leaves the machine only as the value a call already sends.
 *
 *     const kit = new OneLobby({ gameId, netVersion, lobbyServer: "", settingsFile: "settings.json" });
 *     kit.settings.save({ name: "Sam", relay: field.value });   // { ok, rejected: ["relay"] } when the line is not a relay
 *     field.value = kit.settings.maskedRelay();                // turn:relay.example.com:3478 <hidden> <hidden>
 */
import { cleanText, clampCodePoints } from "./room-rules.js";
import { normalizeCode } from "./crockford.js";
import { parseTurnLine } from "./turn.js";
import { lobbyServerUrl } from "./ui/server-url.js";
import { memoryStore, type KeyValueStore } from "./storage.js";
import type { IceServer } from "./transport.js";

export type SettingsField = "name" | "relay" | "lastCode" | "server";
export const SETTINGS_FIELDS: readonly SettingsField[] = ["name", "relay", "lastCode", "server"];

/** The four settings; an empty string is "none". */
export interface SettingsValues {
  name: string;
  relay: string;
  lastCode: string;
  server: string;
}

/** The environment variable that overrides each setting for one run (Node only; a browser has no environment). */
export const SETTINGS_ENV: Readonly<Record<SettingsField, string>> = Object.freeze({
  name: "ONELOBBY_NAME",
  relay: "ONELOBBY_RELAY",
  lastCode: "ONELOBBY_LAST_CODE",
  server: "ONELOBBY_LOBBY_SERVER",
});

/** Which defaults the kit applies (all on). `false` for the whole option switches them all off. */
export interface SettingsUse {
  /** Use the saved name when the game gives none. */
  name?: boolean;
  /** Add the saved relay line to this player's ICE list. */
  relay?: boolean;
  /** Use the saved lobby server when neither the call nor onelobby.json gives one. */
  server?: boolean;
  /** Save the code after a successful host or join. */
  lastCode?: boolean;
}

export type EnvSource = Record<string, string | undefined>;

/** The store key of a game's settings. */
export const settingsKey = (gameId: string) => `onelobby.settings.${gameId}`;

/** The fixed warning for a saved relay line that does not parse. It never holds the line. */
export const RELAY_SKIPPED_WARNING = "The saved relay line is not valid, so it is not used.";
/** What a masked relay shows in place of the user name and the credential (spec/diagnostics.md s.6). */
export const HIDDEN = "<hidden>";

// ---- cleaning (spec/settings.md s.1) ---------------------------------------------------------------------------------

/** Name rules steps 1-3 (spec/room.md s.4.1); a result of exactly `Player` counts as no name. */
export function cleanName(input: unknown, maxLength = 24): string {
  if (typeof input !== "string") return "";
  const n = clampCodePoints(cleanText(input), Math.max(1, Math.min(24, maxLength)));
  return n === "Player" ? "" : n;
}

/** The relay line trimmed, or null when it is not empty and the relay line parser rejects it. */
export function cleanRelay(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.trim();
  if (t === "") return "";
  try {
    parseTurnLine(t);
    return t;
  } catch {
    return null;
  }
}

/** A lobby code (6 characters) or direct join code (11) the way a pasted code is cleaned, or null. */
export function cleanLastCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.trim();
  if (t === "") return "";
  const six = normalizeCode(t);
  if (six) return six;
  const s = t.replace(/[ \-]/g, "").replace(/[a-z]/g, (c) => c.toUpperCase()).replace(/[IL]/g, "1").replace(/O/g, "0");
  return /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{11}$/.test(s) ? s : null;
}

/** The lobby server address as a ws(s) URL (the `<one-lobby server>` rule plus a port check), "" for none, or null. */
export function cleanServer(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.trim();
  if (t === "") return "";
  const url = lobbyServerUrl(t);
  if (!url) return null;
  const m = /^wss?:\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)(?::(\d*))?(?:[/?#]|$)/i.exec(url);
  if (!m) return null;
  if (!/^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)$/.test(m[1])) return null;
  if (m[2] !== undefined && !(/^\d{1,5}$/.test(m[2]) && Number(m[2]) >= 1 && Number(m[2]) <= 65535)) return null;
  return url;
}

/** `cleanName` / `cleanRelay` / `cleanLastCode` / `cleanServer` by field name; null = invalid. */
export function cleanSetting(field: SettingsField, input: unknown): string | null {
  switch (field) {
    case "name": return cleanName(input);
    case "relay": return cleanRelay(input);
    case "lastCode": return cleanLastCode(input);
    case "server": return cleanServer(input);
  }
}

/**
 * The relay line for showing in a settings field: the URLs stay readable, the user name and the credential are
 * `<hidden>` (spec/settings.md s.4). Empty stays empty; a line that does not parse is `<hidden>` whole.
 */
export function maskRelay(line: string): string {
  const t = String(line ?? "").trim();
  if (t === "") return "";
  try {
    const e = parseTurnLine(t);
    return [[e.urls].flat().join(","), ...(e.username ? [HIDDEN] : []), ...(e.credential ? [HIDDEN] : [])].join(" ");
  } catch {
    return HIDDEN;
  }
}

/** The ICE entry for a relay line, or null when it is empty or invalid. */
export function relayEntry(line: string): IceServer | null {
  const t = String(line ?? "").trim();
  if (t === "") return null;
  try {
    return parseTurnLine(t);
  } catch {
    return null;
  }
}

/** `user:pass@` dropped from an address before it goes in a log (spec/settings.md s.4). */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");
}

// ---- the store ------------------------------------------------------------------------------------------------------

function nodeEnv(): EnvSource | null {
  const p = (globalThis as { process?: { env?: EnvSource; versions?: { node?: string } } }).process;
  return p?.versions?.node && p.env ? p.env : null;
}

export interface SaveResult {
  /** True when every field in the patch was written. */
  ok: boolean;
  /** The fields that did not clean (never their text). */
  rejected: SettingsField[];
}

/** One game's settings in a key/value store, with the environment on top. */
export class PlayerSettings {
  private readonly store: KeyValueStore;
  private readonly key: string;
  private readonly env: EnvSource | null;
  private lastWritten: string | null = null;
  private writeFailed = false;

  /**
   * @param env The variables that override (default: the Node process environment, none in a browser). null: never read one.
   */
  constructor(store: KeyValueStore | null, readonly gameId: string, env?: EnvSource | null) {
    this.store = store ?? memoryStore();
    this.key = settingsKey(gameId);
    this.env = env === undefined ? nodeEnv() : env;
  }

  private rawText(): string | null {
    if (this.writeFailed) return this.lastWritten;
    try {
      return this.store.getItem(this.key);
    } catch {
      return this.lastWritten;
    }
  }

  /** The stored object, or {} for nothing, unreadable text or anything that is not an object. */
  private rawObject(): Record<string, unknown> {
    const text = this.rawText();
    if (!text) return {};
    try {
      const o: unknown = JSON.parse(text);
      return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** The stored values, cleaned; a missing, corrupt or odd value reads as empty. Never throws. */
  load(): SettingsValues {
    const o = this.rawObject();
    const out: SettingsValues = { name: "", relay: "", lastCode: "", server: "" };
    for (const f of SETTINGS_FIELDS) out[f] = cleanSetting(f, o[f]) ?? "";
    return out;
  }

  private envValue(field: SettingsField): string {
    const raw = this.env?.[SETTINGS_ENV[field]];
    return typeof raw === "string" && raw.trim() !== "" ? raw : "";
  }

  /** The values this run uses: a clean, non-empty environment variable over the stored value (never written back). */
  effective(): SettingsValues {
    const out = this.load();
    for (const f of SETTINGS_FIELDS) {
      const e = this.envValue(f);
      const c = e === "" ? null : cleanSetting(f, e);
      if (c) out[f] = c;
    }
    return out;
  }

  /**
   * Writes the fields in `patch` (an empty value removes one); every unknown field already stored is kept. A field that does
   * not clean is not written and is listed in `rejected`. Never throws; a store that cannot write keeps the values for the session.
   */
  save(patch: Partial<SettingsValues>): SaveResult {
    const o = this.rawObject();
    const rejected: SettingsField[] = [];
    for (const f of SETTINGS_FIELDS) {
      if (!(f in patch) || patch[f] === undefined) continue;
      const c = cleanSetting(f, patch[f]);
      if (c === null) rejected.push(f);
      else if (c === "") delete o[f];
      else o[f] = c;
    }
    o.v = Number.isInteger(o.v) ? o.v : 1;
    const text = JSON.stringify(o);
    this.lastWritten = text;
    try {
      this.store.setItem(this.key, text);
      this.writeFailed = false;
    } catch {
      this.writeFailed = true;
    }
    return { ok: rejected.length === 0, rejected };
  }

  /** Forgets every saved setting (unknown fields too). */
  clear(): void {
    this.lastWritten = null;
    try {
      this.store.removeItem(this.key);
      this.writeFailed = false;
    } catch {
      this.writeFailed = true;
    }
  }

  /** The relay line this run uses, masked for a settings field (see `maskRelay`). */
  maskedRelay(): string {
    return maskRelay(this.effective().relay);
  }

  /**
   * The ICE entry of the effective relay line (null when none), and whether a relay line is set that does not parse
   * (stored or environment: skipped, so the caller warns once).
   */
  relayStatus(): { entry: IceServer | null; invalid: boolean } {
    const storedRaw = this.rawObject().relay;
    const env = this.envValue("relay");
    const invalid = (typeof storedRaw === "string" && storedRaw.trim() !== "" && cleanRelay(storedRaw) === null) || (env !== "" && cleanRelay(env) === null);
    return { entry: relayEntry(this.effective().relay), invalid };
  }
}
