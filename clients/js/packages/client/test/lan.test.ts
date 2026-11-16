import { afterEach, describe, expect, it, vi } from "vitest";
import dgram from "node:dgram";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { OneLobby } from "../src/onelobby.js";
import { webRtcLinkFactoryFor } from "../src/webrtc.js";
import { hostDirect, isLoopbackHost } from "../src/direct/index.js";
import {
  LanAnswerer, LanFinder, LanHost, LAN_DEFAULT_PORT, LAN_MAX_DATAGRAM, LAN_RATE_PER_SOURCE, LAN_RATE_TOTAL,
  decodeLanAnswer, decodeLanQuestion, encodeLanAnswer, encodeLanQuestion, lanSourceClass, type LanHostInfo, type LanUdp,
} from "../src/lan.js";
import { freePort, loopbackRtc } from "./helpers.js";
import { hex, specJson, unhex } from "./spec.js";

const V = specJson("vectors/lan-discovery.json");
const links = webRtcLinkFactoryFor(loopbackRtc(RTCPeerConnection) as unknown as typeof globalThis.RTCPeerConnection);

const until = async (cond: () => boolean, what: string, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A UDP port nobody holds right now (127.0.0.1 only). */
async function freeUdpPort(): Promise<number> {
  const s = dgram.createSocket("udp4");
  await new Promise<void>((r) => s.bind(0, "127.0.0.1", () => r()));
  const p = s.address().port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanup.splice(0).reverse()) await c();
});

/** Sockets the LAN code opened: it asks node:dgram for an exclusive socket with an options object (nothing else here does). */
const lanSockets = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => typeof c[0] === "object").length;

const info = (o: Partial<LanHostInfo> = {}): LanHostInfo => ({ lobbyName: "Sam's game", hostName: "Sam", players: 1, maxPlayers: 4, password: false, port: 47810, ...o });

describe("LAN discovery vectors", () => {
  it("encodes and decodes every question", () => {
    for (const q of V.questions) {
      expect(hex(encodeLanQuestion(unhex(q.nonce), q.gameId)), q.name).toBe(q.hex);
      const d = decodeLanQuestion(unhex(q.hex))!;
      expect(hex(d.nonce)).toBe(q.nonce);
      expect(d.gameId).toBe(q.gameId);
    }
  });

  it("encodes and decodes every answer", () => {
    for (const a of V.answers) {
      const f = a.fields;
      expect(hex(encodeLanAnswer({ ...f, nonce: unhex(f.nonce) })), a.name).toBe(a.hex);
      const d = decodeLanAnswer(unhex(a.hex))!;
      expect({ ...d, nonce: hex(d.nonce) }, a.name).toEqual(f);
      expect(unhex(a.hex).length).toBeLessThanOrEqual(LAN_MAX_DATAGRAM);
    }
  });

  it("drops every bad question and every bad answer", () => {
    for (const d of V.dropQuestions) expect(decodeLanQuestion(unhex(d.hex)), d.name).toBeNull();
    for (const d of V.dropAnswers) expect(decodeLanAnswer(unhex(d.hex)), d.name).toBeNull();
  });

  it("classes source addresses", () => {
    for (const s of V.sourceClasses) expect(lanSourceClass(s.ip), s.ip).toBe(s.class);
  });

  it("applies the host rules", () => {
    for (const r of V.hostRules) {
      const sent: Uint8Array[] = [];
      const a = new LanAnswerer({ gameId: r.ownGameId, netVersion: "3", info: () => info(), reply: (b) => sent.push(b) });
      const got = a.handle(unhex(r.question), r.source, 50000);
      expect(got, r.name).toBe(r.expect);
      expect(sent.length, r.name).toBe(r.expect === "answer" ? 1 : 0);
    }
  });

  it("applies the finder rules", () => {
    for (const r of V.finderRules) {
      const f = new LanFinder({ gameId: r.ownGameId, netVersion: r.ownNetVersion });
      for (const n of r.sentNonces) f.rememberNonce(n);
      expect(f.receive(unhex(r.answer), r.source, 47840), r.name).toBe(r.expect);
      expect(f.games.length, r.name).toBe(r.expect === "ok" || r.expect === "other_version" ? 1 : 0);
      if (r.expect === "other_version") expect(f.games[0].sameVersion).toBe(false);
    }
  });
});

