// Regenerates spec/vectors/*.json from the reference implementation.  Run: node spec/reference/gen-vectors.mjs
// The vectors are frozen once published; tests in spec/reference/*.test.mjs also pin hand-computed anchors.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { encode, fromJson, toJson, hex, unhex, chunkPayload, MAX_FRAME } from './codec.mjs';
import { runLog, Gridpaint, paintCmd, seedFromCode, fnv1a64 } from './gridpaint.mjs';
import { credential } from './turn.mjs';
import { ALPHABET } from './codes.mjs';
import * as jc from './joincode.mjs';
const group = jc.group;

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors');
const write = (name, obj) => writeFileSync(join(dir, name), JSON.stringify(obj, null, 2) + '\n');
const b = (...xs) => hex(Uint8Array.from(xs));
const rep = (byte, n) => hex(new Uint8Array(n).fill(byte));

// ---- frames.json: one or more vectors per type ----
const msgs = [
  ['hi', 'joiner hello, proto 1, peerId 2, lastTick 0', { type: 'hi', route: 0, proto: 1, peerId: 2, lastTick: '0' }],
  ['hi_resume', 'peerId 300, lastTick 1234567890123', { type: 'hi', route: 0, proto: 1, peerId: 300, lastTick: '1234567890123' }],
  ['hi_negative_tick', 'i64 is signed: lastTick -1 means no state yet', { type: 'hi', route: 0, proto: 1, peerId: 2, lastTick: '-1' }],
  ['welcome_dc', 'lockstep (mode 1), 20 TPS, host 1, tick 0', { type: 'welcome_dc', route: 0, tick: '0', tickRate: 20, mode: 1, hostId: 1 }],
  ['welcome_dc_raw', 'raw mode (2), tick 4096', { type: 'welcome_dc', route: 0, tick: '4096', tickRate: 30, mode: 2, hostId: 7 }],
  ['cmd_paint', 'gridpaint paint 5,9', { type: 'cmd', route: 0, seq: 1, bytes: b(1, 5, 9) }],
  ['cmd_empty', 'zero-length command bytes', { type: 'cmd', route: 0, seq: 4294967295, bytes: '' }],
  ['frame_empty', 'empty frame (n = 0) is still sent', { type: 'frame', route: 0, tick: '41', cmds: [] }],
  ['frame_two_cmds', 'commands in peerId then arrival order', { type: 'frame', route: 0, tick: '42', cmds: [{ peerId: 1, bytes: b(1, 0, 0) }, { peerId: 3, bytes: b(1, 15, 15) }] }],
  ['frame_big_tick', 'tick above 2^32', { type: 'frame', route: 0, tick: '5000000000', cmds: [{ peerId: 2, bytes: '' }] }],
  ['hash', 'FNV-1a 64 of an empty grid (all zero 256 bytes) at tick 20', { type: 'hash', route: 0, tick: '20', hash: fnv1a64(new Uint8Array(256)).toString() }],
  ['hash_max', 'u64 max', { type: 'hash', route: 0, tick: '1', hash: '18446744073709551615' }],
  ['desync', 'host tells peer the two hashes', { type: 'desync', route: 0, tick: '60', hostHash: '1311768467463790320', yourHash: '81985529216486895' }],
  ['snapshot_req', 'resync request', { type: 'snapshot_req', route: 0, sinceTick: '100' }],
  ['snapshot_header', 'snapshot of tick 100, 260 bytes, not deflated', { type: 'snapshot', route: 0, tick: '100', total: 260, flags: 0 }],
  ['snapshot_header_deflate', 'deflate flag set', { type: 'snapshot', route: 0, tick: '100', total: 77, flags: 1 }],
  ['chunk_first', 'chunk 0 of 3', { type: 'chunk', route: 0, id: 7, index: 0, count: 3, bytes: '000102' }],
  ['chunk_empty_body', 'a chunk may carry zero bytes (empty payload = one empty chunk)', { type: 'chunk', route: 0, id: 8, index: 0, count: 1, bytes: '' }],
  ['raw_broadcast', 'raw payload, route 0 = broadcast / for host', { type: 'raw', route: 0, bytes: '68656c6c6f' }],
  ['raw_to_peer', 'sent to host with destination 3', { type: 'raw', route: 3, bytes: 'ff' }],
  ['ping', 'on the fast channel', { type: 'ping', route: 0, n: 1, t: 123456 }],
  ['pong', 'echoes n and t of the ping', { type: 'pong', route: 0, n: 1, t: 123456 }],
  ['host_claim', 'migration claim, epoch 1, new host 2, at tick 777', { type: 'host_claim', route: 0, epoch: 1, hostId: 2, tick: '777' }],
  ['voice_two_packets', 'speaker 3 (route), seq 9, two 20 ms frames, not end of burst', { type: 'voice', route: 3, seq: 9, flags: 0, packets: [{ opus: b(0xf8, 0xff, 0xfe) }, { opus: b(0xf8, 0x01) }] }],
  ['voice_end_of_burst', 'flags bit0 = end of talk burst, one frame', { type: 'voice', route: 3, seq: 65535, flags: 1, packets: [{ opus: b(0xf8, 0xff, 0xfe) }] }],
  ['voice_silence', 'zero packets (end-of-burst marker only)', { type: 'voice', route: 5, seq: 0, flags: 1, packets: [] }],
  ['chat_send', 'sender -> host: id is the sender client counter, ts 0, host stamps both', { type: 'chat', route: 0, id: 1, ts: '0', text: 'hello' }],
  ['chat_stamped', 'host -> all: route = sender (peerId 2)', { type: 'chat', route: 2, id: 17, ts: '1761264000123', text: 'gg wp' }],
  ['chat_utf8', 'multi-byte UTF-8 (length is in bytes)', { type: 'chat', route: 2, id: 18, ts: '1761264001000', text: 'café ☕ 😀' }],
  ['chat_history_empty', 'new joiner, nothing said yet', { type: 'chat_history', route: 0, lines: [] }],
  ['chat_history_two', 'two lines', { type: 'chat_history', route: 0, lines: [{ peerId: 1, id: 1, ts: '1761264000000', text: 'welcome' }, { peerId: 2, id: 2, ts: '1761264005000', text: 'hi!' }] }],
  ['chat_reject_rate', 'reason 1 = rate', { type: 'chat_reject', route: 0, id: 9, reason: 1 }],
  ['chat_reject_length', 'reason 2 = length', { type: 'chat_reject', route: 0, id: 10, reason: 2 }],
  ['chat_reject_muted', 'reason 3 = muted_by_host', { type: 'chat_reject', route: 0, id: 11, reason: 3 }],
  ['pause_request_pause', 'joiner -> host: pause the match (paused 1)', { type: 'pause_request', route: 0, paused: 1 }],
  ['pause_request_resume', 'joiner -> host: resume (paused 0)', { type: 'pause_request', route: 0, paused: 0 }],
  ['pause_state_paused', 'host -> all: paused by peer 2', { type: 'pause_state', route: 0, paused: 1, byPeer: 2, flags: 0 }],
  ['pause_state_pauser_left', 'host -> all: the pauser left, host (peer 1) holds the pause (flags bit 0)', { type: 'pause_state', route: 0, paused: 1, byPeer: 1, flags: 1 }],
  ['pause_state_resumed', 'host -> all: resumed by peer 300', { type: 'pause_state', route: 0, paused: 0, byPeer: 300, flags: 0 }],
  ['pause_refuse_not_in_game', 'host -> requester: reason 1 = not_in_game', { type: 'pause_refuse', route: 0, paused: 1, reason: 1 }],
  ['pause_refuse_rate', 'reason 2 = rate_limited', { type: 'pause_refuse', route: 0, paused: 0, reason: 2 }],
  ['pause_refuse_not_allowed', 'reason 3 = not_allowed', { type: 'pause_refuse', route: 0, paused: 0, reason: 3 }],
];
const frames = msgs.map(([name, desc, msg]) => ({ name, desc, msg, hex: hex(encode(fromJson(msg))) }));
// max-size frame: raw with 16381 bytes of payload = exactly 16384.
frames.push({ name: 'raw_max_frame', desc: 'exactly 16384 bytes (the limit); body bytes all 0xab', msg: { type: 'raw', route: 0, bytes: rep(0xab, MAX_FRAME - 3) }, hex: hex(encode(fromJson({ type: 'raw', route: 0, bytes: rep(0xab, MAX_FRAME - 3) }))) });
write('frames.json', { desc: 'Every data-channel frame type. msg is the JSON form (i64/u64 decimal strings, bytes hex); hex is the full wire frame.', vectors: frames });

