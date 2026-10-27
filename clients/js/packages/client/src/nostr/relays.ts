/**
 * Nostr events and the relay pool (spec/nostr-signaling.md s.3 and s.6). Anonymous: every connection uses a throw-away
 * key and carries encrypted frames only.
 */
import type { Clock } from "../clock.js";
import type { SocketLike } from "../transport.js";
import { sha256, toHex, fromHex } from "./crypto.js";
import { schnorrPublicKey, schnorrSign } from "./secp256k1.js";

export const NOSTR_KIND = 25050;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** NIP-01 event id: SHA-256 of `[0, pubkey, created_at, kind, tags, content]` serialised without whitespace. */
export async function eventId(pubkey: string, createdAt: number, kind: number, tags: string[][], content: string): Promise<string> {
  return toHex(await sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, createdAt, kind, tags, content]))));
}

/** A signed kind-25050 event (BIP340 Schnorr over the id). */
export async function makeEvent(secret: Uint8Array, topic: string, content: string, createdAt: number): Promise<NostrEvent> {
  const pubkey = toHex(schnorrPublicKey(secret));
  const tags = [["t", topic]];
  const id = await eventId(pubkey, createdAt, NOSTR_KIND, tags, content);
  const sig = toHex(await schnorrSign(fromHex(id), secret));
  return { id, pubkey, created_at: createdAt, kind: NOSTR_KIND, tags, content, sig };
}

/** The WebSocket constructor to a relay; the browser's, or Node 22+'s global one. Tests pass their own. */
export type RelayConnect = (url: string) => SocketLike;

export const defaultRelayConnect: RelayConnect = (url) => {
  const WS = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (!WS) throw new Error("no WebSocket in this runtime (Node 22+ has one; older Node needs advanced.nostrConnect)");
  return new WS(url) as SocketLike;
};

export interface RelayPoolOptions {
  urls: readonly string[];
  topic: string;
  connect: RelayConnect;
  clock: Clock;
  /** Unix ms. */
  wall: () => number;
  onEvent: (ev: NostrEvent) => void;
  /** Called when the number of connected relays changes. */
  onChange?: () => void;
}

interface Relay {
  url: string;
  ws: SocketLike | null;
  open: boolean;
  /** The first connect to this relay has succeeded or failed (a dead relay is known to be dead). */
  attempted: boolean;
  skipped: boolean;
  backoff: number;
  cancelRetry: (() => void) | null;
}

const SEEN_MAX = 4096;
const SINCE_SLACK_S = 30;

/** Every relay at once, each reconnected with backoff (1 s doubling to 30 s); events deduped by id. */
export class RelayPool {
  private readonly relays: Relay[];
  private readonly seen = new Set<string>();
  private readonly sub = "ol" + Math.random().toString(16).slice(2, 10);
  private closed = false;
  private waiters: (() => void)[] = [];

  constructor(private readonly o: RelayPoolOptions) {
    this.relays = o.urls.map((url) => ({ url, ws: null, open: false, attempted: false, skipped: false, backoff: 1000, cancelRetry: null }));
  }

  get total(): number {
    return this.relays.length;
  }

  /** Relays connected right now (and not skipped). */
  get connected(): number {
    return this.relays.filter((r) => r.open && !r.skipped).length;
  }

  /** Every relay has either connected, failed a connect, or been skipped: waiting longer for the rest is pointless. */
  get settled(): boolean {
    return this.relays.every((r) => r.attempted || r.skipped);
  }

  start(): void {
    for (const r of this.relays) this.dial(r);
  }

  /** Resolves true once one relay is connected, false after `timeoutMs` (or when closed). */
  whenUp(timeoutMs: number): Promise<boolean> {
    if (this.connected > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const cancel = this.o.clock.setTimeout(() => done(false), timeoutMs);
      const done = (v: boolean) => {
        cancel();
        this.waiters = this.waiters.filter((w) => w !== check);
        resolve(v);
      };
      const check = () => {
        if (this.connected > 0) done(true);
        else if (this.closed) done(false);
      };
      this.waiters.push(check);
    });
  }

  publish(ev: NostrEvent): void {
    const msg = JSON.stringify(["EVENT", ev]);
    for (const r of this.relays) if (r.open && !r.skipped) this.trySend(r, msg);
  }

  close(): void {
    this.closed = true;
    for (const r of this.relays) {
      r.cancelRetry?.();
      r.cancelRetry = null;
      this.drop(r, false);
    }
    this.changed();
  }

  private changed(): void {
    for (const w of [...this.waiters]) w();
    this.o.onChange?.();
  }

  private trySend(r: Relay, msg: string): void {
    try {
      r.ws?.send(msg);
    } catch {
      /* a dying socket: its onclose reconnects */
    }
  }

  private dial(r: Relay): void {
    if (this.closed || r.skipped) return;
    let ws: SocketLike;
    try {
      ws = this.o.connect(r.url);
    } catch {
      r.attempted = true;
      this.retryLater(r);
      return;
    }
    r.ws = ws;
    ws.onopen = () => {
      if (r.ws !== ws) return;
      r.open = true;
      r.attempted = true;
      r.backoff = 1000;
      const since = Math.floor(this.o.wall() / 1000) - SINCE_SLACK_S;
      this.trySend(r, JSON.stringify(["REQ", this.sub, { kinds: [NOSTR_KIND], "#t": [this.o.topic], since }]));
      this.changed();
    };
    ws.onmessage = (e) => {
      if (r.ws === ws) this.onMessage(r, String(e.data));
    };
    const lost = () => {
      if (r.ws !== ws) return;
      const wasOpen = r.open;
      r.ws = null;
      r.open = false;
      r.attempted = true;
      if (wasOpen) this.changed();
      this.retryLater(r);
    };
    ws.onclose = lost;
    ws.onerror = () => {
      /* onclose follows; Node's WebSocket may not fire it for a failed connect, so retry from here too */
      lost();
    };
  }

  private drop(r: Relay, retry: boolean): void {
    const ws = r.ws;
    r.ws = null;
    r.open = false;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    if (retry) this.retryLater(r);
  }

  private retryLater(r: Relay): void {
    if (this.closed || r.skipped || r.cancelRetry) return;
    const wait = r.backoff;
    r.backoff = Math.min(30_000, r.backoff * 2);
    r.cancelRetry = this.o.clock.setTimeout(() => {
      r.cancelRetry = null;
      this.dial(r);
    }, wait);
  }

  private skip(r: Relay): void {
    if (r.skipped) return;
    r.skipped = true;
    r.cancelRetry?.();
    r.cancelRetry = null;
    this.drop(r, false);
    this.changed();
  }

  private onMessage(r: Relay, text: string): void {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(m)) return;
    switch (m[0]) {
      case "EVENT": {
        const ev = m[2] as NostrEvent | undefined;
        if (!ev || typeof ev.id !== "string" || typeof ev.pubkey !== "string" || typeof ev.content !== "string" || typeof ev.created_at !== "number") return;
        if (ev.kind !== NOSTR_KIND || !Array.isArray(ev.tags) || !ev.tags.some((t) => t[0] === "t" && t[1] === this.o.topic)) return;
        if (this.seen.has(ev.id)) return;
        this.seen.add(ev.id);
        if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
        this.o.onEvent(ev);
        return;
      }
      case "OK":
        // refused (not a plain duplicate): this relay does not take our events, skip it for the session
        if (m[2] === false && !String(m[3] ?? "").startsWith("duplicate")) this.skip(r);
        return;
      case "CLOSED":
        this.skip(r);
        return;
    }
  }
}

