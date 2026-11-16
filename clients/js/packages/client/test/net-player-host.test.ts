import { describe, expect, it } from "vitest";
import { PlayerRig, pathAt } from "./player-rig.js";
import { drive, scene, walkStep } from "./net-player-scenario.js";

describe("D7 the host's limits", () => {
  it("an owner that claims a move over the top speed is put back", async () => {
    const s = await scene("owner", { layer: { authority: "owner", limits: { maxSpeed: 12 } } });
    let cheat = 0;
    s.al.on("tick", () => {
      const { teleport: _t, ...p } = pathAt(s.rig.nowMs);
      s.al.setLocalState({ ...p, x: p.x + cheat });
      cheat = 0;
    });
    const corrected: number[] = [];
    s.al.on("corrected", () => corrected.push(s.rig.nowMs));
    await s.rig.run(6);
    expect(s.hl.stats.limitViolations, "an honest path at 9.6 m/s under a 12 m/s limit").toBe(0);
    cheat = 30; // one update claims a move of 30 m in one tick
    let worstHost = 0;
    let worstWatched = 0;
    for (let i = 0; i < 120; i++) {
      await s.rig.step();
      const now = pathAt(s.rig.nowMs);
      const h = s.hl.latest(s.a.peerId)!;
      worstHost = Math.max(worstHost, Math.hypot(h.x - now.x, h.z - now.z));
      const seen = s.bl.get(s.a.peerId)!;
      worstWatched = Math.max(worstWatched, Math.hypot(seen.x - pathAt(s.rig.nowMs - 400).x, seen.z - pathAt(s.rig.nowMs - 400).z));
    }
    console.log(`D7 speed: violations ${s.hl.stats.limitViolations}, owner told ${corrected.length}x, worst host distance from the true path ${worstHost.toFixed(2)} m, worst distance the watcher saw ${worstWatched.toFixed(2)} m`);
    expect(s.hl.stats.limitViolations).toBeGreaterThanOrEqual(1);
    expect(corrected.length).toBeGreaterThanOrEqual(1);
    expect(worstHost).toBeLessThan(10); // never at the claimed +30 m
    expect(worstWatched).toBeLessThan(10);
    // and it goes on: the owner is accepted again after it took the host's state
    const before = s.hl.stats.limitViolations;
    await s.rig.run(3);
    expect(s.hl.stats.limitViolations).toBe(before);
    const h = s.hl.latest(s.a.peerId)!;
    const now = pathAt(s.rig.nowMs);
    expect(Math.hypot(h.x - now.x, h.z - now.z)).toBeLessThan(3);
  });

  it("a teleport the owner raises passes, a second one within a second does not", async () => {
    const s = await scene("owner", { layer: { authority: "owner", limits: { maxSpeed: 12, maxStep: 3 } } });
    const shift = { x: 0, z: 0 };
    s.al.on("tick", () => {
      const { teleport: _t, ...p } = pathAt(s.rig.nowMs);
      s.al.setLocalState({ ...p, x: p.x + shift.x, z: p.z + shift.z });
    });
    // a game that is put back takes the host's state as its own
    s.al.on("corrected", (st) => {
      const p = pathAt(s.rig.nowMs);
      shift.x = st.x - p.x;
      shift.z = st.z - p.z;
    });
    await s.rig.run(3);
    const jump = (to: { x: number; z: number }) => {
      const p = pathAt(s.rig.nowMs);
      shift.x = to.x - p.x;
      shift.z = to.z - p.z;
      s.al.teleport(to);
    };
    jump({ x: 80, z: 80 });
    await s.rig.run(1.5);
    expect(s.hl.stats.limitViolations).toBe(0);
    expect(Math.hypot(s.hl.latest(s.a.peerId)!.x - 80, s.hl.latest(s.a.peerId)!.z - 80)).toBeLessThan(14); // the path is a 12 m circle around the new centre
    jump({ x: -80, z: -80 });
    await s.rig.run(0.3);
    jump({ x: 80, z: -80 }); // a second teleport inside the second
    await s.rig.run(2);
    console.log(`D7 teleport: violations ${s.hl.stats.limitViolations}`);
    expect(s.hl.stats.limitViolations).toBe(1);
  });

  it("shots over the rate limit are dropped and counted, and the other client never sees them", async () => {
    const s = await scene("owner", { layer: { authority: "owner", limits: { minShotIntervalMs: 250 } } });
    drive(s);
    const atHost: number[] = [];
    const atB: number[] = [];
    s.hl.onAction("shoot", (e) => e.player === s.a.peerId && atHost.push(e.seq));
    s.bl.onAction("shoot", (e) => e.player === s.a.peerId && atB.push(e.seq));
    await s.rig.run(3);
    // honest: one shot every 300 ms
    for (let i = 0; i < 10; i++) {
      s.al.action("shoot", { yaw: 5 });
      await s.rig.run(0.3);
    }
    await s.rig.run(1);
    expect(s.hl.stats.actionsRateLimited, "an honest 300 ms cadence").toBe(0);
    expect(atHost.length).toBe(10);
    // fast: one shot every 100 ms for 3 s
    for (let i = 0; i < 30; i++) {
      s.al.action("shoot", { yaw: 5 });
      await s.rig.run(0.1);
    }
    await s.rig.run(2);
    console.log(`D7 shots: 40 sent, ${atHost.length} accepted at the host, ${s.hl.stats.actionsRateLimited} dropped and counted, ${atB.length} seen by the other client`);
    expect(s.hl.stats.actionsRateLimited).toBeGreaterThan(10);
    expect(atHost.length + s.hl.stats.actionsRateLimited).toBe(40);
    expect(atB.length).toBe(atHost.length);
  });
});

