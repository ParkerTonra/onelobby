import type { VoiceError } from "./voice-types.js";
import { Emitter } from "./emitter.js";
import type { Hub } from "./hub.js";
import type { Message } from "./codec.js";
import {
  FLAG_END_OF_BURST,
  FRAME_MS,
  JitterBuffer,
  VoiceGate,
  VoicePacketizer,
  VoiceRelayPolicy,
  rms,
  type VoiceMode,
  type VoicePacket,
} from "./voice-core.js";
import type { AudioSink, FrameSource, VoiceCodec, VoiceDecoderHandle, VoiceEncoderHandle } from "./voice-types.js";

export type VoiceEvents = {
  speaking: [peerId: number, talking: boolean];
  error: [VoiceError];
};

interface Speaker {
  jitter: JitterBuffer;
  decoder: VoiceDecoderHandle | null;
  talking: boolean;
  lastHeard: number;
}

export interface VoiceDeps {
  codec: VoiceCodec | null;
  /** Creates the mic capture; resolved on `enabled = true`. */
  createSource: (() => FrameSource) | null;
  createSink: (() => AudioSink) | null;
}

const SPEAKING_TIMEOUT_MS = 300;

/** Voice chat (DESIGN s.9a): Opus frames on the `voice` channel, star-routed through the host, never in a frame. */
export class Voice extends Emitter<VoiceEvents> {
  mode: VoiceMode = "pushToTalk";
  /** Master mute for capture (self). */
  muted = false;
  /** 0..1 RMS of the last captured frame. */
  inputLevel = 0;
  bitrate = 24000;

  private _enabled = false;
  private gate = new VoiceGate();
  private packetizer = new VoicePacketizer();
  private relay = new VoiceRelayPolicy();
  private speakers = new Map<number, Speaker>();
  private peerMuted = new Set<number>();
  private gains = new Map<number, number>();
  private encoder: VoiceEncoderHandle | null = null;
  private source: FrameSource | null = null;
  private sink: AudioSink | null = null;
  private cancelPlayout: (() => void) | null = null;
  private endTimer: (() => void) | null = null;
  private sending = false;

  constructor(private hub: Hub, private deps: VoiceDeps) {
    super();
  }

  get enabled(): boolean {
    return this._enabled;
  }
  set enabled(v: boolean) {
    if (v === this._enabled) return;
    this._enabled = v;
    if (v) void this.start();
    else this.stop();
  }

  pushToTalk(down: boolean): void {
    this.gate.ptt = down;
  }

  isMutedPeer(peerId: number): boolean {
    return this.peerMuted.has(peerId);
  }
  setMuted(peerId: number, muted: boolean): void {
    if (muted) this.peerMuted.add(peerId);
    else this.peerMuted.delete(peerId);
  }
  setVolume(peerId: number, gain: number): void {
    this.gains.set(peerId, Math.min(2, Math.max(0, gain)));
  }
  volumeOf(peerId: number): number {
    return this.gains.get(peerId) ?? 1;
  }

  // ---- capture -------------------------------------------------------------------------------------------------

  private async start(): Promise<void> {
    try {
      if (!this.deps.codec) throw new Error("no Opus codec available: supply one through the voice.codec option (WASM fallback)");
      if (!this.deps.createSink) throw new Error("no audio output available");
      this.sink = this.deps.createSink();
      this.cancelPlayout = this.hub.clock.setInterval(() => this.playoutTick(), FRAME_MS);
      if (this.deps.createSource) {
        this.encoder = this.deps.codec.createEncoder({ bitrate: this.bitrate }, (opus) => this.onEncoded(opus));
        this.source = this.deps.createSource();
        await this.source.start((pcm) => this.onCapturedFrame(pcm, this.hub.clock.now()));
      }
    } catch (e) {
      this._enabled = false;
      this.stop();
      this.emit("error", { message: e instanceof Error ? e.message : String(e), cause: e });
    }
  }

  private stop(): void {
    if (this.sending) this.closeBurst();
    this.source?.stop();
    this.source = null;
    this.encoder?.close();
    this.encoder = null;
    this.cancelPlayout?.();
    this.cancelPlayout = null;
    this.sink?.close();
    this.sink = null;
    for (const [id, s] of this.speakers) {
      s.decoder?.close();
      if (s.talking) this.emit("speaking", id, false);
    }
    this.speakers.clear();
  }