describe("the host's limits", () => {
  const q = (n: number, gameId = "g") => encodeLanQuestion(Uint8Array.from([n, 0, 0, 0, 0, 0, 0, 0]), gameId);

  it("answers at most the per-source number in a window", () => {
    let t = 1000;
    const sent: Uint8Array[] = [];
    const a = new LanAnswerer({ gameId: "g", netVersion: "1", info: () => info(), reply: (b) => sent.push(b), now: () => t });
    for (let i = 0; i < 200; i++) a.handle(q(i), "192.168.1.9", 5000);
    expect(sent.length).toBe(LAN_RATE_PER_SOURCE);
    expect(a.stats.rate_limited).toBe(200 - LAN_RATE_PER_SOURCE);
    t += 1000;
    a.handle(q(250), "192.168.1.9", 5000);
    expect(sent.length).toBe(LAN_RATE_PER_SOURCE + 1);
  });

  it("answers at most the total number in a window, over many sources", () => {
    const sent: Uint8Array[] = [];
    const a = new LanAnswerer({ gameId: "g", netVersion: "1", info: () => info(), reply: (b) => sent.push(b), now: () => 5 });
    for (let i = 0; i < 200; i++) a.handle(q(1), `10.0.${i >> 8}.${i & 255}`, 5000);
    expect(sent.length).toBe(LAN_RATE_TOTAL);
  });

  it("answers the same question once (a finder asks two broadcast addresses)", () => {
    const sent: Uint8Array[] = [];
    const a = new LanAnswerer({ gameId: "g", netVersion: "1", info: () => info(), reply: (b) => sent.push(b) });
    expect(a.handle(q(7), "192.168.1.9", 5000)).toBe("answer");
    expect(a.handle(q(7), "192.168.1.9", 5000)).toBe("duplicate");
    expect(sent.length).toBe(1);
  });

  it("never sends more than 512 bytes, whatever the question's size", () => {
    const sent: Uint8Array[] = [];
    const a = new LanAnswerer({ gameId: "g", netVersion: "1", info: () => info({ lobbyName: "x".repeat(500), hostName: "\u{1F41C}".repeat(300) }), reply: (b) => sent.push(b) });
    a.handle(q(1), "127.0.0.1", 5000);
    a.handle(new Uint8Array(4000), "127.0.0.1", 5000);
    a.handle(new Uint8Array(512).fill(0x4f), "127.0.0.1", 5000);
    expect(sent.length).toBe(1);
    expect(sent[0].length).toBeLessThanOrEqual(LAN_MAX_DATAGRAM);
    expect(decodeLanAnswer(sent[0])!.lobbyName.length).toBeLessThanOrEqual(24);
  });

  it("answers nothing before a lobby is open", () => {
    const a = new LanAnswerer({ gameId: "g", netVersion: "1", info: () => null, reply: () => expect.fail("sent") });
    expect(a.handle(q(1), "127.0.0.1", 5000)).toBe("no_lobby");
  });
});

