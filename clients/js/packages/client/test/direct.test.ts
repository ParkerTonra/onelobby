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
import { DirectHubHost, defaultHubOptions, directHubOptions, hostDirect, originAllowed } from "../src/direct/index.js";
import { PortInUseError, portFailureHint } from "../src/direct/hub-host.js";

/**
 * Direct IP in Node (docs/direct-ip.md): a Node process hosts with onelobby/direct, joiners use kit.joinDirect, real
 * WebRTC through node-datachannel (libdatachannel) on loopback. No server anywhere.
 */

const links = webRtcLinkFactoryFor(RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection);
const kit = (name: string) =>
  new OneLobby({ gameId: "com.onelobby.directtest", netVersion: "1", lobbyServer: "", mode: "raw", displayName: name, rememberSeat: false, advanced: { linkFactory: links } });

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

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
    expect(await (await fetch(`http://127.0.0.1:${host.port}/healthz`)).text()).toBe("ok");
    expect((await fetch(`http://127.0.0.1:${host.port}/`)).status).toBe(426);
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
});

describe("hostDirect + joinDirect over real WebRTC (node-datachannel)", () => {
  it("joins by the same-network code, carries both channels, ends with host_left", async () => {
    const port = await freePort();
    const host = await hostDirect(kit("Host"), { port, password: "pw", maxPlayers: 3, openPort: false });
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
    const host = await hostDirect(mk("Host", reorder), { port, openPort: false });
    cleanup.push(() => host.leave());
    const ann = await mk("Ann", recording).joinDirect(`127.0.0.1:${port}`);
    cleanup.push(() => ann.leave());
    await ann.ready;
    expect(seen[0]).toBe("offer");
    expect(seen).toContain("ice");
  }, 30000);

  it("rejoinDirect takes a seat back with the resume token (same peer id); a dead token is invalid_token", async () => {
    const port = await freePort();
    const host = await hostDirect(kit("Host"), { port, openPort: false });
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
    class Spy extends (RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection) {
      constructor(c?: RTCConfiguration) {
        super(c);
        hostPcs.push(this as unknown as RTCPeerConnection);
      }
    }
    const hostKit = new OneLobby({ gameId: "com.onelobby.directtest", netVersion: "1", lobbyServer: "", mode: "raw", rememberSeat: false,
      advanced: { linkFactory: webRtcLinkFactoryFor(Spy) } });
    const host = await hostDirect(hostKit, { port, openPort: false });
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
    const host = await hostDirect(kit("Host"), { port, openPort: false, rateLimit: { messages: 5, perMs: 60_000 } });
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
    const a = await hostDirect(kit("A"), { port, openPort: false });
    cleanup.push(() => a.leave());
    await expect(hostDirect(kit("B"), { port, openPort: false })).rejects.toMatchObject({ code: "port_in_use" });
  });

  it("a busy port falls back to a later one (the code carries it); a joiner's joinCode is what it joined with", async () => {
    const port = await freePort();
    const a = await hostDirect(kit("A"), { port, openPort: false });
    cleanup.push(() => a.leave());
    const b = await hostDirect(kit("B"), { port, openPort: false, fallbackPorts: 3 });
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
    const host = await hostDirect(kit("Host"), {
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
