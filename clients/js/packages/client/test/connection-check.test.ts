import { afterEach, describe, expect, it } from "vitest";
import { OneLobby, checkConnection } from "../src/index.js";
import { probeRelay } from "../src/internals.js";
import { fakeStun, fakeTurn, type Fake } from "./udp-fakes.js";

/** The connection check against UDP responders on 127.0.0.1 (nothing leaves the machine). */
const open: Fake[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});
const up = async <T extends Fake>(p: Promise<T>) => {
  const f = await p;
  open.push(f);
  return f;
};
const url = (f: Fake) => `stun:127.0.0.1:${f.port}`;
const opts = { bindAddress: "127.0.0.1", serverTimeoutMs: 400 };

/**
 * The clock the checks run on (the `clock` seam), so no result rides on a real timeout. A check waits twice per request/answer exchange (the
 * retransmit, then the limit); `silent[i]` says whether the i-th exchange meets a server that never answers (both waits fire at once: nothing
 * can answer) or one that does (they never fire: a slow answer on a busy runner still lands). `whole`: checkConnection also asks for its
 * whole-check wait first (never fires here).
 */
function scripted(whole: boolean, ...silent: boolean[]) {
  let n = 0;
  return {
    setTimeout(fn: () => void): () => void {
      const i = n++ - (whole ? 1 : 0);
      if (i < 0 || !silent[Math.floor(i / 2)]) return () => {};
      const h = setImmediate(fn);
      return () => clearImmediate(h);
    },
  };
}

describe("connection check: UDP and NAT type from two STUN servers", () => {
  it("one mapping from both servers is a cone NAT", async () => {
    const map = () => ({ ip: "203.0.113.9", port: 40000 });
    const a = await up(fakeStun({ map }));
    const b = await up(fakeStun({ map }));
    const r = await checkConnection({ ...opts, clock: scripted(true, false, false), stun: [url(a), url(b)] });
    expect(r).toMatchObject({ udp: "ok", natType: "cone", relay: "none", verdict: "good", message: "Direct connections: likely to work." });
  });

  it("a different port from the second server is a symmetric NAT", async () => {
    const a = await up(fakeStun({ map: () => ({ ip: "203.0.113.9", port: 40000 }) }));
    const b = await up(fakeStun({ map: () => ({ ip: "203.0.113.9", port: 40001 }) }));
    const r = await checkConnection({ ...opts, clock: scripted(true, false, false), stun: [url(a), url(b)] });
    expect(r).toMatchObject({ udp: "ok", natType: "symmetric", verdict: "likely_fail", message: "Direct connections: likely to fail. A relay is recommended." });
  });

  it("servers that see the socket's own address mean no NAT at all (open)", async () => {
    const a = await up(fakeStun());
    const b = await up(fakeStun());
    const r = await checkConnection({ ...opts, clock: scripted(true, false, false), stun: [url(a), url(b)] });
    expect(r).toMatchObject({ udp: "ok", natType: "open", verdict: "good" });
  });

  it("one answer says UDP works but not the NAT type", async () => {
    const a = await up(fakeStun({ map: () => ({ ip: "203.0.113.9", port: 40000 }) }));
    const b = await up(fakeStun({ silent: true }));
    const r = await checkConnection({ ...opts, clock: scripted(true, false, true), stun: [url(a), url(b)] });
    expect(r).toMatchObject({ udp: "ok", natType: "unknown", verdict: "unknown" });
  });

  it("no answer from any server is UDP blocked", async () => {
    const a = await up(fakeStun({ silent: true }));
    const b = await up(fakeStun({ silent: true }));
    const r = await checkConnection({ ...opts, clock: scripted(true, true, true), stun: [url(a), url(b)] });
    expect(r).toMatchObject({ udp: "blocked", natType: "unknown", verdict: "blocked" });
    expect(r.message).toMatch(/blocks UDP/);
  });

  it("contacts only the servers it is given", async () => {
    const a = await up(fakeStun({ map: () => ({ ip: "203.0.113.9", port: 40000 }) }));
    const bystander = await up(fakeStun());
    await checkConnection({ ...opts, clock: scripted(true, false, false), stun: [url(a), url(a)] });
    expect(a.seen).toBeGreaterThan(0);
    expect(bystander.seen).toBe(0);
  });
});

describe("connection check: the relay login", () => {
  const entry = (f: Fake, user = "alice", credential = "s3cret") => ({ urls: `turn:127.0.0.1:${f.port}`, username: user, credential });

  it("a login the server takes is ok", async () => {
    const turn = await up(fakeTurn({ user: "alice", password: "s3cret" }));
    const stun = await up(fakeStun({ map: () => ({ ip: "203.0.113.9", port: 40000 }) }));
    const r = await checkConnection({ ...opts, clock: scripted(true, false, false, false, false), stun: [url(stun), url(stun)], iceServers: [entry(turn)] });
    expect(r).toMatchObject({ udp: "ok", natType: "cone", relay: "ok", verdict: "good" });
  });

  it("a wrong login is refused", async () => {
    const turn = await up(fakeTurn({ user: "alice", password: "s3cret" }));
    const stun = await up(fakeStun({ map: () => ({ ip: "203.0.113.9", port: 40000 }) }));
    const r = await checkConnection({ ...opts, clock: scripted(true, false, false, false, false), stun: [url(stun), url(stun)], iceServers: [entry(turn, "alice", "wrong")] });
    expect(r).toMatchObject({ relay: "refused", verdict: "relay_refused", message: "The relay rejected the login. Check the relay line; it may have expired." });
  });

  it("a server that rejects every login is refused", async () => {
    const turn = await up(fakeTurn({ user: "alice", password: "s3cret", reject: true }));
    expect(await probeRelay(entry(turn), undefined, 400, scripted(false, false, false))).toBe("refused");
  });

  it("a silent server is unreachable", async () => {
    const turn = await up(fakeTurn({ user: "alice", password: "s3cret", silent: true }));
    const stun = await up(fakeStun({ map: () => ({ ip: "203.0.113.9", port: 40000 }) }));
    const r = await checkConnection({ ...opts, clock: scripted(true, false, false, true), stun: [url(stun), url(stun)], iceServers: [entry(turn)] });
    expect(r).toMatchObject({ relay: "unreachable", verdict: "relay_unreachable" });
  });

  it("a turns: URL cannot be tested here and is unknown", async () => {
    expect(await probeRelay({ urls: "turns:127.0.0.1:5349", username: "a", credential: "b" })).toBe("unknown");
  });

  it("the kit keeps the result and logs it without the login", async () => {
    const turn = await up(fakeTurn({ user: "alice", password: "s3cret" }));
    const stun = await up(fakeStun());
    const kit = new OneLobby({ gameId: "g", netVersion: "1", lobbyServer: "", rememberSeat: false });
    const r = await kit.checkConnection({ ...opts, clock: scripted(true, false, false, false, false), stun: [url(stun), url(stun)], iceServers: [entry(turn)] });
    expect(r.relay).toBe("ok");
    const text = kit.netLog.export({ includeAddresses: true });
    expect(text).toMatch(/connection check udp=ok nat=open relay=ok verdict=good/);
    expect(text).not.toMatch(/s3cret|alice/);
  });
});
