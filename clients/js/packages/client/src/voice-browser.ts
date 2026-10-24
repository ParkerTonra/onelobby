/* Browser implementations of the voice seams: WebCodecs Opus, AudioWorklet mic capture, WebAudio playback. */
import { FRAME_SAMPLES, SAMPLE_RATE } from "./voice-core.js";
import type { AudioSink, FrameSource, VoiceCodec, VoiceDecoderHandle, VoiceEncoderHandle } from "./voice-types.js";

export function webCodecsOpusAvailable(): boolean {
  return typeof AudioEncoder !== "undefined" && typeof AudioDecoder !== "undefined" && typeof AudioData !== "undefined";
}

/** Opus through WebCodecs (not Baseline: Chromium/Edge/Safari; check `webCodecsOpusAvailable()`). */
export const webCodecsOpus: VoiceCodec = {
  createEncoder(opts, onFrame): VoiceEncoderHandle {
    let ts = 0;
    const enc = new AudioEncoder({
      output: (chunk) => {
        const out = new Uint8Array(chunk.byteLength);
        chunk.copyTo(out);
        onFrame(out);
      },
      error: (e) => console.error("keepalive: AudioEncoder", e),
    });
    enc.configure({
      codec: "opus",
      sampleRate: SAMPLE_RATE,
      numberOfChannels: 1,
      bitrate: opts.bitrate,
      opus: { frameDuration: 20000, application: "voip", useinbandfec: true, usedtx: false, packetlossperc: 10 },
    } as AudioEncoderConfig);
    return {
      encode(pcm) {
        const data = new AudioData({
          format: "f32",
          sampleRate: SAMPLE_RATE,
          numberOfFrames: pcm.length,
          numberOfChannels: 1,
          timestamp: ts,
          data: pcm as unknown as Float32Array<ArrayBuffer>,
        });
        ts += 20000;
        enc.encode(data);
        data.close();
      },
      close() {
        if (enc.state !== "closed") enc.close();
      },
    };
  },
  createDecoder(onPcm): VoiceDecoderHandle {
    let ts = 0;
    const dec = new AudioDecoder({
      output: (audio) => {
        const pcm = new Float32Array(audio.numberOfFrames);
        audio.copyTo(pcm, { planeIndex: 0, format: "f32-planar" } as AudioDataCopyToOptions);
        audio.close();
        onPcm(pcm);
      },
      error: (e) => console.error("keepalive: AudioDecoder", e),
    });
    dec.configure({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    return {
      decode(opus) {
        if (opus === null) {
          onPcm(new Float32Array(FRAME_SAMPLES)); // WebCodecs has no PLC hook: conceal with silence
          return;
        }
        dec.decode(new EncodedAudioChunk({ type: "key", timestamp: ts, data: opus }));
        ts += 20000;
      },
      close() {
        if (dec.state !== "closed") dec.close();
      },
    };
  },
};

const WORKLET_SRC = `
class KeepaliveCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${FRAME_SAMPLES}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === ${FRAME_SAMPLES}) {
          const out = this.buf; this.buf = new Float32Array(${FRAME_SAMPLES}); this.n = 0;
          this.port.postMessage(out, [out.buffer]);
        }
      }
    }
    return true;
  }
}
registerProcessor('keepalive-capture', KeepaliveCapture);
`;

/** getUserMedia + AudioWorklet producing 960-sample frames at 48 kHz. Must be started from a user gesture. */
export class WorkletMic implements FrameSource {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;

  async start(onFrame: (pcm: Float32Array) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "text/javascript" }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const src = this.ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.ctx, "keepalive-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (e) => onFrame(e.data as Float32Array);
    src.connect(node);
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  stop(): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    void this.ctx?.close();
    this.stream = null;
    this.ctx = null;
  }
}

/** Plays decoded PCM per speaker, scheduled back to back on an AudioContext. */
export class WebAudioSink implements AudioSink {
  private ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  private next = new Map<number, number>();

  constructor() {
    void this.ctx.resume();
  }

  play(peerId: number, pcm: Float32Array, gain: number): void {
    if (pcm.length === 0) return;
    const buf = this.ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
    buf.copyToChannel(pcm as unknown as Float32Array<ArrayBuffer>, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    let at = this.next.get(peerId) ?? 0;
    if (at < now + 0.01) at = now + 0.02; // (re)started: small lead so scheduling never lands in the past
    src.start(at);
    this.next.set(peerId, at + pcm.length / SAMPLE_RATE);
  }

  close(): void {
    void this.ctx.close();
  }
}
