import { describe, expect, it } from "vitest";
import { ManualClock, NetSimLinkFactory, type NetSimOptions } from "../src/testing.js";
import type { ChannelName, LinkFactory, PeerLink } from "../src/transport.js";

/** An in-memory pair of links: a frame sent on one arrives on the other at once (the sim does all the delaying). */
class Pipe implements PeerLink {
  remoteId = 1;
  isOpen = true;
  onSignal = null;
  onOpen = null;
  onClose = null;
  onMessage: PeerLink["onMessage"] = null;
  other: Pipe | null = null;
  startOffer(): void {}
  handleSignal(): void {}
  send(channel: ChannelName, bytes: Uint8Array): void {
    this.other?.onMessage?.(channel, bytes);
  }
  close(): void {
    this.isOpen = false;
  }
}

/** Both ends wrapped with the same options (so latencyMs is the one-way time). */
function pair(clock: ManualClock, options: NetSimOptions) {
  const a = new Pipe();
  const b = new Pipe();
  a.other = b;
  b.other = a;
  const mk = (p: Pipe, seed: number): PeerLink => new NetSimLinkFactory({ create: () => p } as LinkFactory, { ...options, seed }, clock).create({ remoteId: 1, iceServers: [], relayOnly: false });
  return { from: mk(a, options.seed ?? 1), to: mk(b, (options.seed ?? 1) + 1000) };
}

const idBytes = (i: number) => Uint8Array.of(i & 255, (i >> 8) & 255);
const idOf = (b: Uint8Array) => b[0] | (b[1] << 8);

/** Sends `n` frames of a channel, one per ms, and runs the clock until everything due has gone out; returns the delays and the ids that arrived. */
function run(options: NetSimOptions, channel: ChannelName, n = 1000) {
  const clock = new ManualClock();
  const { from, to } = pair(clock, options);
  const got: { id: number; delay: number; at: number }[] = [];
  const sentAt: number[] = [];
  to.onMessage = (_c, b) => got.push({ id: idOf(b), delay: clock.now() - sentAt[idOf(b)], at: clock.now() });
  for (let i = 0; i < n; i++) {
    sentAt[i] = clock.now();
    from.send(channel, idBytes(i));
    clock.advance(1);
  }
  clock.advance(1000);
  return got;
}

describe("NetSimLinkFactory", () => {
  it("passes frames straight through with the default options", () => {
    const got = run({}, "fast", 100);
    expect(got.length).toBe(100);
    expect(got.every((g) => g.delay === 0)).toBe(true);
  });

  it("delays frames: the mean is the latency plus the mean jitter (both ends wrapped), within 10% over 1000 frames", () => {
    const got = run({ latencyMs: 100, jitterMs: 20, seed: 7 }, "fast"); // reliable frames are held back to keep their order, so their mean runs higher
    expect(got.length).toBe(1000);
    const mean = got.reduce((s, g) => s + g.delay, 0) / got.length;
    console.log(`netsim js: mean delay ${mean.toFixed(2)} ms over ${got.length} frames (latency 100, jitter 20, two hops)`);
    expect(mean).toBeGreaterThan(120 * 0.9);
    expect(mean).toBeLessThan(120 * 1.1);
  });

  it("keeps the delay of a frame inside latency .. latency + 2 x jitter", () => {
    const got = run({ latencyMs: 100, jitterMs: 20, seed: 3 }, "fast");
    const min = Math.min(...got.map((g) => g.delay));
    const max = Math.max(...got.map((g) => g.delay));
    console.log(`netsim js: delay range ${min}..${max} ms (allowed 100..140)`);
    expect(min).toBeGreaterThanOrEqual(100 - 2); // two truncations to whole ms
    expect(max).toBeLessThanOrEqual(140);
    expect(max - min).toBeGreaterThan(20); // it does jitter
  });

  it("loses about lossPercent of the fast frames in each direction, within the binomial range", () => {
    const got = run({ latencyMs: 20, lossPercent: 20, seed: 5 }, "fast");
    // survive both hops: p = 0.8 * 0.8 = 0.64; sd = sqrt(1000 * .64 * .36) = 15.2; four sd either side
    console.log(`netsim js: ${got.length} of 1000 fast frames arrived (expected 640, sd 15.2)`);
    expect(got.length).toBeGreaterThan(640 - 61);
    expect(got.length).toBeLessThan(640 + 61);
  });

  it("delays reliable frames but never drops them and keeps them in order, even with jitter and loss on", () => {
    const got = run({ latencyMs: 60, jitterMs: 40, lossPercent: 50, seed: 9 }, "reliable");
    expect(got.length).toBe(1000);
    expect(got.map((g) => g.id)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    expect(got.every((g) => g.delay >= 59)).toBe(true);
  });

  it("lets fast frames overtake each other with jitter (the reordering reliable frames are spared)", () => {
    const got = run({ latencyMs: 20, jitterMs: 60, seed: 11 }, "fast");
    const ids = got.map((g) => g.id);
    expect(ids.some((v, i) => i > 0 && v < ids[i - 1])).toBe(true);
  });

  it("repeats the same run for the same seed and differs for another", () => {
    const o = { latencyMs: 80, jitterMs: 30, lossPercent: 10 };
    const a = run({ ...o, seed: 42 }, "fast");
    const b = run({ ...o, seed: 42 }, "fast");
    const c = run({ ...o, seed: 43 }, "fast");
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it("takes new options while running", () => {
    const clock = new ManualClock();
    const a = new Pipe();
    const b = new Pipe();
    a.other = b;
    const f = new NetSimLinkFactory({ create: () => a } as LinkFactory, { latencyMs: 100 }, clock);
    const link = f.create({ remoteId: 1, iceServers: [], relayOnly: false });
    let n = 0;
    b.onMessage = () => n++;
    link.send("reliable", idBytes(1));
    clock.advance(49);
    expect(n).toBe(0);
    clock.advance(1);
    expect(n).toBe(1);
    f.options = {};
    link.send("reliable", idBytes(2));
    expect(n).toBe(2);
  });
});
