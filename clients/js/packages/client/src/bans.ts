import { Emitter } from "./emitter.js";
import { banMatches, isLoopbackIp, isPlayerId, normalizeIp, type BanCandidate, type BanEntry } from "./room-rules.js";
import { bansKey, type KeyValueStore } from "./storage.js";

/** At most this many entries are kept; the oldest is dropped first (spec/room.md s.5.3). */
export const MAX_BANS = 1000;
/** The hub holds at most this many player ids per lobby (`bans` message). */
export const HUB_BAN_IDS = 256;

export type BanListEvents = { changed: [] };

/**
 * The host's ban list: survives the lobby because it is saved in a `KeyValueStore` (JS default: `localStorage`, else a
 * file the game names, else memory). Entries are keyed by the player id, with the address as the fallback (spec/room.md
 * s.5.3). A corrupt store loads as empty and is only overwritten by the next change.
 */
export class BanList extends Emitter<BanListEvents> {
  private entries: BanEntry[] = [];
  private readonly key: string;

  constructor(private store: KeyValueStore | null, gameId: string) {
    super();
    this.key = bansKey(gameId);
    this.reload();
  }

  /** Reads the store again (another process may have changed the file). */
  reload(): void {
    this.entries = [];
    let text: string | null = null;
    try {
      text = this.store?.getItem(this.key) ?? null;
    } catch {
      return;
    }
    if (!text) return;
    try {
      const v: unknown = JSON.parse(text);
      const list = (v as { bans?: unknown }).bans;
      if (!Array.isArray(list)) return;
      for (const e of list) {
        if (!e || typeof e !== "object") continue;
        const o = e as Record<string, unknown>;
        const id = isPlayerId(o.id) ? o.id : undefined;
        const ip = typeof o.ip === "string" && o.ip ? normalizeIp(o.ip) : undefined;
        if (!id && !ip) continue;
        this.entries.push({
          ...(id ? { id } : {}),
          ...(ip ? { ip } : {}),
          ...(typeof o.name === "string" ? { name: o.name } : {}),
          ...(typeof o.reason === "string" ? { reason: o.reason } : {}),
          ...(typeof o.code === "string" ? { code: o.code } : {}),
          at: typeof o.at === "number" ? o.at : 0,
        });
      }
      if (this.entries.length > MAX_BANS) this.entries.splice(0, this.entries.length - MAX_BANS);
    } catch {
      this.entries = [];
    }
  }

  list(): readonly BanEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  get size(): number {
    return this.entries.length;
  }

  /** The entry that bans `c`, if any. */
  match(c: BanCandidate): BanEntry | undefined {
    return this.entries.find((e) => banMatches(e, c));
  }

  /** Adds a ban for a player id and/or an address. A loopback address is never stored. Returns the entry. */
  add(e: { id?: string; ip?: string; name?: string; reason?: string; code?: string; at?: number }): BanEntry {
    const id = isPlayerId(e.id) ? e.id : undefined;
    let ip = e.ip ? normalizeIp(e.ip) : undefined;
    if (ip && isLoopbackIp(ip)) ip = undefined;
    if (!id && !ip) throw new RangeError("a ban needs a player id or an address");
    const entry: BanEntry = {
      ...(id ? { id } : {}),
      ...(ip ? { ip } : {}),
      ...(e.name ? { name: e.name } : {}),
      ...(e.reason ? { reason: e.reason } : {}),
      ...(e.code ? { code: e.code } : {}),
      at: e.at ?? Date.now(),
    };
    // one entry per id (or per address when it has no id): a new ban replaces the old
    this.entries = this.entries.filter((x) => !(id ? x.id === id : !x.id && x.ip === ip));
    this.entries.push(entry);
    if (this.entries.length > MAX_BANS) this.entries.splice(0, this.entries.length - MAX_BANS);
    this.save();
    return { ...entry };
  }

  /** Unban: by player id, by address, or by a `{ id?, ip? }` selector (every entry with either). Returns how many went. */
  remove(sel: string | { id?: string; ip?: string }): number {
    const s = typeof sel === "string" ? (isPlayerId(sel) ? { id: sel } : { ip: normalizeIp(sel) }) : { ...sel, ...(sel.ip ? { ip: normalizeIp(sel.ip) } : {}) };
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !((s.id && e.id === s.id) || (s.ip && e.ip === s.ip)));
    const n = before - this.entries.length;
    if (n > 0) this.save();
    return n;
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.save();
  }

  /** The newest player ids, for the hub's `bans` message. */
  hubIds(): string[] {
    return this.entries.filter((e) => e.id).slice(-HUB_BAN_IDS).map((e) => e.id!);
  }

  private save(): void {
    try {
      this.store?.setItem(this.key, JSON.stringify({ v: 1, bans: this.entries }));
    } catch {
      /* a store that cannot save: the list lasts this session */
    }
    this.emit("changed");
  }
}