// ---- chunking.json ----
const payload = new Uint8Array(40000).map((_, i) => (i * 7 + 3) & 0xff);
const chunks = chunkPayload(0xdeadbeef, payload, 16000);
const small = Uint8Array.of(1, 2, 3, 4, 5, 6, 7);
const smallChunks = chunkPayload(5, small, 3);
// A large inner frame (a `frame` with one 20000-byte command) travels as chunks whose reassembly is a complete frame.
const bigInnerBytes = new Uint8Array(20000).map((_, i) => i & 0xff);
const bigInner = new Uint8Array(3 + 8 + 2 + 2 + 2 + bigInnerBytes.length);
{
  const dv = new DataView(bigInner.buffer);
  dv.setUint8(0, 0x11); dv.setUint16(1, 0, true); dv.setBigInt64(3, 99n, true); dv.setUint16(11, 1, true); dv.setUint16(13, 2, true); dv.setUint16(15, bigInnerBytes.length, true);
  bigInner.set(bigInnerBytes, 17);
}
const snapDefl = deflateSync(Uint8Array.from({ length: 260 }, (_, i) => (i % 16 === 0 ? 1 : 0)));
write('chunking.json', {
  desc: 'Chunking: split bytes into chunk frames sharing one id; reassemble by index (any order, duplicates ignored). Each chunk frame is a complete wire frame.',
  maxFrame: MAX_FRAME, defaultChunkSize: 16000, maxChunkBody: 16373,
  vectors: [
    { name: 'small_3byte_chunks', payload: hex(small), chunkSize: 3, id: 5, chunks: smallChunks.map((c) => hex(encode(c))) },
    { name: 'forty_kb_default', payload_len: payload.length, payload_pattern: 'byte[i] = (i*7+3) & 0xff', chunkSize: 16000, id: 3735928559, chunk_count: chunks.length,
      chunk_lengths: chunks.map((c) => encode(c).length), chunk_hex_prefix_16: chunks.map((c) => hex(encode(c)).slice(0, 32)), payload_fnv1a64: fnv1a64(payload).toString() },
    { name: 'empty_payload', payload: '', chunkSize: 16000, id: 1, chunks: chunkPayload(1, new Uint8Array(0)).map((c) => hex(encode(c))) },
    { name: 'oversized_inner_frame', desc: 'a 20017-byte frame (type 0x11) sent as chunks; reassembled bytes decode as a frame', payload_len: bigInner.length, chunkSize: 16000, id: 12, payload_fnv1a64: fnv1a64(bigInner).toString(), chunk_count: 2 },
    { name: 'snapshot_deflate', desc: 'snapshot flags=1: payload is a zlib stream (RFC 1950, what CompressionStream("deflate") and ZLibStream produce) of the 260-byte gridpaint snapshot; header total = payload length',
      snapshot_header_hex: hex(encode({ type: 'snapshot', route: 0, tick: 100n, total: snapDefl.length, flags: 1 })), payload: hex(snapDefl), inflated_len: 260, id: 21, chunks: chunkPayload(21, snapDefl, 40).map((c) => hex(encode(c))) },
  ],
});

