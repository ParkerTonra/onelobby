/**
 * The replication wire format (spec/replication.md): snapshot, input, event and stream event messages, and `describe`.
 * Pure functions, no lobby; every message is the body of one lobby `raw` frame and starts `0x52 'R'`, version 1, kind.
 */

export const MAGIC = 0x52;
export const VERSION = 1;
export const KIND_SNAPSHOT = 1;
export const KIND_INPUT = 2;
export const KIND_EVENT = 3;
export const KIND_STREAM_EVENT = 4;
export const MAX_STATE_BYTES = 255;

const OP_DELTA = 0;
const OP_FULL = 1;
const OP_DESPAWN = 2;

/** The error names of spec/replication.md; `message` and `code` are the name. */
export type ReplicationErrorCode =
  | "too_short" | "trailing" | "varint" | "range" | "tick" | "baseline" | "id" | "op" | "delta" | "despawn" | "full" | "seq" | "stream_0" | "seq_0";

/** A malformed replication message. */
export class ReplicationError extends Error {
  constructor(readonly code: ReplicationErrorCode) {
    super(code);
    this.name = "ReplicationError";
  }
}

/** One entity inside one tick's world table. `state` is the entity's bit-packed bytes, shared (never mutated). */
export interface Ent {
  id: number;
  type: number;
  owner: number;
  state: Uint8Array;
}

/** The replicated world at one tick: entities sorted by id. */
export interface World {
  tick: number;
  ents: Ent[];
}

/** Index of `id` in the world's entities, or -1. */
export function indexOf(w: World, id: number): number {
  let lo = 0;
  let hi = w.ents.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = w.ents[mid].id;
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- bytes ----------------------------------------------------------------------------------------------------------

/** Growable byte buffer with unsigned LEB128. */
export class ByteWriter {
  private b = new Uint8Array(256);
  length = 0;

  clear(): void {
    this.length = 0;
  }
  private need(n: number): void {
    if (this.length + n > this.b.length) {
      const bigger = new Uint8Array(Math.max(this.b.length * 2, this.length + n));
      bigger.set(this.b);
      this.b = bigger;
    }
  }
  u8(v: number): void {
    this.need(1);
    this.b[this.length++] = v & 0xff;
  }
  /** varuint of a non-negative integer up to 2^53. */
  varuint(v: number): void {
    this.need(10);
    while (v >= 0x80) {
      this.b[this.length++] = (v % 128) | 0x80;
      v = Math.floor(v / 128);
    }
    this.b[this.length++] = v;
  }
  bytes(s: Uint8Array): void {
    this.need(s.length);
    this.b.set(s, this.length);
    this.length += s.length;
  }
  append(o: ByteWriter): void {
    this.bytes(o.span());
  }
  span(): Uint8Array {
    return this.b.subarray(0, this.length);
  }
  toBytes(): Uint8Array {
    return this.b.slice(0, this.length);
  }
}

class ByteReader {
  private p = 0;
  constructor(private readonly s: Uint8Array, start = 0) {
    this.p = start;
  }
  get remaining(): number {
    return this.s.length - this.p;
  }
  u8(): number {
    if (this.p >= this.s.length) throw new ReplicationError("too_short");
    return this.s[this.p++];
  }
  /** varuint as a number (exact up to 2^53; larger values are huge, which every caller range-checks anyway). */
  varuint(): number {
    let v = 0;
    let scale = 1;
    for (let shift = 0; shift < 70; shift += 7) {
      const b = this.u8();
      if (shift === 63 && b > 1) throw new ReplicationError("varint");
      v += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) return v;
      scale *= 128;
    }
    throw new ReplicationError("varint");
  }
  var32(): number {
    const v = this.varuint();
    if (v > 0xffffffff) throw new ReplicationError("range");
    return v;
  }
  bytes(n: number): Uint8Array {
    if (n < 0 || n > this.remaining) throw new ReplicationError("too_short");
    const r = this.s.subarray(this.p, this.p + n);
    this.p += n;
    return r;
  }
  rest(): Uint8Array {
    return this.bytes(this.remaining);
  }
}

/** True when this raw payload is a replication message (at least 3 bytes, first byte 0x52). */
export function isReplication(p: Uint8Array): boolean {
  return p.length >= 3 && p[0] === MAGIC;
}

