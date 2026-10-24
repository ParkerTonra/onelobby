/**
 * Gridpaint: the shared demo game (spec/demo-game.md). Pure and deterministic; ported from spec/reference/gridpaint.mjs.
 * Shipped in the library so the browser demo, the tests and the conformance adapter share one implementation.
 */
import { normalizeCode } from "./crockford.js";

export const GRID_W = 16;
export const GRID_H = 16;
export const OP_PAINT = 1;
export const PALETTE = [
  "#000000", "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0",
  "#f032e6", "#bcf60c", "#fabebe", "#008080", "#e6beff", "#9a6324", "#800000", "#aaffc3",
];
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

export const colourOf = (peerId: number): number => ((peerId - 1) % 15) + 1;

export function fnv1a32(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function fnv1a64(bytes: Uint8Array): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

export function seedFromCode(code: string): number {
  const c = normalizeCode(code);
  if (!c) throw new Error(`bad lobby code: ${code}`);
  const s = fnv1a32(new TextEncoder().encode(c));
  return s === 0 ? 1 : s;
}

export function xorshift32(x: number): number {
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  return x >>> 0;
}

export const paintCmd = (x: number, y: number): Uint8Array => Uint8Array.of(OP_PAINT, x, y);

export class Gridpaint {
  tick = 0;
  rng: number;
  grid = new Uint8Array(GRID_W * GRID_H);

  constructor(code: string) {
    this.rng = seedFromCode(code);
  }

  /** Apply frame `tick` (must be current + 1). Returns the hash after the tick. */
  step(tick: number, cmds: ReadonlyArray<{ peerId: number; bytes: Uint8Array }> = []): bigint {
    if (tick !== this.tick + 1) throw new Error(`expected tick ${this.tick + 1}, got ${tick}`);
    for (const c of cmds) this.apply(c.peerId, c.bytes);
    this.spread();
    this.tick = tick;
    return this.hash();
  }

  apply(peerId: number, bytes: Uint8Array): void {
    if (bytes.length !== 3 || bytes[0] !== OP_PAINT) return;
    const x = bytes[1];
    const y = bytes[2];
    if (x >= GRID_W || y >= GRID_H) return;
    this.grid[y * GRID_W + x] = colourOf(peerId);
  }

  private spread(): void {
    const old = this.grid.slice();
    for (let i = 0; i < GRID_W * GRID_H; i++) {
      if (old[i] === 0) continue;
      this.rng = xorshift32(this.rng);
      const d = this.rng % 4;
      const x = (i % GRID_W) + DX[d];
      const y = Math.floor(i / GRID_W) + DY[d];
      if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) continue;
      this.grid[y * GRID_W + x] = old[i];
    }
  }

  hash(): bigint {
    return fnv1a64(this.grid);
  }

  /** rng:u32 LE + 256 grid bytes. */
  snapshot(): Uint8Array {
    const o = new Uint8Array(4 + GRID_W * GRID_H);
    new DataView(o.buffer).setUint32(0, this.rng, true);
    o.set(this.grid, 4);
    return o;
  }

  restore(tick: number, bytes: Uint8Array): void {
    if (bytes.length !== 4 + GRID_W * GRID_H) throw new Error("bad snapshot length");
    this.tick = tick;
    this.rng = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    this.grid = bytes.slice(4);
  }
}
