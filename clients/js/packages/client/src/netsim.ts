/**
 * Fake bad network for dev builds and tests, shaped like `NetSimTransport` of the C# client (clients/dotnet/OneLobby.Core):
 * it wraps a {@link LinkFactory} and makes every peer link worse on purpose. Only data channel frames are affected
 * (signaling is not). Reliable frames are delayed but stay in order and are never lost; fast and voice frames can also be
 * lost, or reordered by jitter. Settings can change while running ({@link NetSimLinkFactory.options}).
 *
 * Like the C# one it acts on this peer's sends AND its receives: each frame gets `latencyMs / 2 + random * jitterMs` on the
 * way out and again on the way in, and a loss roll in each direction. So with only one end of a link wrapped `latencyMs` is
 * the added round trip, and with both ends wrapped with the same settings it is the added one-way time.
 *
 * Differences from C# (JS has no transport object, only the link factory; there is no Poll): the wrapper is a
 * {@link LinkFactory} (`kit` option `advanced.linkFactory`), and delayed frames go out on the {@link Clock} (a timer set
 * for the earliest due frame), so a test drives them with a `ManualClock`. The random stream is mulberry32 of the seed, so
 * a seed repeats a run in JS, but is not the same stream as C#'s `System.Random` or the GDScript generator.
 */
import { systemClock, type Clock } from "./clock.js";
import type { ChannelName, LinkFactory, LinkFacts, LinkOptions, PeerLink, SignalPayload } from "./transport.js";

/** Bad-network settings for {@link NetSimLinkFactory} (the same names and defaults as C#'s `NetSimOptions`). */
export interface NetSimOptions {
  /** Added round trip in ms, split evenly between this peer's sends and receives. Default 0. */
  latencyMs?: number;
  /** Up to this much extra random delay per frame, each way. Default 0. */
  jitterMs?: number;
  /** Chance (0-100) to lose a fast or voice frame, each way. Reliable frames are never lost. Default 0. */
  lossPercent?: number;
  /** Random seed, for repeatable runs. Default 1. Only read at construction. */
  seed?: number;
}

/** Deterministic random numbers (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Held {
  at: number;
  seq: number;
  channel: ChannelName;
  bytes: Uint8Array;
}

/** Wraps any {@link LinkFactory}; every link it makes delays, jitters and drops frames per {@link options}. */
export class NetSimLinkFactory implements LinkFactory {
  /** Current settings; assign to change them on the fly (the seed is only read at construction). */
  options: NetSimOptions;
  readonly inner: LinkFactory;
  /** @internal */
  readonly clock: Clock;
  private rng: () => number;

  constructor(inner: LinkFactory, options: NetSimOptions = {}, clock: Clock = systemClock) {
    if (!inner) throw new TypeError("NetSimLinkFactory needs an inner link factory");
    this.inner = inner;
    this.options = options;
    this.clock = clock;
    this.rng = mulberry32(options.seed ?? 1);
  }

  create(opts: LinkOptions): PeerLink {
    return new SimLink(this, this.inner.create(opts));
  }

  /** @internal Whole ms of delay for one frame (like C#: truncated, never negative). */
  delay(): number {
    const o = this.options;
    const d = (o.latencyMs ?? 0) / 2 + ((o.jitterMs ?? 0) > 0 ? this.rng() * (o.jitterMs ?? 0) : 0);
    return Math.floor(Math.max(0, d));
  }

  /** @internal */
  lose(channel: ChannelName): boolean {
    const p = this.options.lossPercent ?? 0;
    return channel !== "reliable" && p > 0 && this.rng() * 100 < p;
  }
}

class SimLink implements PeerLink {
  onMessage: PeerLink["onMessage"] = null;
  private out: Held[] = [];
  private inn: Held[] = [];
  private seq = 0;
  private lastReliableOut = 0;
  private lastReliableIn = 0;
  private cancelOut: (() => void) | null = null;
  private cancelIn: (() => void) | null = null;
  private dead = false;

  constructor(private readonly t: NetSimLinkFactory, private readonly link: PeerLink) {
    link.onMessage = (channel, bytes) => this.receive(channel, bytes);
  }

