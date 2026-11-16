/**
 * Bit-packed state writer/reader and the quantization functions (spec/replication.md "State bits", "Quantization").
 * Same packing and the same rounding as the C# reference: host and client run the same math, so a value the client
 * reads back is exactly `dequantize(quantize(v))` on both sides.
 */

const f32 = Math.fround;
const scratch = new DataView(new ArrayBuffer(4));

/** The 32 IEEE-754 bits of a float32. */
export function floatBits(v: number): number {
  scratch.setFloat32(0, v, true);
  return scratch.getUint32(0, true);
}

/** The float32 with these 32 bits. */
export function bitsFloat(bits: number): number {
  scratch.setUint32(0, bits >>> 0, true);
  return scratch.getFloat32(0, true);
}

function maxOf(bits: number): number {
  return 2 ** Math.min(bits, 32) - 1;
}

/** Round half away from zero (for non-negative input: floor, plus 1 when the fraction is at least a half). */
function roundHalfAway(x: number): number {
  const neg = x < 0;
  const a = neg ? -x : x;
  const r = Math.floor(a);
  const up = a - r >= 0.5 ? r + 1 : r;
  return neg ? -up : up;
}

/** Writes bits LSB first. One state is at most 255 bytes (2040 bits). Reuse one writer; do not keep it past `write`. */
export class NetWriter {
  private buf = new Uint8Array(64);
  private bits = 0;

  /** Bits written so far. */
  get bitCount(): number {
    return this.bits;
  }
  /** Bytes the state occupies (unused high bits of the last byte are zero). */
  get byteCount(): number {
    return (this.bits + 7) >> 3;
  }

  reset(): void {
    this.buf.fill(0, 0, this.byteCount);
    this.bits = 0;
  }

  /** Write the low `bits` (1..32) bits of `value`. */
  writeBits(value: number, bits: number): void {
    if (!Number.isInteger(bits) || bits < 1 || bits > 32) throw new RangeError("bits must be 1..32");
    let v = value >>> 0;
    if (bits < 32) v &= (2 ** bits - 1) >>> 0;
    const need = (this.bits + bits + 7) >> 3;
    if (need > this.buf.length) {
      const bigger = new Uint8Array(Math.max(need, this.buf.length * 2));
      bigger.set(this.buf);
      this.buf = bigger;
    }
    for (let i = 0; i < bits; i++) {
      if (((v >>> i) & 1) !== 0) this.buf[this.bits >> 3] |= 1 << (this.bits & 7);
      this.bits++;
    }
  }

  writeBool(v: boolean): void {
    this.writeBits(v ? 1 : 0, 1);
  }
  writeByte(v: number): void {
    this.writeBits(v, 8);
  }
  writeUInt16(v: number): void {
    this.writeBits(v, 16);
  }
  writeUInt32(v: number): void {
    this.writeBits(v, 32);
  }
  writeInt32(v: number): void {
    this.writeBits(v | 0, 32);
  }
  /** Full-precision float (32 bits). Prefer the quantized writers for anything that moves every tick. */
  writeFloat(v: number): void {
    this.writeBits(floatBits(v), 32);
  }
  /** Clamp to [min, max] and write in `bits` bits (see {@link Quantize.float}). */
  writeQuantized(v: number, min: number, max: number, bits: number): void {
    this.writeBits(Quantize.float(v, min, max, bits), bits);
  }
  /** An angle in degrees, wrapped to [0, 360), in `bits` bits. */
  writeAngle(degrees: number, bits: number): void {
    this.writeBits(Quantize.angle(degrees, bits), bits);
  }
  /** Unit quaternion, smallest-three: 2 bits index + 3 x `bitsPerComponent` (default 9: 29 bits). */
  writeQuaternion(x: number, y: number, z: number, w: number, bitsPerComponent = 9): void {
    const q = Quantize.smallestThree(x, y, z, w, bitsPerComponent);
    this.writeBits(q.largest, 2);
    this.writeBits(q.a, bitsPerComponent);
    this.writeBits(q.b, bitsPerComponent);
    this.writeBits(q.c, bitsPerComponent);
  }

  /** A copy of the bytes written. */
  toBytes(): Uint8Array {
    return this.buf.slice(0, this.byteCount);
  }
  /** @internal The bytes written, not copied: valid until the next write or reset. */
  view(): Uint8Array {
    return this.buf.subarray(0, this.byteCount);
  }
}

/** Reads what {@link NetWriter} wrote, in the same order. Reading past the end returns zero bits and sets `overrun`. */
export class NetReader {
  private buf: Uint8Array;
  private len: number;
  private bits = 0;
  /** True when a read went past the end of the state (a schema mismatch). */
  overrun = false;

  constructor(data: Uint8Array = new Uint8Array(0)) {
    this.buf = data;
    this.len = data.length;
  }

  reset(data: Uint8Array, length = data.length): void {
    this.buf = data;
    this.len = length;
    this.bits = 0;
    this.overrun = false;
  }

  readBits(bits: number): number {
    if (!Number.isInteger(bits) || bits < 1 || bits > 32) throw new RangeError("bits must be 1..32");
    let v = 0;
    for (let i = 0; i < bits; i++) {
      const byteIndex = this.bits >> 3;
      if (byteIndex >= this.len) {
        this.overrun = true;
        this.bits++;
        continue;
      }
      if (((this.buf[byteIndex] >> (this.bits & 7)) & 1) !== 0) v |= 1 << i;
      this.bits++;
    }
    return v >>> 0;
  }

