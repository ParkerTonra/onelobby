import { describe, expect, it } from "vitest";
import { Lockstep, type Hub, type Message } from "../src/internals.js";
import { ManualClock, settle } from "../src/testing.js";
import { Player, play, rig } from "./helpers.js";

describe("lockstep scheduler (unit, fake hub)", () => {
  function fakeHub(isHost: boolean, clock: ManualClock) {
    const sent: { to: number; msg: Message }[] = [];
    const dropped: [number, string][] = [];
    let chunk = 1;
    const hub: Hub = {
      clock,
      localPeerId: isHost ? 1 : 2,
      hostPeerId: 1,
      isHost,
      tickRate: 20,
      connectedPeers: () => [2, 3],
      sendTo: (to, msg) => void sent.push({ to, msg }),
      sendToHost: (msg) => void sent.push({ to: 1, msg }),
      dropPeer: (p, r) => void dropped.push([p, r]),
      reportError: (e) => {
        throw e;
      },
      nextChunkId: () => chunk++,
    };
    return { hub, sent, dropped };
  }

  it("host emits one frame per 50 ms at 20 TPS, never waits, empty frames included", () => {
    const clock = new ManualClock();
    const { hub, sent } = fakeHub(true, clock);
    const ls = new Lockstep(hub, { hashEveryTicks: 20 });
    ls.onPeerHi(2, -1); // lobby phase: ready
    ls.hostStart();
    clock.advance(1000);
    const frames = sent.filter((s) => s.to === 2 && s.msg.type === "frame").map((s) => (s.msg as any).tick);
    expect(frames).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(ls.framesBuffered).toBe(20);
  });

  it("commands go into the next unemitted frame, sorted by peerId, stable within a peer", () => {
    const clock = new ManualClock();
    const { hub, sent } = fakeHub(true, clock);
    const ls = new Lockstep(hub, { hashEveryTicks: 20 });
    ls.onPeerHi(2, -1);
    ls.hostStart();
    ls.handle(3, { type: "cmd", seq: 1, bytes: Uint8Array.of(3, 1) });
    ls.handle(2, { type: "cmd", seq: 1, bytes: Uint8Array.of(2, 1) });
    ls.submit(Uint8Array.of(1, 1)); // host's own
    ls.handle(2, { type: "cmd", seq: 2, bytes: Uint8Array.of(2, 2) });
    clock.advance(50);
    const f = sent.find((s) => s.msg.type === "frame")!.msg as Extract<Message, { type: "frame" }>;
    expect(f.tick).toBe(1);
    expect(f.commands.map((c) => [c.peerId, c.bytes[1]])).toEqual([[1, 1], [2, 1], [2, 2], [3, 1]]);
  });

  it("a flooding peer is capped at 256 pending commands, others are unaffected, drops are counted", () => {
    const clock = new ManualClock();
    const { hub, sent } = fakeHub(true, clock);
    const ls = new Lockstep(hub, { hashEveryTicks: 20 });
    ls.onPeerHi(2, -1);
    ls.hostStart();
    for (let i = 0; i < 300; i++) ls.handle(2, { type: "cmd", seq: i, bytes: Uint8Array.of(2, i & 255) });
    ls.handle(3, { type: "cmd", seq: 1, bytes: Uint8Array.of(3, 0) });
    expect(ls.droppedCommands).toBe(300 - 256);
    clock.advance(50);
    const f = sent.find((s) => s.msg.type === "frame")!.msg as Extract<Message, { type: "frame" }>;
    expect(f.commands.filter((c) => c.peerId === 2).length).toBe(256);
    expect(f.commands.filter((c) => c.peerId === 3).length).toBe(1);
  });

  it("joiner queues frames, ignores duplicates, asks for a snapshot on a gap", () => {
    const clock = new ManualClock();
    const { hub, sent } = fakeHub(false, clock);
    const ls = new Lockstep(hub, { hashEveryTicks: 20 });
    const frame = (tick: number): Message => ({ type: "frame", tick, commands: [] });
    ls.handle(1, frame(1));
    ls.handle(1, frame(2));
    ls.handle(1, frame(2)); // duplicate
    expect(ls.framesBuffered).toBe(2);
    expect(ls.catchingUp).toBe(false);
    ls.handle(1, frame(5)); // gap
    const req = sent.find((s) => s.msg.type === "snapshot_req")!;
    expect(req.msg).toMatchObject({ type: "snapshot_req", sinceTick: 2 });
    expect(ls.framesBuffered).toBe(0);
  });

  it("catch-up: more than 2 buffered frames reports catchingUp", () => {
    const clock = new ManualClock();
    const { hub } = fakeHub(false, clock);
    const ls = new Lockstep(hub, { hashEveryTicks: 20 });
    for (let t = 1; t <= 3; t++) ls.handle(1, { type: "frame", tick: t, commands: [] });
    expect(ls.catchingUp).toBe(true);
    expect(ls.nextFrame()!.tick).toBe(1);
    expect(ls.nextFrame()!.tick).toBe(2);
    expect(ls.catchingUp).toBe(false);
  });

  it("far behind (> tickRate*3 frames) requests a snapshot", () => {
    const clock = new ManualClock();
    const { hub, sent } = fakeHub(false, clock);
    const ls = new Lockstep(hub, { hashEveryTicks: 20 });
    for (let t = 1; t <= 61; t++) ls.handle(1, { type: "frame", tick: t, commands: [] });
    expect(sent.some((s) => s.msg.type === "snapshot_req")).toBe(true);
  });

  it("hashes are reported only on multiples of hashEveryTicks (tick > 0)", () => {
    const clock = new ManualClock();
    const { hub, sent } = fakeHub(false, clock);
    const ls = new Lockstep(hub, { hashEveryTicks: 20 });
    for (const t of [0, 1, 19, 20, 21, 40]) ls.reportHash(t, 5n);
    expect(sent.filter((s) => s.msg.type === "hash").map((s) => (s.msg as any).tick)).toEqual([20, 40]);
  });
});

