// Test client for the signaling protocol: strict-order message queue + schema validation of everything the server sends.
import WebSocket from 'ws';
import { validateServer } from '../lib/schema.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Client {
  static connect(url, label = 'c') {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      const c = new Client(ws, label);
      const t = setTimeout(() => { ws.terminate(); reject(new Error(`connect timeout ${url}`)); }, 5000);
      ws.once('open', () => { clearTimeout(t); resolve(c); });
      ws.once('error', (e) => { clearTimeout(t); reject(new Error(`connect failed ${url}: ${e.message}`)); });
    });
  }

  constructor(ws, label) {
    this.ws = ws; this.label = label; this.queue = []; this.waiters = []; this.violations = []; this.log = [];
    this.closed = null; this.inLobby = false; this.info = null;
    ws.on('message', (data, isBinary) => {
      if (isBinary) { this.violations.push('server sent a binary frame'); return; }
      let m;
      try { m = JSON.parse(data.toString()); } catch { this.violations.push(`server sent invalid JSON: ${String(data).slice(0, 80)}`); return; }
      const errs = validateServer(m);
      if (errs.length) this.violations.push(`${m?.t}: ${errs.join('; ')}`);
      this.log.push(['<-', m]);
      if (m.t === 'lobby') this.inLobby = true;
      this.queue.push(m);
      this.pump();
    });
    ws.on('close', (code) => { this.closed = code; this.pump(); });
    ws.on('error', () => {});
  }

  pump() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (this.queue.length) { this.waiters.shift(); clearTimeout(w.timer); w.resolve(this.queue.shift()); }
      else if (this.closed !== null && w.rejectOnClose) { this.waiters.shift(); clearTimeout(w.timer); w.reject(new Error(`${this.label}: socket closed (${this.closed}) while waiting for ${w.what}`)); }
      else break;
    }
  }

  send(obj) { this.log.push(['->', obj]); this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
  sendRaw(data) { this.ws.send(data); }

  // Next message, whatever it is.
  nextAny(timeout = 2500, what = 'a message') {
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, what, rejectOnClose: true, timer: setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`${this.label}: timeout waiting for ${what}`));
      }, timeout) };
      this.waiters.push(w);
      this.pump();
    });
  }

  // Next message must have type t (strict order) and match `where` (object of expected field values).
  async next(t, where = {}, timeout = 2500) {
    const m = await this.nextAny(timeout, `${t}${Object.keys(where).length ? ' ' + JSON.stringify(where) : ''}`);
    if (m.t !== t) throw new Error(`${this.label}: expected ${t}, got ${JSON.stringify(m)}`);
    for (const [k, v] of Object.entries(where)) {
      if (JSON.stringify(m[k]) !== JSON.stringify(v)) throw new Error(`${this.label}: ${t}.${k} expected ${JSON.stringify(v)}, got ${JSON.stringify(m[k])} in ${JSON.stringify(m)}`);
    }
    return m;
  }

  // Next message must be error with the given code. Returns it.
  async nextError(code, timeout = 2500) {
    const m = await this.nextAny(timeout, `error ${code}`);
    if (m.t !== 'error' || m.code !== code) throw new Error(`${this.label}: expected error ${code}, got ${JSON.stringify(m)}`);
    return m;
  }

  async call(msg, t, where) { this.send(msg); return this.next(t, where); }
  async callError(msg, code) { this.send(msg); return this.nextError(code); }

  async expectSilence(ms = 300) {
    await sleep(ms);
    if (this.queue.length) throw new Error(`${this.label}: expected silence, got ${JSON.stringify(this.queue[0])}`);
  }

  // Wait for socket close; resolves with the close code.
  async waitClosed(timeout = 3000) {
    const t0 = Date.now();
    while (this.closed === null) { if (Date.now() - t0 > timeout) throw new Error(`${this.label}: socket not closed after ${timeout} ms`); await sleep(20); }
    return this.closed;
  }

  drain() { const q = this.queue; this.queue = []; return q; }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
  kill() { try { this.ws.terminate(); } catch { /* ignore */ } }
}
