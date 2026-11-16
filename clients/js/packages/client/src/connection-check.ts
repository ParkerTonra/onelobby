/**
 * The connection check (spec/diagnostics.md s.8): UDP, NAT type and relay login, measured with the STUN servers the client
 * already uses and the player's TURN entry, and nothing else. Where the runtime can open a UDP socket (Node) it speaks STUN
 * and TURN itself from one socket; where it cannot (browsers) it reads the candidates of one RTCPeerConnection.
 */
import { checkVerdict, classifyNat, type CheckFindings, type CheckVerdict, type MappedAddress } from "./diagnose.js";
import { hasTurn, type IceServer } from "./transport.js";

/** What `checkConnection` resolves to. */
export interface CheckResult extends CheckFindings {
  verdict: CheckVerdict;
  /** One plain line for a menu: "Direct connections: likely to fail. A relay is recommended." */
  message: string;
}

export interface CheckOptions {
  /** STUN URLs to ask; default `stun:stun.l.google.com:19302` and `stun:stun.cloudflare.com:3478` (what the client connects with). */
  stun?: string[];
  /** The player's TURN entry (or entries); the first `turn:` one is tested. Default none. */
  iceServers?: IceServer[];
  /** Give up on the whole check after this long (default 8000). */
  timeoutMs?: number;
  /** How long each STUN or TURN server gets to answer, with one retransmit at a third of it (default 1500). */
  serverTimeoutMs?: number;
  /** Bind the probe socket here (default all interfaces; tests pass 127.0.0.1). Node only. */
  bindAddress?: string;
  /** Measure with an RTCPeerConnection instead of raw UDP (the browser method), with this class. */
  rtc?: typeof RTCPeerConnection;
  /** Test seam: the UDP socket factory. Default: node:dgram where it exists. */
  udp?: () => UdpSocketLike | null;
}

/** What a relay probe finds out. */
export type RelayProbeResult = "ok" | "refused" | "unreachable" | "unknown";

export const CHECK_DEFAULT_STUN: readonly string[] = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"];
const SERVER_MS = 1500;
const RETRANSMIT_MS = 500;
const WHOLE_MS = 8000;

// ---- STUN / TURN messages ----------------------------------------------------------------------------------------

const COOKIE = 0x2112a442;

