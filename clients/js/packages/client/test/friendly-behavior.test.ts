import { describe, expect, it } from "vitest";
import { Keepalive, KeepaliveError, describeError, type KeepaliveOptions, type SeatStorage } from "../src/index.js";
import type { LinkFactory, PeerLink } from "../src/transport.js";
import { ManualClock, MemoryNetwork, MemoryServer, settle } from "../src/testing.js";

class MapStorage implements SeatStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  copy() { const s = new MapStorage(); s.m = new Map(this.m); return s; }
}

/** A link whose ICE never completes (blocked network): it never opens. */
class DeadLink implements PeerLink {
  isOpen = false;
  onSignal: PeerLink["onSignal"] = null;
  onOpen: PeerLink["onOpen"] = null;
  onClose: PeerLink["onClose"] = null;
  onMessage: PeerLink["onMessage"] = null;
  constructor(readonly remoteId: number) {}
  startOffer() {}
  handleSignal() {}
  send() {}
  close() {}
}

function world() {
  const clock = new ManualClock();
  const server = new MemoryServer();
  const net = new MemoryNetwork();
  const make = (name: string, extra: Partial<KeepaliveOptions> = {}, adv: KeepaliveOptions["advanced"] = {}) =>
    new Keepalive({
      gameId: "gridpaint",
      netVersion: "1",
      lobbyServer: "mem://server",
      mode: "raw",
      displayName: name,
      ...extra,
      advanced: {
        socketFactory: server.socketFactory,
        linkFactory: net.factoryFor(name),
        clock,
        wallClock: () => 0,
        voiceCodec: null,
        createMic: null,
        createSink: null,
        storage: null,
        ...adv,
      },
    });
  return { clock, server, net, make };
}

/** Direct (non-relay) links never connect; relay-only links work when `relayWorks`. */
function blockedDirect(net: MemoryNetwork, owner: string, relayWorks: boolean): { factory: LinkFactory; relayTries: number } {
  const inner = net.factoryFor(owner);
  const out = {
    relayTries: 0,
    factory: {
      create: (o: Parameters<LinkFactory["create"]>[0]) => {
        if (o.relayOnly) out.relayTries++;
        return o.relayOnly && relayWorks ? inner.create(o) : new DeadLink(o.remoteId);
      },
    },
  };
  return out;
}

