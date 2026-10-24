/**
 * Test doubles: a manual clock, an in-memory lobby server speaking the lk1 protocol (spec/signaling.md, the parts the
 * client uses) and an in-memory peer network. Exported as `@keepalive/client/testing`.
 */
import type { Clock } from "./clock.js";
import { CROCKFORD_ALPHABET, normalizeCode } from "./crockford.js";
import type {
  ChannelName,
  LinkFactory,
  LinkOptions,
  PeerLink,
  SignalPayload,
  SocketFactory,
  SocketLike,
} from "./transport.js";

// ---- clock ------------------------------------------------------------------------------------------------------

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
  every?: number;
  dead?: boolean;
}

/** Deterministic clock: time only moves through `advance()`. Timers fire in (time, creation) order. */
export class ManualClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers: Timer[] = [];

  now(): number {
    return this.t;
  }

  setInterval(fn: () => void, ms: number): () => void {
    const timer: Timer = { at: this.t + ms, seq: this.seq++, fn, every: Math.max(1, ms) };
    this.timers.push(timer);
    return () => {
      timer.dead = true;
    };
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const timer: Timer = { at: this.t + ms, seq: this.seq++, fn };
    this.timers.push(timer);
    return () => {
      timer.dead = true;
    };
  }

  /** Advance time, firing due timers one at a time (microtasks flush between them when awaited via `run`). */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers = this.timers.filter((x) => !x.dead);
      let next: Timer | undefined;
      for (const x of this.timers) if (x.at <= end && (!next || x.at < next.at || (x.at === next.at && x.seq < next.seq))) next = x;
      if (!next) break;
      this.t = Math.max(this.t, next.at);
      if (next.every) {
        next.at += next.every;
        next.seq = this.seq++;
      } else {
        next.dead = true;
      }
      next.fn();
    }
    this.t = end;
  }

  /** Advance in `step` ms slices, letting promises and queued microtasks settle between slices. */
  async run(ms: number, step = 10): Promise<void> {
    let left = ms;
    await settle();
    while (left > 0) {
      const d = Math.min(step, left);
      this.advance(d);
      left -= d;
      await settle();
    }
  }
}

/** Let all pending microtasks (and chained promise continuations) run. */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
  // A macrotask boundary guarantees the whole microtask queue (delivery chains) has drained.
  await new Promise<void>((r) => ((globalThis as { setImmediate?: (f: () => void) => void }).setImmediate?.(r) ?? setTimeout(r, 0)));
}

// ---- in-memory peer network ---------------------------------------------------------------------------------------

let linkSerial = 0;

/**
 * Pairs `PeerLink`s through the signaling path like WebRTC would: the offerer's SDP string names it, the answerer
 * resolves that name, and both open one microtask later. Messages are delivered FIFO, one microtask later.
 */
export class MemoryNetwork {
  private offers = new Map<string, MemoryLink>();
  /** Every link ever created (for assertions and fault injection). */
  readonly links: MemoryLink[] = [];
  /** Set to drop all traffic in one direction pair for fault injection: key `${from}->${to}` is not tracked; use link.mute(). */
  readonly factory: LinkFactory = { create: (opts) => new MemoryLink(this, opts) };

  /** @internal */
  register(offer: string, link: MemoryLink): void {
    this.offers.set(offer, link);
    this.links.push(link);
  }
  /** @internal */
  lookup(offer: string): MemoryLink | undefined {
    return this.offers.get(offer);
  }

  /** Kill every link whose far end is this identity-tagged factory owner (set `tag` via MemoryLink.owner). */
  killOwner(owner: string): void {
    for (const l of this.links) if (l.owner === owner) l.close();
  }

  /** Per-owner factory so tests can tell whose link is whose and cut one peer off. */
  factoryFor(owner: string): LinkFactory {
    return {
      create: (opts) => {
        const l = new MemoryLink(this, opts);
        l.owner = owner;
        return l;
      },
    };
  }
}

