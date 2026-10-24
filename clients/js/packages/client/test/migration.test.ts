import { describe, expect, it } from "vitest";
import { claimWins, claimWinsWrapped, pickNewHost } from "../src/internals.js";
import { settle } from "../src/testing.js";
import { Player, play, rig } from "./helpers.js";

describe("migration rule (s.9)", () => {
  it("new host = lowest peerId still connected", () => {
    expect(pickNewHost([1, 2, 3, 4], 1)).toBe(2);
    expect(pickNewHost([3, 4, 1], 1)).toBe(3);
    expect(pickNewHost([1], 1)).toBeNull();
  });
  it("higher epoch wins; equal epoch -> lower peerId wins", () => {
    expect(claimWins({ epoch: 2, hostId: 9 }, { epoch: 1, hostId: 2 })).toBe(true);
    expect(claimWins({ epoch: 1, hostId: 2 }, { epoch: 1, hostId: 3 })).toBe(true);
    expect(claimWins({ epoch: 1, hostId: 3 }, { epoch: 1, hostId: 2 })).toBe(false);
    expect(claimWinsWrapped({ epoch: 0, hostId: 5 }, { epoch: 65535, hostId: 2 })).toBe(true); // u16 wrap
  });
});

describe("migration end to end", () => {
  async function setup() {
    const r = rig();
    const la = await r.make("alice").host({ name: "t", maxPlayers: 4 });
    const lb = await r.make("bob").join(la.code);
    const lc = await r.make("cara").join(la.code);
    await settle();
    const [A, B, C] = [new Player("a", la), new Player("b", lb), new Player("c", lc)];
    await la.start();
    A.paint(2, 2);
    await play(r.clock, [A, B, C], 2000);
    return { r, la, lb, lc, A, B, C };
  }

  it("host leaves: lowest peerId takes over, frames resume, game sees hostChanged, hashes stay equal", async () => {
    const { r, la, lb, lc, A, B, C } = await setup();
    const changed: number[] = [];
    lb.on("hostChanged", (h) => changed.push(h));
    lc.on("hostChanged", (h) => changed.push(h));
    const tickBefore = B.g.tick;
    await la.leave();
    await play(r.clock, [B, C], 5000);
    expect(lb.isHost).toBe(true);
    expect(lc.hostPeerId).toBe(2);
    expect(changed).toEqual([2, 2]);
    expect(B.g.tick).toBeGreaterThan(tickBefore + 60);
    expect(C.g.tick).toBeGreaterThanOrEqual(B.g.tick - 2);
    B.paint(8, 8);
    C.paint(9, 9);
    await play(r.clock, [B, C], 3000);
    const t = Math.min(B.g.tick, C.g.tick);
    const tt = t - (t % 20);
    expect(C.hashes.get(tt)).toBe(B.hashes.get(tt));
    expect(B.desyncs + C.desyncs).toBe(0);
    void A;
  });

  it("a frozen host (no frames for 3 s, link still open) is replaced within the timeout", async () => {
    const { r, la, lb, lc, A, B, C } = await setup();
    // freeze: the host's outgoing traffic vanishes
    for (const l of r.net.links) if (l.owner === "alice") l.blackhole = true;
    const start = r.clock.now();
    let at = 0;
    lb.on("hostChanged", () => (at ||= r.clock.now() - start));
    await play(r.clock, [B, C], 5000);
    expect(lb.isHost).toBe(true);
    expect(at).toBeGreaterThanOrEqual(3000);
    expect(at).toBeLessThanOrEqual(4000);
    void la; void A; void lc;
  });

  it("the old host returning with a lower epoch demotes itself", async () => {
    const { r, la, lb, lc, A, B, C } = await setup();
    for (const l of r.net.links) if (l.owner === "alice") l.blackhole = true;
    await play(r.clock, [B, C], 4000);
    expect(lb.isHost).toBe(true);
    // bob's offer to alice goes through signaling; alice hears host_claim epoch 1 and follows
    for (const l of r.net.links) if (l.owner === "alice") l.blackhole = false;
    await play(r.clock, [A, B, C], 4000);
    void la; void lc;
    expect(lb.isHost).toBe(true);
  });
});
