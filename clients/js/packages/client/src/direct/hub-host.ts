/// <reference types="node" />
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { createServer, type Server, type Socket } from "node:net";
import type { SocketLike } from "../transport.js";
import { SignalingHub, directHubOptions, type HubDeps, type HubOptions, type Session } from "./hub.js";
import { LocalHubSocket } from "./hub-local.js";
import { PortMapper,type PortMapperOptions, type PortMapResult } from "./portmap.js";
import type { NostrHostBridge } from "../nostr/host.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HEADER_BYTES = 8192;
const HANDSHAKE_TIMEOUT_MS = 5000;
/** A joiner socket with more than this much unsent data is closed (1008 "backpressure"); spec/signaling.md. */
export const MAX_PENDING_WRITE_BYTES = 1024 * 1024;
const BACKPRESSURE_GRACE_MS = 3000;
const STATUS_TEXT: Record<number, string> = { 200: "OK", 301: "Moved Permanently", 302: "Found", 404: "Not Found", 500: "Internal Server Error" };

/**
 * Whether a WebSocket handshake carrying `origin` is accepted. A web page can open a WebSocket to any address it can
 * reach, so a browser's Origin must be one we expect: in `allowed` ("*" = all), the same host:port as the request's
 * Host header (the page this host serves itself), or loopback (localhost, 127.0.0.1, [::1], any port). A request with
 * no Origin header is a native client and never gets here.
 */
export function originAllowed(origin: string, host: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.includes("*") || allowed.includes(origin)) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") return true;
  return host !== undefined && u.host.toLowerCase() === host.trim().toLowerCase();
}

/** Whether `ip` (as the socket reports it) is 127.0.0.0/8, ::1 or an IPv4-mapped loopback address. */
export function isLoopback(ip: string): boolean {
  const a = ip.replace(/^::ffff:/i, "");
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a) || a === "::1";
}

/**
 * Rejects (EADDRINUSE) when another program holds IPv4 TCP or UDP `port`. Windows lets the dual-stack listener bind
 * over a program on 0.0.0.0 (every IPv4 joiner would then reach that program), and the peer links need UDP `port`
 * too, so both are tried and released before the real listen.
 */
async function probeIPv4(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen({ port, host: "0.0.0.0", exclusive: true }, () => s.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    const u = createSocket({ type: "udp4" });
    u.once("error", (e) => {
      u.close();
      reject(e);
    });
    u.bind({ port, address: "0.0.0.0", exclusive: true }, () => u.close(() => resolve()));
  });
}

export class PortInUseError extends Error {
  readonly code = "port_in_use";
  /** Windows reserved the port (EACCES: an excluded port range, often from Hyper-V, WSL or Docker); not another program. */
  readonly reserved: boolean;
  constructor(port: number, detail: string) {
    const reserved = detail === "EACCES";
    super(`port_in_use: cannot listen on port ${port} (${detail}): ${portFailureHint(!reserved, reserved)}`);
    this.reserved = reserved;
  }
}

/** The end of a `port_in_use` message: busy (another program) and reserved (Windows) need different fixes. */
export function portFailureHint(anyBusy: boolean, anyReserved: boolean): string {
  if (!anyReserved) return "is another copy of the game hosting?";
  if (!anyBusy) return "Windows has reserved it (an excluded port range, often from Hyper-V, WSL or Docker); pick another port";
  return "each one is busy or reserved by Windows (an excluded port range); is another copy of the game hosting?";
}

/**
 * Runs a {@link SignalingHub} inside a Node process and listens for joiners' signaling WebSockets on TCP `port`: the
 * Node twin of C#'s `DirectHubHost` (docs/direct-ip.md s.2, s.5 step 3). A plain `net` server with a minimal HTTP/1.1
 * upgrade and RFC 6455 framing (text, close, ping/pong, fragments; client frames must be masked), so the package keeps
 * zero runtime dependencies. Any path upgrades; `GET /healthz` answers `ok` and `GET /metrics` the hub's Prometheus text
 * (loopback callers only), as onelobby-server does, ahead of the `http` callback. The host's own client talks to the hub in
 * memory through {@link connectLocal}. `hub.tick()` runs once a second on an unref'd timer.
 */
/** One plain-HTTP answer from the host's port, e.g. a browser join page. */
export interface HttpReply {
  /** Default 200. */
  status?: number;
  /** Content-Type, e.g. "text/html; charset=utf-8". */
  type: string;
  body: string | Uint8Array;
  /**
   * Extra response headers, e.g. `{ "Cache-Control": "max-age=3600" }` for a static asset (default `no-store`). The
   * hub owns Content-Type, Content-Length and Connection; a name or value with a line break answers 500.
   */
  headers?: Record<string, string>;
}

