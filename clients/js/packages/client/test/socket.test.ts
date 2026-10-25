import { describe, expect, it } from "vitest";
import { settle } from "../src/testing.js";
import type { LobbySocket } from "../src/socket.js";
import { rig } from "./helpers.js";

// WebSocket-shaped sockets (lobby.asWebSocket / lobby.onConnection), rateLimit and peerTimeoutMs, on the in-memory rig.

async function pair(opts: { peerTimeoutMs?: number; rateLimit?: { messages: number; perMs: number } } = {}) {
  const r = rig();
  const h = await r.make("host", { mode: "raw", peerTimeoutMs: opts.peerTimeoutMs }).host({ name: "t", maxPlayers: 4, rateLimit: opts.rateLimit });
  const a = await r.make("a", { mode: "raw", peerTimeoutMs: opts.peerTimeoutMs }).join(h.code);
  return { r, h, a };
}

describe("WebSocket-shaped sockets", () => {
  it("joiner socket and host connection talk text both ways", async () => {
    const { h, a } = await pair();
    const conns: LobbySocket[] = [];
    const atHost: string[] = [];
    h.onConnection((c) => {
      conns.push(c);
      c.onmessage = (e) => {
        atHost.push(String(e.data));
        c.send(`echo ${e.data}`);
      };
    });
    const ws = a.asWebSocket();
    expect(ws.readyState).toBe(0);
    const atJoiner: string[] = [];
    let opened = 0;
    ws.onopen = () => {
      opened++;
      ws.send("hello");
    };
    ws.onmessage = (e) => atJoiner.push(String(e.data));
    await settle();
    expect(opened).toBe(1);
    expect(ws.readyState).toBe(1);
    expect(conns.map((c) => c.peerId)).toEqual([a.localPeerId]);
    expect(atHost).toEqual(["hello"]);
    expect(atJoiner).toEqual(["echo hello"]);
  });

  it("made after ready, the socket is OPEN at once: a send right away arrives, onopen still fires", async () => {
    const { h, a } = await pair();
    const atHost: string[] = [];
    h.onConnection((c) => (c.onmessage = (e) => atHost.push(String(e.data))));
    await a.ready;
    await settle();
    const ws = a.asWebSocket();
    expect(ws.readyState).toBe(1);
    ws.send("now");
    let opened = 0;
    ws.onopen = () => opened++;
    await settle();
    expect(atHost).toEqual(["now"]);
    expect(opened).toBe(1);
  });

  it("binary mode delivers bytes", async () => {
    const { h, a } = await pair();
    const got: unknown[] = [];
    h.onConnection((c) => (c.onmessage = (e) => got.push(e.data)), { binary: true });
    const ws = a.asWebSocket({ binary: true });
    await settle();
    ws.send(Uint8Array.of(1, 2, 3));
    await settle();
    expect(got).toEqual([Uint8Array.of(1, 2, 3)]);
  });

  it("a server-backed host leaving migrates, which closes the joiner socket with 1001 host_changed", async () => {
    const { h, a } = await pair();
    const ws = a.asWebSocket();
    await settle();
    const closes: { code: number; reason: string }[] = [];
    ws.onclose = (e) => closes.push({ code: e.code, reason: e.reason });
    await h.leave();
    await settle();
    expect(ws.readyState).toBe(3);
    expect(closes).toEqual([{ code: 1001, reason: "host_changed" }]);
  });

  it("a joiner leaving closes its host connection; a later joiner gets a new one", async () => {
    const { r, h, a } = await pair();
    const closes: [number, number, string][] = [];
    h.onConnection((c) => (c.onclose = (e) => closes.push([c.peerId, e.code, e.reason])));
    await settle();
    await a.leave();
    await settle();
    // (the in-memory server reports a leave that races its socket close as "timeout"; a real server says "left")
    expect(closes.map((c) => c[0])).toEqual([a.localPeerId]);
    const b = await r.make("b", { mode: "raw" }).join(h.code);
    let seen = 0;
    h.onConnection((c) => c.peerId === b.localPeerId && seen++);
    await settle();
    expect(seen).toBe(1);
  });

  it("joiner close() leaves the lobby; asWebSocket on the host throws", async () => {
    const { h, a } = await pair();
    const ws = a.asWebSocket();
    await settle();
    let ended = "";
    a.on("sessionEnded", (r) => (ended = r));
    ws.close();
    await settle();
    expect(ended).toBe("left");
    expect(() => h.asWebSocket()).toThrow(/joiners/);
    expect(() => a.onConnection(() => {})).toThrow(/host/);
  });
});

