/**
 * Binary codec for the peer data channels (DESIGN s.8). Little-endian, one message per frame,
 * 3-byte header `type:u8, route:u16`. Pure functions; no I/O.
 */

export const MAX_FRAME_BYTES = 16 * 1024;
/** Cap on one reassembled chunk set (spec/binary.md "Snapshot and chunks"). */
export const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
export const HEADER_BYTES = 3;
export const PROTO = 1;

export const MsgType = {
  hi: 0x01,
  welcome_dc: 0x02,
  cmd: 0x10,
  frame: 0x11,
  hash: 0x12,
  desync: 0x13,
  snapshot_req: 0x14,
  snapshot: 0x15,
  chunk: 0x16,
  raw: 0x20,
  ping: 0x30,
  pong: 0x31,
  host_claim: 0x40,
  voice: 0x50,
  chat: 0x60,
  chat_history: 0x61,
  chat_reject: 0x62,
  pause_request: 0x70,
  pause_state: 0x71,
  pause_refuse: 0x72,
} as const;

/** welcome_dc.mode: 1 = lockstep, 2 = raw (0 reserved) per spec/binary.md. */
export const MODE_LOCKSTEP = 1;
export const MODE_RAW = 2;

export type CodecErrorCode = "too_short" | "trailing" | "too_long" | "bad_utf8" | "bad_value";
export class CodecError extends Error {
  constructor(public code: CodecErrorCode, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "CodecError";
  }
}

export interface FrameCommand {
  peerId: number;
  bytes: Uint8Array;
}
export interface ChatLine {
  peerId: number;
  id: number;
  ts: number;
  text: string;
}

export type Message =
  | { type: "hi"; proto: number; peerId: number; lastTick: number }
  | { type: "welcome_dc"; tick: number; tickRate: number; mode: number; hostId: number }
  | { type: "cmd"; seq: number; bytes: Uint8Array }
  | { type: "frame"; tick: number; commands: FrameCommand[] }
  | { type: "hash"; tick: number; hash: bigint }
  | { type: "desync"; tick: number; hostHash: bigint; yourHash: bigint }
  | { type: "snapshot_req"; sinceTick: number }
  | { type: "snapshot"; tick: number; total: number; flags: number }
  | { type: "chunk"; id: number; index: number; count: number; bytes: Uint8Array }
  | { type: "raw"; bytes: Uint8Array }
  | { type: "ping"; n: number; t: number }
  | { type: "pong"; n: number; t: number }
  | { type: "host_claim"; epoch: number; hostId: number; tick: number }
  | { type: "voice"; seq: number; flags: number; frames: Uint8Array[] }
  | { type: "chat"; id: number; ts: number; text: string }
  | { type: "chat_history"; lines: ChatLine[] }
  | { type: "chat_reject"; id: number; reason: number }
  | { type: "pause_request"; paused: number }
  | { type: "pause_state"; paused: number; byPeer: number; flags: number }
  | { type: "pause_refuse"; paused: number; reason: number };

