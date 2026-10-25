import { describe, expect, it } from "vitest";
import { WebRtcLink } from "../src/webrtc.js";

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
});
