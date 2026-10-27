/**
 * The frame layer of Nostr signaling (spec/nostr-signaling.md s.4): ordered, de-duplicated, acknowledged delivery of
 * hub protocol texts between two pubkeys over lossy relays. One {@link ReliableLink} per peer; it knows nothing about
 * relays, keys or encryption: the owner stamps and ships the frames it emits.
 */
import type { Clock } from "../clock.js";

export type FrameType = "open" | "data" | "beat" | "close";

/** The wire frame (JSON in the encrypted event content). */
export interface Frame {
  v: 1;
  type: FrameType;
  from: string;
  to: string;
  seq: number;
  ack: number;
  msgs?: string[];
  reason?: string;
}

/** What a link emits; the owner adds v / from / to. */
export type OutFrame = Pick<Frame, "type" | "seq" | "ack"> & { msgs?: string[]; reason?: string };

export const BATCH_MS = 30;
export const RESEND_MS = 3000;
export const MAX_RESENDS = 5;
export const BEAT_MS = 10_000;
export const SILENCE_MS = 30_000;
export const MAX_HELD = 64;
/** Outbound: queued texts plus unacknowledged frames, at most this many frames and bytes; excess texts are dropped. */
export const MAX_OUT_FRAMES = 128;
export const MAX_OUT_BYTES = 256 * 1024;
export const MAX_FRAME_BYTES = 30_000; // under the 32 KiB content limit, room for the JSON envelope
const TICK_MS = 250;

const utf8 = new TextEncoder();
const byteLen = (s: string) => utf8.encode(s).length;

export interface LinkOptions {
  clock: Clock;
  /** Ships a frame to the peer. */
  send: (f: OutFrame) => void;
  /** An in-order hub protocol text from the peer. */
  deliver: (text: string) => void;
  /** The peer sent `close`. */
  onPeerClose: (reason: string) => void;
  /** Gave up: five resends unanswered, or 30 s of silence (reason "timeout"). */
  onDead: (reason: string) => void;
}

interface Pending {
  bytes: number;
  frame: OutFrame;
  lastSent: number;
  resends: number;
}

export class ReliableLink {
  private readonly o: LinkOptions;
  private queue: string[] = [];
  private queueBytes = 0;
  private unackedBytes = 0;
  private nextSeq = 1;
  private readonly unacked = new Map<number, Pending>();
  private rcvNext = 1; // next seq to deliver
  private readonly held = new Map<number, string[]>();
  private ackOwed = false;
  private lastSent: number;
  private lastHeard: number;
  private cancelFlush: (() => void) | null = null;
  private cancelTick: (() => void) | null = null;
  private done = false;

  constructor(o: LinkOptions) {
    this.o = o;
    this.lastSent = this.lastHeard = o.clock.now();
    this.cancelTick = o.clock.setInterval(() => this.tick(), TICK_MS);
  }

  get closed(): boolean {
    return this.done;
  }

  /** Queues a hub text; sent within 30 ms, packed with its neighbours. */
  send(text: string): void {
    if (this.done) return;
    // relays refuse high publish rates: past the cap the text is dropped, the connection is not
    const n = byteLen(text);
    if (this.queue.length + this.unacked.size >= MAX_OUT_FRAMES || this.queueBytes + this.unackedBytes + n > MAX_OUT_BYTES) return;
    this.queue.push(text);
    this.queueBytes += n;
    this.scheduleFlush();
  }

  /** Any frame arrived from the peer (including `open`, which only proves it is alive). */
  heard(): void {
    this.lastHeard = this.o.clock.now();
  }

