import { describe, expect, it } from "vitest";
import { ErrorCodes, describeError, type PauseState } from "../src/index.js";
import type { Lobby } from "../src/internals.js";
import { settle } from "../src/testing.js";
import { Player, play, rig } from "./helpers.js";

/** A host (peer 1) and one or more joiners, all linked; `start` begins the game. */
async function room(joiners = 1, opts: { start?: boolean; mode?: "lockstep" | "raw" } = {}) {
  const r = rig();
  const host = await r.make("host", { mode: opts.mode ?? "lockstep" }).host({ name: "t", maxPlayers: 6 });
  const others: Lobby[] = [];
  for (let i = 0; i < joiners; i++) others.push(await r.make(`p${i + 2}`, { mode: opts.mode ?? "lockstep" }).join(host.code));
  await settle();
  if (opts.start !== false) {
    await host.start();
    await settle();
  }
  const log = (l: Lobby) => {
    const changed: PauseState[] = [];
    const refused: string[] = [];
    l.pause.on("changed", (s) => changed.push(s));
    l.pause.on("refused", (c) => refused.push(c));
    return { changed, refused };
  };
  return { r, host, others, log };
}

const gap = async (r: { clock: { advance(ms: number): void } }, ms = 600) => {
  r.clock.advance(ms);
  await settle();
};

describe("shared pause", () => {
  it("any player pauses, the pauser resumes; everyone sees both changes", async () => {
    const { r, host, others, log } = await room(2, { mode: "raw" });
    const [bob, cara] = others;
    const h = log(host), c = log(cara);
    expect(host.pause.state).toEqual({ paused: false, byPeer: 0, pauserLeft: false });
    bob.pause.request(true);
    await settle();
    for (const l of [host, bob, cara]) expect(l.pause.state).toEqual({ paused: true, byPeer: 2, pauserLeft: false });
    expect(bob.pause.canResume).toBe(true);
    expect(host.pause.canResume).toBe(true);
    expect(cara.pause.canResume).toBe(false);
    await gap(r);
    bob.pause.request(false);
    await settle();
    for (const l of [host, bob, cara]) expect(l.pause.state).toEqual({ paused: false, byPeer: 2, pauserLeft: false });
    expect(h.changed.map((s) => s.paused)).toEqual([true, false]);
    expect(c.changed.map((s) => s.paused)).toEqual([true, false]);
    expect(host.pause.canResume).toBe(false);
  });

  it("a joiner who did not pause cannot resume; the host can", async () => {
    const { r, host, others, log } = await room(2, { mode: "raw" });
    const [bob, cara] = others;
    const c = log(cara);
    bob.pause.request(true);
    await settle();
    cara.pause.request(false);
    await settle();
    expect(c.refused).toEqual(["not_allowed"]);
    expect(cara.pause.state.paused).toBe(true);
    expect(host.pause.state.paused).toBe(true);
    await gap(r);
    host.pause.request(false);
    await settle();
    for (const l of [host, bob, cara]) expect(l.pause.state.paused).toBe(false);
  });

  it("the host can pause and anyone can then be refused a resume; a joiner pause is resumed by the host", async () => {
    const { host, others } = await room(1, { mode: "raw" });
    const [bob] = others;
    host.pause.request(true);
    await settle();
    expect(bob.pause.state).toEqual({ paused: true, byPeer: 1, pauserLeft: false });
    expect(bob.pause.canResume).toBe(false);
  });

  it("when the pauser leaves the host holds the pause and says so", async () => {
    const { host, others, log } = await room(2, { mode: "raw" });
    const [bob, cara] = others;
    const c = log(cara);
    bob.pause.request(true);
    await settle();
    await bob.leave();
    await settle();
    for (const l of [host, cara]) expect(l.pause.state).toEqual({ paused: true, byPeer: 1, pauserLeft: true });
    expect(c.changed.at(-1)).toEqual({ paused: true, byPeer: 1, pauserLeft: true });
    expect(cara.pause.canResume).toBe(false);
    expect(host.pause.canResume).toBe(true);
    host.pause.request(false);
    await settle();
    expect(cara.pause.state.paused).toBe(false);
  });

  it("a late joiner learns the state once its link is up", async () => {
    const { r, host, others } = await room(1, { mode: "raw" });
    others[0].pause.request(true);
    await settle();
    const dan = await r.make("dan", { mode: "raw" }).join(host.code);
    await settle();
    expect(dan.pause.state).toEqual({ paused: true, byPeer: 2, pauserLeft: false });
    expect(dan.pause.canResume).toBe(false);
  });

  it("requests are limited to one accepted per 0.5 s per peer", async () => {
    const { r, host, others, log } = await room(1, { mode: "raw" });
    const [bob] = others;
    const b = log(bob);
    bob.pause.request(true);
    await settle();
    bob.pause.request(false); // too soon
    await settle();
    expect(b.refused).toEqual(["rate_limited"]);
    expect(host.pause.state.paused).toBe(true);
    await gap(r, 500);
    bob.pause.request(false);
    await settle();
    expect(host.pause.state.paused).toBe(false);
  });

  it("outside the game phase a request is refused with not_in_game, for a joiner and for the host", async () => {
    const { host, others, log } = await room(1, { start: false, mode: "raw" });
    const [bob] = others;
    const b = log(bob), h = log(host);
    bob.pause.request(true);
    host.pause.request(true);
    await settle();
    expect(b.refused).toEqual([ErrorCodes.NotInGame]);
    expect(h.refused).toEqual([ErrorCodes.NotInGame]);
    expect(host.pause.state.paused).toBe(false);
    expect(describeError(ErrorCodes.NotInGame).message).toMatch(/game/i);
    expect(describeError(ErrorCodes.NotAllowed).message).toBeTruthy();
  });

  it("the state clears when the phase goes back to the lobby", async () => {
    const { host, others, log } = await room(1, { mode: "raw" });
    const [bob] = others;
    const b = log(bob);
    bob.pause.request(true);
    await settle();
    (host as unknown as { signaling: { send(m: object): void } }).signaling.send({ t: "phase", phase: "lobby" });
    await settle();
    expect(host.phase).toBe("lobby");
    for (const l of [host, bob]) expect(l.pause.state.paused).toBe(false);
    expect(b.changed.map((s) => s.paused)).toEqual([true, false]);
  });

  it("clear() unpauses at once, skipping policy and rate limit; joiners cannot call it", async () => {
    const { host, others } = await room(1, { mode: "raw" });
    const [bob] = others;
    host.pause.policy = () => false; // nobody may resume through a request
    bob.pause.request(true); // refused by the policy
    await settle();
    expect(host.pause.state.paused).toBe(false);
    host.pause.policy = null;
    bob.pause.request(true);
    await settle();
    host.pause.clear(); // within 0.5 s of the pause
    await settle();
    for (const l of [host, bob]) expect(l.pause.state.paused).toBe(false);
    expect(() => bob.pause.clear()).toThrow();
    host.pause.clear(); // not paused: nothing
  });

  it("a host policy hook can make pausing host-only", async () => {
    const { host, others, log } = await room(1, { mode: "raw" });
    const [bob] = others;
    const b = log(bob);
    host.pause.policy = (peer) => peer === host.localPeerId;
    bob.pause.request(true);
    await settle();
    expect(b.refused).toEqual(["not_allowed"]);
    host.pause.request(true);
    await settle();
    expect(bob.pause.state.paused).toBe(true);
  });

  it("mode off throws pause_disabled; mode host is host-only by default", async () => {
    const { r, host, others } = await room(1, { mode: "raw" });
    const [bob] = others;
    bob.pause.mode = "off";
    expect(() => bob.pause.request(true)).toThrowError(expect.objectContaining({ code: "pause_disabled" }));
    expect(() => bob.pause.request(true)).toThrowError(/set session\.pause to "anyone" or "host"/);
    host.pause.mode = "host";
    bob.pause.mode = "anyone";
    bob.pause.request(true);
    await settle();
    expect(host.pause.state.paused).toBe(false);
    host.pause.request(true);
    await settle();
    expect(bob.pause.state.paused).toBe(true);
    await gap(r);
    expect(host.pause.canResume).toBe(true);
  });
});

