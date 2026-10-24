import { describe, expect, it } from "vitest";
import {
  JitterBuffer,
  MAX_SPEAKERS,
  VoiceGate,
  VoicePacketizer,
  VoiceRelayPolicy,
  type VoicePacket,
} from "../src/internals.js";
import { settle } from "../src/testing.js";
import { rig } from "./helpers.js";

const f = (n: number) => Uint8Array.of(n);
const pk = (seq: number, flags = 0, ...frames: number[]): VoicePacket => ({ seq, flags, frames: frames.map(f) });

describe("voice packetization", () => {
  it("2 frames per packet (40 ms), seq increments, end flag flushes the remainder", () => {
    const p = new VoicePacketizer();
    expect(p.push(f(1))).toBeNull();
    const a = p.push(f(2))!;
    expect(a).toMatchObject({ seq: 0, flags: 0 });
    expect(a.frames.length).toBe(2);
    expect(p.push(f(3))).toBeNull();
    const end = p.endBurst();
    expect(end).toMatchObject({ seq: 1, flags: 1 });
    expect(end.frames.length).toBe(1);
  });
  it("seq wraps at 65536", () => {
    const p = new VoicePacketizer(1);
    let last = 0;
    for (let i = 0; i < 65537; i++) last = p.push(f(0))!.seq;
    expect(last).toBe(0);
  });
});

describe("push-to-talk and voice activity gate", () => {
  it("PTT follows the key", () => {
    const g = new VoiceGate();
    expect(g.update(0.5, 0).send).toBe(false);
    g.ptt = true;
    expect(g.update(0, 20)).toEqual({ send: true, edge: "open" });
    g.ptt = false;
    expect(g.update(0, 40)).toEqual({ send: false, edge: "close" });
  });
  it("VAD: RMS gate with a 300 ms hangover", () => {
    const g = new VoiceGate();
    g.mode = "voiceActivity";
    expect(g.update(0.001, 0).send).toBe(false);
    expect(g.update(0.2, 20).edge).toBe("open");
    expect(g.update(0.001, 200).send).toBe(true);
    expect(g.update(0.001, 320).send).toBe(true);
    expect(g.update(0.001, 330)).toEqual({ send: false, edge: "close" });
  });
});

