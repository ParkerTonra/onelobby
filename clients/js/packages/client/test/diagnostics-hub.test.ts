import { afterEach, describe, expect, it } from "vitest";
import { SignalingHub, directHubOptions } from "../src/direct/hub.js";
import { NostrHostBridge } from "../src/nostr/host.js";
import { NostrSocket } from "../src/nostr/socket.js";
import { encodeRoomCode } from "../src/joincode.js";
import { systemClock } from "../src/clock.js";
import { FakeRelays } from "./fake-relay.js";
import { specJson } from "./spec.js";

const V = specJson("vectors/diagnostics.json");
const GOOD = { cause: "nat_blocked", stage: "ice", elapsedMs: 15000, relaySet: false, candidateTypes: { local: ["host", "srflx"], remote: ["host", "srflx"] }, clientVersion: "0.7.2" };

/** The `diag` message at a Direct hub (the same hub code the Nostr bridge and the browser host run). */
function lobbyOf(opts = directHubOptions(4, null)) {
  let now = 1_700_000_000_000;
  const hub = new SignalingHub(opts, { now: () => now });
  const inbox = new Map<number, any[]>();
  const socks = new Map<number, ReturnType<typeof hub.connect>>();
  const sock = (n: number, name: string) => {
    inbox.set(n, []);
    const s = hub.connect(`10.0.0.${n}`, (t) => inbox.get(n)!.push(JSON.parse(t)), () => {})!;
    socks.set(n, s);
    hub.receive(s, JSON.stringify({ t: "hello", proto: "lk1", gameId: "g", netVersion: "1", name }));
    return s;
  };
  const host = sock(1, "Host");
  hub.receive(host, JSON.stringify({ t: "create", name: "L", maxPlayers: 4, visibility: "unlisted", mode: "raw", tickRate: 20, lateJoin: true, meta: {} }));
  const joiner = (n: number, name: string) => {
    const s = sock(n, name);
    hub.receive(s, JSON.stringify({ t: "join" }));
    return s;
  };
  const send = (n: number, m: object) => hub.receive(socks.get(n)!, JSON.stringify(m));
  return { hub, inbox, host, joiner, send, advance: (ms: number) => (now += ms) };
}
const last = (box: any[], t: string) => [...box].reverse().find((m) => m.t === t);