// ---- invalid.json: decoders must reject these (error kinds are informative) ----
const f = (name) => frames.find((v) => v.name === name).hex;
write('invalid.json', {
  desc: 'Frames a decoder must reject (throw / return error). Unknown type ids are NOT invalid: they decode as unknown and are ignored.',
  vectors: [
    { name: 'empty', hex: '', error: 'too_short' },
    { name: 'header_truncated', hex: '0100', error: 'too_short' },
    { name: 'hi_truncated', hex: f('hi').slice(0, -2), error: 'too_short' },
    { name: 'hi_trailing', hex: f('hi') + '00', error: 'trailing' },
    { name: 'frame_count_lies', hex: f('frame_empty').slice(0, -4) + '0300', error: 'too_short' },
    { name: 'cmd_len_exceeds', hex: '10000001000000ff00ab', error: 'too_short' },
    { name: 'chat_bad_utf8', hex: '600000' + '01000000' + '0000000000000000' + '0200' + 'c328', error: 'bad_utf8' },
    { name: 'chat_trailing', hex: f('chat_send') + '00', error: 'trailing' },
    { name: 'pause_state_truncated', hex: f('pause_state_paused').slice(0, -2), error: 'too_short' },
    { name: 'pause_request_trailing', hex: f('pause_request_pause') + '00', error: 'trailing' },
    { name: 'voice_truncated_packet', hex: '500300' + '0900' + '00' + '01' + '0500' + 'f8', error: 'too_short' },
    { name: 'oversize_frame', hex: '200000' + rep(0, MAX_FRAME - 2), error: 'too_long' },
  ],
  unknown_type_ok: [{ name: 'type_0x99', hex: '990700aabb', decodesAs: { type: 'unknown', typeId: 153, route: 7, body: 'aabb' } }],
});

