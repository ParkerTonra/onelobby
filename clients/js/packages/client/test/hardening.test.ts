/**
 * Hub and client hardening (spec/signaling.md "Direct hubs relay only to or from the host", "Clients accept offers only
 * from the host", the rate-limit table; spec/nostr-signaling.md "Outbound queue", "New sessions", "Bans"; DESIGN s.12).
 */
import { createConnection, type Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { SignalingHub, defaultHubOptions, directHubOptions } from "../src/direct/hub.js";
import { DirectHubHost } from "../src/direct/hub-host.js";
import { hostDirect } from "../src/direct/index.js";
import { ReliableLink, MAX_OUT_BYTES, MAX_OUT_FRAMES, type OutFrame } from "../src/nostr/link.js";
import { NostrHostBridge, MAX_NEW_SESSIONS, NEW_SESSION_WINDOW_MS } from "../src/nostr/host.js";
import { NostrSocket } from "../src/nostr/socket.js";
import { encodeRoomCode } from "../src/joincode.js";
import { encodeMessage } from "../src/codec.js";
import { systemClock, type Clock } from "../src/clock.js";
import { settle } from "../src/testing.js";
import { OneLobby } from "../src/onelobby.js";
import { webRtcLinkFactoryFor } from "../src/webrtc.js";
import { FakeRelays } from "./fake-relay.js";
import { freePort, loopbackRtc, rig } from "./helpers.js";
import { ManualClock } from "../src/testing.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
const until = async (cond: () => boolean, what: string, ms = 10000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

// ---- a hub driven in memory ---------------------------------------------------------------------------------------

function mk(hub: SignalingHub) {
  const sock = (ip: string, name = "p") => {
    const inbox: any[] = [];
    const closes: [number | undefined, string | undefined][] = [];
    const s = hub.connect(ip, (t) => inbox.push(JSON.parse(t)), (c, r) => closes.push([c, r]));
    if (s) hub.receive(s, JSON.stringify({ t: "hello", proto: "lk1", gameId: "g", netVersion: "1", name }));
    return { s, inbox, closes, send: (m: object) => s && hub.receive(s, JSON.stringify(m)) };
  };
  return sock;
}
const wide = () => ({ ...directHubOptions(8, null), maxPeers: 1000 });
const create = { t: "create", name: "L", maxPlayers: 8, visibility: "unlisted", mode: "raw", tickRate: 20, lateJoin: true, meta: {} };
const lastError = (inbox: any[]) => inbox.filter((m) => m.t === "error").at(-1);

describe("hub: signals in a direct lobby go to or from the host only", () => {
  it("joiner to joiner is bad_request and nothing is relayed; host both ways works", () => {
    const hub = new SignalingHub(directHubOptions(8, null), { now: () => 1_700_000_000_000 });
    const sock = mk(hub);
    const h = sock("10.0.0.1");
    h.send(create);
    const a = sock("10.0.0.2");
    a.send({ t: "join" });
    const b = sock("10.0.0.3");
    b.send({ t: "join" });
    a.send({ t: "signal", to: 3, sdp: { type: "offer", sdp: "x" } });
    expect(lastError(a.inbox)).toMatchObject({ code: "bad_request" });
    expect(b.inbox.some((m) => m.t === "signal")).toBe(false);
    a.send({ t: "signal", to: 1, ice: {} });
    h.send({ t: "signal", to: 3, ice: {} });
    expect(h.inbox.filter((m) => m.t === "signal")).toHaveLength(1);
    expect(b.inbox.filter((m) => m.t === "signal")).toHaveLength(1);
  });

  it("a server hub (migration) still relays between two joiners", () => {
    const hub = new SignalingHub({ ...defaultHubOptions(), rateScale: 20 }, { now: () => 1_700_000_000_000 });
    const sock = mk(hub);
    const h = sock("10.0.0.1");
    h.send(create);
    const code = h.inbox.find((m) => m.t === "lobby").code;
    const a = sock("10.0.0.2");
    a.send({ t: "join", code });
    const b = sock("10.0.0.3");
    b.send({ t: "join", code });
    a.send({ t: "signal", to: 3, ice: {} });
    expect(b.inbox.filter((m) => m.t === "signal")).toHaveLength(1);
  });
});

describe("hub: socket cap per IP and the signal limit under disableIpLimits", () => {
  it("the 33rd socket from one address gets rate_limited max_sockets and is closed 1008 too_many_sockets", () => {
    const hub = new SignalingHub(wide(), { now: () => 1_700_000_000_000 });
    const sock = mk(hub);
    for (let i = 0; i < 32; i++) expect(sock("127.0.0.1").s).not.toBeNull();
    const extra = sock("127.0.0.1");
    expect(extra.s).toBeNull();
    expect(extra.closes).toEqual([[1008, "too_many_sockets"]]);
    expect(lastError(extra.inbox)).toMatchObject({ code: "rate_limited", data: { reason: "max_sockets" } });
    expect(sock("127.0.0.2").s).not.toBeNull(); // another address is fine
  });

  it("a closed socket frees its place; disableIpLimits lifts the cap", () => {
    const hub = new SignalingHub(wide(), { now: () => 1_700_000_000_000 });
    const sock = mk(hub);
    const first = sock("1.2.3.4");
    for (let i = 0; i < 31; i++) sock("1.2.3.4");
    expect(sock("1.2.3.4").s).toBeNull();
    hub.disconnect(first.s!);
    expect(sock("1.2.3.4").s).not.toBeNull();
    const open = new SignalingHub({ ...wide(), disableIpLimits: true }, { now: () => 1_700_000_000_000 });
    for (let i = 0; i < 100; i++) expect(mk(open)("1.2.3.4").s).not.toBeNull();
  });

  it("disableIpLimits no longer turns off the signal rate limit", () => {
    const hub = new SignalingHub({ ...directHubOptions(8, null), disableIpLimits: true }, { now: () => 1_700_000_000_000 });
    const sock = mk(hub);
    const h = sock("10.0.0.1");
    h.send(create);
    const a = sock("10.0.0.2");
    a.send({ t: "join" });
    for (let i = 0; i < 20; i++) h.send({ t: "signal", to: 2, ice: {} });
    expect(lastError(h.inbox)).toBeUndefined();
    h.send({ t: "signal", to: 2, ice: {} });
    expect(lastError(h.inbox)).toMatchObject({ code: "rate_limited" });
  });
});

describe("hub: signals to a Nostr-bridged target are limited to 10/s per sender", () => {
  it("10 pass, the 11th is rate_limited; a plain target still gets 20", () => {
    const hub = new SignalingHub(directHubOptions(8, null), { now: () => 1_700_000_000_000 });
    const sock = mk(hub);
    const h = sock("local");
    h.send(create);
    const n = sock("nostr:0123456789abcdef");
    n.send({ t: "join" });
    const t = sock("10.0.0.5");
    t.send({ t: "join" });
    for (let i = 0; i < 10; i++) h.send({ t: "signal", to: 2, ice: {} });
    expect(lastError(h.inbox)).toBeUndefined();
    h.send({ t: "signal", to: 2, ice: {} });
    expect(lastError(h.inbox)).toMatchObject({ code: "rate_limited" });
    expect(n.inbox.filter((m) => m.t === "signal")).toHaveLength(10);
    for (let i = 0; i < 20; i++) h.send({ t: "signal", to: 3, ice: {} });
    expect(t.inbox.filter((m) => m.t === "signal")).toHaveLength(20);
  });
});

describe("hub: a Nostr kick bans the pubkey and the link's address", () => {
  it("the kicked key's address bans a fresh key whose link comes from the same IP", () => {
    const hub = new SignalingHub(directHubOptions(8, null), { now: () => 1_700_000_000_000 });
    const sock = mk(hub);
    const h = sock("local");
    h.send(create);
    const bad = sock("nostr:aaaaaaaaaaaaaaaa");
    bad.send({ t: "join" });
    hub.reportLinkAddress(2, "203.0.113.9");
    h.send({ t: "kick", peerId: 2 });
    expect(lastError(bad.inbox)).toMatchObject({ code: "kicked" });
    // same key again: refused by key
    const again = sock("nostr:aaaaaaaaaaaaaaaa");
    again.send({ t: "join" });
    expect(lastError(again.inbox)).toMatchObject({ code: "kicked" });
    // a new key: joins (nothing known yet) ...
    const fresh = sock("nostr:bbbbbbbbbbbbbbbb");
    fresh.send({ t: "join" });
    expect(fresh.inbox.some((m) => m.t === "lobby")).toBe(true);
    // ... until its link resolves to the banned address
    hub.reportLinkAddress(3, "203.0.113.9");
    expect(lastError(fresh.inbox)).toMatchObject({ code: "kicked" });
    expect(fresh.closes).toHaveLength(1);
    expect(h.inbox.filter((m) => m.t === "peer_left" && m.peerId === 3)).toHaveLength(1);
  });

  it("a kick without a known link address bans the key only; a different address is untouched", () => {
    const hub = new SignalingHub(directHubOptions(8, null), { now: () => 1_700_000_000_000 });
    const sock = mk(hub);
    const h = sock("local");
    h.send(create);
    sock("nostr:aaaaaaaaaaaaaaaa").send({ t: "join" });
    h.send({ t: "kick", peerId: 2 });
    const other = sock("nostr:cccccccccccccccc");
    other.send({ t: "join" });
    hub.reportLinkAddress(3, "198.51.100.1");
    expect(other.inbox.some((m) => m.t === "error")).toBe(false);
  });
});

// ---- the Nostr link queue -----------------------------------------------------------------------------------------

describe("ReliableLink outbound queue", () => {
  function linkWith() {
    const clock = new ManualClock();
    const frames: OutFrame[] = [];
    let dead = false;
    const link = new ReliableLink({ clock, send: (f) => frames.push(f), deliver: () => {}, onPeerClose: () => {}, onDead: () => (dead = true) });
    const shipped = () => frames.filter((f) => f.type === "data").reduce((n, f) => n + (f.msgs?.length ?? 0), 0);
    return { clock, link, frames, shipped, dead: () => dead };
  }

  it("keeps at most 128 frames' worth unacknowledged; the excess is dropped and the link stays up", () => {
    const { clock, link, shipped, dead } = linkWith();
    for (let i = 0; i < 400; i++) link.send(`{"t":"x","n":${i}}`);
    clock.advance(100);
    expect(shipped()).toBe(MAX_OUT_FRAMES);
    expect(link.closed).toBe(false);
    expect(dead()).toBe(false);
  });

  it("keeps at most 256 KiB, counted over queued and unacknowledged texts", () => {
    const { clock, link, shipped } = linkWith();
    const big = "x".repeat(40_000);
    for (let i = 0; i < 12; i++) link.send(big);
    clock.advance(100);
    expect(shipped()).toBe(Math.floor(MAX_OUT_BYTES / 40_000));
    // after an ack the room comes back
    link.receive({ v: 1, type: "beat", from: "a", to: "b", seq: 0, ack: 99 });
    link.send(big);
    clock.advance(100);
    expect(shipped()).toBe(Math.floor(MAX_OUT_BYTES / 40_000) + 1);
  });
});

// ---- Nostr bridge: new sessions per window --------------------------------------------------------------------------

describe("Nostr host bridge: at most 8 new sessions per 10 s", () => {
  it("excess joiners are left waiting (their open repeats) and get in when the window frees", async () => {
    const relays = new FakeRelays();
    const URLS = ["wss://r1.test"];
    let skew = 0;
    const clock: Clock = { ...systemClock, now: () => systemClock.now() + skew, setInterval: systemClock.setInterval, setTimeout: systemClock.setTimeout };
    const hub = new SignalingHub({ ...directHubOptions(40, null), rateScale: 50 });
    const code = encodeRoomCode();
    const bridge = await NostrHostBridge.start(hub, { code, relays: URLS, connect: relays.connect, clock });
    cleanup.push(() => bridge.close());
    const socks = Array.from({ length: MAX_NEW_SESSIONS + 3 }, () => {
      const s = new NostrSocket({ code, relays: URLS, connect: relays.connect, clock: systemClock, openEveryMs: 100, openTimeoutMs: 60_000 });
      cleanup.push(() => s.close());
      return s;
    });
    await until(() => bridge.peerCount === MAX_NEW_SESSIONS, "eight sessions");
    await new Promise((r) => setTimeout(r, 600));
    expect(bridge.peerCount).toBe(MAX_NEW_SESSIONS);
    expect(socks.filter((s) => s.readyState === 1)).toHaveLength(MAX_NEW_SESSIONS);
    expect(socks.filter((s) => s.readyState === 0)).toHaveLength(3); // still trying, not failed
    skew = NEW_SESSION_WINDOW_MS + 1;
    await until(() => socks.every((s) => s.readyState === 1), "the rest get in after the window");
    expect(bridge.peerCount).toBe(MAX_NEW_SESSIONS + 3);
  }, 30000);
});

// ---- hub host over TCP: backpressure and the socket cap --------------------------------------------------------------

function rawWs(port: number): Promise<{ sock: Socket; send: (m: object) => void; chunks: Buffer[] }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    const chunks: Buffer[] = [];
    let upgraded = false;
    sock.on("error", reject);
    sock.on("connect", () => {
      const key = randomBytes(16).toString("base64");
      sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.on("data", (b) => {
      if (!upgraded) {
        if (b.indexOf("\r\n\r\n") < 0) return;
        upgraded = true;
        const send = (m: object) => {
          const payload = Buffer.from(JSON.stringify(m));
          const mask = randomBytes(4);
          const head = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]);
          const body = Buffer.from(payload);
          for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
          sock.write(Buffer.concat([head, mask, body]));
        };
        resolve({ sock, send, chunks });
        const rest = b.subarray(b.indexOf("\r\n\r\n") + 4);
        if (rest.length) chunks.push(Buffer.from(rest));
        return;
      }
      chunks.push(b);
    });
  });
}
void createHash;

