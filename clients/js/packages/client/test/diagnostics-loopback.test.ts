import { afterEach, describe, expect, it } from "vitest";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { OneLobby, describeError } from "../src/index.js";
import type { PeerDiagnosis } from "../src/lobby.js";
import { webRtcLinkFactoryFor } from "../src/webrtc.js";
import type { LinkFactory, PeerLink, SignalPayload } from "../src/transport.js";
import { hostDirect } from "../src/direct/index.js";
import { freePort, loopbackRtc } from "./helpers.js";
import { fakeTurn, type Fake } from "./udp-fakes.js";

/**
 * The plan's "Done when" (docs/design/one-shot.md s.4) as a real test on 127.0.0.1: a joiner whose direct path cannot work
 * sees its cause on its own side within the ready timeout, the host receives the same sentence by name, and the exported
 * log names the cause. Real WebRTC through node-datachannel; nothing leaves the machine.
 */
const real = webRtcLinkFactoryFor(loopbackRtc(RTCPeerConnection) as unknown as typeof globalThis.RTCPeerConnection);

/**
 * Simulated strict NAT: both sides gather and send their candidates as usual, but none that arrive is handed to ICE (a
 * relay candidate still is), so no candidate pair can ever form. The typed address a joiner dials is dropped too.
 */
function strictNat(inner: LinkFactory): LinkFactory {
  return {
    create(opts) {
      const link = inner.create({ ...opts, extraRemoteCandidates: [] });
      const wrap: PeerLink = {
        get remoteId() { return link.remoteId; },
        get isOpen() { return link.isOpen; },
        onSignal: null, onOpen: null, onClose: null, onMessage: null, onPath: null, onRemoteAddress: null, onTrace: null,
        startOffer: () => link.startOffer(),
        handleSignal: (s: SignalPayload) => {
          const keep = (line: string) => / typ relay\b/.test(line);
          if (s.ice && !keep(String((s.ice as { candidate?: string }).candidate ?? ""))) return;
          if (s.sdp) s = { sdp: { type: s.sdp.type, sdp: s.sdp.sdp.split(/\r?\n/).filter((l) => !l.startsWith("a=candidate:") || keep(l)).join("\r\n") } };
          return link.handleSignal(s);
        },
        send: (c, b) => link.send(c, b),
        close: () => link.close(),
        diagnostics: () => link.diagnostics?.() ?? "",
        facts: () => link.facts?.() ?? {},
      };
      link.onSignal = (s) => wrap.onSignal?.(s);
      link.onOpen = () => wrap.onOpen?.();
      link.onClose = (r) => wrap.onClose?.(r);
      link.onMessage = (c, b) => wrap.onMessage?.(c, b);
      link.onPath = (p) => wrap.onPath?.(p);
      link.onRemoteAddress = (a) => wrap.onRemoteAddress?.(a);
      link.onTrace = (k, t) => wrap.onTrace?.(k, t);
      return wrap;
    },
  };
}

const cleanup: (() => Promise<void> | void)[] = [];
const fakes: Fake[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  for (const f of fakes.splice(0)) await f.close();
});

const mk = (name: string, extra: Partial<ConstructorParameters<typeof OneLobby>[0]> = {}) =>
  new OneLobby({ gameId: "com.onelobby.diagtest", netVersion: "1", lobbyServer: "", mode: "raw", displayName: name, rememberSeat: false, advanced: { linkFactory: strictNat(real) }, ...extra });

const until = async (cond: () => boolean, what: string, ms = 10000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function hostUp(opts: Record<string, unknown> = {}) {
  const port = await freePort();
  const host = await hostDirect(mk("Host"), { nostr: false, bindHost: "127.0.0.1", port, openPort: false, log: false, ...opts });
  cleanup.push(() => host.leave());
  const seen: PeerDiagnosis[] = [];
  host.on("peerDiagnosis", (d) => seen.push(d));
  return { host, port, seen };
}

describe("Done when (one-shot s.4): a strict NAT with no relay", () => {
  it("the joiner sees nat_blocked within the ready timeout, the host gets the same sentence by name, and the log names the cause", async () => {
    const { host, port, seen } = await hostUp();
    const kit = mk("Sam", { readyTimeoutMs: 2500 });
    const errors: Error[] = [];
    kit.on("error", (e) => errors.push(e));
    const t0 = Date.now();
    const lobby = await kit.joinDirect(`127.0.0.1:${port}`);
    let rejected: unknown = null;
    lobby.ready.catch((e) => (rejected = e));
    await until(() => rejected !== null, "ready rejects", 6000);
    expect(Date.now() - t0).toBeLessThan(4000); // inside the ready timeout (plus connect time)

    // on the joiner's own screen
    const shown = describeError(rejected);
    expect(shown).toMatchObject({ code: "ice_failed", cause: "nat_blocked", stage: "ice" });
    expect(shown.message).toBe("Your network blocks direct connections (strict NAT) and no relay is set.");
    expect(shown.hint).toMatch(/Paste a relay line/);
    expect(describeError(errors[0]).cause).toBe("nat_blocked");

    // on the host's screen, by name, with the same sentence
    await until(() => seen.length > 0, "the host's peerDiagnosis");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: "Sam", cause: "nat_blocked", stage: "ice", relaySet: false, message: shown.message });
    expect(seen[0].line).toBe(`Sam: strict NAT, no relay set, stopped at the connection check after ${Math.round(seen[0].elapsedMs / 1000)} s.`);
    expect(seen[0].hint).toMatch(/relay \(TURN\)/);
    expect(seen[0].candidateTypes.local).toContain("host");
    // nothing in what the host got is an address, a credential or free text
    expect(JSON.stringify(seen[0])).not.toMatch(/\d+\.\d+\.\d+\.\d+|credential|password/i);

    // Copy logs: masked, and it names the cause
    const log = kit.netLog.export();
    expect(log).toMatch(/diag cause nat_blocked stage ice/);
    expect(log).toMatch(/error ice_failed/);
    expect(log).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(kit.netLog.export({ includeAddresses: true })).toMatch(/addr=127\.0\.0\.1/);
    // and the host's own log recorded the report it received
    expect(host.peers.map((p) => p.name)).toContain("Host");
  }, 30000);

  it("reportToHost: false sends nothing to the host", async () => {
    const { port, seen } = await hostUp();
    const kit = mk("Sam", { readyTimeoutMs: 1500, diagnostics: { reportToHost: false } });
    kit.on("error", () => {});
    const lobby = await kit.joinDirect(`127.0.0.1:${port}`);
    let rejected: unknown = null;
    lobby.ready.catch((e) => (rejected = e));
    await until(() => rejected !== null, "ready rejects", 6000);
    expect(describeError(rejected).cause).toBe("nat_blocked");
    await new Promise((r) => setTimeout(r, 500));
    expect(seen).toHaveLength(0);
  }, 30000);
});

