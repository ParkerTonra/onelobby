/**
 * The joiner's signaling socket over Nostr (spec/nostr-signaling.md s.4): a {@link SocketLike} that carries the hub
 * protocol to the host through a {@link NostrRoom}. `SignalingClient` cannot tell it from a TCP WebSocket.
 */
import type { Clock } from "../clock.js";
import type { SocketLike } from "../transport.js";
import { ReliableLink, type Frame } from "./link.js";
import { NostrRoom } from "./room.js";
import { GIVE_UP_MS, JOINER_FIRST_RELAY_MS, OPEN_EVERY_MS } from "./limits.js";
import type { RelayConnect } from "./relays.js";

export interface NostrSocketOptions {
  code: string;
  relays?: readonly string[];
  connect?: RelayConnect;
  clock: Clock;
  wall?: () => number;
  /** No relay connected within this long: the socket fails (default 10000). */
  relayTimeoutMs?: number;
  /** The host's first `open` did not arrive within this long: the socket fails (default 15000). */
  openTimeoutMs?: number;
  /** Resend interval of `open` (default 2000). */
  openEveryMs?: number;
}

export class NostrSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  /** Why the socket failed or closed, for messages ("no Nostr relay reachable", "host did not answer"). */
  failure = "";

  private room: NostrRoom | null = null;
  private link: ReliableLink | null = null;
  private hostPub = "";
  private cancelOpen: (() => void) | null = null;
  private cancelDeadline: (() => void) | null = null;
  private sendOpen: (() => void) | null = null;
  private relaysSeen = 0;

  constructor(private readonly o: NostrSocketOptions) {
    void this.start();
  }

  /** Relays connected, for a progress line. */
  get relaysConnected(): number {
    return this.room?.relaysConnected ?? 0;
  }

  get relaysTotal(): number {
    return this.room?.relaysTotal ?? 0;
  }

  send(data: string): void {
    if (this.readyState !== 1 || !this.link) return;
    // The keep-alive ping never crosses Nostr: answer it here (spec s.4)
    if (data.length < 64 && data.startsWith('{"t":"ping"')) {
      try {
        const m = JSON.parse(data) as { n?: unknown };
        queueMicrotask(() => this.readyState === 1 && this.onmessage?.({ data: JSON.stringify({ t: "pong", n: m.n }) }));
        return;
      } catch {
        /* send it on */
      }
    }
    this.link.send(data);
  }

  close(_code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    const wasOpen = this.readyState === 1;
    if (wasOpen) this.link?.close(reason ?? "");
    this.finish(1000, reason ?? "", false);
  }

  private async start(): Promise<void> {
    const { clock } = this.o;
    try {
      // a relay that comes up after the first `open` gets one at once, not at the next resend (spec s.4)
      this.room = await NostrRoom.open({ ...this.o, onChange: () => this.relaysChanged() });
    } catch (e) {
      this.fail(String(e));
      return;
    }
    const room = this.room;
    if (this.readyState === 3) {
      room.close();
      return;
    }
    room.onFrame = (f) => this.onFrame(f);
    this.cancelDeadline = clock.setTimeout(() => this.fail("the host did not answer through the Nostr relays"), this.o.openTimeoutMs ?? GIVE_UP_MS);
    if (!(await room.whenUp(this.o.relayTimeoutMs ?? JOINER_FIRST_RELAY_MS))) {
      this.fail("no Nostr relay reachable");
      return;
    }
    if (this.readyState !== 0) return;
    const open = () => void room.send("", { type: "open", seq: 0, ack: 0 });
    this.relaysSeen = room.relaysConnected;
    this.sendOpen = open;
    open();
    this.cancelOpen = clock.setInterval(open, this.o.openEveryMs ?? OPEN_EVERY_MS);
  }

  private relaysChanged(): void {
    const up = this.room?.relaysConnected ?? 0;
    if (up > this.relaysSeen && this.readyState === 0) this.sendOpen?.();
    this.relaysSeen = up;
  }

  private onFrame(f: Frame): void {
    if (this.readyState === 3 || f.to !== this.room?.pub) return;
    if (this.readyState === 0) {
      if (f.type !== "open") return;
      this.hostPub = f.from;
      this.sendOpen = null;
      this.cancelOpen?.();
      this.cancelDeadline?.();
      this.cancelOpen = this.cancelDeadline = null;
      const room = this.room!;
      this.link = new ReliableLink({
        clock: this.o.clock,
        send: (out) => void room.send(this.hostPub, out),
        deliver: (text) => this.readyState === 1 && this.onmessage?.({ data: text }),
        onPeerClose: (reason) => this.finish(1000, reason, true),
        onDead: (reason) => this.finish(1006, reason, false),
      });
      this.readyState = 1;
      this.onopen?.();
      return;
    }
    if (f.from !== this.hostPub) return;
    if (f.type === "open") {
      this.link?.heard();
      return;
    }
    this.link?.receive(f);
  }

  private fail(why: string): void {
    if (this.readyState === 3) return;
    this.failure = why;
    if (this.readyState === 0) this.onerror?.({ message: why });
    this.finish(1006, why, false);
  }

  private finish(code: number, reason: string, clean: boolean): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.cancelOpen?.();
    this.cancelDeadline?.();
    this.cancelOpen = this.cancelDeadline = null;
    this.link?.stop();
    this.room?.close(true);
    queueMicrotask(() => this.onclose?.({ code, reason, wasClean: clean }));
  }
}
