// A small reference implementation of the peer side (host and joiner) of the data-channel protocol, written from
// spec/binary.md + spec/demo-game.md. It is the "library under test" for the harness self-test, and an executable
// reading of the rules. Not production code: no WebRTC, the transport is whatever the adapter wires up.
import { deflateSync, inflateSync } from 'node:zlib';
import { encode, decode, chunkPayload, Reassembler, CodecError, hex, unhex, MAX_FRAME } from '../../../spec/reference/codec.mjs';
import { Gridpaint, paintCmd } from '../../../spec/reference/gridpaint.mjs';

const STRIP = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const big = (n) => BigInt(n);

export class MockNode {
  // io: { send(to, channel, bytes), emit(eventObject) }
  constructor(io) {
    this.io = io; this.links = new Set(); this.timers = [];
    this.chunkSeq = 1; this.clientChatId = 1; this.voiceSeq = 0; this.cmdSeq = 1; this.pingN = 0;
  }

  // -------------------------------------------------------------- lifecycle
  start(p) {
    this.role = p.role; this.code = p.code; this.id = p.peerId; this.hostId = p.hostId; this.roster = new Set(p.peers ?? [p.peerId, p.hostId]);
    this.tickRate = p.tickRate ?? 20; this.hashEvery = p.hashEvery ?? this.tickRate; this.mode = p.mode ?? 'lockstep'; this.chunkSize = p.chunkSize ?? 16000;
    this.game = new Gridpaint(p.code); this.started = this.role === 'host'; this.hashes = new Map(); this.frames = new Map(); this.epoch = 0;
    this.re = new Reassembler(); this.pendingSnap = null; this.lastFrameAt = Date.now(); this.lastSnapReq = 0; this.resyncs = new Map();
    this.joined = new Map(); // host side: peerId -> {live}
    this.queue = []; this.arrival = 0; this.chatBucket = new Map(); this.chatLog = []; this.chatId = 0; this.muted = new Set(); this.voiceWin = new Map(); this.speakers = new Map();
    this.hostTimer = null; this.lost = false;
    this.timers.push(setInterval(() => this.watchdog(), 100));
    if (this.role === 'host') this.hostMode = true;
  }
  stop() { for (const t of this.timers) clearInterval(t); clearInterval(this.hostTimer); this.timers = []; }
  begin() {
    clearInterval(this.hostTimer);
    const t0 = Date.now(); let emitted = 0; const period = 1000 / this.tickRate;
    this.hostTimer = setInterval(() => { const due = Math.floor((Date.now() - t0) / period); while (emitted < due) { emitted++; this.emitFrame(); } }, 4);
  }

  tx(to, channel, msg) { const b = msg instanceof Uint8Array ? msg : encode(msg); this.io.send(to, channel, b); }

  linkOpen(peerId) {
    this.links.add(peerId);
    if (this.role === 'joiner' && peerId === this.hostId) this.tx(peerId, 'reliable', { type: 'hi', route: 0, proto: 1, peerId: this.id, lastTick: this.started ? big(this.game.tick) : -1n });
    if (this.claiming && this.claimTargets?.has(peerId)) this.tx(peerId, 'reliable', { type: 'host_claim', route: 0, epoch: this.epoch, hostId: this.id, tick: big(this.game.tick) });
    if (this.followId === peerId) this.tx(peerId, 'reliable', { type: 'hi', route: 0, proto: 1, peerId: this.id, lastTick: big(this.game.tick) });
  }
  linkClose(peerId) {
    this.links.delete(peerId); this.joined.delete(peerId);
    if (this.role === 'joiner' && peerId === this.hostId && !this.lost) this.hostLost();
  }

  // -------------------------------------------------------------- receive
  recv(from, channel, bytes) {
    let m;
    try { m = decode(bytes); } catch (e) { if (e instanceof CodecError) return; throw e; }
    try { this.dispatch(from, channel, m); } catch (e) { if (!(e instanceof CodecError)) throw e; }
  }
  dispatch(from, channel, m) {
    switch (m.type) {
      case 'unknown': return;
      case 'ping': return this.tx(from, channel === 'fast' ? 'fast' : channel, { type: 'pong', route: 0, n: m.n, t: m.t });
      case 'pong': return;
      case 'chunk': return this.onChunk(from, channel, m);
      case 'voice': if (channel !== 'voice') return; return this.hostMode ? this.hostVoice(from, m) : this.io.emit({ ev: 'voice', peerId: m.route, seq: m.seq, flags: m.flags, frames: m.packets.map((p) => hex(p.opus)) });
      case 'host_claim': return this.onClaim(from, m);
      default: return this.hostMode ? this.hostRecv(from, channel, m) : this.joinerRecv(from, channel, m);
    }
  }