function header(w: ByteWriter, kind: number): void {
  w.u8(MAGIC);
  w.u8(VERSION);
  w.u8(kind);
}

// ---- snapshot -------------------------------------------------------------------------------------------------------

function recHead(w: ByteWriter, prev: { v: number }, id: number, op: number): void {
  w.varuint((id - prev.v) * 4 + op);
  prev.v = id;
}

function full(w: ByteWriter, prev: { v: number }, e: Ent): void {
  recHead(w, prev, e.id, OP_FULL);
  w.varuint(e.type);
  w.varuint(e.owner);
  w.varuint(e.state.length);
  w.bytes(e.state);
}

/** Encode `cur` as a delta against `baseline` (null = full snapshot). */
export function encodeSnapshot(cur: World, baseline: World | null, lastInputSeq: number, w = new ByteWriter(), recs = new ByteWriter()): Uint8Array {
  w.clear();
  recs.clear();
  header(w, KIND_SNAPSHOT);
  w.varuint(cur.tick);
  w.varuint(baseline ? cur.tick - baseline.tick : 0);
  w.varuint(lastInputSeq);
  const bas = baseline ? baseline.ents : [];
  const c = cur.ents;
  let i = 0;
  let j = 0;
  let count = 0;
  const prev = { v: 0 };
  while (i < c.length || j < bas.length) {
    if (j >= bas.length || (i < c.length && c[i].id < bas[j].id)) {
      full(recs, prev, c[i]);
      i++;
      count++;
    } else if (i >= c.length || bas[j].id < c[i].id) {
      recHead(recs, prev, bas[j].id, OP_DESPAWN);
      j++;
      count++;
    } else {
      const a = c[i++];
      const b = bas[j++];
      if (a.type !== b.type || a.owner !== b.owner || a.state.length !== b.state.length) {
        full(recs, prev, a);
        count++;
        continue;
      }
      if (sameBytes(a.state, b.state)) continue;
      recHead(recs, prev, a.id, OP_DELTA);
      const len = a.state.length;
      const mask = new Uint8Array((len + 7) >> 3);
      for (let k = 0; k < len; k++) if (a.state[k] !== b.state[k]) mask[k >> 3] |= 1 << (k & 7);
      recs.bytes(mask);
      for (let k = 0; k < len; k++) if (a.state[k] !== b.state[k]) recs.u8(a.state[k]);
      count++;
    }
  }
  w.varuint(count);
  w.append(recs);
  return w.toBytes();
}

export interface SnapshotHeader {
  tick: number;
  /** 0 = full snapshot. */
  baselineTick: number;
  lastInput: number;
}

/** Reads only the header (after the 3-byte prefix) so the caller can find the baseline. */
export function peekSnapshot(p: Uint8Array): SnapshotHeader {
  const r = new ByteReader(p, 3);
  const tick = r.var32();
  const back = r.var32();
  const last = r.var32();
  if (tick === 0 || back > tick) throw new ReplicationError("tick");
  return { tick, baselineTick: back === 0 ? 0 : tick - back, lastInput: last };
}

/** Apply a snapshot to its baseline (null for a full snapshot). Throws {@link ReplicationError}. */
export function decodeSnapshot(p: Uint8Array, baseline: World | null): World {
  const r = new ByteReader(p, 3);
  const tick = r.var32();
  const back = r.var32();
  r.var32();
  if (tick === 0 || back > tick) throw new ReplicationError("tick");
  if ((back === 0) !== (baseline === null)) throw new ReplicationError("baseline");
  const count = r.varuint();
  const bas = baseline ? baseline.ents : [];
  const out: Ent[] = [];
  let j = 0;
  let prev = 0;
  for (let n = 0; n < count; n++) {
    const head = r.varuint();
    const op = head % 4;
    const delta = Math.floor(head / 4);
    if (delta === 0 || prev + delta > 0xffffffff) throw new ReplicationError("id");
    const id = prev + delta;
    prev = id;
    while (j < bas.length && bas[j].id < id) out.push(bas[j++]);
    const inBase = j < bas.length && bas[j].id === id;
    switch (op) {
      case OP_FULL: {
        const type = r.varuint();
        const owner = r.varuint();
        const len = r.varuint();
        if (type > 65535 || owner > 0x7fffffff || len > MAX_STATE_BYTES) throw new ReplicationError("full");
        out.push({ id, type, owner, state: r.bytes(len).slice() });
        if (inBase) j++;
        break;
      }
      case OP_DESPAWN:
        if (!inBase) throw new ReplicationError("despawn");
        j++;
        break;
      case OP_DELTA: {
        if (!inBase) throw new ReplicationError("delta");
        const b = bas[j++];
        const len = b.state.length;
        const mask = r.bytes((len + 7) >> 3);
        const st = b.state.slice();
        for (let k = 0; k < len; k++) if (((mask[k >> 3] >> (k & 7)) & 1) !== 0) st[k] = r.u8();
        out.push({ id, type: b.type, owner: b.owner, state: st });
        break;
      }
      default:
        throw new ReplicationError("op");
    }
  }
  while (j < bas.length) out.push(bas[j++]);
  if (r.remaining !== 0) throw new ReplicationError("trailing");
  return { tick, ents: out };
}

