import { describe, expect, it } from "vitest";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { OneLobby } from "../src/onelobby.js";
import { webRtcLinkFactoryFor } from "../src/webrtc.js";
import { checkNostrRelays, DEFAULT_NOSTR_RELAYS } from "../src/nostr/relays.js";
import { hostDirect } from "../src/direct/index.js";
import { freePort } from "./helpers.js";

/**
 * Real public relays and real STUN, anonymous (random keys, encrypted frames, nothing about anyone).
 * Run: ONELOBBY_LIVE_NOSTR=1 npx vitest run test/nostr-live.test.ts
 */
const live = process.env.ONELOBBY_LIVE_NOSTR === "1";
const links = webRtcLinkFactoryFor(RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection);
const mk = (name: string) =>
  new OneLobby({ gameId: "com.onelobby.livetest", netVersion: "1", lobbyServer: "", mode: "raw", displayName: name, rememberSeat: false, advanced: { linkFactory: links } });

describe.skipIf(!live)("live Nostr signaling", () => {
  it("the default relays: probe", async () => {
    const res = await checkNostrRelays([...DEFAULT_NOSTR_RELAYS], 10_000);
    console.log(res.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.url} ${r.ms} ms${r.error ? " " + r.error : ""}`).join("\n"));
    expect(res.filter((r) => r.ok).length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("host and joiner meet through real relays and exchange a message over WebRTC", async () => {
    const lines: string[] = [];
    const host = await hostDirect(mk("Host"), { port: await freePort(), openPort: false, log: (l) => lines.push(l) });
    try {
      console.log(lines[0]);
      expect(host.joinCodeKind).toBe("nostr");
      const t0 = Date.now();
      const ann = await mk("Ann").joinDirect(host.joinCode);
      try {
        await ann.ready;
        console.log(`joined in ${Date.now() - t0} ms`);
        const got: string[] = [];
        host.on("message", (_f, b) => got.push(new TextDecoder().decode(b)));
        ann.send(host.localPeerId, new TextEncoder().encode("hello over nostr"));
        const start = Date.now();
        while (got.length === 0 && Date.now() - start < 10_000) await new Promise((r) => setTimeout(r, 20));
        expect(got).toEqual(["hello over nostr"]);
      } finally {
        await ann.leave();
      }
    } finally {
      await host.leave();
    }
  }, 60_000);
});
