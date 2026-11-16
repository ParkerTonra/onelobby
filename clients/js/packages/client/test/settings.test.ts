import { afterEach, describe, expect, it } from "vitest";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { OneLobby, PlayerSettings, SETTINGS_ENV, describeError, maskRelay } from "../src/index.js";
import { cleanLastCode, cleanName, cleanRelay, cleanServer, settingsKey } from "../src/internals.js";
import { memoryStore, type KeyValueStore } from "../src/storage.js";
import { settle } from "../src/testing.js";
import type { LinkFactory, PeerLink, SignalPayload, SocketFactory } from "../src/transport.js";
import { webRtcLinkFactoryFor } from "../src/webrtc.js";
import { hostDirect } from "../src/direct/index.js";
import { readStored } from "../src/ui/element.js";
import { freePort, loopbackRtc, rig } from "./helpers.js";
import { specJson } from "./spec.js";
import { fakeTurn, type Fake } from "./udp-fakes.js";

const V = specJson("vectors/settings.json");
const GAME = "com.you.game";

/** A store pre-filled with one game's settings object (or raw text). */
function storeWith(value: unknown, game = GAME): KeyValueStore {
  const s = memoryStore();
  if (value !== undefined && value !== null) s.setItem(settingsKey(game), typeof value === "string" ? value : JSON.stringify(value));
  return s;
}
/** The same for the rig's kits (game id "gridpaint"). */
const rigStore = (value: unknown) => storeWith(value, "gridpaint");

describe("settings vectors (spec/vectors/settings.json)", () => {
  it("the store key and the variable names", () => {
    for (const k of V.key) expect(settingsKey(k.gameId)).toBe(k.key);
    expect({ ...SETTINGS_ENV }).toEqual(V.envNames);
    expect(V.hidden).toBe("<hidden>");
  });

  const cleaners: Record<string, (s: string) => string | null> = { name: cleanName, relay: cleanRelay, lastCode: cleanLastCode, server: cleanServer };
  for (const field of Object.keys(cleaners)) {
    it(`clean ${field}`, () => {
      expect(V.clean[field].length).toBeGreaterThan(4);
      for (const c of V.clean[field]) {
        const got = cleaners[field](c.input);
        if (c.invalid) expect(got, JSON.stringify(c.input)).toBeNull();
        else expect(got, JSON.stringify(c.input)).toBe(c.ok);
      }
    });
  }

  it("masked relay", () => {
    for (const c of V.mask) expect(maskRelay(c.relay), JSON.stringify(c.relay)).toBe(c.masked);
  });

  it("load: corrupt and odd values read as no settings", () => {
    for (const c of V.load) expect(new PlayerSettings(storeWith(c.stored), GAME, null).load(), c.name).toEqual(c.values);
  });

  it("save: unknown fields kept, bad fields rejected, corrupt value replaced", () => {
    for (const c of V.save) {
      const store = storeWith(c.stored);
      const s = new PlayerSettings(store, GAME, null);
      const r = s.save(c.patch);
      expect(r.rejected, c.name).toEqual(c.rejected);
      expect(r.ok, c.name).toBe(c.rejected.length === 0);
      expect(JSON.parse(store.getItem(settingsKey(GAME))!), c.name).toEqual(c.result);
    }
  });

  it("env: a variable wins for the run and is never written back", () => {
    for (const c of V.env) {
      const store = storeWith(c.stored);
      const before = store.getItem(settingsKey(GAME));
      const s = new PlayerSettings(store, GAME, c.env);
      expect(s.effective(), c.name).toEqual(c.effective);
      expect(store.getItem(settingsKey(GAME)), c.name).toBe(before);
      s.save({ lastCode: "7HQ4K2" });
      expect(store.getItem(settingsKey(GAME))).not.toContain("Ann");
      expect(s.effective().lastCode, c.name).toBe(c.env.ONELOBBY_LAST_CODE ? c.effective.lastCode : "7HQ4K2");
    }
  });

  it("a store that throws is no error: the settings last for the session", () => {
    const broken: KeyValueStore = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("blocked"); } };
    const s = new PlayerSettings(broken, GAME, null);
    expect(s.load().name).toBe("");
    expect(s.save({ name: "Sam" }).ok).toBe(true);
    expect(s.load().name).toBe("Sam");
    s.clear();
  });

  it("maskedRelay shows the effective relay with the hidden marker", () => {
    const s = new PlayerSettings(storeWith({ relay: "turn:relay.example.com:3478 alice s3cret" }), GAME, null);
    expect(s.maskedRelay()).toBe("turn:relay.example.com:3478 <hidden> <hidden>");
    expect(new PlayerSettings(storeWith(null), GAME, { ONELOBBY_RELAY: "turn:r.example.com:3478 bob pw99" }).maskedRelay()).toBe("turn:r.example.com:3478 <hidden> <hidden>");
  });
});

