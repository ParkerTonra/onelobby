/** Pluggable audio seams for voice: codec (WebCodecs or a WASM Opus), mic source, speaker sink. */

export interface VoiceError {
  message: string;
  cause?: unknown;
}

export interface VoiceEncoderHandle {
  /** Encode one 20 ms mono 48 kHz frame (960 samples, float -1..1). Output arrives through the callback. */
  encode(pcm: Float32Array): void;
  close(): void;
}

export interface VoiceDecoderHandle {
  /** Decode one Opus frame; `null` asks for packet-loss concealment of one 20 ms frame. */
  decode(opus: Uint8Array | null): void;
  close(): void;
}

/**
 * Opus codec seam. The default implementation uses WebCodecs `AudioEncoder`/`AudioDecoder`; a WASM libopus build
 * can implement this interface for browsers without WebCodecs Opus.
 */
export interface VoiceCodec {
  createEncoder(opts: { bitrate: number }, onFrame: (opus: Uint8Array) => void): VoiceEncoderHandle;
  createDecoder(onPcm: (pcm: Float32Array) => void): VoiceDecoderHandle;
}

/** Microphone: delivers 960-sample frames. */
export interface FrameSource {
  start(onFrame: (pcm: Float32Array) => void): Promise<void>;
  stop(): void;
}

/** Speaker output for decoded PCM (mono 48 kHz). `gain` is 0..2. */
export interface AudioSink {
  play(peerId: number, pcm: Float32Array, gain: number): void;
  close(): void;
}