// ---- input ----------------------------------------------------------------------------------------------------------

/** One input entry: view tick in 1/256 tick, and the game's bytes. */
export interface InputEntry {
  view256: number;
  bytes: Uint8Array;
}

/** `newestFirst`: entries for seq newestSeq, newestSeq-1, ...; the first `count` are written. */
export function encodeInput(ack: number, newestSeq: number, newestFirst: readonly InputEntry[], count = newestFirst.length, w = new ByteWriter()): Uint8Array {
  w.clear();
  header(w, KIND_INPUT);
  w.varuint(ack);
  w.varuint(newestSeq);
  w.u8(count);
  for (let i = 0; i < count; i++) {
    const e = newestFirst[i];
    w.varuint(e.view256);
    w.varuint(e.bytes.length);
    w.bytes(e.bytes);
  }
  return w.toBytes();
}

export interface DecodedInput {
  ack: number;
  newestSeq: number;
  inputs: { seq: number; view256: number; bytes: Uint8Array }[];
}

export function decodeInput(p: Uint8Array): DecodedInput {
  const r = new ByteReader(p, 3);
  const ack = r.var32();
  const newest = r.var32();
  const n = r.u8();
  if (n > newest) throw new ReplicationError("seq");
  const inputs: DecodedInput["inputs"] = [];
  for (let i = 0; i < n; i++) {
    const view256 = r.varuint();
    const len = Math.min(r.varuint(), 0x7fffffff);
    inputs.push({ seq: newest - i, view256, bytes: r.bytes(len).slice() });
  }
  if (r.remaining !== 0) throw new ReplicationError("trailing");
  return { ack, newestSeq: newest, inputs };
}

// ---- events ---------------------------------------------------------------------------------------------------------

export function encodeEvent(tick: number, payload: Uint8Array, w = new ByteWriter()): Uint8Array {
  w.clear();
  header(w, KIND_EVENT);
  w.varuint(tick);
  w.bytes(payload);
  return w.toBytes();
}

export function decodeEvent(p: Uint8Array): { tick: number; payload: Uint8Array } {
  const r = new ByteReader(p, 3);
  const tick = r.var32();
  return { tick, payload: r.rest().slice() };
}

export function encodeStreamEvent(tick: number, stream: number, seq: number, payload: Uint8Array, w = new ByteWriter()): Uint8Array {
  w.clear();
  header(w, KIND_STREAM_EVENT);
  w.varuint(tick);
  w.u8(stream);
  w.varuint(seq);
  w.bytes(payload);
  return w.toBytes();
}

export function decodeStreamEvent(p: Uint8Array): { tick: number; stream: number; seq: number; payload: Uint8Array } {
  const r = new ByteReader(p, 3);
  const tick = r.var32();
  const stream = r.u8();
  if (stream === 0) throw new ReplicationError("stream_0");
  const seq = r.var32();
  if (seq === 0) throw new ReplicationError("seq_0");
  return { tick, stream, seq, payload: r.rest().slice() };
}

// ---- debug view -----------------------------------------------------------------------------------------------------

export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
  return s;
}

export function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * One replication message as a plain JSON-able object (spec/replication.md "Debug view"). A delta record needs its
 * baseline (the state length decides the mask size), so pass the baseline world when you have it. Never throws.
 */
