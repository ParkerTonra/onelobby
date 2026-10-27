import { afterEach, describe, expect, it } from "vitest";
import { connect as netConnect, createServer } from "node:net";
import { createSocket } from "node:dgram";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { OneLobby } from "../src/onelobby.js";
import type { Lobby } from "../src/lobby.js";
import { OneLobbyError } from "../src/signaling.js";
import { decodeJoinCode, encodeJoinCode } from "../src/joincode.js";
import { webRtcLinkFactoryFor } from "../src/webrtc.js";
import type { LinkFactory, PeerLink, SignalPayload } from "../src/transport.js";
import { DirectHubHost, defaultHubOptions, directHubOptions, formatHostLog, hostDirect, originAllowed } from "../src/direct/index.js";
import { SignalingHub } from "../src/direct/hub.js";
import { PortInUseError, isLoopback, portFailureHint } from "../src/direct/hub-host.js";
import { freePort, loopbackRtc } from "./helpers.js";
import { directJoinInfo } from "../src/friendly.js";

/** The IP-code tests: Nostr is off so no test talks to a public relay (test/nostr-e2e.test.ts covers Nostr). */
const hostIp = (k: OneLobby, o: Parameters<typeof hostDirect>[1] = {}) => hostDirect(k, { nostr: false, bindHost: "127.0.0.1", ...o });

/**
 * Direct IP in Node (docs/direct-ip.md): a Node process hosts with onelobby/direct, joiners use kit.joinDirect, real
 * WebRTC through node-datachannel (libdatachannel) on loopback. No server anywhere.
 */

const links = webRtcLinkFactoryFor(loopbackRtc(RTCPeerConnection) as unknown as typeof globalThis.RTCPeerConnection);
const kit = (name: string) =>
  new OneLobby({ gameId: "com.onelobby.directtest", netVersion: "1", lobbyServer: "", mode: "raw", displayName: name, rememberSeat: false, advanced: { linkFactory: links } });

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

/** Raw lk1 over a WebSocket to the listener. */
async function raw(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const inbox: any[] = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const next = async (t: string) => {
    await until(() => inbox.some((m) => m.t === t || m.t === "error"), `message ${t}`);
    return inbox.splice(inbox.findIndex((m) => m.t === t || m.t === "error"), 1)[0];
  };
  const send = (m: object) => ws.send(JSON.stringify(m));
  const hello = async (gameId = "g") => {
    send({ t: "hello", proto: "lk1", gameId, netVersion: "1", name: "x" });
    return next("welcome");
  };
  cleanup.push(() => ws.close());
  return { ws, send, next, hello };
}

