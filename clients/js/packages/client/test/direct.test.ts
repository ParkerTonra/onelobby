import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { OneLobby } from "../src/onelobby.js";
import type { Lobby } from "../src/lobby.js";
import { OneLobbyError } from "../src/signaling.js";
import { decodeJoinCode } from "../src/joincode.js";
import { webRtcLinkFactoryFor } from "../src/webrtc.js";
import { DirectHubHost, directHubOptions, hostDirect } from "../src/direct/index.js";

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

  it("GET /healthz answers ok and plain HTTP gets 426", async () => {
    const host = await DirectHubHost.listen(0, undefined, { host: "127.0.0.1" });
    cleanup.push(() => host.close());
    expect(await (await fetch(`http://127.0.0.1:${host.port}/healthz`)).text()).toBe("ok");
    expect((await fetch(`http://127.0.0.1:${host.port}/`)).status).toBe(426);
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
    expect(host.directHub.connectionCount).toBe(0);
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

  it("second host on the same port is port_in_use", async () => {
    const port = await freePort();
    const a = await hostDirect(kit("A"), { port, openPort: false });
    cleanup.push(() => a.leave());
    await expect(hostDirect(kit("B"), { port, openPort: false })).rejects.toMatchObject({ code: "port_in_use" });
  });
});

export type { Lobby };
