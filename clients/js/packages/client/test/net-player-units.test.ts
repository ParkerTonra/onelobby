import { describe, expect, it } from "vitest";
import { PLAYER_OMITTABLE } from "../src/blueprint.js";
import { HistoryRing, NetMath, parseBlueprint, NetPlayers, PLAYER_TYPE_ID, PlayerCodec, PredictionSmoother, Reconciler, ReplicationSession, defaultPlayerState } from "../src/index.js";
import { KIND_PLAYER_EVENTS, OMITTABLE, encodePlayerEvents } from "../src/internals.js";
import { PlayerRig, pathAt } from "./player-rig.js";
import { RepRig } from "./replication-rig.js";
import { drive, scene } from "./net-player-scenario.js";

describe("PredictionSmoother (twin of the C# SmoothingTests)", () => {
  it("a small correction glides to zero linearly", () => {
    const s = new PredictionSmoother();
    expect(s.correct(1, 0.2, 0)).toBe(false);
    expect([s.offset.x, s.offset.y, Math.abs(s.offset.z)]).toEqual([-1, -0.2, 0]);
    s.update(50);
    expect(s.offset.x).toBeCloseTo(-0.5, 4);
    expect(s.offset.y).toBeCloseTo(-0.1, 4);
    s.update(60);
    expect(s.offsetRemaining).toBe(0);
    expect(s.snapCount).toBe(0);
  });
  it("a correction mid-decay adds to what is left", () => {
    const s = new PredictionSmoother();
    s.correct(1, 0, 0);
    s.update(50);
    s.correct(0, 0, 1);
    expect(s.offset.x).toBeCloseTo(-0.5, 4);
    expect(s.offset.z).toBeCloseTo(-1, 4);
    s.update(100);
    expect(s.offsetRemaining).toBe(0);
  });
  it("large corrections snap", () => {
    const s = new PredictionSmoother();
    expect(s.correct(1.5, 0, 1.5)).toBe(true);
    expect(s.offsetRemaining).toBe(0);
    expect(s.correct(0, 0.6, 0)).toBe(true);
    expect(s.snapCount).toBe(2);
    expect(s.correct(0, 0.4, 1.9)).toBe(false);
  });
  it("a changed sequence snaps whatever the distance", () => {
    const s = new PredictionSmoother();
    expect(s.correct(0.1, 0, 0, 3)).toBe(false);
    expect(s.correct(0.1, 0, 0, 3)).toBe(false);
    expect(s.correct(0.1, 0, 0, 4)).toBe(true);
    expect(s.offsetRemaining).toBe(0);
    expect(s.snapCount).toBe(1);
  });
  it("lerpOrSnap (already in NetMath) jumps past the distance", () => {
    expect(NetMath.lerpOrSnap(0, 2, 0.5, 2.5)).toBe(1);
    expect(NetMath.lerpOrSnap(0, 10, 0.5, 2)).toBe(10);
  });
});

describe("Reconciler (twin of the C# one)", () => {
  it("replays the inputs the host has not seen", () => {
    const r = new Reconciler<number, number>(0, (x, d) => x + d);
    r.equal = (a, b) => Math.abs(a - b) < 1e-9;
    for (let seq = 1; seq <= 5; seq++) r.predict(seq, 1);
    expect(r.current).toBe(5);
    expect(r.reconcile(2, 2)).toBe(5); // the host was at 2 after input 2: replay 3, 4, 5
    expect(r.corrections).toBe(0);
    expect(r.pendingCount).toBe(3);
    expect(r.reconcile(10, 5)).toBe(10); // the host disagrees
    expect(r.corrections).toBe(1);
    expect(r.pendingCount).toBe(0);
  });
});

describe("HistoryRing (twin of the C# one)", () => {
  it("interpolates between ticks and answers only what it holds", () => {
    const h = new HistoryRing<number>(30, (a, b, t) => NetMath.lerp(a, b, t));
    for (let t = 1; t <= 40; t++) h.record(t, 7, t * 2);
    expect(h.trySample(7, 20.5)).toBeCloseTo(41, 6);
    expect(h.trySample(7, 20)).toBe(40);
    expect(h.trySample(7, 5)).toBeUndefined(); // older than the ring holds
    expect(h.trySample(8, 20)).toBeUndefined();
    h.forget(7);
    expect(h.trySample(7, 20)).toBeUndefined();
    expect(() => new HistoryRing<number>(1, (a) => a)).toThrow();
  });
});