// ---- applying them on the in-memory rig --------------------------------------------------------------------------------

const RELAY = "turn:relay.example.com:3478 samuser sampass77";
const RELAY_PARTS = ["samuser", "sampass77"];

interface Spy {
  links: LinkFactory;
  sockets: SocketFactory;
  ice: unknown[][];
  urls: string[];
}

/** Wraps the rig's factories to see what a kit asks them: the ICE list of each link and the address of each socket. */
function spy(r: ReturnType<typeof rig>, owner: string): Spy {
  const ice: unknown[][] = [];
  const urls: string[] = [];
  const inner = r.net.factoryFor(owner);
  return {
    ice,
    urls,
    links: { create: (o) => (ice.push(o.iceServers), inner.create(o)) },
    sockets: (u) => (urls.push(u), r.server.socketFactory(u)),
  };
}

function joinerKit(r: ReturnType<typeof rig>, s: Spy, store: KeyValueStore | null, extra: Record<string, unknown> = {}, env: Record<string, string> | null = null) {
  return r.make("bob", {
    mode: "raw",
    extra: { displayName: "", lobbyServer: "", socketFactory: undefined, linkFactory: undefined, ...extra, advanced: { socketFactory: s.sockets, linkFactory: s.links, settingsStore: store, env } },
  });
}

