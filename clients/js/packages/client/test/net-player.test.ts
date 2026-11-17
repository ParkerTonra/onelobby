import { describe, expect, it } from "vitest";
import type { ActionName } from "../src/index.js";
import { PlayerRig, pathAt } from "./player-rig.js";
import { comparePaths, dist, drive, record, scene, walkStep, type Mode, type Sample } from "./net-player-scenario.js";

const MODES: Mode[] = ["owner", "host"];
const PEER = (s: { a: { peerId: number } }) => s.a.peerId;

// Numbers stated in spec/net-player.md "Tests": the bounds these tests hold the layer to. The three clients hold the same ones.
// D1: per seed the mean and the 99th percentile of the per-frame error, over all seeds the worst frame. Measured (loss 3%, jitter 20 ms,
// seeds 1 to 8, both authorities, this rig): mean 0.034 to 0.114 m, 99th percentile 0.094 to 0.318 m, worst frame 0.358 m.
const D1_SEEDS = [1, 2, 7, 8];
const D1_MEAN_ERROR_M = 0.15;
const D1_P99_ERROR_M = 0.4;
const D1_MAX_ERROR_M = 0.45;
const D1B_MAX_ERROR_M = 0.25;
const CARRY_ON_CAP_MS = 250;
const D3_ON_TIME_TICKS = 2;
const D4_BUDGET = { hostToClient: 1500, clientToHost: 3500 };

describe("D1 the watched player's path stays within an error of the owner's path, over several seeds of loss and jitter", () => {
  for (const mode of MODES) {
    it(mode, async () => {
      let worst = 0;
      const rows: string[] = [];
      for (const seed of D1_SEEDS) {
        const s = await scene(mode, { seed });
        drive(s);
        await s.rig.run(3);
        const { owner, watched } = await record(s, 20);
        const r = comparePaths(owner, watched);
        rows.push(`seed ${seed}: lag ${r.lagMs} ms, mean ${r.mean.toFixed(3)} m, p99 ${r.p99.toFixed(3)} m, worst ${r.max.toFixed(3)} m, delay ${s.bl.session.interpolationDelayMs.toFixed(1)} ms`);
        expect(watched.length, `seed ${seed}`).toBeGreaterThan(1000);
        expect(r.mean, `seed ${seed} mean`).toBeLessThan(D1_MEAN_ERROR_M);
        expect(r.p99, `seed ${seed} p99`).toBeLessThan(D1_P99_ERROR_M);
        worst = Math.max(worst, r.max);
      }
      console.log(`D1 ${mode}: ` + rows.join(" | ") + ` | worst frame over all seeds ${worst.toFixed(3)} m`);
      expect(worst).toBeLessThan(D1_MAX_ERROR_M);
    });
  }
});

// A lost or late input leaves a tick on which the host has nothing new from the owner. Owner mode must not keep that tick as
// extra delay for the rest of the run: with no jitter, 3% loss, these seeds made the watched path jump by a whole tick
// (0.44 to 0.49 m worst, 0.16 m with no loss) before the host carried the owner on and made the stall up.
describe("D1b a stalled tick does not stay as delay (owner authority, loss 3%, no jitter)", () => {
  for (const seed of [4, 10, 13]) {
    it(`seed ${seed}`, async () => {
      const s = await scene("owner", { seed, jitterMs: 0 });
      drive(s);
      await s.rig.run(3);
      const { owner, watched } = await record(s, 20);
      const r = comparePaths(owner, watched);
      console.log(`D1b seed ${seed}: lag ${r.lagMs} ms, mean ${r.mean.toFixed(3)} m, worst ${r.max.toFixed(3)} m`);
      expect(r.max).toBeLessThan(D1B_MAX_ERROR_M);
    });
  }
});

