// node --test spec/   : the vectors round-trip in the reference implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encode, decode, fromJson, toJson, hex, unhex, chunkPayload, Reassembler, CodecError, TYPES, MAX_FRAME } from './codec.mjs';
import { normalize, display, ALPHABET } from './codes.mjs';
import { credential, mint } from './turn.mjs';
import { fnv1a32, fnv1a64, xorshift32, seedFromCode, runLog, Gridpaint, paintCmd } from './gridpaint.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, '..', f), 'utf8'));
const frames = load('vectors/frames.json').vectors;

test('hand-computed anchors (independent of the codec)', () => {
  // hi: type 01, route 0000, proto 01, peerId 0200, lastTick 0
  assert.equal(frames.find((v) => v.name === 'hi').hex, '010000' + '01' + '0200' + '0000000000000000');
  assert.equal(frames.find((v) => v.name === 'ping').hex, '300000' + '01000000' + '40e20100');
  assert.equal(frames.find((v) => v.name === 'chat_reject_rate').hex, '620000' + '09000000' + '01');
  assert.equal(frames.find((v) => v.name === 'cmd_paint').hex, '100000' + '01000000' + '0300' + '010509');
  assert.equal(frames.find((v) => v.name === 'frame_empty').hex, '110000' + '2900000000000000' + '0000');
  assert.equal(frames.find((v) => v.name === 'voice_end_of_burst').hex, '5003' + '00' + 'ffff' + '01' + '01' + '0300' + 'f8fffe');
  assert.equal(frames.find((v) => v.name === 'chat_send').hex, '600000' + '01000000' + '0000000000000000' + '0500' + '68656c6c6f');
});

test('every frame type has a vector', () => {
  const have = new Set(frames.map((v) => v.msg.type));
  for (const t of Object.keys(TYPES)) assert.ok(have.has(t), `missing vector for ${t}`);
});

for (const v of frames) {
  test(`frame ${v.name}: encode and decode round-trip`, () => {
    const msg = fromJson(v.msg);
    assert.equal(hex(encode(msg)), v.hex);
    assert.ok(unhex(v.hex).length <= MAX_FRAME);
    const back = decode(unhex(v.hex));
    assert.deepEqual(toJson(back), v.msg);
  });
}

test('invalid frames are rejected with the documented error', () => {
  const inv = load('vectors/invalid.json');
  for (const v of inv.vectors) {
    assert.throws(() => decode(unhex(v.hex)), (e) => e instanceof CodecError && e.code === v.error, `${v.name} -> ${v.error}`);
  }
  for (const v of inv.unknown_type_ok) {
    const d = decode(unhex(v.hex));
    assert.equal(d.type, 'unknown');
    assert.equal(d.typeId, v.decodesAs.typeId);
    assert.equal(d.route, v.decodesAs.route);
    assert.equal(hex(d.body), v.decodesAs.body);
  }
});

test('chunking vectors', () => {
  const c = load('vectors/chunking.json');
  const byName = Object.fromEntries(c.vectors.map((v) => [v.name, v]));
  for (const name of ['small_3byte_chunks', 'empty_payload']) {
    const v = byName[name];
    const msgs = chunkPayload(v.id, unhex(v.payload), v.chunkSize);
    assert.deepEqual(msgs.map((m) => hex(encode(m))), v.chunks);
    const r = new Reassembler();
    let out = null;
    for (const h of [...v.chunks].reverse()) out = r.feed(decode(unhex(h))) ?? out; // reverse order
    assert.equal(hex(out), v.payload);
  }
  const big = byName.forty_kb_default;
  const payload = new Uint8Array(40000).map((_, i) => (i * 7 + 3) & 0xff);
  const cs = chunkPayload(big.id, payload, big.chunkSize);
  assert.equal(cs.length, big.chunk_count);
  assert.deepEqual(cs.map((m) => encode(m).length), big.chunk_lengths);
  assert.ok(cs.every((m) => encode(m).length <= MAX_FRAME));
  assert.equal(fnv1a64(payload).toString(), big.payload_fnv1a64);
  const r = new Reassembler();
  const dup = [cs[1], cs[1], cs[2], cs[0]]; // duplicates ignored
  let out = null;
  for (const m of dup) out = r.feed(m) ?? out;
  assert.deepEqual(out, payload);
  // oversized inner frame decodes after reassembly
  const inner = byName.oversized_inner_frame;
  assert.equal(inner.chunk_count, 2);
  const sd = byName.snapshot_deflate;
  const snap = decode(unhex(sd.snapshot_header_hex));
  assert.equal(snap.flags, 1);
  assert.equal(snap.total, sd.payload.length / 2);
  assert.equal(inflateSync(unhex(sd.payload)).length, sd.inflated_len);
  const r2 = new Reassembler();
  let o2 = null;
  for (const h of sd.chunks) o2 = r2.feed(decode(unhex(h))) ?? o2;
  assert.equal(hex(o2), sd.payload);
});