describe("hub in direct mode (C# DirectHubTests, ported)", () => {
  it("the signal limit is per target: the host answers many joiners at once, one target still caps at 20/s", () => {
    const hub = new SignalingHub(directHubOptions(8, null), { now: () => 1_700_000_000_000 });
    const inbox = new Map<number, any[]>();
    const sock = (n: number) => {
      inbox.set(n, []);
      const s = hub.connect(`10.0.0.${n}`, (t) => inbox.get(n)!.push(JSON.parse(t)), () => {})!;
      hub.receive(s, JSON.stringify({ t: "hello", proto: "lk1", gameId: "g", netVersion: "1", name: `p${n}` }));
      return s;
    };
    const h = sock(1);
    hub.receive(h, JSON.stringify({ t: "create", name: "L", maxPlayers: 8, visibility: "unlisted", mode: "raw", tickRate: 20, lateJoin: true, meta: {} }));
    for (const n of [2, 3, 4]) hub.receive(sock(n), JSON.stringify({ t: "join" }));
    for (const to of [2, 3, 4]) for (let i = 0; i < 20; i++) hub.receive(h, JSON.stringify({ t: "signal", to, ice: {} }));
    expect(inbox.get(1)!.filter((m) => m.t === "error")).toEqual([]);
    for (const n of [2, 3, 4]) expect(inbox.get(n)!.filter((m) => m.t === "signal")).toHaveLength(20);
    hub.receive(h, JSON.stringify({ t: "signal", to: 3, ice: {} }));
    expect(inbox.get(1)!.at(-1)).toMatchObject({ t: "error", code: "rate_limited" });
  });

  it("the signal limit also caps a sender at 8 targets' worth (160/s) in all", () => {
    const hub = new SignalingHub(directHubOptions(10, null), { now: () => 1_700_000_000_000 });
    const out: any[] = [];
    const sock = (n: number, keep: boolean) => {
      const s = hub.connect(`10.0.0.${n}`, (t) => keep && out.push(JSON.parse(t)), () => {})!;
      hub.receive(s, JSON.stringify({ t: "hello", proto: "lk1", gameId: "g", netVersion: "1", name: `p${n}` }));
      return s;
    };
    const h = sock(1, true);
    hub.receive(h, JSON.stringify({ t: "create", name: "L", maxPlayers: 10, visibility: "unlisted", mode: "raw", tickRate: 20, lateJoin: true, meta: {} }));
    for (let n = 2; n <= 10; n++) hub.receive(sock(n, false), JSON.stringify({ t: "join" }));
    let sent = 0;
    const err = () => out.some((m) => m.t === "error");
    for (let to = 2; to <= 10 && !err(); to++) for (let i = 0; i < 20 && !err(); i++, sent++) hub.receive(h, JSON.stringify({ t: "signal", to, ice: {} }));
    expect(sent).toBe(161);
    expect(out.find((m) => m.t === "error")).toMatchObject({ code: "rate_limited" });
  });

  it("join without a code joins the one lobby; codes hidden; no ICE servers", async () => {
    const host = await DirectHubHost.listen(0, directHubOptions(4, null), { host: "127.0.0.1" });
    cleanup.push(() => host.close());
    const h = await raw(host.port);
    expect((await h.hello()).ice).toEqual([]);
    h.send({ t: "create", name: "L", maxPlayers: 4, mode: "raw" });
    const lobby = await h.next("lobby");
    expect(lobby.code).toBe("");
    const j = await raw(host.port);
    await j.hello();
    j.send({ t: "join" });
    expect((await j.next("lobby")).you).toBe(2);
    h.send({ t: "list", visibility: "public" });
    expect((await h.next("lobbies")).items).toEqual([]);
  });

  it("a member's host_changed claim changes nothing while the host is connected, and takes effect when it goes", async () => {
    const host = await DirectHubHost.listen(0, { ...defaultHubOptions(), rateScale: 20 }, { host: "127.0.0.1" });
    cleanup.push(() => host.close());
    const h = await raw(host.port);
    await h.hello();
    h.send({ t: "create", name: "L", maxPlayers: 4, mode: "raw", visibility: "unlisted" });
    const code = (await h.next("lobby")).code;
    const j = await raw(host.port);
    await j.hello();
    j.send({ t: "join", code });
    await j.next("lobby");
    j.send({ t: "host_changed", hostId: 2, epoch: 3 });
    j.send({ t: "phase", phase: "in_game" });
    expect((await j.next("error")).code).toBe("not_host");
    h.ws.close();
    const hc = await j.next("host_changed");
    expect([hc.hostId, hc.epoch]).toEqual([2, 3]);
  });

  it("a resume token for another game leaves the live socket alone; the right game takes it over", async () => {
    const host = await DirectHubHost.listen(0, { ...defaultHubOptions(), rateScale: 20 }, { host: "127.0.0.1" });
    cleanup.push(() => host.close());
    const a = await raw(host.port);
    await a.hello();
    a.send({ t: "create", name: "L", maxPlayers: 4, mode: "raw", visibility: "unlisted" });
    const lobby = await a.next("lobby");
    const other = await raw(host.port);
    other.send({ t: "hello", proto: "lk1", gameId: "other-game", netVersion: "1", name: "x", resumeToken: lobby.resumeToken });
    expect((await other.next("welcome")).peerId).toBeUndefined();
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    const same = await raw(host.port);
    same.send({ t: "hello", proto: "lk1", gameId: "g", netVersion: "1", name: "x", resumeToken: lobby.resumeToken });
    expect((await same.next("welcome")).peerId).toBe(1);
    await until(() => a.ws.readyState === WebSocket.CLOSED, "old socket closed");
  });

  it("host_changed claims are rejected outright in a direct lobby", async () => {
    const host = await DirectHubHost.listen(0, directHubOptions(4, null), { host: "127.0.0.1" });
    cleanup.push(() => host.close());
    const h = await raw(host.port);
    await h.hello();
    h.send({ t: "create", name: "L", maxPlayers: 4, mode: "raw" });
    await h.next("lobby");
    const j = await raw(host.port);
    await j.hello();
    j.send({ t: "join" });
    await j.next("lobby");
    j.send({ t: "host_changed", hostId: 2, epoch: 7 });
    h.ws.close();
    expect((await j.next("host_changed")).epoch).toBe(1);   // the hub's own promotion, not the claim
  });

  it("wrong password is bad_password; second create is server_full", async () => {
    const host = await DirectHubHost.listen(0, directHubOptions(4, "pw"), { host: "127.0.0.1" });
    cleanup.push(() => host.close());
    const h = await raw(host.port);
    await h.hello();
    h.send({ t: "create", name: "L", maxPlayers: 4 });
    await h.next("lobby");
    const j = await raw(host.port);
    await j.hello();
    j.send({ t: "join", password: "PW" });
    expect((await j.next("lobby")).code).toBe("bad_password");
    j.send({ t: "join", password: "pw" });
    expect((await j.next("lobby")).t).toBe("lobby");
    const k = await raw(host.port);
    await k.hello();
    k.send({ t: "create", name: "L2", maxPlayers: 4 });
    expect((await k.next("lobby")).code).toBe("server_full");
  });

  it("a second listener on the same port is port_in_use", async () => {
    const port = await freePort();
    const a = await DirectHubHost.listen(port);
    cleanup.push(() => a.close());
    await expect(DirectHubHost.listen(port)).rejects.toMatchObject({ code: "port_in_use" });
  });

  it("a port another program holds on IPv4 only, TCP or UDP, is port_in_use", async () => {
    // Windows lets a dual-stack [::] listener bind over a program on 0.0.0.0, and IPv4 joiners then reach that program
    const port = await freePort();
    const other = createServer();
    await new Promise<void>((r) => other.listen(port, "0.0.0.0", () => r()));
    cleanup.push(() => new Promise<void>((r) => other.close(() => r())));
    await expect(DirectHubHost.listen(port)).rejects.toMatchObject({ code: "port_in_use" });

    // peer links share UDP P, so a taken UDP half counts too
    const udp = createSocket("udp4");
    await new Promise<void>((r) => udp.bind(0, "0.0.0.0", () => r()));
    cleanup.push(() => void udp.close());
    await expect(DirectHubHost.listen(udp.address().port)).rejects.toMatchObject({ code: "port_in_use" });
  });

  it("a port Windows reserved (EACCES) says so instead of blaming another copy of the game", () => {
    const e = new PortInUseError(47810, "EACCES");
    expect(e.reserved).toBe(true);
    expect(e.message).toContain("Windows has reserved it");
    expect(new PortInUseError(47810, "EADDRINUSE").message).toContain("another copy of the game");
    expect(portFailureHint(true, true)).toContain("busy or reserved");
  });

  it("a WebSocket upgrade needs no Origin, the host's own page, a loopback origin or an allowed one; else 403", async () => {
    const host = await DirectHubHost.listen(0, undefined, { host: "127.0.0.1" });
    host.allowedOrigins = ["https://play.example"];
    cleanup.push(() => host.close());
    const status = (origin: string | null, hostHeader = "game.example:47810") =>
      new Promise<string>((resolve) => {
        const s = netConnect(host.port, "127.0.0.1", () => {
          s.write("GET / HTTP/1.1\r\nHost: " + hostHeader + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" + (origin === null ? "" : "Origin: " + origin + "\r\n") + "\r\n");
        });
        s.once("data", (d) => { resolve(d.toString("latin1").split("\r\n")[0]); s.destroy(); });
      });
    expect(await status(null)).toContain("101");
    expect(await status("http://game.example:47810")).toContain("101");
    expect(await status("http://localhost:5173")).toContain("101");
    expect(await status("http://127.0.0.1:3000")).toContain("101");
    expect(await status("http://[::1]:3000")).toContain("101");
    expect(await status("https://play.example")).toContain("101");
    expect(await status("https://evil.example")).toContain("403");
    expect(await status("https://play.example.evil.example")).toContain("403");
    expect(await status("null")).toContain("403");
    expect(await status("http://game.example:9999")).toContain("403");
    host.allowedOrigins = ["*"];
    expect(await status("https://evil.example")).toContain("101");
    expect(originAllowed("http://a:1", "a:1", [])).toBe(true);
    expect(originAllowed("http://a:1", "b:1", [])).toBe(false);
  });

  it("GET /healthz answers ok and plain HTTP gets 426", async () => {
    const host = await DirectHubHost.listen(0, undefined, { host: "127.0.0.1" });
    cleanup.push(() => host.close());
    expect(await (await fetch(`http://127.0.0.1:${host.port}/healthz`)).text()).toBe("ok\n");
    expect((await fetch(`http://127.0.0.1:${host.port}/`)).status).toBe(426);
  });

  it("GET /metrics from loopback renders the hub counters, with the same names as the C# hub", async () => {
    const host = await DirectHubHost.listen(0, undefined, { host: "127.0.0.1" });
    cleanup.push(() => host.close());
    const get = () => fetch(`http://127.0.0.1:${host.port}/metrics`);
    const before = await get();
    expect(before.status).toBe(200);
    expect(before.headers.get("content-type")).toBe("text/plain; version=0.0.4");
    const first = await before.text();
    expect(first).toContain("onelobby_lobbies 0\n");
    expect(first).not.toContain("onelobby_lobbies_created_total 1");

    // same scenario as C# DirectHubHostTests.Metrics_from_loopback_render_the_hub_counters
    const h = await raw(host.port);
    await h.hello();
    h.send({ t: "create", name: "L", maxPlayers: 4, mode: "raw", visibility: "unlisted" });
    await h.next("lobby");
    h.send({ t: "create", name: "L", maxPlayers: 4 });
    await h.next("error");
    const after = await (await get()).text();
    expect(after).toContain("onelobby_lobbies 1\n");
    expect(after).toContain("onelobby_lobbies_created_total 1\n");
    expect(after).toContain("onelobby_connections_total 1\n");
    expect(after).toContain('onelobby_errors_total{code="bad_request"} 1\n');
    expect(after).toContain("# HELP onelobby_errors_total Error replies sent, by code.\n");
    const names = after.split("\n").filter((l) => l.startsWith("# TYPE ")).map((l) => l.split(" ")[2]).sort();
    expect(names).toEqual([
      "onelobby_connections_total", "onelobby_errors_total", "onelobby_lobbies", "onelobby_lobbies_created_total",
      "onelobby_lobbies_retired", "onelobby_messages_total", "onelobby_sockets",
    ]);
    // /metrics and /healthz win over the game's http callback
    host.http = () => ({ type: "text/plain", body: "game" });
    expect(await (await fetch(`http://127.0.0.1:${host.port}/healthz`)).text()).toBe("ok\n");
    expect(await (await get()).text()).toContain("onelobby_lobbies 1\n");
  });

  it("only loopback callers may read /metrics", () => {
    for (const ip of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(ip), ip).toBe(true);
    for (const ip of ["192.168.1.5", "10.0.0.1", "8.8.8.8", "::2", "2001:db8::1", "::ffff:192.168.1.5", "", "local"]) expect(isLoopback(ip), ip).toBe(false);
  });

  it("serves plain GETs from the http handler (join page), 404 for null, WebSocket still upgrades", async () => {
    const host = await DirectHubHost.listen(0, undefined, { host: "127.0.0.1" });
    cleanup.push(() => host.close());
    const seen: string[] = [];
    host.http = (path) => {
      seen.push(path);
      return path === "/" ? { type: "text/html; charset=utf-8", body: "<h1>join</h1>" } : null;
    };
    const page = await fetch(`http://127.0.0.1:${host.port}/?join=x`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toBe("<h1>join</h1>");
    expect((await fetch(`http://127.0.0.1:${host.port}/nope`)).status).toBe(404);
    expect(seen).toEqual(["/", "/nope"]);
    const ws = new WebSocket(`ws://127.0.0.1:${host.port}/`);
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("ws failed")); });
    ws.close();
  });

  it("an http reply's headers are sent (Cache-Control replaces no-store); the hub keeps Content-Length; a line break is 500", async () => {
    const host = await DirectHubHost.listen(0, undefined, { host: "127.0.0.1" });
    cleanup.push(() => host.close());
    host.http = (path) =>
      path === "/app.js"
        ? { type: "text/javascript", body: "x", headers: { "Cache-Control": "max-age=60", "Content-Length": "999", "X-Game": "1" } }
        : path === "/bad"
          ? { type: "text/plain", body: "x", headers: { "X-Bad": "a\r\nSet-Cookie: y" } }
          : { type: "text/plain", body: "plain" };
    const js = await fetch(`http://127.0.0.1:${host.port}/app.js`);
    expect(js.headers.get("cache-control")).toBe("max-age=60");
    expect(js.headers.get("content-length")).toBe("1");
    expect(js.headers.get("x-game")).toBe("1");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`http://127.0.0.1:${host.port}/`)).headers.get("cache-control")).toBe("no-store");
    const bad = await fetch(`http://127.0.0.1:${host.port}/bad`);
    expect(bad.status).toBe(500);
    expect(bad.headers.get("set-cookie")).toBeNull();
  });

  it("GET /joininfo is 404 until the host has a code, then the code, kind, link and port as JSON", async () => {
    const host = await DirectHubHost.listen(0, undefined, { host: "127.0.0.1" });
    cleanup.push(() => host.close());
    expect((await fetch(`http://127.0.0.1:${host.port}/joininfo`)).status).toBe(404);
    host.joinInfo = { joinCode: "6B01-RGFE-P2B", joinCodeKind: "internet", directCode: "6B01-RGFE-P2B", directCodeKind: "internet", joinUrl: "http://203.0.113.7:47810/", port: host.port };
    const res = await fetch(`http://127.0.0.1:${host.port}/joininfo?t=1`);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual(host.joinInfo);
  });
});