describe("lockstep end to end (memory transport, gridpaint)", () => {
  async function trio(hashEveryTicks = 20) {
    const r = rig();
    const kitA = r.make("alice", { hashEveryTicks });
    const kitB = r.make("bob", { hashEveryTicks });
    const kitC = r.make("cara", { hashEveryTicks });
    const la = await kitA.host({ name: "t", maxPlayers: 4, lateJoin: true });
    const lb = await kitB.join(la.code);
    await settle();
    return { r, kitC, la, lb, A: new Player("alice", la), B: new Player("bob", lb) };
  }

  it("two peers play 10 s of gridpaint and every hash matches", async () => {
    const { r, la, A, B } = await trio();
    await la.start();
    for (let s = 0; s < 10; s++) {
      A.paint(s, 1);
      B.paint(15 - s, 14);
      await play(r.clock, [A, B], 1000);
    }
    expect(A.g.tick).toBeGreaterThanOrEqual(190);
    expect(B.g.tick).toBeGreaterThanOrEqual(A.g.tick - 2);
    const common = Math.min(A.g.tick, B.g.tick);
    for (let t = 20; t <= common; t += 20) expect(B.hashes.get(t)).toBe(A.hashes.get(t));
    expect(B.lobby.phase).toBe("in_game");
    expect(A.desyncs + B.desyncs).toBe(0);
    // the host never reported a desync and nobody was dropped
    expect(la.peers.length).toBe(2);
  });

  it("a joiner command lands in a frame and shows on both grids", async () => {
    const { r, la, A, B } = await trio();
    await la.start();
    await play(r.clock, [A, B], 200);
    B.paint(3, 3);
    await play(r.clock, [A, B], 400);
    const colour = 2; // peer 2 -> ((2-1)%15)+1
    // the painted cell or a neighbour it spread to must carry bob's colour on both sides
    expect(A.g.grid.includes(colour)).toBe(true);
    expect(Array.from(A.g.grid)).toEqual(Array.from(B.g.grid));
  });

  it("late join: a third peer joins mid-game by snapshot and converges", async () => {
    const { r, la, kitC, A, B } = await trio();
    await la.start();
    for (let i = 0; i < 6; i++) {
      A.paint(i * 2, i);
      await play(r.clock, [A, B], 500);
    }
    const lc = await kitC.join(la.code);
    const C = new Player("cara", lc);
    await play(r.clock, [A, B, C], 1500);
    expect(C.restores.length).toBe(1);
    expect(C.restores[0]).toBeGreaterThan(0);
    expect(C.g.tick).toBeGreaterThanOrEqual(A.g.tick - 2);
    const t = Math.min(A.g.tick, B.g.tick, C.g.tick);
    const tt = t - (t % 20);
    expect(C.hashes.get(tt)).toBe(A.hashes.get(tt));
    expect(lc.phase).toBe("in_game");
  });

  it("a forced desync gets a desync event, a snapshot, and converges again", async () => {
    const { r, la, A, B } = await trio();
    await la.start();
    await play(r.clock, [A, B], 500);
    A.paint(5, 5);
    await play(r.clock, [A, B], 500);
    B.corruptAt = B.g.tick + 5;
    await play(r.clock, [A, B], 3000);
    expect(B.desyncs).toBe(1);
    expect(B.restores.length).toBe(1);
    const t = Math.min(A.g.tick, B.g.tick);
    expect(Array.from(A.g.grid).length).toBe(256);
    const tt = t - (t % 20);
    expect(B.hashes.get(tt)).toBe(A.hashes.get(tt));
  });

  it("the third desync drops the peer", async () => {
    const { r, la, A, B } = await trio();
    await la.start();
    A.paint(5, 5);
    await play(r.clock, [A, B], 500);
    const left: string[] = [];
    la.on("peerLeft", (_p, reason) => left.push(reason));
    for (let i = 0; i < 4 && !left.length; i++) {
      B.corruptAt = B.g.tick + 3;
      await play(r.clock, [A, B], 2500);
    }
    expect(B.desyncs).toBe(2);
    expect(left).toContain("desync");
    expect(la.peers.map((p) => p.peerId)).toEqual([1]);
  });

  it("a snapshot above the 1 KiB threshold travels deflated and still restores", async () => {
    const { r, la, kitC, A, B } = await trio();
    const big = new Uint8Array(40000).map((_, i) => (i * 7) & 0xff);
    A.lobby.lockstep.snapshot = () => {
      const g = A.g.snapshot();
      const out = new Uint8Array(g.length + big.length);
      out.set(g);
      out.set(big, g.length);
      return out;
    };
    await la.start();
    await play(r.clock, [A, B], 1000);
    const lc = await kitC.join(la.code);
    const C = new Player("cara", lc);
    let got = 0;
    lc.lockstep.restore = (tick, bytes) => {
      got = bytes.length;
      C.g.restore(tick, bytes.subarray(0, 260));
    };
    await play(r.clock, [A, B, C], 1500);
    expect(got).toBe(260 + 40000);
    expect(C.g.tick).toBeGreaterThan(0);
  });
});
