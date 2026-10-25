/**
 * Blueprint v1: the `onelobby.json` settings file (docs/design/blueprint.md s.4, spec/blueprint.schema.json).
 * `parseBlueprint` validates by hand (the package has no dependencies), fills the defaults and returns a frozen
 * object. Errors carry the dotted `path` and the `rule` id the shared vectors (spec/vectors/blueprint.json) expect.
 */
import { OneLobbyError } from "./signaling.js";

export type BlueprintEngine = "web" | "node-browser" | "godot-csharp" | "unity" | "dotnet";

export interface Blueprint {
  readonly version: 1;
  readonly game: { readonly id: string; readonly netVersion: string; readonly title?: string };
  readonly engine?: BlueprintEngine;
  readonly hosting: {
    readonly direct: boolean;
    readonly server: boolean;
    readonly lobbyServer: string;
    readonly directPort: number;
    readonly openPort: boolean;
    readonly relayOnly: boolean;
    readonly allowedOrigins: readonly string[];
  };
  readonly lobby: {
    readonly maxPlayers: number;
    readonly listed: boolean;
    readonly approveJoins: boolean;
    readonly password: boolean;
    readonly lateJoin: boolean;
    readonly rejoin: boolean;
    readonly joinLink: boolean;
    readonly meta: Readonly<Record<string, string>>;
  };
  readonly sync: {
    readonly mode: "raw" | "lockstep" | "replication";
    readonly tickRate: number;
    readonly hashEveryTicks: number;
  };
  readonly players: { readonly identity: "name" | "anonymous" | "platform"; readonly maxNameLength: number };
  readonly chat: { readonly text: boolean; readonly voice: boolean; readonly voiceMode: "pushToTalk" | "voiceActivity" };
  readonly session: {
    readonly hostLeaves: "end" | "migrate";
    readonly pause: "off" | "host" | "anyone";
    readonly readyTimeoutMs: number;
    readonly peerTimeoutMs: number;
    readonly rateLimit?: { readonly messages: number; readonly perMs: number };
    readonly runInBackground: boolean;
  };
  readonly platforms: {
    readonly steam: boolean | { readonly appId?: number };
    readonly epic: boolean | { readonly [k: string]: string };
    readonly discord: boolean;
  };
  readonly ui: { readonly kind: "drop-in" | "generated" | "none"; readonly entry?: string; readonly theme: "light" | "dark" | "auto" };
}

/** What you may write: only `game.id` is required. */
export interface BlueprintInput {
  $schema?: string;
  $comment?: string;
  version?: 1;
  game: { $comment?: string; id: string; netVersion?: string; title?: string };
  engine?: BlueprintEngine;
  hosting?: {
    $comment?: string;
    direct?: boolean;
    server?: boolean;
    lobbyServer?: string;
    directPort?: number;
    openPort?: boolean;
    relayOnly?: boolean;
    allowedOrigins?: string[];
  };
  lobby?: {
    $comment?: string;
    maxPlayers?: number;
    listed?: boolean;
    approveJoins?: boolean;
    password?: boolean;
    lateJoin?: boolean;
    rejoin?: boolean;
    joinLink?: boolean;
    meta?: Record<string, string>;
  };
  sync?: { $comment?: string; mode?: "raw" | "lockstep" | "replication"; tickRate?: number; hashEveryTicks?: number };
  players?: { $comment?: string; identity?: "name" | "anonymous" | "platform"; maxNameLength?: number };
  chat?: { $comment?: string; text?: boolean; voice?: boolean; voiceMode?: "pushToTalk" | "voiceActivity" };
  session?: {
    $comment?: string;
    hostLeaves?: "end" | "migrate";
    pause?: "off" | "host" | "anyone";
    readyTimeoutMs?: number;
    peerTimeoutMs?: number;
    rateLimit?: { messages: number; perMs: number };
    runInBackground?: boolean;
  };
  platforms?: {
    $comment?: string;
    steam?: boolean | { appId?: number };
    epic?: boolean | { [k: string]: string };
    discord?: boolean;
  };
  ui?: { $comment?: string; kind?: "drop-in" | "generated" | "none"; entry?: string; theme?: "light" | "dark" | "auto" };
}

