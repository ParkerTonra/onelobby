import { describe, expect, it } from "vitest";
import { SignalingClient } from "../src/signaling.js";
import type { SocketLike } from "../src/transport.js";
import type { Clock } from "../src/clock.js";

/** SignalingClient against a scripted socket that can deliver several messages in one go, as one TCP read does. */

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** Back-to-back events with no await in between. */
  deliver(...msgs: object[]) {
    for (const m of msgs) this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const clock: Clock = { now: () => Date.now(), setInterval: () => () => {}, setTimeout: () => () => {} };

describe("SignalingClient", () => {
  it("keeps a message that lands with the join reply, before anyone listens, and hands it over in order", async () => {
    const s = new FakeSocket();
    const sig = new SignalingClient("ws://x", () => s, clock);
    const connected = sig.connect();
    s.open();
    await connected;
    const joined = sig.request<{ t: string }>({ t: "join" }, "lobby");
    s.deliver({ t: "lobby", code: "ABC" }, { t: "signal", from: 1, sdp: { type: "offer", sdp: "v=0" } }, { t: "peer_joined", peer: { peerId: 3 } });
    expect((await joined).t).toBe("lobby");
    const got: string[] = [];
    sig.onMessage = (m) => got.push(m.t);
    expect(got).toEqual(["signal", "peer_joined"]);
    s.deliver({ t: "phase" });
    expect(got).toEqual(["signal", "peer_joined", "phase"]);
  });
});
