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
import type { LobbyState, PeerInfo, SignalingClient, ServerMsg } from "./signaling.js";
import type { ChannelName, IceServer, LinkFactory, PeerLink, SignalPayload } from "./transport.js";
import { Voice, type VoiceDeps } from "./voice.js";

export type Phase = "lobby" | "in_game";
export type Peer = PeerInfo;

export type LobbyEvents = {
  peerJoined: [Peer];
  /** The peer's data channels are open and the handshake is done: reliable sends reach it now (earlier ones were queued and flushed). */
  peerReady: [Peer];
  /** Joiner: the link to the host is open (the host itself is ready from the start). Also available as `lobby.ready`. */
  ready: [];
  peerLeft: [Peer, reason: string];
  joinRequested: [Peer];
  hostChanged: [hostId: number];
  phase: [Phase];
  message: [from: number, bytes: Uint8Array, channel: ChannelName];
  sessionEnded: [reason: string];
  /** The signaling server went away. The game continues on the data channels (s.9). */
  serverLost: [];
  metaChanged: [Record<string, string>];
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
  readonly voice: Voice;

  localPeerId: number;
  hostPeerId: number;
  phase: Phase;
  meta: Record<string, string>;
  resumeToken: string;
  /** Last measured round trip to the host in ms (joiners), or 0. */
  rtt = 0;

  private signaling: SignalingClient;
  private cfg: LobbyConfig;
  private roster = new Map<number, Peer>();
  private links = new Map<number, PeerLink>();
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
  /** Resolves when this peer can exchange data: immediately for the host, once the link to the host is open for a joiner. */
  readonly ready: Promise<void> = new Promise<void>((res) => (this.markReady = res));

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
    this.resumeToken = st.resumeToken;
    for (const p of st.peers) this.roster.set(p.peerId, p);

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
    this.lockstep.on("started", () => this.setPhase("in_game"));
    this.lockstep.on("error", (e) => this.reportError(e));

    this.signaling.onMessage = (m) => this.onSignaling(m);
    this.signaling.onClose = () => this.onServerClosed();

    if (this.isHost) this.markReady();
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

  /** @internal Called by Keepalive right after construction: the host waits for joiners, a joiner waits for the host's offer. */
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

  async kick(peerId: number): Promise<void> {
    if (!this.isHost) throw new Error("only the host can kick");
    this.signaling.send({ t: "kick", peerId });
    this.removePeer(peerId, "kicked");
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
  /** @internal set by Keepalive so lobby errors reach `kit.on("error")`. */
  errorSink: ((e: Error) => void) | null = null;

  // ---- links -----------------------------------------------------------------------------------------------------

  private makeLink(peerId: number): PeerLink {
    const old = this.links.get(peerId);
    if (old) {
      old.onClose = null;
      old.onMessage = null;
      old.close();
    }
    const link = this.cfg.links.create({ remoteId: peerId, iceServers: this.cfg.ice, relayOnly: this.cfg.relayOnly });
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
      this.handleHostLost("link closed");
    }
  }

  // ---- data channel dispatch -------------------------------------------------------------------------------------

  private onData(from: number, channel: ChannelName, bytes: Uint8Array): void {
    let d;
    try {
      d = decodeMessage(bytes);
    } catch (e) {
      this.reportError(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    if (!d) return;
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
        let r = this.reassemblers.get(from);
        if (!r) this.reassemblers.set(from, (r = new Reassembler()));
        const whole = r.push(msg);
        if (!whole) break;
        if (this.lockstep.snapshotPending && from === this.hostPeerId) this.lockstep.onSnapshotPayload(whole);
        else this.onData(from, channel, whole); // an oversized inner frame
        break;
      }
      case "chat": case "chat_history": case "chat_reject":
        this.chat.handle(from, route, msg);
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
    if (route === 0 || route === this.localPeerId) {
      this.emit("message", from, bytes, channel);
    }
    if (route === 0) {
      for (const p of this.connectedPeerIds()) if (p !== from) this.sendTo(p, { type: "raw", bytes }, from, channel);
    } else if (route !== this.localPeerId) {
      this.sendTo(route, { type: "raw", bytes }, from, channel);
    }
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
    this.connected.clear();
    this.hiSentTo.clear();
    this.lockstep.becomeHost();
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
        const peer = m.peer as Peer;
        if (!peer || this.roster.has(peer.peerId)) return;
        this.roster.set(peer.peerId, peer);
        this.emit("peerJoined", peer);
        if (this.isHost) this.offerTo(peer.peerId);
        break;
      }
      case "peer_left":
        this.removePeer(Number(m.peerId), String(m.reason ?? "left"));
        break;
      case "host_changed": {
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
        this.emit("joinRequested", m.peer as Peer);
        break;
      case "lobby": {
        const st = m as unknown as LobbyState;
        this.meta = { ...st.meta };
        this.resumeToken = st.resumeToken ?? this.resumeToken;
        this.roster = new Map(st.peers.map((p) => [p.peerId, p]));
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
        if (m.code === "kicked") this.teardown("kicked");
        else this.reportError(new Error(`${String(m.code)}: ${String(m.msg ?? "")}`));
        break;
    }
  }

  private async onSignal(from: number, s: SignalPayload): Promise<void> {
    let link = this.links.get(from);
    if (s.sdp?.type === "offer") {
      // We are the answerer; an offer always comes from the (new) host.
      link = this.makeLink(from);
    }
    if (!link) return;
    const payload: SignalPayload = {};
    if (s.sdp) payload.sdp = s.sdp;
    if (s.ice) payload.ice = s.ice;
    await link.handleSignal(payload);
  }

  private removePeer(peerId: number, reason: string): void {
    const peer = this.roster.get(peerId);
    if (peerId === this.localPeerId) {
      this.teardown(reason === "kicked" ? "kicked" : reason);
      return;
    }
    if (peer) this.roster.delete(peerId);
    const link = this.links.get(peerId);
    if (link && peerId !== this.hostPeerId) {
      link.onClose = null;
      link.onMessage = null;
      link.close();
      this.links.delete(peerId);
      this.hiSentTo.delete(link);
    }
    this.connected.delete(peerId);
    this.outbox.delete(peerId);
    this.lockstep.onPeerLeft(peerId);
    this.chat.onPeerLeft(peerId);
    this.voice.onPeerLeft(peerId);
    if (peer) this.emit("peerLeft", peer, reason);
    if (peerId === this.hostPeerId && !this.isHost) {
      this.handleHostLost(reason);
    }
  }

  private dropPeer(peerId: number, reason: string): void {
    this.signaling.send({ t: "kick", peerId });
    this.removePeer(peerId, reason);
  }

  private setPhase(p: Phase): void {
    if (p !== "lobby" && p !== "in_game") return;
    if (this.phase === p) return;
    this.phase = p;
    if (p === "in_game" && !this.lockstep.started) this.lockstep.markStarted();
    this.emit("phase", p);
  }

  private onServerClosed(): void {
    if (this.ended) return;
    this.serverUp = false;
    this.emit("serverLost");
    // Alone with no peers: nothing keeps this session alive.
    if (this.links.size === 0 && this.roster.size <= 1) this.teardown("server_lost");
  }

  // ---- housekeeping ----------------------------------------------------------------------------------------------

  private watchdog(): void {
    if (this.ended || this.isHost) return;
    if (this.mode === "lockstep" && this.lockstep.hostSilent()) {
      this.lockstep.touch();
      this.lockstep.pokeHost(); // a live-but-stalled host answers with a snapshot; a dead one is replaced below
      this.handleHostLost("timeout");
    }
  }

  private pingHost(): void {
    if (this.ended || this.isHost) return;
    this.sendTo(this.hostPeerId, { type: "ping", n: ++this.pingN, t: this.cfg.clock.now() >>> 0 }, 0, "fast");
  }

  private teardown(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.cancelWatchdog?.();
    this.cancelPing?.();
    this.lockstep.stop();
    this.voice.close();
    for (const l of this.links.values()) {
      l.onClose = null;
      l.onMessage = null;
      l.close();
    }
    this.links.clear();
    this.signaling.onClose = null;
    this.signaling.onMessage = null;
    this.signaling.close();
    this.emit("sessionEnded", reason);
  }

  /** Total in-flight links (diagnostics and tests). */
  get linkCount(): number {
    return this.links.size;
  }
}

export { PROTO };
