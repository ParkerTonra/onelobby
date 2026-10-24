// conformance/server test suite. Behaviour source: DESIGN s.6, s.7, s.9, s.12 + spec/signaling.md (decisions).
import assert from 'node:assert/strict';
import { Client, sleep } from './client.mjs';
import { normalize, ALPHABET } from '../../spec/reference/codes.mjs';

const rid = () => Math.random().toString(36).slice(2, 8);

export class Ctx {
  constructor(opts) { this.opts = opts; this.clients = []; this.game = opts.gameId; this.netVersion = '1'; this.seq = 0; }
  uniqueGame() { return `${this.opts.gameId}-${rid()}`; }

  async raw(label = 'raw') {
    const c = await Client.connect(this.opts.url, `${label}${++this.seq}`);
    this.clients.push(c);
    return c;
  }

  // Connected + hello'd client. Returns the client; c.welcome holds the welcome message.
  async hello(o = {}) {
    const c = await this.raw(o.label ?? 'c');
    c.send({ t: 'hello', proto: 'lk1', gameId: o.gameId ?? this.game, netVersion: o.netVersion ?? this.netVersion,
      client: { lib: 'conformance', ver: '0', platform: 'node' }, name: o.name ?? `P${this.seq}`, ...(o.resumeToken ? { resumeToken: o.resumeToken } : {}), ...(o.extra ?? {}) });
    c.welcome = await c.next('welcome');
    return c;
  }

  createBody(o = {}) {
    return { t: 'create', name: 'conf lobby', maxPlayers: 4, visibility: 'unlisted', mode: 'lockstep', tickRate: 20, lateJoin: false, meta: {}, ...o };
  }

  // Host: hello + create. c.lobby = lobby message.
  async host(create = {}, helloOpts = {}) {
    const c = await this.hello({ label: 'host', ...helloOpts });
    c.lobby = await c.call(this.createBody(create), 'lobby');
    return c;
  }

  // Joiner: hello + join. If host given, consumes the host's peer_joined.
  async join(code, helloOpts = {}, host = null) {
    const c = await this.hello({ label: 'joiner', ...helloOpts });
    c.lobby = await c.call({ t: 'join', code }, 'lobby');
    if (host) await host.next('peer_joined', { peer: { peerId: c.lobby.you, name: helloOpts.name ?? c.lobby.peers.find((p) => p.peerId === c.lobby.you).name } });
    return c;
  }

  async cleanup() {
    const bad = [];
    for (const c of [...this.clients].reverse()) if (c.closed === null && c.inLobby) { try { c.send({ t: 'leave' }); } catch { /* closed */ } }
    await sleep(60);
    for (const c of this.clients) { bad.push(...c.violations.map((v) => `${c.label}: ${v}`)); c.close(); }
    await sleep(20);
    for (const c of this.clients) c.kill();
    this.clients = [];
    return bad;
  }
}

