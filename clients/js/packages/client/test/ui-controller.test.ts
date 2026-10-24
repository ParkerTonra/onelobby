import { describe, expect, it } from "vitest";
import { OneLobby } from "../src/onelobby.js";
import { LobbyController } from "../src/ui/controller.js";
import type { OneLobbyOptions, SeatStorage } from "../src/onelobby.js";
import { rig, type Rig } from "./helpers.js";

/** A kit like the element builds (raw mode, no voice) on the in-memory server. */
const kit = (r: Rig, name: string, extra: Partial<OneLobbyOptions> = {}, adv: OneLobbyOptions["advanced"] = {}) =>
  new OneLobby({
    gameId: "gridpaint", netVersion: "1", lobbyServer: "mem://server", mode: "raw", displayName: name, ...extra,
    advanced: { socketFactory: r.server.socketFactory, linkFactory: r.net.factoryFor(name), clock: r.clock, voiceCodec: null, createMic: null, createSink: null, storage: null, ...adv },
  });

class MapStorage implements SeatStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

function player(r: Rig, opts: { maxPlayers?: number; makeKit?: (name: string) => OneLobby } = {}) {
  const c = new LobbyController({
    makeKit: opts.makeKit ?? ((name) => kit(r, name)),
    maxPlayers: opts.maxPlayers ?? 4,
  });
  const events: [string, any][] = [];
  const states: string[] = [];
  c.onEvent = (t, d) => events.push([t, d]);
  c.onChange = () => {
    if (states[states.length - 1] !== c.state) states.push(c.state);
  };
  return { c, events, states, of: (t: string) => events.filter((e) => e[0] === t).map((e) => e[1]) };
}

