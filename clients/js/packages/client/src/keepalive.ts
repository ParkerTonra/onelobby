import { systemClock, type Clock } from "./clock.js";
import { Emitter } from "./emitter.js";
import { normalizeCode } from "./crockford.js";
import { Lobby } from "./lobby.js";
import {
  KeepaliveError,
  PROTO_ID,
  SignalingClient,
  type LobbyState,
  type LobbySummary,
  type WelcomeMsg,
} from "./signaling.js";
import {
  defaultSocketFactory,
  type LinkFactory,
  type SocketFactory,
} from "./transport.js";
import type { VoiceCodec, FrameSource, AudioSink } from "./voice-types.js";
import { WebAudioSink, WorkletMic, webCodecsOpus, webCodecsOpusAvailable } from "./voice-browser.js";
import { webRtcLinkFactory } from "./webrtc.js";

export const LIB_NAME = "@keepalive/client";
export const LIB_VERSION = "0.1.0";

export interface KeepaliveOptions {
  gameId: string;
  netVersion: string;
  /** `ws://` / `wss://` URL of a keepalive-server. */
  lobbyServer: string;
  mode?: "lockstep" | "raw";
  tickRate?: number;
  /** Default: tickRate (once a second). */
  hashEveryTicks?: number;
  displayName?: string;
  relayOnly?: boolean;

  // Seams (defaults are the browser implementations).
  socketFactory?: SocketFactory;
  linkFactory?: LinkFactory;
  clock?: Clock;
  /** Wall clock in unix ms, stamps chat lines. */
  wallClock?: () => number;
  /** Opus codec; defaults to WebCodecs when available. Provide a WASM-backed one elsewhere. */
  voiceCodec?: VoiceCodec | null;
  createMic?: (() => FrameSource) | null;
  createSink?: (() => AudioSink) | null;
}

export interface HostOptions {
  name: string;
  maxPlayers: number;
  visibility?: "public" | "unlisted" | "private";
  lateJoin?: boolean;
  meta?: Record<string, string>;
}

export interface ListOptions {
  meta?: Record<string, string>;
  limit?: number;
  cursor?: string;
}

export type KeepaliveEvents = { error: [Error] };

function hasMic(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== "undefined";
}

/** Entry point (DESIGN s.11.2). */
export class Keepalive extends Emitter<KeepaliveEvents> {
  readonly options: Required<Pick<KeepaliveOptions, "gameId" | "netVersion" | "lobbyServer" | "mode" | "tickRate" | "hashEveryTicks" | "displayName" | "relayOnly">>;
  private socketFactory: SocketFactory;
  private linkFactory: LinkFactory;
  private clock: Clock;
  private wall: () => number;
  private voiceCodec: VoiceCodec | null;
  private createMic: (() => FrameSource) | null;
  private createSink: (() => AudioSink) | null;

  constructor(o: KeepaliveOptions) {
    super();
    const tickRate = o.tickRate ?? 20;
    this.options = {
      gameId: o.gameId,
      netVersion: o.netVersion,
      lobbyServer: o.lobbyServer,
      mode: o.mode ?? "lockstep",
      tickRate,
      hashEveryTicks: o.hashEveryTicks ?? tickRate,
      displayName: o.displayName ?? "player",
      relayOnly: o.relayOnly ?? false,
    };
    this.socketFactory = o.socketFactory ?? defaultSocketFactory;
    this.linkFactory = o.linkFactory ?? webRtcLinkFactory;
    this.clock = o.clock ?? systemClock;
    this.wall = o.wallClock ?? (() => Date.now());
    this.voiceCodec = o.voiceCodec !== undefined ? o.voiceCodec : webCodecsOpusAvailable() ? webCodecsOpus : null;
    this.createMic = o.createMic !== undefined ? o.createMic : hasMic() ? () => new WorkletMic() : null;
    this.createSink = o.createSink !== undefined ? o.createSink : typeof AudioContext !== "undefined" ? () => new WebAudioSink() : null;
  }