/** Default public relays (probed 2026-10-26, docs/design/no-server-fallback.md): all accept and echo ephemeral kind 25050. */
export const DEFAULT_NOSTR_RELAYS: readonly string[] = [
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr-pub.wellorder.net",
  "wss://nostr.oxtr.dev",
  "wss://nostr.bitcoiner.social",
  "wss://relay.nostr.net",
  "wss://nostr.sathoarder.com",
];

/** Public STUN servers for Nostr joiners (spec s.5). */
export const DEFAULT_NOSTR_STUN: readonly string[] = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"];

export interface RelayCheck {
  url: string;
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * Probes each relay: connect, subscribe, publish one kind-25050 event to itself under a random topic with a random
 * key, and see it echoed. Anonymous (nothing about the player is sent). Use it to pick `hosting.nostrRelays`.
 */
export async function checkNostrRelays(
  urls: readonly string[],
  timeoutMs = 8000,
  opts: { connect?: RelayConnect; clock?: Clock } = {},
): Promise<RelayCheck[]> {
  const connect = opts.connect ?? defaultRelayConnect;
  const setT = (fn: () => void, ms: number) => {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  };
  return Promise.all(urls.map((url) => checkOne(url, timeoutMs, connect, opts.clock?.setTimeout.bind(opts.clock) ?? setT)));
}

async function checkOne(url: string, timeoutMs: number, connect: RelayConnect, setT: (fn: () => void, ms: number) => () => void): Promise<RelayCheck> {
  const t0 = Date.now();
  const secret = new Uint8Array(32);
  globalThis.crypto.getRandomValues(secret);
  secret[0] &= 0x7f; // far below the curve order
  if (secret.every((b) => b === 0)) secret[31] = 1;
  const topic = toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  let ev: NostrEvent;
  try {
    ev = await makeEvent(secret, topic, "probe", Math.floor(Date.now() / 1000));
  } catch (e) {
    return { url, ok: false, ms: 0, error: String(e) };
  }
  return new Promise<RelayCheck>((resolve) => {
    let ws: SocketLike | null = null;
    let finished = false;
    let accepted = false;
    const finish = (ok: boolean, error?: string) => {
      if (finished) return;
      finished = true;
      cancel();
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve({ url, ok, ms: Date.now() - t0, ...(error ? { error } : {}) });
    };
    const cancel = setT(() => finish(false, accepted ? "accepted but not echoed" : "timeout"), timeoutMs);
    try {
      ws = connect(url);
    } catch (e) {
      finish(false, String(e));
      return;
    }
    const sub = "chk" + topic.slice(0, 8);
    let published = false;
    const publish = () => {
      if (published) return;
      published = true;
      ws!.send(JSON.stringify(["EVENT", ev]));
    };
    ws.onopen = () => {
      ws!.send(JSON.stringify(["REQ", sub, { kinds: [NOSTR_KIND], "#t": [topic], since: Math.floor(Date.now() / 1000) - 30 }]));
      // some relays never send EOSE for a subscription with no stored events: publish shortly anyway
      setT(publish, 1500);
    };
    ws.onerror = () => finish(false, "connection failed");
    ws.onclose = () => finish(false, "closed");
    ws.onmessage = (e) => {
      let m: unknown;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (!Array.isArray(m)) return;
      if (m[0] === "EOSE") publish();
      else if (m[0] === "OK" && m[1] === ev.id) {
        if (m[2] === true) accepted = true;
        else finish(false, `refused: ${String(m[3] ?? "")}`.slice(0, 120));
      } else if (m[0] === "CLOSED") finish(false, `closed: ${String(m[2] ?? "")}`.slice(0, 120));
      else if (m[0] === "EVENT" && (m[2] as NostrEvent | undefined)?.id === ev.id) finish(true);
    };
  });
}
