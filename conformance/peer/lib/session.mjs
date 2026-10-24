// Harness core: a Session wires an adapter (the library under test) to scripted fake remote peers.
import { encode, decode, hex, unhex, CodecError, MAX_FRAME } from '../../../spec/reference/codec.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalise for comparisons: bigint -> decimal string, bytes -> hex, numbers -> decimal string.
export function norm(v) {
  if (typeof v === 'bigint' || typeof v === 'number') return String(v);
  if (v instanceof Uint8Array) return hex(v);
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
  return v;
}
export function matches(obj, where) {
  for (const [k, w] of Object.entries(where)) {
    if (typeof w === 'function') { if (!w(obj[k], obj)) return false; continue; }
    if (JSON.stringify(norm(obj[k])) !== JSON.stringify(norm(w))) return false;
  }
  return true;
}

class Waiter {
  constructor() { this.items = []; this.waiters = []; }
  push(x) { this.items.push(x); this.poke(); }
  poke() {
    for (const w of [...this.waiters]) {
      const i = this.items.findIndex(w.pred);
      if (i >= 0) { const [x] = this.items.splice(i, 1); this.waiters = this.waiters.filter((y) => y !== w); clearTimeout(w.timer); w.resolve(x); }
    }
  }
  wait(pred, timeout, what) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, timer: setTimeout(() => { this.waiters = this.waiters.filter((y) => y !== w); reject(new Error(`timeout (${timeout} ms) waiting for ${what}`)); }, timeout) };
      this.waiters.push(w);
      this.poke();
    });
  }
}

// A scripted remote peer. Frames the library sends to it land in `inbox` (decoded); `send` delivers frames to the library.
export class Peer {
  constructor(sess, id) { this.s = sess; this.id = id; this.box = new Waiter(); this.all = []; }
  get inbox() { return this.box.items; }
  deliver(channel, bytes) {
    let msg;
    if (bytes.length > MAX_FRAME) { this.s.violations.push(`library sent a ${bytes.length}-byte frame to peer ${this.id} (limit ${MAX_FRAME})`); return; }
    try { msg = decode(bytes); } catch (e) {
      if (e instanceof CodecError) { this.s.violations.push(`library sent an undecodable frame to peer ${this.id} on ${channel}: ${e.message} [${hex(bytes).slice(0, 60)}]`); return; }
      throw e;
    }
    msg._ch = channel; msg._n = ++this.s.seq; msg._t = Date.now();
    this.all.push(msg);
    this.box.push(msg);
  }
  // Encode (if a message object) and hand to the library as if received on `channel` from this peer.
  async send(msg, channel = 'reliable') {
    const bytes = msg instanceof Uint8Array ? msg : encode(msg);
    await this.s.adapter.call('recv', { from: this.id, channel, hex: hex(bytes) });
  }
  // First queued message of `type` matching `where`; waits up to timeout. Others stay queued.
  wait(type, where = {}, timeout = 3000) {
    return this.box.wait((m) => m.type === type && matches(m, where), timeout, `${type} ${JSON.stringify(norm(where))} from the library to peer ${this.id}`);
  }
  waitFor(pred, timeout = 3000, what = 'a message') { return this.box.wait(pred, timeout, `${what} to peer ${this.id}`); }
  take(type, where = {}) { const out = this.box.items.filter((m) => m.type === type && matches(m, where)); this.box.items = this.box.items.filter((m) => !out.includes(m)); return out; }
  async none(type, where = {}, ms = 300) {
    await sleep(ms);
    const m = this.box.items.find((x) => x.type === type && matches(x, where));
    if (m) throw new Error(`peer ${this.id}: unexpected ${type} ${JSON.stringify(norm(m), (k, v) => (k.startsWith('_') ? undefined : v)).slice(0, 200)}`);
  }
  // Collect messages of `type` for ms milliseconds (removes them from the inbox).
  async collect(type, ms) { await sleep(ms); return this.take(type); }
}

export class Session {
  constructor(adapter, opts = {}) {
    this.adapter = adapter; this.opts = opts; this.peers = new Map(); this.events = new Waiter(); this.violations = []; this.seq = 0; this.closed = new Set();
    adapter.onevent = (e) => this.onEvent(e);
  }
  peer(id) { if (!this.peers.has(id)) this.peers.set(id, new Peer(this, id)); return this.peers.get(id); }
  onEvent(e) {
    if (e.ev === 'send') return this.peer(e.to).deliver(e.channel, unhex(e.hex));
    if (e.ev === 'close') { this.closed.add(e.peerId); return; }
    e._n = ++this.seq; e._t = Date.now();
    this.events.push(e);
  }
  call(op, args = {}) { return this.adapter.call(op, args); }
  start(p) { return this.call('start', p); }
  link(id) { return this.call('link_open', { peerId: id }); }
  unlink(id) { return this.call('link_close', { peerId: id }); }
  waitEvent(name, where = {}, timeout = 3000) {
    return this.events.wait((e) => e.ev === name && matches(e, where), timeout, `event ${name} ${JSON.stringify(norm(where))}`);
  }
  async noEvent(name, where = {}, ms = 300) {
    await sleep(ms);
    const e = this.events.items.find((x) => x.ev === name && matches(x, where));
    if (e) throw new Error(`unexpected event ${name}: ${JSON.stringify(e)}`);
  }
  takeEvents(name) { const out = this.events.items.filter((e) => e.ev === name); this.events.items = this.events.items.filter((e) => e.ev !== name); return out; }
}