describe("hostDirect join code: manual public address and router retry", () => {
  it("publicAddress makes an internet code and joinUrl without asking the router; /joininfo and directJoinInfo match", async () => {
    const port = await freePort();
    const host = await hostIp(kit("Host"), {
      port, publicAddress: "203.0.113.7", log: false, http: () => ({ type: "text/html", body: "page" }),
      portMapping: { ssdp: { address: "127.0.0.1", port: 9 }, natPmp: { address: "127.0.0.1", port: 9 } },
    });
    cleanup.push(() => host.leave());
    expect(host.directHub.portMapper).toBeNull();
    expect(host.joinCode).toBe(encodeJoinCode("203.0.113.7", port));
    expect(host.joinCodeKind).toBe("internet");
    expect(host.portMapping).toBe("manual");
    expect(host.joinUrl).toBe(`http://203.0.113.7:${port}/`);
    // a page opened at a LAN or loopback address learns the public link
    expect(await directJoinInfo(`http://127.0.0.1:${port}/game?x=1`)).toEqual({
      joinCode: host.joinCode, joinCodeKind: "internet", directCode: host.joinCode, directCodeKind: "internet", joinUrl: host.joinUrl, port,
    });
    expect(await directJoinInfo(`http://127.0.0.1:${await freePort()}/`)).toBeNull();
    await expect(hostIp(kit("Bad"), { port: await freePort(), publicAddress: "my.host.example", log: false }))
      .rejects.toMatchObject({ code: "bad_address" });
    process.env.ONELOBBY_PUBLIC_IP = "203.0.113.8";
    try {
      const fromEnv = await hostIp(kit("Env"), { port: await freePort(), log: false });
      cleanup.push(() => fromEnv.leave());
      expect(fromEnv.joinCodeKind).toBe("internet");
      expect(fromEnv.portMapping).toBe("manual (ONELOBBY_PUBLIC_IP)");
    } finally {
      delete process.env.ONELOBBY_PUBLIC_IP;
    }
  });

  it("a router that answers late flips the code to internet and fires joinCodeChanged, no restart", async () => {
    // NAT-PMP gateway on loopback that is silent (router still booting) until `up`
    let up = false;
    const gw = createSocket("udp4");
    gw.on("message", (q, r) => {
      if (!up) return;
      if (q[1] === 0) return void gw.send(Buffer.from([0, 128, 0, 0, 0, 0, 0, 1, 198, 51, 100, 9]), r.port, r.address);
      const reply = Buffer.alloc(16);
      reply[1] = 128 + q[1];
      reply.writeUInt32BE(1, 4);
      reply.writeUInt16BE(q.readUInt16BE(4), 8);
      reply.writeUInt16BE(q.readUInt32BE(8) === 0 ? 0 : q.readUInt16BE(4), 10);
      reply.writeUInt32BE(q.readUInt32BE(8), 12);
      gw.send(reply, r.port, r.address);
    });
    await new Promise<void>((r) => gw.bind(0, "127.0.0.1", () => r()));
    cleanup.push(() => {
      gw.close();
    });
    const port = await freePort();
    const lines: string[] = [];
    const host = await hostIp(kit("Host"), {
      port, log: (l) => lines.push(l), http: () => ({ type: "text/html", body: "page" }),
      portMapping: { natPmp: { address: "127.0.0.1", port: gw.address().port }, tryUpnp: false, retryMs: 100 },
    });
    cleanup.push(() => host.leave());
    expect(host.joinCodeKind).not.toBe("internet");
    const changed: [string, string][] = [];
    host.on("joinCodeChanged", (code, kind) => changed.push([code, kind]));
    up = true;
    await until(() => changed.length > 0, "joinCodeChanged after the router comes back", 15000);
    expect(changed).toEqual([[encodeJoinCode("198.51.100.9", port), "internet"]]);
    expect(host.joinCode).toBe(encodeJoinCode("198.51.100.9", port));
    expect(host.joinUrl).toBe(`http://198.51.100.9:${port}/`);
    expect(host.portMapping).toBe("NAT-PMP");
    expect(lines.at(-1)).toBe(host.directHostLog);
    expect(lines.at(-1)).toContain("(Internet); port mapping NAT-PMP");
    expect(host.directHub.joinInfo?.joinCodeKind).toBe("internet");
  }, 30000);

  it("retryMs: 0 asks the router once only", async () => {
    let asked = 0;
    const gw = createSocket("udp4");
    gw.on("message", () => void asked++);
    await new Promise<void>((r) => gw.bind(0, "127.0.0.1", () => r()));
    cleanup.push(() => {
      gw.close();
    });
    const host = await hostIp(kit("Host"), {
      port: await freePort(), log: false,
      portMapping: { natPmp: { address: "127.0.0.1", port: gw.address().port }, tryUpnp: false, retryMs: 0 },
    });
    cleanup.push(() => host.leave());
    const once = asked;
    await new Promise((r) => setTimeout(r, 600));
    expect(asked).toBe(once);
  }, 30000);
});