/** Identity function for TypeScript completion in a `.ts` config (like Vite's `defineConfig`). */
export function defineBlueprint<T extends BlueprintInput>(x: T): T {
  return x;
}

/** `bad_config`: the file is not a valid blueprint. `path` is dotted ("" = root), `rule` a vector rule id. */
export class BlueprintError extends OneLobbyError {
  constructor(public path: string, public rule: string, detail: string) {
    super("bad_config", `onelobby.json: ${path ? path + ": " : ""}${detail}`);
  }
}

// ---- schema as data (key order = spec/blueprint.schema.json) ----------------------------------------------------

type Node =
  | { k: "obj"; req?: string[]; props: Record<string, Node> }
  | { k: "str"; pattern?: RegExp; min?: number; max?: number }
  | { k: "int"; min?: number; max?: number; zeroOr?: boolean }
  | { k: "bool" }
  | { k: "enum"; vals: string[] }
  | { k: "const"; val: number }
  | { k: "strarr" }
  | { k: "meta" }
  | { k: "rate" }
  | { k: "steam" }
  | { k: "epic" };

const obj = (props: Record<string, Node>, req?: string[]): Node => ({ k: "obj", props, req });
const bool: Node = { k: "bool" };
const str = (o: { pattern?: RegExp; min?: number; max?: number } = {}): Node => ({ k: "str", ...o });
const int = (min?: number, max?: number, zeroOr?: boolean): Node => ({ k: "int", min, max, zeroOr });
const en = (...vals: string[]): Node => ({ k: "enum", vals });

const ROOT: Node = obj(
  {
    version: { k: "const", val: 1 },
    game: obj(
      { id: str({ pattern: /^[A-Za-z0-9._-]{1,64}$/ }), netVersion: str({ min: 1, max: 32 }), title: str({ max: 64 }) },
      ["id"],
    ),
    engine: en("web", "node-browser", "godot-csharp", "unity", "dotnet"),
    hosting: obj({
      direct: bool,
      server: bool,
      lobbyServer: str(),
      directPort: int(1024, 65535),
      openPort: bool,
      relayOnly: bool,
      allowedOrigins: { k: "strarr" },
    }),
    lobby: obj({
      maxPlayers: int(2, 64),
      listed: bool,
      approveJoins: bool,
      password: bool,
      lateJoin: bool,
      rejoin: bool,
      joinLink: bool,
      meta: { k: "meta" },
    }),
    sync: obj({ mode: en("raw", "lockstep", "replication"), tickRate: int(1, 120), hashEveryTicks: int(1, 100000) }),
    players: obj({ identity: en("name", "anonymous", "platform"), maxNameLength: int(1, 24) }),
    chat: obj({ text: bool, voice: bool, voiceMode: en("pushToTalk", "voiceActivity") }),
    session: obj({
      hostLeaves: en("end", "migrate"),
      pause: en("off", "host", "anyone"),
      readyTimeoutMs: int(0, 600000),
      peerTimeoutMs: int(6000, 600000, true),
      rateLimit: { k: "rate" },
      runInBackground: bool,
    }),
    platforms: obj({ steam: { k: "steam" }, epic: { k: "epic" }, discord: bool }),
    ui: obj({ kind: en("drop-in", "generated", "none"), entry: str(), theme: en("light", "dark", "auto") }),
  },
  ["game"],
);

/** Allowed (and ignored) anywhere. */
const IGNORED = new Set(["$schema", "$comment"]);

