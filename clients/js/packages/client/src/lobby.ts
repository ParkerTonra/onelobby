import { Chat } from "./chat.js";
import type { Clock } from "./clock.js";
import {
  CodecError,
  MAX_FRAME_BYTES,
  MODE_LOCKSTEP,
  MODE_RAW,
  PROTO,
  decodeMessage,
  encodeMessage,
  type Message,
} from "./codec.js";
import { Reassembler, splitChunks } from "./chunking.js";
import { Emitter } from "./emitter.js";
import type { Hub } from "./hub.js";
import { Lockstep } from "./lockstep.js";
import { claimWinsWrapped, pickNewHost } from "./migration.js";
import { Pause } from "./pause.js";
import { OneLobbyError, type LobbyState, type PeerInfo, type SignalingClient, type ServerMsg } from "./signaling.js";
import type { ChannelName, IceServer, LinkFactory, PeerLink, SignalPayload } from "./transport.js";
import { Voice, type VoiceDeps } from "./voice.js";
import { hostConnections, joinerSocket, type LobbySocket, type LobbySocketOptions } from "./socket.js";

export type Phase = "lobby" | "in_game";
/** The close code and reason a host chose with `kick()` / `disconnect()`, passed to the removed player's sockets. */
export interface CloseInfo {
  code?: number;
  reason?: string;
}
/** Options for `lobby.kick()`. */
export interface KickOptions {
  /** Default true: the player's address cannot rejoin this lobby while it lasts. false = `disconnect()`. */
  ban?: boolean;
  /** Close code for the player's `asWebSocket()` onclose: 1000 or 3000-4999. */
  code?: number;
  /** Close reason for that onclose, at most 120 characters. */
  reason?: string;
}
export type Peer = PeerInfo;

/** What a direct host's `joinCode` is: see {@link Lobby.joinCodeKind}. */
export type JoinCodeKind = "nostr" | "internet" | "same_network" | "none";

export type LobbyEvents = {
  peerJoined: [Peer];
  /** The peer's data channels are open and the handshake is done: reliable sends reach it now (earlier ones were queued and flushed). */
  peerReady: [Peer];
  /** Joiner: the link to the host is open (the host itself is ready from the start). Also available as `lobby.ready`. */
  ready: [];
  /** reason "left", "kicked", "disconnected" (kick with ban false), "timeout", ...; `close` when the host gave one. */
  peerLeft: [Peer, reason: string, close?: CloseInfo];
  /**
   * Host only: a joiner never got its link to the host open ("a friend could not connect"). reason "timeout" when it is
   * not ready `readyTimeoutMs` after joining (it may still connect: `peerReady` then fires as usual), else the
   * `peerLeft` reason when it leaves before it was ready (a joiner's own `ice_failed` ends that way). Fires at most once
   * per peer, just before that `peerLeft`; not for peers the host kicks or disconnects.
   */
  peerFailed: [Peer, reason: string];
  joinRequested: [Peer];
  hostChanged: [hostId: number];
  phase: [Phase];
  message: [from: number, bytes: Uint8Array, channel: ChannelName];
  /** `close` is the code and reason the host gave when it removed this player (`kick()` / `disconnect()`). */
  sessionEnded: [reason: string, close?: CloseInfo];
  /** The signaling server went away. The game continues on the data channels (s.9). */
  serverLost: [];
  metaChanged: [Record<string, string>];
  /**
   * Direct-IP host only: the join code changed after `hostDirect` resolved, e.g. the router answered a later port-mapping
   * retry and the code went from "same_network" to "internet". Show the new code (and `joinUrl`).
   */
  joinCodeChanged: [code: string, kind: JoinCodeKind];
  /**
   * Browser host only (`kit.hostNostr`): the host tab went hidden (`true`) or visible again (`false`). Browsers throttle
   * timers in hidden tabs, so joiners may see lag or drop; ask the host to keep the tab visible.
   */
  hostHiddenChanged: [hidden: boolean];
};

export interface LobbyConfig {
  signaling: SignalingClient;
  state: LobbyState;
  ice: IceServer[];
  links: LinkFactory;
  clock: Clock;
  wall: () => number;
  hashEveryTicks: number;
  relayOnly: boolean;
  voice: VoiceDeps;
  displayName: string;
  /**
   * Joiner: give up on reaching the host after this many ms (0 or absent: wait forever). When the ICE list has a
   * TURN server and the lobby is not relay-only already, the second half of the budget is a relay-only retry.
   * On failure `ready` rejects with OneLobbyError("ice_failed"), the error is reported and the lobby is left.
   */
  readyTimeoutMs?: number;
  /**
   * Direct IP (docs/direct-ip.md): the hub lives in the host, so there is no migration. A joiner that loses the host
   * (link, peer_left, a host_changed from the hub as it shuts down, or the signaling socket) ends with "host_left".
   */
  direct?: boolean;
  /**
   * Treat a peer as gone after this many ms without hearing anything from it (0 or absent: off, and a silent peer
   * surfaces only when its link or signaling socket times out, about 30 s). Joiners ping the host every 2 s and the
   * host answers, so the host drops a silent joiner (`peerLeft`, "timeout") and a joiner handles a silent host as
   * lost (a direct lobby ends with "host_left"). Values under 6000 are raised to 6000.
   */
  peerTimeoutMs?: number;
  /** Host: per-peer cap on incoming raw messages; the excess is dropped before `message` fires or is relayed. */
  rateLimit?: RateLimit;
}

