import { describe, expect, it } from "vitest";
import {
  FLAG_END_OF_BURST,
  JitterBuffer,
  MAX_PACKETS_PER_SEC,
  MAX_SPEAKERS,
  MAX_VOICE_PACKET_BYTES,
  VAD_HANGOVER_MS,
  VoiceGate,
  VoicePacketizer,
  VoiceRelayPolicy,
  rms,
  seqDiff,
  type VoicePacket,
} from "../src/voice-core.js";

const fr = (n: number) => new Uint8Array([n]);
const pkt = (seq: number, frames: number[], flags = 0): VoicePacket => ({ seq, flags, frames: frames.map(fr) });

describe("VoicePacketizer", () => {
  it("batches two 20 ms frames into one packet with increasing seq", () => {
    const p = new VoicePacketizer();
    expect(p.push(fr(1))).toBeNull();
    expect(p.buffered).toBe(1);
    const a = p.push(fr(2))!;
    expect(a.seq).toBe(0);
    expect(a.flags).toBe(0);
    expect(a.frames.map((f) => f[0])).toEqual([1, 2]);
    expect(p.buffered).toBe(0);
    p.push(fr(3));
    expect(p.push(fr(4))!.seq).toBe(1);
  });

  it("endBurst flushes the remainder with the end flag, even when empty", () => {
    const p = new VoicePacketizer();
    p.push(fr(9));
    const tail = p.endBurst();
    expect(tail.flags).toBe(FLAG_END_OF_BURST);
    expect(tail.frames.map((f) => f[0])).toEqual([9]);
    const empty = p.endBurst();
    expect(empty.frames).toEqual([]);
    expect(empty.flags).toBe(FLAG_END_OF_BURST);
    expect(empty.seq).toBe(tail.seq + 1);
  });

  it("honours framesPerPacket and wraps seq at 16 bits", () => {
    const p = new VoicePacketizer(1);
    expect(p.push(fr(1))!.frames).toHaveLength(1);
    const q = new VoicePacketizer();
    let last = -1;
    for (let i = 0; i < 0x10001; i++) last = q.packet([], 0).seq;
    expect(last).toBe(0); // 65536th packet is seq 0 again
  });
});

describe("rms", () => {
  it("is 0 for empty and silent input, and the root mean square otherwise", () => {
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(new Float32Array(960))).toBe(0);
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array([1, 0, 0, 0]))).toBeCloseTo(0.5);
  });
});

describe("VoiceGate", () => {
  it("push-to-talk follows ptt and reports edges once", () => {
    const g = new VoiceGate();
    expect(g.mode).toBe("pushToTalk");
    expect(g.update(1, 0)).toEqual({ send: false, edge: null }); // loud but not pressed
    g.ptt = true;
    expect(g.update(0, 20)).toEqual({ send: true, edge: "open" });
    expect(g.isOpen).toBe(true);
    expect(g.update(0, 40)).toEqual({ send: true, edge: null });
    g.ptt = false;
    expect(g.update(0, 60)).toEqual({ send: false, edge: "close" });
    expect(g.isOpen).toBe(false);
  });

  it("voice activity opens at the threshold and holds for the 300 ms hangover", () => {
    const g = new VoiceGate();
    g.mode = "voiceActivity";
    expect(g.update(0.019, 1000)).toEqual({ send: false, edge: null }); // under 0.02
    expect(g.update(0.02, 1020)).toEqual({ send: true, edge: "open" }); // exactly the threshold counts
    expect(g.update(0, 1020 + VAD_HANGOVER_MS).send).toBe(true); // hangover inclusive
    expect(g.update(0, 1020 + VAD_HANGOVER_MS + 1)).toEqual({ send: false, edge: "close" });
  });

  it("loud input during the hangover extends it", () => {
    const g = new VoiceGate();
    g.mode = "voiceActivity";
    g.update(0.5, 0);
    g.update(0.5, 250);
    expect(g.update(0, 500).send).toBe(true);
    expect(g.update(0, 551).send).toBe(false);
  });

  it("a custom threshold applies and ptt is ignored in voice activity mode", () => {
    const g = new VoiceGate();
    g.mode = "voiceActivity";
    g.vadThreshold = 0.3;
    g.ptt = true;
    expect(g.update(0.2, 0).send).toBe(false);
    expect(g.update(0.3, 20).send).toBe(true);
  });
});

describe("seqDiff", () => {
  it("compares u16 sequence numbers across the wrap", () => {
    expect(seqDiff(5, 3)).toBe(2);
    expect(seqDiff(3, 5)).toBe(-2);
    expect(seqDiff(0, 0xffff)).toBe(1);
    expect(seqDiff(0xffff, 0)).toBe(-1);
    expect(seqDiff(0x8000, 0)).toBe(-0x8000);
    expect(seqDiff(0x7fff, 0)).toBe(0x7fff);
  });
});

