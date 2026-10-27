/**
 * The host side of Nostr signaling (spec/nostr-signaling.md s.4): each joiner pubkey becomes one hub session, as if it
 * had opened a TCP WebSocket. The hub speaks the usual protocol; this file only moves its texts over frames.
 */
import type { Clock } from "../clock.js";
import type { SignalingHub, Session } from "../direct/hub.js";
import { ReliableLink, type Frame } from "./link.js";
import { NostrRoom } from "./room.js";
import type { RelayConnect } from "./relays.js";

export interface NostrHostOptions {
  /** The version 1 join code this host publishes. */
  code: string;
  relays?: readonly string[];
  connect?: RelayConnect;
  clock: Clock;
  wall?: () => number;
  /** The number of connected relays changed. */
  onChange?: () => void;
  /** The lobby's player cap: the new-session burst grows to it (see newSessionBurst). */
  maxPlayers?: number;
}

/** A lobby sized for more than NEW_SESSION_BURST players gets a burst that fits it (up to MAX_SESSION_BURST). */
export function newSessionBurst(maxPlayers?: number): number {
  return Math.max(NEW_SESSION_BURST, Math.min(MAX_SESSION_BURST, maxPlayers ?? 0));
}

interface Peer {
  link: ReliableLink;
  session: Session | null;
}

const PING = '{"t":"ping","n":0}';
const CLOSED_MEMORY = 512;
/**
 * NEW joiner pubkeys per lobby are a token bucket: a burst of newSessionBurst(maxPlayers) at once (a party joining
 * together), then one more per NEW_SESSION_REFILL_MS. Refused pubkeys wait in a list (up to WAITING_MAX, oldest
 * first) and are answered the moment a token refills; a waiting pubkey whose `open` (repeated every 2 s) has not
 * been heard for WAITING_STALE_MS has given up and is dropped.
 */
export const NEW_SESSION_BURST = 16;
export const MAX_SESSION_BURST = 64;
export const NEW_SESSION_REFILL_MS = 1_000;
const WAITING_MAX = 64;
const WAITING_STALE_MS = 5_000;

export class NostrHostBridge {
  private readonly peers = new Map<string, Peer>();
  private readonly gone = new Set<string>();
  private stopped = false;
  private readonly burst: number;
  private newTokens: number;
  private newTokensAt: number | null = null;
  /** Refused new pubkeys, oldest first, with when their last `open` was heard. */
  private readonly waiting = new Map<string, number>();
  private cancelWaiting: (() => void) | null = null;

  private constructor(private readonly hub: SignalingHub, private readonly room: NostrRoom, private readonly clock: Clock, maxPlayers?: number) {
    this.burst = this.newTokens = newSessionBurst(maxPlayers);
    room.onFrame = (f) => this.onFrame(f);
  }

  static async start(hub: SignalingHub, o: NostrHostOptions): Promise<NostrHostBridge> {
    return new NostrHostBridge(hub, await NostrRoom.open(o), o.clock, o.maxPlayers);
  }

  get relaysConnected(): number {
    return this.room.relaysConnected;
  }

  get relaysTotal(): number {
    return this.room.relaysTotal;
  }

  /** Resolves true once one relay is connected, false after `timeoutMs`. */
  whenUp(timeoutMs: number): Promise<boolean> {
    return this.room.whenUp(timeoutMs);
  }

  /** Joiners currently attached. */
  get peerCount(): number {
    return this.peers.size;
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelWaiting?.();
    this.cancelWaiting = null;
    this.waiting.clear();
    for (const [pub, p] of this.peers) {
      p.link.close("host left");
      if (p.session) this.hub.disconnect(p.session);
      this.peers.delete(pub);
    }
    this.room.close(true);
  }

