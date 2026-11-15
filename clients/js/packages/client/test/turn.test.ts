import { describe, expect, it } from "vitest";
import { SignalingHub, directHubOptions } from "../src/direct/hub.js";
import { parseTurnLine, turnCredential, turnLogin } from "../src/turn.js";
import { WebRtcLink, isRelayCandidate } from "../src/webrtc.js";
import { hasTurn } from "../src/transport.js";
import { OneLobby } from "../src/onelobby.js";
import { specJson } from "./spec.js";

const turn = { urls: ["turn:turn.example.com:3478"], username: "1:x", credential: "c" };

describe("TURN logins (spec/vectors/turn-rest.json)", () => {
  const v = specJson("vectors/turn-rest.json");
  it("credential matches every vector", () => {
    for (const x of v.vectors) expect(turnCredential(x.secret, x.username)).toBe(x.credential);
  });
  it("login mints the pinned username and credential", () => {
    const m = v.mint;
    expect(turnLogin(m.secret, m.userId, m.ttl, m.nowSeconds)).toEqual({ username: m.expectUsername, credential: m.expectCredential });
  });
  it("login drops colons from the user id and defaults to the clock", () => {
    expect(turnLogin("s", "a:b", 60, 100).username).toBe("160:ab");
    const l = turnLogin("s", "p", 60);
    expect(Number(l.username.split(":")[0])).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe("parseTurnLine (spec/vectors/turn-paste.json)", () => {
  for (const c of specJson("vectors/turn-paste.json").cases) {
    it(JSON.stringify(c.input), () => {
      if (c.error) expect(() => parseTurnLine(c.input)).toThrow();
      else expect(parseTurnLine(c.input)).toEqual(c.ok);
    });
  }
});

describe("Direct hub welcome.ice", () => {
  const welcome = (o: ReturnType<typeof directHubOptions>) => {
    const hub = new SignalingHub(o, { now: () => 1_700_000_000_000 });
    const out: any[] = [];
    const s = hub.connect("10.0.0.1", (t) => out.push(JSON.parse(t)), () => {})!;
    hub.receive(s, JSON.stringify({ t: "hello", proto: "lk1", gameId: "g", netVersion: "1", name: "x" }));
    return out.find((m) => m.t === "welcome");
  };
  it("puts ice_servers after the STUN entry, verbatim", () => {
    const w = welcome({ ...directHubOptions(4, null, [turn]), stunUrls: ["stun:s.example:3478"] });
    expect(w.ice).toEqual([{ urls: ["stun:s.example:3478"] }, turn]);
  });
  it("has the TURN entry alone without STUN, and nothing without either", () => {
    expect(welcome(directHubOptions(4, null, [turn])).ice).toEqual([turn]);
    expect(welcome(directHubOptions(4, null)).ice).toEqual([]);
  });
});

describe("relay-only enforcement", () => {
  const sdp = ["v=0", "a=candidate:1 1 UDP 1 10.0.0.1 5000 typ host", "a=candidate:2 1 UDP 1 1.2.3.4 6000 typ relay raddr 0.0.0.0 rport 0", "a=mid:0", ""].join("\r\n");
  class FakePc {
    static last: FakePc;
    remote = "";
    added: any[] = [];
    onicecandidate: ((e: any) => void) | null = null;
    onconnectionstatechange: unknown = null;
    connectionState = "new";
    constructor(public config: any) {
      FakePc.last = this;
    }
    createDataChannel() {
      return {};
    }
    async createOffer() {
      return { type: "offer", sdp };
    }
    async createAnswer() {
      return { type: "answer", sdp };
    }
    async setLocalDescription() {}
    async setRemoteDescription(d: { sdp: string }) {
      this.remote = d.sdp;
    }
    async addIceCandidate(c: unknown) {
      this.added.push(c);
    }
    close() {}
  }
  const mk = (relayOnly: boolean, extra: string[] = []) => {
    const link = new WebRtcLink({ remoteId: 1, iceServers: [], relayOnly, extraRemoteCandidates: extra }, FakePc as never);
    const sent: any[] = [];
    link.onSignal = (s) => sent.push(s);
    return { link, sent, pc: () => FakePc.last };
  };
  const cand = (candidate: string) => ({ candidate: candidate, sdpMid: "0", sdpMLineIndex: 0 });

  it("recognises relay candidates", () => {
    expect(isRelayCandidate("candidate:2 1 UDP 1 1.2.3.4 6000 typ relay raddr 0.0.0.0 rport 0")).toBe(true);
    expect(isRelayCandidate("candidate:1 1 UDP 1 10.0.0.1 5000 typ host")).toBe(false);
    expect(isRelayCandidate("candidate:1 1 UDP 1 10.0.0.1 5000 typ srflx raddr 1.1.1.1 rport 1")).toBe(false);
  });
  it("relay-only sends and takes only relay candidates, in signals and in SDP", async () => {
    const { link, sent, pc } = mk(true, ["candidate:9 1 UDP 1 9.9.9.9 47810 typ host"]);
    expect(pc().config.iceTransportPolicy).toBe("relay");
    link.startOffer();
    await new Promise((r) => setTimeout(r, 5));
    const offer = sent.find((s) => s.sdp).sdp.sdp as string;
    expect(offer).toContain("typ relay");
    expect(offer).not.toContain("typ host");
    pc().onicecandidate!({ candidate: { candidate: "candidate:1 1 UDP 1 10.0.0.1 5000 typ host", toJSON: () => cand("candidate:1 1 UDP 1 10.0.0.1 5000 typ host") } });
    pc().onicecandidate!({ candidate: { candidate: "candidate:2 1 UDP 1 1.2.3.4 6000 typ relay", toJSON: () => cand("candidate:2 1 UDP 1 1.2.3.4 6000 typ relay") } });
    expect(sent.filter((s) => s.ice).map((s) => s.ice.candidate)).toEqual(["candidate:2 1 UDP 1 1.2.3.4 6000 typ relay"]);
    await link.handleSignal({ sdp: { type: "offer", sdp } });
    expect(pc().remote).not.toContain("typ host");
    expect(pc().remote).toContain("typ relay");
    await link.handleSignal({ ice: cand("candidate:5 1 UDP 1 5.5.5.5 1 typ host") });
    await link.handleSignal({ ice: cand("candidate:6 1 UDP 1 6.6.6.6 1 typ relay") });
    expect(pc().added.map((c) => c.candidate)).toEqual(["candidate:6 1 UDP 1 6.6.6.6 1 typ relay"]);
  });
  it("a typed address the offer already carries as a host candidate is not added twice", async () => {
    const offer = "v=0\r\na=candidate:1 1 UDP 2114977791 10.0.0.1 5000 typ host\r\n";
    const same = mk(false, ["candidate:1 1 UDP 2122317823 10.0.0.1 5000 typ host"]);
    await same.link.handleSignal({ sdp: { type: "offer", sdp: offer } });
    expect(same.pc().added.length).toBe(0);
    const other = mk(false, ["candidate:1 1 UDP 2122317823 203.0.113.7 5000 typ host"]);
    await other.link.handleSignal({ sdp: { type: "offer", sdp: offer } });
    expect(other.pc().added.length).toBe(1);
  });
  it("a normal link passes everything through", async () => {
    const { link, sent, pc } = mk(false, ["candidate:9 1 UDP 1 9.9.9.9 47810 typ host"]);
    link.startOffer();
    await new Promise((r) => setTimeout(r, 5));
    expect(sent.find((s) => s.sdp).sdp.sdp).toBe(sdp);
    await link.handleSignal({ sdp: { type: "offer", sdp } });
    expect(pc().remote).toBe(sdp);
    expect(pc().added.length).toBe(1);
  });
});

describe("hasTurn", () => {
  it("sees turn: and turns: urls only", () => {
    expect(hasTurn({ urls: "stun:a" })).toBe(false);
    expect(hasTurn({ urls: ["stun:a", "turns:b:443"] })).toBe(true);
    expect(hasTurn(turn)).toBe(true);
  });
});

describe("joiner ice_servers", () => {
  it("adds its own entries after the host's, and after default STUN for a Nostr code", () => {
    const kit = new OneLobby({ gameId: "g", netVersion: "1", lobbyServer: "", mode: "raw", displayName: "J", rememberSeat: false });
    const w = (kit as any).withStun({ t: "welcome", ice: [{ urls: ["stun:h"] }, turn] }, { nostr: null }, { iceServers: [{ urls: "turn:mine:3478" }] });
    expect(w.ice.map((e: any) => e.urls)).toEqual([["stun:h"], turn.urls, "turn:mine:3478"]);
    const n = (kit as any).withStun({ t: "welcome", ice: [] }, { nostr: "X" }, { stun: ["stun:s"], iceServers: [turn] });
    expect(n.ice).toEqual([{ urls: ["stun:s"] }, turn]);
    const same = { t: "welcome", ice: [turn] };
    expect((kit as any).withStun(same, { nostr: null }, {})).toBe(same);
  });
});
