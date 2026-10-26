import { describe, expect, it } from "vitest";
import { CodecError, decodeMessage, encodeMessage, Reassembler, splitChunks, type Message } from "../src/internals.js";
import { hex, specJson, unhex } from "./spec.js";

// Adapter: spec JSON form <-> our Message shape.
function fromJson(j: any): { msg: Message; route: number } {
  const route = j.route as number;
  switch (j.type) {
    case "hi": return { route, msg: { type: "hi", proto: j.proto, peerId: j.peerId, lastTick: Number(j.lastTick) } };
    case "welcome_dc": return { route, msg: { type: "welcome_dc", tick: Number(j.tick), tickRate: j.tickRate, mode: j.mode, hostId: j.hostId } };
    case "cmd": return { route, msg: { type: "cmd", seq: j.seq, bytes: unhex(j.bytes) } };
    case "frame": return { route, msg: { type: "frame", tick: Number(j.tick), commands: j.cmds.map((c: any) => ({ peerId: c.peerId, bytes: unhex(c.bytes) })) } };
    case "hash": return { route, msg: { type: "hash", tick: Number(j.tick), hash: BigInt(j.hash) } };
    case "desync": return { route, msg: { type: "desync", tick: Number(j.tick), hostHash: BigInt(j.hostHash), yourHash: BigInt(j.yourHash) } };
    case "snapshot_req": return { route, msg: { type: "snapshot_req", sinceTick: Number(j.sinceTick) } };
    case "snapshot": return { route, msg: { type: "snapshot", tick: Number(j.tick), total: j.total, flags: j.flags } };
    case "chunk": return { route, msg: { type: "chunk", id: j.id, index: j.index, count: j.count, bytes: unhex(j.bytes) } };
    case "raw": return { route, msg: { type: "raw", bytes: unhex(j.bytes) } };
    case "ping": case "pong": return { route, msg: { type: j.type, n: j.n, t: j.t } };
    case "host_claim": return { route, msg: { type: "host_claim", epoch: j.epoch, hostId: j.hostId, tick: Number(j.tick) } };
    case "voice": return { route, msg: { type: "voice", seq: j.seq, flags: j.flags, frames: j.packets.map((p: any) => unhex(p.opus)) } };
    case "chat": return { route, msg: { type: "chat", id: j.id, ts: Number(j.ts), text: j.text } };
    case "chat_history": return { route, msg: { type: "chat_history", lines: j.lines.map((l: any) => ({ peerId: l.peerId, id: l.id, ts: Number(l.ts), text: l.text })) } };
    case "chat_reject": return { route, msg: { type: "chat_reject", id: j.id, reason: j.reason } };
    case "pause_request": return { route, msg: { type: "pause_request", paused: j.paused } };
    case "pause_state": return { route, msg: { type: "pause_state", paused: j.paused, byPeer: j.byPeer, flags: j.flags } };
    case "pause_refuse": return { route, msg: { type: "pause_refuse", paused: j.paused, reason: j.reason } };
  }
  throw new Error("unknown vector type " + j.type);
}

const frames = specJson("vectors/frames.json");
const invalid = specJson("vectors/invalid.json");
const chunking = specJson("vectors/chunking.json");

describe("codec vs spec/vectors/frames.json", () => {
  for (const v of frames.vectors) {
    const { msg, route } = fromJson(v.msg);
    it(`${v.name}: encode matches the wire hex`, () => {
      expect(hex(encodeMessage(msg, route))).toBe(v.hex);
    });
    it(`${v.name}: decode of the wire hex matches`, () => {
      const d = decodeMessage(unhex(v.hex));
      expect(d).not.toBeNull();
      expect(d!.route).toBe(route);
      expect(d!.msg).toEqual(msg);
    });
  }
});

