import { describe, expect, it } from "vitest";
import { NetMath, ReplicationSession } from "../src/index.js";
import { fromHex } from "../src/internals.js";
import { alienEntity, alienSchema, newAlien, rng, RepRig, type AlienState, type RepPlayer } from "./replication-rig.js";
import { specJson } from "./spec.js";

const ALIEN = 7;
const PLAYER = 1;

function expectWorldsMatchHost(host: RepPlayer, client: RepPlayer): void {
  let n = 0;
  for (const w of client.session.clientWorlds()) {
    const hw = host.session.hostWorld(w.tick);
    if (!hw) continue; // older than the host's history
    expect(w.ents.map((e) => e.id)).toEqual(hw.ents.map((e) => e.id));
    for (let i = 0; i < w.ents.length; i++) {
      expect(w.ents[i].type).toBe(hw.ents[i].type);
      expect(w.ents[i].owner).toBe(hw.ents[i].owner);
      expect(Array.from(w.ents[i].state)).toEqual(Array.from(hw.ents[i].state));
    }
    n++;
  }
  expect(n, "compared ticks").toBeGreaterThan(10);
}

describe("replication session (host and client over a raw lobby)", () => {
  it("spawn and despawn reach the client with type and owner", async () => {
    const rig = new RepRig();
    const host = await rig.startHost();
    const a = await rig.join("a");
    const alienId = host.session.spawn(ALIEN, 0, alienEntity(newAlien({ x: 10, z: -4 })));
    const avatarId = host.session.spawn(PLAYER, a.peerId, alienEntity(newAlien({ x: 1 })));
    expect(await rig.until(() => a.spawned.length === 2)).toBe(true);
    expect(a.spawned).toContainEqual({ id: alienId, typeId: ALIEN, owner: 0 });
    expect(a.spawned).toContainEqual({ id: avatarId, typeId: PLAYER, owner: a.peerId });
    expect(a.session.isMine(a.session.entities.find((e) => e.id === avatarId)!)).toBe(true);
    const s = a.session.trySample(alienId, alienSchema)!;
    expect(s.x).toBeCloseTo(10, 2);
    expect(s.z).toBeCloseTo(-4, 2);

    host.session.despawn(alienId);
    expect(await rig.until(() => a.despawned.length === 1)).toBe(true);
    expect(a.despawned[0].id).toBe(alienId);
    expect(a.session.trySample(alienId, alienSchema)).toBeUndefined();
    expect(a.session.entities).toHaveLength(1);
  });

  it("despawn shows at render time, not on receipt", async () => {
    const rig = new RepRig(undefined, { latencyMs: 20 });
    const host = await rig.startHost();
    const a = await rig.join("a");
    const id = host.session.spawn(ALIEN, 0, alienEntity(newAlien()));
    expect(await rig.until(() => a.spawned.length === 1)).toBe(true);
    await rig.run(0.5);
    host.session.despawn(id);
    const despawnTick = host.session.clock.tick + 1;
    expect(await rig.until(() => a.session.latestTick >= despawnTick)).toBe(true);
    expect(a.despawned).toHaveLength(0); // received, but the render time is still ~100 ms behind
    expect(await rig.until(() => a.despawned.length === 1)).toBe(true);
    expect(a.session.renderTick).toBeGreaterThanOrEqual(despawnTick);
  });

  it("delta state is exact after loss and jitter", async () => {
    const rig = new RepRig(undefined, { latencyMs: 40, lossRate: 0.2, jitterMs: 30 });
    const host = await rig.startHost();
    const a = await rig.join("a");
    const b = await rig.join("b");
    const aliens: { id: number; a: AlienState }[] = [];
    for (let i = 0; i < 20; i++) {
      const al = newAlien({ x: i });
      aliens.push({ id: host.session.spawn(ALIEN, 0, alienEntity(al)), a: al });
    }
    const r = rng(7);
    rig.hostTick = (tick) => {
      for (const { a: al } of aliens) {
        al.x += r() - 0.5;
        al.z += 0.05;
        al.yaw += 3;
        if (Math.floor(r() * 10) === 0) al.anim = Math.floor(r() * 16);
      }
      if (tick % 15 === 0) {
        const al = newAlien({ x: -5 });
        aliens.push({ id: host.session.spawn(ALIEN, 0, alienEntity(al)), a: al });
      }
      if (tick % 20 === 0 && aliens.length > 5) host.session.despawn(aliens.shift()!.id);
    };
    await rig.run(6);
    expect(a.session.stats.snapshotsReceived).toBeGreaterThan(100);
    expect(host.session.stats.fullSnapshotsSent).toBeLessThan(host.session.stats.snapshotsSent / 5);
    expectWorldsMatchHost(host, a);
    expectWorldsMatchHost(host, b);
    expect(a.session.stats.malformed).toBe(0);
  });

  it("a late joiner gets a full snapshot, then deltas", async () => {
    const rig = new RepRig(undefined, { latencyMs: 30 });
    const host = await rig.startHost();
    const early = await rig.join("early");
    const ids = Array.from({ length: 30 }, (_, i) => host.session.spawn(ALIEN, 0, alienEntity(newAlien({ x: i }))));
    await rig.run(1);
    for (let i = 0; i < 10; i++) host.session.despawn(ids[i]);
    await rig.run(1);
    const fullBefore = host.session.stats.fullSnapshotsSent;
    const late = await rig.join("late");
    expect(await rig.until(() => late.spawned.length === 20)).toBe(true);
    await rig.run(1);
    expect(late.session.entities.map((e) => e.id).sort((x, y) => x - y)).toEqual(ids.slice(10));
    expect(late.despawned).toHaveLength(0);
    expect(host.session.ackedTick(late.peerId)).toBeGreaterThan(0);
    const fulls = host.session.stats.fullSnapshotsSent - fullBefore;
    expect(fulls).toBeGreaterThanOrEqual(1);
    expect(fulls).toBeLessThanOrEqual(12); // full until the first ack comes back (~RTT), then deltas
    expectWorldsMatchHost(host, late);
    expect(early.session.entities).toHaveLength(20);
  });

  it("the host counts a client only once its link is up", async () => {
    const rig = new RepRig(undefined, { latencyMs: 30 });
    const host = await rig.startHost();
    const ready: number[] = [];
    host.session.on("clientReady", (p) => ready.push(p));
    host.session.spawn(ALIEN, 0, alienEntity(newAlien({ x: 1 })));
    rig.net.blockOpen = true; // this joiner's link never opens
    const stuck = await (async () => {
      const lobby = await rig.base.make("stuck", { mode: "raw" }).join(host.lobby.code);
      return lobby;
    })();
    await rig.run(2);
    expect(stuck.connectedPeers).toEqual([]);
    expect(host.session.clients).toEqual([]);
    expect(host.session.isClientReady(stuck.localPeerId)).toBe(false);
    expect(host.session.stats.snapshotsSent).toBe(0); // nothing streamed into a dead link
    rig.net.blockOpen = false;
    const ok = await rig.join("ok");
    expect(await rig.until(() => ok.spawned.length === 1)).toBe(true);
    await rig.run(1);
    expect(host.session.clients).toEqual([ok.peerId]);
    expect(ready).toEqual([ok.peerId]);
    expect(host.session.isClientReady(ok.peerId)).toBe(true);
    expect(host.session.stats.fullSnapshotsSent).toBeGreaterThanOrEqual(1); // its first snapshot was a full one
    expectWorldsMatchHost(host, ok);
  });

  it("interpolation renders about 100 ms behind and is smooth", async () => {
    const rig = new RepRig(undefined, { latencyMs: 25, jitterMs: 10 });
    const host = await rig.startHost();
    const a = await rig.join("a");
    const mover = newAlien();
    const id = host.session.spawn(ALIEN, 0, alienEntity(mover));
    rig.hostTick = (tick) => {
      mover.x = tick * 0.1 - 100; // 3 m/s along X
    };
    await rig.run(2);
    const samples: number[] = [];
    for (let i = 0; i < 120; i++) {
      await rig.step();
      const s = a.session.trySample(id, alienSchema);
      expect(s).toBeDefined();
      samples.push(s!.x);
      // interpolated X matches the host's function at the render tick (quantization step is ~0.8 cm)
      expect(Math.abs(s!.x - (a.session.renderTick * 0.1 - 100))).toBeLessThanOrEqual(0.02);
    }
    for (let i = 1; i < samples.length; i++) expect(samples[i], "went backwards at " + i).toBeGreaterThanOrEqual(samples[i - 1] - 1e-3);
    const behindMs = ((host.session.clock.tick - a.session.renderTick) * 1000) / 30;
    expect(behindMs).toBeGreaterThanOrEqual(100);
    expect(behindMs).toBeLessThanOrEqual(190);
    const est = ((host.session.clock.tick - a.session.serverTick) * 1000) / 30;
    expect(est).toBeGreaterThanOrEqual(0);
    expect(est).toBeLessThanOrEqual(70); // the server tick estimate trails by about the one-way latency
  });

  it("redundant inputs survive heavy loss", async () => {
    async function delivered(redundancy: number): Promise<{ received: number; applied: number }> {
      const rig = new RepRig({ inputRedundancy: redundancy }, { latencyMs: 30, lossRate: 0.3 });
      const host = await rig.startHost();
      const a = await rig.join("a");
      a.makeInput = (t) => new Uint8Array(new Uint32Array([t]).buffer);
      const got = new Set<number>();
      rig.hostTick = () => {
        const f = host.session.tryGetInput(a.peerId);
        if (f && !f.repeated) {
          got.add(f.seq);
          expect(f.bytes.length).toBe(4);
        }
      };
      await rig.run(20);
      const maxSeq = Math.max(...a.submittedSeqs);
      const sent = a.submittedSeqs.filter((s) => s < maxSeq - 10).length;
      const applied = [...got].filter((s) => s < maxSeq - 10).length / sent;
      return { received: 1 - host.session.stats.inputsLost / a.submittedSeqs.length, applied };
    }
    const one = await delivered(1);
    const four = await delivered(4);
    expect(one.received).toBeGreaterThan(0.6); // ~70%: one copy, 30% loss
    expect(one.received).toBeLessThan(0.8);
    expect(four.received, "4x redundancy: arrived").toBeGreaterThanOrEqual(0.98); // 1 - 0.3^4 = 99.2%
    expect(four.applied, "4x redundancy: applied").toBeGreaterThanOrEqual(0.95);
  });

  it("inputs arrive in order with a view tick", async () => {
    const rig = new RepRig(undefined, { latencyMs: 30 });
    const host = await rig.startHost();
    const a = await rig.join("a");
    host.session.spawn(ALIEN, 0, alienEntity(newAlien()));
    a.makeInput = (t) => Uint8Array.of(t & 0xff);
    const seqs: number[] = [];
    const views: [number, number][] = [];
    rig.hostTick = (tick) => {
      const f = host.session.tryGetInput(a.peerId);
      if (f && !f.repeated) {
        seqs.push(f.seq);
        views.push([f.viewTick, tick]);
      }
    };
    await rig.run(3);
    expect(seqs.length).toBeGreaterThan(60);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
    const [view, at] = views[views.length - 1];
    const lagMs = ((at - view) * 1000) / 30;
    expect(lagMs).toBeGreaterThanOrEqual(120);
    expect(lagMs).toBeLessThanOrEqual(260); // interp 100 + one-way 30 + input travel 30 + buffering
    expect(a.session.lastProcessedInput).toBeGreaterThan(0);
  });

  it("reliable events arrive once, in order, both ways", async () => {
    const rig = new RepRig(undefined, { latencyMs: 30, lossRate: 0.3 });
    const host = await rig.startHost();
    const a = await rig.join("a");
    const b = await rig.join("b");
    for (let i = 0; i < 20; i++) host.session.sendEvent(Uint8Array.of(i));
    host.session.sendEvent(Uint8Array.of(99), { to: b.peerId });
    a.session.sendEvent(Uint8Array.of(42));
    await rig.run(1);
    expect(a.events.map((e) => e.payload[0])).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(b.events).toHaveLength(21);
    expect(b.events[b.events.length - 1].payload[0]).toBe(99);
    expect(host.events.map((e) => [e.from, e.payload[0]])).toEqual([[a.peerId, 42]]);
    for (const e of a.events) expect(e.from).toBe(host.peerId);
  });

  it("other raw messages pass through untouched", async () => {
    const rig = new RepRig();
    const host = await rig.startHost();
    const a = await rig.join("a");
    const got: Uint8Array[] = [];
    a.session.on("otherMessage", (_f, bytes) => got.push(bytes));
    host.lobby.broadcast(Uint8Array.of(1, 2, 3));
    await rig.run(0.2);
    expect(got).toHaveLength(1);
    expect(Array.from(got[0])).toEqual([1, 2, 3]);
    expect(ReplicationSession.isReplicationPayload(got[0])).toBe(false);
    expect(ReplicationSession.isReplicationPayload(Uint8Array.of(0x52, 1, 1))).toBe(true);
    expect(ReplicationSession.isReplicationPayload(Uint8Array.of(0x52, 1))).toBe(false);
  });

  it("a snapshot against a baseline the client does not hold is dropped quietly (vector)", async () => {
    const v = (specJson("vectors/replication.json").snapshots as any[]).find((e) => e.clientHoldsBaseline === false);
    const rig = new RepRig();
    const host = await rig.startHost();
    await rig.run(1); // the host is past tick 5 when the client joins
    const a = await rig.join("a");
    await rig.run(0.2);
    const before = a.session.stats.snapshotsDropped;
    host.lobby.send(a.peerId, fromHex(v.hex), { channel: "fast" });
    await rig.run(0.2);
    expect(a.session.stats.snapshotsDropped).toBe(before + 1);
    expect(a.session.stats.malformed).toBe(0);
  });

  it("an unknown version or kind is not delivered to the game", async () => {
    const rig = new RepRig();
    const host = await rig.startHost();
    const a = await rig.join("a");
    const got: Uint8Array[] = [];
    a.session.on("otherMessage", (_f, bytes) => got.push(bytes));
    host.lobby.send(a.peerId, Uint8Array.of(0x52, 2, 1, 0));
    host.lobby.send(a.peerId, Uint8Array.of(0x52, 1, 9, 0));
    await rig.run(0.2);
    expect(got).toHaveLength(0);
    expect(a.session.stats.malformed).toBe(1); // the version; an unknown kind is ignored
  });

  it("rewind is clamped to maxRewindMs", async () => {
    const rig = new RepRig({ maxRewindMs: 200 });
    const host = await rig.startHost();
    await rig.run(1);
    const now = host.session.clock.tick;
    expect(host.session.rewindTick({ viewTick: 0 })).toBeCloseTo(now - 6, 6);
    expect(host.session.rewindTick({ viewTick: now - 2.5 })).toBeCloseTo(now - 2.5, 6);
    expect(host.session.rewindTick({ viewTick: now + 50 })).toBeCloseTo(now, 6);
  });

  it("four players and fifty aliens stay under the bandwidth budget", async () => {
    // Worst case for a 4-player co-op game: host + 3 clients, 50 aliens all moving every tick, 4 avatars, 5% loss, jitter.
    const rig = new RepRig(undefined, { latencyMs: 40, lossRate: 0.05, jitterMs: 15 });
    const host = await rig.startHost();
    const clients = [await rig.join("a"), await rig.join("b"), await rig.join("c")];
    const r = rng(11);
    const all: AlienState[] = [];
    for (let i = 0; i < 50; i++) {
      const al = newAlien({ x: Math.floor(r() * 200) - 100, z: Math.floor(r() * 200) - 100, yaw: Math.floor(r() * 360) });
      all.push(al);
      host.session.spawn(ALIEN, 0, alienEntity(al));
    }
    const avatars: AlienState[] = [];
    for (const p of [host.peerId, ...clients.map((c) => c.peerId)]) {
      const av = newAlien();
      avatars.push(av);
      host.session.spawn(PLAYER, p, alienEntity(av));
    }
    for (const c of clients) c.makeInput = (t) => Uint8Array.of(t & 0xff, 0x10, 0x20, 0x30, 0x40, 0x50);
    rig.hostTick = (tick) => {
      for (const al of all) {
        const rad = (al.yaw * Math.PI) / 180;
        al.yaw += r() * 6 - 3;
        al.x += Math.cos(rad) * 0.13;
        al.z += Math.sin(rad) * 0.13;
        al.y = Math.sin(tick * 0.05 + al.z) * 0.2;
        if (Math.floor(r() * 30) === 0) al.anim = Math.floor(r() * 16);
      }
      for (const av of avatars) {
        av.x += 0.2;
        av.yaw += 1;
      }
      for (const c of clients) host.session.tryGetInput(c.peerId);
    };
    await rig.run(2); // warm up: everyone acked, deltas flowing
    const fastBefore = rig.sentBytes(host, "fast");
    const relBefore = rig.sentBytes(host, "reliable");
    const clientFastBefore = clients.map((c) => rig.sentBytes(c, "fast"));
    const before = clients.map((c) => host.session.bytesSentTo(c.peerId));
    const snapsBefore = host.session.stats.snapshotsSent;
    const seconds = 10;
    await rig.run(seconds);

    const snapsPerClient = (host.session.stats.snapshotsSent - snapsBefore) / clients.length;
    // replication payload + the 3-byte lobby header on every snapshot frame
    const perClient = clients.map((c, i) => (host.session.bytesSentTo(c.peerId) - before[i] + 3 * snapsPerClient) / seconds);
    const hostFastUp = (rig.sentBytes(host, "fast") - fastBefore) / seconds;
    const hostReliableUp = (rig.sentBytes(host, "reliable") - relBefore) / seconds;
    const clientUp = Math.max(...clients.map((c, i) => (rig.sentBytes(c, "fast") - clientFastBefore[i]) / seconds));
    const avgSnap = host.session.stats.snapshotBytesSent / host.session.stats.snapshotsSent;
    console.log(
      `54 entities @30 Hz, 3 clients, 5% loss: snapshot avg ${avgSnap.toFixed(0)} B, largest ${host.session.stats.largestSnapshot} B; ` +
        `per-client down ${((Math.max(...perClient) * 8) / 1000).toFixed(1)} kbit/s; host up fast ${((hostFastUp * 8) / 1000).toFixed(1)}, ` +
        `reliable ${((hostReliableUp * 8) / 1000).toFixed(1)} kbit/s; client up ${((clientUp * 8) / 1000).toFixed(1)} kbit/s`,
    );
    for (const c of clients) expectWorldsMatchHost(host, c);

    // Budget (DESIGN s.18): 128 kbit/s per client down, 3 x 128 host up, 16 kbit/s client up, MTU-safe snapshots.
    for (const b of perClient) expect(b * 8, "client downstream bit/s").toBeLessThanOrEqual(128_000);
    expect(hostFastUp * 8, "host upstream bit/s").toBeLessThanOrEqual(3 * 128_000);
    expect(clientUp * 8, "client upstream bit/s").toBeLessThanOrEqual(16_000);
    expect(host.session.stats.largestSnapshot).toBeLessThanOrEqual(1200);
  }, 120_000);
});