/** At most `messages` raw messages per peer in any `perMs` window (a fixed window, reset every `perMs`). */
export interface RateLimit {
  messages: number;
  perMs: number;
}

/** The smallest `peerTimeoutMs` honoured: three missed pings. */
export const MIN_PEER_TIMEOUT_MS = 6000;
/** Host: how long a kicked / disconnected peer's link stays open for the hub's notice to reach it first. */
export const KICK_LINGER_MS = 3000;

/** The name shown for a peer that chose none: "Player N", N = its seat (peer id, join order). */
export function seatName(p: PeerInfo): PeerInfo {
  const n = typeof p.name === "string" ? p.name.trim() : "";
  // "Player" is onelobby-server's stand-in for an empty name
  if (n && n !== "Player") return p;
  return { ...p, name: `Player ${p.peerId}` };
}

function hasRelay(ice: IceServer[]): boolean {
  return ice.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(String(u))));
}

const HOST_WATCHDOG_MS = 250;
const PING_EVERY_MS = 2000;

/** One joined lobby: roster, star of peer links, and the lockstep/chat/voice engines riding on them. */
export class Lobby extends Emitter<LobbyEvents> {
  readonly code: string;
  readonly mode: "lockstep" | "raw";
  readonly tickRate: number;
  readonly lockstep: Lockstep;
  readonly chat: Chat;
  /** The shared co-op pause (docs/recipes/pause.md). */
  readonly pause: Pause;
  readonly voice: Voice;

  localPeerId: number;
  hostPeerId: number;
  phase: Phase;
  meta: Record<string, string>;
  /** The lobby's name as the server keeps it (host()'s `name`, sanitised); "" if the server sends none. */
  name: string;
  resumeToken: string;
  /** Last measured round trip to the host in ms (joiners), or 0. */
  rtt = 0;
  /**
   * Direct-IP host only (onelobby/direct): the code friends paste to join, e.g. "6B01-RGFE-P2B" (docs/direct-ip.md
   * s.2a). Show it with joinCodeKind. Empty when the machine has no IPv4 address, and on joiners.
   */
  joinCode = "";
  /**
   * "nostr": a version 1 code that works through public Nostr relays (spec/nostr-signaling.md; the default for a direct
   * host). "internet": the router forwarded the port and the code carries its public address; "same_network": the LAN
   * address. "none": no code.
   */
  joinCodeKind: JoinCodeKind = "none";
  /**
   * Direct-IP host only: the IP code (address and port, version 0), with `directCodeKind` "internet" or "same_network".
   * Equal to `joinCode` when Nostr is off; otherwise the code to hand out for LAN play or when the router port is open.
   */
  directCode = "";
  directCodeKind: "internet" | "same_network" | "none" = "none";
  /** Direct-IP host only: this machine's addresses with the port, for an "Advanced" fold-out. */
  directAddresses: string[] = [];
  /** Direct-IP host only: how the router port-open went ("UPnP", "no UPnP gateway answered; ...", "off"). */
  portMapping = "";
  /** Direct-IP host only: the one startup line (bound port, join code, port mapping); see `formatHostLog` in onelobby/direct. */
  directHostLog = "";

  /** Browser host only (`kit.hostNostr`): true while the host tab is hidden (see the `hostHiddenChanged` event). */
  hostHidden = false;

  /** @internal kit.hostNostr: the tab's visibility changed. */
  setHostHidden(hidden: boolean): void {
    if (this.hostHidden === hidden) return;
    this.hostHidden = hidden;
    this.emit("hostHiddenChanged", hidden);
  }

  /** @internal onelobby/direct: fires `joinCodeChanged` with the current code. */
  notifyJoinCodeChanged(): void {
    this.emit("joinCodeChanged", this.joinCode, this.joinCodeKind);
  }

  private signaling: SignalingClient;
  private cfg: LobbyConfig;
  private roster = new Map<number, Peer>();
  private links = new Map<number, PeerLink>();
  /** ICE from a peer that has no link yet: its candidates can overtake its offer (node-datachannel). */
  private earlyIce = new Map<number, SignalPayload[]>();
  private connected = new Set<number>(); // host: peers that said hi
  private hiSentTo = new Set<PeerLink>();
  private epoch = 0;
  private ended = false;
  private serverUp = true;
  private cancelWatchdog: (() => void) | null = null;
  private cancelPing: (() => void) | null = null;
  private pingN = 0;
  private chunkId = 1;
  private reassemblers = new Map<number, Reassembler>();
  private hub: Hub;
  private outbox = new Map<number, { msg: Message; route: number; channel?: ChannelName }[]>();
  private markReady: () => void = () => {};
  private failReady: (e: Error) => void = () => {};
  private isReady = false;
  private cancelReadyTimer: (() => void) | null = null;
  private relayRetry = false;
  /** clock.now() of the last frame from each peer (peerTimeoutMs). */
  private lastHeard = new Map<number, number>();
  /** Host: links of kicked / disconnected peers, kept open briefly (removePeer `linger`). */
  private readonly lingering = new Set<PeerLink>();
  /** Host: joiners that joined but are not ready yet, with the cancel of their readyTimeoutMs timer (peerFailed). */
  private notReady = new Map<number, () => void>();
  /** Host: per-peer fixed window for rateLimit. */
  private rate = new Map<number, { start: number; n: number }>();
  /**
   * Resolves when this peer can exchange data: immediately for the host, once the link to the host is open for a
   * joiner. Rejects with OneLobbyError("ice_failed") when the joiner cannot reach the host in `readyTimeoutMs`
   * (or with "closed"/"kicked" when the lobby ends first; "closed" also when the host disconnected it).
   */
  readonly ready: Promise<void> = new Promise<void>((res, rej) => {
    this.markReady = () => {
      if (this.isReady) return;
      this.isReady = true;
      this.cancelReadyTimer?.();
      this.cancelReadyTimer = null;
      res();
    };
    this.failReady = rej;
  });