export function hexOf(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
export function bytesOf(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function header(type: number, bodyLen: number, tid: Uint8Array): Uint8Array {
  const h = new Uint8Array(20);
  const dv = new DataView(h.buffer);
  dv.setUint16(0, type);
  dv.setUint16(2, bodyLen);
  dv.setUint32(4, COOKIE);
  h.set(tid, 8);
  return h;
}

function attr(type: number, value: Uint8Array): Uint8Array {
  const padded = (value.length + 3) & ~3;
  const a = new Uint8Array(4 + padded);
  const dv = new DataView(a.buffer);
  dv.setUint16(0, type);
  dv.setUint16(2, value.length);
  a.set(value, 4);
  return a;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** An RFC 5389 Binding Request with transaction id `tid` (12 bytes). */
export function stunBindingRequest(tid: Uint8Array): Uint8Array {
  return header(0x0001, 0, tid);
}

interface StunAttr {
  type: number;
  value: Uint8Array;
}

/** The attributes of a STUN message whose transaction id is `tid`, with its type; null when it is not one. */
function parseStun(bytes: Uint8Array, tid?: Uint8Array): { type: number; attrs: StunAttr[] } | null {
  if (bytes.length < 20) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(4) !== COOKIE) return null;
  const len = dv.getUint16(2);
  if (20 + len > bytes.length) return null;
  if (tid) for (let i = 0; i < 12; i++) if (bytes[8 + i] !== tid[i]) return null;
  const attrs: StunAttr[] = [];
  let o = 20;
  while (o + 4 <= 20 + len) {
    const t = dv.getUint16(o);
    const l = dv.getUint16(o + 2);
    if (o + 4 + l > 20 + len) break;
    attrs.push({ type: t, value: bytes.subarray(o + 4, o + 4 + l) });
    o += 4 + ((l + 3) & ~3);
  }
  return { type: dv.getUint16(0), attrs };
}

/** The mapped address in a Binding success response for `tid` (`XOR-MAPPED-ADDRESS`, else `MAPPED-ADDRESS`); null when there is none. */
export function parseStunResponse(bytes: Uint8Array, tid: Uint8Array): MappedAddress | null {
  const m = parseStun(bytes, tid);
  if (!m || m.type !== 0x0101) return null;
  for (const want of [0x0020, 0x0001]) {
    const a = m.attrs.find((x) => x.type === want);
    if (!a || a.value.length < 8 || a.value[1] !== 0x01) continue; // IPv4 only
    const v = a.value;
    let port = (v[2] << 8) | v[3];
    const ip = [v[4], v[5], v[6], v[7]];
    if (want === 0x0020) {
      port ^= COOKIE >>> 16;
      ip[0] ^= 0x21;
      ip[1] ^= 0x12;
      ip[2] ^= 0xa4;
      ip[3] ^= 0x42;
    }
    return { ip: ip.join("."), port };
  }
  return null;
}

/** The `ip:port` a Binding Response for `tid` carries (an XOR-MAPPED-ADDRESS answer; the test STUN responders use it). */
export function stunBindingResponse(tid: Uint8Array, ip: string, port: number): Uint8Array {
  const v = new Uint8Array(8);
  v[1] = 0x01;
  const xp = port ^ (COOKIE >>> 16);
  v[2] = xp >> 8;
  v[3] = xp & 0xff;
  const parts = ip.split(".").map(Number);
  const x = [0x21, 0x12, 0xa4, 0x42];
  for (let i = 0; i < 4; i++) v[4 + i] = parts[i] ^ x[i];
  const a = attr(0x0020, v);
  return concat(header(0x0101, a.length, tid), a);
}

interface NodeCrypto {
  createHash(alg: string): { update(d: string | Uint8Array): { digest(): Uint8Array } };
  createHmac(alg: string, key: Uint8Array): { update(d: Uint8Array): { digest(): Uint8Array } };
}
function nodeCrypto(): NodeCrypto | null {
  const p = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  return (p?.getBuiltinModule?.(["node", "crypto"].join(":")) as NodeCrypto | undefined) ?? null;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * A TURN Allocate request for UDP (RFC 5766). Without `auth` it is the bare first request; with it, the long-term
 * credential form (USERNAME, REALM, NONCE, MESSAGE-INTEGRITY).
 */
export function turnAllocateRequest(tid: Uint8Array, auth?: { username: string; realm: string; nonce: Uint8Array; password: string }): Uint8Array | null {
  const transport = attr(0x0019, Uint8Array.of(17, 0, 0, 0));
  if (!auth) return concat(header(0x0003, transport.length, tid), transport);
  const crypto = nodeCrypto();
  if (!crypto) return null;
  const body = concat(transport, attr(0x0006, utf8(auth.username)), attr(0x0014, utf8(auth.realm)), attr(0x0015, auth.nonce));
  // MESSAGE-INTEGRITY covers the message up to itself, with the header length counting the 24-byte attribute
  const key = crypto.createHash("md5").update(`${auth.username}:${auth.realm}:${auth.password}`).digest();
  const pre = concat(header(0x0003, body.length + 24, tid), body);
  const mac = crypto.createHmac("sha1", key).update(pre).digest();
  return concat(pre, attr(0x0008, mac));
}

/** What a TURN server answered: success, or an error code with the realm and nonce it wants (for the 401 round). */
export function parseTurnResponse(bytes: Uint8Array, tid: Uint8Array): { ok: true } | { ok: false; code: number; realm?: string; nonce?: Uint8Array } | null {
  const m = parseStun(bytes, tid);
  if (!m) return null;
  if (m.type === 0x0103) return { ok: true };
  if (m.type !== 0x0113) return null;
  const e = m.attrs.find((a) => a.type === 0x0009);
  const code = e && e.value.length >= 4 ? (e.value[2] & 7) * 100 + e.value[3] : 0;
  const realm = m.attrs.find((a) => a.type === 0x0014);
  const nonce = m.attrs.find((a) => a.type === 0x0015);
  return { ok: false, code, realm: realm ? new TextDecoder().decode(realm.value) : undefined, nonce: nonce ? Uint8Array.from(nonce.value) : undefined };
}

// ---- UDP seam ----------------------------------------------------------------------------------------------------

/** The slice of a UDP socket the check uses (node:dgram wrapped; a Godot or .NET client has its own). */
export interface UdpSocketLike {
  /** Binds and resolves with the local port and the local addresses (to tell an open NAT from a cone one). */
  bind(address?: string): Promise<{ port: number; addresses: string[] }>;
  send(bytes: Uint8Array, host: string, port: number): void;
  onMessage: ((bytes: Uint8Array) => void) | null;
  close(): void;
}

interface DgramSocket {
  bind(port: number, address: string | undefined, cb: () => void): void;
  address(): { port: number };
  send(msg: Uint8Array, port: number, host: string, cb?: (e: Error | null) => void): void;
  on(event: string, fn: (...a: any[]) => void): void;
  close(): void;
}

/** A UDP socket over node:dgram, or null where there is none (a browser). */
export function nodeUdp(): UdpSocketLike | null {
  const p = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const dgram = p?.getBuiltinModule?.(["node", "dgram"].join(":")) as { createSocket(type: string): DgramSocket } | undefined;
  const os = p?.getBuiltinModule?.(["node", "os"].join(":")) as { networkInterfaces(): Record<string, { address: string; family: string | number }[] | undefined> } | undefined;
  if (!dgram) return null;
  const s = dgram.createSocket("udp4");
  let closed = false;
  const out: UdpSocketLike = {
    onMessage: null,
    bind: (address) =>
      new Promise((resolve, reject) => {
        s.on("error", (e: Error) => !closed && reject(e));
        s.on("message", (m: Uint8Array) => out.onMessage?.(new Uint8Array(m)));
        s.bind(0, address, () => {
          const addrs = address && address !== "0.0.0.0" ? [address] : Object.values(os?.networkInterfaces() ?? {}).flatMap((l) => (l ?? []).filter((a) => a.family === "IPv4" || a.family === 4).map((a) => a.address));
          resolve({ port: s.address().port, addresses: addrs });
        });
      }),
    send: (b, host, port) => s.send(b, port, host, () => {}),
    close: () => {
      if (closed) return;
      closed = true;
      try {
        s.close();
      } catch {
        /* already closed */
      }
    },
  };
  return out;
}

/** `host` and `port` of a `stun:` / `turn:` URL (UDP only: `stuns:`, `turns:` and a tcp transport give null). */
export function iceUrlTarget(url: string): { host: string; port: number } | null {
  const m = /^(stun|turn):([^:?\s/]+)(?::(\d+))?(\?\S*)?$/i.exec(url.trim());
  if (!m) return null;
  if (m[4] && /transport=tcp/i.test(m[4])) return null;
  return { host: m[2], port: m[3] ? Number(m[3]) : 3478 };
}

// ---- measurements ------------------------------------------------------------------------------------------------

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One request/response exchange from the shared socket, with one retransmit; null when nothing valid came back in `ms`. */
function exchange<T>(sock: UdpSocketLike, listeners: Set<(b: Uint8Array) => void>, send: () => void, parse: (b: Uint8Array) => T | null, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      listeners.delete(on);
      clearTimeout(t1);
      clearTimeout(t2);
      resolve(v);
    };
    const on = (b: Uint8Array) => {
      const v = parse(b);
      if (v !== null) finish(v);
    };
    listeners.add(on);
    send();
    const t1 = setTimeout(send, Math.min(RETRANSMIT_MS, Math.floor(ms / 3)));
    const t2 = setTimeout(() => finish(null), ms);
    void sock;
  });
}

