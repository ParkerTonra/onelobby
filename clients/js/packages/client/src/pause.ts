import { PAUSE_FLAG_PAUSER_LEFT, PAUSE_REFUSE, type Message } from "./codec.js";
import { Emitter } from "./emitter.js";
import type { Hub } from "./hub.js";
import { OneLobbyError } from "./signaling.js";

/** The least time between two accepted pause requests from one peer. */
export const PAUSE_MIN_REQUEST_GAP_MS = 500;

/**
 * The shared pause: `paused` is on while someone holds the match; `byPeer` is the peer that paused (while paused) or
 * that last resumed it; `pauserLeft` says the pauser left and the host now holds the pause (`byPeer` is then the host).
 */
export interface PauseState {
  readonly paused: boolean;
  readonly byPeer: number;
  readonly pauserLeft: boolean;
}

/** Why a request was refused: `not_in_game`, `rate_limited` or `not_allowed` (the `ErrorCodes` constants). */
export type PauseRefusal = "not_in_game" | "rate_limited" | "not_allowed" | "unknown";

export type PauseEvents = {
  /** The state changed (paused, resumed, pauser left, cleared). Fires on every peer. */
  changed: [PauseState];
  /** A request of this peer was refused; `code` is a `PauseRefusal`. */
  refused: [code: PauseRefusal];
};

/** `session.pause` of a blueprint: "off" makes `request` throw `pause_disabled`, "host" makes the default policy host-only. */
export type PauseMode = "off" | "host" | "anyone";

export interface PauseDeps {
  /** The lobby's phase now ("lobby" | "in_game"). */
  phase: () => string;
  /** Lockstep: stop (true) or resume (false) the host's frame emission. */
  hold: (held: boolean) => void;
  /** Whether `peerId` is still in the roster. */
  hasPeer: (peerId: number) => boolean;
}

const NONE: PauseState = Object.freeze({ paused: false, byPeer: 0, pauserLeft: false });

function refusalName(code: number): PauseRefusal {
  return code === PAUSE_REFUSE.notInGame ? "not_in_game" : code === PAUSE_REFUSE.rateLimited ? "rate_limited" : code === PAUSE_REFUSE.notAllowed ? "not_allowed" : "unknown";
}

/**
 * Shared co-op pause (docs/recipes/pause.md): any player asks the host to pause or resume the match for everyone.
 * The host validates (phase, rate, policy), keeps the state and broadcasts it over the reliable channel. OneLobby moves
 * the state and, in lockstep, stops the host's frames; scaling time, menus and banners stay in the game. It is outside
 * the sim: never put it in a lockstep command or hash.
 */
export class Pause extends Emitter<PauseEvents> {
  /** Set by a blueprint (`session.pause`); the default is "anyone". */
  mode: PauseMode = "anyone";
  /**
   * Host: replaces the default policy. Called with (requesting peer, true to pause / false to resume); return true to
   * allow. Default: anyone pauses, the pauser or the host resumes (host only in "host" mode). Phase and rate run first.
   */
  policy: ((peerId: number, paused: boolean) => boolean) | null = null;

  private current: PauseState = NONE;
  private lastAccepted = new Map<number, number>();

  constructor(private hub: Hub, private deps: PauseDeps) {
    super();
  }

  /** The current shared state (the same on every peer once the host's broadcast has arrived). */
  get state(): PauseState {
    return this.current;
  }

  /**
   * True when the local peer may resume now under the default policy: the pauser or the host (in "host" mode, the
   * host). A custom `policy` lives on the host, so on a joiner this is a hint.
   */
  get canResume(): boolean {
    return this.current.paused && this.defaultAllows(this.hub.localPeerId, false);
  }

  /**
   * Ask to pause (true) or resume (false) the match for everyone. Throws `pause_disabled` when the blueprint says
   * `session.pause` is "off". The result arrives as `changed` or `refused`; asking for the state that already holds
   * does nothing.
   */
  request(paused: boolean): void {
    if (this.mode === "off") throw new OneLobbyError("pause_disabled", "this game has pause turned off (session.pause is \"off\")");
    if (this.hub.isHost) this.hostHandle(this.hub.localPeerId, paused);
    else this.hub.sendToHost({ type: "pause_request", paused: paused ? 1 : 0 });
  }

  /**
   * Host only: unpause at once, skipping the policy and the rate limit. Call it before a restart or game over so the
   * next round does not start frozen. Does nothing when not paused.
   */
  clear(): void {
    if (!this.hub.isHost) throw new Error("only the host can clear the pause");
    if (!this.current.paused) return;
    this.set({ paused: false, byPeer: this.hub.localPeerId, pauserLeft: false }, true);
  }

