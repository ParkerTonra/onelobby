/**
 * Pure voice building blocks (DESIGN s.9a): packetizer, PTT/VAD gate, jitter buffer, host relay policy.
 * No audio APIs here, so all of it is unit-testable.
 */

export const SAMPLE_RATE = 48000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 960
export const FRAMES_PER_PACKET = 2;
export const MAX_VOICE_PACKET_BYTES = 1024;
export const MAX_SPEAKERS = 8;
export const MAX_PACKETS_PER_SEC = 30;
export const JITTER_MS = 60;
export const VAD_HANGOVER_MS = 300;
export const FLAG_END_OF_BURST = 1;

export interface VoicePacket {
  seq: number;
  flags: number;
  frames: Uint8Array[];
}

/** Batches encoded 20 ms frames into 40 ms packets; `endBurst()` flushes the remainder with the end flag. */
export class VoicePacketizer {
  private seq = 0;
  private buf: Uint8Array[] = [];
  constructor(private framesPerPacket = FRAMES_PER_PACKET) {}

  push(frame: Uint8Array): VoicePacket | null {
    this.buf.push(frame);
    if (this.buf.length < this.framesPerPacket) return null;
    return this.take(0);
  }

  /** Always emits a packet (possibly with zero frames) carrying the end-of-burst flag. */
  endBurst(): VoicePacket {
    return this.take(FLAG_END_OF_BURST);
  }

  get buffered(): number {
    return this.buf.length;
  }

  private take(flags: number): VoicePacket {
    const p: VoicePacket = { seq: this.seq, flags, frames: this.buf };
    this.seq = (this.seq + 1) & 0xffff;
    this.buf = [];
    return p;
  }
}

export function rms(pcm: Float32Array): number {
  if (pcm.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / pcm.length);
}

export type VoiceMode = "pushToTalk" | "voiceActivity";

/** Decides, per captured 20 ms frame, whether it is transmitted. VAD uses an RMS gate with a 300 ms hangover. */
export class VoiceGate {
  mode: VoiceMode = "pushToTalk";
  ptt = false;
  vadThreshold = 0.02;
  private lastLoud = -Infinity;
  private open = false;

  /** Returns { send, edge } where edge is 'open' | 'close' | null on a transition. */
  update(level: number, nowMs: number): { send: boolean; edge: "open" | "close" | null } {
    let want: boolean;
    if (this.mode === "pushToTalk") {
      want = this.ptt;
    } else {
      if (level >= this.vadThreshold) this.lastLoud = nowMs;
      want = nowMs - this.lastLoud <= VAD_HANGOVER_MS;
    }
    const edge = want === this.open ? null : want ? "open" : "close";
    this.open = want;
    return { send: want, edge };
  }

  get isOpen(): boolean {
    return this.open;
  }
}

/** u16 sequence comparison with wraparound: positive when a is after b. */
export function seqDiff(a: number, b: number): number {
  const d = (a - b) & 0xffff;
  return d >= 0x8000 ? d - 0x10000 : d;
}

export type PullResult =
  | { kind: "frame"; opus: Uint8Array }
  | { kind: "plc" }
  | { kind: "wait" }
  | { kind: "idle" };

/**
 * Per-speaker jitter buffer. Reorders by `seq`, prefills 60 ms (3 frames) before playing, reports a lost packet as
 * PLC frames when a later packet is already here, and flushes on the end-of-burst flag.
 * `pull()` is called once per 20 ms by the playout clock.
 */
export class JitterBuffer {
  private packets = new Map<number, VoicePacket>();
  private expected: number | null = null;
  private ready: Uint8Array[] = [];
  private playing = false;
  private endSeq: number | null = null;
  private waitTicks = 0;
  readonly prefillFrames: number;

  constructor(jitterMs = JITTER_MS, private framesPerPacket = FRAMES_PER_PACKET) {
    this.prefillFrames = Math.max(1, Math.round(jitterMs / FRAME_MS));
  }