  constructor(cfg: LobbyConfig) {
    super();
    this.cfg = cfg;
    this.signaling = cfg.signaling;
    const st = cfg.state;
    this.code = st.code;
    this.mode = st.mode;
    this.tickRate = st.tickRate;
    this.localPeerId = st.you;
    this.hostPeerId = st.hostId;
    this.phase = st.phase;
    this.meta = { ...st.meta };
    this.name = st.name ?? "";
    this.resumeToken = st.resumeToken;
    for (const p of st.peers) this.roster.set(p.peerId, seatName(p));
    this.ready.catch(() => {}); // a rejection is also reported through errorSink; awaiting `ready` stays optional

    const self = this;
    this.hub = {
      get clock() { return self.cfg.clock; },
      get localPeerId() { return self.localPeerId; },
      get hostPeerId() { return self.hostPeerId; },
      get isHost() { return self.isHost; },
      get tickRate() { return self.tickRate; },
      connectedPeers: () => self.connectedPeerIds(),
      sendTo: (peerId, msg, route, channel) => self.sendTo(peerId, msg, route ?? 0, channel),
      sendToHost: (msg, route, channel) => {
        if (!self.isHost) self.sendTo(self.hostPeerId, msg, route ?? 0, channel);
      },
      dropPeer: (peerId, reason) => self.dropPeer(peerId, reason),
      reportError: (e) => self.reportError(e),
      nextChunkId: () => self.chunkId++ >>> 0,
    };

    this.lockstep = new Lockstep(this.hub, { hashEveryTicks: cfg.hashEveryTicks });
    this.chat = new Chat(this.hub, cfg.wall, (id) => this.voice.isMutedPeer(id));
    this.voice = new Voice(this.hub, cfg.voice);
    this.pause = new Pause(this.hub, {
      phase: () => this.phase,
      hold: (held) => this.lockstep.hold(held),
      hasPeer: (id) => this.roster.has(id),
    });
    this.lockstep.on("started", () => this.setPhase("in_game"));
    this.lockstep.on("error", (e) => this.reportError(e));

    this.signaling.onMessage = (m) => this.onSignaling(m);
    this.signaling.onClose = () => this.onServerClosed();

    if (this.isHost) this.markReady();
    else this.armReadyTimer();
    if (this.isHost && this.mode === "lockstep") {
      if (this.phase === "in_game") this.lockstep.hostStart();
      else this.lockstep.hostIdle();
    }
    this.cancelWatchdog = cfg.clock.setInterval(() => this.watchdog(), HOST_WATCHDOG_MS);
    this.cancelPing = cfg.clock.setInterval(() => this.pingHost(), PING_EVERY_MS);
  }

  // ---- state -----------------------------------------------------------------------------------------------------

  get isHost(): boolean {
    return this.localPeerId === this.hostPeerId;
  }
  get peers(): Peer[] {
    return [...this.roster.values()].sort((a, b) => a.peerId - b.peerId);
  }
  peer(peerId: number): Peer | undefined {
    return this.roster.get(peerId);
  }
  /** Peers whose link is open and handshake done (host: the ready joiners; joiner: the host once ready). */
  get connectedPeers(): number[] {
    return this.connectedPeerIds();
  }

  /**
   * Joiner: the link to the host as a WebSocket-shaped object (text by default), so WebSocket client code runs
   * unchanged. It opens when `ready` resolves and closes when the session ends (`host_left` gives code 1001).
   */
  asWebSocket(opts?: LobbySocketOptions): LobbySocket {
    return joinerSocket(this, opts);
  }

  /** Host: `handler(conn)` once per joiner (a WebSocket-shaped connection), the server-side mirror of asWebSocket(). */
  onConnection(handler: (conn: LobbySocket) => void, opts?: LobbySocketOptions): () => void {
    return hostConnections(this, handler, opts);
  }

  set snapshotChunkSize(n: number) {
    this.lockstep.chunkSize = n;
  }

  /** Current migration epoch (0 until the first host change). */
  get hostEpoch(): number {
    return this.epoch;
  }

  /** @internal Host role: create the link to `peerId` and start negotiating (adapters and tests). */
  _offer(peerId: number): PeerLink {
    this.offerTo(peerId);
    return this.links.get(peerId)!;
  }

  /** @internal Joiner role: create the answering link to `peerId` (adapters and tests). */
  _answer(peerId: number): PeerLink {
    return this.makeLink(peerId);
  }

  /** @internal Called by OneLobby right after construction: the host waits for joiners, a joiner waits for the host's offer. */
  _begin(): void {
    /* joiners are passive until the host offers; hosts create links on peer_joined */
  }

  // ---- game-facing actions ---------------------------------------------------------------------------------------

  async start(): Promise<void> {
    if (!this.isHost) throw new Error("only the host can start the game");
    if (this.phase === "in_game") return;
    this.signaling.send({ t: "phase", phase: "in_game" });
    this.setPhase("in_game");
    if (this.mode === "lockstep") this.lockstep.hostStart();
  }

