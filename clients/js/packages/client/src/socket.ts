import type { CloseInfo, Lobby, Peer } from "./lobby.js";

/**
 * A WebSocket-shaped view of one peer link, so code written against `WebSocket` runs on a lobby unchanged:
 * `lobby.asWebSocket()` on a joiner (the link to the host), `lobby.onConnection(conn => ...)` on the host (one per
 * joiner). Not a real WebSocket: no URL, no subprotocols, no `addEventListener`; `bufferedAmount` is always 0.
 */
export interface LobbySocket {
  /** The peer at the other end (the host for a joiner's socket, the joiner for a host's connection). */
  readonly peerId: number;
  /** 0 CONNECTING (joiner, before `lobby.ready`), 1 OPEN, 3 CLOSED (there is no CLOSING). */
  readonly readyState: 0 | 1 | 3;
  readonly bufferedAmount: 0;
  /** A string is sent as UTF-8; bytes as they are. Ignored unless OPEN. */
  send(data: string | Uint8Array): void;
  /**
   * Closes this socket locally and fires `onclose` with `code` (default 1000). On a joiner it also leaves the lobby.
   * On the host it only stops this connection's events: to end the player's connection too (its socket gets your code
   * and reason), call `lobby.disconnect(conn.peerId, code, reason)`; `lobby.kick()` also bans it from the lobby.
   */
  close(code?: number, reason?: string): void;
  /**
   * Fires once, on a later task than the one that created the socket (like a real WebSocket). Assigned after it already
   * fired (the socket came out of an `await` chain)? It runs for the new handler once; `readyState === 1` also tells.
   */
  onopen: ((ev: { type: "open" }) => void) | null;
  /** `data` is a string (UTF-8 decoded), or the bytes with `{ binary: true }`. */
  onmessage: ((ev: { type: "message"; data: string | Uint8Array }) => void) | null;
  /** `reason` is the lobby's reason ("host_left", "timeout", "kicked", "disconnected", ...) unless `close()` or the host gave one. */
  onclose: ((ev: { type: "close"; code: number; reason: string; wasClean: boolean }) => void) | null;
  /** Never called (errors surface as `onclose` with code 1006); present so WebSocket code that assigns it works. */
  onerror: ((ev: { type: "error" }) => void) | null;
}

export interface LobbySocketOptions {
  /** Deliver `onmessage` data as bytes (Uint8Array) instead of UTF-8 text. Default false. */
  binary?: boolean;
  /** Channel for `send` (default "reliable"). "fast" is unordered and may drop, like UDP. */
  channel?: "reliable" | "fast";
}

/**
 * Close codes: 1000 a normal leave, `close()` or the host's `disconnect()`, 1001 the other end went away (`host_left`,
 * the host closing, a player who left), 4000 kicked, 1006 anything abnormal (`timeout`, `ice_failed`, `server_lost`,
 * ...). A code and reason the host passed to `kick()` / `disconnect()` win over these.
 */
export function closeCodeFor(reason: string): number {
  if (reason === "left" || reason === "disconnected") return 1000;
  if (reason === "host_left" || reason === "closed") return 1001;
  if (reason === "kicked") return 4000;
  return 1006;
}

/** A later task, like a real WebSocket's events: setImmediate in Node, setTimeout(0) in browsers. */
const nextTask: (f: () => void) => void =
  (globalThis as { setImmediate?: (f: () => void) => void }).setImmediate ?? ((f) => void setTimeout(f, 0));

const enc = new TextEncoder();
const dec = new TextDecoder();

class PeerSocket implements LobbySocket {
  readyState: 0 | 1 | 3 = 0;
  readonly bufferedAmount = 0 as const;
  private openHandler: LobbySocket["onopen"] = null;
  /** OPEN, but `onopen` has not run yet for any handler. */
  private openPending = false;
  onmessage: LobbySocket["onmessage"] = null;
  onclose: LobbySocket["onclose"] = null;
  onerror: LobbySocket["onerror"] = null;
  /** Unsubscribes from the lobby; set by the factory. */
  detach: () => void = () => {};

