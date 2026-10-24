// OneLobby reference codec for the data-channel binary protocol (DESIGN s.8, s.9a, s.9b).
// Little-endian. 3-byte header: type:u8, route:u16. One message per frame, <= 16 KiB.
// Representation: i64/u64 fields are BigInt, bytes fields are Uint8Array, chat text is a JS string.
// JSON form (spec/vectors): i64/u64 as decimal strings, bytes as lowercase hex, text as string.

export const MAX_FRAME = 16384;
export const HEADER = 3;
export const MAX_CHUNK_BODY = MAX_FRAME - HEADER - 8; // 16373: chunk body = id:u32 index:u16 count:u16 + bytes
export const DEFAULT_CHUNK = 16000;
export const MAX_REASSEMBLED = 64 * 1024 * 1024;

export const TYPES = {
  hi: 0x01, welcome_dc: 0x02, cmd: 0x10, frame: 0x11, hash: 0x12, desync: 0x13, snapshot_req: 0x14,
  snapshot: 0x15, chunk: 0x16, raw: 0x20, ping: 0x30, pong: 0x31, host_claim: 0x40, voice: 0x50,
  chat: 0x60, chat_history: 0x61, chat_reject: 0x62,
};
export const NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));

// Field kinds: u8 u16 u32 i64 u64; lbytes = u16 length + bytes; text = u16 length + utf8; rest = bytes to end of frame;
// list16/list8 = u16/u8 count + repeated records. A list is always the last thing in the body.
const LAYOUT = {
  hi: [['proto', 'u8'], ['peerId', 'u16'], ['lastTick', 'i64']],
  welcome_dc: [['tick', 'i64'], ['tickRate', 'u8'], ['mode', 'u8'], ['hostId', 'u16']],
  cmd: [['seq', 'u32'], ['bytes', 'lbytes']],
  frame: [['tick', 'i64'], ['cmds', 'list16', [['peerId', 'u16'], ['bytes', 'lbytes']]]],
  hash: [['tick', 'i64'], ['hash', 'u64']],
  desync: [['tick', 'i64'], ['hostHash', 'u64'], ['yourHash', 'u64']],
  snapshot_req: [['sinceTick', 'i64']],
  snapshot: [['tick', 'i64'], ['total', 'u32'], ['flags', 'u8']],
  chunk: [['id', 'u32'], ['index', 'u16'], ['count', 'u16'], ['bytes', 'rest']],
  raw: [['bytes', 'rest']],
  ping: [['n', 'u32'], ['t', 'u32']],
  pong: [['n', 'u32'], ['t', 'u32']],
  host_claim: [['epoch', 'u16'], ['hostId', 'u16'], ['tick', 'i64']],
  voice: [['seq', 'u16'], ['flags', 'u8'], ['packets', 'list8', [['opus', 'lbytes']]]],
  chat: [['id', 'u32'], ['ts', 'i64'], ['text', 'text']],
  chat_history: [['lines', 'list16', [['peerId', 'u16'], ['id', 'u32'], ['ts', 'i64'], ['text', 'text']]]],
  chat_reject: [['id', 'u32'], ['reason', 'u8']],
};
export const LAYOUTS = LAYOUT;

export class CodecError extends Error {
  constructor(code, msg) { super(`${code}: ${msg}`); this.code = code; }
}

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });
const SIZE = { u8: 1, u16: 2, u32: 4, i64: 8, u64: 8 };

class W {
  constructor() { this.parts = []; this.len = 0; }
  num(kind, v) {
    const b = new Uint8Array(SIZE[kind]);
    const dv = new DataView(b.buffer);
    const bad = () => { throw new CodecError('bad_value', `${kind} out of range: ${v}`); };
    if (kind === 'u8') { if (!Number.isInteger(v) || v < 0 || v > 255) bad(); dv.setUint8(0, v); }
    else if (kind === 'u16') { if (!Number.isInteger(v) || v < 0 || v > 65535) bad(); dv.setUint16(0, v, true); }
    else if (kind === 'u32') { if (!Number.isInteger(v) || v < 0 || v > 4294967295) bad(); dv.setUint32(0, v, true); }
    else if (kind === 'i64') { const x = BigInt(v); if (x < -(2n ** 63n) || x >= 2n ** 63n) bad(); dv.setBigInt64(0, x, true); }
    else { const x = BigInt(v); if (x < 0n || x >= 2n ** 64n) bad(); dv.setBigUint64(0, x, true); }
    this.push(b);
  }
  push(b) { this.parts.push(b); this.len += b.length; }
  bytes() {
    const o = new Uint8Array(this.len);
    let p = 0;
    for (const b of this.parts) { o.set(b, p); p += b.length; }
    return o;
  }
}

function writeFields(w, spec, obj) {
  for (const [name, kind, sub] of spec) {
    const v = obj[name];
    if (v === undefined) throw new CodecError('missing_field', name);
    if (kind in SIZE) w.num(kind, v);
    else if (kind === 'lbytes') {
      if (v.length > 65535) throw new CodecError('bad_value', `${name} too long`);
      w.num('u16', v.length);
      w.push(Uint8Array.from(v));
    } else if (kind === 'text') {
      const b = te.encode(v);
      if (b.length > 65535) throw new CodecError('bad_value', 'text too long');
      w.num('u16', b.length);
      w.push(b);
    } else if (kind === 'rest') w.push(Uint8Array.from(v));
    else if (kind === 'list16' || kind === 'list8') {
      w.num(kind === 'list16' ? 'u16' : 'u8', v.length);
      for (const rec of v) writeFields(w, sub, rec);
    }
  }
}

