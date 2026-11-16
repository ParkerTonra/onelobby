import { describe, expect, it } from "vitest";
import { NetReader, NetWriter, Quantize } from "../src/index.js";
import {
  ByteWriter, ReplicationError, decodeEvent, decodeInput, decodeSnapshot, decodeStreamEvent, describeReplication, encodeEvent, encodeInput,
  encodeSnapshot, encodeStreamEvent, fromHex, peekSnapshot, toHex, type Ent, type World,
} from "../src/internals.js";
import { NetworkClock } from "../src/index.js";
import { rng } from "./replication-rig.js";
import { specJson } from "./spec.js";

const V = specJson("vectors/replication.json");
const f32 = Math.fround;

const worldOf = (tick: number, arr: [number, number, number, string][]): World => ({
  tick,
  ents: arr.map(([id, type, owner, st]) => ({ id, type, owner, state: fromHex(st) })),
});
const baselineOf = (b: { tick: number; world: [number, number, number, string][] } | null): World | null => (b ? worldOf(b.tick, b.world) : null);
const num = (v: number | string): number => (v === "NaN" ? NaN : v === "Infinity" ? Infinity : v === "-Infinity" ? -Infinity : (v as number));

function expectSameWorld(a: World, b: World): void {
  expect(a.tick).toBe(b.tick);
  expect(a.ents.map((e) => [e.id, e.type, e.owner, toHex(e.state)])).toEqual(b.ents.map((e) => [e.id, e.type, e.owner, toHex(e.state)]));
}

describe("replication vectors: snapshots", () => {
  for (const v of V.snapshots) {
    it(v.name, () => {
      const cur = worldOf(v.tick, v.world);
      const baseline = baselineOf(v.baseline);
      const bytes = encodeSnapshot(cur, baseline, v.lastInputSeq);
      expect(toHex(bytes)).toBe(v.hex);
      const h = peekSnapshot(bytes);
      expect(h).toEqual({ tick: v.tick, baselineTick: baseline?.tick ?? 0, lastInput: v.lastInputSeq });
      expectSameWorld(decodeSnapshot(bytes, baseline), cur);
      expectSameWorld(decodeSnapshot(fromHex(v.hex), baseline), cur);
    });
  }
});

describe("replication vectors: inputs, events, stream events", () => {
  for (const v of V.inputs) {
    it(v.name, () => {
      const entries = (v.inputs as [number, string][]).map(([view256, hex]) => ({ view256, bytes: fromHex(hex) }));
      const bytes = encodeInput(v.ack, v.newestSeq, entries);
      expect(toHex(bytes)).toBe(v.hex);
      const d = decodeInput(bytes);
      expect(d.ack).toBe(v.ack);
      expect(d.newestSeq).toBe(v.newestSeq);
      expect(d.inputs.map((i) => [i.view256, toHex(i.bytes)])).toEqual(v.inputs);
      expect(d.inputs.map((i) => i.seq)).toEqual(entries.map((_, i) => v.newestSeq - i));
    });
  }
  for (const v of V.events) {
    it(v.name, () => {
      const bytes = encodeEvent(v.tick, fromHex(v.payloadHex));
      expect(toHex(bytes)).toBe(v.hex);
      const d = decodeEvent(bytes);
      expect(d.tick).toBe(v.tick);
      expect(toHex(d.payload)).toBe(v.payloadHex);
    });
  }
  for (const v of V.streamEvents) {
    it(v.name, () => {
      const bytes = encodeStreamEvent(v.tick, v.stream, v.seq, fromHex(v.payloadHex));
      expect(toHex(bytes)).toBe(v.hex);
      const d = decodeStreamEvent(bytes);
      expect([d.tick, d.stream, d.seq, toHex(d.payload)]).toEqual([v.tick, v.stream, v.seq, v.payloadHex]);
    });
  }
});