// ---- turn-rest.json ----
const secret = 'keepalive-test-secret';
const tv = [
  { username: '1761267600:c7', secret },
  { username: '2000000000:p42', secret },
  { username: '1761267600:c7', secret: 'another secret' },
].map((v) => ({ ...v, credential: credential(v.secret, v.username) }));
write('turn-rest.json', {
  desc: 'credential = base64(HMAC-SHA1(secret as UTF-8, username as UTF-8)). username = <expiry unix seconds>:<userId>, userId has no colon.',
  vectors: tv,
  mint: { secret, userId: 'c7', nowSeconds: 1761264000, ttl: 3600, expectUsername: '1761267600:c7', expectCredential: tv[0].credential },
});

// ---- gridpaint.json ----
let s = 20261023;
const rnd = (n) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 8) % n; };
const log = [];
for (let t = 1; t <= 300; t++) {
  const k = rnd(6) === 0 ? 2 : (rnd(5) === 0 ? 1 : 0);
  for (let i = 0; i < k; i++) log.push({ tick: t, peerId: 1 + rnd(4), x: rnd(16), y: rnd(16) });
  if (t === 150) log.push({ tick: t, peerId: 2, x: 16, y: 3 }); // out-of-range paint: ignored
}
log.sort((a, b2) => a.tick - b2.tick); // stable: preserves listed order within a tick
const golden = [];
for (const code of ['7HQ4K2', '000000', 'ZZZZZZ']) {
  const hashes = runLog(code, log, [0, 1, 20, 100, 400]);
  golden.push({ code, seed: seedFromCode(code), hashes });
}
const g = new Gridpaint('7HQ4K2');
const by = new Map();
for (const c of log) { if (!by.has(c.tick)) by.set(c.tick, []); by.get(c.tick).push({ peerId: c.peerId, bytes: paintCmd(c.x, c.y) }); }
for (let t = 1; t <= 100; t++) g.step(t, by.get(t) ?? []);
const snap100 = g.snapshot();
write('gridpaint.json', {
  desc: 'Gridpaint goldens. log = commands as delivered in frames (listed in frame order). hashes: tick -> FNV-1a 64 decimal after processing that tick (tick 0 = empty grid).',
  commandLog: log,
  golden,
  snapshotAtTick100_code_7HQ4K2: { tick: 100, bytes: hex(snap100), hash: g.hash().toString() },
});

// ---- joincode.json: dc1 join codes (docs/design/direct-ip.md s.2a) ----
const jcValid = [
  ['127.0.0.1', 47810], ['192.168.1.20', 47810], ['10.0.0.188', 47810], ['203.0.113.7', 47810],
  ['0.0.0.0', 1], ['255.255.255.255', 65535], ['100.101.102.103', 41641], ['8.8.8.8', 34197],
].map(([ip, port]) => ({ ip, port, code: jc.encode(ip, port) }));
const firstRaw = jc.encodeRaw('203.0.113.7', 47810);
const typos = [];
for (let i = 0; i < jc.LENGTH; i++)
  for (const c of ALPHABET) if (c !== firstRaw[i]) typos.push(firstRaw.slice(0, i) + c + firstRaw.slice(i + 1));