  onChunk(from, channel, c) {
    if (this.pendingSnap && this.pendingSnap.from === from) {
      if (this.pendingSnap.id === null) this.pendingSnap.id = c.id;
      if (c.id === this.pendingSnap.id) {
        const done = this.re.feed(c);
        if (done) { const ps = this.pendingSnap; this.pendingSnap = null; this.applySnapshot(ps, done); }
        return;
      }
    }
    const done = this.re.feed(c);
    if (done) { try { this.dispatch(from, channel, decode(done)); } catch (e) { if (!(e instanceof CodecError)) throw e; } }
  }

  applySnapshot(ps, payload) {
    if (payload.length !== ps.total) { this.requestSnapshot(); return; }
    const raw = ps.flags & 1 ? inflateSync(payload) : payload;
    this.game = Gridpaint.restore(ps.tick, raw); this.started = true; this.lastFrameAt = Date.now();
    this.io.emit({ ev: 'snapshot_restored', tick: Number(ps.tick) });
  }

  // -------------------------------------------------------------- joiner
  joinerRecv(from, channel, m) {
    switch (m.type) {
      case 'welcome_dc':
        this.tickRate = m.tickRate; this.hostId = m.hostId; this.epoch = this.epoch;
        if (m.tick === 0n) this.started = true;
        return;
      case 'chat_history': return this.io.emit({ ev: 'chat_history', lines: m.lines.map((l) => ({ peerId: l.peerId, id: l.id, ts: Number(l.ts), text: l.text })) });
      case 'chat': return this.io.emit({ ev: 'chat', peerId: m.route, id: m.id, ts: Number(m.ts), text: m.text });
      case 'chat_reject': return this.io.emit({ ev: 'chat_rejected', id: m.id, reason: m.reason });
      case 'raw': return this.io.emit({ ev: 'raw', from: m.route, channel, hex: hex(m.bytes) });
      case 'desync': this.io.emit({ ev: 'desync', tick: Number(m.tick), hostHash: m.hostHash.toString(), yourHash: m.yourHash.toString() }); this.pendingSnap = null; return;
      case 'snapshot': this.pendingSnap = { from, tick: m.tick, total: m.total, flags: m.flags, id: null }; return;
      case 'frame': return this.onFrame(m);
      default:
    }
  }
  onFrame(m) {
    if (!this.started) return;
    this.lastFrameAt = Date.now();
    const t = Number(m.tick);
    if (t <= this.game.tick) return;
    if (t > this.game.tick + 1) return this.requestSnapshot();
    this.frames.set(t, m);
    this.game.step(t, m.cmds.map((c) => ({ peerId: c.peerId, bytes: c.bytes })));
    this.hashes.set(t, this.game.hash());
    if (t % this.hashEvery === 0) this.tx(this.hostId, 'reliable', { type: 'hash', route: 0, tick: big(t), hash: this.game.hash() });
  }
  requestSnapshot() {
    const now = Date.now();
    if (now - this.lastSnapReq < 1000) return;
    this.lastSnapReq = now; this.lastFrameAt = now;
    this.tx(this.hostId, 'reliable', { type: 'snapshot_req', route: 0, sinceTick: big(this.started ? this.game.tick : -1) });
  }
  watchdog() {
    if (this.role === 'joiner' && !this.hostMode && this.started && this.links.has(this.hostId) && Date.now() - this.lastFrameAt > 3000) this.requestSnapshot();
  }

