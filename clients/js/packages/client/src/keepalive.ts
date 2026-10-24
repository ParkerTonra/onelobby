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

/** Where `rememberSeat` keeps the resume token: the subset of the Web Storage API it uses. */
export interface SeatStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Seams for tests, adapters and non-browser runtimes. Every default is the browser implementation. */
export interface AdvancedOptions {
  socketFactory?: SocketFactory;
  linkFactory?: LinkFactory;
  clock?: Clock;
  /** Wall clock in unix ms, stamps chat lines. */
  wallClock?: () => number;
  /** Opus codec; defaults to WebCodecs when available. Provide a WASM-backed one elsewhere. */
  voiceCodec?: VoiceCodec | null;
  createMic?: (() => FrameSource) | null;
  createSink?: (() => AudioSink) | null;
  /** Storage for `rememberSeat`; defaults to `sessionStorage` when the page has one. null disables it. */
  storage?: SeatStorage | null;
}

export interface KeepaliveOptions {
  gameId: string;
  netVersion: string;
  /** `ws://` / `wss://` URL of a keepalive-server. */
  lobbyServer: string;
  mode?: "lockstep" | "raw";
  tickRate?: number;
  /** Default: tickRate (once a second). */
  hashEveryTicks?: number;
  /** The player's name. Empty (the default): other players see "Player N", N being the seat number. */
  displayName?: string;
  relayOnly?: boolean;
  /**
   * Joiners give up on reaching the host after this many ms: `lobby.ready` rejects with code `ice_failed`, the kit
   * emits `error`, and the lobby is left. Half the time goes to a relay-only retry when the server offers TURN.
   * Default 15000; 0 waits forever.
   */
  readyTimeoutMs?: number;
  /**
   * Keep this tab's seat across a page reload (sessionStorage): `join(code)` and `resume()` take the seat back
   * instead of joining as a new player. Cleared when the session ends. Default true where sessionStorage exists.
   */
  rememberSeat?: boolean;
  /** Test and runtime seams (see AdvancedOptions). */
  advanced?: AdvancedOptions;

  /** @deprecated use `advanced.socketFactory` */
  socketFactory?: SocketFactory;
  /** @deprecated use `advanced.linkFactory` */
  linkFactory?: LinkFactory;
  /** @deprecated use `advanced.clock` */
  clock?: Clock;
  /** @deprecated use `advanced.wallClock` */
  wallClock?: () => number;
  /** @deprecated use `advanced.voiceCodec` */
  voiceCodec?: VoiceCodec | null;
  /** @deprecated use `advanced.createMic` */
  createMic?: (() => FrameSource) | null;
  /** @deprecated use `advanced.createSink` */
  createSink?: (() => AudioSink) | null;
}