describe("sampling helpers", () => {
  it("lerpOrSnap jumps past maxDistance", () => {
    expect(NetMath.lerpOrSnap(0, 2, 0.5, 2.5)).toBe(1);
    expect(NetMath.lerpOrSnap(0, 10, 0.5, 2)).toBe(10);
  });
  it("lerpAngle takes the short way round", () => {
    expect(NetMath.lerpAngle(350, 10, 0.5)).toBeCloseTo(0, 6);
    expect(NetMath.lerpAngle(10, 350, 0.5)).toBeCloseTo(0, 6);
    expect(NetMath.lerpAngle(0, 90, 0.5)).toBeCloseTo(45, 6);
  });
});

describe("keyframes, rates, packet log and diagnostics", () => {
  it("a late joiner gets a reliable full snapshot even if every fast packet is lost", async () => {
    const rig = new RepRig(undefined, { latencyMs: 30, lossRate: 1.0 });
    const host = await rig.startHost();
    const id = host.session.spawn(ALIEN, 0, alienEntity(newAlien({ x: 5 })));
    await rig.run(0.5);
    const a = await rig.join("a");
    expect(await rig.until(() => a.session.latestTick > 0, 200)).toBe(true);
    expect(host.session.stats.keyframesSent).toBe(1);
    const got = a.session.tryGetLatest(id, alienSchema);
    expect(got).toBeDefined();
    expect(got!.state.x).toBeCloseTo(5, 2);
  });

  it("keyframes repeat every keyframeSeconds and stop when it is 0", async () => {
    const rig = new RepRig({ keyframeSeconds: 1 }, { latencyMs: 20 });
    const host = await rig.startHost();
    await rig.join("a");
    host.session.spawn(ALIEN, 0, alienEntity(newAlien()));
    await rig.run(3.5);
    expect(host.session.stats.keyframesSent).toBeGreaterThanOrEqual(3);
    expect(host.session.stats.keyframesSent).toBeLessThanOrEqual(5);
    expect(host.session.stats.fullSnapshotsSent).toBeGreaterThanOrEqual(host.session.stats.keyframesSent);

    const off = new RepRig({ keyframeSeconds: 0 }, { latencyMs: 20 });
    const h2 = await off.startHost();
    const b = await off.join("b");
    h2.session.spawn(ALIEN, 0, alienEntity(newAlien()));
    await off.run(3);
    expect(h2.session.stats.keyframesSent).toBe(0);
    expect(await off.until(() => b.spawned.length === 1)).toBe(true); // full snapshots on fast until the first ack, as before
  });

  it("rates count payload bytes per kind over the last second", async () => {
    const rig = new RepRig(undefined, { latencyMs: 20 });
    const host = await rig.startHost();
    const a = await rig.join("a");
    host.session.spawn(ALIEN, 0, alienEntity(newAlien()));
    a.makeInput = (t) => Uint8Array.of(t & 0xff, 1, 2);
    await rig.run(2);
    const before = host.session.bytesSentTo(a.peerId);
    await rig.run(1);
    const perSecond = host.session.bytesSentTo(a.peerId) - before;
    const hr = host.session.trafficRates;
    expect(hr.snapshotsSent).toBeGreaterThan(perSecond * 0.85);
    expect(hr.snapshotsSent).toBeLessThan(perSecond * 1.15);
    expect(hr.totalSent).toBe(hr.snapshotsSent + hr.inputsSent + hr.eventsSent);
    expect(hr.inputsReceived).toBeGreaterThan(0);
    expect(a.session.trafficRates.inputsSent).toBeGreaterThan(0);
    expect(a.session.trafficRates.snapshotsReceived).toBeGreaterThan(hr.snapshotsSent * 0.85);
    expect(a.session.trafficRates.snapshotsReceived).toBeLessThan(hr.snapshotsSent * 1.15);

    host.session.sendEvent(new Uint8Array(10));
    await rig.run(0.1);
    expect(host.session.trafficRates.eventsSent).toBeGreaterThanOrEqual(13);
    expect(a.session.trafficRates.eventsReceived).toBeGreaterThanOrEqual(13);
    await rig.run(1.2);
    expect(host.session.trafficRates.eventsSent).toBe(0);
  });

  it("the packet log writes one JSON line per packet at a capped rate, to a callback or the net log", async () => {
    const rig = new RepRig({ packetLogPerSecond: 5 }, { latencyMs: 20 });
    const host = await rig.startHost();
    const a = await rig.join("a");
    host.session.spawn(ALIEN, 0, alienEntity(newAlien()));
    await rig.run(1);
    const lines: string[] = [];
    a.session.packetLog = (l) => lines.push(l);
    a.makeInput = (t) => Uint8Array.of(t & 0xff);
    await rig.run(1);
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.length).toBeLessThanOrEqual(10); // 5 a second; the window may straddle two
    for (const l of lines) {
      const [rep, dir, peer, ch, json] = [...l.split(" ").slice(0, 4), l.split(" ").slice(4).join(" ")];
      expect(rep).toBe("rep");
      expect(["in", "out"]).toContain(dir);
      expect(Number.isInteger(Number(peer))).toBe(true);
      expect(["fast", "reliable"]).toContain(ch);
      expect(["snapshot", "input"]).toContain(JSON.parse(json).kind);
    }
    // true: into the kit's net log
    const entries = a.lobby.netLog?.entries.length ?? 0;
    a.session.packetLog = true;
    await rig.run(0.3);
    if (a.lobby.netLog) expect(a.lobby.netLog.entries.length).toBeGreaterThan(entries);
    a.session.packetLog = false;
  });

  it("rtt, host peer id and snapshot age are exposed", async () => {
    const rig = new RepRig(undefined, { latencyMs: 40 });
    const host = await rig.startHost();
    const a = await rig.join("a");
    host.session.spawn(ALIEN, 0, alienEntity(newAlien()));
    await rig.run(3);
    expect(a.session.hostPeerId).toBe(host.peerId);
    expect(host.session.hostPeerId).toBe(host.peerId);
    expect(a.session.rttMs).toBeGreaterThanOrEqual(70);
    expect(a.session.rttMs).toBeLessThanOrEqual(140);
    expect(host.session.rttMs).toBe(0);
    expect(a.session.snapshotAgeMs).toBeGreaterThanOrEqual(0);
    expect(a.session.snapshotAgeMs).toBeLessThanOrEqual(60);
  });

  it("sendFullSnapshot resets one client's baseline, then deltas resume", async () => {
    const rig = new RepRig(undefined, { latencyMs: 30 });
    const host = await rig.startHost();
    const a = await rig.join("a");
    const b = await rig.join("b");
    for (let i = 0; i < 10; i++) host.session.spawn(ALIEN, 0, alienEntity(newAlien({ x: i })));
    await rig.run(2);
    const fullBefore = host.session.stats.fullSnapshotsSent;
    expect(host.session.ackedTick(a.peerId)).toBeGreaterThan(0);
    host.session.sendFullSnapshot(a.peerId);
    expect(host.session.ackedTick(a.peerId)).toBe(0);
    await rig.run(1);
    const fulls = host.session.stats.fullSnapshotsSent - fullBefore;
    expect(fulls).toBeGreaterThanOrEqual(1);
    expect(fulls).toBeLessThanOrEqual(8); // only a, until its next ack (~RTT)
    expect(host.session.ackedTick(a.peerId)).toBeGreaterThan(0);
    expect(a.session.entities).toHaveLength(10);
    expect(a.despawned).toHaveLength(0);
    expect(b.session.entities).toHaveLength(10);
  });

  it("input stats are split per client", async () => {
    const rig = new RepRig(undefined, { latencyMs: 30 });
    const host = await rig.startHost();
    const a = await rig.join("a");
    const b = await rig.join("b");
    a.makeInput = (t) => Uint8Array.of(t & 0xff);
    b.makeInput = (t) => (t % 2 === 0 ? Uint8Array.of(t & 0xff) : null); // b sends every other tick: repeats
    rig.hostTick = () => {
      host.session.tryGetInput(a.peerId);
      host.session.tryGetInput(b.peerId);
    };
    await rig.run(3);
    const sa = host.session.inputStatsFor(a.peerId);
    const sb = host.session.inputStatsFor(b.peerId);
    expect(sb.repeated, "b repeats").toBeGreaterThan(30);
    expect(sa.repeated, "a repeats").toBeLessThan(sb.repeated / 4);
    expect(sa.bufferDepth).toBeLessThanOrEqual(4);
    expect(sa.repeated + sb.repeated).toBe(host.session.stats.inputsRepeated);
    expect(sa.skipped + sb.skipped).toBe(host.session.stats.inputsSkipped);
    expect(host.session.inputStatsFor(99)).toEqual({ repeated: 0, skipped: 0, lost: 0, bufferDepth: 0 });
  });
});