  /** Feed one 20 ms mono 48 kHz frame (called by the mic source; exposed so tests and custom sources can drive it). */
  onCapturedFrame(pcm: Float32Array, nowMs: number): void {
    const level = rms(pcm);
    this.inputLevel = level;
    if (!this._enabled || this.muted) {
      if (this.sending) this.closeBurst();
      return;
    }
    const g = this.gate.update(level, nowMs);
    if (g.send) {
      this.sending = true;
      this.endTimer?.();
      this.endTimer = null;
      this.encoder?.encode(pcm);
    } else if (g.edge === "close" && this.sending) {
      this.closeBurst();
    }
  }

  private closeBurst(): void {
    this.sending = false;
    // Encoders can emit asynchronously (WebCodecs); give them one packet's worth of time before the end flag.
    this.endTimer?.();
    this.endTimer = this.hub.clock.setTimeout(() => {
      this.endTimer = null;
      this.sendPacket(this.packetizer.endBurst());
    }, FRAME_MS * 2);
  }

  /** Encoded frame from the encoder (also the test entry point for packetization). */
  onEncoded(opus: Uint8Array): void {
    const p = this.packetizer.push(opus);
    if (p) this.sendPacket(p);
  }

  private sendPacket(p: VoicePacket): void {
    const msg: Message = { type: "voice", seq: p.seq, flags: p.flags, frames: p.frames };
    if (this.hub.isHost) {
      for (const peer of this.hub.connectedPeers()) this.hub.sendTo(peer, msg, this.hub.localPeerId, "voice");
    } else {
      this.hub.sendToHost(msg, 0, "voice");
    }
  }

  // ---- receive -------------------------------------------------------------------------------------------------

  handle(from: number, route: number, msg: Message): void {
    if (msg.type !== "voice") return;
    const size = msg.frames.reduce((a, f) => a + f.length, 0) + 4 + msg.frames.length * 2;
    const now = this.hub.clock.now();
    let speaker = route;
    if (this.hub.isHost) {
      speaker = from;
      if (!this.relay.accept(from, size, msg.flags, now)) return;
      for (const peer of this.hub.connectedPeers()) {
        if (peer !== from) this.hub.sendTo(peer, msg, from, "voice");
      }
    }
    if (!this._enabled || speaker === this.hub.localPeerId || this.peerMuted.has(speaker)) return;
    this.receivePacket(speaker, { seq: msg.seq, flags: msg.flags, frames: msg.frames }, now);
  }

  /** Local playback path for one speaker's packet (after host forwarding). */
  receivePacket(speaker: number, p: VoicePacket, now: number): void {
    let s = this.speakers.get(speaker);
    if (!s) {
      s = { jitter: new JitterBuffer(), decoder: null, talking: false, lastHeard: now };
      this.speakers.set(speaker, s);
    }
    s.lastHeard = now;
    s.jitter.push(p);
    if (!s.talking && p.frames.length > 0) {
      s.talking = true;
      this.emit("speaking", speaker, true);
    }
  }

  private playoutTick(): void {
    const now = this.hub.clock.now();
    for (const [id, s] of this.speakers) {
      const r = s.jitter.pull();
      if (r.kind === "frame" || r.kind === "plc") {
        if (!s.decoder && this.deps.codec) {
          s.decoder = this.deps.codec.createDecoder((pcm) => this.sink?.play(id, pcm, this.volumeOf(id)));
        }
        s.decoder?.decode(r.kind === "frame" ? r.opus : null);
      } else if (r.kind === "idle" && s.talking) {
        s.talking = false;
        this.emit("speaking", id, false);
      } else if (s.talking && now - s.lastHeard > SPEAKING_TIMEOUT_MS + 5 * FRAME_MS && !s.jitter.active) {
        s.talking = false;
        this.emit("speaking", id, false);
      }
    }
  }

  onPeerLeft(peerId: number): void {
    this.relay.forget(peerId);
    const s = this.speakers.get(peerId);
    if (s) {
      s.decoder?.close();
      if (s.talking) this.emit("speaking", peerId, false);
      this.speakers.delete(peerId);
    }
  }

  close(): void {
    this._enabled = false;
    this.stop();
    this.endTimer?.();
  }

  /** For tests: expose the end-of-burst flag constant. */
  static readonly END = FLAG_END_OF_BURST;
}