  private async connect(resumeToken?: string): Promise<{ sig: SignalingClient; welcome: WelcomeMsg }> {
    const sig = new SignalingClient(this.options.lobbyServer, this.socketFactory, this.clock);
    await sig.connect();
    try {
      const welcome = await sig.request<WelcomeMsg & { t: string }>(
        {
          t: "hello",
          proto: PROTO_ID,
          gameId: this.options.gameId,
          netVersion: this.options.netVersion,
          client: { lib: LIB_NAME, ver: LIB_VERSION, platform: typeof navigator !== "undefined" ? "browser" : "node" },
          name: this.options.displayName.slice(0, 24),
          ...(resumeToken ? { resumeToken } : {}),
        },
        "welcome",
      );
      return { sig, welcome };
    } catch (e) {
      sig.close();
      throw e;
    }
  }

  private makeLobby(sig: SignalingClient, welcome: WelcomeMsg, state: LobbyState): Lobby {
    const lobby = new Lobby({
      signaling: sig,
      state,
      ice: welcome.ice ?? [],
      links: this.linkFactory,
      clock: this.clock,
      wall: this.wall,
      hashEveryTicks: this.options.hashEveryTicks,
      relayOnly: state.relayOnly ?? this.options.relayOnly,
      displayName: this.options.displayName,
      voice: { codec: this.voiceCodec, createSource: this.createMic, createSink: this.createSink },
    });
    lobby.errorSink = (e) => this.emit("error", e);
    return lobby;
  }

  async host(h: HostOptions): Promise<Lobby> {
    const { sig, welcome } = await this.connect();
    try {
      const state = await sig.request<LobbyState>(
        {
          t: "create",
          name: h.name,
          maxPlayers: h.maxPlayers,
          visibility: h.visibility ?? "public",
          mode: this.options.mode,
          tickRate: this.options.tickRate,
          lateJoin: h.lateJoin ?? true,
          meta: h.meta ?? {},
          ...(this.options.relayOnly ? { relayOnly: true } : {}),
        },
        "lobby",
      );
      return this.makeLobby(sig, welcome, state);
    } catch (e) {
      sig.close();
      throw e;
    }
  }

  async join(code: string): Promise<Lobby> {
    const norm = normalizeCode(code);
    if (!norm) throw new KeepaliveError("bad_code", `"${code}" is not a valid join code`);
    const { sig, welcome } = await this.connect();
    try {
      const state = await sig.request<LobbyState>({ t: "join", code: norm }, "lobby");
      return this.makeLobby(sig, welcome, state);
    } catch (e) {
      sig.close();
      throw e;
    }
  }

  async rejoin(resumeToken: string): Promise<Lobby> {
    const sig = new SignalingClient(this.options.lobbyServer, this.socketFactory, this.clock);
    await sig.connect();
    try {
      // The server answers hello(resumeToken) with welcome then the full lobby state; listen for both up front.
      const lobbyP = sig.expect<LobbyState>("lobby");
      const welcomeP = sig.request<WelcomeMsg & { t: string }>(
        {
          t: "hello",
          proto: PROTO_ID,
          gameId: this.options.gameId,
          netVersion: this.options.netVersion,
          client: { lib: LIB_NAME, ver: LIB_VERSION, platform: typeof navigator !== "undefined" ? "browser" : "node" },
          name: this.options.displayName.slice(0, 24),
          resumeToken,
        },
        "welcome",
      );
      const [welcome, state] = await Promise.all([welcomeP, lobbyP]);
      return this.makeLobby(sig, welcome, state);
    } catch (e) {
      sig.close();
      throw e;
    }
  }

  async list(opts: ListOptions = {}): Promise<LobbySummary[]> {
    const { sig } = await this.connect();
    try {
      const res = await sig.request<{ t: string; items: LobbySummary[] }>(
        { t: "list", visibility: "public", meta: opts.meta ?? {}, limit: Math.min(100, opts.limit ?? 50), ...(opts.cursor ? { cursor: opts.cursor } : {}) },
        "lobbies",
      );
      return res.items ?? [];
    } finally {
      sig.close();
    }
  }
}