describe("a relay that refuses the login", () => {
  it("the joiner sees relay_refused, the host gets it by name, and the log names it", async () => {
    const turn = await fakeTurn({ user: "alice", password: "s3cret", reject: true });
    fakes.push(turn);
    const { port, seen } = await hostUp();
    const kit = mk("Sam", { readyTimeoutMs: 4000 });
    kit.on("error", () => {});
    const lobby = await kit.joinDirect(`127.0.0.1:${port}`, { iceServers: [{ urls: `turn:127.0.0.1:${turn.port}`, username: "alice", credential: "s3cret" }] });
    let rejected: unknown = null;
    const t0 = Date.now();
    lobby.ready.catch((e) => (rejected = e));
    await until(() => rejected !== null, "ready rejects", 9000);
    expect(Date.now() - t0).toBeLessThan(6000);

    const shown = describeError(rejected);
    expect(shown).toMatchObject({ code: "ice_failed", cause: "relay_refused" });
    expect(shown.message).toBe("The relay rejected the login.");
    await until(() => seen.length > 0, "the host's peerDiagnosis");
    expect(seen[0]).toMatchObject({ name: "Sam", cause: "relay_refused", relaySet: true, message: shown.message });
    expect(seen[0].line).toMatch(/^Sam: the relay rejected the login, stopped at the connection check after \d+ s\.$/);

    const log = kit.netLog.export({ includeAddresses: true });
    expect(log).toMatch(/diag cause relay_refused/);
    expect(log).toMatch(/retry direct attempt stalled/);
    expect(log).not.toMatch(/s3cret|alice/);
    expect(turn.seen).toBeGreaterThan(0);
  }, 30000);

  it("a relay that never answers is relay_unreachable", async () => {
    const turn = await fakeTurn({ user: "alice", password: "s3cret", silent: true });
    fakes.push(turn);
    const { port, seen } = await hostUp();
    const kit = mk("Sam", { readyTimeoutMs: 4000, diagnostics: { relayProbe: (s) => import("../src/internals.js").then((m) => m.probeRelay(s, undefined, 600)) } });
    kit.on("error", () => {});
    const lobby = await kit.joinDirect(`127.0.0.1:${port}`, { iceServers: [{ urls: `turn:127.0.0.1:${turn.port}`, username: "alice", credential: "s3cret" }] });
    let rejected: unknown = null;
    lobby.ready.catch((e) => (rejected = e));
    await until(() => rejected !== null, "ready rejects", 9000);
    expect(describeError(rejected).cause).toBe("relay_unreachable");
    await until(() => seen.length > 0, "the host's peerDiagnosis");
    expect(seen[0].cause).toBe("relay_unreachable");
  }, 30000);
});

describe("a joiner with no diagnostics behaves as before", () => {
  it("an old hub (no diag feature) gets no report, and the failure is still ice_failed", async () => {
    const { host, port, seen } = await hostUp();
    // pretend the hub is old: the joiner's lobby sees no "diag" feature
    const kit = mk("Sam", { readyTimeoutMs: 1500 });
    kit.on("error", () => {});
    const lobby = await kit.joinDirect(`127.0.0.1:${port}`);
    (lobby as unknown as { cfg: { features: string[] } }).cfg.features = ["set_name", "room"];
    let rejected: unknown = null;
    lobby.ready.catch((e) => (rejected = e));
    await until(() => rejected !== null, "ready rejects", 6000);
    expect((rejected as { code: string }).code).toBe("ice_failed");
    await new Promise((r) => setTimeout(r, 400));
    expect(seen).toHaveLength(0);
    expect(host.peers.length).toBe(1);
  }, 30000);
});

describe("connect-time failures carry a cause too", () => {
  it("an address nobody listens on is host_unreachable", async () => {
    const port = await freePort();
    const kit = mk("Sam");
    const err = await kit.joinDirect(`127.0.0.1:${port}`, { connectTimeoutMs: 1500 }).catch((e: unknown) => e);
    expect(describeError(err)).toMatchObject({ code: "direct_unreachable", cause: "host_unreachable", message: "The host did not answer." });
    expect(kit.netLog.export()).toMatch(/diag cause host_unreachable stage signaling/);
  }, 15000);

  it("a lobby server that is down is signaling_unreachable", async () => {
    const kit = new OneLobby({ gameId: "g", netVersion: "1", lobbyServer: "ws://127.0.0.1:1/", rememberSeat: false });
    const err = await kit.join("7HQ4K2").catch((e: unknown) => e);
    expect(describeError(err)).toMatchObject({ code: "connect_failed", cause: "signaling_unreachable" });
  }, 15000);
});

