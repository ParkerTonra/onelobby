import { afterEach, describe, expect, it } from "vitest";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { OneLobby } from "../src/onelobby.js";
import { decodeJoinCode, encodeRoomCode } from "../src/joincode.js";
import { webRtcLinkFactoryFor } from "../src/webrtc.js";
import { systemClock } from "../src/clock.js";
import { SignalingHub, directHubOptions } from "../src/direct/hub.js";
import { NostrHostBridge } from "../src/nostr/host.js";
import { NostrSocket } from "../src/nostr/socket.js";
import { hostDirect } from "../src/direct/index.js";
import { freePort } from "./helpers.js";
import { FakeRelays } from "./fake-relay.js";

const URLS = ["wss://r1.test", "wss://r2.test"];
const links = webRtcLinkFactoryFor(RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection);

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

describe("NostrSocket <-> NostrHostBridge through fake relays", () => {
  const speak = (sock: NostrSocket) => {
    const inbox: any[] = [];
    sock.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
    const next = async (t: string, ms = 8000) => {
      await until(() => inbox.some((m) => m.t === t || m.t === "error"), `message ${t}`, ms);
      return inbox.splice(inbox.findIndex((m) => m.t === t || m.t === "error"), 1)[0];
    };
    return { inbox, next, send: (m: object) => sock.send(JSON.stringify(m)) };
  };

  async function setup(relays: FakeRelays) {
    const hub = new SignalingHub({ ...directHubOptions(4, null), rateScale: 50 });
    const code = encodeRoomCode();
    const bridge = await NostrHostBridge.start(hub, { code, relays: URLS, connect: relays.connect, clock: systemClock });
    cleanup.push(() => bridge.close());
    const socket = (extra = {}) => {
      const s = new NostrSocket({ code, relays: URLS, connect: relays.connect, clock: systemClock, openEveryMs: 200, ...extra });
      cleanup.push(() => s.close());
      return s;
    };
    return { hub, code, bridge, socket };
  }

  it("a joiner reaches the hub: hello, create, join; keep-alive ping is answered locally", async () => {
    const relays = new FakeRelays();
    const { hub, bridge, socket } = await setup(relays);
    const a = socket();
    const sa = speak(a);
    await new Promise<void>((r) => (a.onopen = () => r()));
    expect(a.readyState).toBe(1);
    sa.send({ t: "hello", proto: "lk1", gameId: "g", netVersion: "1", name: "A" });
    expect((await sa.next("welcome")).t).toBe("welcome");
    sa.send({ t: "create", name: "L", maxPlayers: 4, mode: "raw" });
    expect((await sa.next("lobby")).you).toBe(1);

    const pingsBefore = hub.metrics.render().match(/type="ping"[^\n]* (\d+)/)?.[1];
    sa.send({ t: "ping", n: 7 });
    expect(await sa.next("pong")).toMatchObject({ n: 7 });
    expect(hub.metrics.render().match(/type="ping"[^\n]* (\d+)/)?.[1]).toBe(pingsBefore); // never reached the hub

    const b = socket();
    const sb = speak(b);
    sb.send({ t: "hello", proto: "lk1", gameId: "g", netVersion: "1", name: "B" }); // queued before open? ignored until open
    await new Promise<void>((r) => (b.onopen = () => r()));
    sb.send({ t: "hello", proto: "lk1", gameId: "g", netVersion: "1", name: "B" });
    await sb.next("welcome");
    sb.send({ t: "join" });
    expect((await sb.next("lobby")).you).toBe(2);
    expect((await sa.next("peer_joined")).peer.peerId).toBe(2);
    expect(bridge.peerCount).toBe(2);

    // b leaves: the hub tells a
    b.close();
    expect((await sa.next("peer_left")).peerId).toBe(2);
    await until(() => bridge.peerCount === 1, "bridge forgets b");
  }, 20000);

  it("survives a lossy relay network (resends), and a relay restart", async () => {
    const relays = new FakeRelays();
    relays.loss = 0.3;
    const { socket } = await setup(relays);
    const a = socket();
    const sa = speak(a);
    await new Promise<void>((r) => (a.onopen = () => r()));
    sa.send({ t: "hello", proto: "lk1", gameId: "g", netVersion: "1", name: "A" });
    await sa.next("welcome", 15000);
    relays.drop(URLS[0]);
    sa.send({ t: "create", name: "L", maxPlayers: 4, mode: "raw" });
    expect((await sa.next("lobby", 15000)).you).toBe(1);
  }, 40000);

  it("fails with a reason when no relay is reachable, or the host never answers", async () => {
    const relays = new FakeRelays();
    for (const u of URLS) relays.down.add(u);
    const { socket } = await setup(relays);
    const a = socket({ relayTimeoutMs: 300 });
    const err = await new Promise<string>((r) => (a.onerror = () => r(a.failure)));
    expect(err).toBe("no Nostr relay reachable");
    expect(a.readyState).toBe(3);

    const quiet = new FakeRelays();
    const b = new NostrSocket({ code: encodeRoomCode(), relays: URLS, connect: quiet.connect, clock: systemClock, openTimeoutMs: 400, openEveryMs: 100 });
    await new Promise<void>((r) => (b.onerror = () => r()));
    expect(b.failure).toMatch(/did not answer/);
  });

  it("a wrong code is never answered", async () => {
    const relays = new FakeRelays();
    const { socket } = await setup(relays);
    const wrong = new NostrSocket({ code: encodeRoomCode(), relays: URLS, connect: relays.connect, clock: systemClock, openTimeoutMs: 500, openEveryMs: 100 });
    cleanup.push(() => wrong.close());
    await new Promise<void>((r) => (wrong.onerror = () => r()));
    expect(wrong.readyState).toBe(3);
    expect(socket).toBeDefined();
  });
});