async function probeStun(sock: UdpSocketLike, listeners: Set<(b: Uint8Array) => void>, t: { host: string; port: number }, ms: number): Promise<MappedAddress | null> {
  const tid = randomBytes(12);
  const req = stunBindingRequest(tid);
  return exchange(sock, listeners, () => sock.send(req, t.host, t.port), (b) => parseStunResponse(b, tid), ms);
}

/** The TURN login round trip (RFC 5766 long-term credentials) against `turn:` entry `s`; `ok`, `refused` or `unreachable`. */
async function probeTurn(sock: UdpSocketLike, listeners: Set<(b: Uint8Array) => void>, s: IceServer, ms: number): Promise<RelayProbeResult> {
  const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => /^turn:/i.test(u));
  const targets = urls.map(iceUrlTarget).filter((x): x is { host: string; port: number } => x !== null);
  if (targets.length === 0) return "unknown";
  const t = targets[0];
  const tid1 = randomBytes(12);
  const first = turnAllocateRequest(tid1)!;
  const r1 = await exchange(sock, listeners, () => sock.send(first, t.host, t.port), (b) => parseTurnResponse(b, tid1), ms);
  if (!r1) return "unreachable";
  if (r1.ok) return "ok"; // an open relay
  if (r1.code !== 401 || !r1.realm || !r1.nonce) return "refused";
  if (!s.username || !s.credential) return "refused";
  const tid2 = randomBytes(12);
  const second = turnAllocateRequest(tid2, { username: s.username, realm: r1.realm, nonce: r1.nonce, password: s.credential });
  if (!second) return "unknown";
  const r2 = await exchange(sock, listeners, () => sock.send(second, t.host, t.port), (b) => parseTurnResponse(b, tid2), ms);
  if (!r2) return "unreachable";
  return r2.ok ? "ok" : "refused";
}

/**
 * Probes a relay entry on its own (a fresh UDP socket): `ok`, `refused` (the server answered and turned the login down),
 * `unreachable` (no answer) or `unknown` (this runtime cannot test it: no UDP socket, a `turns:` URL). A lobby uses it to
 * tell `relay_refused` from `relay_unreachable` after a failed connect.
 */