describe("replication vectors: invalid", () => {
  const seen = new Set<string>();
  for (const v of V.invalid) {
    it(`${v.name} -> ${v.error}`, () => {
      const bytes = fromHex(v.hex);
      const baseline = baselineOf(v.baseline);
      const act = () =>
        v.kind === "input" ? decodeInput(bytes)
        : v.kind === "event" ? decodeEvent(bytes)
        : v.kind === "streamEvent" ? decodeStreamEvent(bytes)
        : decodeSnapshot(bytes, baseline);
      let err: unknown;
      try {
        act();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ReplicationError);
      expect((err as ReplicationError).code).toBe(v.error);
      expect((err as ReplicationError).message).toBe(v.error);
      seen.add(v.error);
    });
  }
  it("names every error of the spec at least once", () => {
    const names = ["too_short", "trailing", "range", "varint", "id", "delta", "despawn", "op", "tick", "baseline", "full", "seq", "stream_0", "seq_0"];
    expect([...new Set(V.invalid.map((v: { error: string }) => v.error))].sort()).toEqual([...names].sort());
  });
});

describe("replication vectors: state bits", () => {
  type Op = { op: string; v?: any; n?: number; min?: number; max?: number; bits?: number; repeat?: number; read?: any };
  const write = (w: NetWriter, o: Op) => {
    switch (o.op) {
      case "bits": return w.writeBits(o.v, o.n!);
      case "bool": return w.writeBool(o.v);
      case "byte": return w.writeByte(o.v);
      case "u16": return w.writeUInt16(o.v);
      case "u32": return w.writeUInt32(o.v);
      case "i32": return w.writeInt32(o.v);
      case "float": return w.writeFloat(o.v);
      case "q": return w.writeQuantized(o.v, o.min!, o.max!, o.bits!);
      case "angle": return w.writeAngle(o.v, o.bits!);
      case "quat": return w.writeQuaternion(o.v[0], o.v[1], o.v[2], o.v[3], o.bits);
    }
    throw new Error("op " + o.op);
  };
  const read = (r: NetReader, o: Op): unknown => {
    switch (o.op) {
      case "bits": return r.readBits(o.n!);
      case "bool": return r.readBool();
      case "byte": return r.readByte();
      case "u16": return r.readUInt16();
      case "u32": return r.readUInt32();
      case "i32": return r.readInt32();
      case "float": return r.readFloat();
      case "q": return r.readQuantized(o.min!, o.max!, o.bits!);
      case "angle": return r.readAngle(o.bits!);
      case "quat": { const q = r.readQuaternion(o.bits); return [q.x, q.y, q.z, q.w]; }
    }
    throw new Error("op " + o.op);
  };
  for (const v of V.stateBits) {
    it(v.name, () => {
      if (v.ops) {
        const w = new NetWriter();
        for (const o of v.ops as Op[]) for (let i = 0; i < (o.repeat ?? 1); i++) write(w, o);
        expect(toHex(w.toBytes())).toBe(v.hex);
        expect(w.bitCount).toBe(v.bits);
        expect(w.byteCount).toBeLessThanOrEqual(255);
      }
      const r = new NetReader(fromHex(v.hex));
      for (const o of v.reads as Op[]) {
        for (let i = 0; i < (o.repeat ?? 1); i++) {
          const got = read(r, o);
          const want = o.op === "float" || o.op === "q" || o.op === "angle" ? f32(o.read) : o.op === "quat" ? o.read.map(f32) : o.read;
          expect(got).toEqual(want);
        }
      }
      expect(r.overrun).toBe(v.overrun);
    });
  }
});

describe("replication vectors: quantize", () => {
  for (const v of V.quantize) {
    it(v.name, () => {
      if (v.fn === "float") {
        const q = Quantize.float(num(v.value), v.min, v.max, v.bits);
        expect(q).toBe(v.q);
        expect(Quantize.dequantize(q, v.min, v.max, v.bits)).toBe(f32(v.back));
      } else if (v.fn === "angle") {
        const q = Quantize.angle(num(v.value), v.bits);
        expect(q).toBe(v.q);
        expect(Quantize.angleFrom(q, v.bits)).toBe(f32(v.back));
      } else {
        const [x, y, z, w] = v.value as number[];
        const q = Quantize.smallestThree(x, y, z, w, v.bits);
        expect(q.largest).toBe(v.largest);
        expect([q.a, q.b, q.c]).toEqual(v.q);
        const b = Quantize.fromSmallestThree(q.largest, q.a, q.b, q.c, v.bits);
        expect([b.x, b.y, b.z, b.w]).toEqual((v.back as number[]).map(f32));
      }
    });
  }
});

