// Gridpaint: the starter game. Pure and deterministic (no wall clock, no Math.random, no I/O), so it can run in
// lockstep: every player applies the same commands in the same order and gets the same grid.
// Rules: OneLobby spec/demo-game.md. Swap this file for your own game; keep step(), snapshot(), restore() and hash().

export const W = 16;
export const H = 16;
export const OP_PAINT = 1;
export const PALETTE = [
  "#000000", "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0",
  "#f032e6", "#bcf60c", "#fabebe", "#008080", "#e6beff", "#9a6324", "#800000", "#aaffc3",
];
const DX = [0, 1, 0, -1]; // rng % 4: up, right, down, left
const DY = [-1, 0, 1, 0];

/** A player's colour from their seat number. */
export const colourOf = (peerId) => ((peerId - 1) % 15) + 1;

/** The command players send: paint cell (x, y). OneLobby carries these bytes without looking inside. */
export const paintCmd = (x, y) => Uint8Array.of(OP_PAINT, x, y);

function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function fnv1a64(bytes) {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

/** The random seed comes from the lobby code, so every player starts from the same number. */
function seedFromCode(code) {
  const s = fnv1a32(new TextEncoder().encode(String(code).replace(/[\s-]/g, "").toUpperCase()));
  return s === 0 ? 1 : s;
}

function xorshift32(x) {
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  return x >>> 0;
}

export class Gridpaint {
  constructor(code) {
    this.tick = 0;
    this.rng = seedFromCode(code);
    this.grid = new Uint8Array(W * H);
  }

  /** Apply frame `tick` (must be the next one). `cmds` = [{ peerId, bytes }] in frame order. Returns the hash. */
  step(tick, cmds = []) {
    if (tick !== this.tick + 1) throw new Error(`expected tick ${this.tick + 1}, got ${tick}`);
    for (const c of cmds) this.apply(c.peerId, c.bytes);
    this.spread();
    this.tick = tick;
    return this.hash();
  }

  apply(peerId, bytes) {
    if (bytes.length !== 3 || bytes[0] !== OP_PAINT) return; // malformed: ignored, still deterministic
    const x = bytes[1];
    const y = bytes[2];
    if (x >= W || y >= H) return;
    this.grid[y * W + x] = colourOf(peerId);
  }

  spread() {
    const old = this.grid.slice();
    for (let i = 0; i < W * H; i++) {
      if (old[i] === 0) continue;
      this.rng = xorshift32(this.rng);
      const d = this.rng % 4;
      const x = (i % W) + DX[d];
      const y = Math.floor(i / W) + DY[d];
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      this.grid[y * W + x] = old[i];
    }
  }

  hash() {
    return fnv1a64(this.grid);
  }

  /** rng (u32 little endian) + the grid: what a late joiner needs. */
  snapshot() {
    const o = new Uint8Array(4 + W * H);
    new DataView(o.buffer).setUint32(0, this.rng, true);
    o.set(this.grid, 4);
    return o;
  }

  restore(tick, bytes) {
    if (bytes.length !== 4 + W * H) throw new Error("bad snapshot length");
    this.tick = tick;
    this.rng = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    this.grid = bytes.slice(4);
  }
}
