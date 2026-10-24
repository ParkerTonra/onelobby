import { CHAT_REJECT, chatRejectName, type ChatLine, type ChatRejectReason, type Message } from "./codec.js";
import { Emitter } from "./emitter.js";
import type { Hub } from "./hub.js";

export const CHAT_MAX_BYTES = 256;
export const CHAT_BURST = 3;
export const CHAT_WINDOW_MS = 5000;
export const CHAT_PER_WINDOW = 5;
export const CHAT_HISTORY_LINES = 100;

/** Control characters (C0, DEL, C1) and bidi overrides/isolates/marks are removed at the host. */
// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeChat(text: string): string {
  return text.replace(STRIP, "");
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Token bucket per peer: `CHAT_PER_WINDOW` messages per `CHAT_WINDOW_MS`, burst `CHAT_BURST`
 * (capacity 3, refilled one token per second).
 */
export class ChatLimiter {
  private buckets = new Map<number, { tokens: number; at: number }>();
  private refillMs = CHAT_WINDOW_MS / CHAT_PER_WINDOW;

  tryTake(peerId: number, now: number): boolean {
    let b = this.buckets.get(peerId);
    if (!b) this.buckets.set(peerId, (b = { tokens: CHAT_BURST, at: now }));
    b.tokens = Math.min(CHAT_BURST, b.tokens + (now - b.at) / this.refillMs);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  forget(peerId: number): void {
    this.buckets.delete(peerId);
  }
}

export interface ChatMessage {
  peerId: number;
  id: number;
  ts: number;
  text: string;
}

export type ChatEvents = {
  message: [ChatMessage];
  rejected: [id: number, reason: ChatRejectReason];
  /** The host's `chat_history` arrived (joiners, right after the handshake). */
  history: [readonly ChatMessage[]];
};

/** Text chat (DESIGN s.9b): sender -> host (validates, stamps) -> everyone, over the reliable channel. */
export class Chat extends Emitter<ChatEvents> {
  /** Game-provided profanity hook; applied to every line a player is shown. */
  filter: (text: string) => string = (t) => t;

  private lines: ChatMessage[] = [];
  private limiter = new ChatLimiter();
  private hostMuted = new Set<number>();
  private localId = 0;
  private stampId = 0;

  constructor(
    private hub: Hub,
    private wall: () => number,
    private isLocallyMuted: (peerId: number) => boolean,
  ) {
    super();
  }

  get history(): readonly ChatMessage[] {
    return this.lines;
  }

  /** Returns the local message id (what `rejected` will refer to). */
  send(text: string): number {
    const id = ++this.localId >>> 0;
    if (utf8Length(text) > CHAT_MAX_BYTES * 4) {
      // Do not even ship absurd payloads; the host would reject on length anyway.
      queueMicrotask(() => this.emit("rejected", id, "length"));
      return id;
    }
    if (this.hub.isHost) this.hostProcess(this.hub.localPeerId, id, text);
    else this.hub.sendToHost({ type: "chat", id, ts: 0, text });
    return id;
  }

  /** Host only: drop a peer's chat for everyone (`chat_reject` reason 3). */
  hostMute(peerId: number, muted: boolean): void {
    if (!this.hub.isHost) throw new Error("only the host can mute chat");
    if (muted) this.hostMuted.add(peerId);
    else this.hostMuted.delete(peerId);
  }

  isHostMuted(peerId: number): boolean {
    return this.hostMuted.has(peerId);
  }

  onPeerLeft(peerId: number): void {
    this.limiter.forget(peerId);
    this.hostMuted.delete(peerId);
  }

  /** Host: send recent lines to a freshly connected peer. */
  sendHistory(peerId: number): void {
    const lines: ChatLine[] = this.lines.slice(-CHAT_HISTORY_LINES).map((l) => ({ ...l }));
    this.hub.sendTo(peerId, { type: "chat_history", lines }, 0);
  }

  handle(from: number, route: number, msg: Message): void {
    switch (msg.type) {
      case "chat":
        if (this.hub.isHost) this.hostProcess(from, msg.id, msg.text);
        else this.deliver({ peerId: route, id: msg.id, ts: msg.ts, text: msg.text });
        break;
      case "chat_history":
        if (!this.hub.isHost) {
          this.lines = [];
          for (const l of msg.lines.slice(-CHAT_HISTORY_LINES)) this.push({ ...l, text: this.safeFilter(l.text) });
          this.emit("history", this.lines);
        }
        break;
      case "chat_reject":
        this.emit("rejected", msg.id, chatRejectName(msg.reason));
        break;
    }
  }

  // ---- host path ----------------------------------------------------------------------------------------------

  private hostProcess(from: number, id: number, rawText: string): void {
    const reject = (code: number) => {
      if (from === this.hub.localPeerId) this.emit("rejected", id, chatRejectName(code));
      else this.hub.sendTo(from, { type: "chat_reject", id, reason: code }, 0);
    };
    if (this.hostMuted.has(from)) return reject(CHAT_REJECT.mutedByHost);
    // spec order: muted, length (before stripping), rate (a reject spends no token), strip, drop if empty
    if (utf8Length(rawText) > CHAT_MAX_BYTES) return reject(CHAT_REJECT.length);
    if (!this.limiter.tryTake(from, this.hub.clock.now())) return reject(CHAT_REJECT.rate);
    const text = sanitizeChat(rawText);
    if (text.length === 0) return;
    const line: ChatMessage = { peerId: from, id: ++this.stampId >>> 0, ts: this.wall(), text };
    const out: Message = { type: "chat", id: line.id, ts: line.ts, text: line.text };
    for (const p of this.hub.connectedPeers()) this.hub.sendTo(p, out, from);
    this.deliver(line);
  }

  private deliver(line: ChatMessage): void {
    const shown: ChatMessage = { ...line, text: this.safeFilter(line.text) };
    this.push(shown);
    if (this.isLocallyMuted(line.peerId)) return; // local mute drops the peer's chat, history included
    this.emit("message", shown);
  }

  private push(line: ChatMessage): void {
    if (this.isLocallyMuted(line.peerId)) return;
    this.lines.push(line);
    if (this.lines.length > CHAT_HISTORY_LINES) this.lines.splice(0, this.lines.length - CHAT_HISTORY_LINES);
  }

  private safeFilter(text: string): string {
    try {
      return this.filter(text);
    } catch {
      return text;
    }
  }
}