describe("D8 hits are judged on the host with rewind", () => {
  for (const mode of ["owner", "host"] as const) {
    it(`${mode}: the host finds the target where the shooter saw it`, async () => {
      // 60 ms one way like the C# twin: the default rewind of 250 ms covers a shooter's view age plus its shot's flight only up to about that
      const s = await scene(mode, { latencyMs: 60 });
      drive(s); // A is the target, strafing
      await s.rig.run(4);
      // B shoots at what it renders this frame
      let seen: { x: number; z: number } | null = null;
      const errors: number[] = [];
      const plain: number[] = [];
      s.hl.onAction("shoot", (e) => {
        if (e.player !== s.b.peerId || !seen) return;
        const then = s.hl.rewound(s.a.peerId, e.args.view)!;
        const now = s.hl.latest(s.a.peerId)!;
        errors.push(Math.hypot(then.x - seen.x, then.z - seen.z));
        plain.push(Math.hypot(now.x - seen.x, now.z - seen.z));
        seen = null;
      });
      for (let i = 0; i < 30; i++) {
        await s.rig.run(0.7);
        const v = s.bl.get(s.a.peerId)!;
        seen = { x: v.x, z: v.z };
        s.bl.action("shoot", { yaw: 0, pitch: 0 }); // `view` is the tick B is rendering
        await s.rig.run(0.5);
      }
      const worst = Math.max(...errors);
      console.log(`D8 ${mode}: ${errors.length} shots, error with rewind at most ${worst.toFixed(3)} m, without rewind ${Math.min(...plain).toFixed(2)} to ${Math.max(...plain).toFixed(2)} m`);
      expect(errors.length).toBe(30);
      expect(worst).toBeLessThan(0.1);
      expect(Math.max(...plain)).toBeGreaterThan(1);
    });
  }

  it("a rewind is clamped to the session's maxRewindMs", async () => {
    const rig = new PlayerRig({ session: { maxRewindMs: 200 }, layer: { authority: "owner" } });
    const { layer } = await rig.hostPlayers();
    await rig.run(1);
    const now = layer.session.clock.tick;
    expect(layer.rewindTick(0)).toBeCloseTo(now - 6, 6);
    expect(layer.rewindTick((now - 2.5) * 256)).toBeCloseTo(now - 2.5, 6);
    expect(layer.rewindTick((now + 50) * 256)).toBeCloseTo(now, 6);
  });
});