describe("saved settings applied by the kit (memory rig)", () => {
  it("a joiner's name, relay entry and lobby server come from the saved settings", async () => {
    const r = rig();
    const la = await r.make("alice", { mode: "raw", extra: { settings: false } }).host({ name: "t", maxPlayers: 4 });
    const s = spy(r, "bob");
    const kit = joinerKit(r, s, rigStore({ v: 1, name: "Sam", relay: RELAY, server: "wss://lobby.mygame.net/ws" }));
    const lb = await kit.join(la.code);
    await settle();
    expect(s.urls).toEqual(["wss://lobby.mygame.net/ws"]);
    expect(la.peers.find((p) => p.peerId === lb.localPeerId)?.name).toBe("Sam");
    expect(lb.room.entries.find((e) => e.id === lb.localPeerId)?.name).toBe("Sam");
    // the host's own list first, then this player's entry
    expect(s.ice[0]).toEqual([...r.server.iceServers, { urls: ["turn:relay.example.com:3478"], username: "samuser", credential: "sampass77" }]);
    // the code was saved after the join
    expect(kit.settings.load().lastCode).toBe(la.code);
  });

  it("an explicit argument beats the saved value, and a default can be switched off", async () => {
    const r = rig();
    const la = await r.make("alice", { mode: "raw", extra: { settings: false } }).host({ name: "t", maxPlayers: 4 });
    const s = spy(r, "bob");
    const stored = { v: 1, name: "Sam", relay: RELAY, server: "wss://lobby.mygame.net/ws" };
    const kit = joinerKit(r, s, rigStore(stored), { displayName: "Zed", lobbyServer: "mem://explicit" });
    const lb = await kit.join(la.code);
    await settle();
    expect(s.urls).toEqual(["mem://explicit"]);
    expect(kit.options.displayName).toBe("Zed");
    expect(la.peers.find((p) => p.peerId === lb.localPeerId)?.name).toBe("Zed");
    await lb.leave();

    const s2 = spy(r, "bob");
    const off = joinerKit(r, s2, rigStore(stored), { lobbyServer: "mem://x", settings: { name: false, relay: false } });
    const lb2 = await off.join(la.code);
    await settle();
    expect(off.options.displayName).toBe("");
    expect(la.peers.find((p) => p.peerId === lb2.localPeerId)?.name).toMatch(/^Player \d+$/);
    expect(s2.ice[0]).toEqual(r.server.iceServers);
    await lb2.leave();

    const none = joinerKit(r, spy(r, "bob"), rigStore(stored), { lobbyServer: "mem://x", settings: false });
    await (await none.join(la.code)).leave();
    expect(none.settings.load().lastCode).toBe(""); // lastCode is a default too
  });

  it("host saves lastCode; the saved server is read at call time; the environment wins for a run and is not written", async () => {
    const r = rig();
    const s = spy(r, "ann");
    const store = rigStore({ v: 1, name: "Sam", theme: "dark" });
    const kit = r.make("ann", { mode: "raw", extra: { displayName: "", lobbyServer: "", advanced: { socketFactory: s.sockets, linkFactory: s.links, settingsStore: store, env: { ONELOBBY_NAME: "Ann", ONELOBBY_LOBBY_SERVER: "wss://lobby.env.net/ws" } } } });
    expect(kit.options.displayName).toBe("Ann");
    const l = await kit.host({ name: "t", maxPlayers: 4 });
    expect(s.urls).toEqual(["wss://lobby.env.net/ws"]);
    expect(l.peers[0].name).toBe("Ann");
    const stored = JSON.parse(store.getItem(settingsKey("gridpaint"))!);
    expect(stored).toMatchObject({ lastCode: l.code, theme: "dark" });
    expect(JSON.stringify(stored)).not.toMatch(/Ann|lobby\.env/);
    // a setting saved later counts on the next call
    kit.settings.save({ name: "Sam II" });
    expect(kit.options.displayName).toBe("Ann"); // the variable still wins
  });

  it("an invalid saved relay line is skipped with one plain warning that does not print it", async () => {
    const r = rig();
    const la = await r.make("alice", { mode: "raw", extra: { settings: false } }).host({ name: "t", maxPlayers: 4 });
    const s = spy(r, "bob");
    // written by hand, so it is not a relay line
    const kit = joinerKit(r, s, rigStore({ v: 1, relay: "samuser sampass77" }), { lobbyServer: "mem://x" });
    const warnings: string[] = [];
    kit.on("warning", (m) => warnings.push(m));
    for (let i = 0; i < 2; i++) {
      const lb = await kit.join(la.code);
      await settle();
      await lb.leave();
    }
    expect(warnings).toEqual(["The saved relay line is not valid, so it is not used."]);
    expect(s.ice[0]).toEqual(r.server.iceServers);
    expect(kit.netLog.export()).not.toMatch(/samuser|sampass77/);
  });

  it("with a relay line saved, no signaling message, log line or error holds its user name or password", async () => {
    const r = rig();
    const la = await r.make("alice", { mode: "raw", extra: { settings: false } }).host({ name: "t", maxPlayers: 4 });
    const s = spy(r, "bob");
    const kit = joinerKit(r, s, rigStore({ v: 1, relay: RELAY, server: "wss://sam:pwserver9@lobby.mygame.net/ws?token=tok12345" }));
    const errors: unknown[] = [];
    kit.on("error", (e) => errors.push(e));
    await expect(kit.join("ZZZZZZ")).rejects.toBeTruthy(); // an unknown code
    await expect(kit.join("not a code")).rejects.toBeTruthy(); // a bad one
    const lb = await kit.join(la.code);
    await settle();
    await lb.leave();
    const everything = [
      kit.netLog.export({ includeAddresses: true }),
      JSON.stringify(r.server.received),
      JSON.stringify(errors.map(describeError)),
    ].join("\n");
    for (const secret of [...RELAY_PARTS, "pwserver9", "tok12345"]) expect(everything, secret).not.toContain(secret);
    // the thrown errors too
    for (const bad of ["ZZZZZZ", "not a code"]) {
      const e = await kit.join(bad).catch((x) => x);
      expect(JSON.stringify([String(e?.message), e?.code, e?.data])).not.toMatch(/samuser|sampass77|pwserver9|tok12345/);
    }
  });

  it("fromConfig: no saved name for anonymous games, and the blueprint's length clamps it", () => {
    const r = rig();
    const store = storeWith({ v: 1, name: "Samantha the Long" });
    const mk = (bp: Record<string, unknown>) => OneLobby.fromConfig({ game: { id: GAME }, ...bp }, { advanced: { settingsStore: store, env: null, socketFactory: r.server.socketFactory } });
    expect(mk({}).options.displayName).toBe("Samantha the Long");
    expect(mk({ players: { identity: "anonymous" } }).options.displayName).toBe("");
    expect(mk({ players: { maxNameLength: 5 } }).options.displayName).toBe("Saman");
    // the file's server is "given", so the saved one is not used; an empty one falls back
    expect(mk({ hosting: { lobbyServer: "wss://lobby.file.net/ws" } }).options.lobbyServer).toBe("wss://lobby.file.net/ws");
    store.setItem(settingsKey(GAME), JSON.stringify({ server: "wss://lobby.mygame.net/ws" }));
    expect(mk({}).options.lobbyServer).toBe("wss://lobby.mygame.net/ws");
    expect(mk({ hosting: { lobbyServer: "wss://lobby.file.net/ws" } }).options.lobbyServer).toBe("wss://lobby.file.net/ws");
  });

  it("an old drop-in name key is read once and moved into the settings", () => {
    const ls = memoryStore();
    ls.setItem("onelobby-name", "  Sam ");
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    try {
      expect(readStored("my-game")).toBe("Sam");
      expect(ls.getItem("onelobby-name")).toBeNull();
      expect(JSON.parse(ls.getItem(settingsKey("my-game"))!)).toMatchObject({ v: 1, name: "Sam" });
      expect(readStored("my-game")).toBe("Sam");
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

// ---- never logged, on real loopback WebRTC with a relay that refuses the login ------------------------------------------

const loopback = webRtcLinkFactoryFor(loopbackRtc(RTCPeerConnection) as unknown as typeof globalThis.RTCPeerConnection);

/** A simulated strict NAT (as in diagnostics-loopback): no candidate that arrives reaches ICE except a relay one, so only the relay can connect. */
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
      link.onSignal = (x) => wrap.onSignal?.(x);
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
const real = strictNat(loopback);
const cleanup: (() => Promise<void> | void)[] = [];
const fakes: Fake[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  for (const f of fakes.splice(0)) await f.close();
});

describe("never logged (loopback)", () => {
  it("a saved relay that the relay refuses shows in no log, error or report, yet reaches the relay", async () => {
    const turn = await fakeTurn({ user: "samuser", password: "sampass77", reject: true });
    fakes.push(turn);
    const port = await freePort();
    const base = { gameId: "com.onelobby.settingstest", netVersion: "1", lobbyServer: "", mode: "raw" as const, rememberSeat: false };
    const hostKit = new OneLobby({ ...base, displayName: "Host", settings: false, advanced: { linkFactory: real, settingsStore: null, env: null } });
    const host = await hostDirect(hostKit, { nostr: false, bindHost: "127.0.0.1", port, openPort: false, log: false });
    cleanup.push(() => host.leave());
    const seen: unknown[] = [];
    host.on("peerDiagnosis", (d) => seen.push(d));

    const store = storeWith(null);
    store.setItem(settingsKey("com.onelobby.settingstest"), JSON.stringify({ v: 1, name: "Sam", relay: `turn:127.0.0.1:${turn.port} samuser sampass77` }));
    const kit = new OneLobby({ ...base, displayName: "", readyTimeoutMs: 4000, advanced: { linkFactory: real, settingsStore: store, env: null } });
    const errors: Error[] = [];
    kit.on("error", (e) => errors.push(e));
    const lobby = await kit.joinDirect(`127.0.0.1:${port}`);
    let rejected: unknown = null;
    lobby.ready.catch((e) => (rejected = e));
    const t0 = Date.now();
    while (rejected === null) {
      if (Date.now() - t0 > 9000) throw new Error("ready did not reject");
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(turn.seen).toBeGreaterThan(0); // the saved entry did reach the relay
    expect(describeError(rejected).cause).toBe("relay_refused"); // and the relay hint knows a relay was set
    while (seen.length === 0) {
      if (Date.now() - t0 > 12000) throw new Error("no report");
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(host.peers.map((p) => p.name)).toContain("Host");
    const all = [
      kit.netLog.export({ includeAddresses: true }),
      hostKit.netLog.export({ includeAddresses: true }),
      JSON.stringify(seen),
      JSON.stringify(describeError(rejected)),
      String((rejected as Error).message),
      JSON.stringify(errors.map((e) => [e.message, describeError(e)])),
    ].join("\n");
    expect(all).not.toMatch(/samuser|sampass77/);
    expect(all).toMatch(/relay_refused/);
  }, 30000);
});