export function encode(msg) {
  const typeId = typeof msg.type === 'number' ? msg.type : TYPES[msg.type];
  const name = NAMES[typeId];
  if (typeId === undefined || !name) throw new CodecError('unknown_type', String(msg.type));
  const w = new W();
  w.num('u8', typeId);
  w.num('u16', msg.route ?? 0);
  writeFields(w, LAYOUT[name], msg);
  const out = w.bytes();
  if (out.length > MAX_FRAME) throw new CodecError('too_long', `${out.length} > ${MAX_FRAME}`);
  return out;
}

class R {
  constructor(b, off) { this.b = b; this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); this.p = off; }
  need(n) { if (this.p + n > this.b.length) throw new CodecError('too_short', `need ${n} at ${this.p} of ${this.b.length}`); }
  num(kind) {
    this.need(SIZE[kind]);
    let v;
    const p = this.p;
    if (kind === 'u8') v = this.dv.getUint8(p);
    else if (kind === 'u16') v = this.dv.getUint16(p, true);
    else if (kind === 'u32') v = this.dv.getUint32(p, true);
    else if (kind === 'i64') v = this.dv.getBigInt64(p, true);
    else v = this.dv.getBigUint64(p, true);
    this.p += SIZE[kind];
    return v;
  }
  take(n) { this.need(n); const s = this.b.slice(this.p, this.p + n); this.p += n; return s; }
}

function readFields(r, spec) {
  const o = {};
  for (const [name, kind, sub] of spec) {
    if (kind in SIZE) o[name] = r.num(kind);
    else if (kind === 'lbytes') o[name] = r.take(r.num('u16'));
    else if (kind === 'text') {
      const raw = r.take(r.num('u16'));
      try { o[name] = td.decode(raw); } catch { throw new CodecError('bad_utf8', name); }
    } else if (kind === 'rest') o[name] = r.take(r.b.length - r.p);
    else {
      const n = r.num(kind === 'list16' ? 'u16' : 'u8');
      o[name] = [];
      for (let i = 0; i < n; i++) o[name].push(readFields(r, sub));
    }
  }
  return o;
}

// Unknown type ids decode to {type:'unknown', typeId, route, body}: receivers ignore them (additive evolution).
export function decode(buf) {
  const b = buf instanceof Uint8Array ? buf : Uint8Array.from(buf);
  if (b.length > MAX_FRAME) throw new CodecError('too_long', `${b.length} > ${MAX_FRAME}`);
  if (b.length < HEADER) throw new CodecError('too_short', 'header');
  const r = new R(b, 0);
  const typeId = r.num('u8');
  const route = r.num('u16');
  const name = NAMES[typeId];
  if (!name) return { type: 'unknown', typeId, route, body: b.slice(HEADER) };
  const o = readFields(r, LAYOUT[name]);
  if (r.p !== b.length) throw new CodecError('trailing', `${b.length - r.p} extra bytes`);
  return { type: name, typeId, route, ...o };
}

// ---- JSON form (vectors) ----
export const hex = (b) => Buffer.from(b).toString('hex');
export const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));

function mapFields(spec, o, f) {
  const out = {};
  for (const [name, kind, sub] of spec) {
    if (kind === 'i64' || kind === 'u64' || kind === 'lbytes' || kind === 'rest') out[name] = f(kind, o[name]);
    else if (kind === 'list16' || kind === 'list8') out[name] = o[name].map((rec) => mapFields(sub, rec, f));
    else out[name] = o[name];
  }
  return out;
}
export function toJson(msg) {
  return { type: msg.type, route: msg.route, ...mapFields(LAYOUT[msg.type], msg, (k, v) => (k === 'i64' || k === 'u64') ? v.toString() : hex(v)) };
}
export function fromJson(j) {
  return { type: j.type, route: j.route, ...mapFields(LAYOUT[j.type], j, (k, v) => (k === 'i64' || k === 'u64') ? BigInt(v) : unhex(v)) };
}

// ---- chunking ----
// Split `bytes` into chunk messages sharing `id`. chunkSize <= MAX_CHUNK_BODY.
export function chunkPayload(id, bytes, chunkSize = DEFAULT_CHUNK, route = 0) {
  if (chunkSize < 1 || chunkSize > MAX_CHUNK_BODY) throw new CodecError('bad_value', 'chunkSize');
  const count = Math.max(1, Math.ceil(bytes.length / chunkSize));
  if (count > 65535) throw new CodecError('too_long', 'more than 65535 chunks');
  const out = [];
  for (let i = 0; i < count; i++) out.push({ type: 'chunk', route, id, index: i, count, bytes: bytes.slice(i * chunkSize, (i + 1) * chunkSize) });
  return out;
}

// Reassembles chunk messages (any order, duplicates ignored). feed() returns the full bytes when complete, else null.
export class Reassembler {
  constructor(maxBytes = MAX_REASSEMBLED) { this.sets = new Map(); this.max = maxBytes; }
  feed(c) {
    if (c.count < 1 || c.index >= c.count) throw new CodecError('bad_chunk', 'index/count');
    let s = this.sets.get(c.id);
    if (!s) { s = { count: c.count, parts: new Map(), size: 0 }; this.sets.set(c.id, s); }
    if (s.count !== c.count) throw new CodecError('bad_chunk', 'count changed');
    if (!s.parts.has(c.index)) { s.parts.set(c.index, c.bytes); s.size += c.bytes.length; }
    if (s.size > this.max) { this.sets.delete(c.id); throw new CodecError('too_long', 'reassembly cap'); }
    if (s.parts.size < s.count) return null;
    this.sets.delete(c.id);
    const out = new Uint8Array(s.size);
    let p = 0;
    for (let i = 0; i < s.count; i++) { out.set(s.parts.get(i), p); p += s.parts.get(i).length; }
    return out;
  }
}