describe("replication vectors: describe", () => {
  for (const v of V.describe) {
    it(v.name, () => {
      expect(describeReplication(fromHex(v.hex), baselineOf(v.baseline))).toEqual(v.json);
    });
  }
  it("never throws on garbage", () => {
    const r = rng(3);
    for (let i = 0; i < 300; i++) {
      const b = new Uint8Array(1 + Math.floor(r() * 30)).map(() => Math.floor(r() * 256));
      b[0] = 0x52;
      b[1] = 1;
      b[2] = 1 + Math.floor(r() * 4);
      expect(() => describeReplication(b)).not.toThrow();
    }
  });
});

describe("replication codec properties", () => {
  it("quantize round-trips within half a step", () => {
    const r = rng(5);
    for (let i = 0; i < 1000; i++) {
      const v = r() * 512 - 256;
      const back = Quantize.dequantize(Quantize.float(v, -256, 256, 16), -256, 256, 16);
      expect(Math.abs(back - v)).toBeLessThanOrEqual(512 / 65535 / 2 + 1e-4);
      const a = r() * 720 - 360;
      const ab = Quantize.angleFrom(Quantize.angle(a, 10), 10);
      const d = Math.abs((((ab - a) % 360) + 540) % 360 - 180);
      expect(d).toBeLessThanOrEqual(360 / 1024 / 2 + 1e-3);
    }
    expect(Quantize.bitsFor(-256, 256, 0.005)).toBe(17);
    expect(Quantize.bitsFor(0, 1023, 1)).toBe(10);
  });

  it("smallest-three quaternion is within Gaffer's precision", () => {
    const r = rng(9);
    for (let i = 0; i < 500; i++) {
      const c = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
      const len = Math.hypot(...c);
      const q = c.map((x) => f32(x / len));
      const w = new NetWriter();
      w.writeQuaternion(q[0], q[1], q[2], q[3]);
      expect(w.bitCount).toBe(29);
      const b = new NetReader(w.toBytes()).readQuaternion();
      expect(Math.abs(q[0] * b.x + q[1] * b.y + q[2] * b.z + q[3] * b.w)).toBeGreaterThan(0.999);
    }
  });

  it("a delta round-trips random worlds", () => {
    const r = rng(21);
    const rb = () => Uint8Array.from({ length: 1 + Math.floor(r() * 40) }, () => Math.floor(r() * 256));
    const w = new ByteWriter();
    const recs = new ByteWriter();
    let prev: World | null = null;
    let nextId = 1;
    let live: Ent[] = [];
    for (let tick = 1; tick < 300; tick++) {
      if (Math.floor(r() * 3) === 0) live.push({ id: nextId++, type: Math.floor(r() * 4), owner: Math.floor(r() * 5), state: rb() });
      if (live.length > 0 && Math.floor(r() * 5) === 0) live.splice(Math.floor(r() * live.length), 1);
      live = live.map((e) => {
        if (Math.floor(r() * 2) !== 0) return e;
        let s = e.state.slice();
        if (Math.floor(r() * 10) === 0) s = rb();
        else s[Math.floor(r() * s.length)] ^= 1 + Math.floor(r() * 255);
        return { ...e, type: Math.floor(r() * 20) === 0 ? 9 : e.type, state: s };
      });
      const cur: World = { tick, ents: live.map((e) => ({ ...e })) };
      const bytes = encodeSnapshot(cur, prev, tick, w, recs);
      expectSameWorld(decodeSnapshot(bytes, prev), cur);
      prev = Math.floor(r() * 4) === 0 ? null : cur;
    }
  });

  it("the clock runs fixed steps and drops a long stall", () => {
    let now = 0;
    const c = new NetworkClock(30, () => now);
    let ticks = 0;
    for (let f = 0; f < 60; f++) {
      now += 16;
      while (c.tryAdvance()) ticks++;
    }
    expect(ticks).toBeGreaterThanOrEqual(29);
    expect(ticks).toBeLessThanOrEqual(31);
    now += 5000;
    let burst = 0;
    while (c.tryAdvance()) burst++;
    expect(burst).toBe(c.maxCatchUp);
  });

  it("NetWriter rejects widths outside 1..32", () => {
    const w = new NetWriter();
    expect(() => w.writeBits(1, 0)).toThrow();
    expect(() => w.writeBits(1, 33)).toThrow();
    expect(() => new NetReader(new Uint8Array(1)).readBits(33)).toThrow();
  });
});