describe("rateLimit", () => {
  it("drops a joiner's raw messages over the cap, per window", async () => {
    const { r, h, a } = await pair({ rateLimit: { messages: 3, perMs: 1000 } });
    await settle();
    let n = 0;
    h.on("message", () => n++);
    for (let i = 0; i < 10; i++) a.send(h.localPeerId, Uint8Array.of(i));
    await settle();
    expect(n).toBe(3);
    await r.clock.run(1000, 100);
    a.send(h.localPeerId, Uint8Array.of(99));
    await settle();
    expect(n).toBe(4);
  });
});

describe("peerTimeoutMs", () => {
  it("host drops a silent joiner; a silent host ends a joiner's lobby", async () => {
    const { r, h, a } = await pair({ peerTimeoutMs: 6000 });
    await r.clock.run(3000, 100);
    const left: [number, string][] = [];
    h.on("peerLeft", (p, why) => left.push([p.peerId, why]));
    let joinerSaw = "";
    a.on("hostChanged", () => (joinerSaw = "hostChanged"));
    for (const l of r.net.links) l.blackhole = true; // both directions go silent, nothing closes
    await r.clock.run(7000, 100);
    expect(left).toEqual([[a.localPeerId, "timeout"]]);
    expect(h.connectedPeers).toEqual([]);
    expect(joinerSaw).not.toBe("");
  });

  it("off by default: a silent joiner stays", async () => {
    const { r, h } = await pair();
    await r.clock.run(3000, 100);
    let left = 0;
    h.on("peerLeft", () => left++);
    for (const l of r.net.links) l.blackhole = true;
    await r.clock.run(20000, 200);
    expect(left).toBe(0);
  });

  it("pings keep a quiet but live pair connected", async () => {
    const { r, h } = await pair({ peerTimeoutMs: 6000 });
    let left = 0;
    h.on("peerLeft", () => left++);
    await r.clock.run(30000, 100);
    expect(left).toBe(0);
  });
});

describe("host disconnect and late onopen (0.2.1)", () => {
  it("onopen assigned after several awaits still fires, once", async () => {
    const { a } = await pair();
    // the shape of a game's dial(): await ready, return the socket from an async function, attach handlers later
    const dial = async () => {
      await a.ready;
      return a.asWebSocket();
    };
    const ws = await dial().then(async (w) => {
      await Promise.resolve();
      await Promise.resolve();
      return w;
    });
    let opened = 0;
    ws.onopen = () => opened++;
    await settle();
    expect(ws.readyState).toBe(1);
    expect(opened).toBe(1);
    ws.onopen = () => opened++; // a second handler later does not replay it
    await settle();
    expect(opened).toBe(1);
  });

  it("disconnect(peerId, code, reason): both sockets close with them, no ban, the player can join again", async () => {
    const { r, h, a } = await pair();
    const conns: LobbySocket[] = [];
    h.onConnection((c) => conns.push(c));
    const ws = a.asWebSocket();
    await settle();
    const atJoiner: [number, string][] = [];
    const atHost: [number, string][] = [];
    ws.onclose = (e) => atJoiner.push([e.code, e.reason]);
    conns[0]!.onclose = (e) => atHost.push([e.code, e.reason]);
    const ended: [string, unknown][] = [];
    a.on("sessionEnded", (why, close) => ended.push([why, close]));
    const left: string[] = [];
    h.on("peerLeft", (_p, why) => left.push(why));

    await h.disconnect(a.localPeerId, 4000, "replaced");
    await settle();
    expect(atJoiner).toEqual([[4000, "replaced"]]);
    expect(atHost).toEqual([[4000, "replaced"]]);
    expect(ended).toEqual([["disconnected", { code: 4000, reason: "replaced" }]]);
    expect(left).toEqual(["disconnected"]);
    expect(r.server.received.some((m) => m.t === "kick" && m.ban === false && m.closeCode === 4000)).toBe(true);

    const again = await r.make("a2", { mode: "raw" }).join(h.code);
    expect(again.peers.length).toBe(2);
  });

  it("disconnect without a code closes with 1000 \"disconnected\"; kick still closes with 4000 \"kicked\"", async () => {
    const { r, h, a } = await pair();
    const ws = a.asWebSocket();
    await settle();
    const seen: [number, string][] = [];
    ws.onclose = (e) => seen.push([e.code, e.reason]);
    await h.disconnect(a.localPeerId);
    await settle();
    expect(seen).toEqual([[1000, "disconnected"]]);

    const b = await r.make("b", { mode: "raw" }).join(h.code);
    const wb = b.asWebSocket();
    await settle();
    wb.onclose = (e) => seen.push([e.code, e.reason]);
    await h.kick(b.localPeerId);
    await settle();
    expect(seen[1]).toEqual([4000, "kicked"]);
    await expect(h.kick(99, { code: 1006 })).rejects.toThrow(RangeError);
  });
});
