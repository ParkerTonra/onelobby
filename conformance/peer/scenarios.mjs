// conformance/peer scenarios. Each drives the library under test (through an adapter) against scripted fake peers and
// checks the bytes on the wire and the game-facing events. Behaviour source: spec/binary.md + spec/demo-game.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { encode, chunkPayload, Reassembler, hex, unhex } from '../../spec/reference/codec.mjs';
import { Gridpaint, paintCmd } from '../../spec/reference/gridpaint.mjs';
import { sleep, norm } from './lib/session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, '..', '..', 'spec', 'vectors', 'gridpaint.json'), 'utf8'));
const CODE = '7HQ4K2';
const GOLD = golden.golden.find((g) => g.code === CODE).hashes;
const TICK_RATE = 50;

const cmdsByTick = new Map();
for (const c of golden.commandLog) { if (!cmdsByTick.has(c.tick)) cmdsByTick.set(c.tick, []); cmdsByTick.get(c.tick).push({ peerId: c.peerId, bytes: paintCmd(c.x, c.y) }); }
const firstCmdTick = golden.commandLog[0].tick;

// ---------------------------------------------------------------- helpers
const ref = () => new Gridpaint(CODE);
// Send frames [from..to] to the library from `peer`, stepping `g` (the reference) too. tamper(t, cmds) alters what is SENT only.
async function feed(peer, g, from, to, { tamper = null, cmds = (t) => cmdsByTick.get(t) ?? [] } = {}) {
  for (let t = from; t <= to; t++) {
    const c = cmds(t);
    g.step(t, c);
    (g.hist ??= new Map()).set(t, g.hash().toString());
    await peer.send({ type: 'frame', route: 0, tick: BigInt(t), cmds: tamper ? tamper(t, c) : c });
  }
}
const snapshotMsgs = (g, id, chunkSize = 40, flags = 1) => {
  const raw = g.snapshot();
  const payload = flags & 1 ? deflateSync(raw) : raw;
  return [{ type: 'snapshot', route: 0, tick: BigInt(g.tick), total: payload.length, flags }, ...chunkPayload(id, payload, chunkSize)];
};

async function joinerUp(s, o = {}) {
  const { tick = 0, peerId = 2, peers = [1, 2], hashEvery = 20, name = 'Tester' } = o;
  await s.start({ role: 'joiner', code: CODE, peerId, hostId: 1, peers, tickRate: TICK_RATE, hashEvery, mode: o.mode ?? 'lockstep', chunkSize: 64, name });
  const host = s.peer(1);
  await s.link(1);
  const hi = await host.wait('hi');
  assert.equal(hi.proto, 1); assert.equal(hi.peerId, peerId); assert.equal(hi.lastTick, -1n, 'fresh joiner sends lastTick -1'); assert.equal(hi.route, 0); assert.equal(hi._ch, 'reliable');
  await host.send({ type: 'welcome_dc', route: 0, tick: BigInt(tick), tickRate: TICK_RATE, mode: o.mode === 'raw' ? 2 : 1, hostId: 1 });
  await host.send({ type: 'chat_history', route: 0, lines: o.history ?? [] });
  return host;
}
async function hostUp(s, o = {}) {
  const { mode = 'lockstep', peers = [1, 2, 3], begin = true } = o;
  await s.start({ role: 'host', code: CODE, peerId: 1, hostId: 1, peers, tickRate: TICK_RATE, hashEvery: 20, mode, chunkSize: 16 });
  if (begin) await s.call('begin');
}
async function joinTo(s, id, lastTick = -1n) {
  await s.link(id);
  const p = s.peer(id);
  await p.send({ type: 'hi', route: 0, proto: 1, peerId: id, lastTick });
  const w = await p.wait('welcome_dc');
  const h = await p.wait('chat_history');
  assert.ok(w._n < h._n, 'welcome_dc before chat_history');
  assert.equal(w.hostId, 1); assert.equal(w.tickRate, TICK_RATE);
  return { p, w, h };
}
// Reassemble a snapshot the library sent to peer p (header already taken).
async function takeSnapshot(p, hdr, timeout = 3000) {
  const re = new Reassembler(); let out = null; let id = null;
  while (!out) {
    const c = await p.wait('chunk', id === null ? {} : { id }, timeout);
    id = c.id; assert.ok(c._n > hdr._n, 'chunks follow the snapshot header');
    out = re.feed(c);
  }
  assert.equal(out.length, hdr.total, 'snapshot total equals the summed chunk bodies');
  const raw = hdr.flags & 1 ? inflateSync(out) : out;
  return Gridpaint.restore(hdr.tick, raw);
}
const hashAt = async (s, t) => (await s.call('hash_at', { tick: t })).hash;