  readBool(): boolean {
    return this.readBits(1) !== 0;
  }
  readByte(): number {
    return this.readBits(8);
  }
  readUInt16(): number {
    return this.readBits(16);
  }
  readUInt32(): number {
    return this.readBits(32);
  }
  readInt32(): number {
    return this.readBits(32) | 0;
  }
  readFloat(): number {
    return bitsFloat(this.readBits(32));
  }
  readQuantized(min: number, max: number, bits: number): number {
    return Quantize.dequantize(this.readBits(bits), min, max, bits);
  }
  readAngle(bits: number): number {
    return Quantize.angleFrom(this.readBits(bits), bits);
  }
  readQuaternion(bitsPerComponent = 9): { x: number; y: number; z: number; w: number } {
    const largest = this.readBits(2);
    const a = this.readBits(bitsPerComponent);
    const b = this.readBits(bitsPerComponent);
    const c = this.readBits(bitsPerComponent);
    return Quantize.fromSmallestThree(largest, a, b, c, bitsPerComponent);
  }
}

const INV_SQRT2 = f32(0.70710678);

/** Pure quantization functions (spec/replication.md "Quantization"); inputs are rounded to float32 first. */
export const Quantize = {
  /** Clamp `v` to [min, max] and map linearly onto 0 .. 2^bits - 1 (NaN becomes min), rounding half away from zero. */
  float(v: number, min: number, max: number, bits: number): number {
    v = f32(v);
    min = f32(min);
    max = f32(max);
    if (!(max > min)) throw new RangeError("max must be greater than min");
    if (Number.isNaN(v)) v = min;
    const t = (Math.min(Math.max(v, min), max) - min) / (max - min);
    return roundHalfAway(t * maxOf(bits)) + 0;
  },

  dequantize(q: number, min: number, max: number, bits: number): number {
    min = f32(min);
    max = f32(max);
    const m = maxOf(bits);
    return f32(min + ((max - min) * Math.min(q, m)) / m);
  },

  /** Bits needed to cover [min, max] with a step no larger than `precision`. */
  bitsFor(min: number, max: number, precision: number): number {
    const steps = Math.ceil((f32(max) - f32(min)) / f32(precision));
    let bits = 1;
    while (bits < 32 && maxOf(bits) < steps) bits++;
    return bits;
  },

  /** Degrees wrapped to [0, 360) mapped onto 0 .. 2^bits - 1 (360 wraps to 0). */
  angle(degrees: number, bits: number): number {
    let a = f32(degrees) % 360;
    if (a < 0) a += 360;
    const steps = maxOf(bits) + 1;
    return (roundHalfAway((a / 360) * steps) % steps) + 0;
  },

  angleFrom(q: number, bits: number): number {
    return f32((q * 360) / (maxOf(bits) + 1));
  },

  floatBits,
  bitsFloat,

  /** Smallest-three quaternion encoding. */
  smallestThree(x: number, y: number, z: number, w: number, bits: number): { largest: number; a: number; b: number; c: number } {
    const q = [f32(x), f32(y), f32(z), f32(w)];
    let len = Math.sqrt(f32(f32(f32(f32(q[0] * q[0]) + f32(q[1] * q[1])) + f32(q[2] * q[2])) + f32(q[3] * q[3])));
    if (len < 1e-6) {
      q[0] = 0;
      q[1] = 0;
      q[2] = 0;
      q[3] = 1;
      len = 1;
    }
    let largest = 0;
    for (let i = 0; i < 4; i++) {
      q[i] = f32(q[i] / len);
      if (Math.abs(q[i]) > Math.abs(q[largest])) largest = i;
    }
    const sign = q[largest] < 0 ? -1 : 1;
    const o: number[] = [];
    for (let i = 0; i < 4; i++) if (i !== largest) o.push(Quantize.float(q[i] * sign, -INV_SQRT2, INV_SQRT2, bits));
    return { largest, a: o[0], b: o[1], c: o[2] };
  },

  fromSmallestThree(largest: number, a: number, b: number, c: number, bits: number): { x: number; y: number; z: number; w: number } {
    const q = [0, 0, 0, 0];
    const src = [a, b, c];
    let k = 0;
    let sum = 0;
    const skip = largest & 3;
    for (let i = 0; i < 4; i++) {
      if (i === skip) continue;
      q[i] = Quantize.dequantize(src[k++], -INV_SQRT2, INV_SQRT2, bits);
      sum += f32(q[i] * q[i]);
    }
    q[skip] = f32(Math.sqrt(Math.max(0, 1 - sum)));
    return { x: q[0], y: q[1], z: q[2], w: q[3] };
  },
};

/** Small interpolation helpers for state schemas' `lerp`. */
export const NetMath = {
  lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  },
  /** Lerp, but return `b` when the two samples are more than `maxDistance` apart (a teleport is a jump, not a streak). */
  lerpOrSnap(a: number, b: number, t: number, maxDistance: number): number {
    return Math.abs(b - a) > maxDistance ? b : a + (b - a) * t;
  },
  /** Lerp between two angles in degrees along the shorter arc; result in [0, 360). */
  lerpAngle(a: number, b: number, t: number): number {
    let d = (b - a) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    const r = (a + d * t) % 360;
    return r < 0 ? r + 360 : r;
  },
};
