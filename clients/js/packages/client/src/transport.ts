/**
 * Transport seams. The protocol logic never touches RTCPeerConnection or WebSocket directly, so the whole
 * lobby/lockstep/chat/voice stack runs under vitest against `MemoryNetwork` / `MemoryServer` (see testing.ts).
 */

export type ChannelName = "reliable" | "fast" | "voice";

export const CHANNEL_IDS: Record<ChannelName, number> = { reliable: 0, fast: 1, voice: 2 };

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
  ttl?: number;
}

/** Whether an ICE server entry has a `turn:` or `turns:` URL. */
export function hasTurn(s: IceServer): boolean {
  return (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(String(u)));
}

export interface SdpInit {
  type: "offer" | "answer";
  sdp: string;
}
export interface IceInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export interface SignalPayload {
  sdp?: SdpInit;
  ice?: IceInit;
}

/** What a link knows for a diagnosis (spec/diagnostics.md s.2). */
export interface LinkFacts {
  /** A candidate pair was selected (ICE connected), whether or not the channels opened. */
  iceConnected?: boolean;
  /** The TURN allocation: `failed` = gathering ended with no relay candidate and the reason is not known. Absent: no TURN entry. */
  relay?: "pending" | "ok" | "refused" | "unreachable" | "failed";
}

/** One peer connection with the three negotiated channels (s.8). */
export interface PeerLink {
  readonly remoteId: number;
  readonly isOpen: boolean;
  /** Fired for each local SDP/ICE blob that must reach the remote through signaling. */
  onSignal: ((s: SignalPayload) => void) | null;
  /** Fired once, when all three channels are open. */
  onOpen: (() => void) | null;
  /** Fired once when the link dies (after open or while connecting). */
  onClose: ((reason: string) => void) | null;
  onMessage: ((channel: ChannelName, bytes: Uint8Array) => void) | null;
  /** Fired once after ICE completes: whether the selected candidate pair uses a TURN relay (reported to the server). */
  onPath?: ((path: "direct" | "relayed") => void) | null;
  /** Fired when the selected candidate pair's remote address is known and is neither relayed nor an mDNS name. */
  onRemoteAddress?: ((ip: string) => void) | null;
  /** The offerer calls this to start negotiation. The answerer just feeds handleSignal. */
  startOffer(): void;
  handleSignal(s: SignalPayload): void | Promise<void>;
  send(channel: ChannelName, bytes: Uint8Array): void;
  close(): void;
  /** Optional one-line state for a "could not connect" report (connection states, signals seen); never parsed. */
  diagnostics?(): string;
  /** Optional: connection steps for the net log (ICE and channel state changes). Text carries no address or credential. */
  onTrace?: ((kind: "ice" | "chan" | "route", text: string) => void) | null;
  /** Optional: what this link knows for a diagnosis (`diagnose`); links without it read as unknown. */
  facts?(): LinkFacts;
}

export interface LinkOptions {
  remoteId: number;
  iceServers: IceServer[];
  relayOnly: boolean;
  /**
   * Direct-IP host (docs/design/direct-ip.md s.2): bind ICE to these local UDP ports. One port (begin = end) also turns on
   * ICE UDP mux so every peer shares it. Honoured by libdatachannel-based RTCPeerConnection (node-datachannel);
   * browsers ignore it.
   */
  portRange?: { begin: number; end: number };
  /**
   * Bind the ICE sockets to this one local address (libdatachannel `bindAddress`; "127.0.0.1" when the peer is this PC).
   * Honoured by node-datachannel; browsers ignore it. Left out = every interface.
   */
  bindAddress?: string;
  /**
   * Direct-IP joiner: remote ICE candidate lines (`candidate:1 1 UDP ... typ host`) added after the remote
   * description, for the address the player typed or pasted as a code.
   */
  extraRemoteCandidates?: string[];
}

export interface LinkFactory {
  create(opts: LinkOptions): PeerLink;
}

/** Subset of the WebSocket API the signaling client needs. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type SocketFactory = (url: string) => SocketLike;

export const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;
