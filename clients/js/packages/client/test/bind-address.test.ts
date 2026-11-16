import { describe, expect, it } from "vitest";
import { loopbackBindAddress } from "../src/direct-address.js";
import { WebRtcLink } from "../src/webrtc.js";

/** An RTCPeerConnection stand-in that only records its configuration: no socket, no native. */
function recordingRtc(seen: Record<string, unknown>[]): typeof RTCPeerConnection {
  return class {
    constructor(config: Record<string, unknown>) {
      seen.push(config);
    }
  } as unknown as typeof RTCPeerConnection;
}

describe("loopback ICE bind address", () => {
  it("names 127.0.0.1 only for a host on this PC", () => {
    expect(loopbackBindAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(loopbackBindAddress("127.0.0.5")).toBe("127.0.0.1");
    expect(loopbackBindAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(loopbackBindAddress("192.168.1.20")).toBeUndefined();
    expect(loopbackBindAddress("203.0.113.7")).toBeUndefined();
    expect(loopbackBindAddress("example.com")).toBeUndefined();
    expect(loopbackBindAddress(undefined)).toBeUndefined();
  });

  it("WebRtcLink hands bindAddress to the peer connection, and leaves it out by default", () => {
    const seen: Record<string, unknown>[] = [];
    const base = { remoteId: 2, iceServers: [], relayOnly: false };
    new WebRtcLink({ ...base, bindAddress: "127.0.0.1" }, recordingRtc(seen));
    new WebRtcLink(base, recordingRtc(seen));
    expect(seen[0]!.bindAddress).toBe("127.0.0.1");
    expect("bindAddress" in seen[1]!).toBe(false);
  });

  it("a local run has no ICE servers at all: an empty list stays empty (no default STUN is added), a given one is kept", () => {
    const seen: Record<string, unknown>[] = [];
    new WebRtcLink({ remoteId: 2, iceServers: [], relayOnly: false, bindAddress: "127.0.0.1" }, recordingRtc(seen));
    new WebRtcLink({ remoteId: 2, iceServers: [{ urls: ["stun:stun.example:3478"] }], relayOnly: false }, recordingRtc(seen));
    expect(seen[0]!.iceServers).toEqual([]);
    expect(seen[1]!.iceServers).toEqual([{ urls: ["stun:stun.example:3478"] }]);
  });
});