export function buildScenarios() {
  const S = [];
  const T = (group, name, needs, fn) => S.push({ group, name, needs, fn });

  // ================================================================ library as JOINER (harness plays the host)
  T('joiner', 'handshake: hi on reliable (proto 1, peerId, lastTick -1)', ['joiner', 'lockstep'], async (s) => { await joinerUp(s); });

  T('joiner', 'frames drive the game: hashes match the gridpaint goldens at ticks 20 and 100', ['joiner', 'lockstep'], async (s) => {
    const host = await joinerUp(s); const g = ref();
    await feed(host, g, 1, 100);
    for (const t of [20, 40, 60, 80, 100]) {
      const h = await host.wait('hash', { tick: t });
      assert.equal(h.hash.toString(), g.hist.get(t), `hash at tick ${t}`);
      if (GOLD[t] !== undefined) assert.equal(h.hash.toString(), GOLD[t], `tick ${t} equals the published golden`);
    }
    assert.equal(g.hash().toString(), GOLD[100]);
    const st = await s.call('state');
    assert.equal(st.tick, 100); assert.equal(st.hash, GOLD[100]);
    // hash(T) is only sent for multiples of hashEvery
    await host.none('hash', { tick: (t) => Number(t) % 20 !== 0 }, 50);
  });

  T('joiner', 'ticks up to 400 reproduce the tick-400 golden', ['joiner', 'lockstep'], async (s) => {
    const host = await joinerUp(s); const g = ref();
    await feed(host, g, 1, 400);
    const h = await host.wait('hash', { tick: 400 }, 5000);
    assert.equal(h.hash.toString(), GOLD[400]);
  });

  T('joiner', 'a local command is sent as cmd{seq, bytes} to the host and does not change state until its frame', ['joiner', 'lockstep'], async (s) => {
    const host = await joinerUp(s); const g = ref();
    await feed(host, g, 1, 3);
    const before = (await s.call('state')).hash;
    await s.call('command', { x: 3, y: 4 });
    const c1 = await host.wait('cmd');
    assert.equal(c1.seq, 1); assert.equal(hex(c1.bytes), '010304'); assert.equal(c1.route, 0); assert.equal(c1._ch, 'reliable');
    await s.call('command', { x: 15, y: 0 });
    const c2 = await host.wait('cmd');
    assert.equal(c2.seq, 2); assert.equal(hex(c2.bytes), '010f00');
    assert.equal((await s.call('state')).hash, before, 'state waits for the frame');
    // the frame brings it in
    g.step(4, [{ peerId: 2, bytes: paintCmd(3, 4) }]);
    await host.send({ type: 'frame', route: 0, tick: 4n, cmds: [{ peerId: 2, bytes: paintCmd(3, 4) }] });
    assert.equal((await s.call('state')).hash, g.hash().toString());
  });

  T('joiner', 'a gap in frames -> snapshot_req{sinceTick}', ['joiner', 'lockstep'], async (s) => {
    const host = await joinerUp(s); const g = ref();
    await feed(host, g, 1, 5);
    await host.send({ type: 'frame', route: 0, tick: 9n, cmds: [] });
    const r = await host.wait('snapshot_req');
    assert.equal(r.sinceTick, 5n); assert.equal(r._ch, 'reliable');
  });

  T('joiner', 'stale and duplicate frames are ignored', ['joiner', 'lockstep'], async (s) => {
    const host = await joinerUp(s); const g = ref();
    await feed(host, g, 1, 20);
    const evil = [{ peerId: 3, bytes: paintCmd(0, 0) }];
    await host.send({ type: 'frame', route: 0, tick: 10n, cmds: evil });
    await host.send({ type: 'frame', route: 0, tick: 20n, cmds: evil });
    await feed(host, g, 21, 40);
    const h = await host.wait('hash', { tick: 40 });
    assert.equal(h.hash.toString(), g.hash().toString());
  });

  T('joiner', 'malformed, truncated, trailing and unknown frames are ignored without breaking the session', ['joiner', 'lockstep'], async (s) => {
    const host = await joinerUp(s); const g = ref();
    await feed(host, g, 1, 5);
    const good = encode({ type: 'frame', route: 0, tick: 6n, cmds: [] });
    await host.send(Uint8Array.of(0x99, 7, 0, 1, 2, 3));                                  // unknown type
    await host.send(good.slice(0, good.length - 1));                                       // truncated
    await host.send(Uint8Array.from([...good, 0]));                                        // trailing byte
    await host.send(Uint8Array.of(0x16, 0, 0, 1, 0, 0, 0, 5, 0, 2, 0));                   // chunk index >= count
    await host.send(Uint8Array.of(0x60, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0xc3, 0x28)); // chat with invalid UTF-8
    await host.send(Uint8Array.of(1));                                                     // shorter than a header
    await feed(host, g, 6, 20);
    const h = await host.wait('hash', { tick: 20 });
    assert.equal(h.hash.toString(), GOLD[20]);
    await s.noEvent('chat', {}, 50);
  });

  T('joiner', 'desync + snapshot (deflate, many chunks): library restores and converges', ['joiner', 'lockstep', 'deflate'], async (s) => {
    const host = await joinerUp(s); const g = ref();
    await feed(host, g, 1, 40, { tamper: (t, c) => (t === firstCmdTick ? [] : c) });
    const bad = await host.wait('hash', { tick: 20 });
    assert.notEqual(bad.hash.toString(), GOLD[20], 'library state diverged (test premise)');
    const msgs = snapshotMsgs(g, 4242, 40, 1);
    assert.ok(msgs.length > 3, 'snapshot spans several chunks');
    await host.send({ type: 'desync', route: 0, tick: 20n, hostHash: BigInt(GOLD[20]), yourHash: bad.hash });
    for (const m of msgs) await host.send(m);
    await s.waitEvent('desync', { tick: 20 });
    await s.waitEvent('snapshot_restored', { tick: 40 });
    await feed(host, g, 41, 80);
    const h = await host.wait('hash', { tick: 80 });
    assert.equal(h.hash.toString(), g.hash().toString());
  });

  T('joiner', 'late join: snapshot at welcome_dc.tick, chunks in any order with a duplicate, frames after it', ['joiner', 'lockstep', 'deflate'], async (s) => {
    await s.start({ role: 'joiner', code: CODE, peerId: 2, hostId: 1, peers: [1, 2], tickRate: TICK_RATE, hashEvery: 20, mode: 'lockstep', chunkSize: 64 });
    const host = s.peer(1); await s.link(1);
    await host.wait('hi');
    const g = ref(); g.tick = 0;
    for (let t = 1; t <= 100; t++) g.step(t, cmdsByTick.get(t) ?? []);
    await host.send({ type: 'welcome_dc', route: 0, tick: 100n, tickRate: TICK_RATE, mode: 1, hostId: 1 });
    await host.send({ type: 'chat_history', route: 0, lines: [] });
    const [hdr, ...chunks] = snapshotMsgs(g, 9, 24, 1);
    assert.ok(chunks.length >= 3);
    await host.send(hdr);
    const order = [...chunks].reverse(); order.splice(1, 0, order[0]);
    for (const c of order) await host.send(c);
    await s.waitEvent('snapshot_restored', { tick: 100 });
    await feed(host, g, 101, 140);
    const h = await host.wait('hash', { tick: 140 });
    assert.equal(h.hash.toString(), g.hash().toString());
    assert.equal((await host.take('hash', { tick: 100 })).length, 0, 'no hash for a tick restored from a snapshot before frames resume');
  });

  T('joiner', 'a frame split into chunks is reassembled and applied', ['joiner', 'lockstep'], async (s) => {
    const host = await joinerUp(s); const g = ref();
    await feed(host, g, 1, 5);
    const cmds = [{ peerId: 3, bytes: paintCmd(2, 2) }, { peerId: 4, bytes: paintCmd(9, 9) }];
    g.step(6, cmds);
    for (const c of chunkPayload(77, encode({ type: 'frame', route: 0, tick: 6n, cmds }), 5)) await host.send(c);
    await feed(host, g, 7, 20);
    const h = await host.wait('hash', { tick: 20 });
    assert.equal(h.hash.toString(), g.hash().toString());
  });

  T('joiner', '3 s without frames -> snapshot_req', ['joiner', 'lockstep'], async (s) => {
    const host = await joinerUp(s); const g = ref();
    await feed(host, g, 1, 10);
    const t0 = Date.now();
    const r = await host.wait('snapshot_req', {}, 5000);
    assert.equal(r.sinceTick, 10n);
    const dt = Date.now() - t0;
    assert.ok(dt >= 2500 && dt <= 4800, `snapshot_req after ${dt} ms of silence (expected about 3000)`);
  });

  T('joiner', 'ping on fast is answered with pong echoing n and t', ['joiner'], async (s) => {
    const host = await joinerUp(s);
    await host.send({ type: 'ping', route: 0, n: 7, t: 99 }, 'fast');
    const p = await host.wait('pong', { n: 7, t: 99 });
    assert.equal(p._ch, 'fast');
  });

  T('joiner', 'chat: history, incoming line, outgoing line (client id, ts 0), reject event', ['joiner', 'chat'], async (s) => {
    const host = await joinerUp(s, { history: [{ peerId: 1, id: 1, ts: 1000n, text: 'welcome' }, { peerId: 3, id: 2, ts: 2000n, text: 'hi' }] });
    const hist = await s.waitEvent('chat_history');
    assert.deepEqual(hist.lines.map((l) => [l.peerId, l.id, l.text]), [[1, 1, 'welcome'], [3, 2, 'hi']]);
    await host.send({ type: 'chat', route: 3, id: 3, ts: 3000n, text: 'café ☕' });
    const ev = await s.waitEvent('chat', { peerId: 3 });
    assert.equal(ev.text, 'café ☕'); assert.equal(ev.id, 3);
    await s.call('chat_send', { text: 'yo' });
    const c1 = await host.wait('chat');
    assert.equal(c1.text, 'yo'); assert.equal(c1.ts, 0n); assert.equal(c1.route, 0); assert.ok(c1.id >= 1); assert.equal(c1._ch, 'reliable');
    await s.call('chat_send', { text: 'again' });
    const c2 = await host.wait('chat');
    assert.equal(c2.id, c1.id + 1, 'client chat id increments');
    await host.send({ type: 'chat_reject', route: 0, id: c1.id, reason: 1 });
    await s.waitEvent('chat_rejected', { id: c1.id, reason: 1 });
  });

  T('joiner', 'voice: packets from the host reach the game; own voice leaves on the voice channel', ['joiner', 'voice'], async (s) => {
    const host = await joinerUp(s);
    await host.send({ type: 'voice', route: 3, seq: 9, flags: 0, packets: [{ opus: Uint8Array.of(0xf8, 1, 2) }, { opus: Uint8Array.of(0xf8, 3) }] }, 'voice');
    const ev = await s.waitEvent('voice', { peerId: 3, seq: 9 });
    assert.deepEqual(ev.frames, ['f80102', 'f803']);
    await host.send({ type: 'voice', route: 3, seq: 10, flags: 0, packets: [{ opus: Uint8Array.of(1) }] }, 'reliable');
    await s.noEvent('voice', { seq: 10 }, 150);
    await s.call('voice_send', { frames: ['f8aa', 'f8bb'], endOfBurst: false });
    await s.call('voice_send', { frames: ['f8cc', 'f8dd'], endOfBurst: true });
    const v1 = await host.wait('voice'); const v2 = await host.wait('voice');
    assert.equal(v1._ch, 'voice'); assert.equal(v1.route, 0); assert.equal(v1.flags, 0); assert.equal(v1.packets.length, 2);
    assert.equal(v2.seq, (v1.seq + 1) & 0xffff); assert.equal(v2.flags & 1, 1);
    assert.deepEqual(v1.packets.map((p) => hex(p.opus)), ['f8aa', 'f8bb']);
  });

  T('joiner', 'raw mode: raw payloads in and out', ['joiner', 'raw'], async (s) => {
    const host = await joinerUp(s, { mode: 'raw' });
    await host.send({ type: 'raw', route: 3, bytes: Uint8Array.of(1, 2, 3) }, 'reliable');
    const ev = await s.waitEvent('raw', { from: 3 });
    assert.equal(ev.hex, '010203');
    await s.call('raw_send', { to: 3, hex: 'beef', channel: 'fast' });
    const r = await host.wait('raw');
    assert.equal(r._ch, 'fast'); assert.equal(r.route, 3); assert.equal(hex(r.bytes), 'beef');
    await s.call('raw_send', { to: 0, hex: 'cafe', channel: 'reliable' });
    const r2 = await host.wait('raw', { route: 0 });
    assert.equal(hex(r2.bytes), 'cafe'); assert.equal(r2._ch, 'reliable');
  });

  T('migration', 'host link lost, library is lowest peerId: dials, claims epoch 1, serves a follower from its buffer', ['joiner', 'lockstep', 'migration'], async (s) => {
    const host = await joinerUp(s, { peers: [1, 2, 3] }); const g = ref();
    await feed(host, g, 1, 30);
    await host.wait('hash', { tick: 20 });
    await s.unlink(1);
    await s.waitEvent('dial', { peerId: 3 }, 6000);
    await s.link(3);
    const p3 = s.peer(3);
    const claim = await p3.wait('host_claim', {}, 3000);
    assert.equal(claim.epoch, 1); assert.equal(claim.hostId, 2); assert.equal(claim.tick, 30n); assert.equal(claim._ch, 'reliable'); assert.equal(claim.route, 0);
    await s.waitEvent('host_changed', { hostId: 2 });
    // peer 3 follows: hi with an older lastTick -> welcome_dc, chat_history, frames 28.. contiguous, then live frames
    await p3.send({ type: 'hi', route: 0, proto: 1, peerId: 3, lastTick: 27n });
    const w = await p3.wait('welcome_dc'); assert.equal(w.hostId, 2);
    await p3.wait('chat_history');
    await sleep(600);
    const frames = p3.take('frame').filter((f) => f._n > w._n);
    assert.ok(frames.length >= 5, `frames after migration: ${frames.length}`);
    assert.equal(frames[0].tick, 28n, 'replay starts at lastTick + 1');
    frames.forEach((f, i) => assert.equal(f.tick, 28n + BigInt(i), 'consecutive ticks'));
    assert.ok(frames.at(-1).tick > 30n, 'live frames continue past the old host tick');
  });

  T('migration', 'host link lost, library is NOT lowest: no claim; better claim wins (epoch, then lower id)', ['joiner', 'lockstep', 'migration'], async (s) => {
    const host = await joinerUp(s, { peerId: 3, peers: [1, 2, 3, 4] }); const g = ref();
    await feed(host, g, 1, 10);
    await s.unlink(1);
    await s.noEvent('host_changed', { hostId: 3 }, 1200);
    const p2 = s.peer(2), p4 = s.peer(4);
    await s.link(2); await s.link(4);
    await p2.none('host_claim', {}, 100);
    await p2.send({ type: 'host_claim', route: 0, epoch: 1, hostId: 2, tick: 10n });
    await s.waitEvent('host_changed', { hostId: 2, epoch: 1 });
    const hi = await p2.wait('hi'); assert.equal(hi.peerId, 3); assert.equal(hi.lastTick, 10n);
    await p4.send({ type: 'host_claim', route: 0, epoch: 1, hostId: 4, tick: 10n });
    await s.noEvent('host_changed', { hostId: 4 }, 400);
    await p4.send({ type: 'host_claim', route: 0, epoch: 2, hostId: 4, tick: 10n });
    await s.waitEvent('host_changed', { hostId: 4, epoch: 2 });
  });

  // ================================================================ library as HOST (harness plays joiners)
  T('host', 'handshake before the game starts: welcome_dc{tick 0}, chat_history, no snapshot, frames from tick 1', ['host', 'lockstep'], async (s) => {
    await hostUp(s, { begin: false });
    const { p, w, h } = await joinTo(s, 2);
    assert.equal(w.tick, 0n); assert.equal(w.mode, 1); assert.equal(h.lines.length, 0); assert.equal(w._ch, 'reliable');
    await p.none('snapshot', {}, 250);
    await p.none('frame', {}, 100);
    await s.call('begin');
    const f = await p.wait('frame');
    assert.equal(f.tick, 1n);
  });

  T('host', 'frame cadence: consecutive ticks at tickRate, empty frames included, same sequence for every peer', ['host', 'lockstep'], async (s) => {
    await hostUp(s, { begin: false });
    const a = (await joinTo(s, 2)).p, b = (await joinTo(s, 3)).p;
    await s.call('begin');
    await sleep(1200);
    const fa = a.take('frame'), fb = b.take('frame');
    assert.ok(fa.length >= 0.6 * 1.2 * TICK_RATE && fa.length <= 1.4 * 1.2 * TICK_RATE, `peer 2 got ${fa.length} frames in 1.2 s at ${TICK_RATE} TPS`);
    fa.forEach((f, i) => assert.equal(f.tick, BigInt(i + 1), 'consecutive from 1'));
    assert.ok(fa.every((f) => f.cmds.length === 0), 'idle frames are empty but sent');
    const n = Math.min(fa.length, fb.length);
    for (let i = 0; i < n; i++) assert.equal(fa[i].tick, fb[i].tick);
    assert.equal(fa[0]._ch, 'reliable');
  });

  T('host', 'commands: relayed once, sorted by peerId (stable), host commands included, identical for all peers', ['host', 'lockstep'], async (s) => {
    await hostUp(s, { begin: false });
    const a = (await joinTo(s, 2)).p, b = (await joinTo(s, 3)).p;
    // all commands arrive before the first frame: order in the frame must be by peerId, then arrival
    await b.send({ type: 'cmd', route: 0, seq: 1, bytes: paintCmd(4, 4) });
    await a.send({ type: 'cmd', route: 0, seq: 1, bytes: paintCmd(1, 1) });
    await a.send({ type: 'cmd', route: 0, seq: 2, bytes: paintCmd(2, 2) });
    await s.call('command', { x: 5, y: 5 });
    await s.call('begin');
    await sleep(300);
    const fa = a.take('frame'), fb = b.take('frame');
    const withCmds = fa.filter((f) => f.cmds.length);
    assert.equal(withCmds.length, 1, 'all four commands share the first frame');
    assert.deepEqual(withCmds[0].cmds.map((c) => [c.peerId, hex(c.bytes)]), [[1, '010505'], [2, '010101'], [2, '010202'], [3, '010404']]);
    const same = fb.find((f) => f.tick === withCmds[0].tick);
    assert.deepEqual(norm(same.cmds), norm(withCmds[0].cmds));
  });

  T('host', 'late join: welcome_dc{tick}, chat_history, snapshot of that tick, then frames from tick+1 without a gap', ['host', 'lockstep', 'deflate'], async (s) => {
    await hostUp(s);
    await joinTo(s, 2);
    await s.call('command', { x: 7, y: 7 });
    await sleep(500);
    await s.link(3);
    const p = s.peer(3);
    await p.send({ type: 'hi', route: 0, proto: 1, peerId: 3, lastTick: -1n });
    const w = await p.wait('welcome_dc');
    assert.ok(w.tick > 0n);
    const ch = await p.wait('chat_history');
    const hdr = await p.wait('snapshot');
    assert.ok(w._n < ch._n && ch._n < hdr._n, 'order: welcome_dc, chat_history, snapshot');
    assert.equal(hdr.tick, w.tick);
    const g = await takeSnapshot(p, hdr);
    assert.equal(g.tick, Number(hdr.tick));
    assert.equal(g.hash().toString(), await hashAt(s, g.tick), 'snapshot hash equals the host hash at that tick');
    await sleep(400);
    const frames = p.take('frame');
    assert.ok(frames.length >= 5);
    assert.equal(frames[0].tick, hdr.tick + 1n, 'first frame after the snapshot is tick+1');
    frames.forEach((f, i) => assert.equal(f.tick, hdr.tick + 1n + BigInt(i)));
    for (const f of frames) g.step(Number(f.tick), f.cmds.map((c) => ({ peerId: c.peerId, bytes: c.bytes })));
    assert.equal(g.hash().toString(), await hashAt(s, g.tick), 'restored + frames == host');
  });

  T('host', 'hash mismatch -> desync + snapshot (1st, 2nd); matching hash -> nothing; 3rd mismatch drops the peer', ['host', 'lockstep'], async (s) => {
    await hostUp(s, { begin: false });
    const a = (await joinTo(s, 2)).p, b = (await joinTo(s, 3)).p;
    await s.call('begin');
    await a.wait('frame', { tick: 20 }, 4000);
    const mine = await hashAt(s, 20);
    assert.ok(mine, 'host kept its hash for tick 20');
    await b.send({ type: 'hash', route: 0, tick: 20n, hash: BigInt(mine) });
    await b.none('desync', {}, 200);
    for (let round = 1; round <= 2; round++) {
      await a.send({ type: 'hash', route: 0, tick: 20n, hash: 12345n });
      const d = await a.wait('desync');
      assert.equal(d.tick, 20n); assert.equal(d.hostHash.toString(), mine); assert.equal(d.yourHash, 12345n);
      const hdr = await a.wait('snapshot'); assert.ok(d._n < hdr._n);
      const g = await takeSnapshot(a, hdr);
      assert.equal(g.hash().toString(), await hashAt(s, g.tick), `resync ${round}: snapshot matches the host`);
    }
    await a.send({ type: 'hash', route: 0, tick: 20n, hash: 12345n });
    await s.waitEvent('peer_dropped', { peerId: 2, reason: 'desync' });
    await sleep(100);
    assert.ok(s.closed.has(2), 'library closed the connection to the desynced peer');
  });

  T('host', 'snapshot_req -> snapshot, no desync', ['host', 'lockstep'], async (s) => {
    await hostUp(s);
    const { p } = await joinTo(s, 2);
    await sleep(300);
    p.take('snapshot');
    await p.send({ type: 'snapshot_req', route: 0, sinceTick: 3n });
    const hdr = await p.wait('snapshot');
    const g = await takeSnapshot(p, hdr);
    assert.equal(g.hash().toString(), await hashAt(s, g.tick));
    await p.none('desync', {}, 100);
  });

  T('host', 'chat: stamped id/ts, route = sender, sent to everyone including the sender; history for late joiners', ['host', 'chat'], async (s) => {
    await hostUp(s, { begin: false });
    const a = (await joinTo(s, 2)).p, b = (await joinTo(s, 3)).p;
    const t0 = Date.now();
    await a.send({ type: 'chat', route: 0, id: 1, ts: 0n, text: 'hello' });
    const ca = await a.wait('chat'), cb = await b.wait('chat');
    for (const c of [ca, cb]) { assert.equal(c.route, 2); assert.equal(c.text, 'hello'); assert.ok(c.id >= 1); assert.ok(Math.abs(Number(c.ts) - t0) < 5000, 'ts is host unix ms'); assert.equal(c._ch, 'reliable'); }
    assert.equal(ca.id, cb.id);
    await s.waitEvent('chat', { peerId: 2, text: 'hello' });
    await s.call('chat_send', { text: 'from host' });
    const ch = await a.wait('chat', { text: 'from host' });
    assert.equal(ch.route, 1); assert.ok(ch.id > ca.id, 'ids are monotonic');
    // late joiner gets both lines, oldest first
    await s.link(4);
    const d = s.peer(4);
    await d.send({ type: 'hi', route: 0, proto: 1, peerId: 4, lastTick: -1n });
    const h = await d.wait('chat_history');
    assert.deepEqual(h.lines.map((l) => [l.peerId, l.text]), [[2, 'hello'], [1, 'from host']]);
  });

  T('host', 'chat limits: burst of 3 then rate reject, length reject, host mute, control characters stripped', ['host', 'chat'], async (s) => {
    await hostUp(s, { begin: false });
    const a = (await joinTo(s, 2)).p, b = (await joinTo(s, 3)).p;
    for (let i = 1; i <= 4; i++) await a.send({ type: 'chat', route: 0, id: i, ts: 0n, text: `m${i}` });
    const rej = await a.wait('chat_reject');
    assert.equal(rej.id, 4); assert.equal(rej.reason, 1);
    assert.deepEqual(b.take('chat').map((c) => c.text), ['m1', 'm2', 'm3'], 'only the burst was delivered');
    await sleep(1100);
    await a.send({ type: 'chat', route: 0, id: 5, ts: 0n, text: 'x'.repeat(257) });
    const lr = await a.wait('chat_reject', { id: 5 }); assert.equal(lr.reason, 2);
    await a.send({ type: 'chat', route: 0, id: 6, ts: 0n, text: 'a\u0001b‮c' });
    const stripped = await b.wait('chat', { text: 'abc' });
    assert.equal(stripped.route, 2);
    await sleep(1100);
    await s.call('chat_host_mute', { peerId: 2, muted: true });
    await a.send({ type: 'chat', route: 0, id: 7, ts: 0n, text: 'muted?' });
    const mr = await a.wait('chat_reject', { id: 7 }); assert.equal(mr.reason, 3);
    await b.none('chat', { text: 'muted?' }, 150);
    await s.call('chat_host_mute', { peerId: 2, muted: false });
    await sleep(1100);
    await a.send({ type: 'chat', route: 0, id: 8, ts: 0n, text: 'back' });
    await b.wait('chat', { text: 'back' });
  });

  T('host', 'voice: forwarded to everyone but the speaker with route = speaker; oversize, flood and 9th speaker dropped', ['host', 'voice'], async (s) => {
    await hostUp(s, { begin: false });
    const ids = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const peers = {};
    for (const id of ids) peers[id] = (await joinTo(s, id)).p;
    const pkt = (seq, n = 2, size = 20) => ({ type: 'voice', route: 0, seq, flags: 0, packets: Array.from({ length: n }, () => ({ opus: new Uint8Array(size).fill(0xf8) })) });
    await peers[2].send(pkt(1), 'voice');
    const got = await peers[3].wait('voice');
    assert.equal(got.route, 2); assert.equal(got.seq, 1); assert.equal(got.packets.length, 2); assert.equal(got._ch, 'voice');
    await peers[2].none('voice', {}, 100);
    // oversize (> 1024 bytes) dropped
    await peers[2].send(pkt(2, 2, 600), 'voice');
    await peers[3].none('voice', { seq: 2 }, 150);
    // flood: 45 packets from one peer inside a second -> at most 30 forwarded
    peers[3].take('voice');
    for (let i = 0; i < 45; i++) await peers[4].send(pkt(100 + i, 1, 10), 'voice');
    await sleep(150);
    const fl = peers[3].take('voice').filter((v) => v.route === 4).length;
    assert.ok(fl >= 25 && fl <= 31, `forwarded ${fl} of 45 packets in one second (cap is 30)`);
    // speaker limit: after a quiet period, nine peers speak; the listener (11) hears at most 8 of them
    await sleep(1100);
    peers[11].take('voice');
    for (const id of [2, 3, 4, 5, 6, 7, 8, 9, 10]) await peers[id].send(pkt(1, 1, 10), 'voice');
    await sleep(150);
    const speakers = new Set(peers[11].take('voice').map((v) => v.route));
    assert.equal(speakers.size, 8, `${speakers.size} distinct speakers reached the listener (cap is 8)`);
  });

  T('host', 'raw mode: routed to a peer or broadcast, route = source, never echoed to the sender', ['host', 'raw'], async (s) => {
    await hostUp(s, { mode: 'raw', begin: false });
    const { p: a, w } = await joinTo(s, 2); const b = (await joinTo(s, 3)).p;
    assert.equal(w.mode, 2); assert.equal(w.tick, 0n);
    await a.none('snapshot', {}, 100);
    await a.send({ type: 'raw', route: 3, bytes: Uint8Array.of(1, 2, 3) }, 'reliable');
    const r = await b.wait('raw'); assert.equal(r.route, 2); assert.equal(hex(r.bytes), '010203'); assert.equal(r._ch, 'reliable');
    await a.send({ type: 'raw', route: 0, bytes: Uint8Array.of(9) }, 'fast');
    const rb = await b.wait('raw', { bytes: Uint8Array.of(9) }); assert.equal(rb._ch, 'fast'); assert.equal(rb.route, 2);
    await s.waitEvent('raw', { from: 2, hex: '09' });
    await a.none('raw', {}, 100);
    await s.call('raw_send', { to: 0, hex: 'aa', channel: 'reliable' });
    const ha = await a.wait('raw'); const hb = await b.wait('raw', { bytes: Uint8Array.of(0xaa) });
    assert.equal(ha.route, 1); assert.equal(hb.route, 1);
    await a.none('frame', {}, 100);
  });

  T('host', 'ping on fast is answered; garbage frames do not break the host', ['host'], async (s) => {
    await hostUp(s, { begin: false });
    const { p } = await joinTo(s, 2);
    await p.send({ type: 'ping', route: 0, n: 3, t: 4242 }, 'fast');
    const pong = await p.wait('pong', { n: 3, t: 4242 }); assert.equal(pong._ch, 'fast');
    await p.send(Uint8Array.of(0x99, 0, 0, 1)); await p.send(Uint8Array.of(0x10, 0, 0, 1)); await p.send(Uint8Array.of());
    await p.send({ type: 'ping', route: 0, n: 4, t: 1 }, 'fast');
    await p.wait('pong', { n: 4 });
    const { p: q } = await joinTo(s, 3);
    assert.ok(q);
  });

  return S;
}