/** `GET /joininfo` on a direct host: what a page served from the host shows as its share link (`directJoinInfo()`). */
export interface DirectJoinInfo {
  /** What to hand out: the Nostr code (version 1) by default, else the IP code. */
  joinCode: string;
  joinCodeKind: "nostr" | "internet" | "same_network" | "none";
  /** The IP code (address and port); equals `joinCode` when Nostr is off. */
  directCode: string;
  directCodeKind: "internet" | "same_network" | "none";
  /** With `http`: `http://<the code's address>:<port>/`; else null. */
  joinUrl: string | null;
  port: number;
}

const HUB_OWNED_HEADERS = new Set(["content-type", "content-length", "connection", "transfer-encoding"]);

function replyHeaders(extra: Record<string, string> | undefined): string {
  const h = new Map<string, [string, string]>([
    ["cache-control", ["Cache-Control", "no-store"]],
    ["x-content-type-options", ["X-Content-Type-Options", "nosniff"]],
  ]);
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (/[\r\n:]/.test(k) || /[\r\n]/.test(String(v)) || !k) throw new Error("bad header");
    if (!HUB_OWNED_HEADERS.has(k.toLowerCase())) h.set(k.toLowerCase(), [k, String(v)]);
  }
  return [...h.values()].map(([k, v]) => `${k}: ${v}\r\n`).join("");
}

/** Serves plain `GET` requests on the direct port (path without the query); null answers 404. */
export type HttpHandler = (path: string) => HttpReply | null;

export class DirectHubHost {
  readonly hub: SignalingHub;
  /**
   * Plain `GET`s that are not WebSocket upgrades go here, so the host can serve its own join page: a browser opening
   * `http://<host address>:<port>/` gets a page that joins with `kit.joinDirect(location.host)`. Null (default): 426.
   */
  http: HttpHandler | null = null;
  /**
   * Browser `Origin` values allowed to open a signaling socket, exact match, "*" for all. No Origin header (native
   * clients), the host's own page (Origin equal to the request's Host) and localhost pages are always allowed.
   */
  allowedOrigins: string[] = [];
  /** Served as JSON at `GET /joininfo` (404 while null); `hostDirect` keeps it current as the join code changes. */
  joinInfo: DirectJoinInfo | null = null;
  /** The bound TCP port (the requested one, or the one the OS picked for 0). */
  readonly port: number;
  portMapper: PortMapper | null = null;
  /** Nostr signaling for joiners that cannot reach the port (spec/nostr-signaling.md); set by `hostDirect`. */
  nostr: NostrHostBridge | null = null;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly ticker: ReturnType<typeof setInterval>;
  private readonly maxMessageBytes: number;
  private closed = false;

  private constructor(server: Server, port: number, hub: SignalingHub, maxMessageBytes: number) {
    this.server = server;
    this.port = port;
    this.hub = hub;
    this.maxMessageBytes = maxMessageBytes;
    this.ticker = setInterval(() => this.hub.tick(), 1000);
    this.ticker.unref?.();
    server.on("connection", (sock) => this.accept(sock));
  }

  /**
   * Binds TCP `port` on every interface (IPv6 dual-stack where available). Hub options default to
   * {@link directHubOptions} (one lobby, no codes, no ICE servers). Rejects with {@link PortInUseError}.
   */
  static async listen(port: number, options?: Partial<HubOptions>, deps?: HubDeps & { host?: string }): Promise<DirectHubHost> {
    const opts = { ...directHubOptions(8), ...options };
    const server = createServer({ noDelay: true });
    const tryListen = (host: string, ipv6Only?: boolean) =>
      new Promise<void>((resolve, reject) => {
        const onError = (e: NodeJS.ErrnoException) => reject(e);
        server.once("error", onError);
        server.listen({ port, host, ipv6Only }, () => {
          server.off("error", onError);
          resolve();
        });
      });
    try {
      if (deps?.host) await tryListen(deps.host);
      else {
        if (port !== 0) await probeIPv4(port);
        try {
          await tryListen("::", false);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") throw e;
          await tryListen("0.0.0.0"); // no IPv6 on this machine
        }
      }
    } catch (e) {
      throw new PortInUseError(port, (e as NodeJS.ErrnoException).code ?? String(e));
    }
    const addr = server.address();
    const bound = typeof addr === "object" && addr ? addr.port : port;
    return new DirectHubHost(server, bound, new SignalingHub(opts, deps), opts.maxMessageBytes);
  }

  /** Joiner sockets currently open. */
  get connectionCount(): number {
    return this.sockets.size;
  }