  constructor(
    readonly peerId: number,
    private readonly out: (bytes: Uint8Array) => void,
    private readonly binary: boolean,
    private readonly onLocalClose: () => void,
  ) {}

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) return;
    this.out(typeof data === "string" ? enc.encode(data) : data);
  }

  close(code = 1000, reason = "left"): void {
    if (this.readyState === 3) return;
    this.closed(code, reason);
    this.onLocalClose();
  }

  get onopen(): LobbySocket["onopen"] {
    return this.openHandler;
  }

  set onopen(h: LobbySocket["onopen"]) {
    this.openHandler = h;
    // assigned after the open event went by with no handler: deliver it once, still on a later task
    if (h && this.openPending) nextTask(() => this.fireOpen());
  }

  /**
   * @internal OPEN now; `onopen` now, or on a later task (like a real WebSocket) so a handler assigned
   * after any number of awaits in the same task still runs.
   */
  open(later = false): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.openPending = true;
    if (!later) this.fireOpen();
    else nextTask(() => this.fireOpen());
  }

  private fireOpen(): void {
    if (this.readyState !== 1 || !this.openPending || !this.openHandler) return;
    this.openPending = false;
    this.openHandler({ type: "open" });
  }

  /** @internal */
  deliver(bytes: Uint8Array): void {
    if (this.readyState === 1) this.onmessage?.({ type: "message", data: this.binary ? bytes : dec.decode(bytes) });
  }

  /** @internal */
  closed(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.detach();
    this.onclose?.({ type: "close", code, reason, wasClean: code === 1000 || code === 1001 });
  }
}

/**
 * Joiner: the link to the host as a socket. OPEN once `lobby.ready` resolves (at once if it already has), with
 * `onopen` on a later task;
 * closed when the session ends, or with 1001 "host_changed" when a server-backed lobby migrates to a new host.
 */
export function joinerSocket(lobby: Lobby, o: LobbySocketOptions = {}): LobbySocket {
  if (lobby.isHost) throw new Error("asWebSocket() is for joiners; the host uses lobby.onConnection()");
  const channel = o.channel ?? "reliable";
  const s = new PeerSocket(lobby.hostPeerId, (b) => lobby.send(lobby.hostPeerId, b, { channel }), !!o.binary, () => void lobby.leave());
  const offs = [
    lobby.on("message", (from, bytes) => {
      if (from === lobby.hostPeerId) s.deliver(bytes);
    }),
    lobby.on("sessionEnded", (reason, close?: CloseInfo) => s.closed(close?.code ?? closeCodeFor(reason), close?.reason ?? reason)),
    // The socket's far end is the host it opened to; after a migration that server is gone (direct lobbies end instead).
    lobby.on("hostChanged", () => s.closed(1001, "host_changed")),
  ];
  s.detach = () => offs.forEach((f) => f());
  // Already connected (made after `await lobby.ready`): OPEN at once, so a send() right away goes out.
  if (lobby.connectedPeers.includes(lobby.hostPeerId)) s.open(true);
  else lobby.ready.then(() => s.open(true), () => {});
  return s;
}

/**
 * Host: calls `handler(conn)` once per joiner, as soon as its link is ready (and right away for joiners already
 * connected). A message from a joiner the handler has not seen yet creates its connection first, so nothing is lost.
 * `conn.onclose` fires when that peer leaves (code from closeCodeFor) or the host's session ends. Returns a function
 * that stops new connections (existing ones keep working).
 */
export function hostConnections(lobby: Lobby, handler: (conn: LobbySocket) => void, o: LobbySocketOptions = {}): () => void {
  if (!lobby.isHost) throw new Error("onConnection() is for the host; a joiner uses lobby.asWebSocket()");
  const channel = o.channel ?? "reliable";
  const conns = new Map<number, PeerSocket>();
  let stopped = false;
  const ensure = (peerId: number): PeerSocket | undefined => {
    if (peerId === lobby.localPeerId) return undefined;
    let c = conns.get(peerId);
    if (c || stopped) return c;
    c = new PeerSocket(peerId, (b) => lobby.send(peerId, b, { channel }), !!o.binary, () => {});
    const conn = c;
    conn.detach = () => {
      if (conns.get(peerId) === conn) conns.delete(peerId);
    };
    conns.set(peerId, conn);
    conn.open();
    handler(conn);
    return conn;
  };
  const offs = [
    lobby.on("peerReady", (p: Peer) => void ensure(p.peerId)),
    lobby.on("message", (from, bytes) => ensure(from)?.deliver(bytes)),
    lobby.on("peerLeft", (p: Peer, reason, close?: CloseInfo) =>
      conns.get(p.peerId)?.closed(close?.code ?? (reason === "left" ? 1001 : closeCodeFor(reason)), close?.reason ?? reason),
    ),
    lobby.on("sessionEnded", (reason) => {
      for (const c of [...conns.values()]) c.closed(reason === "left" ? 1001 : closeCodeFor(reason), reason);
      offs.forEach((f) => f());
    }),
  ];
  for (const id of lobby.connectedPeers) ensure(id);
  return () => {
    stopped = true;
  };
}