// One runner hitch: a process that stalls for 4, 5 or 7 ticks mid-walk, then runs on. The owner's stall, or the host's, must not leave
// the host's record of the walker a tick or more ahead for the rest of the run. As in the engine-smoke players run, the path judged is
// the host's own record of the walker against the walker's own path (not a third peer's interpolated view). Samples are not taken while
// the hitched process is stopped (a stopped process samples nothing) nor for two seconds after it (the stall itself is lost time and the
// path takes a moment to settle; it is the lag that is left that counts). The whole of the rest is judged with the D1 bounds, one
// constant lag fitted over the run, and the lag fitted after the hitch must be the lag fitted before it, give or take half a tick.
// No loss (jitter 20 ms as in D1): a lost command is a step a host-mode host never takes whatever the hitch, which would bury the hitch in noise.
describe("D1c a hitch of 4, 5 or 7 ticks does not leave the host's record ahead", () => {
  for (const mode of MODES) {
    for (const who of ["owner", "host"] as const) {
      for (const ticks of [4, 5, 7]) {
        it(`${mode} authority, ${who} stalls ${ticks} ticks`, async () => {
          let worst = 0;
          let worstMean = 0;
          let maxShift = 0;
          const rows: string[] = [];
          for (const seed of D1_SEEDS) {
            const s = await scene(mode, { seed, lossRate: 0 });
            drive(s);
            await s.rig.run(6); // past the start-up of the clocks and the buffers
            const victim = who === "owner" ? s.a.name : s.host.name;
            const frozenFrames = Math.ceil((ticks * 1000) / 30 / s.rig.frameMs);
            const hitchAt = Math.floor(10000 / s.rig.frameMs);
            const settle = Math.floor(2000 / s.rig.frameMs);
            const frames = Math.floor(20000 / s.rig.frameMs);
            const owner: Sample[] = [];
            const before: Sample[] = [];
            const after: Sample[] = [];
            for (let i = 0; i < frames; i++) {
              if (i === hitchAt) s.rig.frozen.add(victim);
              if (i === hitchAt + frozenFrames) s.rig.frozen.delete(victim);
              await s.rig.step();
              const stopped = i >= hitchAt && i < hitchAt + frozenFrames;
              const t = s.rig.nowMs;
              const mine = s.al.get(s.al.localPeerId);
              if (mine && !(stopped && who === "owner")) owner.push({ t, x: mine.x, y: mine.y, z: mine.z });
              const seen = s.hl.get(s.al.localPeerId);
              if (!seen) continue;
              if (i < hitchAt) before.push({ t, x: seen.x, y: seen.y, z: seen.z });
              else if (i >= hitchAt + frozenFrames + settle) after.push({ t, x: seen.x, y: seen.y, z: seen.z });
            }
            const all = [...before, ...after];
            const r = comparePaths(owner, all);
            const rb = comparePaths(owner, before);
            const ra = comparePaths(owner, after);
            rows.push(`seed ${seed}: lag ${r.lagMs} ms, mean ${r.mean.toFixed(3)} m, worst ${r.max.toFixed(3)} m; lag before ${rb.lagMs} ms, after ${ra.lagMs} ms`);
            expect(all.length, `seed ${seed}`).toBeGreaterThan(600);
            worst = Math.max(worst, r.max);
            worstMean = Math.max(worstMean, r.mean);
            maxShift = Math.max(maxShift, Math.abs(ra.lagMs - rb.lagMs));
          }
          console.log(`D1c ${mode} ${who} ${ticks}: ` + rows.join(" | "));
          expect(worstMean, "mean").toBeLessThan(D1_MEAN_ERROR_M);
          expect(worst, "worst").toBeLessThan(D1_MAX_ERROR_M);
          expect(maxShift, "the lag moved across the hitch (ms)").toBeLessThanOrEqual(16);
        });
      }
    }
  }
});

describe("D2 the watched player never stands still past the carry-on cap; it stops after the cap when snapshots stop", () => {
  for (const mode of MODES) {
    it(mode, async () => {
      const s = await scene(mode);
      drive(s);
      await s.rig.run(3);
      const { watched } = await record(s, 20);
      let still = 0;
      let longest = 0;
      for (let i = 1; i < watched.length; i++) {
        still = dist(watched[i], watched[i - 1]) < 1e-4 ? still + s.rig.frameMs : 0;
        longest = Math.max(longest, still);
      }
      console.log(`D2 ${mode}: longest stand-still ${longest} ms over ${watched.length} frames`);
      expect(longest).toBeLessThanOrEqual(CARRY_ON_CAP_MS);

      // the host stops sending: B's view of A carries on by its velocity for at most the cap, then holds
      s.rig.frozen.add("host");
      await s.rig.run(0.8);
      const newest = s.bl.latest(PEER(s))!;
      const p1 = s.bl.get(PEER(s))!;
      await s.rig.run(1.5);
      const p2 = s.bl.get(PEER(s))!;
      const carried = Math.hypot(p1.x - newest.x, p1.y - newest.y, p1.z - newest.z);
      const speed = Math.hypot(newest.vx, newest.vy, newest.vz);
      console.log(`D2 ${mode}: after the stop it held ${carried.toFixed(3)} m past the newest snapshot (speed ${speed.toFixed(2)} m/s, the cap allows ${(speed * 0.25).toFixed(3)} m)`);
      expect(Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z)).toBeLessThan(1e-6);
      expect(carried).toBeLessThanOrEqual(speed * (CARRY_ON_CAP_MS / 1000) + 0.05);
    });
  }
});