  // -------------------------------------------------------------- migration
  hostLost() {
    this.lost = true;
    const others = [...this.roster].filter((p) => p !== this.hostId).sort((a, b) => a - b);
    const lowest = others[0];
    this.roster.delete(this.hostId);
    if (lowest === this.id) {
      this.epoch += 1; this.claiming = true; this.claimTargets = new Set(others.filter((p) => p !== this.id));
      for (const p of this.claimTargets) this.io.emit({ ev: 'dial', peerId: p });
      this.becomeHost();
    }
  }
  onClaim(from, m) {
    const better = m.epoch > this.epoch || (m.epoch === this.epoch && m.hostId < (this.hostMode ? this.id : this.hostId));
    if (!better) return;
    if (this.hostMode && this.role === 'joiner') { clearInterval(this.hostTimer); this.hostMode = false; this.claiming = false; }
    this.epoch = m.epoch; this.hostId = m.hostId; this.lost = true; this.followId = m.hostId;
    this.io.emit({ ev: 'host_changed', hostId: m.hostId, epoch: m.epoch });
    if (this.links.has(m.hostId)) this.linkOpen(m.hostId); else this.io.emit({ ev: 'dial', peerId: m.hostId });
  }
  becomeHost() {
    this.hostMode = true; this.hostId = this.id; this.started = true;
    this.io.emit({ ev: 'host_changed', hostId: this.id, epoch: this.epoch });
    this.begin();
  }

  // -------------------------------------------------------------- host
  emitFrame() {
    const tick = this.game.tick + 1;
    const cmds = this.queue.splice(0).sort((a, b) => a.peerId - b.peerId || a.n - b.n).map((c) => ({ peerId: c.peerId, bytes: c.bytes }));
    this.game.step(tick, cmds);
    const f = { type: 'frame', route: 0, tick: big(tick), cmds };
    this.frames.set(tick, f); this.frames.delete(tick - 3000);
    this.hashes.set(tick, this.game.hash()); this.hashes.delete(tick - 3000);
    for (const [p, st] of this.joined) if (st.live) this.tx(p, 'reliable', f);
  }
  sendSnapshot(to) {
    const raw = this.game.snapshot();
    const flags = 1, payload = deflateSync(raw);
    this.tx(to, 'reliable', { type: 'snapshot', route: 0, tick: big(this.game.tick), total: payload.length, flags });
    for (const c of chunkPayload(this.chunkSeq++, payload, this.chunkSize)) this.tx(to, 'reliable', c);
  }
  hostRecv(from, channel, m) {
    switch (m.type) {
      case 'hi': {
        this.roster.add(from);
        this.joined.set(from, { live: false });
        this.tx(from, 'reliable', { type: 'welcome_dc', route: 0, tick: big(this.game.tick), tickRate: this.tickRate, mode: this.mode === 'raw' ? 2 : 1, hostId: this.id });
        this.tx(from, 'reliable', { type: 'chat_history', route: 0, lines: this.chatLog.slice(-100) });
        if (this.mode === 'lockstep') {
          const last = Number(m.lastTick);
          if (this.game.tick > 0 && last < 0) this.sendSnapshot(from);
          else if (last >= 0 && last < this.game.tick) {
            let ok = true;
            for (let t = last + 1; t <= this.game.tick; t++) if (!this.frames.has(t)) ok = false;
            if (ok) for (let t = last + 1; t <= this.game.tick; t++) this.tx(from, 'reliable', this.frames.get(t));
            else this.sendSnapshot(from);
          }
        }
        this.joined.get(from).live = true;
        return;
      }
      case 'cmd': this.queue.push({ peerId: from, bytes: m.bytes, n: this.arrival++ }); return;
      case 'hash': {
        const mine = this.hashes.get(Number(m.tick));
        if (mine === undefined || mine === m.hash) return;
        const n = (this.resyncs.get(from) ?? 0) + 1; this.resyncs.set(from, n);
        if (n >= 3) { this.io.emit({ ev: 'peer_dropped', peerId: from, reason: 'desync' }); this.io.emit({ ev: 'close', peerId: from }); this.joined.delete(from); return; }
        this.tx(from, 'reliable', { type: 'desync', route: 0, tick: m.tick, hostHash: mine, yourHash: m.hash });
        this.sendSnapshot(from);
        return;
      }
      case 'snapshot_req': this.sendSnapshot(from); return;
      case 'chat': return this.hostChat(from, m);
      case 'raw': {
        const out = { type: 'raw', route: from, bytes: m.bytes };
        if (m.route === 0) { for (const p of this.joined.keys()) if (p !== from) this.tx(p, channel, out); this.io.emit({ ev: 'raw', from, channel, hex: hex(m.bytes) }); }
        else if (m.route === this.id) this.io.emit({ ev: 'raw', from, channel, hex: hex(m.bytes) });
        else if (this.joined.has(m.route)) this.tx(m.route, channel, out);
        return;
      }
      default:
    }
  }
  hostChat(from, m) {
    const reject = (reason) => this.tx(from, 'reliable', { type: 'chat_reject', route: 0, id: m.id, reason });
    if (this.muted.has(from)) return reject(3);
    if (new TextEncoder().encode(m.text).length > 256) return reject(2);
    const now = Date.now();
    const b = this.chatBucket.get(from) ?? { tokens: 3, at: now };
    b.tokens = Math.min(3, b.tokens + (now - b.at) / 1000); b.at = now;
    if (b.tokens < 1) { this.chatBucket.set(from, b); return reject(1); }
    b.tokens -= 1; this.chatBucket.set(from, b);
    const text = m.text.replace(STRIP, '');
    if (!text) return;
    this.postChat(from, text);
  }
  postChat(from, text) {
    const line = { peerId: from, id: ++this.chatId, ts: big(Date.now()), text };
    this.chatLog.push(line);
    for (const p of this.joined.keys()) this.tx(p, 'reliable', { type: 'chat', route: from, id: line.id, ts: line.ts, text });
    if (from === this.id) this.io.emit({ ev: 'chat', peerId: from, id: line.id, ts: Number(line.ts), text });
    else this.io.emit({ ev: 'chat', peerId: from, id: line.id, ts: Number(line.ts), text });
  }
  hostVoice(from, m) {
    const now = Date.now();
    if (encode(m).length > 1024) return;
    const win = (this.voiceWin.get(from) ?? []).filter((t) => now - t < 1000);
    if (win.length >= 30) return;
    win.push(now); this.voiceWin.set(from, win);
    for (const [p, last] of this.speakers) if (now - last > 500) this.speakers.delete(p);
    if (!this.speakers.has(from) && this.speakers.size >= 8) return;
    this.speakers.set(from, now);
    if (m.flags & 1) this.speakers.delete(from);
    for (const p of this.joined.keys()) if (p !== from) this.tx(p, 'voice', { ...m, route: from });
    this.io.emit({ ev: 'voice', peerId: from, seq: m.seq, flags: m.flags, frames: m.packets.map((q) => hex(q.opus)) });
  }