const v2 = (() => { // a well-formed code with version 10: must decode as unknown_version, not as an address
  const data = (2n << 48n) | (BigInt(0xcb007107) << 16n) | 47810n;
  let v = (data << 5n) | BigInt(jc.crc5(data, 50)), s = '';
  for (let i = 0; i < jc.LENGTH; i++) { s = ALPHABET[Number(v & 31n)] + s; v >>= 5n; }
  return s;
})();
write('joincode.json', {
  desc: 'dc1 join codes (docs/design/direct-ip.md s.2a): version:2 | ipv4:32 | port:16 | crc5(poly 0x05, init 0, MSB first, over the 50 bits before it). Display 4-4-3 with hyphens. Version 1 (rooms) is version:2 = 1 | room:48 | crc5 (spec/nostr-signaling.md s.1); decode gives { room } as 12 lower-case hex digits.',
  valid: jcValid,
  aliases: [
    { input: jcValid[3].code.toLowerCase(), ip: '203.0.113.7', port: 47810, note: 'lower case' },
    { input: jcValid[3].code.replace(/-/g, ' '), ip: '203.0.113.7', port: 47810, note: 'spaces instead of hyphens' },
    { input: jcValid[3].code.replace(/-/g, ''), ip: '203.0.113.7', port: 47810, note: 'no separators' },
    { input: jcValid[3].code.replace(/1/g, 'l').replace(/0/g, 'o'), ip: '203.0.113.7', port: 47810, note: 'l for 1, o for 0' },
  ],
  invalid: [
    { input: '', error: 'bad_code' },
    { input: firstRaw.slice(0, 10), error: 'bad_code', note: 'too short' },
    { input: firstRaw + '0', error: 'bad_code', note: 'too long' },
    { input: firstRaw.slice(0, 10) + 'U', error: 'bad_code', note: 'U is not in the alphabet' },
    { input: group(v2), error: 'unknown_version', note: 'version bits 10, valid crc' },
  ],
  rooms: ['000000000000', '0123456789ab', 'ffffffffffff', 'a1b2c3d4e5f6', '7fffffffffff'].map((room) => ({ room, code: jc.encodeRoom(room) })),
  roomAliases: [
    { input: jc.encodeRoom('a1b2c3d4e5f6').toLowerCase(), room: 'a1b2c3d4e5f6', note: 'lower case' },
    { input: jc.encodeRoom('a1b2c3d4e5f6').replace(/-/g, ' '), room: 'a1b2c3d4e5f6', note: 'spaces instead of hyphens' },
  ],
  singleTypos: { of: jc.group(firstRaw), error: 'bad_code', count: typos.length, inputs: typos },
});

// ---- nostr.json: Nostr signaling (spec/nostr-signaling.md) ----
{
  const nostr = await import('./nostr.mjs');
  const room = 'a1b2c3d4e5f6';
  const shown = jc.encodeRoom(room);
  const raw = jc.encodeRoomRaw(room);
  const { key, topic } = nostr.deriveKeys(raw);
  const frame = { v: 1, type: 'data', from: 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659', to: 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9', seq: 1, ack: 0, msgs: ['{"t":"hello"}', '{"t":"ping","n":1}'] };
  const plaintext = JSON.stringify(frame);
  const iv = '000102030405060708090a0b';
  const content = nostr.encrypt(key, plaintext, iv);
  const created = 1700000000;
  const tags = [['t', topic]];
  write('nostr.json', {
    desc: 'Nostr signaling vectors (spec/nostr-signaling.md). keys: HKDF-SHA256 of the 11 normalised code characters. crypto: AES-256-GCM with the given iv (a real sender draws a fresh one); content = base64(iv || ciphertext || tag). event: NIP-01 id of a kind 25050 event (sig is any valid BIP340 signature over the id). bip340: official BIP340 signing vectors (secretKey, auxRand, message -> signature).',
    keys: { code: shown, normalized: raw, room, ikm: raw, salt: 'onelobby-nostr-v1', key, topic },
    crypto: { key, iv, plaintext, content },
    event: { pubkey: frame.from, created_at: created, kind: 25050, tags, content, id: nostr.eventId(frame.from, created, 25050, tags, content) },
    bip340: nostr.BIP340,
  });
}

console.log('vectors written:', frames.length, 'frames');
