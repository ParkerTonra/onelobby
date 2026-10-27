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
import { decodeJoinCode, encodeJoinCode, encodeRoomCodeFor, looksLikeJoinCode } from "./joincode.js";
import { NostrSocket } from "./nostr/socket.js";
import { DEFAULT_NOSTR_STUN, type RelayConnect } from "./nostr/relays.js";
import { DEFAULT_DIRECT_PORT, parseDirectAddress } from "./direct-address.js";
import { BlueprintError, parseBlueprint, type Blueprint } from "./blueprint.js";
import { hostNostr, type BrowserHostOptions } from "./direct/browser-host.js";

export const LIB_NAME = "onelobby";
export const LIB_VERSION = "0.5.0";

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
  /** WebSocket to a Nostr relay (default: the runtime's `WebSocket`); for Node older than 22 or tests. */
  nostrConnect?: RelayConnect;
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

/** Per-launch settings for `OneLobby.fromConfig`; everything else comes from the blueprint. */
export interface FromConfigOverrides {
  /** The player's name. Checked against `players.identity` and `players.maxNameLength`. */
  displayName?: string;
  /** Wins over `hosting.lobbyServer` (the file is the bottom layer: put `?lobby=` / storage / `<meta>` lookups here). */
  lobbyServer?: string;
  /** Default: `lobby.rejoin` from the file. */
  rememberSeat?: boolean;
  advanced?: AdvancedOptions;
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
  /** Nostr relays for a Nostr code (version 1); default the blueprint's `hosting.nostrRelays`, else the library list. */
  nostrRelays?: string[];
  /** STUN servers for a Nostr code when the host offers none; default Google's and Cloudflare's public ones. */
  stun?: string[];
}

/** Where a direct join goes: a host address (TCP) or a Nostr room. */
interface DirectTarget {
  /** The display form of the version 1 code, or null for an address. */
  nostr: string | null;
  url: string;
  joinedWith: string;
  links: LinkFactory;
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
  private nostrConnectFn: RelayConnect | undefined;
  /** The validated, frozen onelobby.json this kit was built from (`OneLobby.fromConfig`); undefined for `new OneLobby`. */
  readonly blueprint?: Blueprint;

  /**
   * Build a kit from an onelobby.json (already parsed; docs/design/blueprint.md s.7). Throws `bad_config` for an
   * invalid file or name, `identity_anonymous` for a name when `players.identity` is "anonymous". Then `host()` and
   * `hostDirect()` default their options from the file and the file's chat/listing switches are enforced.
   */
  static fromConfig(json: unknown, overrides: FromConfigOverrides = {}): OneLobby {
    const bp = parseBlueprint(json);
    const name = (overrides.displayName ?? "").trim();
    if (name) {
      if (bp.players.identity === "anonymous") throw new OneLobbyError("identity_anonymous", "this game uses anonymous players: no display names");
      if (name.length > bp.players.maxNameLength)
        throw new BlueprintError("displayName", "length", `must be at most ${bp.players.maxNameLength} characters`);
    }
    const kit = new OneLobby({
      gameId: bp.game.id,
      netVersion: bp.game.netVersion,
      lobbyServer: overrides.lobbyServer ?? bp.hosting.lobbyServer,
      mode: bp.sync.mode === "lockstep" ? "lockstep" : "raw", // replication is C# only; JS speaks raw
      tickRate: bp.sync.tickRate,
      hashEveryTicks: bp.sync.hashEveryTicks,
      displayName: name,
      relayOnly: bp.hosting.relayOnly,
      readyTimeoutMs: bp.session.readyTimeoutMs,
      peerTimeoutMs: bp.session.peerTimeoutMs,
      rememberSeat: overrides.rememberSeat ?? bp.lobby.rejoin,
      advanced: overrides.advanced,
    });
    (kit as { blueprint?: Blueprint }).blueprint = bp;
    return kit;
  }