  private onFrame(f: Frame): void {
    if (this.stopped) return;
    const known = this.peers.get(f.from);
    if (f.type === "open") {
      if (this.gone.has(f.from)) return;
      if (known) {
        known.link.heard();
        this.answer(f.from);
      } else if (this.waiting.has(f.from)) {
        this.waiting.set(f.from, this.clock.now()); // still trying: keep its place in the queue
        this.admitWaiting();
      } else if (this.waiting.size === 0 && this.admitNew()) {
        this.accept(f.from);
      } else if (this.waiting.size < WAITING_MAX) {
        this.waiting.set(f.from, this.clock.now()); // over the cap: answered when a token refills
        this.scheduleWaiting();
      } // waiting list full too: not answered, the joiner's next open retries
      return;
    }
    if (!known) return;
    known.link.receive(f);
    // a joiner's beat is its keep-alive: the hub counts it as activity (its pong is dropped below)
    if (f.type === "beat" && known.session) this.hub.receive(known.session, PING);
  }

  /** Arms one timer for the next token while anyone waits. */
  private scheduleWaiting(): void {
    if (this.cancelWaiting || this.waiting.size === 0 || this.stopped) return;
    const missing = Math.max(0, 1 - this.newTokens);
    this.cancelWaiting = this.clock.setTimeout(() => {
      this.cancelWaiting = null;
      this.admitWaiting();
    }, Math.max(1, Math.ceil(missing * NEW_SESSION_REFILL_MS)));
  }

  /** Answers waiting pubkeys, oldest first, while tokens last; drops the ones that gave up. */
  private admitWaiting(): void {
    if (this.stopped) return;
    const now = this.clock.now();
    for (const [pub, heard] of this.waiting) {
      if (now - heard > WAITING_STALE_MS || this.peers.has(pub) || this.gone.has(pub)) {
        this.waiting.delete(pub);
        continue;
      }
      if (!this.admitNew()) break;
      this.waiting.delete(pub);
      this.accept(pub);
    }
    this.scheduleWaiting();
  }

  /** Spends one token of the new-session bucket, or false when it is empty. */
  private admitNew(): boolean {
    const now = this.clock.now();
    if (this.newTokensAt !== null) {
      this.newTokens = Math.min(this.burst, this.newTokens + (now - this.newTokensAt) / NEW_SESSION_REFILL_MS);
    }
    this.newTokensAt = now;
    if (this.newTokens < 1 - 1e-6) return false; // fractional clock times can leave a full token at 0.9999999999999999
    this.newTokens = Math.max(0, this.newTokens - 1);
    return true;
  }

  private answer(pub: string): void {
    void this.room.send(pub, { type: "open", seq: 0, ack: 0 });
  }

  private accept(pub: string): void {
    const peer: Peer = { session: null, link: null as unknown as ReliableLink };
    peer.link = new ReliableLink({
      clock: this.clock,
      send: (out) => void this.room.send(pub, out),
      deliver: (text) => peer.session && this.hub.receive(peer.session, text),
      onPeerClose: () => this.detach(pub, peer),
      onDead: () => this.detach(pub, peer),
    });
    this.peers.set(pub, peer);
    this.answer(pub);
    const session = this.hub.connect(
      `nostr:${pub.slice(0, 16)}`,
      (text) => {
        if (!text.startsWith('{"t":"pong"')) peer.link.send(text); // keep-alive pongs never cross Nostr
      },
      () => {
        // the hub closed this session: say so, keep the pubkey out for the rest of the session
        peer.link.close();
        this.forget(pub, peer);
      },
    );
    if (peer.link.closed) return; // full: the hub already had us close it
    if (!session) {
      peer.link.close("closed");
      this.forget(pub, peer);
      return;
    }
    peer.session = session;
  }

  private detach(pub: string, peer: Peer): void {
    peer.link.stop();
    if (peer.session) this.hub.disconnect(peer.session);
    peer.session = null;
    this.forget(pub, peer);
  }

  private forget(pub: string, peer: Peer): void {
    if (this.peers.get(pub) === peer) this.peers.delete(pub);
    this.gone.add(pub);
    if (this.gone.size > CLOSED_MEMORY) this.gone.delete(this.gone.values().next().value as string);
  }
}
