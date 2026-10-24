/**
 * The DOM-free brain of `<keepalive-lobby>`: a small state machine over Keepalive + Lobby (raw mode) that the element
 * renders, plus the JSON message envelope and the host-authoritative shared state. Unit-tested without a browser.
 */
import { KeepaliveError } from "../signaling.js";
import type { Lobby, Peer } from "../lobby.js";
import type { HostOptions } from "../keepalive.js";
import { describeError, type FriendlyError } from "./friendly-shim.js";
import { normalizeCode } from "../crockford.js";

export type UiState = "idle" | "connecting" | "lobby" | "playing" | "error";

export interface Player {
  id: number;
  name: string;
  isHost: boolean;
  isMe: boolean;
}

/** What the controller needs from `Keepalive` (so tests can pass the in-memory rig). */
export interface KitLike {
  host(h: HostOptions): Promise<Lobby>;
  join(code: string): Promise<Lobby>;
}

export interface ControllerEvents {
  message: { from: Player | null; data: unknown };
  "player-joined": { player: Player };
  "player-left": { player: Player; reason: string };
  start: Record<string, never>;
  error: FriendlyError;
  "shared-change": { key: string; value: unknown; from: Player | null };
}

export interface ControllerOptions {
  makeKit: (name: string) => KitLike;
  /** A number, or a function read each time a game is hosted. */
  maxPlayers: number | (() => number);
  /** Lobby name shown to the server (not to players). */
  lobbyName?: string;
  /** How long a joiner waits for the direct link to the host before giving up. */
  joinTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

/** Wire envelope inside raw frames. Kept tiny and versioned by key names only. */
type Wire =
  | { k: "m"; d: unknown } // game message
  | { k: "set"; key: string; v: unknown } // joiner -> host: please set
  | { k: "add"; key: string; n: number } // joiner -> host: please add
  | { k: "S"; key: string; v: unknown; by: number; q: number } // host -> all: value changed (q = host change counter)
  | { k: "SS"; all: Record<string, unknown>; q: number }; // host -> one: full state as of change q

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBytes = (w: Wire) => enc.encode(JSON.stringify(w));

export class SharedState {
  /** @internal */ values = new Map<string, unknown>();
  constructor(private c: LobbyController) {}
  get(key: string): unknown {
    return this.values.get(key);
  }
  /** Set a value for everyone. The host decides the order; everyone gets `shared-change`. */
  set(key: string, value: unknown): void {
    this.c._sharedOp({ k: "set", key: String(key), v: value === undefined ? null : value });
  }
  /** Add `n` (default 1) to a number, safely even when several players click at once. */
  add(key: string, n = 1): void {
    this.c._sharedOp({ k: "add", key: String(key), n: Number(n) || 0 });
  }
  /** A plain copy of every value. */
  all(): Record<string, unknown> {
    return Object.fromEntries(this.values);
  }
  keys(): string[] {
    return [...this.values.keys()];
  }
}

export class LobbyController {
  state: UiState = "idle";
  lobby: Lobby | null = null;
  error: FriendlyError | null = null;
  /** True while a joiner waits for its direct link to the host. */
  linking = false;
  name = "";
  readonly shared = new SharedState(this);

  onChange: () => void = () => {};
  onEvent: <K extends keyof ControllerEvents>(type: K, detail: ControllerEvents[K]) => void = () => {};

  private lastAction: { kind: "host" } | { kind: "join"; code: string } | null = null;
  private cancelTimer: (() => void) | null = null;
  private unsub: Array<() => void> = [];
  private gen = 0;
  /** Host: changes made so far. Joiner: the newest change applied (older queued ones are skipped). */
  private seq = 0;

  constructor(private opts: ControllerOptions) {}

  get isHost(): boolean {
    return !!this.lobby && this.lobby.isHost;
  }
  get code(): string | null {
    return this.lobby?.code ?? null;
  }
  get players(): Player[] {
    const l = this.lobby;
    if (!l) return [];
    const list = l.peers.map((p) => this.toPlayer(p));
    if (!list.some((p) => p.isMe)) list.push({ id: l.localPeerId, name: this.name, isHost: l.isHost, isMe: true });
    return list.sort((a, b) => a.id - b.id);
  }