  async setMeta(meta: Record<string, string>): Promise<void> {
    if (!this.isHost) throw new Error("only the host can set metadata");
    this.meta = { ...meta };
    this.signaling.send({ t: "meta", meta });
    this.emit("metaChanged", this.meta);
  }

  /**
   * Host: removes a player. By default it is a ban: the hub refuses that player's address for the rest of this lobby
   * (a new tab or a reload included). `{ ban: false }` is `disconnect()`. `code` / `reason` reach the player's
   * `asWebSocket()` onclose (and `sessionEnded`'s second argument); without them its socket closes with 4000 "kicked".
   */
  async kick(peerId: number, opts: KickOptions = {}): Promise<void> {
    if (!this.isHost) throw new Error("only the host can kick");
    const { ban = true, code, reason } = opts;
    if (code !== undefined && !(code === 1000 || (Number.isInteger(code) && code >= 3000 && code <= 4999)))
      throw new RangeError("close code must be 1000 or 3000-4999");
    if (reason !== undefined && reason.length > 120) throw new RangeError("close reason must be at most 120 characters");
    const msg: Record<string, unknown> = { t: "kick", peerId };
    if (!ban) msg.ban = false;
    if (code !== undefined) msg.closeCode = code;
    if (reason !== undefined) msg.closeReason = reason;
    this.signaling.send(msg as { t: "kick"; peerId: number });
    const close: CloseInfo | undefined = code !== undefined || reason !== undefined ? { code, reason } : undefined;
    this.removePeer(peerId, ban ? "kicked" : "disconnected", close, true);
  }

  /**
   * Host: ends one player's connection without a ban, like a server closing one WebSocket. The player's
   * `asWebSocket()` gets onclose with `code` (default 1000) and `reason` (default "disconnected"), its lobby ends with
   * `sessionEnded("disconnected")`, and it may join again (a new tab, a reload). Same as `kick(peerId, { ban: false, code, reason })`.
   */
  disconnect(peerId: number, code?: number, reason?: string): Promise<void> {
    return this.kick(peerId, { ban: false, code, reason });
  }

  async approve(peerId: number, ok: boolean): Promise<void> {
    if (!this.isHost) throw new Error("only the host can approve joins");
    this.signaling.send({ t: "approve", peerId, ok });
  }

  async leave(): Promise<void> {
    if (this.ended) return;
    this.signaling.send({ t: "leave" });
    this.teardown("left");
  }

  /** raw mode (and any extra game data): to one peer. */
  send(peerId: number, bytes: Uint8Array, opts: { channel?: "reliable" | "fast" } = {}): void {
    const channel = opts.channel ?? "reliable";
    if (this.isHost) this.sendTo(peerId, { type: "raw", bytes }, this.localPeerId, channel);
    else this.sendTo(this.hostPeerId, { type: "raw", bytes }, peerId, channel);
  }

  /** To everyone else in the lobby. */
  broadcast(bytes: Uint8Array, opts: { channel?: "reliable" | "fast" } = {}): void {
    const channel = opts.channel ?? "reliable";
    if (this.isHost) {
      // peers whose channels are not open yet get reliable broadcasts queued and flushed in order
      for (const p of this.roster.keys()) if (p !== this.localPeerId) this.sendTo(p, { type: "raw", bytes }, this.localPeerId, channel);
    } else {
      this.sendTo(this.hostPeerId, { type: "raw", bytes }, 0, channel);
    }
  }

  // ---- sending ---------------------------------------------------------------------------------------------------

  private channelFor(msg: Message): ChannelName {
    if (msg.type === "voice") return "voice";
    if (msg.type === "ping" || msg.type === "pong") return "fast";
    return "reliable";
  }