describe("JitterBuffer", () => {
  const opus = (r: ReturnType<JitterBuffer["pull"]>) => (r.kind === "frame" ? r.opus[0] : r.kind);

  it("is idle until a packet arrives, then waits for the 60 ms prefill", () => {
    const j = new JitterBuffer();
    expect(j.prefillFrames).toBe(3);
    expect(j.pull()).toEqual({ kind: "idle" });
    j.push(pkt(0, [1, 2]));
    expect(j.active).toBe(true);
    expect(j.pull()).toEqual({ kind: "wait" }); // 2 frames < 3
    j.push(pkt(1, [3, 4]));
    expect([1, 2, 3, 4].map(() => opus(j.pull()))).toEqual([1, 2, 3, 4]);
  });

  it("reorders packets by seq", () => {
    const j = new JitterBuffer();
    j.push(pkt(0, [1, 2]));
    j.push(pkt(2, [5, 6]));
    j.push(pkt(1, [3, 4]));
    expect([0, 1, 2, 3, 4, 5].map(() => opus(j.pull()))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("drops late and duplicate packets", () => {
    const j = new JitterBuffer();
    j.push(pkt(5, [1, 2]));
    j.push(pkt(6, [3, 4]));
    j.push(pkt(4, [99, 99])); // before the first expected seq
    j.push(pkt(5, [1, 2])); // duplicate overwrites the same slot
    expect([0, 1, 2, 3].map(() => opus(j.pull()))).toEqual([1, 2, 3, 4]);
  });

  it("conceals a missing packet with PLC frames when a later one is here", () => {
    const j = new JitterBuffer();
    j.push(pkt(0, [1, 2]));
    j.push(pkt(2, [5, 6]));
    expect([0, 1, 2, 3, 4, 5].map(() => opus(j.pull()))).toEqual([1, 2, "plc", "plc", 5, 6]);
  });

  it("waits (does not conceal) when nothing newer has arrived", () => {
    const j = new JitterBuffer();
    j.push(pkt(0, [1, 2]));
    j.push(pkt(1, [3, 4]));
    for (let i = 0; i < 4; i++) j.pull();
    expect(j.pull()).toEqual({ kind: "wait" });
  });

  it("end-of-burst flushes a short burst without prefill and then goes idle", () => {
    const j = new JitterBuffer();
    j.push(pkt(0, [1], FLAG_END_OF_BURST));
    expect(opus(j.pull())).toBe(1);
    expect(j.pull()).toEqual({ kind: "idle" });
    expect(j.active).toBe(false);
  });

  it("without an end flag, 13 empty pulls (over 240 ms) end the burst", () => {
    const j = new JitterBuffer();
    j.push(pkt(0, [1, 2]));
    j.push(pkt(1, [3, 4]));
    for (let i = 0; i < 4; i++) j.pull();
    for (let i = 0; i < 12; i++) expect(j.pull()).toEqual({ kind: "wait" });
    expect(j.pull()).toEqual({ kind: "idle" });
    expect(j.active).toBe(false);
  });

  it("a packet after the end flag starts a new burst; reset clears everything", () => {
    const j = new JitterBuffer();
    j.push(pkt(0, [1, 2], FLAG_END_OF_BURST));
    j.push(pkt(1, [3, 4]));
    for (let i = 0; i < 4; i++) j.pull();
    expect(j.pull()).toEqual({ kind: "wait" }); // burst 1 was not treated as ended
    j.reset();
    expect(j.active).toBe(false);
    expect(j.pull()).toEqual({ kind: "idle" });
  });

  it("jitterMs sets the prefill, at least one frame", () => {
    expect(new JitterBuffer(100).prefillFrames).toBe(5);
    expect(new JitterBuffer(0).prefillFrames).toBe(1);
  });
});

describe("VoiceRelayPolicy", () => {
  it("rejects packets over 1 KiB and accepts exactly 1 KiB", () => {
    const r = new VoiceRelayPolicy();
    expect(r.accept(1, MAX_VOICE_PACKET_BYTES + 1, 0, 0)).toBe(false);
    expect(r.accept(1, MAX_VOICE_PACKET_BYTES, 0, 0)).toBe(true);
  });

  it("allows 30 packets per second per peer, and the window slides", () => {
    const r = new VoiceRelayPolicy();
    for (let i = 0; i < MAX_PACKETS_PER_SEC; i++) expect(r.accept(1, 100, 0, i)).toBe(true);
    expect(r.accept(1, 100, 0, 100)).toBe(false);
    expect(r.accept(2, 100, 0, 100)).toBe(true); // another peer has its own budget
    expect(r.accept(1, 100, 0, 1000)).toBe(true); // the first packet (t=0) is a full second old
  });

  it("caps concurrent speakers at 8 and frees a slot on end of burst", () => {
    const r = new VoiceRelayPolicy();
    for (let p = 1; p <= MAX_SPEAKERS; p++) expect(r.accept(p, 100, 0, 0)).toBe(true);
    expect(r.activeSpeakers).toBe(MAX_SPEAKERS);
    expect(r.accept(99, 100, 0, 10)).toBe(false); // 9th is dropped
    expect(r.accept(3, 100, 0, 20)).toBe(true); // an existing speaker continues
    expect(r.accept(3, 100, FLAG_END_OF_BURST, 30)).toBe(true);
    expect(r.activeSpeakers).toBe(MAX_SPEAKERS - 1);
    expect(r.accept(99, 100, 0, 40)).toBe(true);
  });

  it("counts a silent speaker as gone after burstTimeoutMs, and forget removes a peer", () => {
    const r = new VoiceRelayPolicy();
    for (let p = 1; p <= MAX_SPEAKERS; p++) r.accept(p, 100, 0, 0);
    expect(r.accept(99, 100, 0, 500)).toBe(false); // exactly the timeout is not yet over
    expect(r.accept(99, 100, 0, 501)).toBe(true);
    r.forget(99);
    expect(r.activeSpeakers).toBe(0); // the others timed out when 99 was admitted
  });
});