  /** `data`, `beat` and `close` frames from the peer. */
  receive(f: Frame): void {
    if (this.done) return;
    this.heard();
    if (f.type === "close") {
      const reason = typeof f.reason === "string" ? f.reason : "";
      this.stop();
      this.o.onPeerClose(reason);
      return;
    }
    if (f.type !== "data" && f.type !== "beat") return;
    if (Number.isInteger(f.ack)) for (const s of [...this.unacked.keys()]) if (s <= f.ack) this.dropUnacked(s);
    if (f.type === "beat") return;
    const msgs = Array.isArray(f.msgs) ? f.msgs.filter((m) => typeof m === "string") : [];
    if (!Number.isInteger(f.seq) || f.seq < 1) return;
    this.ackOwed = true;
    if (f.seq === this.rcvNext) {
      this.rcvNext++;
      for (const m of msgs) this.o.deliver(m);
      for (let h = this.held.get(this.rcvNext); h && !this.done; h = this.held.get(this.rcvNext)) {
        this.held.delete(this.rcvNext);
        this.rcvNext++;
        for (const m of h) this.o.deliver(m);
      }
    } else if (f.seq > this.rcvNext && f.seq <= this.rcvNext + MAX_HELD) this.held.set(f.seq, msgs);
    // f.seq < rcvNext: a duplicate; the ack below tells the sender to stop resending
    this.scheduleFlush();
  }

  /** Sends what is queued, then `close` (once), and stops. */
  close(reason = ""): void {
    if (this.done) return;
    this.flush();
    this.o.send({ type: "close", seq: 0, ack: this.rcvNext - 1, ...(reason ? { reason } : {}) });
    this.stop();
  }

  /** Stops the timers without telling the peer. */
  stop(): void {
    this.done = true;
    this.cancelFlush?.();
    this.cancelTick?.();
    this.cancelFlush = this.cancelTick = null;
    this.unacked.clear();
    this.unackedBytes = 0;
    this.held.clear();
    this.queue = [];
    this.queueBytes = 0;
  }

  private scheduleFlush(): void {
    if (this.cancelFlush || this.done) return;
    this.cancelFlush = this.o.clock.setTimeout(() => {
      this.cancelFlush = null;
      this.flush();
    }, BATCH_MS);
  }

  private flush(): void {
    if (this.done) return;
    this.cancelFlush?.();
    this.cancelFlush = null;
    const now = this.o.clock.now();
    if (this.queue.length === 0) {
      if (this.ackOwed) this.emit({ type: "beat", seq: 0, ack: this.rcvNext - 1 }, now);
      return;
    }
    let batch: string[] = [];
    let bytes = 0;
    const ship = () => {
      if (batch.length === 0) return;
      const frame: OutFrame = { type: "data", seq: this.nextSeq++, ack: this.rcvNext - 1, msgs: batch };
      this.unacked.set(frame.seq, { bytes, frame, lastSent: now, resends: 0 });
      this.unackedBytes += bytes;
      this.emit(frame, now);
      batch = [];
      bytes = 0;
    };
    this.queueBytes = 0;
    for (const m of this.queue.splice(0)) {
      const n = byteLen(m);
      if (batch.length > 0 && bytes + n > MAX_FRAME_BYTES) ship();
      batch.push(m);
      bytes += n;
    }
    ship();
  }

  private dropUnacked(seq: number): void {
    const p = this.unacked.get(seq);
    if (!p) return;
    this.unackedBytes -= p.bytes;
    this.unacked.delete(seq);
  }

  private emit(f: OutFrame, now: number): void {
    this.lastSent = now;
    this.ackOwed = false;
    this.o.send(f);
  }

  private tick(): void {
    if (this.done) return;
    const now = this.o.clock.now();
    if (now - this.lastHeard >= SILENCE_MS) return this.die();
    for (const p of this.unacked.values()) {
      if (now - p.lastSent < RESEND_MS) continue;
      if (p.resends >= MAX_RESENDS) return this.die();
      p.resends++;
      p.lastSent = now;
      this.o.send({ ...p.frame, ack: this.rcvNext - 1 });
      this.lastSent = now;
    }
    if (now - this.lastSent >= BEAT_MS) this.emit({ type: "beat", seq: 0, ack: this.rcvNext - 1 }, now);
  }

  private die(): void {
    this.stop();
    this.o.onDead("timeout");
  }
}