describe("<one-lobby> controller", () => {
  it("host -> join -> start -> messages, with plain-language status along the way", async () => {
    const r = rig();
    const A = player(r);
    const B = player(r);
    expect(A.c.statusText).toMatch(/Host a game/);
    await A.c.host("Sam");
    expect(A.states).toEqual(["connecting", "lobby"]);
    expect(A.c.isHost).toBe(true);
    expect(A.c.statusText).toBe("Waiting for players… Share the code with your friends.");
    const code = A.c.code!;
    expect(code).toMatch(/^[0-9A-Z]{6}$/);

    const pending = B.c.join(code.toLowerCase().slice(0, 3) + " " + code.slice(3), "Alex");
    expect(B.c.statusText).toBe("Joining…");
    await pending;
    expect(B.c.state).toBe("lobby");
    expect(B.c.linking).toBe(true);
    expect(B.c.statusText).toBe("Connecting to Sam…");
    await r.clock.run(50);
    expect(B.c.linking).toBe(false);
    expect(B.c.statusText).toBe("Connected! Waiting for Sam to start.");
    expect(A.c.statusText).toBe("2 players here. Press Start when everyone's in.");
    expect(A.of("player-joined").map((d) => d.player.name)).toEqual(["Alex"]);
    expect(B.c.players.map((p) => [p.name, p.isHost, p.isMe])).toEqual([["Sam", true, false], ["Alex", false, true]]);

    await A.c.start();
    await r.clock.run(50);
    expect(A.c.state).toBe("playing");
    expect(B.c.state).toBe("playing");
    expect(A.of("start").length).toBe(1);
    expect(B.of("start").length).toBe(1);

    A.c.send({ hello: "from Sam" });
    B.c.send([1, 2, 3]);
    await r.clock.run(50);
    expect(B.of("message")).toEqual([{ from: expect.objectContaining({ name: "Sam", isHost: true }), data: { hello: "from Sam" } }]);
    expect(A.of("message")).toEqual([{ from: expect.objectContaining({ name: "Alex" }), data: [1, 2, 3] }]);
  });

  it("messages between two joiners go through the host and keep the sender", async () => {
    const r = rig();
    const [A, B, C] = [player(r), player(r), player(r)];
    await A.c.host("Sam");
    await B.c.join(A.c.code!, "Alex");
    await C.c.join(A.c.code!, "Kim");
    await r.clock.run(50);
    B.c.send("hi");
    await r.clock.run(50);
    expect(C.of("message")).toEqual([{ from: expect.objectContaining({ name: "Alex" }), data: "hi" }]);
    expect(A.of("message").map((m) => m.data)).toEqual(["hi"]);
    expect(B.of("message")).toEqual([]);
  });

  it("shared state is host-authoritative: sets and adds converge, late joiners get a snapshot", async () => {
    const r = rig();
    const [A, B, C] = [player(r), player(r), player(r)];
    A.c.shared.set("title", "Clicks"); // before hosting: kept as a default
    await A.c.host("Sam");
    await B.c.join(A.c.code!, "Alex");
    await r.clock.run(50);
    expect(B.c.shared.get("title")).toBe("Clicks");
    for (let i = 0; i < 5; i++) {
      A.c.shared.add("clicks");
      B.c.shared.add("clicks");
    }
    B.c.shared.set("color", "red");
    await r.clock.run(50);
    expect(A.c.shared.get("clicks")).toBe(10);
    expect(B.c.shared.get("clicks")).toBe(10);
    expect(A.c.shared.get("color")).toBe("red");
    const change = B.of("shared-change").find((d) => d.key === "color");
    expect(change.from).toEqual(expect.objectContaining({ name: "Alex" }));

    await C.c.join(A.c.code!, "Kim");
    await r.clock.run(50);
    expect(C.c.shared.all()).toEqual({ title: "Clicks", clicks: 10, color: "red" });
    C.c.shared.set("color", null); // null deletes
    await r.clock.run(50);
    expect(A.c.shared.keys().sort()).toEqual(["clicks", "title"]);
    expect(B.c.shared.get("color")).toBeUndefined();
  });

  it("a joiner never goes back to an older value delivered after the snapshot", async () => {
    const r = rig();
    const [A, B] = [player(r), player(r)];
    await A.c.host("Sam");
    // B joins; while its channel opens the host keeps changing the value (those broadcasts queue for B)
    const j = B.c.join(A.c.code!, "Alex");
    A.c.shared.set("n", 1);
    await j;
    A.c.shared.set("n", 2);
    A.c.shared.set("n", 3);
    const seen: unknown[] = [];
    B.c.onEvent = (t, d: any) => t === "shared-change" && seen.push(d.value);
    await r.clock.run(50);
    expect(B.c.shared.get("n")).toBe(3);
    for (let i = 1; i < seen.length; i++) expect(seen[i] as number).toBeGreaterThanOrEqual(seen[i - 1] as number);
  });

  it("friendly errors for a bad code, an unknown code and a full game; retry repeats the action", async () => {
    const r = rig();
    const [A, B, C, D] = [player(r, { maxPlayers: 2 }), player(r), player(r), player(r)];
    await B.c.join("hello!", "Alex");
    expect(B.c.state).toBe("error");
    expect(B.c.error).toMatchObject({ code: "bad_code", message: "That doesn't look like a lobby code." });
    expect(B.of("error").length).toBe(1);

    await C.c.join("ZZZZZZ", "Kim");
    expect(C.c.error?.code).toBe("unknown_code");
    expect(C.c.statusText).toBe("We couldn't find a lobby with that code.");

    await A.c.host("Sam");
    await B.c.join(A.c.code!, "Alex");
    await D.c.join(A.c.code!, "Lee");
    expect(D.c.error?.code).toBe("lobby_full");
    expect(D.c.error?.hint).toBeTruthy();

    await B.c.leave();
    await r.clock.run(50);
    await D.c.retry();
    expect(D.c.state).toBe("lobby");
    expect(D.c.code).toBe(A.c.code);
  });

  it("a join whose direct link never opens times out with a friendly message", async () => {
    const r = rig();
    const A = player(r);
    // The joiner's network swallows everything: its link to the host never opens (a strict firewall).
    const dead = (remoteId: number) => ({
      remoteId, isOpen: false, onSignal: null, onOpen: null, onClose: null, onMessage: null, onPath: null,
      startOffer() {}, handleSignal() {}, send() {}, close() {},
    });
    const B = player(r, {
      makeKit: (name) => kit(r, name, { readyTimeoutMs: 3000 }, { linkFactory: { create: (o) => dead(o.remoteId) as never } }),
    });
    await A.c.host("Sam");
    await B.c.join(A.c.code!, "Alex");
    expect(B.c.statusText).toBe("Connecting to Sam…");
    await r.clock.run(2900);
    expect(B.c.state).toBe("lobby");
    await r.clock.run(200);
    expect(B.c.state).toBe("error");
    expect(B.c.error?.code).toBe("ice_failed");
    expect(B.c.error?.hint).toMatch(/hotspot/);
    expect(B.of("error").length).toBe(1);
    await r.clock.run(100);
    expect(A.c.players.map((p) => p.name)).toEqual(["Sam"]); // it left the lobby cleanly
  });

  it("a reloaded page takes its seat back (resume), and there is nothing to resume on a fresh tab", async () => {
    const r = rig();
    const A = player(r);
    const store = new MapStorage();
    const B = player(r, { makeKit: (name) => kit(r, name, {}, { storage: store }) });
    await A.c.host("Sam");
    await B.c.join(A.c.code!, "Alex");
    await r.clock.run(50);
    const saved = new MapStorage();
    for (const [k, v] of store.m) saved.setItem(k, v);
    // "reload": the old page's socket dies; storage survives
    r.server.sockets[1].close();
    await B.c.leave(); // the old page is gone (its leave cannot reach the server any more)
    await r.clock.run(50);
    const B2 = player(r, { makeKit: (name) => kit(r, name, {}, { storage: saved }) });
    expect(await B2.c.resume("Alex")).toBe(true);
    expect(B2.states).toEqual(["connecting", "lobby"]);
    expect(B2.c.code).toBe(A.c.code);
    await r.clock.run(50);
    expect(B2.c.statusText).toBe("Connected! Waiting for Sam to start.");
    expect(A.c.players.length).toBe(2);

    const fresh = player(r, { makeKit: (name) => kit(r, name, {}, { storage: new MapStorage() }) });
    expect(await fresh.c.resume("Kim")).toBe(false);
    expect(fresh.c.state).toBe("idle");
  });

  it("an empty name shows as Player N", async () => {
    const r = rig();
    const [A, B] = [player(r), player(r)];
    await A.c.host("Sam");
    await B.c.join(A.c.code!, "  ");
    await r.clock.run(50);
    expect(A.c.players.map((p) => p.name)).toEqual(["Sam", "Player 2"]);
    expect(B.c.players.map((p) => p.name)).toEqual(["Sam", "Player 2"]);
  });

  it("the host leaving: the joiner takes over (migration) and the status follows", async () => {
    const r = rig();
    const [A, B] = [player(r), player(r)];
    await A.c.host("Sam");
    await B.c.join(A.c.code!, "Alex");
    await r.clock.run(50);
    await A.c.leave();
    await r.clock.run(100);
    expect(B.of("player-left").map((d) => d.player.name)).toEqual(["Sam"]);
    expect(B.c.isHost).toBe(true);
    expect(B.c.statusText).toMatch(/Waiting for players/);
  });
});