  /** One line of plain language for the status area. */
  get statusText(): string {
    switch (this.state) {
      case "idle":
        return "Host a game, or type a code to join one.";
      case "connecting":
        return this.lastAction?.kind === "join" ? "Joining…" : "Creating a game…";
      case "error":
        return this.error?.message ?? "Something went wrong.";
      case "lobby": {
        if (this.linking) return `Connecting to ${this.hostName}…`;
        if (this.isHost) {
          const n = this.players.length;
          return n <= 1 ? "Waiting for players… Share the code with your friends." : `${n} players here. Press Start when everyone's in.`;
        }
        return `Connected! Waiting for ${this.hostName} to start.`;
      }
      case "playing":
        return this.linking ? `Connecting to ${this.hostName}…` : "Game on!";
    }
  }

  private get hostName(): string {
    const l = this.lobby;
    if (!l) return "the host";
    return l.peer(l.hostPeerId)?.name || "the host";
  }

  private toPlayer(p: Peer | undefined, id?: number): Player {
    const l = this.lobby!;
    const pid = p?.peerId ?? id ?? 0;
    return { id: pid, name: p?.name || (pid === l.localPeerId ? this.name : `Player ${pid}`), isHost: pid === l.hostPeerId, isMe: pid === l.localPeerId };
  }

  // ---- actions -----------------------------------------------------------------------------------------------------

  host(name: string): Promise<void> {
    this.lastAction = { kind: "host" };
    return this.run(name, (kit) => kit.host({ name: this.opts.lobbyName ?? "game", maxPlayers: typeof this.opts.maxPlayers === "function" ? this.opts.maxPlayers() : this.opts.maxPlayers, visibility: "unlisted", lateJoin: true }));
  }

  join(code: string, name: string): Promise<void> {
    const norm = normalizeCode(code);
    this.lastAction = { kind: "join", code };
    if (!norm) {
      this.fail(new KeepaliveError("bad_code"));
      return Promise.resolve();
    }
    return this.run(name, (kit) => kit.join(norm));
  }

  /** Repeat whatever failed last (host or join). */
  retry(): Promise<void> {
    const a = this.lastAction;
    if (!a) {
      this.reset();
      return Promise.resolve();
    }
    return a.kind === "host" ? this.host(this.name) : this.join(a.code, this.name);
  }

  async start(): Promise<void> {
    if (!this.lobby || !this.isHost || this.state === "playing") return;
    await this.lobby.start();
  }

  async leave(): Promise<void> {
    const l = this.lobby;
    this.detach();
    await l?.leave();
    this.reset();
  }

  /** Back to the start screen (after an error, or to cancel). */
  reset(): void {
    this.detach();
    this.state = "idle";
    this.error = null;
    this.onChange();
  }

