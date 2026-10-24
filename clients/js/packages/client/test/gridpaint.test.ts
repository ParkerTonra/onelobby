import { describe, expect, it } from "vitest";
import { Gridpaint, fnv1a64, paintCmd, seedFromCode } from "../src/index.js";
import { hex, specJson, unhex } from "./spec.js";

const gp = specJson("vectors/gridpaint.json");

function replay(code: string, until: number, from?: Gridpaint): Map<number, bigint> {
  const g = from ?? new Gridpaint(code);
  const by = new Map<number, { peerId: number; bytes: Uint8Array }[]>();
  for (const c of gp.commandLog) {
    if (!by.has(c.tick)) by.set(c.tick, []);
    by.get(c.tick)!.push({ peerId: c.peerId, bytes: paintCmd(c.x, c.y) });
  }
  const out = new Map<number, bigint>();
  if (!from) out.set(0, g.hash());
  for (let t = g.tick + 1; t <= until; t++) out.set(t, g.step(t, by.get(t) ?? []));
  return out;
}

describe("gridpaint vs spec/vectors/gridpaint.json", () => {
  it("fnv anchors", () => {
    expect(fnv1a64(new Uint8Array(0))).toBe(0xcbf29ce484222325n);
    expect(fnv1a64(new TextEncoder().encode("a"))).toBe(0xaf63dc4c8601ec8cn);
    expect(fnv1a64(new TextEncoder().encode("foobar"))).toBe(0x85944171f73967e8n);
  });
  for (const g of gp.golden) {
    it(`code ${g.code}: seed and hashes at ticks ${Object.keys(g.hashes).join(",")}`, () => {
      expect(seedFromCode(g.code)).toBe(g.seed);
      const hashes = replay(g.code, 400);
      for (const [t, h] of Object.entries(g.hashes)) expect(hashes.get(Number(t))!.toString()).toBe(h);
    });
  }
  it("restoring the tick-100 snapshot reproduces the tick-400 hash", () => {
    const s = gp.snapshotAtTick100_code_7HQ4K2;
    const g = new Gridpaint("7HQ4K2");
    g.restore(s.tick, unhex(s.bytes));
    const want = gp.golden.find((x: any) => x.code === "7HQ4K2").hashes["400"];
    expect(replay("7HQ4K2", 400, g).get(400)!.toString()).toBe(want);
  });
  it("our own snapshot at tick 100 equals the spec bytes", () => {
    const g = new Gridpaint("7HQ4K2");
    replay("7HQ4K2", 100, g);
    expect(hex(g.snapshot())).toBe(gp.snapshotAtTick100_code_7HQ4K2.bytes);
  });
  it("refuses a tick gap", () => {
    expect(() => new Gridpaint("7HQ4K2").step(3)).toThrow();
  });
});