export interface Decoded {
  route: number;
  msg: Message;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
function decodeText(b: Uint8Array): string {
  try {
    return dec.decode(b);
  } catch {
    throw new CodecError("bad_utf8");
  }
}

class Writer {
  buf: Uint8Array;
  dv: DataView;
  pos = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(size);
    this.dv = new DataView(this.buf.buffer);
  }
  ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
    nb.set(this.buf);
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  u8(v: number) { this.ensure(1); this.dv.setUint8(this.pos, v); this.pos += 1; }
  u16(v: number) { this.ensure(2); this.dv.setUint16(this.pos, v, true); this.pos += 2; }
  u32(v: number) { this.ensure(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  i64(v: number) { this.ensure(8); this.dv.setBigInt64(this.pos, BigInt(v), true); this.pos += 8; }
  u64(v: bigint) { this.ensure(8); this.dv.setBigUint64(this.pos, BigInt.asUintN(64, v), true); this.pos += 8; }
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  done(): Uint8Array { return this.buf.slice(0, this.pos); }
}

class Reader {
  dv: DataView;
  pos = 0;
  constructor(public buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  need(n: number) { if (this.pos + n > this.buf.length) throw new CodecError("too_short", "truncated frame"); }
  u8() { this.need(1); const v = this.dv.getUint8(this.pos); this.pos += 1; return v; }
  u16() { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i64() { this.need(8); const v = this.dv.getBigInt64(this.pos, true); this.pos += 8; return Number(v); }
  u64() { this.need(8); const v = this.dv.getBigUint64(this.pos, true); this.pos += 8; return v; }
  bytes(n: number) { this.need(n); const v = this.buf.slice(this.pos, this.pos + n); this.pos += n; return v; }
  rest() { const v = this.buf.slice(this.pos); this.pos = this.buf.length; return v; }
}

export function encodeMessage(msg: Message, route = 0, allowOversize = false): Uint8Array {
  const w = new Writer(64);
  w.u8(MsgType[msg.type]);
  w.u16(route);
  switch (msg.type) {
    case "hi": w.u8(msg.proto); w.u16(msg.peerId); w.i64(msg.lastTick); break;
    case "welcome_dc": w.i64(msg.tick); w.u8(msg.tickRate); w.u8(msg.mode); w.u16(msg.hostId); break;
    case "cmd": w.u32(msg.seq); w.u16(msg.bytes.length); w.bytes(msg.bytes); break;
    case "frame":
      w.i64(msg.tick); w.u16(msg.commands.length);
      for (const c of msg.commands) { w.u16(c.peerId); w.u16(c.bytes.length); w.bytes(c.bytes); }
      break;
    case "hash": w.i64(msg.tick); w.u64(msg.hash); break;
    case "desync": w.i64(msg.tick); w.u64(msg.hostHash); w.u64(msg.yourHash); break;
    case "snapshot_req": w.i64(msg.sinceTick); break;
    case "snapshot": w.i64(msg.tick); w.u32(msg.total); w.u8(msg.flags); break;
    case "chunk": w.u32(msg.id); w.u16(msg.index); w.u16(msg.count); w.bytes(msg.bytes); break;
    case "raw": w.bytes(msg.bytes); break;
    case "ping": case "pong": w.u32(msg.n); w.u32(msg.t); break;
    case "host_claim": w.u16(msg.epoch); w.u16(msg.hostId); w.i64(msg.tick); break;
    case "voice":
      w.u16(msg.seq); w.u8(msg.flags); w.u8(msg.frames.length);
      for (const f of msg.frames) { w.u16(f.length); w.bytes(f); }
      break;
    case "chat": { const t = enc.encode(msg.text); w.u32(msg.id); w.i64(msg.ts); w.u16(t.length); w.bytes(t); break; }
    case "chat_history":
      w.u16(msg.lines.length);
      for (const l of msg.lines) {
        const t = enc.encode(l.text);
        w.u16(l.peerId); w.u32(l.id); w.i64(l.ts); w.u16(t.length); w.bytes(t);
      }
      break;
    case "chat_reject": w.u32(msg.id); w.u8(msg.reason); break;
    case "pause_request": w.u8(msg.paused); break;
    case "pause_state": w.u8(msg.paused); w.u16(msg.byPeer); w.u8(msg.flags); break;
    case "pause_refuse": w.u8(msg.paused); w.u8(msg.reason); break;
  }
  const out = w.done();
  if (!allowOversize && out.length > MAX_FRAME_BYTES) throw new CodecError("too_long", `${out.length} > ${MAX_FRAME_BYTES}`);
  return out;
}

const TYPE_BY_ID = new Map<number, keyof typeof MsgType>(
  (Object.keys(MsgType) as Array<keyof typeof MsgType>).map((k) => [MsgType[k], k]),
);

/**
 * Decode one frame. Returns null for unknown types (ignored for forward compatibility); throws on a truncated body.
 * A frame reassembled from chunks passes `reassembled` so the cap is MAX_REASSEMBLED_BYTES instead of one frame's.
 */
export function decodeMessage(buf: Uint8Array, reassembled = false): Decoded | null {
  const max = reassembled ? MAX_REASSEMBLED_BYTES : MAX_FRAME_BYTES;
  if (buf.length > max) throw new CodecError("too_long", `${buf.length} > ${max}`);
  if (buf.length < HEADER_BYTES) throw new CodecError("too_short", "header");
  const r = new Reader(buf);
  const type = TYPE_BY_ID.get(r.u8());
  const route = r.u16();
  if (!type) return null;
  let msg: Message;
  switch (type) {
    case "hi": msg = { type, proto: r.u8(), peerId: r.u16(), lastTick: r.i64() }; break;
    case "welcome_dc": msg = { type, tick: r.i64(), tickRate: r.u8(), mode: r.u8(), hostId: r.u16() }; break;
    case "cmd": { const seq = r.u32(); msg = { type, seq, bytes: r.bytes(r.u16()) }; break; }
    case "frame": {
      const tick = r.i64(); const n = r.u16(); const commands: FrameCommand[] = [];
      for (let i = 0; i < n; i++) { const peerId = r.u16(); commands.push({ peerId, bytes: r.bytes(r.u16()) }); }
      msg = { type, tick, commands }; break;
    }
    case "hash": msg = { type, tick: r.i64(), hash: r.u64() }; break;
    case "desync": msg = { type, tick: r.i64(), hostHash: r.u64(), yourHash: r.u64() }; break;
    case "snapshot_req": msg = { type, sinceTick: r.i64() }; break;
    case "snapshot": msg = { type, tick: r.i64(), total: r.u32(), flags: r.u8() }; break;
    case "chunk": msg = { type, id: r.u32(), index: r.u16(), count: r.u16(), bytes: r.rest() }; break;
    case "raw": msg = { type, bytes: r.rest() }; break;
    case "ping": case "pong": msg = { type, n: r.u32(), t: r.u32() }; break;
    case "host_claim": msg = { type, epoch: r.u16(), hostId: r.u16(), tick: r.i64() }; break;
    case "voice": {
      const seq = r.u16(); const flags = r.u8(); const n = r.u8(); const frames: Uint8Array[] = [];
      for (let i = 0; i < n; i++) frames.push(r.bytes(r.u16()));
      msg = { type, seq, flags, frames }; break;
    }
    case "chat": { const id = r.u32(); const ts = r.i64(); msg = { type, id, ts, text: decodeText(r.bytes(r.u16())) }; break; }
    case "chat_history": {
      const n = r.u16(); const lines: ChatLine[] = [];
      for (let i = 0; i < n; i++) {
        const peerId = r.u16(); const id = r.u32(); const ts = r.i64();
        lines.push({ peerId, id, ts, text: decodeText(r.bytes(r.u16())) });
      }
      msg = { type, lines }; break;
    }
    case "chat_reject": msg = { type, id: r.u32(), reason: r.u8() }; break;
    case "pause_request": msg = { type, paused: r.u8() }; break;
    case "pause_state": msg = { type, paused: r.u8(), byPeer: r.u16(), flags: r.u8() }; break;
    case "pause_refuse": msg = { type, paused: r.u8(), reason: r.u8() }; break;
  }
  if (r.pos !== buf.length) throw new CodecError("trailing", `${buf.length - r.pos} extra bytes`);
  return { route, msg };
}

/** Rewrite the route field on a copy (the host does this when relaying). */
export function withRoute(buf: Uint8Array, route: number): Uint8Array {
  const out = buf.slice();
  out[1] = route & 0xff;
  out[2] = (route >> 8) & 0xff;
  return out;
}

export const CHAT_REJECT = { rate: 1, length: 2, mutedByHost: 3 } as const;
export type ChatRejectReason = "rate" | "length" | "muted_by_host" | "unknown";
export function chatRejectName(code: number): ChatRejectReason {
  return code === 1 ? "rate" : code === 2 ? "length" : code === 3 ? "muted_by_host" : "unknown";
}

/** `pause_state.flags` bit 0: the pauser left and the host holds the pause. */
export const PAUSE_FLAG_PAUSER_LEFT = 1;
/** `pause_refuse.reason`: 1 not_in_game, 2 rate_limited, 3 not_allowed. */
export const PAUSE_REFUSE = { notInGame: 1, rateLimited: 2, notAllowed: 3 } as const;