describe("hub host over TCP", () => {
  it("closes a reader that stops reading once more than 1 MiB is pending (1008 backpressure)", async () => {
    const host = await DirectHubHost.listen(0, { ...directHubOptions(4, null), rateScale: 400, maxMessageBytes: 16 * 1024 }, { host: "127.0.0.1" });
    cleanup.push(() => host.close());
    const hostSock = host.connectLocal();
    const got: any[] = [];
    hostSock.onmessage = (e) => got.push(JSON.parse(String(e.data)));
    await until(() => hostSock.readyState === 1, "local open");
    hostSock.send(JSON.stringify({ t: "hello", proto: "lk1", gameId: "g", netVersion: "1", name: "H" }));
    hostSock.send(JSON.stringify({ t: "create", name: "L", maxPlayers: 4, mode: "raw" }));
    const stuck = await rawWs(host.port);
    cleanup.push(() => void stuck.sock.destroy());
    stuck.send({ t: "hello", proto: "lk1", gameId: "g", netVersion: "1", name: "S" });
    stuck.send({ t: "join" });
    await until(() => got.some((m) => m.t === "peer_joined"), "joined");
    stuck.sock.pause(); // never reads again
    const sdp = "v=0\r\n" + "a=x:".padEnd(12_000, "y");
    let closed = false;
    stuck.sock.on("close", () => (closed = true));
    for (let i = 0; i < 4000 && !closed && host.connectionCount > 0; i++) {
      hostSock.send(JSON.stringify({ t: "signal", to: 2, sdp: { type: "offer", sdp } }));
      if (i % 50 === 0) await new Promise((r) => setTimeout(r, 1));
    }
    await until(() => host.connectionCount === 0, "the stuck reader is cut off", 8000);
    stuck.sock.resume();
    await until(() => closed, "the socket is closed", 8000);
  }, 30000);

  it("the 33rd socket from one address is closed 1008 too_many_sockets", { timeout: 20000 }, async () => {
    const host = await DirectHubHost.listen(0, wide(), { host: "127.0.0.1" });
    cleanup.push(() => host.close());
    const socks: Socket[] = [];
    for (let i = 0; i < 32; i++) {
      const w = await rawWs(host.port);
      socks.push(w.sock);
      cleanup.push(() => void w.sock.destroy());
    }
    await until(() => host.hub.socketCount === 32, "32 sockets registered");
    const extra = await rawWs(host.port);
    cleanup.push(() => void extra.sock.destroy());
    await until(() => Buffer.concat(extra.chunks).toString("latin1").includes("too_many_sockets"), "close reason");
    expect(host.hub.socketCount).toBe(32);
  });
});

