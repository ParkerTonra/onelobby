import { describe, expect, it } from "vitest";
import { RTCPeerConnection as NdcPeerConnection } from "node-datachannel/polyfill";
import { WebRtcLink } from "../src/webrtc.js";
import type { SignalPayload } from "../src/transport.js";

/** WebRtcLink against a scripted RTCPeerConnection: when channels are made, and what a peer that opens late sees. */

class FakeChannel {
  binaryType = "";
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(readonly label: string) {}
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  receive(text: string) {
    this.onmessage?.({ data: new TextEncoder().encode(text).buffer });
  }
  send() {}
}

class FakePc {
  static last: FakePc;
  channels: FakeChannel[] = [];
  remoteDescription: unknown = null;
  connectionState = "new";
  onicecandidate: unknown = null;
  onconnectionstatechange: unknown = null;
  constructor() {
    FakePc.last = this;
  }
  createDataChannel(label: string) {
    const c = new FakeChannel(label);
    this.channels.push(c);
    return c;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "v=0" };
  }
  async setLocalDescription() {}
  async setRemoteDescription(d: unknown) {
    this.remoteDescription = d;
  }
  async addIceCandidate() {}
  async getStats() {
    return new Map();
  }
  close() {}
}

const make = () => new WebRtcLink({ remoteId: 1, iceServers: [], relayOnly: false }, FakePc as unknown as typeof RTCPeerConnection);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("WebRtcLink", () => {
  it("the answerer makes no channels (so no offer of its own) until the remote offer is set", async () => {
    const link = make();
    const pc = FakePc.last;
    expect(pc.channels).toHaveLength(0);
    await link.handleSignal({ sdp: { type: "offer", sdp: "v=0" } });
    expect(pc.channels.map((c) => c.label)).toEqual(["reliable", "fast", "voice"]);
  });

  it("the offerer makes the channels before its offer", async () => {
    const link = make();
    const offers: string[] = [];
    link.onSignal = (s) => s.sdp && offers.push(s.sdp.type);
    link.startOffer();
    expect(FakePc.last.channels).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 0));
    expect(offers).toEqual(["offer"]);
  });

  it("data that arrives before every channel is open waits for onOpen, then comes in order", async () => {
    const link = make();
    await link.handleSignal({ sdp: { type: "offer", sdp: "v=0" } });
    const [reliable, fast, voice] = FakePc.last.channels;
    const seen: string[] = [];
    link.onOpen = () => seen.push("open");
    link.onMessage = (ch, b) => seen.push(`${ch}:${text(b)}${link.isOpen ? "" : " (before open)"}`);
    reliable.open();
    reliable.receive("hi");
    reliable.receive("hello");
    fast.open();
    fast.receive("f");
    expect(seen).toEqual([]);
    voice.open();
    reliable.receive("after");
    expect(seen).toEqual(["open", "reliable:hi", "reliable:hello", "fast:f", "reliable:after"]);
  });

  it("a remote candidate that arrives before the remote description waits for it (node-datachannel's is never null)", async () => {
    // node-datachannel's polyfill answers remoteDescription with an object even before one is set, and its
    // addIceCandidate throws until then. A joiner's candidate can beat its answer to the host (its native callbacks are
    // not ordered), which used to close the host's link: the joiner then timed out with ice_failed.
    class NdcLikePc extends FakePc {
      added: unknown[] = [];
      private set = false;
      constructor() {
        super();
        Object.defineProperty(this, "remoteDescription", { get: () => ({ type: undefined, sdp: "" }) });
      }
      async setRemoteDescription() {
        this.set = true;
      }
      async addIceCandidate(c: unknown) {
        if (!this.set) throw new Error("InvalidStateError: Got a remote candidate without remote description");
        this.added.push(c);
      }
    }
    const link = new WebRtcLink({ remoteId: 1, iceServers: [], relayOnly: false }, NdcLikePc as unknown as typeof RTCPeerConnection);
    const pc = FakePc.last as NdcLikePc;
    const closed: string[] = [];
    link.onClose = (r) => closed.push(r);
    link.startOffer();
    await link.handleSignal({ ice: { candidate: "candidate:1 1 UDP 1 192.0.2.7 5000 typ host", sdpMid: "0" } as never });
    expect(closed).toEqual([]);
    expect(pc.added).toHaveLength(0);
    await link.handleSignal({ sdp: { type: "answer", sdp: "v=0" } });
    expect(closed).toEqual([]);
    expect(pc.added).toHaveLength(1);
  });

  it("real WebRTC (node-datachannel): opens when the answerer's candidates reach the offerer before its answer", async () => {
    const rtc = NdcPeerConnection as unknown as typeof RTCPeerConnection;
    const a = new WebRtcLink({ remoteId: 2, iceServers: [], relayOnly: false }, rtc);
    const b = new WebRtcLink({ remoteId: 1, iceServers: [], relayOnly: false }, rtc);
    const closed: string[] = [];
    a.onClose = (r) => closed.push(`a:${r}`);
    b.onClose = (r) => closed.push(`b:${r}`);
    let heldAnswer: SignalPayload | null = null;
    let candidatesToA = 0;
    a.onSignal = (s) => void b.handleSignal(s);
    // the answerer's candidates go at once; its answer only once a candidate has gone ahead of it
    b.onSignal = (s) => {
      if (s.sdp) heldAnswer = s;
      else {
        candidatesToA++;
        void a.handleSignal(s);
      }
    };
    const opened = Promise.all([new Promise<void>((r) => (a.onOpen = () => r())), new Promise<void>((r) => (b.onOpen = () => r()))]);
    a.startOffer();
    const t0 = Date.now();
    while (!(heldAnswer && candidatesToA > 0)) {
      if (Date.now() - t0 > 5000) throw new Error("no answer or candidate");
      await new Promise((r) => setTimeout(r, 5));
    }
    await a.handleSignal(heldAnswer!);
    await Promise.race([opened, new Promise((_, j) => setTimeout(() => j(new Error(`never opened; closed: ${closed.join(", ")}`)), 8000))]);
    expect(closed).toEqual([]);
    a.close();
    b.close();
  }, 15000);
});