class Fail {
  constructor(public path: string, public rule: string, public detail: string) {}
}
const join = (p: string, k: string | number) => (p ? `${p}.${k}` : String(k));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function check(n: Node, v: unknown, path: string): void {
  switch (n.k) {
    case "obj": {
      if (!isObj(v)) throw new Fail(path, "type", "must be an object");
      for (const r of n.req ?? []) if (!(r in v)) throw new Fail(join(path, r), "required", "is required");
      for (const k of Object.keys(v)) if (!IGNORED.has(k) && !(k in n.props)) throw new Fail(join(path, k), "unknown_key", "unknown key");
      for (const [k, sub] of Object.entries(n.props)) if (k in v) check(sub, v[k], join(path, k));
      return;
    }
    case "str": {
      if (typeof v !== "string") throw new Fail(path, "type", "must be a string");
      if ((n.min !== undefined && v.length < n.min) || (n.max !== undefined && v.length > n.max))
        throw new Fail(path, "length", `must be ${n.min ?? 0} to ${n.max ?? "any"} characters`);
      if (n.pattern && !n.pattern.test(v)) throw new Fail(path, "pattern", `must match ${n.pattern.source}`);
      return;
    }
    case "int": {
      if (typeof v !== "number" || !Number.isInteger(v)) throw new Fail(path, "type", "must be an integer");
      if (n.zeroOr && v === 0) return;
      if ((n.min !== undefined && v < n.min) || (n.max !== undefined && v > n.max))
        throw new Fail(path, "range", `must be ${n.zeroOr ? "0 or " : ""}${n.min ?? "any"} to ${n.max ?? "any"}`);
      return;
    }
    case "bool":
      if (typeof v !== "boolean") throw new Fail(path, "type", "must be true or false");
      return;
    case "enum":
      if (typeof v !== "string" || !n.vals.includes(v)) throw new Fail(path, "enum", `must be one of ${n.vals.join(", ")}`);
      return;
    case "const":
      if (v !== n.val) throw new Fail(path, "const", `must be ${n.val}`);
      return;
    case "strarr": {
      if (!Array.isArray(v)) throw new Fail(path, "type", "must be an array of strings");
      v.forEach((x, i) => {
        if (typeof x !== "string") throw new Fail(join(path, i), "type", "must be a string");
      });
      return;
    }
    case "meta": {
      if (!isObj(v)) throw new Fail(path, "type", "must be an object of strings");
      const keys = Object.keys(v);
      if (keys.length > 16) throw new Fail(path, "length", "at most 16 keys");
      for (const k of keys) {
        if (k.length > 64) throw new Fail(join(path, k), "length", "key is longer than 64 characters");
        const x = v[k];
        if (typeof x !== "string") throw new Fail(join(path, k), "type", "must be a string");
        if (x.length > 64) throw new Fail(join(path, k), "length", "value is longer than 64 characters");
      }
      return;
    }
    case "rate":
      check(obj({ messages: int(1), perMs: int(1) }, ["messages", "perMs"]), v, path);
      return;
    case "steam":
      if (typeof v === "boolean") return;
      if (!isObj(v)) throw new Fail(path, "type", "must be true, false or { appId }");
      check(obj({ appId: int(1) }), v, path);
      return;
    case "epic": {
      if (typeof v === "boolean") return;
      if (!isObj(v)) throw new Fail(path, "type", "must be true, false or { productId }");
      for (const k of Object.keys(v)) if (!IGNORED.has(k) && typeof v[k] !== "string") throw new Fail(join(path, k), "type", "must be a string");
      return;
    }
  }
}

// ---- defaults and cross rules -----------------------------------------------------------------------------------