// ---- the client: who may dial us -------------------------------------------------------------------------------------

describe("lobby: SDP offers and host traffic", () => {
  async function trio() {
    const r = rig();
    const la = await r.make("alice", { mode: "raw" }).host({ name: "t", maxPlayers: 4 });
    const lb = await r.make("bob", { mode: "raw" }).join(la.code);
    const lc = await r.make("cara", { mode: "raw" }).join(la.code);
    await settle();
    return { r, la, lb, lc };
  }
  const offer = { sdp: { type: "offer" as const, sdp: "mem-none" } };

  it("while the link to the host is open, a roster member's offer is not answered; a stranger's never is", async () => {
    const { lb, lc } = await trio();
    const b = lb as any;
    const before = lb.linkCount;
    await b.onSignal(lc.localPeerId, offer);
    await b.onSignal(99, offer);
    expect(lb.linkCount).toBe(before);
  });

  it("a held offer is answered when the host turns out to be lost", async () => {
    const { r, la, lb, lc } = await trio();
    (lb as any).onSignal(lc.localPeerId, offer);
    await la.leave();
    r.clock.advance(5000);
    await settle();
    expect(lb.isHost).toBe(true);
    expect(lc.hostPeerId).toBe(lb.localPeerId);
  });

  it("raw data over a link whose peer is not the host is not handled as host traffic", async () => {
    const { lb, lc } = await trio();
    const got: [number, string][] = [];
    lb.on("message", (from, bytes) => got.push([from, new TextDecoder().decode(bytes)]));
    // cara sends bob a raw frame claiming to relay from peer 1 (the host)
    (lb as any).onData(lc.localPeerId, "reliable", encodeMessage({ type: "raw", bytes: new TextEncoder().encode("fake") }, 1));
    expect(got).toEqual([]);
  });

  it("a host_claim must name its own sender", async () => {
    const { lb, lc } = await trio();
    const before = lb.hostPeerId;
    // cara claims epoch 9 for bob (2) instead of herself
    (lb as any).onData(lc.localPeerId, "reliable", encodeMessage({ type: "host_claim", epoch: 9, hostId: lb.localPeerId, tick: 0 }));
    expect(lb.hostPeerId).toBe(before);
    expect(lb.isHost).toBe(false);
  });
});