interface Played {
  name: string;
  seq: number;
  tick: number;
  late: boolean;
  renderTick: number;
}

async function eventRun(mode: Mode, lossRate: number) {
  const s = await scene(mode, { lossRate });
  drive(s);
  await s.rig.run(3);
  const atB: Played[] = [];
  const atHost: Played[] = [];
  for (const name of ["jump", "shoot", "melee"] as ActionName[]) {
    s.bl.onAction(name, (e) => {
      if (e.player === PEER(s)) atB.push({ name, seq: e.seq, tick: e.tick, late: e.late, renderTick: s.bl.session.renderTick });
    });
    s.hl.onAction(name, (e) => {
      if (e.player === PEER(s)) atHost.push({ name, seq: e.seq, tick: e.tick, late: e.late, renderTick: 0 });
    });
  }
  const sent: Record<string, number> = { jump: 0, shoot: 0, melee: 0 };
  const names = ["jump", "shoot", "melee"] as const;
  const frames = (30 * 1000) / s.rig.frameMs;
  const every = Math.round(120 / s.rig.frameMs);
  for (let i = 0; i < frames; i++) {
    await s.rig.step();
    if (i % every === 0) {
      const name = names[(i / every) % 3];
      s.al.action(name, name === "melee" ? { swing: sent.melee % 256 } : {});
      sent[name]++;
    }
  }
  await s.rig.run(3); // let the last ones arrive
  return { sent, atB, atHost, s };
}

describe("D3 every jump, shoot and melee arrives exactly once and on time", () => {
  for (const mode of MODES) {
    for (const loss of [0.03, 0.3]) {
      it(`${mode}, ${loss * 100}% loss`, async () => {
        const { sent, atB, atHost } = await eventRun(mode, loss);
        const total = sent.jump + sent.shoot + sent.melee;
        expect(total).toBeGreaterThanOrEqual(200);
        for (const name of ["jump", "shoot", "melee"]) {
          expect(atB.filter((e) => e.name === name).length, `${name} at B`).toBe(sent[name]);
          expect(atHost.filter((e) => e.name === name).length, `${name} at the host`).toBe(sent[name]);
        }
        const unique = new Set(atB.map((e) => e.seq)).size;
        expect(unique).toBe(total);
        const late = atB.filter((e) => e.late).length;
        const onTime = atB.filter((e) => !e.late).map((e) => e.renderTick - e.tick);
        const worst = Math.max(...onTime);
        console.log(`D3 ${mode} ${loss * 100}%: sent ${total}, at B ${atB.length}, at host ${atHost.length}, lost ${total - unique}, doubled ${atB.length - unique}, late ${late}, on-time ones played at most ${worst.toFixed(2)} ticks after their tick`);
        if (loss <= 0.03) {
          expect(late).toBeLessThanOrEqual(Math.ceil(total * 0.02));
          expect(worst).toBeLessThanOrEqual(D3_ON_TIME_TICKS);
          expect(Math.min(...onTime)).toBeGreaterThanOrEqual(0);
        }
      });
    }
  }
});