export function describe(p: Uint8Array, baseline: World | null = null): { [k: string]: Json } {
  if (!isReplication(p)) return { kind: "other", bytes: p.length };
  if (p[1] !== VERSION) return { kind: "ignored", reason: "version", version: p[1], bytes: p.length };
  const names: Record<number, string> = { 1: "snapshot", 2: "input", 3: "event", 4: "streamEvent" };
  const kind = names[p[2]];
  if (!kind) return { kind: "unknown", number: p[2], bytes: p.length };
  const out: { [k: string]: Json } = { kind, bytes: p.length };
  try {
    const r = new ByteReader(p, 3);
    if (p[2] === KIND_SNAPSHOT) describeSnapshot(r, out, baseline);
    else if (p[2] === KIND_INPUT) describeInput(r, out);
    else if (p[2] === KIND_EVENT) {
      out.tick = r.var32();
      payload(out, "payload", r.rest());
    } else {
      const tick = r.var32();
      const stream = r.u8();
      if (stream === 0) throw new ReplicationError("stream_0");
      const seq = r.var32();
      if (seq === 0) throw new ReplicationError("seq_0");
      out.tick = tick;
      out.stream = stream;
      out.seq = seq;
      payload(out, "payload", r.rest());
    }
    return out;
  } catch (e) {
    if (e instanceof ReplicationError) return { kind, bytes: p.length, error: e.code };
    throw e;
  }
}

function payload(o: { [k: string]: Json }, key: string, b: Uint8Array): void {
  o.len = b.length;
  o[key] = toHex(b);
}

function describeInput(r: ByteReader, out: { [k: string]: Json }): void {
  const ack = r.var32();
  const newest = r.var32();
  const n = r.u8();
  if (n > newest) throw new ReplicationError("seq");
  const inputs: Json[] = [];
  for (let i = 0; i < n; i++) {
    const view = r.varuint();
    const len = Math.min(r.varuint(), 0x7fffffff);
    const e: { [k: string]: Json } = { seq: newest - i, view256: view };
    payload(e, "hex", r.bytes(len));
    inputs.push(e);
  }
  if (r.remaining !== 0) throw new ReplicationError("trailing");
  out.ack = ack;
  out.newest = newest;
  out.n = n;
  out.inputs = inputs;
}

function describeSnapshot(r: ByteReader, out: { [k: string]: Json }, baseline: World | null): void {
  const tick = r.var32();
  const back = r.var32();
  const last = r.var32();
  if (tick === 0 || back > tick) throw new ReplicationError("tick");
  const count = r.varuint();
  out.tick = tick;
  out.back = back;
  out.baselineTick = back === 0 ? 0 : tick - back;
  out.lastInput = last;
  out.count = count;
  const records: Json[] = [];
  out.records = records;
  let prev = 0;
  let truncated = false;
  for (let n = 0; n < count && !truncated; n++) {
    const head = r.varuint();
    const delta = Math.floor(head / 4);
    if (delta === 0 || prev + delta > 0xffffffff) throw new ReplicationError("id");
    const id = prev + delta;
    prev = id;
    const rec: { [k: string]: Json } = { id };
    switch (head % 4) {
      case OP_FULL: {
        const type = r.varuint();
        const owner = r.varuint();
        const len = r.varuint();
        if (type > 65535 || owner > 0x7fffffff || len > MAX_STATE_BYTES) throw new ReplicationError("full");
        rec.op = "full";
        rec.type = type;
        rec.owner = owner;
        payload(rec, "state", r.bytes(len));
        break;
      }
      case OP_DESPAWN:
        rec.op = "despawn";
        break;
      case OP_DELTA: {
        rec.op = "delta";
        if (!baseline) {
          rec.unknown = true;
          truncated = true;
          break;
        }
        const at = indexOf(baseline, id);
        if (at < 0) throw new ReplicationError("delta");
        const len = baseline.ents[at].state.length;
        const mask = r.bytes((len + 7) >> 3);
        const changed: number[] = [];
        const vals: number[] = [];
        for (let k = 0; k < len; k++) if (((mask[k >> 3] >> (k & 7)) & 1) !== 0) changed.push(k);
        for (let k = 0; k < changed.length; k++) vals.push(r.u8());
        rec.changed = changed;
        rec.values = toHex(Uint8Array.from(vals));
        break;
      }
      default:
        throw new ReplicationError("op");
    }
    records.push(rec);
  }
  if (truncated) out.truncated = true;
  else if (r.remaining !== 0) throw new ReplicationError("trailing");
}