describe("direct host startup line", () => {
  it("matches C# FormatHostLog character for character", () => {
    // the three strings are copied from clients/dotnet/OneLobby.DataChannel.Tests/DirectIpTests.cs
    expect(formatHostLog(47810, 47810, "6B01-RGFE-P2B", "internet", "UPnP"))
      .toBe("OneLobby: direct host listening on TCP+UDP :47810; code 6B01-RGFE-P2B (Internet); port mapping UPnP");
    expect(formatHostLog(47810, 47811, "0A00-0BSE-P3S", "same_network", "off"))
      .toBe("OneLobby: direct host listening on TCP+UDP :47811 (47810 busy); code 0A00-0BSE-P3S (SameNetwork); port mapping off");
    expect(formatHostLog(47810, 47813, "", "none", ""))
      .toBe("OneLobby: direct host listening on TCP+UDP :47813 (47810-47812 busy); no join code (no IPv4 address); port mapping off");
  });

  it("hostDirect calls the log option once with lobby.directHostLog; log: false prints nothing", async () => {
    const lines: string[] = [];
    const port = await freePort();
    const host = await hostIp(kit("Host"), { port, openPort: false, log: (l) => lines.push(l) });
    cleanup.push(() => host.leave());
    expect(lines).toEqual([host.directHostLog]);
    expect(host.directHostLog).toMatch(new RegExp(`^OneLobby: direct host listening on TCP\\+UDP :${port}; (code \\S+ \\((Internet|SameNetwork)\\)|no join code \\(no IPv4 address\\)); port mapping off$`));
    const seen: unknown[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => void seen.push(a);
    try {
      const quiet = await hostIp(kit("Quiet"), { port: await freePort(), openPort: false, log: false });
      cleanup.push(() => quiet.leave());
    } finally {
      console.log = real;
    }
    expect(seen).toEqual([]);
  });
});

describe("hostDirect + joinDirect over real WebRTC (node-datachannel)", () => {
  it("joins by the same-network code, carries both channels, ends with host_left", async () => {
    const port = await freePort();
    // exception to the loopback-only rule: the LAN code names this machine, so this host listens on every interface
    const host = await hostIp(kit("Host"), { bindHost: undefined, port, password: "pw", maxPlayers: 3, openPort: false });
    cleanup.push(() => host.leave());
    expect(host.portMapping).toBe("off");
    expect(host.directAddresses.length).toBeGreaterThan(0);
    // the LAN code needs an IPv4; fall back to loopback for machines without one
    const code = host.joinCode;
    const target = code || `127.0.0.1:${port}`;
    if (code) {
      expect(host.joinCodeKind).toBe("same_network");
      expect(decodeJoinCode(code)).toMatchObject({ port });
    }

    const got: string[] = [];
    host.on("message", (from, bytes, channel) => {
      got.push(`${channel}:${new TextDecoder().decode(bytes)}`);
      host.send(from, bytes, { channel: channel as "reliable" | "fast" });
    });
    const ann = await kit("Ann").joinDirect(target.toLowerCase().replace(/-/g, " "), { password: "pw" });
    cleanup.push(() => ann.leave());
    await ann.ready;
    expect(ann.peers.length).toBe(2);
    const echoes: string[] = [];
    ann.on("message", (_f, b, ch) => echoes.push(`${ch}:${new TextDecoder().decode(b)}`));
    ann.send(host.localPeerId, new TextEncoder().encode("hello"));
    const fast = setInterval(() => ann.send(host.localPeerId, new TextEncoder().encode("fast"), { channel: "fast" }), 50);
    await until(() => echoes.includes("reliable:hello") && echoes.includes("fast:fast"), "echoes");
    clearInterval(fast);

    let ended = "";
    ann.on("sessionEnded", (r) => (ended = r));
    await host.leave();
    await until(() => ended !== "", "joiner session end");
    expect(ended).toBe("host_left");
    // the joiner can see host_left before the host's end of its TCP socket has closed
    await until(() => host.directHub.connectionCount === 0, "hub sockets closed");
  }, 30000);

  it("host candidates that overtake the host's offer are kept for the joiner's link (not dropped)", async () => {
    // node-datachannel's native callbacks are unordered: a candidate can be signaled before the offer it belongs to
    const port = await freePort();
    const reorder: LinkFactory = {
      create(o) {
        const link = links.create(o);
        let out: PeerLink["onSignal"] = null;
        let held: SignalPayload | null = null;
        let sentIce = false;
        const release = () => {
          if (held) out?.(held);
          held = null;
        };
        Object.defineProperty(link, "onSignal", {
          get: () => (s: SignalPayload) => {
            if (s.sdp && !sentIce) {
              held = s;
              setTimeout(release, 1000);
              return;
            }
            out?.(s);
            if (s.ice && !sentIce) {
              sentIce = true;
              setTimeout(release, 0);
            }
          },
          set: (cb: PeerLink["onSignal"]) => (out = cb),
        });
        return link;
      },
    };
    const seen: string[] = [];
    const recording: LinkFactory = {
      create(o) {
        const link = links.create(o);
        const inner = link.handleSignal.bind(link);
        link.handleSignal = (s) => {
          seen.push(s.sdp ? s.sdp.type : "ice");
          return inner(s);
        };
        return link;
      },
    };
    const mk = (name: string, linkFactory: LinkFactory) =>
      new OneLobby({ gameId: "com.onelobby.directtest", netVersion: "1", lobbyServer: "", mode: "raw", displayName: name, rememberSeat: false, advanced: { linkFactory } });
    const host = await hostIp(mk("Host", reorder), { port, openPort: false });
    cleanup.push(() => host.leave());
    const ann = await mk("Ann", recording).joinDirect(`127.0.0.1:${port}`);
    cleanup.push(() => ann.leave());
    await ann.ready;
    expect(seen[0]).toBe("offer");
    expect(seen).toContain("ice");
  }, 30000);

  it("rejoinDirect takes a seat back with the resume token (same peer id); a dead token is invalid_token", async () => {
    const port = await freePort();
    const host = await hostIp(kit("Host"), { port, openPort: false });
    cleanup.push(() => host.leave());
    const old = await kit("Ann").joinDirect(`127.0.0.1:${port}`);
    await old.ready;
    const seat = old.localPeerId;
    const token = old.resumeToken;
    expect(token).toBeTruthy();

    await expect(kit("Ann").rejoinDirect(`127.0.0.1:${port}`, "not-a-token")).rejects.toMatchObject({ code: "invalid_token" });

    // a restart: a new kit takes the seat over while the old socket is still open
    const joined: number[] = [];
    host.on("peerJoined", (p) => joined.push(p.peerId));
    const back = await kit("Ann").rejoinDirect(encodeJoinCode("127.0.0.1", port), token);
    cleanup.push(() => back.leave(), () => old.leave());
    expect(back.localPeerId).toBe(seat);
    expect(back.joinCode).toBe(encodeJoinCode("127.0.0.1", port));
    expect(back.resumeToken).not.toBe(token);
    await back.ready;
    await until(() => joined.includes(seat), "host sees the seat come back");
    const got: string[] = [];
    host.on("message", (from, bytes) => got.push(`${from}:${new TextDecoder().decode(bytes)}`));
    back.send(host.localPeerId, new TextEncoder().encode("back again"));
    await until(() => got.length > 0, "message after rejoin");
    expect(got[0]).toBe(`${seat}:back again`);
  }, 30000);

  it("two joiners share the host's one UDP port", async () => {
    const port = await freePort();
    // capture the host's peer connections to read their local candidates
    const hostPcs: RTCPeerConnection[] = [];
    class Spy extends (loopbackRtc(RTCPeerConnection) as unknown as typeof globalThis.RTCPeerConnection) {
      constructor(c?: RTCConfiguration) {
        super(c);
        hostPcs.push(this as unknown as RTCPeerConnection);
      }
    }
    const hostKit = new OneLobby({ gameId: "com.onelobby.directtest", netVersion: "1", lobbyServer: "", mode: "raw", rememberSeat: false,
      advanced: { linkFactory: webRtcLinkFactoryFor(Spy) } });
    const host = await hostIp(hostKit, { port, openPort: false });
    cleanup.push(() => host.leave());
    const a = await kit("A").joinDirect(`127.0.0.1:${port}`);
    const b = await kit("B").joinDirect(`127.0.0.1:${port}`);
    cleanup.push(() => a.leave(), () => b.leave());
    await Promise.all([a.ready, b.ready]);
    await until(() => host.peers.length === 3, "host sees both");
    expect(hostPcs.length).toBe(2);
    for (const pc of hostPcs) {
      const ports = [...(pc.localDescription?.sdp ?? "").matchAll(/^a=candidate:\S+ \d \S+ \d+ \S+ (\d+) typ host/gm)].map((m) => Number(m[1]));
      expect(ports.length).toBeGreaterThan(0);
      expect(new Set(ports)).toEqual(new Set([port]));
    }
  }, 30000);

  it("mistyped code is bad_code at once; nobody listening is direct_unreachable", async () => {
    await expect(kit("x").joinDirect("6B01-RGFE-P2C")).rejects.toMatchObject({ code: "bad_code" });
    await expect(kit("x").joinDirect("nope nope")).rejects.toMatchObject({ code: "bad_address" });
    const port = await freePort();
    const t0 = Date.now();
    const e = await kit("x").joinDirect(`127.0.0.1:${port}`, { connectTimeoutMs: 2000 }).catch((x) => x);
    expect(e).toBeInstanceOf(OneLobbyError);
    expect(e.code).toBe("direct_unreachable");
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it("sockets over a direct lobby: onConnection + asWebSocket, rateLimit, host leaving is 1001 host_left, never hostChanged", async () => {
    const port = await freePort();
    const host = await hostIp(kit("Host"), { port, openPort: false, rateLimit: { messages: 5, perMs: 60_000 } });
    cleanup.push(() => host.leave());
    const got: string[] = [];
    host.onConnection((c) => (c.onmessage = (e) => { got.push(String(e.data)); c.send(`ok ${e.data}`); }));
    const a = await kit("A").joinDirect(`127.0.0.1:${port}`);
    cleanup.push(() => a.leave());
    const ws = a.asWebSocket();
    const replies: string[] = [];
    const closes: [number, string][] = [];
    let hostChanged = 0;
    a.on("hostChanged", () => hostChanged++);
    ws.onmessage = (e) => replies.push(String(e.data));
    ws.onclose = (e) => closes.push([e.code, e.reason]);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    for (let i = 0; i < 8; i++) ws.send(`m${i}`);
    await until(() => replies.length === 5, "five replies");
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toEqual(["m0", "m1", "m2", "m3", "m4"]); // the rest are over the cap
    await host.leave();
    await until(() => closes.length === 1, "joiner socket closes");
    expect(closes).toEqual([[1001, "host_left"]]);
    expect(hostChanged).toBe(0);
  }, 30000);

  it("second host on the same port is port_in_use", async () => {
    const port = await freePort();
    const a = await hostIp(kit("A"), { port, openPort: false });
    cleanup.push(() => a.leave());
    await expect(hostIp(kit("B"), { port, openPort: false })).rejects.toMatchObject({ code: "port_in_use" });
  });

  it("a busy port falls back to a later one (the code carries it); a joiner's joinCode is what it joined with", async () => {
    const port = await freePort();
    const a = await hostIp(kit("A"), { port, openPort: false });
    cleanup.push(() => a.leave());
    const b = await hostIp(kit("B"), { port, openPort: false, fallbackPorts: 3 });
    cleanup.push(() => b.leave());
    expect(b.directHub.port).toBeGreaterThan(port);
    expect(b.directHub.port).toBeLessThanOrEqual(port + 3);
    const j = await kit("J").joinDirect(`127.0.0.1:${b.directHub.port}`);
    cleanup.push(() => j.leave());
    expect(j.joinCode).toBe(encodeJoinCode("127.0.0.1", b.directHub.port));
  }, 30000);

  it("leave() resolves after the router mapping is deleted, so a host may exit right after it", async () => {
    // a NAT-PMP gateway on loopback: a map (lifetime > 0) or delete (lifetime 0) takes effect when the packet arrives
    const gw = createSocket("udp4");
    const mappings = new Map<string, number>();
    gw.on("message", (q, r) => {
      if (q[1] === 0) return void gw.send(Buffer.from([0, 128, 0, 0, 0, 0, 0, 1, 198, 51, 100, 9]), r.port, r.address);
      const internal = q.readUInt16BE(4);
      const life = q.readUInt32BE(8);
      if (life === 0) mappings.delete(`${q[1]} ${internal}`);
      else mappings.set(`${q[1]} ${internal}`, life);
      setTimeout(() => {
        const reply = Buffer.alloc(16);
        reply[1] = 128 + q[1];
        reply.writeUInt32BE(1, 4);
        reply.writeUInt16BE(internal, 8);
        reply.writeUInt16BE(life === 0 ? 0 : internal, 10);
        reply.writeUInt32BE(life, 12);
        gw.send(reply, r.port, r.address);
      }, 200);
    });
    await new Promise<void>((r) => gw.bind(0, "127.0.0.1", () => r()));
    cleanup.push(() => {
      gw.close();
    });
    const port = await freePort();
    const log: string[] = [];
    const host = await hostIp(kit("Host"), {
      port,
      portMapping: {
        ssdp: { address: "127.0.0.1", port: 9 }, natPmp: { address: "127.0.0.1", port: gw.address().port },
        tryUpnp: false, discoveryTimeoutMs: 800, log: (l) => log.push(l),
      },
    });
    expect(host.portMapping).toContain("NAT-PMP");
    expect(mappings.size).toBe(2);
    await host.leave();
    // the deletes are sent (the log comes after the sends complete) before leave() resolves; a real router is another
    // machine, this fake shares our event loop, so give loopback delivery a moment
    expect(log).toEqual([`direct host mapping deleted port=${port} protocols=TCP,UDP mapping=NAT-PMP`]);
    await until(() => mappings.size === 0, "gateway sees both deletes", 1000);
  }, 30000);
});

export type { Lobby };