describe("the adaptive render delay is a session option", () => {
  it("a bare session keeps the fixed 100 ms and the same bytes", async () => {
    const rig = new RepRig(undefined, { latencyMs: 100, jitterMs: 40, lossRate: 0.03 });
    const host = await rig.startHost();
    const a = await rig.join("a");
    host.session.spawn(1, 0, () => undefined);
    await rig.run(5);
    expect(a.session.config.adaptiveDelay).toBe(false);
    expect(a.session.interpolationDelayMs).toBe(100);
    expect(a.session.jitterMs).toBeGreaterThan(5); // measured either way
  });
  it("grows with jitter and shrinks when the link is calm, inside its bounds", async () => {
    const calm = await scene("owner", { jitterMs: 0, lossRate: 0 });
    drive(calm);
    await calm.rig.run(15);
    const rough = await scene("owner", { jitterMs: 80, lossRate: 0.03 });
    drive(rough);
    await rough.rig.run(15);
    const c = calm.bl.session.interpolationDelayMs;
    const r = rough.bl.session.interpolationDelayMs;
    console.log(`adaptive delay: calm link ${c.toFixed(1)} ms, 80 ms jitter ${r.toFixed(1)} ms (bounds 66.7 to 250)`);
    expect(c).toBeGreaterThanOrEqual(2 * (1000 / 30) - 1e-9);
    expect(c).toBeLessThan(110); // a calm link settles near the lower bound plus what a 16 ms frame adds
    expect(r).toBeGreaterThan(c + 40);
    expect(r).toBeLessThanOrEqual(250);
  });
});

describe("the layer changes nothing for a game that does not use it", () => {
  it("a session with no layer sees no player entity and no kind 5 message", async () => {
    const rig = new RepRig();
    const host = await rig.startHost();
    const a = await rig.join("a");
    host.session.spawn(5, 0, () => undefined);
    await rig.run(2);
    expect(a.session.entities.filter((e) => e.typeId === PLAYER_TYPE_ID)).toHaveLength(0);
  });
  it("an old session ignores a kind 5 message (additive kind)", async () => {
    const rig = new RepRig();
    const host = await rig.startHost();
    const a = await rig.join("a");
    const bytes = encodePlayerEvents([{ player: a.peerId, seq: 1, id: 1, tick: 1, args: new Uint8Array(0) }]);
    expect(bytes[2]).toBe(KIND_PLAYER_EVENTS);
    a.lobby.send(host.peerId, bytes, { channel: "fast" });
    await rig.run(0.5);
    expect(host.session.stats.malformed).toBe(0);
  });
});

describe("what the host does with events it must not accept", () => {
  it("drops host-only events, other players' events and left-out events, and counts them", async () => {
    const s = await scene("owner", { layer: { authority: "owner", omit: ["emote"] } });
    drive(s);
    await s.rig.run(3);
    const seen: string[] = [];
    s.hl.on("action", (e) => seen.push(e.name));
    const send = (player: number, id: number, seq: number, args = new Uint8Array(0)) =>
      s.a.lobby.send(s.host.peerId, encodePlayerEvents([{ player, seq, id, tick: 1, args }]), { channel: "reliable" });
    send(s.a.peerId, 9, 100, new Uint8Array(3)); // "hit": the host raises that one
    send(s.b.peerId, 1, 101); // "jump" of someone else
    send(s.a.peerId, 12, 102, new Uint8Array(1)); // "emote" is left out of this game
    send(s.a.peerId, 1, 103, new Uint8Array(1)); // a jump with arguments it does not have
    await s.rig.run(1);
    expect(seen).toEqual([]);
    expect(s.hl.stats.actionsRejected).toBe(4);
    expect(() => s.al.action("emote", { emote: 1 })).toThrow(/left out/);
    expect(() => s.al.action("hit")).toThrow(/host/);
  });
  it("a malformed kind 5 message is counted, never thrown", async () => {
    const s = await scene("owner");
    s.a.lobby.send(s.host.peerId, new Uint8Array([0x52, 1, 5, 0]), { channel: "reliable" });
    await s.rig.run(0.5);
    expect(s.host.session.stats.malformed).toBe(1);
  });
});