  push(p: VoicePacket): void {
    if (this.expected === null) {
      this.expected = p.seq;
    } else if (seqDiff(p.seq, this.expected) < 0) {
      return; // late: already played or skipped
    }
    this.packets.set(p.seq, p);
    if (p.flags & FLAG_END_OF_BURST) this.endSeq = p.seq;
    else if (this.endSeq !== null && seqDiff(p.seq, this.endSeq) > 0) this.endSeq = null; // a new burst began
  }

  private get ended(): boolean {
    return this.endSeq !== null;
  }

  private bufferedFrames(): number {
    let n = this.ready.length;
    let seq = this.expected;
    // contiguous run starting at expected
    while (seq !== null && this.packets.has(seq)) {
      n += this.packets.get(seq)!.frames.length;
      seq = (seq + 1) & 0xffff;
    }
    return n;
  }

  private newerThanExpected(): boolean {
    for (const s of this.packets.keys()) if (this.expected !== null && seqDiff(s, this.expected) > 0) return true;
    return false;
  }

  pull(): PullResult {
    if (this.expected === null) return { kind: "idle" };
    if (!this.playing) {
      if (this.bufferedFrames() >= this.prefillFrames || (this.ended && this.packets.size > 0)) this.playing = true;
      else return { kind: "wait" };
    }
    if (this.ready.length === 0) this.refill();
    const f = this.ready.shift();
    if (f) {
      this.waitTicks = 0;
      return f.length === 0 ? { kind: "plc" } : { kind: "frame", opus: f };
    }
    // nothing playable
    if (this.ended && this.packets.size === 0) {
      this.reset();
      return { kind: "idle" };
    }
    if (++this.waitTicks > 12) {
      // 240 ms of silence without an end flag: the burst is over (flag lost). Flush.
      this.reset();
      return { kind: "idle" };
    }
    return { kind: "wait" };
  }

  private refill(): void {
    if (this.expected === null) return;
    const p = this.packets.get(this.expected);
    if (p) {
      this.packets.delete(this.expected);
      this.expected = (this.expected + 1) & 0xffff;
      for (const fr of p.frames) this.ready.push(fr);
      return;
    }
    if (this.newerThanExpected()) {
      // The packet never arrived but later ones did: conceal it (empty array = PLC marker).
      this.expected = (this.expected + 1) & 0xffff;
      for (let i = 0; i < this.framesPerPacket; i++) this.ready.push(new Uint8Array(0));
    }
  }

  reset(): void {
    this.packets.clear();
    this.ready = [];
    this.expected = null;
    this.playing = false;
    this.endSeq = null;
    this.waitTicks = 0;
  }

  get active(): boolean {
    return this.expected !== null;
  }
}

/**
 * Host-side policy for forwarding voice (s.9a): <= 8 concurrent speakers (9th burst silently dropped), packets <= 1 KiB,
 * <= 30 packets/s per peer.
 */
export class VoiceRelayPolicy {
  private speakers = new Map<number, number>(); // peerId -> last packet time
  private windows = new Map<number, number[]>();
  /** A burst with no packet for this long counts as over even if its end flag was lost. */
  burstTimeoutMs = 500;

  accept(from: number, size: number, flags: number, now: number): boolean {
    if (size > MAX_VOICE_PACKET_BYTES) return false;
    // rate cap
    let w = this.windows.get(from);
    if (!w) this.windows.set(from, (w = []));
    while (w.length && now - w[0] >= 1000) w.shift();
    if (w.length >= MAX_PACKETS_PER_SEC) return false;
    // speaker cap
    for (const [p, t] of this.speakers) if (now - t > this.burstTimeoutMs) this.speakers.delete(p);
    if (!this.speakers.has(from) && this.speakers.size >= MAX_SPEAKERS) return false;
    w.push(now);
    if (flags & FLAG_END_OF_BURST) this.speakers.delete(from);
    else this.speakers.set(from, now);
    return true;
  }

  get activeSpeakers(): number {
    return this.speakers.size;
  }

  forget(peerId: number): void {
    this.speakers.delete(peerId);
    this.windows.delete(peerId);
  }
}