export function buildSuite(opts) {
  const tests = [];
  const T = (group, name, fn, o = {}) => tests.push({ group, name, fn, ...o });
  const lim = () => ({ rateCreate: 10, rateJoin: 60, rateSignal: 20, maxOpen: 8, ...opts.limits });

  // ------------------------------------------------------------------ health
  T('http', 'GET /healthz returns 200', async (t) => {
    const u = new URL(t.opts.url);
    const res = await fetch(`${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/healthz`);
    assert.equal(res.status, 200);
  }, { skip: () => opts.noHealth && '--no-health' });

  // ------------------------------------------------------------------ connection / hello
  T('hello', 'hello -> welcome with ice, serverTime, limits', async (t) => {
    const c = await t.hello();
    const w = c.welcome;
    assert.ok(Array.isArray(w.ice));
    assert.ok(Math.abs(w.serverTime - Date.now()) < 5 * 60_000, 'serverTime is unix ms and near now');
    assert.ok(w.limits.maxMsg >= 4096 && w.limits.maxPlayers >= 2);
    assert.equal(w.peerId, undefined, 'no peerId without a resumeToken');
    for (const s of w.ice) if (s.credential) assert.ok(s.username && /^\d+:[^:]+$/.test(s.username), `TURN username expiry:userId, got ${s.username}`);
  });
  T('hello', 'message before hello -> bad_request', async (t) => {
    const c = await t.raw();
    await c.callError({ t: 'list', visibility: 'public' }, 'bad_request');
    await c.callError(t.createBody(), 'bad_request');
  });
  T('hello', 'second hello -> bad_request', async (t) => {
    const c = await t.hello();
    await c.callError({ t: 'hello', proto: 'lk1', gameId: 'x', netVersion: '1', client: { lib: 'a', ver: '1', platform: 'n' }, name: 'n' }, 'bad_request');
  });
  T('hello', 'wrong proto -> bad_request (data.supported) ', async (t) => {
    const c = await t.raw();
    c.send({ t: 'hello', proto: 'lk9', gameId: 'x', netVersion: '1', client: { lib: 'a', ver: '1', platform: 'n' }, name: 'n' });
    const e = await c.nextError('bad_request');
    assert.deepEqual(e.data?.supported, ['lk1']);
  });
  T('hello', 'hello with missing/invalid fields -> bad_request', async (t) => {
    for (const bad of [{ gameId: undefined }, { netVersion: 3 }, { name: 5 }, { client: 'x' }]) {
      const c = await t.raw();
      c.send({ t: 'hello', proto: 'lk1', gameId: 'x', netVersion: '1', client: { lib: 'a', ver: '1', platform: 'n' }, name: 'n', ...bad });
      await c.nextError('bad_request');
    }
  });
  T('hello', 'player name: control chars stripped, truncated to 24', async (t) => {
    const h = await t.host({}, { name: `A\u0001B‮C${'x'.repeat(40)}` });
    const name = h.lobby.peers[0].name;
    assert.equal(name.slice(0, 3), 'ABC');
    assert.ok([...name].length <= 24, `name length ${[...name].length}`);
    assert.ok(!/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(name));
  });
  T('hello', 'ping -> pong echoes n', async (t) => {
    const c = await t.hello();
    for (const n of [0, 1, 123456789]) await c.call({ t: 'ping', n }, 'pong', { n });
  });
  T('robustness', 'invalid JSON / non-object / missing t -> bad_request, socket stays usable', async (t) => {
    const c = await t.hello();
    for (const bad of ['{not json', '[1,2]', '42', '{"x":1}', '{"t":5}']) {
      c.sendRaw(bad);
      await c.nextError('bad_request');
    }
    await c.call({ t: 'ping', n: 1 }, 'pong', { n: 1 });
  });
  T('robustness', 'unknown t and unknown fields are ignored', async (t) => {
    const c = await t.hello();
    c.send({ t: 'warp_drive', x: 1 });
    c.send({ t: 'ping', n: 7, extra: 'ignored' });
    await c.next('pong', { n: 7 });
    c.lobby = await c.call(t.createBody({ somethingNew: [1, 2, 3] }), 'lobby');
  });
  T('robustness', 'binary frames are ignored', async (t) => {
    const c = await t.hello();
    c.sendRaw(Buffer.from([1, 2, 3, 4]));
    c.send({ t: 'ping', n: 2 });
    await c.next('pong', { n: 2 });
  });
  T('robustness', 'frame larger than limits.maxMsg closes the socket or is a bad_request', async (t) => {
    const c = await t.hello();
    const big = JSON.stringify({ t: 'ping', n: 1, pad: 'x'.repeat(c.welcome.limits.maxMsg + 100) });
    c.sendRaw(big);
    const m = await Promise.race([c.nextAny(3000, 'error or close').catch(() => null), c.waitClosed(3000).then(() => 'closed').catch(() => null)]);
    assert.ok(m === 'closed' || m?.code === 'bad_request' || c.closed !== null, `expected close or bad_request, got ${JSON.stringify(m)}`);
  });
  T('robustness', 'a frame at 4 KiB still works (SDP-sized message)', async (t) => {
    const h = await t.host();
    const j = await t.join(h.lobby.code, {}, h);
    const sdp = { type: 'offer', sdp: 'v=0\r\n' + 'a=x:'.padEnd(4000, 'y') };
    h.send({ t: 'signal', to: j.lobby.you, sdp });
    const s = await j.next('signal');
    assert.equal(s.sdp.sdp, sdp.sdp);
  });

  // ------------------------------------------------------------------ create
  T('create', 'create -> lobby (host is peer 1, canonical code, resumeToken)', async (t) => {
    const h = await t.host({ name: 'My Lobby', maxPlayers: 5, visibility: 'public', mode: 'raw', tickRate: 30, lateJoin: true, meta: { map: 'x' } });
    const l = h.lobby;
    assert.equal(l.you, 1); assert.equal(l.hostId, 1);
    assert.match(l.code, /^[0-9A-HJKMNP-TV-Z]{6}$/);
    assert.equal(l.gameId, t.game); assert.equal(l.netVersion, '1');
    assert.equal(l.mode, 'raw'); assert.equal(l.tickRate, 30); assert.equal(l.lateJoin, true); assert.equal(l.phase, 'lobby');
    assert.deepEqual(l.meta, { map: 'x' });
    assert.equal(l.peers.length, 1); assert.equal(l.peers[0].peerId, 1);
    assert.ok(l.resumeToken.length > 0);
    assert.ok(Math.abs(l.peers[0].joinedAt - Date.now()) < 5 * 60_000);
  });
  T('create', 'codes of concurrent lobbies are distinct', async (t) => {
    const a = await t.host(); const b = await t.host(); const c = await t.host();
    assert.equal(new Set([a.lobby.code, b.lobby.code, c.lobby.code]).size, 3);
  });
  T('create', 'invalid create fields -> bad_request', async (t) => {
    const lim_ = (await t.hello()).welcome.limits;
    const cases = [{ maxPlayers: 1 }, { maxPlayers: lim_.maxPlayers + 1 }, { maxPlayers: 251 }, { maxPlayers: '4' }, { maxPlayers: 4.5 },
      { visibility: 'secret' }, { mode: 'turnbased' }, { tickRate: 0 }, { tickRate: 256 }, { tickRate: 'fast' }, { lateJoin: 'yes' },
      { meta: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])) }, { meta: { k: 'v'.repeat(65) } }, { meta: { ['k'.repeat(65)]: 'v' } }, { meta: { k: 5 } }, { meta: 'x' }, { name: 5 }];
    for (const bad of cases) {
      const c = await t.hello();
      c.send(t.createBody(bad));
      const e = await c.nextError('bad_request');
      assert.ok(e.msg.length > 0, `error msg present for ${JSON.stringify(bad)}`);
    }
  });
  T('create', 'meta at the limits (16 keys, 64 chars) is accepted', async (t) => {
    const meta = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`${'k'.repeat(60)}${String(i).padStart(4, '0')}`, 'v'.repeat(64)]));
    const h = await t.host({ meta });
    assert.deepEqual(h.lobby.meta, meta);
  });
  T('create', 'maxPlayers 2 and limits.maxPlayers are accepted', async (t) => {
    const a = await t.host({ maxPlayers: 2 });
    const b = await t.hello();
    const b2 = await b.call(t.createBody({ maxPlayers: b.welcome.limits.maxPlayers }), 'lobby');
    assert.ok(b2.code);
    assert.ok(a.lobby.code);
  });
  T('create', 'create while already in a lobby -> bad_request', async (t) => {
    const h = await t.host();
    await h.callError(t.createBody(), 'bad_request');
  });
  T('create', 'lobby name is sanitised and truncated to 48', async (t) => {
    const h = await t.host({ visibility: 'public', name: `L\u0007${'n'.repeat(80)}` });
    const l = await t.hello();
    const r = await l.call({ t: 'list', visibility: 'public' }, 'lobbies');
    const e = r.items.find((x) => x.code === h.lobby.code);
    assert.ok(e); assert.ok([...e.name].length <= 48); assert.ok(!e.name.includes('\u0007'));
  });

  // ------------------------------------------------------------------ join
  T('join', 'join -> lobby for joiner, peer_joined for host', async (t) => {
    const h = await t.host({ meta: { a: 'b' } });
    const j = await t.hello({ name: 'Jo' });
    j.lobby = await j.call({ t: 'join', code: h.lobby.code }, 'lobby');
    assert.equal(j.lobby.you, 2); assert.equal(j.lobby.hostId, 1); assert.equal(j.lobby.code, h.lobby.code);
    assert.deepEqual(j.lobby.peers.map((p) => p.peerId), [1, 2]);
    assert.equal(j.lobby.peers[1].name, 'Jo');
    assert.deepEqual(j.lobby.meta, { a: 'b' });
    assert.notEqual(j.lobby.resumeToken, h.lobby.resumeToken);
    const pj = await h.next('peer_joined');
    assert.deepEqual(pj.peer, { peerId: 2, name: 'Jo' });
    const k = await t.hello({ name: 'Ka' });
    k.lobby = await k.call({ t: 'join', code: h.lobby.code }, 'lobby');
    assert.equal(k.lobby.you, 3);
    assert.deepEqual((await h.next('peer_joined')).peer, { peerId: 3, name: 'Ka' });
    assert.deepEqual((await j.next('peer_joined')).peer, { peerId: 3, name: 'Ka' });
  });
  T('join', 'codes are case-insensitive and accept spaces and hyphens', async (t) => {
    const h = await t.host();
    const code = h.lobby.code;
    const variants = [code.toLowerCase(), `${code.slice(0, 3)} ${code.slice(3)}`, `${code.slice(0, 3)}-${code.slice(3).toLowerCase()}`, ` ${code} `];
    for (const v of variants) {
      const j = await t.hello();
      j.lobby = await j.call({ t: 'join', code: v }, 'lobby');
      assert.equal(j.lobby.code, code, `variant ${JSON.stringify(v)}`);
      await h.next('peer_joined');
      j.send({ t: 'leave' }); j.inLobby = false;
      await h.next('peer_left');
    }
  });
  T('join', 'I L O fold to 1 0 0 (OOOOOO is a well-formed unknown code), U is invalid', async (t) => {
    const c = await t.hello();
    for (const code of ['OOOOOO', 'oooooo', 'IIIIII', 'LLLLLL', 'IlLi1l']) await c.callError({ t: 'join', code }, 'unknown_code');
    for (const code of ['UUUUUU', 'ABCDEU']) await c.callError({ t: 'join', code }, 'bad_request');
  });
  T('join', 'malformed codes -> bad_request, well-formed absent code -> unknown_code', async (t) => {
    const c = await t.hello();
    for (const code of ['', 'ABC', 'ABCDEFG', 'AB!DEF', '12345', 'ABCD EF G']) await c.callError({ t: 'join', code }, 'bad_request');
    await c.callError({ t: 'join' }, 'bad_request');
    await c.callError({ t: 'join', code: 123456 }, 'bad_request');
    for (const code of ['ZZZZZZ', '999999', 'ABCDEF']) await c.callError({ t: 'join', code }, 'unknown_code');
  });
  T('join', 'join while already in a lobby -> bad_request', async (t) => {
    const h = await t.host(); const h2 = await t.host();
    await h2.callError({ t: 'join', code: h.lobby.code }, 'bad_request');
  });
  T('join', 'lobby_full', async (t) => {
    const h = await t.host({ maxPlayers: 2 });
    await t.join(h.lobby.code, {}, h);
    const x = await t.hello();
    await x.callError({ t: 'join', code: h.lobby.code }, 'lobby_full');
  });
  T('join', 'version_mismatch carries both versions', async (t) => {
    const h = await t.host();
    const x = await t.hello({ netVersion: '2' });
    const e = await x.callError({ t: 'join', code: h.lobby.code }, 'version_mismatch');
    assert.equal(e.data.hostNetVersion, '1'); assert.equal(e.data.yourNetVersion, '2');
  });
  T('join', 'a lobby of another gameId is unknown_code', async (t) => {
    const h = await t.host();
    const x = await t.hello({ gameId: t.uniqueGame() });
    await x.callError({ t: 'join', code: h.lobby.code }, 'unknown_code');
  });
  T('join', 'in_game without lateJoin -> in_game; with lateJoin -> joins', async (t) => {
    const h = await t.host({ lateJoin: false });
    h.send({ t: 'phase', phase: 'in_game' });
    const upd = await h.next('lobby');
    assert.equal(upd.phase, 'in_game'); assert.equal(upd.you, 1);
    const x = await t.hello();
    await x.callError({ t: 'join', code: h.lobby.code }, 'in_game');
    const h2 = await t.host({ lateJoin: true });
    h2.send({ t: 'phase', phase: 'in_game' }); await h2.next('lobby', { phase: 'in_game' });
    const y = await t.join(h2.lobby.code, {}, h2);
    assert.equal(y.lobby.phase, 'in_game');
  });
  T('join', 'peerIds are never reused inside a lobby', async (t) => {
    const h = await t.host();
    const a = await t.join(h.lobby.code, {}, h);
    assert.equal(a.lobby.you, 2);
    a.send({ t: 'leave' }); a.inLobby = false;
    await h.next('peer_left', { peerId: 2, reason: 'left' });
    const b = await t.join(h.lobby.code, {}, h);
    assert.equal(b.lobby.you, 3);
  });
  T('join', 'leave -> peer_left; the sender can create/join again', async (t) => {
    const h = await t.host();
    const j = await t.join(h.lobby.code, {}, h);
    j.send({ t: 'leave' }); j.inLobby = false;
    await h.next('peer_left', { peerId: 2, reason: 'left' });
    j.lobby = await j.call(t.createBody(), 'lobby');
    assert.notEqual(j.lobby.code, h.lobby.code);
  });
  T('join', 'host leaves -> peer_left then host_changed to lowest remaining peerId', async (t) => {
    const h = await t.host();
    const a = await t.join(h.lobby.code, {}, h);
    const b = await t.join(h.lobby.code, {}, h); await a.next('peer_joined');
    h.send({ t: 'leave' }); h.inLobby = false;
    for (const c of [a, b]) {
      await c.next('peer_left', { peerId: 1, reason: 'left' });
      const hc = await c.next('host_changed');
      assert.equal(hc.hostId, 2);
    }
    // new host has the powers
    a.send({ t: 'kick', peerId: 3 });
    await b.nextError('kicked');
    await a.next('peer_left', { peerId: 3, reason: 'kicked' });
  });
  T('join', 'lobby closes when the last peer leaves (code unknown afterwards)', async (t) => {
    const h = await t.host();
    h.send({ t: 'leave' }); h.inLobby = false;
    await sleep(100);
    const x = await t.hello();
    await x.callError({ t: 'join', code: h.lobby.code }, 'unknown_code');
  });

  // ------------------------------------------------------------------ host powers
  T('host', 'kick: kicked peer gets error kicked, others peer_left kicked, cannot rejoin', async (t) => {
    const h = await t.host();
    const a = await t.join(h.lobby.code, {}, h);
    const b = await t.join(h.lobby.code, {}, h); await a.next('peer_joined');
    h.send({ t: 'kick', peerId: 2 });
    await a.nextError('kicked');
    for (const c of [h, b]) await c.next('peer_left', { peerId: 2, reason: 'kicked' });
    a.inLobby = false;
    await a.callError({ t: 'join', code: h.lobby.code }, 'kicked');
  });
  T('host', 'host-only messages from a non-host -> not_host', async (t) => {
    const h = await t.host();
    const a = await t.join(h.lobby.code, {}, h);
    for (const m of [{ t: 'kick', peerId: 1 }, { t: 'meta', meta: {} }, { t: 'phase', phase: 'in_game' }, { t: 'approve', peerId: 5, ok: true }]) await a.callError(m, 'not_host');
    await h.expectSilence(150);
  });
  T('host', 'kick self / unknown peer, approve for a non-pending peer -> bad_request', async (t) => {
    const h = await t.host();
    await h.callError({ t: 'kick', peerId: 1 }, 'bad_request');
    await h.callError({ t: 'kick', peerId: 9 }, 'bad_request');
    await h.callError({ t: 'kick' }, 'bad_request');
    await h.callError({ t: 'approve', peerId: 9, ok: true }, 'bad_request');
  });
  T('host', 'meta: replaces metadata, every member gets a fresh lobby message', async (t) => {
    const h = await t.host({ meta: { a: '1' } });
    const j = await t.join(h.lobby.code, {}, h);
    h.send({ t: 'meta', meta: { b: '2' } });
    const lh = await h.next('lobby'); const lj = await j.next('lobby');
    assert.deepEqual(lh.meta, { b: '2' }); assert.deepEqual(lj.meta, { b: '2' });
    assert.equal(lh.you, 1); assert.equal(lj.you, 2);
    await h.callError({ t: 'meta', meta: { k: 'v'.repeat(65) } }, 'bad_request');
    await h.callError({ t: 'meta' }, 'bad_request');
  });
  T('host', 'phase: invalid value -> bad_request; valid is broadcast', async (t) => {
    const h = await t.host();
    const j = await t.join(h.lobby.code, {}, h);
    await h.callError({ t: 'phase', phase: 'paused' }, 'bad_request');
    h.send({ t: 'phase', phase: 'in_game' });
    assert.equal((await h.next('lobby')).phase, 'in_game'); assert.equal((await j.next('lobby')).phase, 'in_game');
    h.send({ t: 'phase', phase: 'lobby' });
    assert.equal((await h.next('lobby')).phase, 'lobby'); assert.equal((await j.next('lobby')).phase, 'lobby');
  });
  T('host', 'private lobby: join_request, nothing for the joiner until approve', async (t) => {
    const h = await t.host({ visibility: 'private' });
    const j = await t.hello({ name: 'Pri' });
    j.send({ t: 'join', code: h.lobby.code });
    const jr = await h.next('join_request');
    assert.equal(jr.peer.name, 'Pri'); assert.ok(jr.peer.peerId >= 2);
    await j.expectSilence(300);
    h.send({ t: 'approve', peerId: jr.peer.peerId, ok: true });
    j.lobby = await j.next('lobby');
    assert.equal(j.lobby.you, jr.peer.peerId);
    await h.next('peer_joined', { peer: { peerId: jr.peer.peerId, name: 'Pri' } });
  });
  T('host', 'private lobby: deny -> joiner gets error kicked (data.reason denied)', async (t) => {
    const h = await t.host({ visibility: 'private' });
    const j = await t.hello();
    j.send({ t: 'join', code: h.lobby.code });
    const jr = await h.next('join_request');
    h.send({ t: 'approve', peerId: jr.peer.peerId, ok: false });
    const e = await j.nextError('kicked');
    assert.equal(e.data?.reason, 'denied');
    await h.expectSilence(150);
  });
  T('host', 'host_changed from a member: epoch rule, only for yourself', async (t) => {
    const h = await t.host();
    const a = await t.join(h.lobby.code, {}, h);
    const b = await t.join(h.lobby.code, {}, h); await a.next('peer_joined');
    b.send({ t: 'host_changed', hostId: 2, epoch: 1 });  // not the claimant: ignored
    a.send({ t: 'host_changed', hostId: 2, epoch: 0 });  // epoch not greater: ignored
    await sleep(150);
    for (const c of [h, a, b]) await c.expectSilence(10);
    a.send({ t: 'host_changed', hostId: 2, epoch: 1 });
    for (const c of [h, a, b]) assert.deepEqual({ hostId: (await c.next('host_changed')).hostId }, { hostId: 2 });
    h.send({ t: 'kick', peerId: 3 });
    await h.nextError('not_host');
    a.send({ t: 'kick', peerId: 3 });
    await b.nextError('kicked');
  });

  // ------------------------------------------------------------------ list
  T('list', 'public lobbies are listed with all fields; unlisted/private are not', async (t) => {
    const g = t.uniqueGame();
    const pub = await t.host({ visibility: 'public', name: 'Pub', meta: { map: 'a' } }, { gameId: g, name: 'HostName' });
    await t.host({ visibility: 'unlisted' }, { gameId: g });
    await t.host({ visibility: 'private' }, { gameId: g });
    await t.join(pub.lobby.code, { gameId: g }, pub);
    const q = await t.hello({ gameId: g });
    const r = await q.call({ t: 'list', visibility: 'public' }, 'lobbies');
    assert.equal(r.items.length, 1);
    const e = r.items[0];
    assert.equal(e.code, pub.lobby.code); assert.equal(e.gameId, g); assert.equal(e.netVersion, '1'); assert.equal(e.name, 'Pub');
    assert.equal(e.hostName, 'HostName'); assert.equal(e.players, 2); assert.equal(e.maxPlayers, 4); assert.equal(e.phase, 'lobby');
    assert.deepEqual(e.meta, { map: 'a' });
    assert.ok(Math.abs(e.createdAt - Date.now()) < 5 * 60_000);
    assert.equal(r.cursor, undefined);
  });
  T('list', 'list is partitioned by gameId and netVersion', async (t) => {
    const g = t.uniqueGame();
    await t.host({ visibility: 'public' }, { gameId: g });
    const other = await t.hello({ gameId: t.uniqueGame() });
    assert.equal((await other.call({ t: 'list', visibility: 'public' }, 'lobbies')).items.length, 0);
    const v2 = await t.hello({ gameId: g, netVersion: '2' });
    assert.equal((await v2.call({ t: 'list', visibility: 'public' }, 'lobbies')).items.length, 0);
  });
  T('list', 'meta filter, in_game lobbies drop off unless lateJoin, phase back to lobby relists', async (t) => {
    const g = t.uniqueGame();
    const a = await t.host({ visibility: 'public', meta: { map: 'a', mode: 'x' } }, { gameId: g });
    const b = await t.host({ visibility: 'public', meta: { map: 'b' } }, { gameId: g });
    const late = await t.host({ visibility: 'public', lateJoin: true, meta: { map: 'a' } }, { gameId: g });
    const q = await t.hello({ gameId: g });
    const codes = async (extra = {}) => (await q.call({ t: 'list', visibility: 'public', ...extra }, 'lobbies')).items.map((i) => i.code).sort();
    assert.deepEqual(await codes(), [a.lobby.code, b.lobby.code, late.lobby.code].sort());
    assert.deepEqual(await codes({ meta: { map: 'a' } }), [a.lobby.code, late.lobby.code].sort());
    assert.deepEqual(await codes({ meta: { map: 'a', mode: 'x' } }), [a.lobby.code]);
    assert.deepEqual(await codes({ meta: { map: 'zzz' } }), []);
    a.send({ t: 'phase', phase: 'in_game' }); await a.next('lobby');
    late.send({ t: 'phase', phase: 'in_game' }); await late.next('lobby');
    assert.deepEqual(await codes(), [b.lobby.code, late.lobby.code].sort());
    a.send({ t: 'phase', phase: 'lobby' }); await a.next('lobby');
    assert.deepEqual(await codes(), [a.lobby.code, b.lobby.code, late.lobby.code].sort());
  });
  T('list', 'limit and cursor page through all lobbies exactly once', async (t) => {
    const g = t.uniqueGame();
    const made = [];
    for (let i = 0; i < 5; i++) made.push((await t.host({ visibility: 'public' }, { gameId: g })).lobby.code);
    const q = await t.hello({ gameId: g });
    const seen = []; let cursor; let pages = 0;
    do {
      const r = await q.call({ t: 'list', visibility: 'public', limit: 2, ...(cursor ? { cursor } : {}) }, 'lobbies');
      assert.ok(r.items.length <= 2); seen.push(...r.items.map((i) => i.code)); cursor = r.cursor; pages++;
    } while (cursor && pages < 10);
    assert.deepEqual([...seen].sort(), [...made].sort()); assert.equal(new Set(seen).size, 5); assert.ok(pages >= 3);
  });
  T('list', 'invalid list requests -> bad_request', async (t) => {
    const q = await t.hello();
    for (const m of [{ visibility: 'unlisted' }, { visibility: 'public', limit: 0 }, { visibility: 'public', limit: 101 }, { visibility: 'public', limit: 'x' }, { visibility: 'public', meta: 'x' }, {}]) await q.callError({ t: 'list', ...m }, 'bad_request');
  });

  // ------------------------------------------------------------------ signal
  T('signal', 'sdp and ice are forwarded verbatim with from stamped by the server', async (t) => {
    const h = await t.host();
    const j = await t.join(h.lobby.code, {}, h);
    const sdp = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n' };
    h.send({ t: 'signal', to: 2, sdp, from: 99 });
    const a = await j.next('signal'); assert.equal(a.from, 1); assert.deepEqual(a.sdp, sdp); assert.equal(a.ice, undefined);
    const ice = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    j.send({ t: 'signal', to: 1, ice });
    const b = await h.next('signal'); assert.equal(b.from, 2); assert.deepEqual(b.ice, ice);
    j.send({ t: 'signal', to: 1, sdp: { type: 'answer', sdp: 'v=0\r\n' }, ice });
    const c = await h.next('signal'); assert.equal(c.from, 2); assert.equal(c.sdp.type, 'answer'); assert.deepEqual(c.ice, ice);
  });
  T('signal', 'joiner to joiner works inside one lobby', async (t) => {
    const h = await t.host();
    const a = await t.join(h.lobby.code, {}, h);
    const b = await t.join(h.lobby.code, {}, h); await a.next('peer_joined');
    a.send({ t: 'signal', to: 3, ice: { candidate: 'x', sdpMid: null, sdpMLineIndex: null } });
    assert.equal((await b.next('signal')).from, 2);
  });
  T('signal', 'bad targets and bodies -> bad_request', async (t) => {
    const h = await t.host();
    const j = await t.join(h.lobby.code, {}, h);
    const other = await t.host();
    await h.callError({ t: 'signal', to: 1, sdp: { type: 'offer', sdp: 'x' } }, 'bad_request');
    await h.callError({ t: 'signal', to: 77, sdp: { type: 'offer', sdp: 'x' } }, 'bad_request');
    await h.callError({ t: 'signal', to: 2 }, 'bad_request');
    await h.callError({ t: 'signal', sdp: { type: 'offer', sdp: 'x' } }, 'bad_request');
    await h.callError({ t: 'signal', to: 'two', sdp: { type: 'offer', sdp: 'x' } }, 'bad_request');
    // cross-lobby: other's peer 1 cannot reach j (peer 2 of h's lobby): target 2 does not exist in other's lobby
    await other.callError({ t: 'signal', to: 2, sdp: { type: 'offer', sdp: 'x' } }, 'bad_request');
    const lone = await t.hello();
    await lone.callError({ t: 'signal', to: 1, sdp: { type: 'offer', sdp: 'x' } }, 'bad_request');
    await j.expectSilence(100);
  });

  // ------------------------------------------------------------------ resume / disconnect
  T('resume', 'socket drop -> peer_left timeout; resumeToken restores the same peerId', async (t) => {
    const h = await t.host();
    const j = await t.join(h.lobby.code, { name: 'Jo' }, h);
    const token = j.lobby.resumeToken;
    j.kill();
    await h.next('peer_left', { peerId: 2, reason: 'timeout' });
    const r = await t.hello({ resumeToken: token, name: 'Jo' });
    assert.equal(r.welcome.peerId, 2);
    const l = await r.next('lobby');
    assert.equal(l.you, 2); assert.equal(l.code, h.lobby.code); assert.equal(l.hostId, 1);
    assert.ok(l.resumeToken.length > 0);
    await h.next('peer_joined', { peer: { peerId: 2, name: 'Jo' } });
    // a token is usable once
    const again = await t.hello({ resumeToken: token });
    assert.equal(again.welcome.peerId, undefined);
  });
  T('resume', 'unknown resumeToken is ignored (plain welcome)', async (t) => {
    const c = await t.hello({ resumeToken: 'definitely-not-a-token' });
    assert.equal(c.welcome.peerId, undefined);
    await c.expectSilence(150);
  });
  T('resume', 'host socket drop -> peer_left timeout, host_changed to lowest peerId; old host resumes as peer', async (t) => {
    const h = await t.host();
    const a = await t.join(h.lobby.code, {}, h);
    const b = await t.join(h.lobby.code, {}, h); await a.next('peer_joined');
    const token = h.lobby.resumeToken;
    h.kill();
    for (const c of [a, b]) { await c.next('peer_left', { peerId: 1, reason: 'timeout' }); assert.equal((await c.next('host_changed')).hostId, 2); }
    const r = await t.hello({ resumeToken: token });
    assert.equal(r.welcome.peerId, 1);
    const l = await r.next('lobby');
    assert.equal(l.you, 1); assert.equal(l.hostId, 2);
  });
  T('resume', 'a reserved slot keeps the lobby alive; the next joiner gets the next peerId', async (t) => {
    const h = await t.host();
    const j = await t.join(h.lobby.code, {}, h);
    j.kill();
    await h.next('peer_left', { peerId: 2, reason: 'timeout' });
    const k = await t.join(h.lobby.code, {}, h);
    assert.equal(k.lobby.you, 3);
  });

  // ------------------------------------------------------------------ optional / slow
  T('policy', 'game_not_allowed (needs --disallowed-game=<id>)', async (t) => {
    const c = await t.raw();
    c.send({ t: 'hello', proto: 'lk1', gameId: opts.disallowedGame, netVersion: '1', client: { lib: 'a', ver: '1', platform: 'n' }, name: 'n' });
    await c.nextError('game_not_allowed');
  }, { skip: () => !opts.disallowedGame && 'no --disallowed-game' });
  T('policy', 'server_full (needs --expect-full, server started with maxLobbies=0 or full)', async (t) => {
    const c = await t.hello();
    await c.callError(t.createBody(), 'server_full');
  }, { skip: () => !opts.expectFull && 'no --expect-full' });
  T('slow', 'idle socket is closed after 30 s of silence; ping keeps it alive', async (t) => {
    const idle = await t.hello(); const live = await t.hello();
    const t0 = Date.now();
    while (Date.now() - t0 < 33_000 && idle.closed === null) { await sleep(5000); if (Date.now() - t0 < 28_000) { live.send({ t: 'ping', n: 1 }); await live.next('pong'); } }
    assert.notEqual(idle.closed, null, 'idle socket closed');
    assert.equal(live.closed, null, 'pinging socket alive');
  }, { slowOnly: true });

  // ------------------------------------------------------------------ rate limits (default limits, fresh server)
  T('ratelimit', 'open lobbies per IP: the 9th create is rate_limited (reason max_lobbies)', async (t) => {
    const n = lim().maxOpen; const hosts = [];
    for (let i = 0; i < n; i++) hosts.push(await t.host());
    const x = await t.hello();
    const e = await x.callError(t.createBody(), 'rate_limited');
    assert.equal(e.data?.reason, 'max_lobbies');
  }, { rateLimitOnly: true, after: 'wait' });
  T('ratelimit', 'create: more than N per minute -> rate_limited with retryAfterMs', async (t) => {
    const n = lim().rateCreate; let hit = -1;
    for (let i = 0; i < n + 2; i++) {
      const c = await t.hello();
      c.send(t.createBody());
      const m = await c.nextAny();
      if (m.t === 'error') { assert.equal(m.code, 'rate_limited'); assert.ok(m.data?.retryAfterMs > 0, 'retryAfterMs'); hit = i; break; }
      c.send({ t: 'leave' }); c.inLobby = false; await sleep(30);
    }
    assert.ok(hit >= 0, 'create was never rate limited');
    assert.ok(hit <= n, `limited after ${hit} creates, limit is ${n}`);
    if (opts.fresh) assert.equal(hit, n, 'fresh server: the (N+1)th create is the first refused');
  }, { rateLimitOnly: true, after: 'wait' });
  T('ratelimit', 'join: more than N per minute -> rate_limited', async (t) => {
    const n = lim().rateJoin; const c = await t.hello(); let hit = -1;
    for (let i = 0; i < n + 3; i++) {
      c.send({ t: 'join', code: 'ZZZZZZ' });
      const m = await c.nextAny();
      assert.equal(m.t, 'error');
      if (m.code === 'rate_limited') { hit = i; assert.ok(m.data?.retryAfterMs > 0); break; }
      assert.equal(m.code, 'unknown_code');
    }
    assert.ok(hit >= 0 && hit <= n, `join limited at ${hit}, limit ${n}`);
    if (opts.fresh) assert.equal(hit, n);
  }, { rateLimitOnly: true, after: 'wait' });
  T('hello', 'path telemetry is accepted silently; a bad value is bad_request', async (t) => {
    const h = await t.host();
    h.send({ t: 'path', path: 'relayed' }); h.send({ t: 'path', path: 'direct' });
    await h.callError({ t: 'path', path: 'sideways' }, 'bad_request');
    await h.call({ t: 'ping', n: 1 }, 'pong');
  });
  T('ratelimit', 'signal: bursts above N/s -> rate_limited, the rest forwarded', async (t) => {
    const n = lim().rateSignal;
    const h = await t.host(); const j = await t.join(h.lobby.code, {}, h);
    for (let i = 0; i < n * 2; i++) h.send({ t: 'signal', to: 2, ice: { candidate: `c${i}`, sdpMid: '0', sdpMLineIndex: 0 } });
    await sleep(400);
    const got = j.drain().filter((m) => m.t === 'signal').length;
    const errs = h.drain().filter((m) => m.t === 'error');
    assert.ok(errs.length > 0 && errs.every((e) => e.code === 'rate_limited'), 'rate_limited errors');
    assert.ok(got >= n - 1 && got <= n + Math.ceil(n / 4), `forwarded ${got}, expected about ${n}`);
  }, { rateLimitOnly: true });

  return tests;
}