describe("joiner ready timeout (ice_failed)", () => {
  it("rejects ready, emits a describable error and leaves when the host is unreachable (no TURN)", async () => {
    const w = world();
    const la = await w.make("alice").host({ name: "t", maxPlayers: 4 });
    const blocked = blockedDirect(w.net, "bob", true);
    const kitB = w.make("bob", { readyTimeoutMs: 10_000 }, { linkFactory: blocked.factory });
    const errors: Error[] = [];
    kitB.on("error", (e) => errors.push(e));
    const lb = await kitB.join(la.code);
    const ended: string[] = [];
    lb.on("sessionEnded", (r) => ended.push(r));
    let rejected: unknown = null;
    lb.ready.catch((e) => (rejected = e));
    await w.clock.run(9_900, 100);
    expect(rejected).toBeNull();
    await w.clock.run(200, 100);
    expect(rejected).toBeInstanceOf(KeepaliveError);
    expect((rejected as KeepaliveError).code).toBe("ice_failed");
    expect(errors.map((e) => (e as KeepaliveError).code)).toEqual(["ice_failed"]);
    expect(describeError(errors[0]).message).toBe("Couldn't connect to the other players.");
    expect(blocked.relayTries).toBe(0); // no TURN offered: no relay retry
    expect(ended).toEqual(["ice_failed"]);
    await settle();
    expect(la.peers.map((p) => p.peerId)).toEqual([1]); // the seat was freed
  });

  it("retries once relay-only when the server offers TURN, and connects", async () => {
    const w = world();
    w.server.iceServers = [{ urls: ["stun:s.example:3478"] }, { urls: ["turn:t.example:3478"] }];
    const la = await w.make("alice").host({ name: "t", maxPlayers: 4 });
    const blocked = blockedDirect(w.net, "bob", true);
    const kitB = w.make("bob", { readyTimeoutMs: 10_000 }, { linkFactory: blocked.factory });
    const errors: Error[] = [];
    kitB.on("error", (e) => errors.push(e));
    const lb = await kitB.join(la.code);
    let ok = false;
    void lb.ready.then(() => (ok = true));
    await w.clock.run(4_900, 100);
    expect(blocked.relayTries).toBe(0);
    await w.clock.run(300, 100);
    expect(blocked.relayTries).toBe(1);
    expect(ok).toBe(true);
    const got: number[] = [];
    la.on("message", (_f, b) => got.push(b[0]));
    lb.broadcast(Uint8Array.of(7));
    await w.clock.run(20_000, 500);
    expect(got).toEqual([7]);
    expect(errors).toEqual([]);
    expect(lb.peers.map((p) => p.peerId)).toEqual([1, 2]); // no bogus migration while connecting
  });

  it("fails with ice_failed after the relay retry also fails, within the total budget", async () => {
    const w = world();
    w.server.iceServers = [{ urls: ["turns:t.example:443"] }];
    const la = await w.make("alice").host({ name: "t", maxPlayers: 4 });
    const blocked = blockedDirect(w.net, "bob", false);
    const lb = await w.make("bob", { readyTimeoutMs: 8_000 }, { linkFactory: blocked.factory }).join(la.code);
    let code = "";
    lb.ready.catch((e: KeepaliveError) => (code = e.code));
    await w.clock.run(8_100, 100);
    expect(blocked.relayTries).toBe(1);
    expect(code).toBe("ice_failed");
  });

  it("readyTimeoutMs: 0 waits forever; a normal join is unaffected by the default", async () => {
    const w = world();
    const la = await w.make("alice").host({ name: "t", maxPlayers: 4 });
    const lb = await w.make("bob", { readyTimeoutMs: 0 }, { linkFactory: blockedDirect(w.net, "bob", false).factory }).join(la.code);
    let settled = false;
    lb.ready.then(() => (settled = true), () => (settled = true));
    await w.clock.run(60_000, 1000);
    expect(settled).toBe(false);
    const lc = await w.make("cara").join(la.code);
    await settle();
    await expect(lc.ready).resolves.toBeUndefined();
    await w.clock.run(30_000, 1000);
    expect(lc.peers.length).toBe(3);
  });
});

describe("rememberSeat", () => {
  it("a reloaded tab joining the same code takes its old seat back; clean leave forgets it", async () => {
    const w = world();
    const la = await w.make("alice").host({ name: "t", maxPlayers: 4 });
    const store = new MapStorage();
    const lb = await w.make("bob", {}, { storage: store }).join(la.code);
    await w.clock.run(200);
    expect(JSON.parse(store.getItem("keepalive.seat.gridpaint")!)).toMatchObject({ code: la.code, token: lb.resumeToken });

    // "reload": the page's storage survives, everything else is gone
    const afterReload = store.copy();
    w.server.sockets[1].close();
    await lb.leave();
    await w.clock.run(500);
    expect(store.getItem("keepalive.seat.gridpaint")).toBeNull(); // ended sessions forget their seat

    const kitB2 = w.make("bob", {}, { storage: afterReload });
    expect(kitB2.rememberedCode).toBe(la.code);
    const lb2 = await kitB2.join(la.code.toLowerCase());
    expect(lb2.localPeerId).toBe(2); // same seat, not a new player 3
    expect(JSON.parse(afterReload.getItem("keepalive.seat.gridpaint")!).token).toBe(lb2.resumeToken);
    await w.clock.run(500);
    expect(la.peers.map((p) => p.peerId)).toEqual([1, 2]);

    await lb2.leave();
    expect(afterReload.getItem("keepalive.seat.gridpaint")).toBeNull();
  });

  it("resume() takes the seat back without a code; a stale seat resolves null and is forgotten", async () => {
    const w = world();
    const la = await w.make("alice").host({ name: "t", maxPlayers: 4 });
    const store = new MapStorage();
    const lb = await w.make("bob", {}, { storage: store }).join(la.code);
    const saved = store.copy();
    w.server.sockets[1].close();
    await lb.leave();
    const lb2 = await w.make("bob", {}, { storage: saved }).resume();
    expect(lb2?.localPeerId).toBe(2);

    const stale = new MapStorage();
    stale.setItem("keepalive.seat.gridpaint", JSON.stringify({ code: la.code, token: "gone", server: "mem://server" }));
    expect(await w.make("x", {}, { storage: stale }).resume()).toBeNull();
    expect(stale.getItem("keepalive.seat.gridpaint")).toBeNull();
    // and join() with a stale seat falls back to a normal join
    stale.setItem("keepalive.seat.gridpaint", JSON.stringify({ code: la.code, token: "gone", server: "mem://server" }));
    const lx = await w.make("x", {}, { storage: stale }).join(la.code);
    expect(lx.localPeerId).toBe(3);
  });

  it("never takes over a seat that is live in this page (two kits, one tab)", async () => {
    const w = world();
    const store = new MapStorage();
    const la = await w.make("alice", {}, { storage: store }).host({ name: "t", maxPlayers: 4 });
    const lb = await w.make("bob", {}, { storage: store }).join(la.code);
    expect(lb.localPeerId).toBe(2);
    expect(la.isHost).toBe(true);
  });

  it("throwing storage and rememberSeat: false are harmless", async () => {
    const w = world();
    const bad: SeatStorage = {
      getItem() { throw new Error("SecurityError"); },
      setItem() { throw new Error("QuotaExceeded"); },
      removeItem() { throw new Error("SecurityError"); },
    };
    const la = await w.make("alice", {}, { storage: bad }).host({ name: "t", maxPlayers: 4 });
    const store = new MapStorage();
    const lb = await w.make("bob", { rememberSeat: false }, { storage: store }).join(la.code);
    expect(store.m.size).toBe(0);
    await lb.leave();
    await la.leave();
  });
});

