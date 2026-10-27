/**
 * One side's connection to a Nostr room: a fresh session key pair, the relay pool, and encrypted frames in and out
 * (spec/nostr-signaling.md s.2-4). {@link NostrSocket} (joiner) and {@link NostrHostBridge} (host) sit on top.
 */
import type { Clock } from "../clock.js";
import { normalizeJoinCode } from "../joincode.js";
import { decryptContent, deriveRoomKeys, encryptContent, toHex } from "./crypto.js";
import type { Frame, OutFrame } from "./link.js";
import { DEFAULT_NOSTR_RELAYS, RelayPool, defaultRelayConnect, makeEvent, type NostrEvent, type RelayConnect } from "./relays.js";
import { randomSecretKey, schnorrPublicKey } from "./secp256k1.js";

export interface NostrRoomOptions {
  /** The version 1 join code, any display form. */
  code: string;
  relays?: readonly string[];
  connect?: RelayConnect;
  clock: Clock;
  /** Unix ms; default Date.now. */
  wall?: () => number;
  /** The number of connected relays changed. */
  onChange?: () => void;
}

const MAX_AGE_S = 120;

export class NostrRoom {
  readonly pub: string;
  /** Called for each valid frame addressed to nobody in particular or to us (`to` empty or our pubkey). */
  onFrame: ((f: Frame) => void) | null = null;
  private readonly pool: RelayPool;
  private closed = false;
  private readonly pending = new Set<Promise<void>>();

  private constructor(private readonly secret: Uint8Array, private readonly keys: { key: Uint8Array; topic: string }, o: NostrRoomOptions, private readonly wall: () => number) {
    this.pub = toHex(schnorrPublicKey(secret));
    this.pool = new RelayPool({
      urls: o.relays && o.relays.length > 0 ? o.relays : DEFAULT_NOSTR_RELAYS,
      topic: keys.topic,
      connect: o.connect ?? defaultRelayConnect,
      clock: o.clock,
      wall,
      onEvent: (ev) => void this.onEvent(ev),
      onChange: o.onChange,
    });
  }

  /** Derives the keys and starts connecting. Throws on a code that is not 11 alphabet characters. */
  static async open(o: NostrRoomOptions): Promise<NostrRoom> {
    const norm = normalizeJoinCode(o.code);
    if (!norm) throw new Error(`not a join code: ${o.code}`);
    const keys = await deriveRoomKeys(norm);
    const room = new NostrRoom(randomSecretKey(), keys, o, o.wall ?? (() => Date.now()));
    room.pool.start();
    return room;
  }

  get relaysConnected(): number {
    return this.pool.connected;
  }

  get relaysTotal(): number {
    return this.pool.total;
  }

  /** Every relay has connected, failed or been skipped. */
  get relaysSettled(): boolean {
    return this.pool.settled;
  }

  whenUp(timeoutMs: number): Promise<boolean> {
    return this.pool.whenUp(timeoutMs);
  }

  /** Stamps, encrypts, signs and publishes a frame to every relay. */
  send(to: string, f: OutFrame): Promise<void> {
    const p = this.sendNow(to, f);
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
    return p;
  }

  private async sendNow(to: string, f: OutFrame): Promise<void> {
    if (this.closed) return;
    const frame: Frame = { v: 1, type: f.type, from: this.pub, to, seq: f.seq, ack: f.ack, ...(f.msgs ? { msgs: f.msgs } : {}), ...(f.reason ? { reason: f.reason } : {}) };
    const content = await encryptContent(this.keys.key, JSON.stringify(frame));
    const ev = await makeEvent(this.secret, this.keys.topic, content, Math.floor(this.wall() / 1000));
    if (!this.closed) this.pool.publish(ev);
  }

  /** Closes now, or (`flush`) once the frames already handed to `send` are published (a final `close` frame). */
  close(flush = false): void {
    if (flush && this.pending.size > 0) {
      void Promise.allSettled([...this.pending]).then(() => this.close());
      return;
    }
    this.closed = true;
    this.onFrame = null;
    this.pool.close();
  }

  private async onEvent(ev: NostrEvent): Promise<void> {
    if (this.closed || ev.pubkey === this.pub) return;
    if (this.wall() / 1000 - ev.created_at > MAX_AGE_S) return;
    const text = await decryptContent(this.keys.key, ev.content);
    if (text === null || this.closed) return;
    let f: Frame;
    try {
      f = JSON.parse(text) as Frame;
    } catch {
      return;
    }
    if (!f || f.v !== 1 || f.from !== ev.pubkey || f.from === this.pub) return;
    if (f.type !== "open" && f.type !== "data" && f.type !== "beat" && f.type !== "close") return;
    if (typeof f.to !== "string" || (f.to !== "" && f.to !== this.pub)) return;
    this.onFrame?.(f);
  }
}