export class MemoryLink implements PeerLink {
  readonly remoteId: number;
  isOpen = false;
  owner = "";
  onSignal: PeerLink["onSignal"] = null;
  onOpen: PeerLink["onOpen"] = null;
  onClose: PeerLink["onClose"] = null;
  onMessage: PeerLink["onMessage"] = null;
  onPath: PeerLink["onPath"] = null;
  /** Bytes sent per channel, for assertions. */
  readonly sent: Record<ChannelName, number> = { reliable: 0, fast: 0, voice: 0 };
  /** While true, outgoing messages vanish (a frozen or partitioned peer). */
  blackhole = false;
  private peer: MemoryLink | null = null;
  private closed = false;
  private id = `mem-${++linkSerial}`;

  constructor(private net: MemoryNetwork, opts: LinkOptions) {
    this.remoteId = opts.remoteId;
  }

  startOffer(): void {
    this.net.register(this.id, this);
    queueMicrotask(() => this.onSignal?.({ sdp: { type: "offer", sdp: this.id } }));
  }

  handleSignal(s: SignalPayload): void {
    if (s.sdp?.type === "offer") {
      const offerer = this.net.lookup(s.sdp.sdp);
      this.net.links.push(this);
      if (!offerer) return;
      this.peer = offerer;
      queueMicrotask(() => this.onSignal?.({ sdp: { type: "answer", sdp: this.id } }));
      queueMicrotask(() => offerer.accept(this));
      queueMicrotask(() => this.open());
    }
  }

  /** @internal */
  accept(answerer: MemoryLink): void {
    this.peer = answerer;
    this.open();
  }

  private open(): void {
    if (this.closed || this.isOpen) return;
    this.isOpen = true;
    this.onOpen?.();
    this.onPath?.("direct");
  }

  send(channel: ChannelName, bytes: Uint8Array): void {
    if (!this.isOpen || this.closed) return;
    this.sent[channel] += bytes.length;
    if (this.blackhole) return;
    const peer = this.peer;
    const copy = bytes.slice();
    queueMicrotask(() => {
      if (peer && peer.isOpen && !peer.closed && !this.closed) peer.onMessage?.(channel, copy);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.isOpen = false;
    const peer = this.peer;
    queueMicrotask(() => {
      this.onClose?.("closed");
      if (peer && !peer.closed) peer.closeFromRemote();
    });
  }

  private closeFromRemote(): void {
    if (this.closed) return;
    this.closed = true;
    this.isOpen = false;
    this.onClose?.("remote closed");
  }
}

// ---- in-memory lobby server ---------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface MPeer {
  peerId: number;
  name: string;
  joinedAt: number;
  sock: MemorySocket | null;
  token: string;
}
interface MLobby {
  code: string;
  gameId: string;
  netVersion: string;
  name: string;
  hostId: number;
  epoch: number;
  mode: string;
  tickRate: number;
  lateJoin: boolean;
  phase: string;
  meta: Record<string, string>;
  visibility: string;
  maxPlayers: number;
  peers: Map<number, MPeer>;
  next: number;
  kicked: Set<number>;
  reserved: Map<string, MPeer>;
}

/** Minimal keepalive-server (lk1) for client tests. Not a conformance target: stream A owns the real server. */
export class MemoryServer {
  readonly lobbies = new Map<string, MLobby>();
  /** Every socket ever opened (to drop one from a test). */
  readonly sockets: MemorySocket[] = [];
  readonly socketFactory: SocketFactory = () => this.connect();
  private n = 0;
  iceServers = [{ urls: ["stun:stun.example:3478"] }];
  /** Log of every client message, for assertions. */
  readonly received: Json[] = [];

  connect(): MemorySocket {
    const s = new MemorySocket(this);
    this.sockets.push(s);
    return s;
  }

  /** @internal */
  newCode(): string {
    let x = 0x9e3779b1 * (++this.n + 17);
    let s = "";
    for (let i = 0; i < 6; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      s += CROCKFORD_ALPHABET[(x >>> 16) & 31];
    }
    return this.lobbies.has(s) ? this.newCode() : s;
  }
}

export class MemorySocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;