export async function probeRelay(s: IceServer, udp: () => UdpSocketLike | null = nodeUdp, ms = SERVER_MS): Promise<RelayProbeResult> {
  const sock = udp();
  if (!sock) return "unknown";
  const listeners = new Set<(b: Uint8Array) => void>();
  sock.onMessage = (b) => [...listeners].forEach((l) => l(b));
  try {
    await sock.bind();
    return await probeTurn(sock, listeners, s, ms);
  } catch {
    return "unknown";
  } finally {
    sock.close();
  }
}

async function checkRaw(sock: UdpSocketLike, o: CheckOptions, stun: string[], turn: IceServer | undefined): Promise<CheckFindings> {
  const listeners = new Set<(b: Uint8Array) => void>();
  sock.onMessage = (b) => [...listeners].forEach((l) => l(b));
  try {
    const local = await sock.bind(o.bindAddress);
    const targets = stun.map(iceUrlTarget).filter((x): x is { host: string; port: number } => x !== null);
    // the servers are asked one after the other from the same socket: a NAT that maps by destination shows two ports
    const answers: MappedAddress[] = [];
    for (const t of targets) {
      const a = await probeStun(sock, listeners, t, o.serverTimeoutMs ?? SERVER_MS);
      if (a) answers.push(a);
    }
    const mine = answers.length > 0 && local.addresses.includes(answers[0].ip) ? { ip: answers[0].ip, port: local.port } : { ip: "", port: local.port };
    const nat = classifyNat(targets.length, answers, mine);
    const relay = turn ? await probeTurn(sock, listeners, turn, o.serverTimeoutMs ?? SERVER_MS) : "none";
    return { ...nat, relay };
  } finally {
    sock.close();
  }
}

interface RtcCandidateEvent {
  candidate: { candidate: string } | null;
}
interface RtcErrorEvent {
  errorCode?: number;
}

async function checkRtc(rtc: typeof RTCPeerConnection, stun: string[], turn: IceServer | undefined, timeoutMs: number): Promise<CheckFindings> {
  const iceServers: IceServer[] = [{ urls: stun }];
  if (turn) iceServers.push(turn);
  const pc = new rtc({ iceServers: iceServers as RTCIceServer[] });
  const srflx = new Set<string>();
  let relayOk = false;
  let refused = false;
  let errored = false;
  try {
    const done = new Promise<void>((resolve) => {
      pc.onicecandidate = ((e: RtcCandidateEvent) => {
        if (!e.candidate) return resolve();
        const m = /^candidate:\S+ \d+ \S+ \d+ (\S+) (\d+) typ (\w+)/.exec(e.candidate.candidate);
        if (!m) return;
        if (m[3] === "srflx") srflx.add(`${m[1]}:${m[2]}`);
        if (m[3] === "relay") relayOk = true;
      }) as unknown as typeof pc.onicecandidate;
      (pc as unknown as { onicecandidateerror: (e: RtcErrorEvent) => void }).onicecandidateerror = (e) => {
        errored = true;
        if (e.errorCode === 401 || e.errorCode === 403) refused = true;
      };
      setTimeout(resolve, timeoutMs);
    });
    pc.createDataChannel("check");
    await pc.setLocalDescription(await pc.createOffer());
    await done;
  } finally {
    pc.close();
  }
  void errored;
  const udp = srflx.size > 0 ? "ok" : "blocked";
  // two servers that see one mapping give one candidate (the browser merges them): cone; two different ones: symmetric
  const natType = srflx.size === 0 ? "unknown" : srflx.size === 1 ? (stun.length >= 2 ? "cone" : "unknown") : "symmetric";
  return { udp, natType, relay: !turn ? "none" : relayOk ? "ok" : refused ? "refused" : "unreachable" };
}

/**
 * Checks what this network allows: whether UDP gets out, the NAT's behaviour, and whether a configured relay takes the
 * login. Nothing is contacted but the STUN servers (default: the ones the client connects with) and the player's own
 * TURN entry. Run it from a menu; the library never runs it by itself.
 */
export async function checkConnection(options: CheckOptions = {}): Promise<CheckResult> {
  const stun = options.stun ?? [...CHECK_DEFAULT_STUN];
  const turn = (options.iceServers ?? []).find((s) => hasTurn(s));
  const total = options.timeoutMs ?? WHOLE_MS;
  let findings: CheckFindings = { udp: "unknown", natType: "unknown", relay: turn ? "unknown" : "none" };
  const sock = options.rtc ? null : (options.udp ?? nodeUdp)();
  const run = sock
    ? checkRaw(sock, options, stun, turn)
    : (options.rtc ?? (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection)
      ? checkRtc((options.rtc ?? globalThis.RTCPeerConnection) as typeof RTCPeerConnection, stun, turn, Math.min(total, 4000))
      : Promise.resolve(findings);
  try {
    findings = await Promise.race([run, wait(total).then(() => findings)]);
  } catch {
    sock?.close();
  }
  return { ...findings, ...checkVerdict(findings) };
}
