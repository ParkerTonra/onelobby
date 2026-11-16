import { describe, expect, it } from "vitest";
import { encodeInput } from "../src/internals.js";
import { alienEntity, newAlien, RepRig, type RepPlayer } from "./replication-rig.js";

const ALIEN = 7;
const WORLD = 5;
const NET = { latencyMs: 100, jitterMs: 20, lossRate: 0.03 };

/** The client's session starts over on the same lobby: a new session object, sequence numbers from 1, no snapshot. */
function restart(a: RepPlayer): void {
  a.session.dispose();
  a.attach({ keyframeSeconds: 0 });
}

async function world(opts: { keyframes?: boolean } = {}, net = NET) {
  const rig = new RepRig({ keyframeSeconds: opts.keyframes ? 5 : 0 }, net);
  const host = await rig.startHost();
  const a = await rig.join("a");
  for (let i = 0; i < WORLD; i++) host.session.spawn(ALIEN, 0, alienEntity(newAlien({ x: i })));
  a.makeInput = (t) => Uint8Array.of(t & 0xff);
  rig.hostTick = () => void host.session.tryGetInput(a.peerId);
  return { rig, host, a };
}

const worldSize = (a: RepPlayer): number => {
  const w = a.session.clientWorlds();
  return w.length === 0 ? 0 : w[w.length - 1].ents.length;
};

/** Virtual ms from now until the client's newest decoded world holds the whole scene (-1 = never within `maxMs`). */
async function msToWorld(rig: RepRig, a: RepPlayer, maxMs = 4000): Promise<number> {
  const t0 = rig.base.clock.now();
  for (let i = 0; i < maxMs / rig.frameMs; i++) {
    if (worldSize(a) === WORLD) return rig.base.clock.now() - t0;
    await rig.step();
  }
  return -1;
}