export interface HostOptions {
  name: string;
  maxPlayers: number;
  /**
   * "unlisted" (default): anyone with the code or link can join, but the lobby is not in `list()`.
   * "public": also listed. "private": the host approves each join.
   */
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

export const DEFAULT_READY_TIMEOUT_MS = 15_000;

function hasMic(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== "undefined";
}

function browserStorage(): SeatStorage | null {
  try {
    const s = (globalThis as { sessionStorage?: SeatStorage }).sessionStorage;
    return s ?? null;
  } catch {
    return null; // storage access can throw (sandboxed iframe, blocked cookies)
  }
}

interface Seat {
  code: string;
  token: string;
  server: string;
}

/**
 * Lobbies alive in this page, by resume token. A remembered seat that is still in use here (two kits in one tab,
 * e.g. a local two-player demo) must not be taken over; after a reload this set starts empty.
 */
const liveSeats = new Set<Lobby>();
function seatInUse(token: string): boolean {
  for (const l of liveSeats) if (l.resumeToken === token) return true;
  return false;
}

/** Entry point (DESIGN s.11.2). */
export class Keepalive extends Emitter<KeepaliveEvents> {
  readonly options: Required<Pick<KeepaliveOptions, "gameId" | "netVersion" | "lobbyServer" | "mode" | "tickRate" | "hashEveryTicks" | "displayName" | "relayOnly" | "readyTimeoutMs">>;
  private socketFactory: SocketFactory;
  private linkFactory: LinkFactory;
  private clock: Clock;
  private wall: () => number;
  private voiceCodec: VoiceCodec | null;
  private createMic: (() => FrameSource) | null;
  private createSink: (() => AudioSink) | null;
  private storage: SeatStorage | null;

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
      displayName: (o.displayName ?? "").trim(),
      relayOnly: o.relayOnly ?? false,
      readyTimeoutMs: o.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    };
    const a = o.advanced ?? {};
    const pick = <K extends keyof AdvancedOptions & keyof KeepaliveOptions>(k: K) => (a[k] !== undefined ? a[k] : o[k]);
    this.socketFactory = pick("socketFactory") ?? defaultSocketFactory;
    this.linkFactory = pick("linkFactory") ?? webRtcLinkFactory;
    this.clock = pick("clock") ?? systemClock;
    this.wall = pick("wallClock") ?? (() => Date.now());
    const codec = pick("voiceCodec");
    this.voiceCodec = codec !== undefined ? codec : webCodecsOpusAvailable() ? webCodecsOpus : null;
    const mic = pick("createMic");
    this.createMic = mic !== undefined ? mic : hasMic() ? () => new WorkletMic() : null;
    const sink = pick("createSink");
    this.createSink = sink !== undefined ? sink : typeof AudioContext !== "undefined" ? () => new WebAudioSink() : null;
    this.storage = o.rememberSeat === false ? null : a.storage !== undefined ? a.storage : browserStorage();
  }

  // ---- remembered seat -------------------------------------------------------------------------------------------

  private get seatKey(): string {
    return `keepalive.seat.${this.options.gameId}`;
  }

  private loadSeat(): Seat | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(this.seatKey);
      if (!raw) return null;
      const s = JSON.parse(raw) as Partial<Seat>;
      if (typeof s.code !== "string" || typeof s.token !== "string" || s.server !== this.options.lobbyServer) return null;
      return s as Seat;
    } catch {
      return null;
    }
  }

  private saveSeat(code: string, token: string): void {
    if (!this.storage || !token) return;
    try {
      this.storage.setItem(this.seatKey, JSON.stringify({ code, token, server: this.options.lobbyServer } satisfies Seat));
    } catch {
      /* quota or blocked storage: the seat just is not remembered */
    }
  }

  private clearSeat(code?: string): void {
    if (!this.storage) return;
    try {
      if (code !== undefined) {
        const s = this.loadSeat();
        if (s && s.code !== code) return;
      }
      this.storage.removeItem(this.seatKey);
    } catch {
      /* ignore */
    }
  }

  /** The lobby code of the seat this tab can take back (rememberSeat), or null. */
  get rememberedCode(): string | null {
    return this.loadSeat()?.code ?? null;
  }

  /**
   * Take back the seat remembered from before a page reload (host or joiner). Resolves null when there is none
   * or the server no longer holds it (the seat is forgotten then).
   */
  async resume(): Promise<Lobby | null> {
    const seat = this.loadSeat();
    if (!seat || seatInUse(seat.token)) return null;
    try {
      return await this.rejoin(seat.token);
    } catch (e) {
      if (e instanceof KeepaliveError && e.code === "invalid_token") {
        this.clearSeat();
        return null;
      }
      throw e;
    }
  }

  // ---- connecting ------------------------------------------------------------------------------------------------

  private helloMsg(resumeToken?: string): Record<string, unknown> {
    return {
      t: "hello",
      proto: PROTO_ID,
      gameId: this.options.gameId,
      netVersion: this.options.netVersion,
      client: { lib: LIB_NAME, ver: LIB_VERSION, platform: typeof navigator !== "undefined" ? "browser" : "node" },
      name: this.options.displayName.slice(0, 24),
      ...(resumeToken ? { resumeToken } : {}),
    };
  }

  private async connect(): Promise<{ sig: SignalingClient; welcome: WelcomeMsg }> {
    const sig = new SignalingClient(this.options.lobbyServer, this.socketFactory, this.clock);
    await sig.connect();
    try {
      const welcome = await sig.request<WelcomeMsg & { t: string }>(this.helloMsg(), "welcome");
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
      readyTimeoutMs: this.options.readyTimeoutMs,
    });
    lobby.errorSink = (e) => this.emit("error", e);
    if (this.storage) {
      liveSeats.add(lobby);
      this.saveSeat(lobby.code, lobby.resumeToken);
      lobby.seatSink = (token) => this.saveSeat(lobby.code, token);
      lobby.on("sessionEnded", () => {
        liveSeats.delete(lobby);
        this.clearSeat(lobby.code);
      });
    }
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
          visibility: h.visibility ?? "unlisted",
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
    const seat = this.loadSeat();
    if (seat && seat.code === norm && !seatInUse(seat.token)) {
      // Same tab, same lobby (a page reload): take the old seat back instead of joining as a new player.
      try {
        return await this.rejoin(seat.token);
      } catch (e) {
        this.clearSeat();
        if (!(e instanceof KeepaliveError && e.code === "invalid_token")) throw e;
      }
    }
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
      const welcomeP = sig.request<WelcomeMsg & { t: string }>(this.helloMsg(resumeToken), "welcome");
      lobbyP.catch(() => {}); // settled below or by close()
      const welcome = await welcomeP;
      // spec: an unknown or expired token is ignored -> plain welcome (no peerId), and no lobby follows
      if (welcome.peerId === undefined) throw new KeepaliveError("invalid_token", "resume token unknown or expired");
      const state = await lobbyP;
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