  // ---- internals (called by Lobby) ------------------------------------------------------------------------------

  handle(from: number, msg: Message): void {
    switch (msg.type) {
      case "pause_request":
        if (this.hub.isHost && this.hub.connectedPeers().includes(from)) this.hostHandle(from, msg.paused !== 0);
        break;
      case "pause_state":
        if (!this.hub.isHost && from === this.hub.hostPeerId) {
          this.set({ paused: msg.paused !== 0, byPeer: msg.byPeer, pauserLeft: (msg.flags & PAUSE_FLAG_PAUSER_LEFT) !== 0 }, false);
        }
        break;
      case "pause_refuse":
        if (!this.hub.isHost && from === this.hub.hostPeerId) this.emit("refused", refusalName(msg.reason));
        break;
    }
  }

  /** Host: a late joiner's link is up; it gets the state when there is one to tell. */
  sendState(peerId: number): void {
    if (this.current.paused) this.hub.sendTo(peerId, this.stateMessage(), 0);
  }

  /** A peer is gone: the host takes over the pause its leaver held. */
  onPeerLeft(peerId: number): void {
    this.lastAccepted.delete(peerId);
    const s = this.current;
    if (this.hub.isHost && s.paused && !s.pauserLeft && s.byPeer === peerId) {
      this.set({ paused: true, byPeer: this.hub.localPeerId, pauserLeft: true }, true);
    }
  }

  /** This peer just became the host (migration): it keeps the state as is, and takes over a pause whose holder is gone. */
  onBecameHost(): void {
    this.deps.hold(this.current.paused);
    const s = this.current;
    if (s.paused && !s.pauserLeft && !this.deps.hasPeer(s.byPeer)) {
      this.set({ paused: true, byPeer: this.hub.localPeerId, pauserLeft: true }, true);
    }
  }

  /** The lobby went back to the lobby phase: nothing stays paused. */
  onLobbyPhase(): void {
    if (!this.current.paused) return;
    this.set({ paused: false, byPeer: this.hub.hostPeerId, pauserLeft: false }, this.hub.isHost);
  }

  // ---- host path --------------------------------------------------------------------------------------------------

  private defaultAllows(peer: number, wantPaused: boolean): boolean {
    if (this.mode === "host") return peer === this.hub.hostPeerId;
    return wantPaused || peer === this.current.byPeer || peer === this.hub.hostPeerId;
  }

  private hostHandle(from: number, want: boolean): void {
    if (this.mode === "off") return this.refuse(from, want, PAUSE_REFUSE.notAllowed);
    if (this.deps.phase() !== "in_game") return this.refuse(from, want, PAUSE_REFUSE.notInGame);
    if (want === this.current.paused) return;
    const now = this.hub.clock.now();
    const last = this.lastAccepted.get(from);
    if (last !== undefined && now - last < PAUSE_MIN_REQUEST_GAP_MS) return this.refuse(from, want, PAUSE_REFUSE.rateLimited);
    const ok = this.policy ? this.policy(from, want) : this.defaultAllows(from, want);
    if (!ok) return this.refuse(from, want, PAUSE_REFUSE.notAllowed);
    this.lastAccepted.set(from, now);
    this.set({ paused: want, byPeer: from, pauserLeft: false }, true);
  }

  private refuse(to: number, want: boolean, reason: number): void {
    if (to === this.hub.localPeerId) this.emit("refused", refusalName(reason));
    else this.hub.sendTo(to, { type: "pause_refuse", paused: want ? 1 : 0, reason }, 0);
  }

  private stateMessage(): Message {
    const s = this.current;
    return { type: "pause_state", paused: s.paused ? 1 : 0, byPeer: s.byPeer, flags: s.pauserLeft ? PAUSE_FLAG_PAUSER_LEFT : 0 };
  }

  private set(next: PauseState, broadcast: boolean): void {
    const prev = this.current;
    this.current = Object.freeze(next);
    this.deps.hold(next.paused);
    if (broadcast) {
      const msg = this.stateMessage();
      for (const p of this.hub.connectedPeers()) this.hub.sendTo(p, msg, 0);
    }
    if (prev.paused !== next.paused || prev.byPeer !== next.byPeer || prev.pauserLeft !== next.pauserLeft) this.emit("changed", next);
  }
}
