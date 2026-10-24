// Gridpaint reference implementation (DESIGN s.15.1, spec/demo-game.md). Pure, deterministic, no I/O.
import { normalize } from './codes.mjs';

export const W = 16;
export const H = 16;
export const GAME_ID = 'gridpaint';
export const NET_VERSION = '1';
export const OP_PAINT = 1;
export const PALETTE = ['#000000', '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0',
  '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#800000', '#aaffc3'];

export const colourOf = (peerId) => ((peerId - 1) % 15) + 1;

export function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function fnv1a64(bytes) {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h;
}

export function seedFromCode(code) {
  const c = normalize(code);
  if (!c) throw new Error(`bad lobby code: ${code}`);
  const s = fnv1a32(new TextEncoder().encode(c));
  return s === 0 ? 1 : s;
}

export function xorshift32(x) {
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  return x >>> 0;
}

export const DX = [0, 1, 0, -1]; // direction = rng % 4: 0 up, 1 right, 2 down, 3 left
export const DY = [-1, 0, 1, 0];

export class Gridpaint {
  constructor(code) {
    this.tick = 0;
    this.rng = seedFromCode(code);
    this.grid = new Uint8Array(W * H);
  }

  // Apply one tick. `cmds` = [{peerId, bytes}] in frame order. Returns the hash after the tick.
  step(tick, cmds = []) {
    if (BigInt(tick) !== BigInt(this.tick) + 1n) throw new Error(`expected tick ${this.tick + 1}, got ${tick}`);
    for (const c of cmds) this.apply(c.peerId, c.bytes);
    this.spread();
    this.tick = Number(tick);
    return this.hash();
  }

  apply(peerId, bytes) {
    if (bytes.length !== 3 || bytes[0] !== OP_PAINT) return; // malformed: ignored, still deterministic
    const x = bytes[1], y = bytes[2];
    if (x >= W || y >= H) return;
    this.grid[y * W + x] = colourOf(peerId);
  }

  spread() {
    const old = Uint8Array.from(this.grid); // copy (Buffer#slice would alias)
    for (let i = 0; i < W * H; i++) {
      if (old[i] === 0) continue;
      this.rng = xorshift32(this.rng);
      const d = this.rng % 4;
      const x = (i % W) + DX[d], y = Math.floor(i / W) + DY[d];
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      this.grid[y * W + x] = old[i];
    }
  }

  hash() { return fnv1a64(this.grid); }

  // Snapshot = rng:u32 LE + 256 grid bytes (tick travels in the snapshot frame header).
  snapshot() {
    const o = new Uint8Array(4 + W * H);
    new DataView(o.buffer).setUint32(0, this.rng, true);
    o.set(this.grid, 4);
    return o;
  }

  static restore(tick, bytes) {
    if (bytes.length !== 4 + W * H) throw new Error('bad snapshot length');
    const g = new Gridpaint('000000');
    g.tick = Number(tick);
    g.rng = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    g.grid = Uint8Array.from(bytes.subarray(4));
    return g;
  }
}

export const paintCmd = (x, y) => Uint8Array.of(OP_PAINT, x, y);

// Run a command log [{tick, peerId, x, y}] (listed in frame order) and return {tick: hashString} for the wanted ticks.
export function runLog(code, log, wantTicks, lastTick = Math.max(...wantTicks)) {
  const g = new Gridpaint(code);
  const out = {};
  const by = new Map();
  for (const c of log) { if (!by.has(c.tick)) by.set(c.tick, []); by.get(c.tick).push({ peerId: c.peerId, bytes: paintCmd(c.x, c.y) }); }
  if (wantTicks.includes(0)) out[0] = g.hash().toString();
  for (let t = 1; t <= lastTick; t++) {
    const h = g.step(t, by.get(t) ?? []);
    if (wantTicks.includes(t)) out[t] = h.toString();
  }
  return out;
}