describe("codec vs spec/vectors/invalid.json", () => {
  for (const v of invalid.vectors) {
    it(`${v.name} -> ${v.error}`, () => {
      let err: unknown = null;
      try {
        decodeMessage(unhex(v.hex));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CodecError);
      expect((err as CodecError).code).toBe(v.error);
    });
  }
  it("unknown type ids are ignored, not errors", () => {
    expect(decodeMessage(Uint8Array.of(0xee, 0, 0, 1, 2, 3))).toBeNull();
  });
  it("encode refuses a frame over 16 KiB", () => {
    expect(() => encodeMessage({ type: "raw", bytes: new Uint8Array(16382) })).toThrow(CodecError);
  });
});

describe("chunking vs spec/vectors/chunking.json", () => {
  for (const v of chunking.vectors.filter((x: any) => x.chunks && x.payload !== undefined && x.chunkSize)) {
    it(`${v.name}: split produces the listed frames`, () => {
      const out = splitChunks(v.id, unhex(v.payload), v.chunkSize).map((m) => hex(encodeMessage(m)));
      expect(out).toEqual(v.chunks);
    });
    it(`${v.name}: reassembles out of order, duplicates ignored`, () => {
      const r = new Reassembler();
      let whole: Uint8Array | null = null;
      for (const h of [...v.chunks].reverse()) {
        const d = decodeMessage(unhex(h))!.msg as Extract<Message, { type: "chunk" }>;
        whole = r.push(d) ?? whole;
        if (v.chunks.length > 1 && r.push(d)) throw new Error("a duplicate completed a set");
      }
      expect(whole).not.toBeNull();
      expect(hex(whole!)).toBe(v.payload);
    });
  }

  it("forty_kb_default: lengths and content", () => {
    const v = chunking.vectors.find((x: any) => x.name === "forty_kb_default");
    const payload = new Uint8Array(40000).map((_, i) => (i * 7 + 3) & 0xff);
    const chunks = splitChunks(v.id, payload, v.chunkSize).map((m) => encodeMessage(m));
    expect(chunks.map((c) => c.length)).toEqual(v.chunk_lengths);
    chunks.forEach((c, i) => expect(hex(c.subarray(0, 16))).toBe(v.chunk_hex_prefix_16[i]));
    const r = new Reassembler();
    let whole: Uint8Array | null = null;
    for (const c of chunks) whole = r.push(decodeMessage(c)!.msg as any) ?? whole;
    expect(whole).toEqual(payload);
  });

  it("oversized_inner_frame: a 20017-byte frame round trips through chunks", () => {
    const inner = encodeMessage({ type: "frame", tick: 9, commands: [{ peerId: 2, bytes: new Uint8Array(20000) }] }, 0, true);
    expect(inner.length).toBe(20000 + 17);
    const r = new Reassembler();
    let whole: Uint8Array | null = null;
    for (const m of splitChunks(12, inner)) whole = r.push(decodeMessage(encodeMessage(m))!.msg as any) ?? whole;
    expect(whole).toEqual(inner);
    expect(() => decodeMessage(inner)).toThrow(CodecError); // single-frame cap
  });

  it("inflate refuses output over the cap and accepts output at it", async () => {
    const { deflate, inflate } = await import("../src/deflate.js");
    const z = await deflate(new Uint8Array(1_000_000)); // ~1 KB of zlib for 1 MB of zeros
    expect(z.length).toBeLessThan(2000);
    await expect(inflate(z, 100_000)).rejects.toThrow(CodecError);
    expect((await inflate(z, 1_000_000)).length).toBe(1_000_000);
  });

  it("snapshot_deflate vector: header decodes and the zlib payload inflates to 260 bytes", async () => {
    const v = chunking.vectors.find((x: any) => x.name === "snapshot_deflate");
    const { inflate } = await import("../src/deflate.js");
    const out = await inflate(unhex(v.payload));
    expect(out.length).toBe(v.inflated_len);
    const hdr = decodeMessage(unhex(v.snapshot_header_hex))!.msg;
    expect(hdr).toMatchObject({ type: "snapshot", flags: 1, total: unhex(v.payload).length });
  });
});