  /** @internal Host options the blueprint implies (empty without one). */
  blueprintHostDefaults(): Partial<HostOptions> {
    const bp = this.blueprint;
    if (!bp) return {};
    const name = this.options.displayName;
    return {
      name: name ? `${name}'s game` : "Game",
      maxPlayers: bp.lobby.maxPlayers,
      visibility: bp.lobby.listed ? "public" : bp.lobby.approveJoins ? "private" : "unlisted",
      lateJoin: bp.lobby.lateJoin,
      meta: { ...bp.lobby.meta },
      ...(bp.session.rateLimit ? { rateLimit: { ...bp.session.rateLimit } } : {}),
    };
  }

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
    this.nostrConnectFn = a.nostrConnect;
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
    const sig = await this.open(url, factory, timeoutMs);
    try {
      const welcome = await sig.request<WelcomeMsg & { t: string }>(this.helloMsg(), "welcome");
      return { sig, welcome };
    } catch (e) {
      sig.close();
      throw e;
    }
  }

  /** The signaling socket only (no hello yet); with a timeout (direct IP), no answer is `direct_unreachable`. */
  private async open(url: string, factory: SocketFactory, timeoutMs: number): Promise<SignalingClient> {
    if (!url.trim() && factory === defaultSocketFactory) throw new OneLobbyError("no_server", "no lobby server address (set hosting.lobbyServer or pass lobbyServer)");
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
    return sig;
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
    if (this.blueprint) guardLobby(lobby, this.blueprint);
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

  /** With a blueprint (`fromConfig`) every option defaults from `lobby.*`; explicit options win. */
  async host(opts?: Partial<HostOptions>): Promise<Lobby> {
    const h = { name: "Game", maxPlayers: 4, ...this.blueprintHostDefaults(), ...definedOnly(opts) } as HostOptions;
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
    const t = this.directTarget(codeOrAddress, opts);
    const { sig, welcome } = await this.connectDirect(t, opts);
    try {
      const state = await sig.request<LobbyState>({ t: "join", ...(opts.password ? { password: opts.password } : {}) }, "lobby");
      const lobby = this.makeLobby(sig, this.withStun(welcome, t, opts), state, { links: t.links });
      // a joiner's joinCode is what it joined with (normalized), so a HUD can show it on both sides
      lobby.joinCode = t.joinedWith;
      return lobby;
    } catch (e) {
      sig.close();
      throw e;
    }
  }

  /**
   * Take a direct-IP seat back after a drop or a restart: the code (or address) joined before and that lobby's
   * `resumeToken` (save it after every join; it changes on each resume). The host keeps a dropped seat for 60 s and the
   * same peer id comes back. Rejects with `invalid_token` when the seat is gone: offer `joinDirect` then.
   */
  async rejoinDirect(codeOrAddress: string, resumeToken: string, opts: JoinDirectOptions = {}): Promise<Lobby> {
    const t = this.directTarget(codeOrAddress, opts);
    const lobby = await this.resumeAt(resumeToken, t.url, t.nostr ? 0 : opts.connectTimeoutMs ?? 5000, { links: t.links }, t.nostr ? this.nostrFactory(t, opts) : undefined, (w) => this.withStun(w, t, opts));
    lobby.joinCode = t.joinedWith;
    return lobby;
  }

  private nostrFactory(t: DirectTarget, opts: JoinDirectOptions): SocketFactory {
    const relays = opts.nostrRelays ?? (this.blueprint ? [...this.blueprint.hosting.nostrRelays] : undefined);
    return () =>
      new NostrSocket({ code: t.nostr!, relays: relays && relays.length > 0 ? relays : undefined, connect: this.nostrConnectFn, clock: this.clock, wall: this.wall });
  }

  /** Opens the signaling socket of a direct target: TCP to the host's address, or Nostr relays for a version 1 code. */
  private async connectDirect(t: DirectTarget, opts: JoinDirectOptions): Promise<{ sig: SignalingClient; welcome: WelcomeMsg }> {
    if (!t.nostr) return this.connect(t.url, this.socketFactory, opts.connectTimeoutMs ?? 5000);
    // the socket enforces its own deadlines (10 s to reach a relay, 15 s for the host to answer)
    let sock: NostrSocket | null = null;
    const factory = this.nostrFactory(t, opts);
    try {
      return await this.connect(t.url, (u) => (sock = factory(u) as NostrSocket), 0);
    } catch (e) {
      const why = (sock as NostrSocket | null)?.failure;
      // same code as an IP host that does not answer, so a game handles one "could not reach the host" error
      if (e instanceof OneLobbyError && e.code === "connect_failed") throw new OneLobbyError("direct_unreachable", why || "no answer through the Nostr relays");
      throw e;
    }
  }

  /** A Nostr joiner needs STUN; take the host's list (it comes in `welcome`), else the public defaults. */
  private withStun(welcome: WelcomeMsg, t: DirectTarget, opts: JoinDirectOptions): WelcomeMsg {
    if (!t.nostr || (welcome.ice && welcome.ice.length > 0)) return welcome;
    const urls = opts.stun ?? [...DEFAULT_NOSTR_STUN];
    return urls.length > 0 ? { ...welcome, ice: [{ urls }] } : welcome;
  }

  private directTarget(codeOrAddress: string, opts: JoinDirectOptions): DirectTarget {
    let input = codeOrAddress.trim();
    if (looksLikeJoinCode(input)) {
      const d = decodeJoinCode(input);
      if ("error" in d)
        throw new OneLobbyError(d.error, d.error === "unknown_version" ? `"${input}" is a join code from a newer version of the game` : `"${input}" is not a valid join code: check for a typo`);
      if ("room" in d) {
        // version 1: a Nostr room; signaling runs over public relays (spec/nostr-signaling.md), WebRTC uses STUN
        const shown = encodeRoomCodeFor(d.room);
        return { nostr: shown, url: `nostr:${shown}`, joinedWith: shown, links: this.linkFactory };
      }
      input = `${d.ip}:${d.port}`;
    }
    const addr = parseDirectAddress(input, opts.defaultPort ?? DEFAULT_DIRECT_PORT);
    if (!addr) throw new OneLobbyError("bad_address", `"${codeOrAddress}" is not a join code or an address (try 6B01-RGFE-P2B or 192.168.1.20:47810)`);
    const inner = this.linkFactory;
    const links: LinkFactory = { create: (o) => inner.create({ ...o, iceServers: [], extraRemoteCandidates: [addr.candidate] }) };
    return { nostr: null, url: addr.url, joinedWith: joinedWith(addr), links };
  }

  /** @internal onelobby/direct's Nostr host: the relay seam and the kit's clocks. */
  nostrHostEnv(): { connect: RelayConnect | undefined; clock: Clock; wall: () => number } {
    return { connect: this.nostrConnectFn, clock: this.clock, wall: this.wall };
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

  /**
   * Host a direct lobby from this browser tab (or any runtime with WebSocket and WebRTC): no Node process, no port.
   * The hub runs in the page and joiners find it through Nostr relays with `lobby.joinCode` (a dc1 version 1 code,
   * `joinCodeKind` "nostr"); they use `kit.joinDirect(code)`. Rejects with `direct_unreachable` when no relay answers
   * within 10 s (a browser has no IP fallback) and `nostr_disabled` when the blueprint has `hosting.nostr` false.
   * Keep the tab visible: hidden tabs are throttled (`lobby.hostHidden`, event `hostHiddenChanged`).
   */
  hostNostr(opts: BrowserHostOptions = {}): Promise<Lobby> {
    return hostNostr(this, opts);
  }

  async rejoin(resumeToken: string): Promise<Lobby> {
    return this.resumeAt(resumeToken, this.options.lobbyServer, 0);
  }

  private async resumeAt(
    resumeToken: string,
    url: string,
    timeoutMs: number,
    direct?: { links: LinkFactory },
    factory?: SocketFactory,
    tweakWelcome?: (w: WelcomeMsg) => WelcomeMsg,
  ): Promise<Lobby> {
    const sig = await this.open(url, factory ?? this.socketFactory, timeoutMs);
    try {
      // The server answers hello(resumeToken) with welcome then the full lobby state; listen for both up front.
      const lobbyP = sig.expect<LobbyState>("lobby");
      const welcomeP = sig.request<WelcomeMsg & { t: string }>(this.helloMsg(resumeToken), "welcome");
      lobbyP.catch(() => {}); // settled below or by close()
      const welcome = tweakWelcome ? tweakWelcome(await welcomeP) : await welcomeP;
      // spec: an unknown or expired token is ignored -> plain welcome (no peerId), and no lobby follows
      if (welcome.peerId === undefined) throw new OneLobbyError("invalid_token", "resume token unknown or expired");
      const state = await lobbyP;
      return this.makeLobby(sig, welcome, state, direct);
    } catch (e) {
      sig.close();
      throw e;
    }
  }

  async list(opts: ListOptions = {}): Promise<LobbySummary[]> {
    if (this.blueprint && !this.blueprint.hosting.server) throw new OneLobbyError("listing_disabled", "this game has no lobby server (hosting.server is false)");
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

function definedOnly<T extends object>(o: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (o) for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Blueprint switches that gate features on the lobby: voice and text chat; chat.voiceMode is the starting voice mode. */
function guardLobby(lobby: Lobby, bp: Blueprint): void {
  lobby.voice.mode = bp.chat.voiceMode;
  if (!bp.chat.voice) {
    const voice = lobby.voice;
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(voice), "enabled");
    if (d?.get && d.set) {
      Object.defineProperty(voice, "enabled", {
        configurable: true,
        get: () => d.get!.call(voice) as boolean,
        set: (v: boolean) => {
          if (v) throw new OneLobbyError("voice_disabled", "this game has voice chat turned off (chat.voice is false)");
          d.set!.call(voice, v);
        },
      });
    }
  }
  lobby.pause.mode = bp.session.pause;
  if (!bp.chat.text) {
    lobby.chat.send = () => {
      throw new OneLobbyError("chat_disabled", "this game has text chat turned off (chat.text is false)");
    };
  }
}