const sect = (x: unknown): Record<string, unknown> => (isObj(x) ? x : {});
function strip(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(strip);
  if (!isObj(o)) return o;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (k !== "$comment" && k !== "$schema") out[k] = strip(v);
  return out;
}
function deepFreeze<T>(o: T): T {
  if (typeof o === "object" && o !== null && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function fill(input: Record<string, unknown>): Blueprint {
  const game = sect(input.game);
  const engine = input.engine as BlueprintEngine | undefined;
  const hosting = sect(input.hosting);
  const lobby = sect(input.lobby);
  const sync = sect(input.sync);
  const players = sect(input.players);
  const chat = sect(input.chat);
  const session = sect(input.session);
  const platforms = sect(input.platforms);
  const ui = sect(input.ui);
  const tickRate = (sync.tickRate as number | undefined) ?? 20;
  const web = engine === "web";
  const out = {
    version: 1,
    game: { id: game.id, netVersion: game.netVersion ?? "1", ...(game.title !== undefined ? { title: game.title } : {}) },
    ...(engine !== undefined ? { engine } : {}),
    hosting: {
      direct: hosting.direct ?? !web,
      server: hosting.server ?? web,
      lobbyServer: hosting.lobbyServer ?? "",
      directPort: hosting.directPort ?? 47810,
      openPort: hosting.openPort ?? true,
      relayOnly: hosting.relayOnly ?? false,
      allowedOrigins: hosting.allowedOrigins ?? [],
    },
    lobby: {
      maxPlayers: lobby.maxPlayers ?? 4,
      listed: lobby.listed ?? false,
      approveJoins: lobby.approveJoins ?? false,
      password: lobby.password ?? false,
      lateJoin: lobby.lateJoin ?? true,
      rejoin: lobby.rejoin ?? true,
      joinLink: lobby.joinLink ?? (web || engine === "node-browser"),
      meta: lobby.meta ?? {},
    },
    sync: { mode: sync.mode ?? "raw", tickRate, hashEveryTicks: sync.hashEveryTicks ?? tickRate },
    players: { identity: players.identity ?? "name", maxNameLength: players.maxNameLength ?? 24 },
    chat: { text: chat.text ?? true, voice: chat.voice ?? false, voiceMode: chat.voiceMode ?? "pushToTalk" },
    session: {
      hostLeaves: session.hostLeaves ?? "end",
      pause: session.pause ?? "off",
      readyTimeoutMs: session.readyTimeoutMs ?? 15000,
      peerTimeoutMs: session.peerTimeoutMs ?? 0,
      ...(session.rateLimit !== undefined ? { rateLimit: session.rateLimit } : {}),
      runInBackground: session.runInBackground ?? true,
    },
    platforms: { steam: platforms.steam ?? false, epic: platforms.epic ?? false, discord: platforms.discord ?? false },
    ui: {
      kind: ui.kind ?? (web ? "drop-in" : "generated"),
      ...(ui.entry !== undefined ? { entry: ui.entry } : {}),
      theme: ui.theme ?? "auto",
    },
  };
  return out as unknown as Blueprint;
}

function crossRules(b: Blueprint): void {
  if (!b.hosting.direct && !b.hosting.server) throw new Fail("hosting", "hosting_none", "at least one of direct, server must be true");
  if (b.lobby.listed && b.lobby.approveJoins) throw new Fail("lobby", "listed_and_approve", "listed and approveJoins cannot both be true");
  if (b.engine === "web" && b.hosting.direct) throw new Fail("hosting.direct", "direct_needs_listener", "engine web cannot host direct (a browser cannot listen on a port)");
  const csharp = b.engine === "godot-csharp" || b.engine === "unity" || b.engine === "dotnet";
  if (b.sync.mode === "replication" && !csharp) throw new Fail("sync.mode", "replication_needs_csharp", "replication needs engine godot-csharp, unity or dotnet");
  if (b.sync.mode === "replication" && b.session.hostLeaves === "migrate") throw new Fail("session.hostLeaves", "migrate_with_replication", "replication has no host migration; use end");
  if (b.session.hostLeaves === "migrate" && !b.hosting.server) throw new Fail("session.hostLeaves", "migrate_needs_server", "migrate needs hosting.server (direct lobbies always end)");
}

/**
 * Validate `json` (an already-parsed onelobby.json), fill every default and return the frozen result.
 * Throws a `BlueprintError` (`OneLobbyError` code `bad_config`, with `path` and `rule`) on the first problem.
 */
export function parseBlueprint(json: unknown): Blueprint {
  let b: Blueprint;
  try {
    check(ROOT, json, "");
    b = fill(strip(json) as Record<string, unknown>);
    crossRules(b);
  } catch (e) {
    if (e instanceof Fail) throw new BlueprintError(e.path, e.rule, e.detail);
    throw e;
  }
  return deepFreeze(b);
}