describe("D4 bytes per second per player stay under the budget", () => {
  for (const mode of MODES) {
    it(mode, async () => {
      const s = await scene(mode);
      drive(s);
      // a busy second: a jump every 400 ms, a shot every 700 ms
      let n = 0;
      s.al.on("tick", () => {
        n++;
        if (n % 12 === 0) s.al.action("jump");
        if (n % 21 === 0) s.al.action("shoot", { yaw: 10, pitch: 0 });
      });
      await s.rig.run(8);
      let toClient = 0;
      let toHost = 0;
      let k = 0;
      for (let i = 0; i < 300; i++) {
        await s.rig.step();
        if (i % 6 === 0) {
          toClient += s.hl.bytesPerSecond(PEER(s)).sent;
          toHost += s.al.bytesPerSecond(s.al.session.hostPeerId).sent;
          k++;
        }
      }
      toClient /= k;
      toHost /= k;
      console.log(`D4 ${mode}: host to client A ${toClient.toFixed(0)} B/s, client A to host ${toHost.toFixed(0)} B/s (3 players, state ${s.al.codec.stateBytes} B, input ${s.al.codec.inputBytes} B, jump every 400 ms and shot every 700 ms)`);
      expect(toClient).toBeLessThan(D4_BUDGET.hostToClient);
      expect(toHost).toBeLessThan(D4_BUDGET.clientToHost);
      expect(toClient).toBeGreaterThan(100);
    });
  }
});

describe("D5 host mode: prediction", () => {
  it("the owner's predicted state ends equal to the host's, a small correction is blended and a large one snaps", async () => {
    let glitch = 0;
    const hostStep: typeof walkStep = (st, i, dt) => {
      const r = walkStep(st, i, dt);
      if (glitch && i.yaw === 90) {
        r.x += glitch;
        glitch = 0;
      }
      return r;
    };
    const rig = new PlayerRig({ latencyMs: 50, lossRate: 0.1, jitterMs: 10, layer: (name) => ({ authority: "host", step: name === "host" ? hostStep : walkStep }) });
    const { layer: hl } = await rig.hostPlayers();
    const { p: a, layer: al } = await rig.joinPlayers("a");
    let moving = true;
    let maxErr = 0;
    al.on("tick", () => {
      const t = rig.nowMs / 1000;
      al.setLocalInput(moving ? { moveX: Math.sin(0.8 * t), moveY: Math.cos(0.8 * t), yaw: 90 } : { moveX: 0, moveY: 0, yaw: 90 });
    });
    await rig.run(3);
    for (let i = 0; i < 400; i++) {
      await rig.step();
      const host = hl.latest(a.peerId);
      if (host && i > 100) maxErr = Math.max(maxErr, Math.hypot(al.local!.x - host.x, al.local!.z - host.z));
    }
    moving = false;
    await rig.run(1.5);
    const host = hl.latest(a.peerId)!;
    const err = Math.hypot(al.local!.x - host.x, al.local!.y - host.y, al.local!.z - host.z);
    console.log(`D5: max |predicted - host| while moving ${maxErr.toFixed(2)} m (the host is behind by the round trip); at rest ${err.toFixed(4)} m`);
    expect(err).toBeLessThan(0.05);

    // a small disagreement of the host: blended over 100 ms, no snap
    moving = true;
    await rig.run(1);
    const before = al.smoother.snapCount;
    glitch = 0.5;
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      await rig.step();
      peak = Math.max(peak, al.smoother.offsetRemaining);
    }
    await rig.run(0.3);
    console.log(`D5: a 0.5 m disagreement of the host: offset peaked at ${peak.toFixed(2)} m, ${al.smoother.offsetRemaining.toFixed(3)} m left after 0.3 s, snaps ${al.smoother.snapCount - before}`);
    expect(peak).toBeGreaterThan(0.3);
    expect(al.smoother.snapCount).toBe(before);
    expect(al.smoother.offsetRemaining).toBeLessThan(0.05);

    // a large one snaps
    await rig.run(0.5);
    const before2 = al.smoother.snapCount;
    glitch = 6;
    await rig.run(1);
    console.log(`D5: a 6 m disagreement of the host: snaps ${al.smoother.snapCount - before2}`);
    expect(al.smoother.snapCount).toBe(before2 + 1);
  });
});

function steps(positions: Sample[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < positions.length; i++) out.push(dist(positions[i], positions[i - 1]));
  return out;
}