describe("ack 0 from a client that had acked: its session started over", () => {
  it("a second session gets the full world within a few ticks, then deltas resume", async () => {
    const { rig, host, a } = await world();
    await rig.run(3);
    expect(host.session.ackedTick(a.peerId)).toBeGreaterThan(0);
    const fullBefore = host.session.stats.fullSnapshotsSent;
    restart(a);
    expect(worldSize(a)).toBe(0);
    const sent0 = rig.sentBytes(host, "fast");
    const ms = await msToWorld(rig, a);
    const ticks = ms / host.session.clock.tickMs;
    console.log(`ack0 second session: world after ${ms} ms (${ticks.toFixed(1)} ticks), extra full snapshots ${host.session.stats.fullSnapshotsSent - fullBefore}, ${rig.sentBytes(host, "fast") - sent0} bytes sent on fast meanwhile`);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ticks, "ticks until the second session has the world (about one round trip: 200 ms = 6 ticks, plus jitter and loss)").toBeLessThanOrEqual(12);
    // deltas resume: no more full snapshots once the second session acked a snapshot sent after the restart
    await rig.run(1);
    const fulls = host.session.stats.fullSnapshotsSent;
    const bytes = rig.sentBytes(host, "fast");
    await rig.run(1.5);
    expect(host.session.stats.fullSnapshotsSent - fulls, "full snapshots in 1.5 s after the resync").toBe(0);
    console.log(`ack0 deltas: ${((rig.sentBytes(host, "fast") - bytes) / 45).toFixed(1)} bytes per snapshot (fast, lobby frames included)`);
    expect(host.session.ackedTick(a.peerId)).toBeGreaterThan(0);
  });

  it("a single session with jitter and reordering never triggers one", async () => {
    const { rig, host, a } = await world({}, { latencyMs: 60, jitterMs: 90, lossRate: 0.05 });
    await rig.run(2);
    let zeroed = 0;
    let was = host.session.ackedTick(a.peerId);
    const full0 = host.session.stats.fullSnapshotsSent;
    for (let i = 0; i < (120 * 1000) / rig.frameMs; i++) {
      await rig.step();
      const now = host.session.ackedTick(a.peerId);
      if (was > 0 && now === 0) zeroed++;
      was = now;
    }
    console.log(`ack0 long run: 120 s, jitter 90 ms, 5% loss: ${zeroed} restarts, ${host.session.stats.fullSnapshotsSent - full0} full snapshots`);
    expect(zeroed).toBe(0);
    expect(host.session.stats.fullSnapshotsSent - full0).toBe(0);
  });

  it("a late packet with ack 0 right after the first ack is not a restart", async () => {
    const { rig, host, a } = await world();
    expect(await rig.until(() => host.session.ackedTick(a.peerId) > 0)).toBe(true);
    const before = host.session.ackedTick(a.peerId);
    // an input the old session sent before its first snapshot arrived, delivered after a newer one
    a.lobby.send(a.lobby.hostPeerId, encodeInput(0, 2, [{ view256: 0, bytes: Uint8Array.of(1) }]), { channel: "fast" });
    await rig.run(0.1);
    expect(host.session.ackedTick(a.peerId)).toBeGreaterThanOrEqual(before);
  });

  it("it is not a tap: at most one restart per history length, however the client alternates", async () => {
    const { rig, host, a } = await world();
    await rig.run(3);
    const zero = () => a.lobby.send(a.lobby.hostPeerId, encodeInput(0, 1, [{ view256: 0, bytes: Uint8Array.of(1) }]), { channel: "fast" });
    let restarts = 0;
    let was = host.session.ackedTick(a.peerId);
    const seconds = 20;
    for (let i = 0; i < (seconds * 1000) / rig.frameMs; i++) {
      if (i % 3 === 0) zero(); // an ack 0 every 48 ms between real acks
      await rig.step();
      const now = host.session.ackedTick(a.peerId);
      if (was > 0 && now === 0) restarts++;
      was = now;
    }
    const allowed = Math.ceil((seconds * 30) / host.session.config.historyTicks);
    console.log(`ack0 tap: ${restarts} restarts in ${seconds} s with an ack 0 every 48 ms (limit ${allowed})`);
    expect(restarts).toBeGreaterThanOrEqual(1);
    expect(restarts).toBeLessThanOrEqual(allowed);
  });

  it("the inputs of a second session are applied from sequence 1, nothing counted lost", async () => {
    const { rig, host, a } = await world();
    const handed: { seq: number; repeated: boolean }[] = [];
    rig.hostTick = () => {
      const f = host.session.tryGetInput(a.peerId);
      if (f) handed.push({ seq: f.seq, repeated: f.repeated });
    };
    await rig.run(4); // the first session reaches sequence ~120
    const first = handed.filter((h) => !h.repeated).map((h) => h.seq);
    expect(Math.max(...first)).toBeGreaterThan(80);
    const lost = host.session.inputStatsFor(a.peerId).lost;
    handed.length = 0;
    restart(a);
    await rig.run(2);
    // the first frames can still be the old session's queued inputs (sequence ~120); the new session's start at 1
    const second = handed.filter((h) => !h.repeated && h.seq < 100);
    console.log(`ack0 second session inputs: ${second.length} applied in 2 s (first seq ${second[0]?.seq}), repeated frames ${handed.filter((h) => h.repeated).length}, lost ${host.session.inputStatsFor(a.peerId).lost - lost}`);
    expect(second.length).toBeGreaterThan(30);
    expect(second[0].seq).toBe(1);
    expect(host.session.inputStatsFor(a.peerId).lost - lost).toBeLessThanOrEqual(3);
  });

  it("a packet of the old session still in flight after the restart is dropped whole", async () => {
    const { rig, host, a } = await world();
    await rig.run(3);
    restart(a);
    await rig.until(() => host.session.ackedTick(a.peerId) === 0, 200); // the host saw the restart, the new session has not acked yet
    const handed: number[] = [];
    rig.hostTick = () => {
      const f = host.session.tryGetInput(a.peerId);
      if (f && !f.repeated) handed.push(f.seq);
    };
    // an old-session packet: ack of a tick sent before the restart, sequence 9000
    const tick = host.session.clock.tick - 20;
    a.lobby.send(a.lobby.hostPeerId, encodeInput(tick, 9000, [{ view256: 0, bytes: Uint8Array.of(9) }]), { channel: "fast" });
    await rig.run(1.5);
    expect(handed.length).toBeGreaterThan(10);
    expect(handed).not.toContain(9000);
    expect(handed[0]).toBeLessThan(10);
  });
});