  // -------------------------------------------------------------- game-facing ops
  command(x, y) {
    const bytes = paintCmd(x, y);
    if (this.hostMode) this.queue.push({ peerId: this.id, bytes, n: this.arrival++ });
    else this.tx(this.hostId, 'reliable', { type: 'cmd', route: 0, seq: this.cmdSeq++, bytes });
  }
  chatSend(text) {
    if (this.hostMode) return this.hostChat(this.id, { id: this.clientChatId++, text });
    this.tx(this.hostId, 'reliable', { type: 'chat', route: 0, id: this.clientChatId++, ts: 0n, text });
  }
  hostMute(peerId, on) { if (on) this.muted.add(peerId); else this.muted.delete(peerId); }
  voiceSend(frames, end) {
    const m = { type: 'voice', route: 0, seq: this.voiceSeq, flags: end ? 1 : 0, packets: frames.map((f) => ({ opus: unhex(f) })) };
    this.voiceSeq = (this.voiceSeq + 1) & 0xffff;
    if (this.hostMode) { for (const p of this.joined.keys()) this.tx(p, 'voice', { ...m, route: this.id }); } else this.tx(this.hostId, 'voice', m);
  }
  rawSend(to, bytes, channel) {
    if (this.hostMode) { if (to === 0) for (const p of this.joined.keys()) this.tx(p, channel, { type: 'raw', route: this.id, bytes }); else this.tx(to, channel, { type: 'raw', route: this.id, bytes }); }
    else this.tx(this.hostId, channel, { type: 'raw', route: to, bytes });
  }
  hashAt(tick) { const h = this.hashes.get(tick); return h === undefined ? null : h.toString(); }
  state() { return { tick: this.game.tick, hash: this.game.hash().toString(), started: this.started, hostMode: !!this.hostMode, hostId: this.hostId, epoch: this.epoch }; }
}
