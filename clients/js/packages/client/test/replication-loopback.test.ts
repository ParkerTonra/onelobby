import { afterEach, describe, expect, it } from "vitest";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { OneLobby, ReplicationSession } from "../src/index.js";
import { webRtcLinkFactoryFor } from "../src/webrtc.js";
import { hostDirect } from "../src/direct/index.js";
import { alienEntity, alienSchema, newAlien } from "./replication-rig.js";
import { freePort, loopbackRtc } from "./helpers.js";

/** Real WebRTC data channels on 127.0.0.1 (libdatachannel), real clock: the same flow as the in-memory tests, over a socket. */
const links = webRtcLinkFactoryFor(loopbackRtc(RTCPeerConnection) as unknown as typeof globalThis.RTCPeerConnection);
const kit = (name: string) =>
  new OneLobby({ gameId: "com.onelobby.replicationtest", netVersion: "1", lobbyServer: "", mode: "raw", displayName: name, rememberSeat: false, advanced: { linkFactory: links } });

const until = async (cond: () => boolean, what: string, ms = 10000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

describe("replication over real WebRTC links on loopback", () => {
  it("spawn, move, input and one event each way", async () => {
    const port = await freePort();
    const host = await hostDirect(kit("Host"), { nostr: false, bindHost: "127.0.0.1", port, openPort: false });
    cleanup.push(() => host.leave());
    const joiner = await kit("Sam").joinDirect(`127.0.0.1:${port}`);
    cleanup.push(() => joiner.leave());
    await joiner.ready;

    const hs = new ReplicationSession(host);
    const cs = new ReplicationSession(joiner);
    const spawned: number[] = [];
    cs.on("entitySpawned", (e) => spawned.push(e.id));
    const hostEvents: number[] = [];
    const clientEvents: number[] = [];
    hs.on("eventReceived", (_f, _t, p) => hostEvents.push(p[0]));
    cs.on("eventReceived", (_f, _t, p) => clientEvents.push(p[0]));

    const alien = newAlien({ x: -10 });
    const id = hs.spawn(7, 0, alienEntity(alien));
    const inputs: number[] = [];
    const timer = setInterval(() => {
      hs.pump();
      while (hs.clock.tryAdvance()) {
        alien.x += 0.1;
        const f = hs.tryGetInput(joiner.localPeerId);
        if (f && !f.repeated) inputs.push(f.bytes[0]);
        hs.sendSnapshot();
      }
      cs.pump();
      while (cs.clock.tryAdvance()) cs.submitInput(Uint8Array.of(cs.clock.tick & 0xff));
    }, 8);
    cleanup.push(() => clearInterval(timer));

    await until(() => spawned.length === 1, "client sees the entity");
    hs.sendEvent(Uint8Array.of(11), { to: joiner.localPeerId });
    cs.sendEvent(Uint8Array.of(22));
    await until(() => hostEvents.length === 1 && clientEvents.length === 1 && inputs.length > 10 && cs.lastProcessedInput > 0, "inputs and events");
    await until(() => (cs.trySample(id, alienSchema)?.x ?? -99) > -9, "the entity moved on the client");
    expect(spawned).toEqual([id]);
    expect(hostEvents).toEqual([22]);
    expect(clientEvents).toEqual([11]);
    expect(hs.ackedTick(joiner.localPeerId)).toBeGreaterThan(0);
    expect(cs.stats.malformed).toBe(0);
    expect(hs.stats.keyframesSent).toBe(1);
    const latest = cs.tryGetLatest(id, alienSchema)!;
    expect(latest.state.x).toBeGreaterThan(-10);
    clearInterval(timer);
    hs.dispose();
    cs.dispose();
  }, 30000);
});
