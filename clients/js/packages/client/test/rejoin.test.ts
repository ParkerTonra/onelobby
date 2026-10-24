import { describe, expect, it } from "vitest";
import { settle } from "../src/testing.js";
import { Player, play, rig } from "./helpers.js";

describe("rejoin(resumeToken)", () => {
  it("a joiner whose signaling socket dropped resumes with the same peerId and converges again", async () => {
    const r = rig();
    const kitB = r.make("bob");
    const la = await r.make("alice").host({ name: "t", maxPlayers: 4 });
    const lb = await kitB.join(la.code);
    await settle();
    const A = new Player("a", la);
    const B = new Player("b", lb);
    await la.start();
    A.paint(4, 4);
    await play(r.clock, [A, B], 2000);
    const token = lb.resumeToken;
    expect(lb.localPeerId).toBe(2);

    // the network drops bob's signaling socket; the game retires the old lobby object
    const sock = r.server.sockets[1];
    const left: string[] = [];
    la.on("peerLeft", (_p, why) => left.push(why));
    sock.close();
    await lb.leave();
    await play(r.clock, [A], 500);
    expect(left).toEqual(["timeout"]);
    expect(la.peers.map((p) => p.peerId)).toEqual([1]);

    const lb2 = await kitB.rejoin(token);
    expect(lb2.localPeerId).toBe(2);
    expect(lb2.code).toBe(la.code);
    expect(lb2.hostPeerId).toBe(1);
    const B2 = new Player("b2", lb2);
    await play(r.clock, [A, B2], 3000);
    expect(la.peers.map((p) => p.peerId)).toEqual([1, 2]);
    expect(B2.restores.length).toBe(1); // fresh state -> snapshot from the host
    expect(B2.g.tick).toBeGreaterThanOrEqual(A.g.tick - 2);
    const t = Math.min(A.g.tick, B2.g.tick);
    const tt = t - (t % 20);
    expect(B2.hashes.get(tt)).toBe(A.hashes.get(tt));
    // and it still plays: its command reaches the host as peer 2
    B2.paint(10, 10);
    await play(r.clock, [A, B2], 500);
    expect(Array.from(A.g.grid)).toEqual(Array.from(B2.g.grid));
  });

  it("an unknown or expired token is rejected (plain welcome, no lobby)", async () => {
    const r = rig();
    await expect(r.make("x").rejoin("nope")).rejects.toMatchObject({ code: "invalid_token" });
  });
});

describe("restore() failures", () => {
  it("a throwing restore leaves ticks untouched, reports, and asks for a fresh snapshot", async () => {
    const r = rig();
    const errors: string[] = [];
    const kitC = r.make("cara");
    kitC.on("error", (e) => errors.push(e.message));
    const la = await r.make("alice").host({ name: "t", maxPlayers: 4 });
    const A = new Player("a", la);
    await la.start();
    await play(r.clock, [A], 1000);
    const lc = await kitC.join(la.code);
    const C = new Player("c", lc);
    let calls = 0;
    const real = lc.lockstep.restore!;
    lc.lockstep.restore = (tick, bytes) => {
      if (++calls === 1) throw new Error("boom");
      real(tick, bytes);
    };
    await play(r.clock, [A, C], 3000);
    expect(errors).toContain("boom");
    expect(calls).toBe(2);
    expect(C.restores.length).toBe(1);
    const t = Math.min(A.g.tick, C.g.tick);
    const tt = t - (t % 20);
    expect(C.hashes.get(tt)).toBe(A.hashes.get(tt));
  });

  it("gives up after repeated failures instead of looping", async () => {
    const r = rig();
    const errors: string[] = [];
    const kitC = r.make("cara");
    kitC.on("error", (e) => errors.push(e.message));
    const la = await r.make("alice").host({ name: "t", maxPlayers: 4 });
    const A = new Player("a", la);
    await la.start();
    await play(r.clock, [A], 1000);
    const lc = await kitC.join(la.code);
    const C = new Player("c", lc);
    let calls = 0;
    lc.lockstep.restore = () => {
      calls++;
      throw new Error("always");
    };
    await play(r.clock, [A, C], 6000);
    expect(calls).toBe(4); // first try + 3 retries
    expect(errors.filter((e) => e.includes("giving up")).length).toBe(1);
    expect(C.g.tick).toBe(0); // never advanced
  });
});