describe("defaults", () => {
  it("host() creates unlisted lobbies unless asked; list() only shows public ones", async () => {
    const w = world();
    await w.make("a").host({ name: "hidden", maxPlayers: 4 });
    await w.make("b").host({ name: "shown", maxPlayers: 4, visibility: "public" });
    const creates = w.server.received.filter((m) => m.t === "create").map((m) => m.visibility);
    expect(creates).toEqual(["unlisted", "public"]);
    expect((await w.make("c").list()).map((l) => l.name)).toEqual(["shown"]);
  });

  it("players without a name show as Player N (their seat)", async () => {
    const w = world();
    const la = await w.make("").host({ name: "t", maxPlayers: 4 });
    const kit = w.make("   ");
    expect(kit.options.displayName).toBe("");
    const lb = await kit.join(la.code);
    const lc = await w.make("cara").join(la.code);
    await settle();
    expect(la.peers.map((p) => p.name)).toEqual(["Player 1", "Player 2", "cara"]);
    expect(lc.peers.map((p) => p.name)).toEqual(["Player 1", "Player 2", "cara"]);
    expect(lb.peer(lb.localPeerId)?.name).toBe("Player 2");
  });

  it("the server's stand-in name 'Player' also becomes Player N", async () => {
    const w = world();
    const la = await w.make("Player").host({ name: "t", maxPlayers: 4 });
    expect(la.peers[0].name).toBe("Player 1");
  });

  it("advanced seams win over the deprecated top-level ones, which still work", async () => {
    const w = world();
    let used = "";
    const viaTop = new Keepalive({
      gameId: "gridpaint", netVersion: "1", lobbyServer: "mem://server",
      socketFactory: (u) => ((used = "top"), w.server.socketFactory(u)),
      linkFactory: w.net.factory, clock: w.clock, voiceCodec: null, createMic: null, createSink: null,
    });
    await viaTop.host({ name: "t", maxPlayers: 2 });
    expect(used).toBe("top");
    const both = new Keepalive({
      gameId: "gridpaint", netVersion: "1", lobbyServer: "mem://server",
      socketFactory: () => { throw new Error("deprecated seam should lose"); },
      advanced: { socketFactory: (u) => ((used = "advanced"), w.server.socketFactory(u)), linkFactory: w.net.factory, clock: w.clock, voiceCodec: null, createMic: null, createSink: null, storage: null },
    });
    await both.host({ name: "t", maxPlayers: 2 });
    expect(used).toBe("advanced");
  });
});