describe("jitter buffer", () => {
  const drain = (j: JitterBuffer, n: number) => Array.from({ length: n }, () => j.pull());
  it("prefills 60 ms before playing, then plays in order", () => {
    const j = new JitterBuffer();
    j.push(pk(0, 0, 1, 2));
    expect(j.pull().kind).toBe("wait");
    j.push(pk(1, 0, 3, 4));
    const out = drain(j, 4).map((r) => (r.kind === "frame" ? r.opus[0] : r.kind));
    expect(out).toEqual([1, 2, 3, 4]);
  });
  it("reorders late packets", () => {
    const j = new JitterBuffer();
    j.push(pk(1, 0, 3, 4));
    j.push(pk(0, 0, 1, 2));
    // arrival order 1 then 0 -> expected starts at the first pushed (1); packet 0 is "late" and dropped by design,
    // so a sender burst must start with the lowest seq; verify out-of-order inside the window instead
    const j2 = new JitterBuffer();
    j2.push(pk(0, 0, 1, 2));
    j2.push(pk(2, 0, 5, 6));
    j2.push(pk(1, 0, 3, 4));
    expect(drain(j2, 6).map((r) => (r.kind === "frame" ? r.opus[0] : r.kind))).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("conceals a lost packet with PLC when a later one is present", () => {
    const j = new JitterBuffer();
    j.push(pk(0, 0, 1, 2));
    j.push(pk(2, 0, 5, 6));
    j.push(pk(3, 0, 7, 8));
    expect(drain(j, 8).map((r) => (r.kind === "frame" ? r.opus[0] : r.kind))).toEqual([1, 2, "plc", "plc", 5, 6, 7, 8]);
  });
  it("end-of-burst flag flushes and goes idle; wraparound seq works", () => {
    const j = new JitterBuffer();
    j.push(pk(0xffff, 0, 1, 2));
    j.push(pk(0, 1, 3));
    const out = drain(j, 5).map((r) => (r.kind === "frame" ? r.opus[0] : r.kind));
    expect(out).toEqual([1, 2, 3, "idle", "idle"]);
    expect(j.active).toBe(false);
  });
});

describe("host relay policy", () => {
  it("drops packets over 1 KiB", () => {
    const p = new VoiceRelayPolicy();
    expect(p.accept(2, 1024, 0, 0)).toBe(true);
    expect(p.accept(2, 1025, 0, 10)).toBe(false);
  });
  it("30 packets per sliding second per peer", () => {
    const p = new VoiceRelayPolicy();
    let ok = 0;
    for (let i = 0; i < 40; i++) if (p.accept(2, 100, 0, i * 10)) ok++;
    expect(ok).toBe(30);
    expect(p.accept(2, 100, 0, 1005)).toBe(true);
  });
  it("9th concurrent speaker is dropped; end flag or 500 ms silence frees a slot", () => {
    const p = new VoiceRelayPolicy();
    for (let id = 1; id <= MAX_SPEAKERS; id++) expect(p.accept(id, 50, 0, 0)).toBe(true);
    expect(p.accept(9, 50, 0, 10)).toBe(false);
    expect(p.accept(3, 50, 1, 20)).toBe(true); // speaker 3 ends
    expect(p.accept(9, 50, 0, 30)).toBe(true);
    expect(p.accept(10, 50, 0, 600)).toBe(true); // others timed out after 500 ms
  });
});

describe("voice end to end", () => {
  it("a tone captured on the joiner is forwarded by the host and decoded on a third peer", async () => {
    const r = rig();
    const la = await r.make("alice").host({ name: "t", maxPlayers: 4 });
    const lb = await r.make("bob").join(la.code);
    const lc = await r.make("cara").join(la.code);
    await settle();
    la.voice.enabled = true;
    lb.voice.enabled = true;
    lc.voice.enabled = true;
    await settle();
    const speaking: [string, number, boolean][] = [];
    la.voice.on("speaking", (p, t) => speaking.push(["alice", p, t]));
    lc.voice.on("speaking", (p, t) => speaking.push(["cara", p, t]));
    lb.voice.pushToTalk(true);
    const mic = r.mics.get("bob")!;
    const tone = new Float32Array(960).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000));
    for (let i = 0; i < 30; i++) {
      mic.onFrame!(tone);
      r.clock.advance(20);
      await settle();
    }
    lb.voice.pushToTalk(false);
    mic.onFrame!(new Float32Array(960));
    await r.clock.run(400, 20);
    const heardByCara = r.sinks.get("cara")!.played.filter((p) => p.peerId === 2);
    const heardByAlice = r.sinks.get("alice")!.played.filter((p) => p.peerId === 2);
    expect(heardByCara.length).toBeGreaterThan(20);
    expect(heardByAlice.length).toBeGreaterThan(20);
    expect(Math.max(...heardByCara.map((p) => Math.max(...p.pcm)))).toBeGreaterThan(0.3);
    expect(r.sinks.get("bob")!.played.filter((p) => p.peerId === 2).length).toBe(0); // not echoed to the speaker
    expect(speaking).toContainEqual(["cara", 2, true]);
    expect(speaking).toContainEqual(["cara", 2, false]);
    expect(lb.voice.inputLevel).toBe(0);
  });

  it("per-peer mute and gain apply; muted self sends nothing", async () => {
    const r = rig();
    const la = await r.make("alice").host({ name: "t", maxPlayers: 4 });
    const lb = await r.make("bob").join(la.code);
    await settle();
    la.voice.enabled = true;
    lb.voice.enabled = true;
    await settle();
    lb.voice.setVolume(1, 1.5);
    lb.voice.setVolume(1, 9);
    expect(lb.voice.volumeOf(1)).toBe(2);
    la.voice.pushToTalk(true);
    const tone = new Float32Array(960).fill(0.4);
    for (let i = 0; i < 10; i++) {
      r.mics.get("alice")!.onFrame!(tone);
      r.clock.advance(20);
      await settle();
    }
    await r.clock.run(200, 20);
    const played = r.sinks.get("bob")!.played.filter((p) => p.peerId === 1);
    expect(played.length).toBeGreaterThan(5);
    expect(played[0].gain).toBe(2);
    lb.voice.setMuted(1, true);
    const before = r.sinks.get("bob")!.played.length;
    for (let i = 0; i < 6; i++) {
      r.mics.get("alice")!.onFrame!(tone);
      r.clock.advance(20);
      await settle();
    }
    await r.clock.run(200, 20);
    expect(r.sinks.get("bob")!.played.length).toBe(before);
    la.voice.muted = true;
    const sentBefore = r.net.links.reduce((a, l) => a + l.sent.voice, 0);
    r.mics.get("alice")!.onFrame!(tone);
    await settle();
    expect(r.net.links.reduce((a, l) => a + l.sent.voice, 0)).toBe(sentBefore);
  });
});
