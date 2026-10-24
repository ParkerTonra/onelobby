import type { Clock } from "./clock.js";
import type { IceServer, SocketFactory, SocketLike } from "./transport.js";

/** Signaling wire types (DESIGN s.7). Unknown fields are kept; unknown types are ignored by the Lobby. */
export interface PeerInfo {
  peerId: number;
  name: string;
  joinedAt?: number;
}

export interface LobbyState {
  t: "lobby";
  code: string;
  gameId: string;
  netVersion: string;
  hostId: number;
  you: number;
  mode: "lockstep" | "raw";
  tickRate: number;
  lateJoin: boolean;
  phase: "lobby" | "in_game";
  meta: Record<string, string>;
  peers: PeerInfo[];
  resumeToken: string;
  name?: string;
  maxPlayers?: number;
  visibility?: string;
  relayOnly?: boolean;
}

export interface LobbySummary {
  code: string;
  gameId: string;
  netVersion: string;
  name: string;
  hostName: string;
  players: number;
  maxPlayers: number;
  phase: string;
  meta: Record<string, string>;
  region?: string;
  createdAt?: number;
}

export interface WelcomeMsg {
  t: "welcome";
  peerId?: number;
  ice: IceServer[];
  serverTime?: number;
  limits?: { maxMsg: number; maxPlayers: number };
}

export interface ServerError {
  t: "error";
  code: string;
  msg?: string;
  data?: Record<string, unknown>;
}

export type ServerMsg = { t: string; [k: string]: unknown };

export class KeepaliveError extends Error {
  constructor(public code: string, message?: string, public data?: Record<string, unknown>) {
    super(message ? `${code}: ${message}` : code);
    this.name = "KeepaliveError";
  }
}

export const PROTO_ID = "lk1";
const PING_EVERY_MS = 10_000;
const SILENCE_MS = 30_000;

interface Waiter {
  types: string[];
  resolve: (m: ServerMsg) => void;
  reject: (e: Error) => void;
}

/** Thin JSON signaling client: one socket, request/response helpers, keep-alive pings. */
export class SignalingClient {
  private socket: SocketLike | null = null;
  private waiters: Waiter[] = [];
  private lastRx = 0;
  private cancelPing: (() => void) | null = null;
  private pingN = 0;
  closed = false;

  onMessage: ((m: ServerMsg) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(private url: string, private factory: SocketFactory, private clock: Clock) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let s: SocketLike;
      try {
        s = this.factory(this.url);
      } catch (e) {
        reject(new KeepaliveError("connect_failed", String(e)));
        return;
      }
      this.socket = s;
      s.onopen = () => {
        this.lastRx = this.clock.now();
        this.cancelPing = this.clock.setInterval(() => this.tick(), PING_EVERY_MS);
        resolve();
      };
      s.onerror = () => {
        if (!this.lastRx) reject(new KeepaliveError("connect_failed", `cannot reach ${this.url}`));
      };
      s.onmessage = (ev) => {
        this.lastRx = this.clock.now();
        let m: ServerMsg;
        try {
          m = JSON.parse(String(ev.data)) as ServerMsg;
        } catch {
          return;
        }
        if (!m || typeof m.t !== "string") return;
        if (m.t === "ping") {
          this.send({ t: "pong", n: m.n });
          return;
        }
        if (m.t === "pong") return;
        const i = this.waiters.findIndex((w) => w.types.includes(m.t) || m.t === "error");
        if (i >= 0) {
          const [w] = this.waiters.splice(i, 1);
          if (m.t === "error") w.reject(errorFrom(m));
          else w.resolve(m);
          return;
        }
        this.onMessage?.(m);
      };
      s.onclose = () => {
        if (!this.lastRx) reject(new KeepaliveError("connect_failed", `cannot reach ${this.url}`));
        this.shutdown();
      };
    });
  }

  private tick() {
    if (this.clock.now() - this.lastRx > SILENCE_MS) {
      this.socket?.close(4000, "silence");
      this.shutdown();
      return;
    }
    this.send({ t: "ping", n: ++this.pingN });
  }

  private shutdown() {
    if (this.closed) return;
    this.closed = true;
    this.cancelPing?.();
    const err = new KeepaliveError("closed", "signaling connection closed");
    for (const w of this.waiters.splice(0)) w.reject(err);
    this.onClose?.();
  }

  get isOpen(): boolean {
    return !this.closed && this.socket !== null && this.socket.readyState === 1;
  }

  send(m: Record<string, unknown>): void {
    if (!this.isOpen) return;
    this.socket!.send(JSON.stringify(m));
  }

  /** Wait for the next message of one of `types`, or reject on `error`/close. */
  expect<T extends { t: string } = ServerMsg>(...types: string[]): Promise<T> {
    if (this.closed) return Promise.reject(new KeepaliveError("closed", "signaling connection closed"));
    return new Promise<T>((resolve, reject) => {
      this.waiters.push({ types, resolve: resolve as (m: ServerMsg) => void, reject });
    });
  }

  async request<T extends { t: string } = ServerMsg>(m: Record<string, unknown>, ...types: string[]): Promise<T> {
    const p = this.expect<T>(...types);
    this.send(m);
    return p;
  }

  close(): void {
    this.socket?.close(1000, "bye");
    this.shutdown();
  }
}

function errorFrom(m: ServerMsg): KeepaliveError {
  return new KeepaliveError(String(m.code ?? "error"), m.msg === undefined ? undefined : String(m.msg), m.data as Record<string, unknown> | undefined);
}