describe("direct lobby: a joiner is never dialled by another joiner", () => {
  it("an offer from a non-host peer is dropped and its link count stays", async () => {
    const inner = webRtcLinkFactoryFor(loopbackRtc(RTCPeerConnection) as unknown as typeof globalThis.RTCPeerConnection);
    const created: number[] = [];
    const rtc = { create: (o: Parameters<typeof inner.create>[0]) => (created.push(o.remoteId), inner.create(o)) };
    const mkKit = (n: string) => new OneLobby({ gameId: "com.onelobby.hardening", netVersion: "1", lobbyServer: "", mode: "raw", displayName: n, rememberSeat: false, advanced: { linkFactory: rtc } });
    const port = await freePort();
    const host = await hostDirect(mkKit("H"), { bindHost: "127.0.0.1", port, openPort: false, nostr: false, log: false });
    cleanup.push(() => host.leave());
    const ann = await mkKit("A").joinDirect(`127.0.0.1:${port}`);
    cleanup.push(() => ann.leave());
    const bob = await mkKit("B").joinDirect(`127.0.0.1:${port}`);
    cleanup.push(() => bob.leave());
    await ann.ready;
    await bob.ready;
    await until(() => ann.peers.length === 3, "ann sees bob");
    const before = created.length;
    await (ann as any).onSignal(bob.localPeerId, { sdp: { type: "offer", sdp: "v=0\r\n" } });
    expect(created.length).toBe(before); // no link was even created for bob
  }, 30000);
});

