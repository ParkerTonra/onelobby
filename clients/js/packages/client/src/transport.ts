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
  /** The offerer calls this to start negotiation. The answerer just feeds handleSignal. */
  startOffer(): void;
  handleSignal(s: SignalPayload): void | Promise<void>;
  send(channel: ChannelName, bytes: Uint8Array): void;
  close(): void;
}

export interface LinkOptions {
  remoteId: number;
  iceServers: IceServer[];
  relayOnly: boolean;
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