describe("host and finder on 127.0.0.1", () => {
  async function pair(opts: { info: () => LanHostInfo | null; netVersion?: string; finderVersion?: string; gameId?: string; finderGame?: string }) {
    const port = await freeUdpPort();
    const logs: string[] = [];
    const host = new LanHost({ gameId: opts.gameId ?? "g", netVersion: opts.netVersion ?? "1", info: opts.info, port, bindHost: "127.0.0.1", log: (l) => logs.push(l) });
    expect(await host.start()).toBe(true);
    cleanup.push(() => host.close());
    const finder = new LanFinder({
      gameId: opts.finderGame ?? opts.gameId ?? "g", netVersion: opts.finderVersion ?? opts.netVersion ?? "1", targets: ["127.0.0.1"], port,
      askIntervalMs: 100, minGapMs: 40, rowTimeoutMs: 400,
    });
    cleanup.push(() => finder.stop());
    return { host, finder, port, logs };
  }

  it("shows a row with the right fields, changes with the lobby, and drops when the host closes", async () => {
    let now = info({ players: 1, password: true, lobbyName: "Ants!", hostName: "Sam", port: 47812 });
    const { host, finder } = await pair({ info: () => now });
    const changes: number[] = [];
    finder.on("changed", (g) => changes.push(g.length));
    expect(await finder.start()).toBe("running");
    await until(() => finder.games.length === 1, "first row");
    const row = finder.games[0];
    expect(row).toMatchObject({ address: "127.0.0.1", port: 47812, name: "Ants!", hostName: "Sam", players: 1, maxPlayers: 4, hasPassword: true, sameVersion: true });
    now = { ...now, players: 2 };
    await until(() => finder.games[0]?.players === 2, "player count change");
    expect(finder.games.length).toBe(1);
    host.close();
    await until(() => finder.games.length === 0, "row gone after the host closed");
    expect(changes.at(-1)).toBe(0);
  });

  it("marks another netVersion", async () => {
    const { finder } = await pair({ info: () => info(), netVersion: "2", finderVersion: "1" });
    await finder.start();
    await until(() => finder.games.length === 1, "row");
    expect(finder.games[0].sameVersion).toBe(false);
    expect(finder.games[0].netVersion).toBe("2");
  });

  it("a question for another game id gets no answer", async () => {
    const { host, finder } = await pair({ info: () => info(), gameId: "g", finderGame: "other" });
    await finder.start();
    await until(() => host.answerer.stats.wrong_game >= 2, "questions seen");
    expect(host.answerer.stats.answered).toBe(0);
    expect(finder.games.length).toBe(0);
  });

  it("stop closes the socket and empties the list", async () => {
    const { finder } = await pair({ info: () => info() });
    const spy = vi.spyOn(dgram, "createSocket");
    await finder.start();
    await until(() => finder.games.length === 1, "row");
    expect(lanSockets(spy)).toBe(1);
    const sock = spy.mock.results[0].value as dgram.Socket;
    expect(() => sock.address()).not.toThrow();
    finder.stop();
    expect(finder.games.length).toBe(0);
    expect(finder.status).toBe("idle");
    expect(() => sock.address()).toThrow(); // closed for real
  });

  it("a late answer after stop is delivered to nothing", async () => {
    let handler: ((b: Uint8Array, a: string, p: number) => void) | null = null;
    const sent: Uint8Array[] = [];
    const fake: LanUdp = {
      onMessage: null,
      bind: async () => 40000,
      send: (b) => sent.push(b),
      close: () => { handler = fake.onMessage; }, // keep the handler: the OS could still hand over a datagram
    };
    const f = new LanFinder({ gameId: "g", netVersion: "1", targets: ["127.0.0.1"], udp: () => fake });
    const changed = vi.fn();
    f.on("changed", changed);
    await f.start();
    const q = decodeLanQuestion(sent[0])!;
    const answer = encodeLanAnswer({ nonce: q.nonce, port: 47810, players: 1, maxPlayers: 4, password: false, gameId: "g", netVersion: "1", lobbyName: "x", hostName: "y" });
    fake.onMessage!(answer, "127.0.0.1", 47840);
    expect(f.games.length).toBe(1);
    f.stop();
    expect(f.games.length).toBe(0);
    changed.mockClear();
    handler!(answer, "127.0.0.1", 47840);
    expect(f.games.length).toBe(0);
    expect(changed).not.toHaveBeenCalled();
  });

  it("askNow asks at once, but never faster than the minimum gap", async () => {
    const port = await freeUdpPort();
    const seen: number[] = [];
    const host = new LanHost({ gameId: "g", netVersion: "1", info: () => info(), port, bindHost: "127.0.0.1" });
    await host.start();
    cleanup.push(() => host.close());
    const orig = host.answerer.handle.bind(host.answerer);
    host.answerer.handle = (b, a, p) => (seen.push(Date.now()), orig(b, a, p));
    const finder = new LanFinder({ gameId: "g", netVersion: "1", targets: ["127.0.0.1"], port, askIntervalMs: 60_000, minGapMs: 200 });
    cleanup.push(() => finder.stop());
    await finder.start();
    for (let i = 0; i < 10; i++) finder.askNow();
    await new Promise((r) => setTimeout(r, 120));
    expect(seen.length).toBe(1);
    await until(() => seen.length === 2, "the held ask goes out");
    expect(seen[1] - seen[0]).toBeGreaterThanOrEqual(150);
  });

  it("the taken-port case: the second host goes on without LAN discovery and says why", async () => {
    const port = await freeUdpPort();
    const a = new LanHost({ gameId: "g", netVersion: "1", info: () => info(), port, bindHost: "127.0.0.1" });
    expect(await a.start()).toBe(true);
    cleanup.push(() => a.close());
    const logs: string[] = [];
    const b = new LanHost({ gameId: "g", netVersion: "1", info: () => info(), port, bindHost: "127.0.0.1", log: (l) => logs.push(l) });
    expect(await b.start()).toBe(false);
    expect(b.listening).toBe(false);
    expect(logs).toEqual([`LAN discovery is off for this lobby: UDP port ${port} is taken`]);
    // only the first is found
    const finder = new LanFinder({ gameId: "g", netVersion: "1", targets: ["127.0.0.1"], port, askIntervalMs: 100, minGapMs: 40 });
    cleanup.push(() => finder.stop());
    await finder.start();
    await until(() => finder.games.length === 1, "row of the first host");
    expect(finder.games.length).toBe(1);
  });

  it("a finder given no UDP says plainly it cannot look (a browser)", async () => {
    const f = new LanFinder({ gameId: "g", netVersion: "1", udp: () => null });
    expect(await f.start()).toBe("browser");
    expect(f.statusReason).toMatch(/browser/);
  });
});