describe("Nostr kick bans the address behind the key (real WebRTC on loopback, fake relays)", () => {
  it("a kicked joiner that comes back with a fresh key is removed once its link address is known", async () => {
    const relays = new FakeRelays();
    const URLS = ["wss://r1.test"];
    const rtc = webRtcLinkFactoryFor(loopbackRtc(RTCPeerConnection) as unknown as typeof globalThis.RTCPeerConnection);
    const mkKit = (n: string) => new OneLobby({ gameId: "com.onelobby.hardening", netVersion: "1", lobbyServer: "", mode: "raw", displayName: n, rememberSeat: false, advanced: { linkFactory: rtc, nostrConnect: relays.connect } });
    const host = await hostDirect(mkKit("H"), { bindHost: "127.0.0.1", port: await freePort(), openPort: false, nostr: { relays: URLS, stun: [] }, log: false });
    cleanup.push(() => host.leave());
    const ann = await mkKit("A").joinDirect(host.joinCode, { nostrRelays: URLS, stun: [] });
    cleanup.push(() => ann.leave());
    await ann.ready;
    const ended: string[] = [];
    ann.on("sessionEnded", (r) => ended.push(r));
    await new Promise((r) => setTimeout(r, 1500)); // the link's stats settle
    await host.kick(ann.localPeerId);
    await until(() => ended.length > 0, "ann removed");
    expect(ended[0]).toBe("kicked");
    // a fresh key (a new kit opens a new Nostr session) from the same address
    const lobby = await mkKit("A2").joinDirect(host.joinCode, { nostrRelays: URLS, stun: [] });
    cleanup.push(() => lobby.leave());
    const gone: string[] = [];
    lobby.on("sessionEnded", (r) => gone.push(r));
    await until(() => gone.length > 0, "the fresh key is removed once its link address resolves", 15000);
    expect(["kicked", "host_left"]).toContain(gone[0]); // the host closes its data link as the hub removes the seat
  }, 60000);
});