describe("D6 a teleport and a respawn snap on the other screens", () => {
  for (const mode of MODES) {
    it(mode, async () => {
      const s = await scene(mode);
      // A's game keeps walking its path from wherever it was put: the path plus a shift that a teleport changes
      const shift = { x: 0, z: 0 };
      if (mode === "owner") {
        s.al.on("tick", () => {
          const { teleport: _t, ...p } = pathAt(s.rig.nowMs);
          s.al.setLocalState({ ...p, x: p.x + shift.x, z: p.z + shift.z });
        });
      } else drive(s);
      await s.rig.run(4);
      const seenRespawn: number[] = [];
      s.bl.onAction("respawn", (e) => seenRespawn.push(e.player));
      for (const kind of ["teleport", "respawn"] as const) {
        const watched: Sample[] = [];
        const to = kind === "teleport" ? { x: 60, z: 60 } : { x: -70, z: -70 };
        for (let i = 0; i < 120; i++) {
          if (i === 30) {
            if (mode === "owner") {
              const p = pathAt(s.rig.nowMs);
              shift.x = to.x - p.x;
              shift.z = to.z - p.z;
              if (kind === "teleport") s.al.teleport(to);
              else s.al.respawn(to);
            } else if (kind === "teleport") s.hl.teleportPlayer(PEER(s), to);
            else s.hl.respawnPlayer(PEER(s), to);
          }
          await s.rig.step();
          const v = s.bl.get(PEER(s))!;
          watched.push({ t: s.rig.nowMs, x: v.x, y: v.y, z: v.z });
        }
        const d = steps(watched);
        const big = d.filter((x) => x > 40).length;
        const slide = d.filter((x) => x > 1 && x < 40).length;
        console.log(`D6 ${mode} ${kind}: ${big} frame(s) jumped over 40 m, ${slide} frame(s) slid between 1 and 40 m; largest ordinary step ${Math.max(...d.filter((x) => x <= 1)).toFixed(2)} m`);
        expect(big).toBe(1);
        expect(slide).toBe(0);
        if (mode === "host") await s.rig.run(1);
      }
      expect(seenRespawn).toEqual([PEER(s)]);
    });
  }
});

describe("host authority: the owner starts where the host spawned it", () => {
  it("the owner never reads a local position near the origin, the first local state is the spawn point, nothing snaps", async () => {
    const SPAWN_X = 50;
    const rig = new PlayerRig({ layer: { authority: "host", step: walkStep, spawn: () => ({ x: SPAWN_X, y: 1 }) } });
    const { layer: hl } = await rig.hostPlayers();
    const { layer: al } = await rig.joinPlayers("a");
    const corrected: unknown[] = [];
    al.on("corrected", (s) => corrected.push(s));
    // the owner holds "walk right" from its very first tick, including the ticks before the host's first state arrives
    al.on("tick", () => al.setLocalInput({ moveX: 1, moveY: 0, yaw: 90 }));
    let firstX: number | undefined;
    let minX = Infinity;
    let frames = 0;
    let withoutState = 0;
    let inputsBeforeState = -1;
    for (let i = 0; i < 300; i++) {
      await rig.step();
      const l = al.local;
      if (!l) {
        withoutState++;
        inputsBeforeState = al.session.stats.inputsSent;
        continue;
      }
      frames++;
      firstX ??= l.x;
      minX = Math.min(minX, l.x);
    }
    console.log(`host authority spawn x=${SPAWN_X}: ${withoutState} frames without a local state, first local x ${firstX?.toFixed(3)}, lowest local x ${minX.toFixed(3)}, snaps ${al.smoother.snapCount}, corrections ${al.stats.corrections}, corrected events ${corrected.length}, inputs sent before the first state ${inputsBeforeState}`);
    expect(frames).toBeGreaterThan(200);
    expect(minX).toBeGreaterThan(SPAWN_X - 1);
    expect(Math.abs(firstX! - SPAWN_X)).toBeLessThan(6 / 30 + 0.01); // within one tick's travel (6 m/s at 30 Hz) and a position step (1 cm)
    expect(al.smoother.snapCount).toBe(0);
    expect(al.stats.corrections).toBe(0);
    expect(corrected.length).toBe(0);
    expect(withoutState).toBeGreaterThan(0);
    expect(inputsBeforeState).toBe(0);
    expect(hl.latest(al.localPeerId)!.x).toBeGreaterThan(SPAWN_X);
  });
});