  private hello: Json | null = null;
  private lobby: MLobby | null = null;
  private peer: MPeer | null = null;
  private closed = false;

  constructor(private srv: MemoryServer) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  // ---- socket API
  send(data: string): void {
    if (this.closed) return;
    const m = JSON.parse(data) as Json;
    queueMicrotask(() => this.handle(m));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.leaveLobby("timeout");
    queueMicrotask(() => this.onclose?.());
  }

  /** @internal server -> this client */
  push(m: Json): void {
    if (this.closed) return;
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(m) }));
  }

  private err(code: string, msg = "", data?: Json) {
    this.push({ t: "error", code, msg, ...(data ? { data } : {}) });
  }

  private lobbyMsg(l: MLobby, p: MPeer): Json {
    return {
      t: "lobby",
      code: l.code,
      gameId: l.gameId,
      netVersion: l.netVersion,
      hostId: l.hostId,
      you: p.peerId,
      mode: l.mode,
      tickRate: l.tickRate,
      lateJoin: l.lateJoin,
      phase: l.phase,
      meta: l.meta,
      peers: [...l.peers.values()].map((q) => ({ peerId: q.peerId, name: q.name, joinedAt: q.joinedAt })),
      resumeToken: p.token,
      name: l.name,
      maxPlayers: l.maxPlayers,
      visibility: l.visibility,
    };
  }

  private broadcast(l: MLobby, m: Json, except?: number) {
    for (const q of l.peers.values()) if (q.peerId !== except) q.sock?.push(m);
  }

  private leaveLobby(reason: string) {
    const l = this.lobby;
    const p = this.peer;
    if (!l || !p) return;
    this.lobby = null;
    this.peer = null;
    p.sock = null;
    l.peers.delete(p.peerId);
    if (reason === "timeout") l.reserved.set(p.token, p); // slot kept for resume
    if (l.peers.size === 0) {
      this.srv.lobbies.delete(l.code);
      return;
    }
    this.broadcast(l, { t: "peer_left", peerId: p.peerId, reason });
    if (l.hostId === p.peerId) {
      l.hostId = Math.min(...l.peers.keys());
      l.epoch++;
      this.broadcast(l, { t: "host_changed", hostId: l.hostId, epoch: l.epoch });
    }
  }

  private handle(m: Json) {
    if (this.closed) return;
    this.srv.received.push(m);
    const t = String(m.t);
    if (t === "ping") return this.push({ t: "pong", n: m.n });
    if (t === "hello") {
      if (this.hello) return this.err("bad_request", "second hello");
      this.hello = m;
      const tok = typeof m.resumeToken === "string" ? m.resumeToken : "";
      for (const l of this.srv.lobbies.values()) {
        const rp = l.reserved.get(tok);
        if (!rp) continue;
        l.reserved.delete(tok);
        rp.sock = this;
        rp.token = tok + "+";
        l.peers.set(rp.peerId, rp);
        this.lobby = l;
        this.peer = rp;
        this.push({ t: "welcome", peerId: rp.peerId, ice: this.srv.iceServers, serverTime: Date.now(), limits: { maxMsg: 16384, maxPlayers: 64 } });
        this.push(this.lobbyMsg(l, rp));
        return this.broadcast(l, { t: "peer_joined", peer: { peerId: rp.peerId, name: rp.name, joinedAt: rp.joinedAt } }, rp.peerId);
      }
      return this.push({ t: "welcome", ice: this.srv.iceServers, serverTime: Date.now(), limits: { maxMsg: 16384, maxPlayers: 64 } });
    }
    if (!this.hello) return this.err("bad_request", "hello first");
    const gameId = String(this.hello.gameId);
    const netVersion = String(this.hello.netVersion);
    switch (t) {
      case "create": {
        const code = this.srv.newCode();
        const p: MPeer = { peerId: 1, name: String(this.hello.name), joinedAt: Date.now(), sock: this, token: `tok-${code}-1` };
        const l: MLobby = {
          code, gameId, netVersion, name: String(m.name), hostId: 1, epoch: 0, mode: String(m.mode), tickRate: Number(m.tickRate),
          lateJoin: !!m.lateJoin, phase: "lobby", meta: (m.meta as Record<string, string>) ?? {}, visibility: String(m.visibility),
          maxPlayers: Number(m.maxPlayers), peers: new Map([[1, p]]), next: 2, kicked: new Set(), reserved: new Map(),
        };
        this.srv.lobbies.set(code, l);
        this.lobby = l;
        this.peer = p;
        return this.push(this.lobbyMsg(l, p));
      }
      case "join": {
        const code = normalizeCode(String(m.code));
        if (!code) return this.err("bad_request", "bad code");
        const l = this.srv.lobbies.get(code);
        if (!l || l.gameId !== gameId) return this.err("unknown_code");
        if (l.netVersion !== netVersion) return this.err("version_mismatch", "", { hostNetVersion: l.netVersion, yourNetVersion: netVersion });
        if (l.phase === "in_game" && !l.lateJoin) return this.err("in_game");
        if (l.peers.size >= l.maxPlayers) return this.err("lobby_full");
        const id = l.next++;
        const p: MPeer = { peerId: id, name: String(this.hello.name), joinedAt: Date.now(), sock: this, token: `tok-${code}-${id}` };
        l.peers.set(id, p);
        this.lobby = l;
        this.peer = p;
        this.push(this.lobbyMsg(l, p));
        return this.broadcast(l, { t: "peer_joined", peer: { peerId: id, name: p.name, joinedAt: p.joinedAt } }, id);
      }
      case "list": {
        const items = [...this.srv.lobbies.values()]
          .filter((l) => l.gameId === gameId && l.netVersion === netVersion && l.visibility === "public")
          .map((l) => ({
            code: l.code, gameId: l.gameId, netVersion: l.netVersion, name: l.name, hostName: l.peers.get(l.hostId)?.name ?? "",
            players: l.peers.size, maxPlayers: l.maxPlayers, phase: l.phase, meta: l.meta, region: "mem", createdAt: 0,
          }));
        return this.push({ t: "lobbies", items });
      }
      case "leave":
        return this.leaveLobby("left");
      case "signal": {
        const l = this.lobby;
        if (!l || !this.peer) return this.err("bad_request");
        const to = l.peers.get(Number(m.to));
        if (!to) return this.err("bad_request", "no such peer");
        return to.sock?.push({ t: "signal", from: this.peer.peerId, ...(m.sdp ? { sdp: m.sdp } : {}), ...(m.ice ? { ice: m.ice } : {}) });
      }
      case "meta":
      case "phase": {
        const l = this.lobby;
        if (!l || !this.peer) return;
        if (l.hostId !== this.peer.peerId) return this.err("not_host");
        if (t === "meta") l.meta = m.meta as Record<string, string>;
        else l.phase = String(m.phase);
        for (const q of l.peers.values()) q.sock?.push(this.lobbyMsg(l, q));
        return;
      }
      case "kick": {
        const l = this.lobby;
        if (!l || !this.peer) return;
        if (l.hostId !== this.peer.peerId) return this.err("not_host");
        const victim = l.peers.get(Number(m.peerId));
        if (!victim || victim === this.peer) return this.err("bad_request");
        l.kicked.add(victim.peerId);
        l.peers.delete(victim.peerId);
        victim.sock?.push({ t: "error", code: "kicked", msg: "kicked" });
        this.broadcast(l, { t: "peer_left", peerId: victim.peerId, reason: "kicked" });
        return;
      }
      case "host_changed": {
        const l = this.lobby;
        if (!l || !this.peer) return;
        if (Number(m.hostId) === this.peer.peerId && Number(m.epoch) > l.epoch) {
          l.hostId = this.peer.peerId;
          l.epoch = Number(m.epoch);
          this.broadcast(l, { t: "host_changed", hostId: l.hostId, epoch: l.epoch });
        }
        return;
      }
      default:
        return;
    }
  }
}

/** Convenience: kill a socket as if the network dropped (server sees a timeout, others get peer_left). */
export function dropSocket(s: SocketLike): void {
  s.close();
}