describe("the switch", () => {
  it("off: a finder from a blueprint with hosting.lan false opens no socket", async () => {
    const spy = vi.spyOn(dgram, "createSocket");
    const kit = OneLobby.fromConfig({ game: { id: "com.example.lantest" }, engine: "dotnet" }, { advanced: { linkFactory: links } });
    expect(kit.blueprint!.hosting.lan).toBe(false);
    const f = kit.lanFinder({ targets: ["127.0.0.1"] });
    expect(await f.start()).toBe("off");
    f.askNow();
    f.stop();
    expect(spy).not.toHaveBeenCalled(); // not even a socket object
  });

  it("off: a direct host opens no UDP socket for LAN discovery (and on opens exactly one)", async () => {
    const spy = vi.spyOn(dgram, "createSocket");
    const kit = OneLobby.fromConfig({ game: { id: "com.example.lantest" }, engine: "dotnet", hosting: { nostr: false, openPort: false } }, { displayName: "Sam", advanced: { linkFactory: links } });
    const off = await hostDirect(kit, { bindHost: "127.0.0.1", port: await freePort(), log: false });
    expect(off.lanHost).toBeNull();
    expect(lanSockets(spy)).toBe(0);
    await off.leave();

    const port = await freeUdpPort();
    const kit2 = OneLobby.fromConfig({ game: { id: "com.example.lantest" }, engine: "dotnet", hosting: { nostr: false, openPort: false, lan: true } }, { displayName: "Sam", advanced: { linkFactory: links } });
    const on = await hostDirect(kit2, { bindHost: "127.0.0.1", port: await freePort(), lan: { port }, log: false });
    cleanup.push(() => on.leave());
    expect(on.lanHost?.listening).toBe(true);
    expect(lanSockets(spy)).toBe(1);

    // a finder from the same blueprint finds it, and the row follows the lobby
    const finder = kit2.lanFinder({ targets: ["127.0.0.1"], port, askIntervalMs: 100, minGapMs: 40, rowTimeoutMs: 400 });
    cleanup.push(() => finder.stop());
    expect(await finder.start()).toBe("running");
    await until(() => finder.games.length === 1, "row of the hostDirect lobby");
    expect(finder.games[0]).toMatchObject({ address: "127.0.0.1", port: on.directHub.port, hostName: "Sam", players: 1, maxPlayers: 4, hasPassword: false, sameVersion: true });
    await on.leave();
    await until(() => finder.games.length === 0, "row gone after the lobby closed");
  });

  it("any loopback bindHost keeps the answering socket on 127.0.0.1; a real address opens it on every card", async () => {
    for (const h of ["127.0.0.1", "127.0.0.2", "127.255.0.1", "localhost", "LOCALHOST", "::1", "[::1]", "::ffff:127.0.0.1"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of [undefined, "", "0.0.0.0", "*", "192.168.1.20", "128.0.0.1", "1127.0.0.1", "example.com"]) expect(isLoopbackHost(h), String(h)).toBe(false);
    // the real path: the address the LAN socket asks to bind (a fake socket, nothing is opened)
    const kit = OneLobby.fromConfig({ game: { id: "com.example.lantest" }, engine: "dotnet", hosting: { nostr: false, openPort: false, lan: true } }, { displayName: "Sam", advanced: { linkFactory: links } });
    const bound: string[] = [];
    const fake: LanUdp = { onMessage: null, bind: async (_p, a) => { bound.push(a); return 40000; }, send: () => {}, close: () => {} };
    const host = await hostDirect(kit, { bindHost: "127.0.0.2", port: await freePort(), lan: { port: 40001, udp: () => fake }, log: false });
    cleanup.push(() => host.leave());
    expect(bound).toEqual(["127.0.0.1"]);
  });

  it("the default port is 47840", () => {
    expect(LAN_DEFAULT_PORT).toBe(V.constants.defaultPort);
  });
});