  /**
   * The host's own signaling socket: a WebSocket look-alike wired straight into the hub (no network). Pass it to the
   * kit as `advanced.socketFactory: () => host.connectLocal()`.
   */
  connectLocal(): SocketLike {
    return new LocalHubSocket(this.hub);
  }

  /** Asks the home router to forward TCP and UDP `port` here (UPnP, then NAT-PMP; docs/direct-ip.md s.2a). */
  openPort(options?: PortMapperOptions): Promise<PortMapResult> {
    if (this.portMapper) throw new Error("the port is already being opened");
    this.portMapper = new PortMapper(this.port, options);
    return this.portMapper.open();
  }

  /** Stops listening, closes every joiner socket and removes the router mapping. Every call gets the same promise. */
  close(): Promise<void> {
    return (this.closing ??= this.closeOnce());
  }

  private closing?: Promise<void>;

  private async closeOnce(): Promise<void> {
    this.closed = true;
    clearInterval(this.ticker);
    this.nostr?.close();
    const unmap = this.portMapper?.close();
    for (const s of this.sockets) s.end(closeFrame(1001, "host left"));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    setTimeout(() => { for (const s of this.sockets) s.destroy(); }, 300).unref?.();
    await unmap;
  }

  // ---------------------------------------------------------------- one TCP connection

  private accept(sock: Socket): void {
    if (this.closed) {
      sock.destroy();
      return;
    }
    this.sockets.add(sock);
    sock.on("close", () => this.sockets.delete(sock));
    sock.on("error", () => {});
    const ip = (sock.remoteAddress ?? "").replace(/^::ffff:/, "");
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => sock.destroy(), HANDSHAKE_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MAX_HEADER_BYTES) sock.destroy();
        return;
      }
      clearTimeout(timer);
      sock.off("data", onData);
      const rest = head.subarray(end + 4);
      if (!this.handshake(sock, ip, head.subarray(0, end).toString("latin1"))) return;
      this.run(sock, ip, rest);
    };
    sock.on("data", onData);
  }

  /** RFC 6455 s.4.2: answers 101 with Sec-WebSocket-Accept, or 200 for /healthz and /metrics (loopback only), or 400/426. */
  private handshake(sock: Socket, ip: string, head: string): boolean {
    const [requestLine, ...lines] = head.split("\r\n");
    const headers = new Map<string, string>();
    for (const l of lines) {
      const i = l.indexOf(":");
      if (i > 0) headers.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim());
    }
    const [method, path] = requestLine.split(" ");
    const reply = (status: string, body: string, type = "text/plain") =>
      sock.end(`HTTP/1.1 ${status}\r\nContent-Type: ${type}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    // The same two endpoints as onelobby-server; /metrics stays local because this port faces the internet.
    if (method === "GET" && path === "/healthz") {
      reply("200 OK", "ok\n");
      return false;
    }
    if (method === "GET" && path === "/metrics") {
      if (isLoopback(ip)) reply("200 OK", this.hub.metrics.render(), "text/plain; version=0.0.4");
      else reply("403 Forbidden", "metrics are local only (OneLobby direct host)");
      return false;
    }
    const key = headers.get("sec-websocket-key");
    const upgrade = /websocket/i.test(headers.get("upgrade") ?? "");
    // The share link for a page the host serves: a player who opened it at a LAN address still shares the public one.
    if (method === "GET" && !upgrade && path?.split("?")[0] === "/joininfo") {
      if (this.joinInfo) reply("200 OK", JSON.stringify(this.joinInfo), "application/json");
      else reply("404 Not Found", "no join code yet");
      return false;
    }
    if (method === "GET" && !upgrade && this.http && path) {
      let page: HttpReply | null = null;
      let extra = "";
      try {
        page = this.http(path.split("?")[0]);
        extra = replyHeaders(page?.headers);
      } catch {
        page = { status: 500, type: "text/plain", body: "error" };
        extra = replyHeaders(undefined);
      }
      const p = page ?? { status: 404, type: "text/plain", body: "not found" };
      const body = typeof p.body === "string" ? Buffer.from(p.body, "utf8") : Buffer.from(p.body);
      const status = p.status ?? 200;
      sock.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "OK"}\r\nContent-Type: ${p.type}\r\n` +
        `Content-Length: ${body.length}\r\n${extra}Connection: close\r\n\r\n`);
      sock.end(body);
      return false;
    }
    if (method !== "GET" || !upgrade || !key) {
      reply("426 Upgrade Required", "this port speaks WebSocket (OneLobby direct host)");
      return false;
    }
    const origin = headers.get("origin");
    if (origin !== undefined && !originAllowed(origin, headers.get("host"), this.allowedOrigins)) {
      reply("403 Forbidden", "this origin may not join (OneLobby direct host)");
      return false;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    return true;
  }

  private run(sock: Socket, ip: string, initial: Buffer): void {
    let open = true;
    let session: Session | null = null;
    const shut = (code: number, reason: string) => {
      if (!open) return;
      open = false;
      if (sock.destroyed) return;
      // a reader that stopped reading never drains its buffer: give the close frame a moment, then cut it off
      if (code === 1008 && reason === "backpressure") {
        sock.write(closeFrame(code, reason));
        setTimeout(() => sock.destroy(), BACKPRESSURE_GRACE_MS).unref?.();
        if (session) this.hub.disconnect(session);
      } else sock.end(closeFrame(code, reason));
    };
    const sendText = (text: string) => {
      if (!open || sock.destroyed) return;
      sock.write(frame(0x1, Buffer.from(text, "utf8")));
      // a slow or malicious reader must not grow this process's memory without bound
      if (sock.writableLength > MAX_PENDING_WRITE_BYTES) shut(1008, "backpressure");
    };
    session = this.hub.connect(ip, sendText, (code, reason) => shut(code ?? 1000, reason ?? "closed by the hub"));
    if (!session) return;
    const s = session;
    const reader = new FrameReader(this.maxMessageBytes + 1024, {
      text: (t) => this.hub.receive(s, t),
      ping: (p) => !sock.destroyed && sock.write(frame(0xa, p)),
      close: () => {
        shut(1000, "");
        this.hub.disconnect(s);
      },
      fail: (code, why) => {
        shut(code, why);
        this.hub.disconnect(s);
      },
    });
    sock.on("data", (b: Buffer) => reader.push(b));
    sock.on("close", () => {
      open = false;
      this.hub.disconnect(s);
    });
    if (initial.length) reader.push(initial);
  }
}