  /** Send any JSON-able value to everyone else. */
  send(data: unknown): void {
    if (!this.lobby) return;
    this.lobby.broadcast(toBytes({ k: "m", d: data === undefined ? null : data }));
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  private async run(name: string, go: (kit: KitLike) => Promise<Lobby>): Promise<void> {
    this.detach();
    const gen = ++this.gen;
    this.name = (name || "").trim().slice(0, 24) || "Player";
    this.state = "connecting";
    this.error = null;
    this.onChange();
    let lobby: Lobby;
    try {
      lobby = await go(this.opts.makeKit(this.name));
    } catch (e) {
      if (gen === this.gen) this.fail(e);
      return;
    }
    if (gen !== this.gen) {
      void lobby.leave();
      return;
    }
    this.attach(lobby);
  }

  private attach(l: Lobby): void {
    this.lobby = l;
    // A joiner takes the host's values; a host keeps anything the page set up front (defaults).
    if (!l.isHost) this.shared.values.clear();
    this.seq = 0;
    this.state = l.phase === "in_game" ? "playing" : "lobby";
    this.linking = !l.isHost;
    const on = this.unsub;
    on.push(l.on("ready", () => this.linked()));
    on.push(l.on("peerJoined", (p) => {
      this.onEvent("player-joined", { player: this.toPlayer(p) });
      this.onChange();
    }));
    on.push(l.on("peerLeft", (p, reason) => {
      this.onEvent("player-left", { player: this.toPlayer(p), reason });
      this.onChange();
    }));
    on.push(l.on("peerReady", (p) => {
      if (l.isHost && p.peerId !== l.localPeerId) l.send(p.peerId, toBytes({ k: "SS", all: this.shared.all(), q: this.seq }));
    }));
    on.push(l.on("hostChanged", () => this.onChange()));
    on.push(l.on("phase", (ph) => {
      if (ph === "in_game" && this.state !== "playing") {
        this.state = "playing";
        this.onChange();
        this.onEvent("start", {});
      }
    }));
    on.push(l.on("message", (from, bytes) => this.onRaw(from, bytes)));
    on.push(l.on("sessionEnded", (reason) => {
      if (this.lobby !== l) return;
      if (reason === "left") return;
      this.fail(new KeepaliveError(reason));
    }));
    if (this.linking) {
      const ms = this.opts.joinTimeoutMs ?? 20_000;
      const timer = this.opts.setTimer ?? ((fn, t) => { const h = setTimeout(fn, t); return () => clearTimeout(h); });
      this.cancelTimer = timer(() => {
        if (this.lobby === l && this.linking) {
          void l.leave();
          this.fail(new KeepaliveError("join_timeout"));
        }
      }, ms);
    }
    this.onChange();
    if (this.state === "playing" && !this.linking) this.onEvent("start", {});
  }

  private linked(): void {
    if (!this.linking) return;
    this.linking = false;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.onChange();
    if (this.state === "playing") this.onEvent("start", {});
  }

  private detach(): void {
    this.gen++;
    for (const u of this.unsub.splice(0)) u();
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.lobby = null;
    this.linking = false;
  }

  private fail(e: unknown): void {
    const l = this.lobby;
    this.detach();
    if (l) void l.leave();
    this.state = "error";
    this.error = describeError(e);
    this.onChange();
    this.onEvent("error", this.error);
  }

  private playerById(id: number): Player | null {
    const l = this.lobby;
    if (!l || !id) return null;
    return this.toPlayer(l.peer(id), id);
  }

  private onRaw(from: number, bytes: Uint8Array): void {
    let w: Wire;
    try {
      w = JSON.parse(dec.decode(bytes)) as Wire;
    } catch {
      return; // not ours
    }
    if (!w || typeof w !== "object") return;
    const l = this.lobby!;
    switch (w.k) {
      case "m":
        this.onEvent("message", { from: this.playerById(from), data: w.d });
        break;
      case "set":
      case "add":
        if (l.isHost) this.applyHost(w, from);
        break;
      case "S":
        if (!l.isHost && from === l.hostPeerId && !(w.q <= this.seq)) {
          this.seq = w.q;
          this.applyValue(w.key, w.v, w.by);
        }
        break;
      case "SS":
        if (!l.isHost && from === l.hostPeerId && w.all && typeof w.all === "object" && !(w.q < this.seq)) {
          this.seq = w.q;
          for (const k of [...this.shared.values.keys()]) if (!(k in w.all)) this.applyValue(k, null, 0);
          for (const [k, v] of Object.entries(w.all)) this.applyValue(k, v, 0);
        }
        break;
    }
  }

  /** @internal from SharedState */
  _sharedOp(op: Extract<Wire, { k: "set" } | { k: "add" }>): void {
    const l = this.lobby;
    if (!l) {
      // Not in a game yet: keep it local, so a page can set defaults up front.
      const v = op.k === "set" ? op.v : (Number(this.shared.values.get(op.key)) || 0) + op.n;
      this.applyValue(op.key, v, 0);
      return;
    }
    if (l.isHost) this.applyHost(op, l.localPeerId);
    else l.send(l.hostPeerId, toBytes(op));
  }

  private applyHost(op: Extract<Wire, { k: "set" } | { k: "add" }>, by: number): void {
    const l = this.lobby!;
    if (typeof op.key !== "string") return;
    const v = op.k === "set" ? op.v : (Number(this.shared.values.get(op.key)) || 0) + (Number(op.n) || 0);
    this.applyValue(op.key, v, by);
    l.broadcast(toBytes({ k: "S", key: op.key, v, by, q: ++this.seq }));
  }

  private applyValue(key: string, v: unknown, by: number): void {
    if (v === null) this.shared.values.delete(key);
    else this.shared.values.set(key, v);
    this.onEvent("shared-change", { key, value: v, from: this.playerById(by) });
  }
}