describe("shared pause and lockstep", () => {
  async function trio() {
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

  it("the host stops issuing frames while paused and resumes at tick+1 with no gap and matching hashes", async () => {
    const { r, la, lb, lc, A, B, C } = await trio();
    lb.pause.request(true);
    await play(r.clock, [A, B, C], 200); // frames already in flight drain
    const frozen = [A.g.tick, B.g.tick, C.g.tick];
    expect(new Set(frozen).size).toBe(1);
    await play(r.clock, [A, B, C], 15_000); // longer than the silent-host (3 s) and silent-peer (10 s) limits
    expect([A.g.tick, B.g.tick, C.g.tick]).toEqual(frozen);
    expect(lb.lockstep.framesBuffered).toBe(0);
    expect(lb.hostPeerId).toBe(1);
    expect(la.peers.length).toBe(3);
    B.paint(5, 5); // commands made while paused are held for the next frame
    await gap(r, 100);
    await play(r.clock, [A, B, C], 100);
    expect(A.g.tick).toBe(frozen[0]);
    la.pause.request(false);
    await play(r.clock, [A, B, C], 3000);
    expect(A.g.tick).toBeGreaterThan(frozen[0] + 40);
    expect(A.g.tick - frozen[0]).toBeLessThan(80); // no burst to catch up the paused time
    const t = Math.min(A.g.tick, B.g.tick, C.g.tick);
    const tt = t - (t % 20);
    expect(B.hashes.get(tt)).toBe(A.hashes.get(tt));
    expect(C.hashes.get(tt)).toBe(A.hashes.get(tt));
    expect(A.desyncs + B.desyncs + C.desyncs).toBe(0);
    expect(B.g.grid[5 * 16 + 5]).not.toBe(0);
    expect(la.peers.length).toBe(3);
  });

  it("host migration while paused: the new host keeps the pause, takes it over, and resumes the frames", async () => {
    const { r, la, lb, lc, A, B, C } = await trio();
    la.pause.request(true);
    await play(r.clock, [A, B, C], 500);
    const frozen = B.g.tick;
    await la.leave();
    await play(r.clock, [B, C], 5000);
    expect(lb.isHost).toBe(true);
    for (const l of [lb, lc]) expect(l.pause.state).toEqual({ paused: true, byPeer: 2, pauserLeft: true });
    expect(B.g.tick).toBe(frozen);
    expect(lc.hostPeerId).toBe(2);
    lb.pause.request(false);
    await play(r.clock, [B, C], 3000);
    expect(B.g.tick).toBeGreaterThan(frozen + 40);
    expect(C.g.tick).toBeGreaterThanOrEqual(B.g.tick - 2);
    const t = Math.min(B.g.tick, C.g.tick);
    expect(C.hashes.get(t - (t % 20))).toBe(B.hashes.get(t - (t % 20)));
    expect(B.desyncs + C.desyncs).toBe(0);
  });
});
