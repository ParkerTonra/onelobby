import { afterEach, describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { build } from "esbuild";
import { OneLobby } from "../src/onelobby.js";
import { OneLobbyError } from "../src/signaling.js";
import { decodeJoinCode } from "../src/joincode.js";
import { webRtcLinkFactoryFor } from "../src/webrtc.js";
import { describeError, ErrorCodes } from "../src/friendly.js";
import { SignalingHub, directHubOptions } from "../src/direct/hub.js";
import { hmacSha1, sha1, turnCredential } from "../src/direct/sha1.js";
import type { VisibilityDoc } from "../src/direct/browser-host.js";
import { loopbackRtc } from "./helpers.js";
import { FakeRelays } from "./fake-relay.js";

const URLS = ["wss://r1.test", "wss://r2.test"];
const links = webRtcLinkFactoryFor(loopbackRtc(RTCPeerConnection) as unknown as typeof globalThis.RTCPeerConnection);

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

const mk = (name: string, relays: FakeRelays) =>
  new OneLobby({ gameId: "com.onelobby.browserhost", netVersion: "1", lobbyServer: "", mode: "raw", displayName: name, rememberSeat: false, advanced: { linkFactory: links, nostrConnect: relays.connect } });

const nostr = { relays: URLS, stun: [] };

/** A document stand-in: `visibilityState` plus the listeners. */
function fakeDoc(): VisibilityDoc & { state: string; set(s: string): void; listeners: Set<() => void> } {
  const listeners = new Set<() => void>();
  const d = {
    state: "visible",
    listeners,
    get visibilityState() {
      return d.state;
    },
    addEventListener: (_t: string, l: () => void) => void listeners.add(l),
    removeEventListener: (_t: string, l: () => void) => void listeners.delete(l),
    set(s: string) {
      d.state = s;
      for (const l of [...listeners]) l();
    },
  };
  return d as unknown as VisibilityDoc & { state: string; set(s: string): void; listeners: Set<() => void> };
}

describe("kit.hostNostr (browser host code path)", () => {
  it("hosts with a Nostr code, two joiners (one over asWebSocket, host side over onConnection), startup line", async () => {
    const relays = new FakeRelays();
    const lines: string[] = [];
    const host = await mk("Host", relays).hostNostr({ nostr, log: (l) => lines.push(l), maxPlayers: 3, document: null });
    cleanup.push(() => host.leave());
    expect(host.joinCodeKind).toBe("nostr");
    expect("room" in decodeJoinCode(host.joinCode)).toBe(true);
    expect(host.directCode).toBe("");
    expect(host.directCodeKind).toBe("none");
    expect(lines).toEqual([host.directHostLog]);
    expect(lines[0]).toBe(`OneLobby: browser host (no port); code ${host.joinCode} (Nostr); nostr 2/2 relays`);

    // host-side game logic over WebSocket-shaped conns
    const got: string[] = [];
    host.onConnection((c) => {
      c.onmessage = (e) => {
        got.push(String(e.data));
        c.send(`ok ${e.data}`);
      };
    });
    const ann = await mk("Ann", relays).joinDirect(host.joinCode, { nostrRelays: URLS, stun: [] });
    cleanup.push(() => ann.leave());
    const ws = ann.asWebSocket();
    const replies: string[] = [];
    ws.onmessage = (e) => replies.push(String(e.data));
    await new Promise<void>((r) => (ws.onopen = () => r()));
    ws.send("ping 1");
    await until(() => replies.length === 1, "reply over the socket");
    expect(replies[0]).toBe("ok ping 1");
    expect(got).toEqual(["ping 1"]);

    // a second joiner talks raw
    const bob = await mk("Bob", relays).joinDirect(host.joinCode, { nostrRelays: URLS, stun: [] });
    cleanup.push(() => bob.leave());
    await bob.ready;
    await until(() => host.peers.length === 3 && bob.peers.length === 3, "everyone sees everyone");
    const back: string[] = [];
    bob.on("message", (_f, b) => back.push(new TextDecoder().decode(b)));
    host.broadcast(new TextEncoder().encode("hi all"));
    await until(() => back.length > 0, "broadcast reaches the second joiner");

    // host leaving: joiners learn it
    const closes: number[] = [];
    ws.onclose = (e) => closes.push(e.code);
    await host.leave();
    await until(() => closes.length === 1, "joiner socket closes");
    expect(closes[0]).toBe(1001);
  }, 40000);

  it("password is enforced", async () => {
    const relays = new FakeRelays();
    const host = await mk("Host", relays).hostNostr({ nostr, log: false, password: "pw", document: null });
    cleanup.push(() => host.leave());
    await expect(mk("X", relays).joinDirect(host.joinCode, { nostrRelays: URLS, stun: [] })).rejects.toMatchObject({ code: "bad_password" });
    const ok = await mk("Y", relays).joinDirect(host.joinCode, { nostrRelays: URLS, stun: [], password: "pw" });
    cleanup.push(() => ok.leave());
    await ok.ready;
  }, 30000);

  it("no relay reachable: direct_unreachable naming relays, nothing left running", async () => {
    const relays = new FakeRelays();
    for (const u of URLS) relays.down.add(u);
    const e = await mk("Host", relays).hostNostr({ nostr, log: false, relayTimeoutMs: 400, document: null }).catch((x) => x);
    expect(e).toBeInstanceOf(OneLobbyError);
    expect(e.code).toBe("direct_unreachable");
    expect(e.message).toMatch(/no Nostr relay reachable/);
  });

  it("hidden tab: hostHidden, hostHiddenChanged and a warning; visible again clears it; listener removed on leave", async () => {
    const relays = new FakeRelays();
    const doc = fakeDoc();
    const warns: string[] = [];
    const host = await mk("Host", relays).hostNostr({ nostr, log: false, warn: (w) => warns.push(w), document: doc });
    expect(host.hostHidden).toBe(false);
    const seen: boolean[] = [];
    host.on("hostHiddenChanged", (h) => seen.push(h));
    doc.set("hidden");
    doc.set("hidden"); // no change, no second event
    expect(host.hostHidden).toBe(true);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/keep this tab visible/i);
    doc.set("visible");
    expect(host.hostHidden).toBe(false);
    expect(seen).toEqual([true, false]);
    await host.leave();
    expect(doc.listeners.size).toBe(0);
  });

  it("starts hidden: hostHidden is true at once", async () => {
    const relays = new FakeRelays();
    const doc = fakeDoc();
    doc.state = "hidden";
    const host = await mk("Host", relays).hostNostr({ nostr, log: false, warn: false, document: doc });
    cleanup.push(() => host.leave());
    expect(host.hostHidden).toBe(true);
  });

  it("blueprint: lobby.* and hosting.nostrRelays apply; hosting.nostr false is nostr_disabled", async () => {
    const relays = new FakeRelays();
    const bp = { game: { id: "com.onelobby.browserhost" }, lobby: { maxPlayers: 2, meta: { mode: "co-op" } }, hosting: { nostrRelays: URLS } };
    const kit = OneLobby.fromConfig(bp, { displayName: "Ann", advanced: { linkFactory: links, nostrConnect: relays.connect } });
    const host = await kit.hostNostr({ log: false, document: null, nostr: { stun: [] } });
    cleanup.push(() => host.leave());
    expect(host.meta).toEqual({ mode: "co-op" });
    expect(host.name).toBe("Ann's game");
    expect(relays.sockets.length).toBeGreaterThan(0);
    const a = await mk("A", relays).joinDirect(host.joinCode, { nostrRelays: URLS, stun: [] });
    cleanup.push(() => a.leave());
    await a.ready;
    await expect(mk("B", relays).joinDirect(host.joinCode, { nostrRelays: URLS, stun: [], connectTimeoutMs: 3000 })).rejects.toMatchObject({ code: "lobby_full" });

    const off = OneLobby.fromConfig({ game: { id: "com.onelobby.browserhost" }, hosting: { nostr: false } }, { advanced: { nostrConnect: relays.connect } });
    const e = await off.hostNostr({ log: false, document: null }).catch((x) => x);
    expect(e).toBeInstanceOf(OneLobbyError);
    expect(e.code).toBe(ErrorCodes.NostrDisabled);
    expect(e.code).toBe("nostr_disabled");
    expect(describeError(e).message).toMatch(/browser/);
    expect(describeError({ code: "direct_unreachable" }).message).not.toMatch(/something went wrong/i);
  }, 30000);
});

