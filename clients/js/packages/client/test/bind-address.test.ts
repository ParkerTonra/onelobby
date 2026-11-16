import { describe, expect, it } from "vitest";
import { loopbackBindAddress } from "../src/direct-address.js";
import { WebRtcLink } from "../src/webrtc.js";
import { decodeJoinCode } from "../src/joincode.js";
import { OneLobby } from "../src/onelobby.js";
import { hostDirect } from "../src/direct/index.js";

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

describe("hostDirect({ local: true }) is the JS --local", () => {
  const kitFor = (name: string) => new OneLobby({ gameId: "com.onelobby.localtest", netVersion: "1", lobbyServer: "", mode: "raw", displayName: name, rememberSeat: false });

  it("binds loopback with no router request and no Nostr: the join code is the IP code and names 127.0.0.1", async () => {
    const host = await hostDirect(kitFor("Ann"), { local: true, port: 0, log: false });
    try {
      expect(host.joinCode).toBe(host.directCode);
      expect(decodeJoinCode(host.joinCode)).toMatchObject({ ip: "127.0.0.1" });
      expect(host.directAddresses.every((a: string) => a.startsWith("127.0.0.1"))).toBe(true);
    } finally {
      await host.leave();
    }
  });

  it("negative control: without local, Nostr stays on (the join code is a Nostr code, apart from the IP code)", async () => {
    const host = await hostDirect(kitFor("Bob"), { bindHost: "127.0.0.1", openPort: false, port: 0, log: false, nostr: { relays: [], stun: [] } });
    try {
      expect(host.joinCode).not.toBe(host.directCode);
    } finally {
      await host.leave();
    }
  });
});
