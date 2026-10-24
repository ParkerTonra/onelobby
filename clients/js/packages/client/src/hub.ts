import type { Clock } from "./clock.js";
import type { Message } from "./codec.js";
import type { ChannelName } from "./transport.js";

/**
 * What lockstep/chat/voice need from the Lobby. Keeping this narrow lets them be unit-tested with a fake hub.
 * Star topology: a joiner's only link is to the host; the host has one link per joiner.
 */
export interface Hub {
  readonly clock: Clock;
  readonly localPeerId: number;
  readonly hostPeerId: number;
  readonly isHost: boolean;
  readonly tickRate: number;
  /** Remote peers with an open link (host: every joiner; joiner: just the host, if linked). */
  connectedPeers(): number[];
  /** Send to one directly linked peer. */
  sendTo(peerId: number, msg: Message, route?: number, channel?: ChannelName): void;
  /** Joiner -> host. No-op when this peer is the host. */
  sendToHost(msg: Message, route?: number, channel?: ChannelName): void;
  /** Host drops a misbehaving peer (kick with a reason shown to the game). */
  dropPeer(peerId: number, reason: string): void;
  reportError(err: Error): void;
  /** Next chunk-set id for this sender (shared by snapshots and oversized frames). */
  nextChunkId(): number;
}