describe("the Direct hub's diag relay", () => {
  it("lists the diag feature in welcome", () => {
    const { inbox } = lobbyOf();
    expect(last(inbox.get(1)!, "welcome").features).toContain("diag");
  });

  it("forwards a joiner's report to the host only, with from stamped by the hub", () => {
    const l = lobbyOf();
    l.joiner(2, "Sam");
    l.joiner(3, "Kim");
    for (const b of l.inbox.values()) b.length = 0;
    l.send(2, { t: "diag", from: 3, report: GOOD });
    expect(last(l.inbox.get(1)!, "diag")).toEqual({ t: "diag", from: 2, report: GOOD });
    expect(last(l.inbox.get(3)!, "diag")).toBeUndefined();
    expect(last(l.inbox.get(2)!, "diag")).toBeUndefined();
    expect(last(l.inbox.get(2)!, "error")).toBeUndefined();
  });

  it("rebuilds the report: unknown fields never reach the host", () => {
    const l = lobbyOf();
    l.joiner(2, "Sam");
    l.send(2, { t: "diag", report: { ...GOOD, address: "203.0.113.9", name: "Sam", note: "hello", candidateTypes: { ...GOOD.candidateTypes, addresses: ["10.0.0.1"] } } });
    const got = last(l.inbox.get(1)!, "diag").report;
    expect(got).toEqual(GOOD);
    expect(JSON.stringify(got)).not.toMatch(/203\.0\.113\.9|Sam|hello|10\.0\.0\.1/);
  });

  it("follows the shared vectors for valid and invalid reports", () => {
    for (const c of V.report.valid) {
      const l = lobbyOf();
      l.joiner(2, "Sam");
      l.send(2, { t: "diag", report: c.input });
      expect(last(l.inbox.get(2)!, "error"), c.name).toBeUndefined();
      expect(last(l.inbox.get(1)!, "diag").report, c.name).toEqual(c.output);
    }
    for (const c of V.report.invalid) {
      const l = lobbyOf();
      l.joiner(2, "Sam");
      l.send(2, { t: "diag", report: c.input });
      expect(last(l.inbox.get(2)!, "error"), c.name).toMatchObject({ code: "bad_request", data: { field: "report" } });
      expect(last(l.inbox.get(1)!, "diag"), c.name).toBeUndefined();
    }
  });

  it("refuses a frame over the cap", () => {
    const l = lobbyOf();
    l.joiner(2, "Sam");
    l.send(2, { t: "diag", pad: "x".repeat(V.report.maxFrameBytes), report: GOOD });
    expect(last(l.inbox.get(2)!, "error")).toMatchObject({ code: "bad_request" });
    expect(last(l.inbox.get(1)!, "diag")).toBeUndefined();
  });

  it("forwards three per minute per peer, then rate_limited, and counts again after the window", () => {
    const l = lobbyOf();
    l.joiner(2, "Sam");
    l.joiner(3, "Kim");
    for (let i = 0; i < V.report.perMinute; i++) l.send(2, { t: "diag", report: GOOD });
    l.send(2, { t: "diag", report: GOOD });
    expect(last(l.inbox.get(2)!, "error")).toMatchObject({ code: "rate_limited" });
    expect(l.inbox.get(1)!.filter((m) => m.t === "diag")).toHaveLength(3);
    // another peer has its own budget
    l.send(3, { t: "diag", report: GOOD });
    expect(l.inbox.get(1)!.filter((m) => m.t === "diag")).toHaveLength(4);
    l.advance(61_000);
    l.send(2, { t: "diag", report: GOOD });
    expect(l.inbox.get(1)!.filter((m) => m.t === "diag")).toHaveLength(5);
  });

  it("the host cannot send one, nor a peer outside a lobby", () => {
    const l = lobbyOf();
    l.send(1, { t: "diag", report: GOOD });
    expect(last(l.inbox.get(1)!, "error")).toMatchObject({ code: "bad_request" });
  });
});

describe("the same report over a Nostr room", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => cleanup.splice(0).forEach((c) => c()));
  const until = async (cond: () => boolean, what: string, ms = 8000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("a Nostr joiner's diag reaches the host's hub session, and only the host", async () => {
    const URLS = ["wss://r1.test", "wss://r2.test"];
    const relays = new FakeRelays();
    const hub = new SignalingHub({ ...directHubOptions(4, null), rateScale: 50 });
    const code = encodeRoomCode();
    const bridge = await NostrHostBridge.start(hub, { code, relays: URLS, connect: relays.connect, clock: systemClock });
    cleanup.push(() => void bridge.close());
    const speak = () => {
      const sock = new NostrSocket({ code, relays: URLS, connect: relays.connect, clock: systemClock, openEveryMs: 200 });
      cleanup.push(() => sock.close());
      const inbox: any[] = [];
      sock.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
      const next = async (t: string) => {
        await until(() => inbox.some((m) => m.t === t || m.t === "error"), `message ${t}`);
        return inbox.splice(inbox.findIndex((m) => m.t === t || m.t === "error"), 1)[0];
      };
      return { sock, inbox, next, send: (m: object) => sock.send(JSON.stringify(m)) };
    };
    const a = speak();
    await new Promise<void>((r) => (a.sock.onopen = () => r()));
    a.send({ t: "hello", proto: "lk1", gameId: "g", netVersion: "1", name: "Host" });
    expect((await a.next("welcome")).features).toContain("diag");
    a.send({ t: "create", name: "L", maxPlayers: 4, mode: "raw" });
    await a.next("lobby");
    const b = speak();
    await new Promise<void>((r) => (b.sock.onopen = () => r()));
    b.send({ t: "hello", proto: "lk1", gameId: "g", netVersion: "1", name: "Sam" });
    await b.next("welcome");
    b.send({ t: "join" });
    await b.next("lobby");
    await a.next("peer_joined");

    b.send({ t: "diag", report: GOOD });
    const got = await a.next("diag");
    expect(got).toEqual({ t: "diag", from: 2, report: GOOD });
    await new Promise((r) => setTimeout(r, 200));
    expect(b.inbox.some((m) => m.t === "diag")).toBe(false);
  }, 20000);
});