describe("D9 players come and go by themselves", () => {
  it("a late joiner sees every player, a leaver's player disappears, a spectator has none", async () => {
    const rig = new PlayerRig({ room: true, layer: { authority: "owner" } });
    const { layer: hl, p: host } = await rig.hostPlayers();
    const { layer: al, p: a } = await rig.joinPlayers("a");
    const { layer: bl, p: b } = await rig.joinPlayers("b");
    for (const [l, phase] of [[hl, 0], [al, 1], [bl, 2]] as const) {
      l.on("tick", () => {
        const { teleport: _t, ...p } = pathAt(rig.nowMs, phase);
        l.setLocalState(p);
      });
    }
    const joined: number[] = [];
    const left: number[] = [];
    hl.on("playerJoined", (p) => joined.push(p));
    hl.on("playerLeft", (p) => left.push(p));
    await rig.run(4);
    const all = [host.peerId, a.peerId, b.peerId].sort();
    expect([...hl.players].sort()).toEqual(all);
    expect([...al.players].sort()).toEqual(all);
    expect([...bl.players].sort()).toEqual(all);

    // a late joiner
    const { layer: cl, p: c } = await rig.joinPlayers("c");
    cl.on("tick", () => {
      const { teleport: _t, ...p } = pathAt(rig.nowMs, 3);
      cl.setLocalState(p);
    });
    await rig.run(4);
    const withC = [host.peerId, a.peerId, b.peerId, c.peerId].sort();
    expect([...cl.players].sort(), "the late joiner sees everyone").toEqual(withC);
    expect([...al.players].sort(), "and everyone sees the late joiner").toEqual(withC);
    expect(cl.get(a.peerId)).toBeDefined();

    // a spectator has no player, and sees the others
    const { layer: dl, p: d } = await rig.joinPlayers("d", "spectator");
    dl.on("tick", () => dl.setLocalState(pathAt(rig.nowMs, 4)));
    await rig.run(4);
    expect(hl.players).not.toContain(d.peerId);
    expect(al.players).not.toContain(d.peerId);
    expect([...dl.players].sort()).toEqual(withC);

    // a leaver's player disappears
    await b.lobby.leave();
    rig.frozen.add("b");
    await rig.run(5);
    expect(hl.players).not.toContain(b.peerId);
    expect(al.players).not.toContain(b.peerId);
    expect(cl.players).not.toContain(b.peerId);
    expect(left).toContain(b.peerId);
    expect(hl.get(b.peerId)).toBeUndefined();
    console.log(`D9: host saw joined ${joined.length}, left ${left.length}; late joiner saw ${cl.players.length} players; spectator saw ${dl.players.length}; host has ${hl.players.length} after the leaver`);
  });
});

describe("a player layer on a host that has no clients", () => {
  it("steps the host's own player in host mode", async () => {
    const rig = new PlayerRig({ layer: { authority: "host", step: walkStep } });
    const { layer } = await rig.hostPlayers();
    layer.on("tick", () => layer.setLocalInput({ moveX: 1, moveY: 0, yaw: 0 }));
    await rig.run(1);
    expect(layer.get(layer.localPeerId)!.x).toBeGreaterThan(3);
  });
});

