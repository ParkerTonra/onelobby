import { describe, expect, it } from "vitest";
import { ChatLimiter, sanitizeChat, type ChatMessage } from "../src/index.js";
import { settle } from "../src/testing.js";
import { rig } from "./helpers.js";

describe("chat limiter", () => {
  it("burst of 3 then one token per second (5 per 5 s)", () => {
    const l = new ChatLimiter();
    expect([0, 0, 0, 0].map(() => l.tryTake(2, 0))).toEqual([true, true, true, false]);
    expect(l.tryTake(2, 999)).toBe(false);
    expect(l.tryTake(2, 1000)).toBe(true);
    expect(l.tryTake(2, 1000)).toBe(false);
    expect(l.tryTake(3, 0)).toBe(true); // per peer
  });
  it("strips control chars and bidi overrides", () => {
    expect(sanitizeChat("a\u0000b\u0007c‮d⁦e\u009ff\u007f")).toBe("abcdef");
  });
});

async function pair() {
  const r = rig();
  const la = await r.make("alice").host({ name: "t", maxPlayers: 4 });
  const lb = await r.make("bob").join(la.code);
  await settle();
  const gotA: ChatMessage[] = [];
  const gotB: ChatMessage[] = [];
  const rej: [number, string][] = [];
  la.chat.on("message", (m) => gotA.push(m));
  lb.chat.on("message", (m) => gotB.push(m));
  lb.chat.on("rejected", (id, why) => rej.push([id, why]));
  return { r, la, lb, gotA, gotB, rej };
}

describe("chat over the lobby", () => {
  it("stamps ids/ts at the host and delivers to everyone including the sender", async () => {
    const { r, la, lb, gotA, gotB } = await pair();
    lb.chat.send("hi\u0000 there");
    await settle();
    la.chat.send("yo");
    await settle();
    expect(gotB.map((m) => [m.peerId, m.id, m.text])).toEqual([[2, 1, "hi there"], [1, 2, "yo"]]);
    expect(gotA.map((m) => m.text)).toEqual(["hi there", "yo"]);
    expect(gotB[0].ts).toBe(1_700_000_000_000 + r.clock.now());
  });

  it("rejects over 256 bytes (reason length) and over-rate (reason rate) and echoes the client id", async () => {
    const { lb, gotB, rej } = await pair();
    const big = lb.chat.send("x".repeat(257));
    await settle();
    expect(rej).toEqual([[big, "length"]]);
    expect(lb.chat.send("é".repeat(128))).toBeGreaterThan(0); // exactly 256 bytes: allowed
    await settle();
    lb.chat.send("2");
    lb.chat.send("3");
    const fourth = lb.chat.send("4");
    await settle();
    expect(rej[1]).toEqual([fourth, "rate"]);
    expect(gotB.length).toBe(3);
  });

  it("host mute drops a peer's lines with reason muted_by_host; unmute restores", async () => {
    const { la, lb, gotA, rej } = await pair();
    la.chat.hostMute(2, true);
    const id = lb.chat.send("hello?");
    await settle();
    expect(rej).toEqual([[id, "muted_by_host"]]);
    expect(gotA.length).toBe(0);
    la.chat.hostMute(2, false);
    lb.chat.send("back");
    await settle();
    expect(gotA.map((m) => m.text)).toEqual(["back"]);
    expect(() => lb.chat.hostMute(1, true)).toThrow();
  });

  it("late joiners get the last 100 lines as history; the filter hook applies", async () => {
    const { r, la } = await pair();
    for (let i = 0; i < 120; i++) {
      la.chat.send("line " + i);
      r.clock.advance(1000);
      await settle(); // keeps signaling pongs flowing while simulated time passes
    }
    await settle();
    const lc = await r.make("cara").join(la.code);
    lc.chat.filter = (t) => t.replace(/line/g, "****");
    await settle();
    expect(lc.chat.history.length).toBe(100);
    expect(la.chat.history.length).toBe(100);
    expect(lc.chat.history[0].text).toBe("**** 20");
    expect(lc.chat.history[99].peerId).toBe(1);
    la.chat.send("line x");
    await settle();
    expect(lc.chat.history.at(-1)!.text).toBe("**** x");
  });

  it("local mute drops that peer's chat", async () => {
    const { la, lb, gotB } = await pair();
    lb.voice.setMuted(1, true);
    la.chat.send("muted by bob");
    await settle();
    expect(gotB.length).toBe(0);
    lb.voice.setMuted(1, false);
    la.chat.send("audible");
    await settle();
    expect(gotB.map((m) => m.text)).toEqual(["audible"]);
  });
});
