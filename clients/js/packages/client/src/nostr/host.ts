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
}

interface Peer {
  link: ReliableLink;
  session: Session | null;
}

const PING = '{"t":"ping","n":0}';
const CLOSED_MEMORY = 512;
/** At most this many NEW joiner pubkeys per window per lobby; a joiner repeats `open` every 2 s, so excess just waits. */
export const MAX_NEW_SESSIONS = 8;
export const NEW_SESSION_WINDOW_MS = 10_000;

export class NostrHostBridge {
  private readonly peers = new Map<string, Peer>();
  private readonly gone = new Set<string>();
  private stopped = false;
  private readonly newAt: number[] = [];

  private constructor(private readonly hub: SignalingHub, private readonly room: NostrRoom, private readonly clock: Clock) {
    room.onFrame = (f) => this.onFrame(f);
  }

  static async start(hub: SignalingHub, o: NostrHostOptions): Promise<NostrHostBridge> {
    return new NostrHostBridge(hub, await NostrRoom.open(o), o.clock);
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
      } else if (this.admitNew()) this.accept(f.from); // over the cap: not answered, the joiner's next open retries
      return;
    }
    if (!known) return;
    known.link.receive(f);
    // a joiner's beat is its keep-alive: the hub counts it as activity (its pong is dropped below)
    if (f.type === "beat" && known.session) this.hub.receive(known.session, PING);
  }

  /** Counts a new session against the per-window cap. */
  private admitNew(): boolean {
    const now = this.clock.now();
    while (this.newAt.length > 0 && now - this.newAt[0] >= NEW_SESSION_WINDOW_MS) this.newAt.shift();
    if (this.newAt.length >= MAX_NEW_SESSIONS) return false;
    this.newAt.push(now);
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