  get remoteId(): number {
    return this.link.remoteId;
  }
  get isOpen(): boolean {
    return this.link.isOpen;
  }
  get onSignal(): PeerLink["onSignal"] {
    return this.link.onSignal;
  }
  set onSignal(v: PeerLink["onSignal"]) {
    this.link.onSignal = v;
  }
  get onOpen(): PeerLink["onOpen"] {
    return this.link.onOpen;
  }
  set onOpen(v: PeerLink["onOpen"]) {
    this.link.onOpen = v;
  }
  get onClose(): PeerLink["onClose"] {
    return this.link.onClose;
  }
  set onClose(v: PeerLink["onClose"]) {
    this.link.onClose = v;
  }
  get onPath(): PeerLink["onPath"] {
    return this.link.onPath;
  }
  set onPath(v: PeerLink["onPath"]) {
    this.link.onPath = v;
  }
  get onRemoteAddress(): PeerLink["onRemoteAddress"] {
    return this.link.onRemoteAddress;
  }
  set onRemoteAddress(v: PeerLink["onRemoteAddress"]) {
    this.link.onRemoteAddress = v;
  }
  get onTrace(): PeerLink["onTrace"] {
    return this.link.onTrace;
  }
  set onTrace(v: PeerLink["onTrace"]) {
    this.link.onTrace = v;
  }
  startOffer(): void {
    this.link.startOffer();
  }
  handleSignal(s: SignalPayload): void | Promise<void> {
    return this.link.handleSignal(s);
  }
  diagnostics(): string {
    return this.link.diagnostics?.() ?? "";
  }
  facts(): LinkFacts {
    return this.link.facts?.() ?? {};
  }

  send(channel: ChannelName, bytes: Uint8Array): void {
    if (this.dead || this.t.lose(channel)) return;
    const now = this.t.clock.now();
    let at = now + this.t.delay();
    if (channel === "reliable") {
      at = Math.max(at, this.lastReliableOut);
      this.lastReliableOut = at;
    }
    if (at <= now && this.out.length === 0) {
      this.link.send(channel, bytes);
      return;
    }
    this.out.push({ at, seq: this.seq++, channel, bytes: bytes.slice() });
    this.arm("out");
  }

  private receive(channel: ChannelName, bytes: Uint8Array): void {
    if (this.dead || this.t.lose(channel)) return;
    const now = this.t.clock.now();
    let at = now + this.t.delay();
    if (channel === "reliable") {
      at = Math.max(at, this.lastReliableIn);
      this.lastReliableIn = at;
    }
    if (at <= now && this.inn.length === 0) {
      this.onMessage?.(channel, bytes);
      return;
    }
    this.inn.push({ at, seq: this.seq++, channel, bytes });
    this.arm("in");
  }

  /** One timer per direction, set for the earliest held frame. */
  private arm(dir: "out" | "in"): void {
    const q = dir === "out" ? this.out : this.inn;
    const cancel = dir === "out" ? this.cancelOut : this.cancelIn;
    if (cancel || q.length === 0) return;
    const head = q.reduce((m, h) => Math.min(m, h.at), Infinity);
    const stop = this.t.clock.setTimeout(() => {
      if (dir === "out") this.cancelOut = null;
      else this.cancelIn = null;
      this.drain(dir);
    }, Math.max(0, head - this.t.clock.now()));
    if (dir === "out") this.cancelOut = stop;
    else this.cancelIn = stop;
  }

  // earliest due frame first; ties keep insertion order, so reliable frames (non-decreasing times) stay in order
  private drain(dir: "out" | "in"): void {
    const q = dir === "out" ? this.out : this.inn;
    const now = this.t.clock.now();
    for (;;) {
      if (this.dead) return;
      let best = -1;
      for (let i = 0; i < q.length; i++) {
        if (q[i].at <= now && (best < 0 || q[i].at < q[best].at || (q[i].at === q[best].at && q[i].seq < q[best].seq))) best = i;
      }
      if (best < 0) break;
      const [h] = q.splice(best, 1);
      if (dir === "out") this.link.send(h.channel, h.bytes);
      else this.onMessage?.(h.channel, h.bytes);
    }
    this.arm(dir);
  }

  close(): void {
    this.dead = true;
    this.out = [];
    this.inn = [];
    this.cancelOut?.();
    this.cancelIn?.();
    this.cancelOut = this.cancelIn = null;
    this.link.close();
  }
}