describe("2D players", () => {
  it("a 2D player travels and is watched; 12 bytes of state", async () => {
    const rig = new PlayerRig({ layer: { authority: "owner", space: "2d", range: 100, velocityRange: 16 } });
    const { layer: hl } = await rig.hostPlayers();
    const { p: a, layer: al } = await rig.joinPlayers("a");
    const { layer: bl } = await rig.joinPlayers("b");
    al.on("tick", () => {
      const p = pathAt(rig.nowMs);
      al.setLocalState({ x: p.x, y: p.z, vx: p.vx, vy: p.vz, yaw: p.yaw });
    });
    await rig.run(5);
    expect(al.codec.stateBytes).toBe(12);
    const v = bl.get(a.peerId)!;
    const truth = pathAt(rig.nowMs - 400);
    expect(Math.hypot(v.x - truth.x, v.y - truth.z)).toBeLessThan(1.5);
    expect(hl.latest(a.peerId)!.z).toBe(0);
  });
  it("leaving fields out shortens the state", () => {
    const full = new PlayerCodec({ space: "3d" });
    const lean = new PlayerCodec({ space: "3d", omit: ["velocity", "pitch", "aiming", "blocking", "team"] });
    expect(full.stateBytes).toBe(16);
    expect(lean.stateBytes).toBeLessThan(full.stateBytes);
    expect(lean.decodeState(lean.encodeState(defaultPlayerState({ x: 3, vx: 9 })))!.vx).toBe(0);
    expect(() => new PlayerCodec({ omit: ["x"] })).toThrow();
    expect(() => new PlayerCodec({ omit: ["teleport"] })).toThrow();
  });
});

describe("the layer can be built from a session or a lobby", () => {
  it("a lobby gets a session with the adaptive delay on", async () => {
    const rig = new RepRig();
    const host = await rig.startHost();
    const layer = new NetPlayers(host.lobby);
    expect(layer.session).toBeInstanceOf(ReplicationSession);
    expect(layer.session.config.adaptiveDelay).toBe(true);
  });
});

describe("the blueprint section", () => {
  it("fromBlueprint reads sync.player and the tick rate; the omit list is the preset's", async () => {
    const bp = parseBlueprint({
      game: { id: "a" },
      sync: { mode: "replication", tickRate: 60, player: { authority: "host", space: "2d", range: 100, limits: { maxSpeed: 8 }, omit: ["emote"] } },
    });
    const rig = new RepRig();
    const host = await rig.startHost();
    const layer = NetPlayers.fromBlueprint(host.lobby, bp);
    expect(layer.authority).toBe("host");
    expect(layer.codec.config).toMatchObject({ space: "2d", range: 100, velocityRange: 32, omit: ["emote"] });
    expect(layer.limits).toEqual({ maxSpeed: 8 });
    expect(layer.session.config.tickRate).toBe(60);
    expect([...PLAYER_OMITTABLE]).toEqual([...OMITTABLE]);
  });
});

describe("the carried bit (the last bit of the state)", () => {
  it("round-trips in 3D and 2D, defaults to false, cannot be left out", () => {
    for (const space of ["3d", "2d"] as const) {
      const c = new PlayerCodec({ space });
      expect(defaultPlayerState().carried).toBe(false);
      expect(c.decodeState(c.encodeState(defaultPlayerState()))!.carried).toBe(false);
      const on = c.decodeState(c.encodeState(defaultPlayerState({ x: 1, vx: 2, teleport: 5, carried: true })))!;
      expect(on.carried).toBe(true);
      expect(on.teleport).toBe(5);
      expect(c.decodeState(c.encodeState(on))!.carried).toBe(true);
    }
    expect(() => new PlayerCodec({ omit: ["carried"] })).toThrow();
  });
  it("a blend takes the older sample's flag", () => {
    const c = new PlayerCodec({ space: "3d" });
    const a = defaultPlayerState({ x: 0, carried: true });
    const b = defaultPlayerState({ x: 2, carried: false });
    expect(c.lerp(a, b, 0.5).carried).toBe(true);
    expect(c.lerp(b, a, 0.5).carried).toBe(false);
  });
  it("128 bits (16 bytes) in 3D, 92 bits (12 bytes) in 2D, 73 bits (10 bytes) for the lean layout", () => {
    const d3 = new PlayerCodec({ space: "3d" });
    const d2 = new PlayerCodec({ space: "2d" });
    const lean = new PlayerCodec({ space: "3d", omit: ["velocity", "pitch", "blocking", "aiming", "team", "health", "alive", "emote", "use"] });
    expect([d3.stateBits, d3.stateBytes]).toEqual([128, 16]);
    expect([d2.stateBits, d2.stateBytes]).toEqual([92, 12]);
    expect([lean.stateBits, lean.stateBytes]).toEqual([73, 10]);
  });
});