describe("the host draws the other players (get(peer) on the host, one tick behind and interpolated)", () => {
  // a player at 9.63 m/s (the fastest the path goes) travels this far in one 30 Hz tick
  const TICK_TRAVEL_M = 9.63 / 30;
  for (const mode of ["owner", "host"] as const) {
    it(`${mode}: two remote players move smoothly between host ticks, a teleport snaps, the host's own player is unchanged`, async () => {
      const s = await scene(mode, { lossRate: 0, jitterMs: 0 });
      // A walks the path, B walks it from another phase
      drive(s);
      if (mode === "owner") {
        s.bl.on("tick", () => {
          const { teleport: _t, ...p } = pathAt(s.rig.nowMs, 2);
          s.bl.setLocalState(p);
        });
        s.hl.on("tick", () => {
          const { teleport: _t, ...p } = pathAt(s.rig.nowMs, 4);
          s.hl.setLocalState(p);
        });
      } else {
        s.bl.on("tick", () => {
          const t = s.rig.nowMs / 1000;
          s.bl.setLocalInput({ moveX: Math.sin(0.8 * t + 2), moveY: Math.cos(0.8 * t + 2), yaw: 90 });
        });
      }
      await s.rig.run(3);
      const last = new Map<number, { x: number; y: number; z: number }>();
      let frames = 0;
      let repeats = 0;
      let biggest = 0;
      let missing = 0;
      for (let i = 0; i < 300; i++) {
        await s.rig.step();
        for (const peer of [s.a.peerId, s.b.peerId]) {
          const v = s.hl.get(peer);
          if (!v) {
            missing++;
            continue;
          }
          const prev = last.get(peer);
          if (prev) {
            const d = Math.hypot(v.x - prev.x, v.y - prev.y, v.z - prev.z);
            frames++;
            if (d === 0) repeats++;
            biggest = Math.max(biggest, d);
          }
          last.set(peer, { x: v.x, y: v.y, z: v.z });
        }
        // the host's own player is its own record, as before
        expect(s.hl.get(s.hl.localPeerId)).toBe(s.hl.local);
      }
      console.log(`host draws others (${mode}): ${frames} frames of 2 players, ${repeats} repeated a position, largest step ${biggest.toFixed(3)} m (one tick of travel at most ${TICK_TRAVEL_M.toFixed(3)} m)`);
      expect(missing).toBe(0);
      expect(repeats).toBe(0);
      expect(biggest).toBeLessThan(TICK_TRAVEL_M);

      // a teleport of A snaps (once, no slide), B keeps moving
      const seen: { x: number; y: number; z: number }[] = [];
      for (let i = 0; i < 120; i++) {
        if (i === 30) s.hl.teleportPlayer(s.a.peerId, { x: 60, z: 60 });
        await s.rig.step();
        const v = s.hl.get(s.a.peerId)!;
        seen.push({ x: v.x, y: v.y, z: v.z });
        if (mode === "owner" && i === 40) break; // the owner of A is told to take the host's state; the snap is what is tested here
      }
      const d: number[] = [];
      for (let i = 1; i < seen.length; i++) d.push(Math.hypot(seen[i].x - seen[i - 1].x, seen[i].y - seen[i - 1].y, seen[i].z - seen[i - 1].z));
      const big = d.filter((x) => x > 40).length;
      const slide = d.filter((x) => x > 1 && x < 40).length;
      console.log(`host draws others (${mode}) teleport: ${big} frame(s) jumped over 40 m, ${slide} frame(s) slid between 1 and 40 m`);
      expect(big).toBe(1);
      expect(slide).toBe(0);
    });
  }

  it("a player with a single record is held where it is, and a player that is not in the world is undefined", async () => {
    const rig = new PlayerRig({ lossRate: 0, jitterMs: 0, layer: { authority: "host", step: walkStep, spawn: (peer) => ({ x: 50 + peer }) } });
    const { layer: hl } = await rig.hostPlayers();
    const { p: a } = await rig.joinPlayers("a");
    expect(hl.get(a.peerId)).toBeUndefined();
    for (let i = 0; i < 400 && !hl.get(a.peerId); i++) await rig.step(); // stop at the first frame the player exists: at most one record
    const v = hl.get(a.peerId)!;
    expect(v.x).toBeCloseTo(50 + a.peerId, 1);
    expect(hl.get(a.peerId + 100)).toBeUndefined();
  });
});
