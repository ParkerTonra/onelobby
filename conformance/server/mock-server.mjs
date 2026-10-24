// A compact in-memory reference keepalive-server, written from spec/signaling.md. It exists to prove the harness is
// self-consistent (conformance/server self-test) and as a readable executable version of the rules. Not production code.
//   node conformance/server/mock-server.mjs [port] [--scale=N]
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { normalize, ALPHABET } from '../../spec/reference/codes.mjs';

const STRIP = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const MAX_MSG = 16384;

export function startMock({ port = 0, scale = 1, allowedGameIds = null, maxLobbies = Infinity } = {}) {
  const lobbies = new Map();
  const tokens = new Map();
  const windows = new Map(); // key -> timestamps
  const lim = { create: 10 * scale, join: 60 * scale, signal: 20 * scale, open: 8 * scale };
  let connSeq = 0;

  const hit = (key, max, winMs) => {
    const now = Date.now();
    const a = (windows.get(key) ?? []).filter((t) => now - t < winMs);
    if (a.length >= max) { windows.set(key, a); return Math.max(1, winMs - (now - a[0])); }
    a.push(now); windows.set(key, a); return 0;
  };

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); } else { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG, perMessageDeflate: false });

  const sendTo = (conn, m) => { if (conn?.ws.readyState === 1) conn.ws.send(JSON.stringify(m)); };
  const err = (conn, code, msg, data) => sendTo(conn, { t: 'error', code, msg, ...(data ? { data } : {}) });
  const connected = (l) => [...l.peers.values()].filter((p) => p.conn);
  const everyone = (l, m, except = null) => { for (const p of connected(l)) if (p.peerId !== except) sendTo(p.conn, m); };
  const lobbyMsg = (l, p) => ({ t: 'lobby', code: l.code, gameId: l.gameId, netVersion: l.netVersion, hostId: l.hostId, you: p.peerId, mode: l.mode,
    tickRate: l.tickRate, lateJoin: l.lateJoin, phase: l.phase, meta: l.meta, name: l.name, maxPlayers: l.maxPlayers, visibility: l.visibility, relayOnly: l.relayOnly,
    peers: connected(l).map((q) => ({ peerId: q.peerId, name: q.name, joinedAt: q.joinedAt })), resumeToken: p.token });
  const broadcastLobby = (l) => { for (const p of connected(l)) sendTo(p.conn, lobbyMsg(l, p)); };
  const newToken = (l, p) => { if (p.token) tokens.delete(p.token); p.token = randomBytes(12).toString('hex'); tokens.set(p.token, { code: l.code, peerId: p.peerId }); };
  const maybeClose = (l) => { if (!connected(l).length && ![...l.peers.values()].some((p) => p.reservedUntil) && !l.pending.size) lobbies.delete(l.code); };
  const sanitize = (s, n) => [...String(s).replace(STRIP, '')].slice(0, n).join('');

  function removePeer(l, p, reason, reserve = false) {
    l.peers.delete(p.peerId);
    if (p.conn) { p.conn.lobby = null; p.conn.peerId = null; }
    if (reserve) {
      p.conn = null; p.reservedUntil = Date.now() + 60_000; l.peers.set(p.peerId, p);
      setTimeout(() => { const q = l.peers.get(p.peerId); if (q && !q.conn && q.reservedUntil) { l.peers.delete(p.peerId); tokens.delete(q.token); maybeClose(l); } }, 60_000).unref();
    } else if (p.token) tokens.delete(p.token);
    everyone(l, { t: 'peer_left', peerId: p.peerId, reason });
    if (p.peerId === l.hostId) {
      const next = connected(l).map((q) => q.peerId).sort((a, b) => a - b)[0];
      if (next) { l.hostId = next; l.epoch++; everyone(l, { t: 'host_changed', hostId: next, epoch: l.epoch }); }
    }
    maybeClose(l);
  }

  function addPeer(l, conn, name, id, joinedAt = Date.now()) {
    const p = { peerId: id, name, joinedAt, conn, token: null };
    newToken(l, p); l.peers.set(id, p); conn.lobby = l.code; conn.peerId = id;
    return p;
  }

  function genCode() {
    for (;;) { let c = ''; const b = randomBytes(6); for (let i = 0; i < 6; i++) c += ALPHABET[b[i] & 31]; if (!lobbies.has(c)) return c; }
  }

  const validMeta = (m) => m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length <= 16 &&
    Object.entries(m).every(([k, v]) => [...k].length <= 64 && typeof v === 'string' && [...v].length <= 64);
  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

  function handle(conn, m) {
    const bad = (msg, field) => err(conn, 'bad_request', msg, field ? { field } : undefined);
    if (m.t === 'ping') { if (!conn.hello) return bad('hello first'); return sendTo(conn, { t: 'pong', n: m.n }); }
    if (m.t === 'hello') {
      if (conn.hello) return bad('second hello');
      if (m.proto !== 'lk1') { err(conn, 'bad_request', 'unsupported proto', { supported: ['lk1'] }); return conn.ws.close(); }
      if (typeof m.gameId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(m.gameId)) return bad('gameId', 'gameId');
      if (typeof m.netVersion !== 'string' || !m.netVersion || m.netVersion.length > 32) return bad('netVersion', 'netVersion');
      if (!m.client || typeof m.client !== 'object' || typeof m.name !== 'string') return bad('client/name');
      if (allowedGameIds && !allowedGameIds.includes(m.gameId)) { err(conn, 'game_not_allowed', 'game not allowed'); return conn.ws.close(); }
      conn.hello = { gameId: m.gameId, netVersion: m.netVersion, name: sanitize(m.name, 24) };
      const tk = typeof m.resumeToken === 'string' ? tokens.get(m.resumeToken) : null;
      const l = tk && lobbies.get(tk.code);
      const slot = l?.peers.get(tk.peerId);
      const ice = [{ urls: ['stun:localhost:3478'] }];
      if (l && slot && !slot.conn && slot.reservedUntil && l.gameId === m.gameId) {
        sendTo(conn, { t: 'welcome', peerId: tk.peerId, ice, serverTime: Date.now(), limits: { maxMsg: MAX_MSG, maxPlayers: 64 } });
        tokens.delete(m.resumeToken); l.peers.delete(slot.peerId);
        const p = addPeer(l, conn, conn.hello.name, slot.peerId, slot.joinedAt);
        sendTo(conn, lobbyMsg(l, p)); everyone(l, { t: 'peer_joined', peer: { peerId: p.peerId, name: p.name } }, p.peerId);
        return;
      }
      return sendTo(conn, { t: 'welcome', ice, serverTime: Date.now(), limits: { maxMsg: MAX_MSG, maxPlayers: 64 } });
    }
    if (!conn.hello) return bad('hello first');
    const l = conn.lobby ? lobbies.get(conn.lobby) : null;
    const me = l?.peers.get(conn.peerId);
    const needHost = () => { if (!l || l.hostId !== me.peerId) { err(conn, 'not_host', 'host only'); return false; } return true; };
    switch (m.t) {
      case 'create': {
        if (l) return bad('already in a lobby');
        const wait = hit(`create:${conn.ip}`, lim.create, 60_000);
        if (wait) return err(conn, 'rate_limited', 'too many creates', { retryAfterMs: wait });
        if ([...lobbies.values()].filter((x) => x.ip === conn.ip).length >= lim.open) return err(conn, 'rate_limited', 'too many open lobbies', { retryAfterMs: 5000, reason: 'max_lobbies' });
        if (lobbies.size >= maxLobbies) return err(conn, 'server_full', 'server full');
        if (typeof m.name !== 'string') return bad('name', 'name');
        if (!isInt(m.maxPlayers, 2, 64)) return bad('maxPlayers', 'maxPlayers');
        if (!['public', 'unlisted', 'private'].includes(m.visibility)) return bad('visibility', 'visibility');
        if (!['lockstep', 'raw'].includes(m.mode)) return bad('mode', 'mode');
        if (!isInt(m.tickRate, 1, 255)) return bad('tickRate', 'tickRate');
        if (typeof m.lateJoin !== 'boolean') return bad('lateJoin', 'lateJoin');
        if (!validMeta(m.meta)) return bad('meta', 'meta');
        const nl = { code: genCode(), ip: conn.ip, gameId: conn.hello.gameId, netVersion: conn.hello.netVersion, name: sanitize(m.name, 48), maxPlayers: m.maxPlayers,
          visibility: m.visibility, mode: m.mode, tickRate: m.tickRate, lateJoin: m.lateJoin, relayOnly: m.relayOnly === true, meta: { ...m.meta }, phase: 'lobby', hostId: 1, epoch: 0,
          peers: new Map(), pending: new Map(), kicked: new Set(), nextId: 2, createdAt: Date.now() };
        lobbies.set(nl.code, nl);
        const p = addPeer(nl, conn, conn.hello.name, 1);
        return sendTo(conn, lobbyMsg(nl, p));
      }
      case 'join': {
        if (l) return bad('already in a lobby');
        const wait = hit(`join:${conn.ip}`, lim.join, 60_000);
        if (wait) return err(conn, 'rate_limited', 'too many joins', { retryAfterMs: wait });
        if (typeof m.code !== 'string') return bad('code', 'code');
        const code = normalize(m.code);
        if (!code) return bad('malformed code', 'code');
        const t = lobbies.get(code);
        if (!t || t.gameId !== conn.hello.gameId) return err(conn, 'unknown_code', 'no such lobby');
        if (t.netVersion !== conn.hello.netVersion) return err(conn, 'version_mismatch', 'netVersion differs', { hostNetVersion: t.netVersion, yourNetVersion: conn.hello.netVersion });
        if (t.kicked.has(conn.id)) return err(conn, 'kicked', 'kicked from this lobby');
        if (t.phase === 'in_game' && !t.lateJoin) return err(conn, 'in_game', 'game already running');
        if (t.peers.size + t.pending.size >= t.maxPlayers) return err(conn, 'lobby_full', 'lobby full');
        const id = t.nextId++;
        if (t.visibility === 'private') {
          t.pending.set(id, { conn, name: conn.hello.name });
          const host = t.peers.get(t.hostId); sendTo(host.conn, { t: 'join_request', peer: { peerId: id, name: conn.hello.name } });
          conn.pendingIn = { code, id };
          return;
        }
        const p = addPeer(t, conn, conn.hello.name, id);
        sendTo(conn, lobbyMsg(t, p)); everyone(t, { t: 'peer_joined', peer: { peerId: id, name: p.name } }, id);
        return;
      }
      case 'leave': if (l) removePeer(l, me, 'left'); return;
      case 'list': {
        if (m.visibility !== 'public') return bad('visibility', 'visibility');
        const limit = m.limit === undefined ? 50 : m.limit;
        if (!isInt(limit, 1, 100)) return bad('limit', 'limit');
        if (m.meta !== undefined && !validMeta(m.meta)) return bad('meta', 'meta');
        let items = [...lobbies.values()].filter((x) => x.gameId === conn.hello.gameId && x.netVersion === conn.hello.netVersion && x.visibility === 'public' &&
          (x.phase === 'lobby' || x.lateJoin) && Object.entries(m.meta ?? {}).every(([k, v]) => x.meta[k] === v));
        items.sort((a, b) => a.createdAt - b.createdAt || (a.code < b.code ? -1 : 1));
        const start = m.cursor ? Number(m.cursor) || 0 : 0;
        const page = items.slice(start, start + limit);
        const out = page.map((x) => ({ code: x.code, gameId: x.gameId, netVersion: x.netVersion, name: x.name, hostName: x.peers.get(x.hostId)?.name ?? '', players: x.peers.size,
          maxPlayers: x.maxPlayers, phase: x.phase, meta: x.meta, region: 'local', createdAt: x.createdAt }));
        return sendTo(conn, { t: 'lobbies', items: out, ...(start + limit < items.length ? { cursor: String(start + limit) } : {}) });
      }
      case 'signal': {
        if (!l) return bad('not in a lobby');
        const wait = hit(`signal:${conn.id}`, lim.signal, 1000);
        if (wait) return err(conn, 'rate_limited', 'too many signals', { retryAfterMs: wait });
        const target = l.peers.get(m.to);
        if (!Number.isInteger(m.to) || !target?.conn || m.to === me.peerId) return bad('to', 'to');
        if (!m.sdp && !m.ice) return bad('sdp or ice');
        return sendTo(target.conn, { t: 'signal', from: me.peerId, ...(m.sdp ? { sdp: m.sdp } : {}), ...(m.ice ? { ice: m.ice } : {}) });
      }
      case 'meta': {
        if (!l) return bad('not in a lobby'); if (!needHost()) return;
        if (!validMeta(m.meta)) return bad('meta', 'meta');
        l.meta = { ...m.meta }; return broadcastLobby(l);
      }
      case 'phase': {
        if (!l) return bad('not in a lobby'); if (!needHost()) return;
        if (!['lobby', 'in_game'].includes(m.phase)) return bad('phase', 'phase');
        l.phase = m.phase; return broadcastLobby(l);
      }
      case 'kick': {
        if (!l) return bad('not in a lobby'); if (!needHost()) return;
        const p = l.peers.get(m.peerId);
        if (!Number.isInteger(m.peerId) || !p || !p.conn || p.peerId === me.peerId) return bad('peerId', 'peerId');
        const kc = p.conn; l.kicked.add(kc.id); sendTo(kc, { t: 'error', code: 'kicked', msg: 'kicked' });
        return removePeer(l, p, 'kicked');
      }
      case 'approve': {
        if (!l) return bad('not in a lobby'); if (!needHost()) return;
        const pend = l.pending.get(m.peerId);
        if (!pend || typeof m.ok !== 'boolean') return bad('peerId', 'peerId');
        l.pending.delete(m.peerId); pend.conn.pendingIn = null;
        if (!m.ok) { err(pend.conn, 'kicked', 'join denied', { reason: 'denied' }); return maybeClose(l); }
        const p = addPeer(l, pend.conn, pend.name, m.peerId);
        sendTo(pend.conn, lobbyMsg(l, p)); return everyone(l, { t: 'peer_joined', peer: { peerId: p.peerId, name: p.name } }, p.peerId);
      }
      case 'host_changed': {
        if (!l) return; if (m.hostId !== me.peerId || !isInt(m.epoch, 1, 65535) || m.epoch <= l.epoch) return;
        l.hostId = m.hostId; l.epoch = m.epoch; return everyone(l, { t: 'host_changed', hostId: l.hostId, epoch: l.epoch });
      }
      default: // unknown type: ignored
    }
  }

  wss.on('connection', (ws, req) => {
    const conn = { ws, id: ++connSeq, hello: null, lobby: null, peerId: null, ip: req.socket.remoteAddress, last: Date.now() };
    ws.on('message', (data, isBinary) => {
      conn.last = Date.now();
      if (isBinary) return;
      let m;
      try { m = JSON.parse(data.toString()); } catch { return err(conn, 'bad_request', 'invalid JSON'); }
      if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return err(conn, 'bad_request', 'message must be an object with string t');
      try { handle(conn, m); } catch (e) { err(conn, 'bad_request', `internal: ${e.message}`); }
    });
    ws.on('close', () => {
      if (conn.pendingIn) { lobbies.get(conn.pendingIn.code)?.pending.delete(conn.pendingIn.id); }
      const l = conn.lobby ? lobbies.get(conn.lobby) : null;
      const me = l?.peers.get(conn.peerId);
      if (l && me) removePeer(l, me, 'timeout', true);
    });
    ws.on('error', () => {});
    conn.idle = setInterval(() => { if (Date.now() - conn.last > 30_000) ws.terminate(); }, 1000);
    ws.on('close', () => clearInterval(conn.idle));
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const p = server.address().port;
    resolve({ url: `ws://127.0.0.1:${p}/ws`, port: p, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => r()); }) });
  }));
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('server/mock-server.mjs')) {
  const port = Number(process.argv[2]?.match(/^\d+$/) ? process.argv[2] : 8080);
  const scale = Number(process.argv.find((a) => a.startsWith('--scale='))?.slice(8) ?? 1);
  const s = await startMock({ port, scale });
  console.log(`mock keepalive-server on ${s.url} (rate scale ${scale})`);
}