describe("hub without node:crypto", () => {
  it("sha1 and hmac-sha1 match node:crypto", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = new Uint8Array(n).map((_, i) => (i * 7 + n) & 255);
      expect(Buffer.from(sha1(data)).toString("hex")).toBe(createHash("sha1").update(data).digest("hex"));
    }
    const key = new Uint8Array(100).fill(9);
    expect(Buffer.from(hmacSha1(key, new TextEncoder().encode("abc"))).toString("hex")).toBe(createHmac("sha1", key).update("abc").digest("hex"));
    expect(turnCredential("s3cret", "1700000000:abcdef")).toBe(createHmac("sha1", "s3cret").update("1700000000:abcdef").digest("base64"));
  });

  it("the hub still issues a TURN credential when configured", () => {
    const hub = new SignalingHub({ ...directHubOptions(4, null), turnUrls: ["turn:t.test:3478"], turnSecret: "s3cret", singleLobby: false, issueCodes: true }, { now: () => 1_700_000_000_000 });
    const out: string[] = [];
    const s = hub.connect("1.2.3.4", (t) => out.push(t), () => {})!;
    hub.receive(s, JSON.stringify({ t: "hello", proto: "lk1", gameId: "g", netVersion: "1", name: "A" }));
    const welcome = JSON.parse(out.find((t) => t.includes('"welcome"'))!);
    const turn = welcome.ice.find((i: { username?: string }) => i.username);
    expect(turn.credential).toBe(createHmac("sha1", "s3cret").update(turn.username).digest("base64"));
  });

  it("the browser bundles contain no node: imports (esbuild for the browser resolves none)", async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const r = await build({ entryPoints: [join(root, "src", "global.ts")], bundle: true, write: false, format: "iife", platform: "browser", logLevel: "silent", metafile: true });
    expect(r.errors).toHaveLength(0);
    const text = r.outputFiles[0].text;
    expect(text).not.toMatch(/node:(crypto|net|dgram|fs|os|http)/);
    expect(text).toContain("browser host (no port)"); // hostNostr is in the bundle
    const inputs = Object.keys(r.metafile!.inputs);
    expect(inputs.some((i) => i.replace(/\\/g, "/").endsWith("direct/hub-host.ts"))).toBe(false);
    expect(inputs.some((i) => i.replace(/\\/g, "/").endsWith("direct/hub.ts"))).toBe(true);
  });
});
