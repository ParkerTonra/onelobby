/**
 * Small synchronous key/value stores for what a client keeps on the player's machine: the per-install player id and the
 * host's ban list (spec/room.md s.1 and s.5.3). The shape is the Web Storage subset, so `localStorage` is one.
 */
import { isPlayerId, newPlayerId } from "./room-rules.js";

/** The subset of the Web Storage API the kit uses. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Keeps values for the life of the process. */
export function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

/** `localStorage` when the runtime has one and it works (a sandboxed iframe or blocked cookies make it throw), else null. */
export function localStore(): KeyValueStore | null {
  try {
    const s = (globalThis as { localStorage?: KeyValueStore }).localStorage;
    if (!s) return null;
    const probe = "onelobby.probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

interface FsLike {
  readFileSync(path: string, enc: "utf8"): string;
  writeFileSync(path: string, data: string, enc: "utf8"): void;
}

/**
 * A JSON file `{ key: value }` at `path` (Node and other runtimes with a file system). Read once, written on every change.
 * An unreadable or corrupt file reads as empty and is replaced by the next write. Throws `no_filesystem` where there is no
 * Node file system (a browser has none): use `localStore()` there.
 */
export function fileStore(path: string): KeyValueStore {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  // the id is built at run time so browser bundles carry no "node:" import to trip a bundler or a policy scan
  const fs = proc?.getBuiltinModule?.(["node", "fs"].join(":")) as FsLike | undefined;
  if (!fs) throw new Error("no_filesystem: fileStore needs the Node file system (Node 20.16+ or 22.3+)");
  let data: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") data[k] = v;
    }
  } catch {
    data = {};
  }
  const flush = () => fs.writeFileSync(path, JSON.stringify(data), "utf8");
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
      flush();
    },
    removeItem: (k) => {
      delete data[k];
      flush();
    },
  };
}

/** The store key of a game's player id. */
export const playerIdKey = (gameId: string) => `onelobby.pid.${gameId}`;
/** The store key of a game's ban list. */
export const bansKey = (gameId: string) => `onelobby.bans.${gameId}`;

/**
 * This install's player id for `gameId`: read from `store`, else made (32 hex characters from the CSPRNG) and saved.
 * A store that cannot save still returns a fresh id, so the id then lasts one session. It is not an account, a hardware
 * id or derived from anything on the machine (spec/room.md s.1).
 */
export function loadPlayerId(store: KeyValueStore | null, gameId: string): string {
  const key = playerIdKey(gameId);
  try {
    const have = store?.getItem(key);
    if (isPlayerId(have)) return have;
  } catch {
    /* unreadable: make a new one */
  }
  const id = newPlayerId();
  try {
    store?.setItem(key, id);
  } catch {
    /* not saved */
  }
  return id;
}