// ------------------------------------------------------------------------------------------------ RFC 6455 framing

/** One unmasked server frame (FIN set). */
function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (n >= 126) {
    head[0] = 0x80 | opcode;
    if (n < 65536) {
      head[1] = 126;
      head.writeUInt16BE(n, 2);
    } else {
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
  }
  return Buffer.concat([head, payload]);
}

function closeFrame(code: number, reason: string): Buffer {
  const r = Buffer.from(reason.slice(0, 100), "utf8");
  const p = Buffer.alloc(2 + r.length);
  p.writeUInt16BE(code, 0);
  r.copy(p, 2);
  return frame(0x8, p);
}

interface FrameSink {
  text(t: string): void;
  ping(payload: Buffer): void;
  close(): void;
  fail(code: number, why: string): void;
}

/** Incremental client-frame parser: masked frames only, text messages (fragmented or not), control frames between. */
class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private partBytes = 0;
  private inMessage = false;
  private binary = false;
  private done = false;
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly maxMessage: number, private readonly sink: FrameSink) {}

  push(chunk: Buffer): void {
    if (this.done) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.done) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if (b0 & 0x70) return this.fail(1002, "reserved bits set");
      if (!(b1 & 0x80)) return this.fail(1002, "client frames must be masked");
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessage)) return this.fail(1009, "message too big");
        len = Number(big);
        off = 10;
      }
      if (len > this.maxMessage) return this.fail(1009, "message too big");
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (opcode >= 0x8) {
        if (!fin || len > 125) return this.fail(1002, "bad control frame");
        if (opcode === 0x8) {
          this.done = true;
          this.sink.close();
          return;
        }
        if (opcode === 0x9) this.sink.ping(payload);
        continue; // pong or unknown control: ignore
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (this.inMessage) return this.fail(1002, "new message inside a fragmented one");
        this.inMessage = true;
        this.binary = opcode === 0x2; // spec/signaling.md: binary frames are ignored
      } else if (opcode !== 0x0 || !this.inMessage) return this.fail(1002, "unexpected continuation");
      this.partBytes += payload.length;
      if (this.partBytes > this.maxMessage) return this.fail(1009, "message too big");
      if (!this.binary) this.parts.push(payload);
      if (fin) {
        const all = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
        const skip = this.binary;
        this.parts = [];
        this.partBytes = 0;
        this.inMessage = false;
        this.binary = false;
        if (skip) continue;
        let text: string;
        try {
          text = this.utf8.decode(all);
        } catch {
          return this.fail(1007, "invalid UTF-8");
        }
        this.sink.text(text);
      }
    }
  }

  private fail(code: number, why: string): void {
    this.done = true;
    this.sink.fail(code, why);
  }
}

export { LocalHubSocket };
