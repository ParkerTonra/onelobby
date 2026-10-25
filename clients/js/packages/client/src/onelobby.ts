import { systemClock, type Clock } from "./clock.js";
import { Emitter } from "./emitter.js";
import { normalizeCode } from "./crockford.js";
import { Lobby, type RateLimit } from "./lobby.js";
import {
  OneLobbyError,
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
import { decodeJoinCode, encodeJoinCode, looksLikeJoinCode } from "./joincode.js";
import { DEFAULT_DIRECT_PORT, parseDirectAddress } from "./direct-address.js";

export const LIB_NAME = "onelobby";
export const LIB_VERSION = "0.2.1";

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

export interface OneLobbyOptions {
  gameId: string;
  netVersion: string;
  /** `ws://` / `wss://` URL of a onelobby-server. */
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
   * Treat a peer as gone after this many ms of silence. Joiners ping the host every 2 s and the host answers, so the
   * host drops a silent joiner (`peerLeft`, "timeout") and a joiner handles a silent host as lost (a direct lobby
   * ends with "host_left"). Default 0 (off): a silently dead peer then surfaces when its link or signaling socket
   * times out, within about 30 s. Values under 6000 are raised to 6000.
   */
  peerTimeoutMs?: number;
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
  /** Per-joiner cap on incoming raw messages, e.g. `{ messages: 60, perMs: 1000 }`; the excess is dropped before `message` fires or is relayed. */
  rateLimit?: RateLimit;
}

export interface ListOptions {
  meta?: Record<string, string>;
  limit?: number;
  cursor?: string;
}

export interface JoinDirectOptions {
  /** The host's password, if it set one; a wrong one fails with `bad_password`. */
  password?: string;
  /** Port for an address typed without one (default 47810, docs/direct-ip.md s.2). */
  defaultPort?: number;
  /** No answer on the host's TCP port within this long fails with `direct_unreachable` (default 5000). */
  connectTimeoutMs?: number;
}

/** @internal How onelobby/direct makes a host lobby: its own socket and link factory, and direct mode. */
export interface DirectLobbyHooks {
  socketFactory: SocketFactory;
  /** Wraps the kit's own link factory (port pin, no ICE servers). */
  wrapLinks: (inner: LinkFactory) => LinkFactory;
}

export type OneLobbyEvents = { error: [Error] };

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
export class OneLobby extends Emitter<OneLobbyEvents> {
  readonly options: Required<Pick<OneLobbyOptions, "gameId" | "netVersion" | "lobbyServer" | "mode" | "tickRate" | "hashEveryTicks" | "displayName" | "relayOnly" | "readyTimeoutMs" | "peerTimeoutMs">>;
  private socketFactory: SocketFactory;
  private linkFactory: LinkFactory;
  private clock: Clock;
  private wall: () => number;
  private voiceCodec: VoiceCodec | null;
  private createMic: (() => FrameSource) | null;
  private createSink: (() => AudioSink) | null;
  private storage: SeatStorage | null;

  constructor(o: OneLobbyOptions) {
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
      peerTimeoutMs: o.peerTimeoutMs ?? 0,
    };
    const a = o.advanced ?? {};
    const pick = <K extends keyof AdvancedOptions & keyof OneLobbyOptions>(k: K) => (a[k] !== undefined ? a[k] : o[k]);
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
    return `onelobby.seat.${this.options.gameId}`;
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
      if (e instanceof OneLobbyError && e.code === "invalid_token") {
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

  private async connect(url = this.options.lobbyServer, factory = this.socketFactory, timeoutMs = 0): Promise<{ sig: SignalingClient; welcome: WelcomeMsg }> {
    const sig = new SignalingClient(url, factory, this.clock);
    if (timeoutMs > 0) {
      let cancel = () => {};
      const timeout = new Promise<never>((_, reject) => {
        cancel = this.clock.setTimeout(() => reject(new OneLobbyError("direct_unreachable", `no answer from ${url} within ${timeoutMs} ms`)), timeoutMs);
      });
      try {
        await Promise.race([sig.connect(), timeout]);
      } catch (e) {
        sig.close();
        if (e instanceof OneLobbyError && e.code === "connect_failed") throw new OneLobbyError("direct_unreachable", `no answer from ${url}`);
        throw e;
      } finally {
        cancel();
      }
    } else await sig.connect();
    try {
      const welcome = await sig.request<WelcomeMsg & { t: string }>(this.helloMsg(), "welcome");
      return { sig, welcome };
    } catch (e) {
      sig.close();
      throw e;
    }
  }

  private makeLobby(sig: SignalingClient, welcome: WelcomeMsg, state: LobbyState, direct?: { links: LinkFactory }, rateLimit?: RateLimit): Lobby {
    const lobby = new Lobby({
      signaling: sig,
      state,
      ice: welcome.ice ?? [],
      links: direct?.links ?? this.linkFactory,
      direct: !!direct,
      clock: this.clock,
      wall: this.wall,
      hashEveryTicks: this.options.hashEveryTicks,
      relayOnly: state.relayOnly ?? this.options.relayOnly,
      displayName: this.options.displayName,
      voice: { codec: this.voiceCodec, createSource: this.createMic, createSink: this.createSink },
      readyTimeoutMs: this.options.readyTimeoutMs,
      peerTimeoutMs: this.options.peerTimeoutMs,
      rateLimit,
    });
    lobby.errorSink = (e) => this.emit("error", e);
    if (this.storage && !direct) {
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
      return this.makeLobby(sig, welcome, state, undefined, h.rateLimit);
    } catch (e) {
      sig.close();
      throw e;
    }
  }

  async join(code: string): Promise<Lobby> {
    const norm = normalizeCode(code);
    if (!norm) throw new OneLobbyError("bad_code", `"${code}" is not a valid join code`);
    const seat = this.loadSeat();
    if (seat && seat.code === norm && !seatInUse(seat.token)) {
      // Same tab, same lobby (a page reload): take the old seat back instead of joining as a new player.
      try {
        return await this.rejoin(seat.token);
      } catch (e) {
        this.clearSeat();
        if (!(e instanceof OneLobbyError && e.code === "invalid_token")) throw e;
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

  /**
   * Join a direct-IP host (docs/direct-ip.md): a join code from the host's screen (`6B01-RGFE-P2B`, any case, spaces
   * or hyphens) or, advanced, an address (`ip`, `ip:port`, `[v6]:port`). No lobby server is involved: the code is
   * the host's address. A mistyped code fails at once with `bad_code`; nobody listening is `direct_unreachable`.
   * The address is also given to ICE as the host's UDP candidate. When the host leaves, `sessionEnded("host_left")`.
   */
  async joinDirect(codeOrAddress: string, opts: JoinDirectOptions = {}): Promise<Lobby> {
    let input = codeOrAddress.trim();
    if (looksLikeJoinCode(input)) {
      const d = decodeJoinCode(input);
      if ("error" in d)
        throw new OneLobbyError(d.error, d.error === "unknown_version" ? `"${input}" is a join code from a newer version of the game` : `"${input}" is not a valid join code: check for a typo`);
      input = `${d.ip}:${d.port}`;
    }
    const addr = parseDirectAddress(input, opts.defaultPort ?? DEFAULT_DIRECT_PORT);
    if (!addr) throw new OneLobbyError("bad_address", `"${codeOrAddress}" is not a join code or an address (try 6B01-RGFE-P2B or 192.168.1.20:47810)`);
    const inner = this.linkFactory;
    const links: LinkFactory = { create: (o) => inner.create({ ...o, iceServers: [], extraRemoteCandidates: [addr.candidate] }) };
    const { sig, welcome } = await this.connect(addr.url, this.socketFactory, opts.connectTimeoutMs ?? 5000);
    try {
      const state = await sig.request<LobbyState>({ t: "join", ...(opts.password ? { password: opts.password } : {}) }, "lobby");
      const lobby = this.makeLobby(sig, welcome, state, { links });
      // a joiner's joinCode is what it joined with (normalized), so a HUD can show it on both sides
      lobby.joinCode = joinedWith(addr);
      return lobby;
    } catch (e) {
      sig.close();
      throw e;
    }
  }

  /** @internal onelobby/direct's host: create the one lobby on the embedded hub, in direct mode. */
  async hostDirectWith(h: HostOptions, hooks: DirectLobbyHooks): Promise<Lobby> {
    const { sig, welcome } = await this.connect("onelobby-direct://host/", hooks.socketFactory);
    try {
      const state = await sig.request<LobbyState>(
        { t: "create", name: h.name, maxPlayers: h.maxPlayers, visibility: "unlisted", mode: this.options.mode, tickRate: this.options.tickRate,
          lateJoin: h.lateJoin ?? true, meta: h.meta ?? {} },
        "lobby",
      );
      return this.makeLobby(sig, welcome, state, { links: hooks.wrapLinks(this.linkFactory) }, h.rateLimit);
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
      if (welcome.peerId === undefined) throw new OneLobbyError("invalid_token", "resume token unknown or expired");
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

/** The join code for an IPv4 address (a host name or IPv6 has none: its `host:port` instead). */
function joinedWith(addr: { host: string; port: number; isIPv6: boolean; display: string }): string {
  if (addr.isIPv6) return addr.display;
  try {
    return encodeJoinCode(addr.host, addr.port);
  } catch {
    return addr.display;
  }
}
