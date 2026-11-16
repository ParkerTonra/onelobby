import { describe, expect, it } from "vitest";
import { encodeStreamEvent } from "../src/internals.js";
import { MAX_STREAM_AHEAD, MAX_STREAM_BUFFERED, MAX_STREAM_BUFFERED_BYTES, type ReplicatedEvent, type StreamGap } from "../src/internals.js";
import { RepRig, type RepPlayer } from "./replication-rig.js";
import { specJson } from "./spec.js";

const u32 = (v: number) => new Uint8Array(new Uint32Array([v]).buffer);
const readU32 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);

async function setup(config?: ConstructorParameters<typeof RepRig>[0]) {
  const rig = new RepRig(config, { latencyMs: 30 });
  const host = await rig.startHost();
  const a = await rig.join("a");
  await rig.run(0.5);
  const got: ReplicatedEvent[] = [];
  const gaps: StreamGap[] = [];
  a.session.on("eventDelivered", (e) => got.push(e));
  a.session.on("eventGap", (g) => gaps.push(g));
  return { rig, host, a, got, gaps };
}

describe("numbered stream events", () => {
  it("are exactly-once and in order even when the transport duplicates and reorders", async () => {
    const { rig, host, a, got, gaps } = await setup();
    let on = false;
    rig.net.duplicateReliable = () => on && rig.random() < 0.2;
    rig.net.reorderReliable = () => on && rig.random() < 0.2;
    on = true;
    for (let i = 1; i <= 200; i++) {
      host.session.sendEvent(u32(i), { to: a.peerId, stream: 3 });
      if (i % 10 === 0) await rig.step();
    }
    await rig.run(1);
    on = false;
    expect(got.map((e) => e.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(got.map((e) => readU32(e.payload))).toEqual(got.map((e) => e.seq));
    for (const e of got) expect(e.stream).toBe(3);
    expect(gaps).toEqual([]);
    expect(a.session.stats.eventsDuplicate).toBeGreaterThan(0);
    expect(a.session.stats.eventsOutOfOrder).toBeGreaterThan(0);
    expect(a.session.stats.eventsGap).toBe(0);
  });

  it("a lost event is reported as a gap after the timeout and the stream goes on", async () => {
    const { rig, host, a, got, gaps } = await setup();
    const drop = new Set([5, 6, 40]);
    let sending = 0;
    rig.net.dropReliable = () => drop.has(sending);
    for (sending = 1; sending <= 50; sending++) host.session.sendEvent(u32(sending), { to: a.peerId, stream: 1 });
    sending = 0;
    await rig.run(0.5);
    expect(got).toHaveLength(4); // 1-4; 7.. wait for 5
    await rig.run(2.5);
    expect(got).toHaveLength(47);
    expect(gaps.map((g) => [g.stream, g.firstMissing, g.nextDelivered])).toEqual([[1, 5, 7], [1, 40, 41]]);
    expect(a.session.stats.eventsGap).toBe(2);
    const seqs = got.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
  });

  it("are numbered separately per recipient; plain events have no seq", async () => {
    const { rig, host, a, got } = await setup();
    const b = await rig.join("b");
    const gotB: ReplicatedEvent[] = [];
    b.session.on("eventDelivered", (e) => gotB.push(e));
    host.session.sendEvent(u32(1), { stream: 1 }); // both clients: seq 1
    host.session.sendEvent(u32(2), { to: a.peerId, stream: 1 }); // a only: seq 2
    host.session.sendEvent(u32(3), { stream: 2 });
    host.session.sendEvent(u32(4));
    host.session.sendEvent(u32(5), { stream: 1 }); // a: 3, b: 2
    await rig.run(0.5);
    expect(got.map((e) => [e.stream, e.seq])).toEqual([[1, 1], [1, 2], [2, 1], [0, 0], [1, 3]]);
    expect(gotB.map((e) => [e.stream, e.seq])).toEqual([[1, 1], [2, 1], [0, 0], [1, 2]]);
    expect(host.session.reliableEventBytesSentTo(a.peerId)).toBeGreaterThan(host.session.reliableEventBytesSentTo(b.peerId));
    expect(a.events).toHaveLength(5); // eventReceived still fires for every event

    a.session.sendEvent(u32(9), { stream: 7 }); // client to host
    const atHost: ReplicatedEvent[] = [];
    host.session.on("eventDelivered", (e) => atHost.push(e));
    await rig.run(0.5);
    expect(atHost).toHaveLength(1);
    expect([atHost[0].stream, atHost[0].seq]).toEqual([7, 1]);
  });

  it("are reliable only", async () => {
    const { host, a } = await setup();
    expect(() => host.session.sendEvent(u32(1), { to: a.peerId, channel: "fast", stream: 1 })).toThrow();
  });

  for (const hold of [0, 8]) {
    it(`holdEventsForTicks ${hold} lines events up with their snapshot`, async () => {
      const { rig, host, a, got } = await setup({ holdEventsForTicks: hold });
      rig.net.extraDelayMs = (ch) => (ch === "fast" ? 60 : 0); // snapshots come in after the events
      const latestAtDelivery: { tick: number; latest: number }[] = [];
      a.session.on("eventDelivered", (e) => latestAtDelivery.push({ tick: e.tick, latest: a.session.latestTick }));
      rig.hostTick = (t) => {
        if (t % 5 === 0) host.session.sendEvent(u32(t), { stream: 1 });
      };
      await rig.run(3);
      expect(latestAtDelivery.length).toBeGreaterThan(10);
      const early = latestAtDelivery.filter((x) => x.latest < x.tick).length;
      if (hold === 0) expect(early, "unheld events beat their snapshot").toBeGreaterThan(latestAtDelivery.length / 2);
      else expect(early).toBe(0);
      const seqs = got.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    });
  }
});

// A joiner that breaks the stream contract on purpose (holes, huge jumps, the fast channel) cannot make the host hold
// its events without bound.
function forge(from: RepPlayer, to: number, stream: number, seq: number, payloadBytes = 4, channel: "reliable" | "fast" = "reliable"): void {
  from.lobby.send(to, encodeStreamEvent(1, stream, seq, new Uint8Array(payloadBytes)), { channel });
}

describe("a misbehaving sender", () => {
  it("sending only holes cannot grow the host's buffer", async () => {
    const { rig, host, a } = await setup();
    const gaps: StreamGap[] = [];
    host.session.on("eventGap", (g) => gaps.push(g));
    for (let seq = 2; seq <= 2000; seq += 2) {
      forge(a, host.peerId, 1, seq);
      if (seq % 100 === 0) await rig.step();
    }
    await rig.run(0.3); // well under the 1 s gap timeout
    expect(host.session.bufferedStreamEvents).toBeLessThanOrEqual(MAX_STREAM_BUFFERED);
    expect(gaps.length).toBeGreaterThan(0);
  });

  it("big payloads hit the byte cap before the count cap", async () => {
    const { rig, host, a } = await setup();
    for (let seq = 2; seq <= 40; seq += 2) forge(a, host.peerId, 1, seq, 64 * 1024);
    await rig.run(0.3);
    expect(host.session.bufferedStreamEvents).toBeLessThanOrEqual(MAX_STREAM_BUFFERED_BYTES / (64 * 1024));
  });

  it("a far jump or the fast channel is malformed", async () => {
    const { rig, host, a } = await setup();
    const got: ReplicatedEvent[] = [];
    host.session.on("eventDelivered", (e) => got.push(e));
    forge(a, host.peerId, 1, MAX_STREAM_AHEAD + 1);
    forge(a, host.peerId, 2, 1, 4, "fast");
    forge(a, host.peerId, 3, 1); // a good one still arrives
    await rig.run(0.3);
    expect(host.session.stats.malformed).toBe(2);
    expect(host.session.bufferedStreamEvents).toBe(0);
    expect(got.map((e) => e.stream)).toEqual([3]);
  });
});

// The receive side of numbered streams against the shared vectors (spec/vectors/replication.json, group streamReceive): the
// arrivals of one sender are forged on a reliable link with no latency, one millisecond per step, and the host session must
// deliver, report gaps and count anomalies exactly as the C# reference did.
describe("replication vectors: streamReceive", () => {
  const cases = specJson("vectors/replication.json").streamReceive as {
    name: string;
    arrivals: { at: number; stream: number; seq: number; bytes: number }[];
    endAt: number;
    expect: { events: unknown[]; duplicates: number; outOfOrder: number; gaps: number; malformed: number; buffered: number };
  }[];
  it("has cases", () => expect(cases.length).toBeGreaterThanOrEqual(10));
  for (const c of cases) {
    it(c.name, async () => {
      const rig = new RepRig(undefined, { latencyMs: 0 });
      const host = await rig.startHost();
      const a = await rig.join("a");
      await rig.run(0.5);
      rig.frameMs = 1;
      const start = host.lobby.nowMs + 1; // the first step below reads 0
      const events: unknown[] = [];
      host.session.on("eventDelivered", (e) => events.push({ type: "deliver", at: host.lobby.nowMs - start, stream: e.stream, seq: e.seq }));
      host.session.on("eventGap", (g) =>
        events.push({ type: "gap", at: host.lobby.nowMs - start, stream: g.stream, firstMissing: g.firstMissing, nextDelivered: g.nextDelivered }));
      const s = host.session.stats;
      const before = { dup: s.eventsDuplicate, ooo: s.eventsOutOfOrder, gap: s.eventsGap, bad: s.malformed };
      let next = 0;
      for (let t = 0; t <= c.endAt; t++) {
        while (next < c.arrivals.length && c.arrivals[next].at === t) {
          const x = c.arrivals[next++];
          a.lobby.send(host.peerId, encodeStreamEvent(1, x.stream, x.seq, new Uint8Array(x.bytes)), { channel: "reliable" });
        }
        await rig.step();
      }
      expect({
        events, duplicates: s.eventsDuplicate - before.dup, outOfOrder: s.eventsOutOfOrder - before.ooo, gaps: s.eventsGap - before.gap,
        malformed: s.malformed - before.bad, buffered: host.session.bufferedStreamEvents,
      }).toEqual(c.expect);
    }, 60_000);
  }
});
