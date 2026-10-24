import { describe, expect, it } from "vitest";
import { CodecError, MAX_REASSEMBLED_BYTES } from "../src/codec.js";
import { Reassembler } from "../src/chunking.js";
import { settle } from "../src/testing.js";
import { rig } from "./helpers.js";

// Raw sends over 16 KiB go out as chunks and arrive whole (spec/binary.md "Large non-snapshot frames").

function payload(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

async function trio() {
  const r = rig();
  const h = await r.make("host", { mode: "raw" }).host({ name: "t", maxPlayers: 4 });
  const a = await r.make("a", { mode: "raw" }).join(h.code);
  const b = await r.make("b", { mode: "raw" }).join(h.code);
  await settle();
  const got: Record<string, [number, Uint8Array][]> = { h: [], a: [], b: [] };
  h.on("message", (from, bytes) => got.h.push([from, bytes]));
  a.on("message", (from, bytes) => got.a.push([from, bytes]));
  b.on("message", (from, bytes) => got.b.push([from, bytes]));
  return { h, a, b, got };
}

describe("large raw messages", () => {
  it("host to joiner", async () => {
    const { h, a, got } = await trio();
    const p = payload(40000, 1);
    h.send(a.localPeerId, p);
    await settle();
    expect(got.a).toEqual([[h.localPeerId, p]]);
  });

  it("joiner to host", async () => {
    const { h, a, got } = await trio();
    const p = payload(100_000, 2);
    a.send(h.localPeerId, p);
    await settle();
    expect(got.h).toEqual([[a.localPeerId, p]]);
  });

  it("joiner to joiner through the host", async () => {
    const { a, b, got } = await trio();
    const p = payload(20000, 3);
    a.send(b.localPeerId, p);
    await settle();
    expect(got.h).toEqual([]);
    expect(got.b).toEqual([[a.localPeerId, p]]);
  });

  it("joiner broadcast reaches everyone else", async () => {
    const { a, got } = await trio();
    const p = payload(50000, 4);
    a.broadcast(p);
    await settle();
    expect(got.a).toEqual([]);
    expect(got.h).toEqual([[a.localPeerId, p]]);
    expect(got.b).toEqual([[a.localPeerId, p]]);
  });

  it("two joiners sending at once do not mix", async () => {
    const { h, a, b, got } = await trio();
    const pa = payload(40000, 5);
    const pb = payload(40000, 6);
    a.send(h.localPeerId, pa);
    b.send(h.localPeerId, pb);
    await settle();
    expect(got.h).toHaveLength(2);
    expect(got.h.find(([f]) => f === a.localPeerId)![1]).toEqual(pa);
    expect(got.h.find(([f]) => f === b.localPeerId)![1]).toEqual(pb);
  });

  it("a reassembly over 64 MiB is refused", () => {
    const half = new Uint8Array(MAX_REASSEMBLED_BYTES / 2 + 1);
    const r = new Reassembler();
    expect(r.push({ id: 1, index: 0, count: 2, bytes: half })).toBeNull();
    expect(() => r.push({ id: 1, index: 1, count: 2, bytes: half })).toThrow(CodecError);
    expect(r.pending).toBe(0);
  });
});
