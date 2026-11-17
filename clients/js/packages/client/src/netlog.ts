/**
 * The net log (spec/diagnostics.md s.5-6): a ring buffer of connection steps with monotonic timings, a text export with
 * a stable line format, and the masking rule. The log stays on the player's machine; nothing here sends anything.
 */
import type { Clock } from "./clock.js";

export type NetLogKind = "sig" | "lobby" | "sdp" | "cand" | "ice" | "chan" | "route" | "retry" | "error" | "diag" | "info";

export interface NetLogEntry {
  /** From 1, never reused: a reader sees how many entries the ring dropped. */
  seq: number;
  /** ms since the log was created (monotonic clock). */
  t: number;
  kind: NetLogKind;
  /** At most 200 characters; no address, credential or password. */
  text: string;
  /** The address the step belongs to, in memory only: printed by `export({ includeAddresses: true })`. */
  addr?: string;
  /** The error code, for `error` entries. */
  code?: string;
}

export const NETLOG_DEFAULT_CAPACITY = 500;
export const NETLOG_MIN_CAPACITY = 50;
export const NETLOG_MAX_CAPACITY = 5000;
export const NETLOG_TEXT_MAX = 200;

const HIDDEN = "<hidden>";

// 1. credentials, always
const KEYED = /\b(username|credential|password|pwd|token|secret)=([^\s,"]*)/g;
const KEYED_JSON = /("(?:username|credential|password|pwd|token|secret)"\s*:\s*")([^"]*)(")/g;
const ICE_SECRET = /(a=ice-(?:ufrag|pwd):)(\S+)/g;
const TURN_LINE = /\b(turns?:[^\s?]+(?:\?\S*)?)\s+\S+\s+\S+/g;
const URL_USER = /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*@/g;
// 2. addresses
const IPV6_BRACKET = /\[[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*\](?::\d{1,5})?/g;
const IPV6_BARE = /(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:])/g;
const MDNS = /\b[0-9A-Fa-f-]{8,}\.local\b/g;
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`\\b${OCTET}(?:\\.${OCTET}){3}(?::\\d{1,5})?\\b`, "g");

function looksLikeIpv6(s: string): boolean {
  const colons = s.split(":").length - 1;
  return colons >= 2 && (s.includes("::") || (colons === 7 && !s.startsWith(":") && !s.endsWith(":")));
}

/**
 * Masks one line of log text. Credentials and ICE secrets are always hidden; IPv4, IPv6 and mDNS names are replaced by
 * `<ip4>`, `<ip6>` and `<mdns>` unless `includeAddresses` (spec/diagnostics.md s.6).
 */
export function maskText(text: string, includeAddresses = false): string {
  let s = text
    .replace(KEYED, (_m, k) => `${k}=${HIDDEN}`)
    .replace(KEYED_JSON, (_m, a, _v, c) => `${a}${HIDDEN}${c}`)
    .replace(ICE_SECRET, (_m, a) => `${a}${HIDDEN}`)
    .replace(TURN_LINE, (_m, url) => `${url} ${HIDDEN} ${HIDDEN}`)
    .replace(URL_USER, (_m, scheme) => `${scheme}${HIDDEN}@`);
  if (includeAddresses) return s;
  s = s.replace(IPV6_BRACKET, (m) => (looksLikeIpv6(m.replace(/^\[|\](?::\d+)?$/g, "")) ? "<ip6>" : m));
  s = s.replace(IPV6_BARE, (m) => (looksLikeIpv6(m) ? "<ip6>" : m));
  s = s.replace(MDNS, "<mdns>");
  return s.replace(IPV4, "<ip4>");
}

export interface NetLogMeta {
  /** `onelobby-js 0.8.0` */
  client: string;
  protocol: string;
  platform: string;
}

export interface NetLogOptions {
  /** Ring size: default 500, clamped to 50..5000 (`raw` skips the clamp: tests). */
  capacity?: number;
  /** The kit's clock: `t` counts from the log's creation on it. */
  clock?: Pick<Clock, "now">;
  meta?: Partial<NetLogMeta>;
  /** Where `save()` writes when given no path (Node), and where the log is flushed on exit. */
  path?: string;
  /**
   * Node: every entry is also appended to `path` as it is added (the first one writes the whole log), so a killed process still has
   * its log. Needs a path; masked, never addresses. `netLogEnvPath()` (the `ONELOBBY_NETLOG` variable) turns it on for a kit.
   */
  live?: boolean;
  /** Key under which a `pagehide` stores the entries in session storage so a reload can export the last session (browsers). */
  storageKey?: string;
  /** Do not clamp `capacity` (tests of the ring). */
  raw?: boolean;
}

interface NodeFs {
  writeFileSync(path: string, data: string): void;
  appendFileSync(path: string, data: string): void;
  mkdirSync(path: string, opts: { recursive: true }): void;
}
interface NodePath {
  dirname(p: string): string;
}
type NodeProc = {
  on(event: string, fn: (...a: unknown[]) => void): void;
  getBuiltinModule?: (id: string) => unknown;
  versions?: { node?: string };
};

function nodeProcess(): NodeProc | null {
  const p = (globalThis as { process?: NodeProc }).process;
  return p && p.versions?.node ? p : null;
}

/** The ring buffer. One per kit (`kit.netLog`); the lobby, links and signaling add to it. */
export class NetLog {
  private ring: NetLogEntry[] = [];
  private nextSeq = 1;
  private readonly cap: number;
  private readonly now: () => number;
  private readonly t0: number;
  private meta: NetLogMeta;
  private lastSession: NetLogEntry[] | null = null;
  /** Where `save()` and the exit flush write (Node); null: nowhere. */
  path: string | null;
  /** True: every entry is also appended to `path` as it is added (Node); see `NetLogOptions.live`. */
  live: boolean;
  private liveOpen = false;

  constructor(opts: NetLogOptions = {}) {
    const c = opts.capacity ?? NETLOG_DEFAULT_CAPACITY;
    this.cap = opts.raw ? Math.max(1, Math.floor(c)) : Math.min(NETLOG_MAX_CAPACITY, Math.max(NETLOG_MIN_CAPACITY, Math.floor(c) || NETLOG_DEFAULT_CAPACITY));
    this.now = opts.clock ? () => opts.clock!.now() : () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    this.t0 = this.now();
    this.meta = { client: "onelobby", protocol: "lk1", platform: "unknown", ...opts.meta };
    this.path = opts.path ?? null;
    this.live = !!opts.live;
    if (opts.storageKey) this.keepAcrossReload(opts.storageKey);
  }

  /** Adds a step. `text` is cut to 200 characters; keep addresses in `addr`, never in `text`. */
  add(kind: NetLogKind, text: string, extra: { addr?: string; code?: string } = {}): void {
    const e: NetLogEntry = { seq: this.nextSeq++, t: Math.max(0, Math.round(this.now() - this.t0)), kind, text: String(text).slice(0, NETLOG_TEXT_MAX) };
    if (extra.addr) e.addr = extra.addr;
    if (extra.code) e.code = extra.code;
    this.ring.push(e);
    if (this.ring.length > this.cap) this.ring.shift();
    if (this.live && this.path) this.appendLive(e);
  }

  // Live mode: the first entry writes the whole log (header and the ring), later ones append one masked line.
  private appendLive(e: NetLogEntry): void {
    try {
      const proc = nodeProcess();
      const fs = proc?.getBuiltinModule?.(["node", "fs"].join(":")) as NodeFs | undefined;
      const pth = proc?.getBuiltinModule?.(["node", "path"].join(":")) as NodePath | undefined;
      if (!fs || !pth || !this.path) return;
      if (!this.liveOpen) {
        this.liveOpen = true;
        fs.mkdirSync(pth.dirname(this.path), { recursive: true });
        fs.writeFileSync(this.path, this.export());
        return;
      }
      fs.appendFileSync(this.path, maskText(`#${e.seq} +${e.t}ms ${e.kind} ${e.text}`, false) + "\n");
    } catch {
      /* the log is a courtesy: a failed write never matters */
    }
  }

  /** The entries kept, oldest first. */
  get entries(): readonly NetLogEntry[] {
    return this.ring;
  }

  /** How many entries the ring dropped. */
  get dropped(): number {
    return this.nextSeq - 1 - this.ring.length;
  }

  /** Sets the header facts (client, protocol, platform). */
  setMeta(meta: Partial<NetLogMeta>): void {
    this.meta = { ...this.meta, ...meta };
  }

  clear(): void {
    this.ring = [];
  }

  /**
   * The log as text (spec/diagnostics.md s.5): a header, then one line per entry, oldest first. Addresses are masked
   * unless `includeAddresses`; credentials never print either way.
   */
  export(opts: { includeAddresses?: boolean } = {}): string {
    return render(this.ring, this.meta, this.dropped, !!opts.includeAddresses);
  }

  /**
   * The previous page session's log (browsers: stored on `pagehide`, read back after a reload), as text; null when there
   * is none.
   */
  exportLastSession(opts: { includeAddresses?: boolean } = {}): string | null {
    return this.lastSession ? render(this.lastSession, this.meta, 0, !!opts.includeAddresses) : null;
  }

  /**
   * Writes the export to a file (Node, or any runtime with a file system) and returns the path: `path`, else the
   * configured log path. Rejects when there is no file system or no path.
   */
  async save(path?: string, opts: { includeAddresses?: boolean } = {}): Promise<string> {
    const target = path ?? this.path;
    if (!target) throw new Error("no log path: pass one, or set diagnostics.logPath");
    const proc = nodeProcess();
    const fs = proc?.getBuiltinModule?.(["node", "fs"].join(":")) as NodeFs | undefined;
    const pth = proc?.getBuiltinModule?.(["node", "path"].join(":")) as NodePath | undefined;
    if (!fs || !pth) throw new Error("this runtime has no file system: use download()");
    fs.mkdirSync(pth.dirname(target), { recursive: true });
    fs.writeFileSync(target, this.export(opts));
    return target;
  }

  /**
   * Browsers: offers the export as a file download (a text file named `filename`) and returns the text. Does nothing
   * but return the text where there is no DOM.
   */
  download(filename = "onelobby-netlog.txt", opts: { includeAddresses?: boolean } = {}): string {
    const text = this.export(opts);
    if (typeof document !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined" && URL.createObjectURL) {
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return text;
  }

  /** Writes the masked log to the configured path now, swallowing errors (the exit and crash flush). */
  flush(): void {
    if (!this.path) return;
    try {
      const proc = nodeProcess();
      const fs = proc?.getBuiltinModule?.(["node", "fs"].join(":")) as NodeFs | undefined;
      const pth = proc?.getBuiltinModule?.(["node", "path"].join(":")) as NodePath | undefined;
      if (!fs || !pth) return;
      fs.mkdirSync(pth.dirname(this.path), { recursive: true });
      fs.writeFileSync(this.path, this.export());
    } catch {
      /* the log is a courtesy: a failed write never matters */
    }
  }

  /**
   * Node: flush to `path` when the process exits and when it dies from an uncaught error. The crash hook only observes
   * (`uncaughtExceptionMonitor`), so the process still crashes as it would have.
   */
  flushOnExit(path?: string): void {
    if (path) this.path = path;
    const proc = nodeProcess();
    if (!proc) return;
    proc.on("exit", () => this.flush());
    proc.on("uncaughtExceptionMonitor", () => this.flush());
  }

  private keepAcrossReload(key: string): void {
    const g = globalThis as { sessionStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void }; addEventListener?: (e: string, f: () => void) => void };
    let store: NonNullable<typeof g.sessionStorage> | null = null;
    try {
      store = g.sessionStorage ?? null;
    } catch {
      store = null;
    }
    if (!store) return;
    try {
      const raw = store.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as NetLogEntry[];
        if (Array.isArray(parsed)) this.lastSession = parsed.filter((e) => e && typeof e.seq === "number" && typeof e.text === "string");
      }
    } catch {
      /* a stale or blocked entry: no last session */
    }
    g.addEventListener?.("pagehide", () => {
      try {
        store!.setItem(key, JSON.stringify(this.ring));
      } catch {
        /* quota: the last session just is not kept */
      }
    });
  }
}

/** The log file the `ONELOBBY_NETLOG` environment variable asks for (Node), or null. Give each copy of a game on one PC its own file. */
export function netLogEnvPath(env?: Record<string, string | undefined>): string | null {
  const e = env ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const v = e?.ONELOBBY_NETLOG?.trim();
  return v ? v : null;
}

function render(entries: readonly NetLogEntry[], meta: NetLogMeta, dropped: number, includeAddresses: boolean): string {
  const lines = [
    "# onelobby netlog v1",
    `# client ${meta.client} protocol ${meta.protocol} platform ${meta.platform}`,
    `# entries ${entries.length} dropped ${dropped}`,
    includeAddresses ? "# addresses included" : "# addresses masked",
  ];
  for (const e of entries) {
    let line = maskText(`#${e.seq} +${e.t}ms ${e.kind} ${e.text}`, includeAddresses);
    if (includeAddresses && e.addr) line += ` addr=${maskText(e.addr, true)}`;
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}