  private sendTo(peerId: number, msg: Message, route: number, channel?: ChannelName): void {
    const link = this.links.get(peerId);
    const ch0 = channel ?? this.channelFor(msg);
    const queueable = msg.type === "raw" || msg.type === "chat" || msg.type === "cmd";
    // game data to a host-side peer waits for its `hi`; protocol messages only need the link
    const ready = !!link?.isOpen && (!queueable || !this.isHost || this.connected.has(peerId));
    if (!ready) {
      // Reliable game data for a peer that is in the roster (or is the host) but not connected yet waits for its handshake.
      const known = this.roster.has(peerId) || peerId === this.hostPeerId;
      if (queueable && ch0 === "reliable" && known && !this.ended) {
        let q = this.outbox.get(peerId);
        if (!q) this.outbox.set(peerId, (q = []));
        if (q.length >= 1000) q.shift();
        q.push({ msg, route, channel });
      }
      return;
    }
    if (!link) return;
    try {
      const ch = ch0;
      let bytes: Uint8Array;
      try {
        bytes = encodeMessage(msg, route);
      } catch (e) {
        if (!(e instanceof CodecError) || e.code !== "too_long") throw e;
        bytes = encodeMessage(msg, route, true);
      }
      if (bytes.length > MAX_FRAME_BYTES) {
        // Oversized frame: send the whole inner frame as a chunk set (spec/binary.md "Large non-snapshot frames").
        for (const c of splitChunks(this.chunkId++ >>> 0, bytes)) link.send(ch, encodeMessage(c, route));
      } else {
        link.send(ch, bytes);
      }
    } catch (e) {
      this.reportError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private connectedPeerIds(): number[] {
    if (this.isHost) return [...this.connected].filter((id) => this.links.get(id)?.isOpen).sort((a, b) => a - b);
    const l = this.links.get(this.hostPeerId);
    return l?.isOpen ? [this.hostPeerId] : [];
  }

  private reportError(e: Error): void {
    this.errorSink?.(e);
  }
  /** @internal set by OneLobby so lobby errors reach `kit.on("error")`. */
  errorSink: ((e: Error) => void) | null = null;
  /** @internal set by OneLobby: the server issued a new resume token (rememberSeat). */
  seatSink: ((token: string) => void) | null = null;

  // ---- joiner connect timeout -------------------------------------------------------------------------------------

  private armReadyTimer(): void {
    const total = this.cfg.readyTimeoutMs ?? 0;
    if (!(total > 0)) return;
    const canRelay = !this.cfg.relayOnly && hasRelay(this.cfg.ice);
    const first = canRelay ? Math.ceil(total / 2) : total;
    this.cancelReadyTimer = this.cfg.clock.setTimeout(() => {
      if (this.isReady || this.ended) return;
      if (canRelay) this.retryRelayed(total - first);
      else this.giveUpConnecting();
    }, first);
  }

  /** The direct attempt stalled: dial the host ourselves through the TURN relay (a host answers any offer). */
  private retryRelayed(budget: number): void {
    this.relayRetry = true;
    const link = this.makeLink(this.hostPeerId, true);
    link.startOffer();
    this.cancelReadyTimer = this.cfg.clock.setTimeout(() => {
      if (!this.isReady && !this.ended) this.giveUpConnecting();
    }, budget);
  }

  private giveUpConnecting(): void {
    const err = new OneLobbyError("ice_failed", `could not open a connection to the host${this.relayRetry ? " (direct or relayed)" : ""}`);
    this.failReady(err);
    this.reportError(err);
    if (this.ended) return;
    this.signaling.send({ t: "leave" });
    this.teardown("ice_failed");
  }

  // ---- links -----------------------------------------------------------------------------------------------------

  private makeLink(peerId: number, relayOnly = this.cfg.relayOnly): PeerLink {
    const old = this.links.get(peerId);
    if (old) {
      old.onClose = null;
      old.onMessage = null;
      old.close();
    }
    const link = this.cfg.links.create({ remoteId: peerId, iceServers: this.cfg.ice, relayOnly });
    this.links.set(peerId, link);
    link.onSignal = (s) => this.signaling.send({ t: "signal", to: peerId, ...s });
    link.onOpen = () => this.onLinkOpen(peerId, link);
    link.onClose = (reason) => this.onLinkClosed(peerId, link, reason);
    link.onMessage = (ch, bytes) => this.onData(peerId, ch, bytes);
    link.onPath = (path) => this.signaling.send({ t: "path", path });
    return link;
  }

  /** Host side: offer to a joiner. */
  private offerTo(peerId: number): void {
    const link = this.makeLink(peerId);
    link.startOffer();
  }

  private onLinkOpen(peerId: number, link: PeerLink): void {
    if (this.isHost) {
      // Joiner speaks first (`hi`). After a migration the new host announces itself so the joiner knows who won.
      if (this.epoch > 0) this.sendTo(peerId, { type: "host_claim", epoch: this.epoch, hostId: this.localPeerId, tick: this.lockstep.lastTick }, 0);
      return;
    }
    if (peerId === this.hostPeerId) this.sendHi(link);
    // else: an unexpected offerer; wait for its host_claim before trusting it
  }

  private sendHi(link: PeerLink): void {
    if (this.hiSentTo.has(link)) return;
    this.hiSentTo.add(link);
    this.lockstep.touch();
    link.send("reliable", encodeMessage(this.lockstep.hiMessage(this.localPeerId)));
    this.markReady();
    this.emit("ready");
    this.emit("peerReady", this.roster.get(link.remoteId) ?? { peerId: link.remoteId, name: "" });
    this.flush(link.remoteId);
  }

  private onLinkClosed(peerId: number, link: PeerLink, _reason: string): void {
    if (this.links.get(peerId) !== link) return; // replaced
    this.links.delete(peerId);
    this.hiSentTo.delete(link);
    if (this.ended) return;
    if (this.isHost) {
      this.connected.delete(peerId);
      this.lockstep.onPeerLeft(peerId);
      this.voice.onPeerLeft(peerId);
      // The server announces the departure; if it is gone, drop the peer ourselves.
      if (!this.serverUp && this.roster.has(peerId)) this.removePeer(peerId, "timeout");
    } else if (peerId === this.hostPeerId) {
      // Never connected yet (ICE failed): not a host loss. The ready timer retries over the relay or gives up.
      if (!this.isReady && this.cancelReadyTimer) return;
      this.handleHostLost("link closed");
    }
  }

  // ---- data channel dispatch -------------------------------------------------------------------------------------

  private onData(from: number, channel: ChannelName, bytes: Uint8Array, reassembled = false): void {
    let d;
    try {
      d = decodeMessage(bytes, reassembled);
    } catch (e) {
      this.reportError(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    if (!d) return;
    if (!reassembled) this.lastHeard.set(from, this.cfg.clock.now());
    const { msg, route } = d;
    switch (msg.type) {
      case "hi":
        if (this.isHost) this.onHi(from, msg.lastTick);
        break;
      case "welcome_dc":
        if (!this.isHost) {
          if (msg.hostId !== this.hostPeerId) this.setHost(msg.hostId);
          this.lockstep.touch();
        }
        break;
      case "cmd": case "frame": case "hash": case "desync":
      case "snapshot_req": case "snapshot":
        if (from === this.hostPeerId || this.isHost) this.lockstep.handle(from, msg);
        break;
      case "chunk": {
        if (reassembled) break; // a chunk set never nests another
        let r = this.reassemblers.get(from);
        if (!r) this.reassemblers.set(from, (r = new Reassembler()));
        let whole;
        try {
          whole = r.push(msg);
        } catch (e) {
          this.reportError(e instanceof Error ? e : new Error(String(e)));
          break;
        }
        if (!whole) break;
        if (this.lockstep.snapshotPending && from === this.hostPeerId) this.lockstep.onSnapshotPayload(whole);
        else this.onData(from, channel, whole, true); // an oversized inner frame
        break;
      }
      case "chat": case "chat_history": case "chat_reject":
        this.chat.handle(from, route, msg);
        break;
      case "pause_request": case "pause_state": case "pause_refuse":
        this.pause.handle(from, msg);
        break;
      case "voice":
        if (channel === "voice") this.voice.handle(from, route, msg); // a voice frame on another channel is ignored
        break;
      case "raw":
        this.onRaw(from, route, msg.bytes, channel);
        break;
      case "ping":
        this.sendTo(from, { type: "pong", n: msg.n, t: msg.t }, 0, "fast");
        break;
      case "pong":
        this.rtt = Math.max(0, (this.cfg.clock.now() >>> 0) - msg.t);
        break;
      case "host_claim":
        this.onHostClaim(from, msg.epoch, msg.hostId);
        break;
    }
  }

  private onHi(from: number, lastTick: number): void {
    this.connected.add(from);
    this.notReady.get(from)?.();
    this.notReady.delete(from);
    this.sendTo(from, {
      type: "welcome_dc",
      // the tick the snapshot will carry (the game's applied tick), so welcome_dc.tick == snapshot.tick even when
      // the game loop has not yet consumed every emitted frame; 0 before the game starts
      tick: this.mode === "lockstep" ? this.lockstep.currentTick : 0,
      tickRate: this.tickRate,
      mode: this.mode === "lockstep" ? MODE_LOCKSTEP : MODE_RAW,
      hostId: this.localPeerId,
    }, 0);
    this.chat.sendHistory(from);
    this.pause.sendState(from);
    if (this.mode === "lockstep") this.lockstep.onPeerHi(from, lastTick);
    this.emit("peerReady", this.roster.get(from) ?? { peerId: from, name: "" });
    this.flush(from);
  }

  private flush(peerId: number): void {
    const q = this.outbox.get(peerId);
    if (!q) return;
    this.outbox.delete(peerId);
    for (const m of q) this.sendTo(peerId, m.msg, m.route, m.channel);
  }

  private onRaw(from: number, route: number, bytes: Uint8Array, channel: ChannelName): void {
    if (!this.isHost) {
      this.emit("message", route, bytes, channel);
      return;
    }
    if (!this.allowRaw(from)) return;
    if (route === 0 || route === this.localPeerId) {
      this.emit("message", from, bytes, channel);
    }
    if (route === 0) {
      for (const p of this.connectedPeerIds()) if (p !== from) this.sendTo(p, { type: "raw", bytes }, from, channel);
    } else if (route !== this.localPeerId) {
      this.sendTo(route, { type: "raw", bytes }, from, channel);
    }
  }

  private allowRaw(from: number): boolean {
    const lim = this.cfg.rateLimit;
    if (!lim || !(lim.messages > 0) || !(lim.perMs > 0)) return true;
    const now = this.cfg.clock.now();
    let w = this.rate.get(from);
    if (!w || now - w.start >= lim.perMs) this.rate.set(from, (w = { start: now, n: 0 }));
    return ++w.n <= lim.messages;
  }

  // ---- migration -------------------------------------------------------------------------------------------------

  private setHost(hostId: number): void {
    if (hostId === this.hostPeerId) return;
    this.hostPeerId = hostId;
    this.emit("hostChanged", hostId);
  }

  /** The host is gone (link closed, no frames for 3 s, or the server said so): run the s.9 rule. */
  private handleHostLost(reason: string): void {
    if (this.isHost || this.ended) return;
    if (this.cfg.direct) {
      this.teardown("host_left");
      return;
    }
    const failed = this.hostPeerId;
    const gone = this.roster.get(failed);
    if (gone) {
      this.roster.delete(failed);
      this.emit("peerLeft", gone, reason === "link closed" ? "timeout" : reason);
    }
    const old = this.links.get(failed);
    if (old) {
      old.onClose = null;
      old.onMessage = null;
      old.close();
      this.links.delete(failed);
      this.hiSentTo.delete(old);
    }
    const candidate = pickNewHost([...this.roster.keys(), this.localPeerId], failed) ?? this.localPeerId;
    if (candidate === this.localPeerId) this.becomeHost();
    // else: wait for the candidate's host_claim (or the server's host_changed); it offers to us and we answer with hi
  }

  private becomeHost(): void {
    this.epoch = (this.epoch + 1) & 0xffff;
    this.hostPeerId = this.localPeerId;
    this.markReady();
    this.connected.clear();
    this.hiSentTo.clear();
    this.lastHeard.clear(); // joiners spoke to the old host; their clocks start when they say hi to us
    this.lockstep.becomeHost();
    this.pause.onBecameHost();
    this.emit("hostChanged", this.localPeerId);
    if (this.serverUp) this.signaling.send({ t: "host_changed", hostId: this.localPeerId, epoch: this.epoch });
    for (const p of this.roster.keys()) {
      if (p !== this.localPeerId) this.offerTo(p);
    }
  }

  private onHostClaim(from: number, epoch: number, hostId: number): void {
    const mine = { epoch: this.epoch, hostId: this.hostPeerId };
    const theirs = { epoch, hostId };
    if (hostId === this.hostPeerId && epoch === this.epoch && !this.isHost) {
      const l = this.links.get(from);
      if (l) this.sendHi(l);
      return;
    }
    if (!claimWinsWrapped(theirs, mine)) return; // we hold the better claim
    const wasHost = this.isHost;
    this.epoch = epoch;
    if (wasHost) {
      // We lose: demote. Everyone else will be offered to by the winner.
      for (const [id, l] of this.links) {
        if (id === from) continue;
        l.onClose = null;
        l.onMessage = null;
        l.close();
        this.links.delete(id);
      }
      this.connected.clear();
      this.lockstep.becomeJoiner();
    }
    this.setHost(hostId);
    const link = this.links.get(from);
    if (link && from === hostId) this.sendHi(link);
  }

  // ---- signaling -------------------------------------------------------------------------------------------------

  private onSignaling(m: ServerMsg): void {
    switch (m.t) {
      case "peer_joined": {
        if (!m.peer || this.roster.has((m.peer as Peer).peerId)) return;
        const peer = seatName(m.peer as Peer);
        this.roster.set(peer.peerId, peer);
        this.emit("peerJoined", peer);
        if (this.isHost) {
          this.watchReady(peer.peerId);
          this.offerTo(peer.peerId);
        }
        break;
      }
      case "peer_left":
        this.removePeer(Number(m.peerId), String(m.reason ?? "left"));
        break;
      case "host_changed": {
        if (this.cfg.direct) {
          // the hub promotes a joiner as the host leaves; in direct mode the hub is going with it
          if (!this.isHost) this.teardown("host_left");
          break;
        }
        const id = Number(m.hostId);
        if (typeof m.epoch === "number" && m.epoch > this.epoch) this.epoch = m.epoch & 0xffff;
        if (id === this.hostPeerId) break;
        if (id === this.localPeerId && !this.isHost) {
          const failed = this.hostPeerId;
          this.roster.delete(failed);
          this.becomeHost();
        } else {
          this.setHost(id);
        }
        break;
      }
      case "join_request":
        this.emit("joinRequested", seatName(m.peer as Peer));
        break;
      case "lobby": {
        const st = m as unknown as LobbyState;
        this.meta = { ...st.meta };
        if (st.name) this.name = st.name;
        if (st.resumeToken && st.resumeToken !== this.resumeToken) {
          this.resumeToken = st.resumeToken;
          this.seatSink?.(this.resumeToken);
        }
        this.roster = new Map(st.peers.map((p) => [p.peerId, seatName(p)]));
        if (st.hostId !== this.hostPeerId && !this.isHost) this.setHost(st.hostId);
        this.setPhase(st.phase);
        break;
      }
      case "meta":
        this.meta = { ...(m.meta as Record<string, string>) };
        this.emit("metaChanged", this.meta);
        break;
      case "phase":
        this.setPhase(m.phase as Phase);
        break;
      case "signal":
        void this.onSignal(Number(m.from), m as unknown as SignalPayload);
        break;
      case "error":
        if (m.code === "kicked") {
          const d = (m.data ?? {}) as { ban?: unknown; closeCode?: unknown; closeReason?: unknown };
          const close: CloseInfo = {};
          if (typeof d.closeCode === "number") close.code = d.closeCode;
          if (typeof d.closeReason === "string") close.reason = d.closeReason;
          this.teardown(d.ban === false ? "disconnected" : "kicked", close.code !== undefined || close.reason !== undefined ? close : undefined);
        }
        else this.reportError(new OneLobbyError(String(m.code), String(m.msg ?? ""), m.data as Record<string, unknown> | undefined));
        break;
    }
  }

  private async onSignal(from: number, s: SignalPayload): Promise<void> {
    let link = this.links.get(from);
    const payload: SignalPayload = {};
    if (s.sdp) payload.sdp = s.sdp;
    if (s.ice) payload.ice = s.ice;
    if (s.sdp?.type === "offer") {
      // We are the answerer; an offer always comes from the (new) host.
      link = this.makeLink(from);
      const early = this.earlyIce.get(from) ?? [];
      this.earlyIce.delete(from);
      // the link holds candidates until the offer is set, so hand them over right behind it
      const done = link.handleSignal(payload);
      for (const e of early) void link.handleSignal(e);
      await done;
      return;
    }
    if (!link) {
      if (!payload.ice || this.ended || !this.roster.has(from)) return;
      const q = this.earlyIce.get(from) ?? [];
      if (q.length < 64) q.push(payload);
      this.earlyIce.set(from, q);
      return;
    }
    await link.handleSignal(payload);
  }

  /**
   * `linger` (host kick / disconnect): stop using the peer's link at once but leave it open until that peer closes it
   * or KICK_LINGER_MS pass. The hub tells the peer over its WebSocket; closing the data link first would make it look
   * like the host vanished (a migration and a 1001 instead of the host's close code).
   */
  private removePeer(peerId: number, reason: string, close?: CloseInfo, linger = false): void {
    const peer = this.roster.get(peerId);
    if (peerId === this.localPeerId) {
      this.teardown(reason === "kicked" ? "kicked" : reason);
      return;
    }
    if (peer) this.roster.delete(peerId);
    this.earlyIce.delete(peerId);
    const cancelWatch = this.notReady.get(peerId);
    if (cancelWatch) {
      cancelWatch();
      this.notReady.delete(peerId);
      if (peer && reason !== "kicked" && reason !== "disconnected") this.emit("peerFailed", peer, reason);
    }
    const link = this.links.get(peerId);
    if (link && peerId !== this.hostPeerId) {
      link.onMessage = null;
      this.links.delete(peerId);
      this.hiSentTo.delete(link);
      if (linger) {
        this.lingering.add(link);
        const done = () => {
          if (!this.lingering.delete(link)) return;
          cancel();
          link.onClose = null;
          link.close();
        };
        const cancel = this.cfg.clock.setTimeout(done, KICK_LINGER_MS);
        link.onClose = done;
      } else {
        link.onClose = null;
        link.close();
      }
    }
    this.connected.delete(peerId);
    this.outbox.delete(peerId);
    this.lastHeard.delete(peerId);
    this.rate.delete(peerId);
    this.lockstep.onPeerLeft(peerId);
    this.chat.onPeerLeft(peerId);
    this.voice.onPeerLeft(peerId);
    this.pause.onPeerLeft(peerId);
    if (peer) this.emit("peerLeft", peer, reason, close);
    if (peerId === this.hostPeerId && !this.isHost) {
      this.handleHostLost(reason);
    }
  }

  /** Lockstep drops (stalled, desynced): removed without a ban, so the player can come back (a rejoin resyncs). */
  private dropPeer(peerId: number, reason: string): void {
    this.signaling.send({ t: "kick", peerId, ban: false, closeReason: reason } as { t: "kick"; peerId: number });
    this.removePeer(peerId, reason, undefined, true);
  }

  private setPhase(p: Phase): void {
    if (p !== "lobby" && p !== "in_game") return;
    if (this.phase === p) return;
    this.phase = p;
    if (p === "lobby") this.pause.onLobbyPhase();
    if (p === "in_game" && !this.lockstep.started) this.lockstep.markStarted();
    this.emit("phase", p);
  }

  private onServerClosed(): void {
    if (this.ended) return;
    if (this.cfg.direct && !this.isHost) {
      this.teardown("host_left");
      return;
    }
    this.serverUp = false;
    this.emit("serverLost");
    // Alone with no peers: nothing keeps this session alive.
    if (this.links.size === 0 && this.roster.size <= 1) this.teardown("server_lost");
  }

  // ---- housekeeping ----------------------------------------------------------------------------------------------

  private watchdog(): void {
    if (this.ended) return;
    const timeout = this.cfg.peerTimeoutMs ?? 0;
    if (timeout > 0) this.dropSilent(Math.max(timeout, MIN_PEER_TIMEOUT_MS));
    if (this.ended || this.isHost) return;
    if (this.mode === "lockstep" && this.lockstep.hostSilent()) {
      this.lockstep.touch();
      this.lockstep.pokeHost(); // a live-but-stalled host answers with a snapshot; a dead one is replaced below
      this.handleHostLost("timeout");
    }
  }

  /** peerTimeoutMs: the host drops joiners it has not heard from; a joiner handles a silent host as lost. */
  private dropSilent(timeout: number): void {
    const now = this.cfg.clock.now();
    if (this.isHost) {
      for (const id of [...this.connected]) {
        const last = this.lastHeard.get(id);
        if (last !== undefined && now - last > timeout) this.removePeer(id, "timeout");
      }
    } else if (this.isReady) {
      const last = this.lastHeard.get(this.hostPeerId);
      if (last !== undefined && now - last > timeout) {
        this.lastHeard.delete(this.hostPeerId);
        this.handleHostLost("timeout");
      }
    }
  }

  private pingHost(): void {
    if (this.ended || this.isHost) return;
    this.sendTo(this.hostPeerId, { type: "ping", n: ++this.pingN, t: this.cfg.clock.now() >>> 0 }, 0, "fast");
  }

  /** Host: report a joiner that is not ready `readyTimeoutMs` after joining as peerFailed("timeout"), once. */
  private watchReady(peerId: number): void {
    const ms = this.cfg.readyTimeoutMs ?? 0;
    let cancel = () => {};
    if (ms > 0) {
      cancel = this.cfg.clock.setTimeout(() => {
        if (!this.notReady.delete(peerId)) return;
        const peer = this.roster.get(peerId);
        if (peer) this.emit("peerFailed", peer, "timeout");
      }, ms);
    }
    this.notReady.set(peerId, cancel);
  }

  private teardown(reason: string, close?: CloseInfo): void {
    if (this.ended) return;
    this.ended = true;
    this.cancelReadyTimer?.();
    for (const cancel of this.notReady.values()) cancel();
    this.notReady.clear();
    if (!this.isReady) {
      const code = reason === "ice_failed" || reason === "kicked" ? reason : "closed";
      this.failReady(new OneLobbyError(code, `the lobby ended before connecting (${reason})`));
    }
    this.cancelWatchdog?.();
    this.cancelPing?.();
    this.lockstep.stop();
    this.voice.close();
    for (const l of [...this.links.values(), ...this.lingering]) {
      l.onClose = null;
      l.onMessage = null;
      l.close();
    }
    this.links.clear();
    this.earlyIce.clear();
    this.lingering.clear();
    this.signaling.onClose = null;
    this.signaling.onMessage = null;
    this.signaling.close();
    this.emit("sessionEnded", reason, close);
  }

  /** Total in-flight links (diagnostics and tests). */
  get linkCount(): number {
    return this.links.size;
  }
}

export { PROTO };