describe("hostDirect + joinDirect with a Nostr code (real WebRTC on loopback, fake relays)", () => {
  const mk = (name: string, relays: FakeRelays) =>
    new OneLobby({ gameId: "com.onelobby.nostrtest", netVersion: "1", lobbyServer: "", mode: "raw", displayName: name, rememberSeat: false, advanced: { linkFactory: links, nostrConnect: relays.connect } });

  it("the Nostr code is the joinCode, the IP code is directCode; both kinds of joiner meet in one lobby", async () => {
    const relays = new FakeRelays();
    const port = await freePort();
    const lines: string[] = [];
    const host = await hostDirect(mk("Host", relays), { port, openPort: false, nostr: { relays: URLS, stun: [] }, log: (l) => lines.push(l), maxPlayers: 3 });
    cleanup.push(() => host.leave());
    expect(host.joinCodeKind).toBe("nostr");
    expect("room" in decodeJoinCode(host.joinCode)).toBe(true);
    expect(host.directCode).not.toBe(host.joinCode);
    expect(host.directCodeKind).not.toBe("none");
    expect("ip" in decodeJoinCode(host.directCode)).toBe(true);
    expect(host.directHub.joinInfo).toMatchObject({ joinCode: host.joinCode, joinCodeKind: "nostr", directCode: host.directCode });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(host.directHostLog);
    expect(lines[0]).toContain(`code ${host.joinCode} (Nostr)`);
    expect(lines[0]).toMatch(/; ip code \S+ \((Internet|SameNetwork)\); port mapping off; nostr 2\/2 relays$/);

    const ann = await mk("Ann", relays).joinDirect(host.joinCode, { nostrRelays: URLS, stun: [] });
    cleanup.push(() => ann.leave());
    expect(ann.joinCode).toBe(host.joinCode);
    await ann.ready;
    const bob = await mk("Bob", relays).joinDirect(`127.0.0.1:${port}`);
    cleanup.push(() => bob.leave());
    await bob.ready;
    await until(() => host.peers.length === 3 && ann.peers.length === 3, "everyone sees everyone");

    const got: string[] = [];
    host.on("message", (from, bytes) => got.push(`${from}:${new TextDecoder().decode(bytes)}`));
    ann.send(host.localPeerId, new TextEncoder().encode("over nostr"));
    await until(() => got.length > 0, "message from the Nostr joiner");
    expect(got[0]).toBe(`${ann.localPeerId}:over nostr`);
    const back: string[] = [];
    ann.on("message", (_f, bytes) => back.push(new TextDecoder().decode(bytes)));
    host.broadcast(new TextEncoder().encode("hi all"));
    await until(() => back.length > 0, "broadcast reaches the Nostr joiner");
  }, 40000);

  it("rejoinDirect with the Nostr code takes the seat back", async () => {
    const relays = new FakeRelays();
    const host = await hostDirect(mk("Host", relays), { port: await freePort(), openPort: false, nostr: { relays: URLS, stun: [] }, log: false });
    cleanup.push(() => host.leave());
    const old = await mk("Ann", relays).joinDirect(host.joinCode, { nostrRelays: URLS, stun: [] });
    await old.ready;
    const seat = old.localPeerId;
    const token = old.resumeToken;
    const back = await mk("Ann", relays).rejoinDirect(host.joinCode, token, { nostrRelays: URLS, stun: [] });
    cleanup.push(() => back.leave(), () => old.leave());
    expect(back.localPeerId).toBe(seat);
    await back.ready;
  }, 40000);

  it("nostr: false keeps IP codes only", async () => {
    const relays = new FakeRelays();
    const lines: string[] = [];
    const host = await hostDirect(mk("Host", relays), { port: await freePort(), openPort: false, nostr: false, log: (l) => lines.push(l) });
    cleanup.push(() => host.leave());
    expect(host.joinCode).toBe(host.directCode);
    expect(host.joinCodeKind).toBe(host.directCodeKind);
    expect(host.directHub.nostr).toBeNull();
    expect(lines[0]).not.toContain("nostr");
    expect(relays.sockets).toHaveLength(0);
  });

  it("no relay reachable: the line says so and the host keeps hosting by IP", async () => {
    const relays = new FakeRelays();
    for (const u of URLS) relays.down.add(u);
    const lines: string[] = [];
    const t0 = Date.now();
    const host = await hostDirect(mk("Host", relays), { port: await freePort(), openPort: false, nostr: { relays: URLS }, log: (l) => lines.push(l) });
    cleanup.push(() => host.leave());
    expect(Date.now() - t0).toBeGreaterThan(9000); // waited the 10 s for a relay
    expect(lines[0]).toMatch(/; nostr: no relay reachable$/);
    // the IP code is the code meanwhile
    expect(host.joinCode).toBe(host.directCode);
    expect(host.joinCodeKind).toBe(host.directCodeKind);
    const bob = await mk("Bob", relays).joinDirect(host.directCode, {});
    cleanup.push(() => bob.leave());
    await bob.ready;
    // a relay comes back: the Nostr code takes over and joinCodeChanged fires
    const changed: string[] = [];
    host.on("joinCodeChanged", (code, kind) => changed.push(`${kind}:${code}`));
    relays.down.clear();
    await until(() => host.joinCodeKind === "nostr", "Nostr code after a relay returns", 15000);
    expect(changed).toHaveLength(1);
    expect(lines.at(-1)).toMatch(/; nostr [12]\/2 relays$/);
    expect("room" in decodeJoinCode(host.joinCode)).toBe(true);
  }, 60000);
});