test('codes.json agrees with the reference normaliser', () => {
  const c = load('codes.json');
  assert.equal(c.alphabet, ALPHABET);
  assert.equal(c.alphabet.length, 32);
  for (const s of c.valid) assert.equal(normalize(s.input), s.canonical, s.input);
  for (const s of c.invalid) assert.equal(normalize(s.input), null, JSON.stringify(s.input));
  assert.equal(display('7HQ4K2'), '7HQ 4K2');
});

test('TURN REST vectors', () => {
  // independent anchor: RFC-style HMAC-SHA1 known answer
  assert.equal(createHmac('sha1', 'key').update('The quick brown fox jumps over the lazy dog').digest('hex'), 'de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9');
  const t = load('vectors/turn-rest.json');
  for (const v of t.vectors) assert.equal(credential(v.secret, v.username), v.credential);
  const m = mint(t.mint.secret, t.mint.userId, t.mint.nowSeconds, t.mint.ttl);
  assert.equal(m.username, t.mint.expectUsername);
  assert.equal(m.credential, t.mint.expectCredential);
});

test('hash and RNG anchors from the literature', () => {
  const ascii = (s) => new TextEncoder().encode(s);
  assert.equal(fnv1a64(ascii('')), 0xcbf29ce484222325n);
  assert.equal(fnv1a64(ascii('a')), 0xaf63dc4c8601ec8cn);
  assert.equal(fnv1a64(ascii('foobar')), 0x85944171f73967e8n);
  assert.equal(fnv1a32(ascii('a')), 0xe40c292c);
  assert.equal(fnv1a32(ascii('foobar')), 0xbf9cf968);
  // Marsaglia xorshift32 (13,17,5) from seed 1
  let x = 1;
  const seq = [];
  for (let i = 0; i < 3; i++) { x = xorshift32(x); seq.push(x); }
  assert.deepEqual(seq, [270369, 67634689, 2647435461]);
});

test('gridpaint goldens', () => {
  const g = load('vectors/gridpaint.json');
  for (const gold of g.golden) {
    assert.equal(seedFromCode(gold.code), gold.seed);
    const want = Object.keys(gold.hashes).map(Number);
    assert.deepEqual(runLog(gold.code, g.commandLog, want), gold.hashes, gold.code);
  }
  // snapshot restore continues identically
  const s = g.snapshotAtTick100_code_7HQ4K2;
  const r = Gridpaint.restore(s.tick, unhex(s.bytes));
  assert.equal(r.hash().toString(), s.hash);
  const by = new Map();
  for (const c of g.commandLog) { if (!by.has(c.tick)) by.set(c.tick, []); by.get(c.tick).push({ peerId: c.peerId, bytes: paintCmd(c.x, c.y) }); }
  for (let t = 101; t <= 400; t++) r.step(t, by.get(t) ?? []);
  assert.equal(r.hash().toString(), g.golden[0].hashes['400']);
});
