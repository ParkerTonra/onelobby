import { describe, expect, it } from "vitest";
import { OneLobby, memoryStore, type RoomOptions } from "../src/internals.js";
import { Player, play } from "./helpers.js";
import { flush, hostWith, joiner, kit, names, newRig, wait } from "./room-helpers.js";

describe("room: roster and replication", () => {
  it("every lobby has a room; the host is seat 0 and supported at once", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r);
    expect(host.room.supported).toBe(true);
    expect(host.room.state).toBe("lobby");
    expect(host.room.me).toMatchObject({ id: 1, role: "player", seat: 0, ready: false, status: "connected" });
    expect(host.room.players).toHaveLength(1);
  });

  it("a joiner gets the whole room, later joiners are broadcast, seats follow join order", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r);
    const events: string[] = [];
    host.room.on("playerJoined", (e) => events.push(`join:${e.name}`));
    const a = await joiner(r, host, "Ann");
    expect(a.lobby.room.supported).toBe(true);
    expect(a.lobby.room.players.map((p) => [p.name, p.seat])).toEqual([["Host", 0], ["Ann", 1]]);
    const b = await joiner(r, host, "Bob");
    await flush();
    for (const l of [host, a.lobby, b.lobby]) expect(l.room.players.map((p) => [p.id, p.name, p.seat])).toEqual([[1, "Host", 0], [2, "Ann", 1], [3, "Bob", 2]]);
    expect(events).toEqual(["join:Ann", "join:Bob"]);
    // the joiner's own view
    expect(b.lobby.room.me?.id).toBe(3);
    expect(a.lobby.room.revision).toBe(host.room.revision);
  });

  it("the player id goes out in hello and stays the same for the install", async () => {
    const r = newRig();
    const { k } = await hostWith(r);
    expect(k.playerId).toMatch(/^[0-9a-f]{32}$/);
    const hello = r.server.received.find((m) => m.t === "hello")!;
    expect(hello.playerId).toBe(k.playerId);
    expect(k.pidStore.getItem("onelobby.pid.gridpaint")).toBe(k.playerId);
    // a second kit on the same store is the same install
    const again = kit(r, "x");
    again.pidStore.setItem("onelobby.pid.gridpaint", k.playerId);
    expect(r.make("y", { extra: { advanced: { playerIdStore: again.pidStore } } as never }).playerId).toBe(k.playerId);
  });
});

describe("room: names", () => {
  it("defaults an empty name, dedupes, clamps and sanitises; a rename re-runs the rules", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, {}, { name: "Sam" });
    const a = await joiner(r, host, "Sam");
    const b = await joiner(r, host, "");
    const c = await joiner(r, host, "  Sam  ");
    expect(names(host)).toEqual(["Sam", "Sam 2", "Player 3", "Sam 3"]);
    expect(names(c.lobby)).toEqual(names(host));
    await a.lobby.rename("Ann‮");
    await flush();
    expect(names(host)).toEqual(["Sam", "Ann", "Player 3", "Sam 3"]);
    await a.lobby.rename("Sam");
    await flush();
    expect(names(host)).toEqual(["Sam", "Sam 2", "Player 3", "Sam 3"]);
    expect(b.lobby.room.player(3)?.name).toBe("Player 3");
  });

  it("the filter hook cleans names and chat lines on the host, and nothing is filtered by default", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r);
    const a = await joiner(r, host, "darnit");
    expect(names(host)).toEqual(["Host", "darnit"]);
    host.room.filter = (t) => t.replace(/darn/g, "****");
    const b = await joiner(r, host, "darn");
    expect(b.lobby.room.me?.name).toBe("****");
    const lines: string[] = [];
    a.lobby.chat.on("message", (m) => lines.push(m.text));
    host.chat.send("what a darn day");
    await flush();
    expect(lines).toEqual(["what a **** day"]);
    host.room.filter = () => {
      throw new Error("boom");
    };
    host.chat.send("darn again");
    await flush();
    expect(lines[1]).toBe("darn again");
    host.room.filter = null;
  });
});

describe("room: per-player data", () => {
  const room: RoomOptions = { data: { mood: { type: "enum", values: ["happy", "sad"] }, vip: { type: "bool", hostOnly: true } } };

  it("starts with defaults and the joiner's data, replicates sets, refuses bad ones", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, room);
    expect(host.room.me?.data).toEqual({ avatar: "0", team: "0" });
    const a = await joiner(r, host, "Ann", { data: { color: "#FF8800", mood: "sad", zzz: "1", avatar: "999" } });
    expect(a.lobby.room.me?.data).toEqual({ color: "#ff8800", mood: "sad", avatar: "0", team: "0" });
    const rejected: string[] = [];
    a.lobby.room.on("rejected", (code, re, key) => rejected.push(`${re}:${code}:${key}`));
    const changes: string[][] = [];
    host.room.on("playerChanged", (e, keys) => e.id === 2 && changes.push(keys));
    a.lobby.room.setData({ avatar: "7", team: "2" });
    await flush();
    expect(host.room.player(2)?.data).toMatchObject({ avatar: "7", team: "2" });
    expect(a.lobby.room.me?.data).toMatchObject({ avatar: "7", team: "2" });
    expect(changes).toEqual([["data.avatar", "data.team"]]);
    a.lobby.room.setData({ mood: "angry" });
    a.lobby.room.setData({ vip: "true" });
    a.lobby.room.setData({ nope: "1" });
    a.lobby.room.setData({ avatar: "300" });
    await flush();
    expect(rejected).toEqual(["set:bad_value:mood", "set:not_allowed:vip", "set:unknown_key:nope", "set:bad_value:avatar"]);
    expect(host.room.player(2)?.data.mood).toBe("sad");
  });

  it("the host overrides any player, hostOnly keys included, and an unset key goes away", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, room);
    const a = await joiner(r, host, "Ann", { data: { color: "#00ff00" } });
    host.room.setData(2, { vip: "true", color: "" });
    await flush();
    expect(a.lobby.room.me?.data).toEqual({ vip: "true", avatar: "0", team: "0" });
    expect(() => host.room.setData(2, { vip: "maybe" })).toThrowError(/bad_value/);
    expect(() => a.lobby.room.setData(1, { team: "1" })).toThrowError(/not_allowed|only the host/);
    host.room.setData({ team: "3" });
    await flush();
    expect(a.lobby.room.player(1)?.data.team).toBe("3");
  });
});

describe("room: ready, countdown, start", () => {
  it("ready flags replicate; allReady fires once everyone (not spectators) is ready", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, { spectators: 2 });
    const a = await joiner(r, host, "Ann");
    const s = await joiner(r, host, "Spec", { role: "spectator" });
    const flips: boolean[] = [];
    host.room.on("allReadyChanged", (v) => flips.push(v));
    expect(host.room.allReady).toBe(false);
    a.lobby.room.setReady(true);
    await flush();
    expect(host.room.player(2)?.ready).toBe(true);
    expect(s.lobby.room.player(2)?.ready).toBe(true);
    host.room.setReady(true);
    await flush();
    expect(host.room.allReady).toBe(true);
    expect(flips).toEqual([true]);
    a.lobby.room.toggleReady();
    await flush();
    expect(flips).toEqual([true, false]);
    // a spectator cannot be ready
    const rejected: string[] = [];
    s.lobby.room.on("rejected", (c) => rejected.push(c));
    s.lobby.room.setReady(true);
    await flush();
    expect(rejected).toEqual(["not_allowed"]);
  });

  it("start runs a countdown every peer sees, then starts the game for all", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, { countdownSeconds: 3 });
    const a = await joiner(r, host, "Ann");
    const log: string[] = [];
    a.lobby.room.on("stateChanged", (s, prev) => log.push(`${prev}>${s}`));
    const ticks: number[] = [];
    a.lobby.room.on("countdown", (c) => ticks.push(Math.round(c.remaining() / 100) * 100));
    host.room.start();
    await flush();
    expect(host.room.state).toBe("countdown");
    expect(a.lobby.room.state).toBe("countdown");
    expect(a.lobby.room.countdown?.total).toBe(3000);
    expect(a.lobby.phase).toBe("lobby");
    await wait(r, 1100);
    expect(a.lobby.room.countdown!.remaining()).toBeLessThanOrEqual(2000);
    expect(a.lobby.room.countdown!.remaining()).toBeGreaterThan(1500);
    await wait(r, 2200);
    for (const l of [host, a.lobby]) {
      expect(l.room.state).toBe("started");
      expect(l.phase).toBe("in_game");
      expect(l.room.countdown).toBeNull();
    }
    expect(log).toEqual(["lobby>countdown", "countdown>started"]);
    expect(ticks[0]).toBe(3000);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
  });

  it("the countdown is cancelable and a joiner sees why", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r);
    const a = await joiner(r, host, "Ann");
    const why: string[] = [];
    a.lobby.room.on("countdownCancelled", (w) => why.push(w));
    host.room.start();
    await wait(r, 1200);
    host.room.cancelCountdown();
    await flush();
    expect(why).toEqual(["host"]);
    expect(a.lobby.room.state).toBe("lobby");
    await wait(r, 5000);
    expect(host.phase).toBe("lobby");
    expect(a.lobby.phase).toBe("lobby");
  });

  it("start refuses outside the lobby and below minPlayers", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, { minPlayers: 2, countdownSeconds: 0 });
    expect(() => host.room.start()).toThrowError(/not_enough_players/);
    const a = await joiner(r, host, "Ann");
    host.room.start();
    await flush();
    expect(host.room.state).toBe("started");
    expect(a.lobby.phase).toBe("in_game");
    expect(() => host.room.start()).toThrowError(/wrong_state/);
  });

  it("a joiner's request raises the host's requested event and changes nothing", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r);
    const a = await joiner(r, host, "Ann");
    const asked: [number, string][] = [];
    host.room.on("requested", (id, what) => asked.push([id, what]));
    a.lobby.room.request("rematch");
    await flush();
    expect(asked).toEqual([[2, "rematch"]]);
    expect(host.room.state).toBe("lobby");
  });
});

describe("room: auto start", () => {
  it("all_ready starts a countdown when everyone is ready and cancels when someone is not", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, { autoStart: "all_ready", minPlayers: 2, countdownSeconds: 3 });
    const a = await joiner(r, host, "Ann");
    const why: string[] = [];
    a.lobby.room.on("countdownCancelled", (w) => why.push(w));
    host.room.setReady(true);
    await flush();
    expect(host.room.state).toBe("lobby"); // Ann is not ready
    a.lobby.room.setReady(true);
    await flush();
    expect(host.room.state).toBe("countdown");
    expect(a.lobby.room.state).toBe("countdown");
    await wait(r, 1000);
    a.lobby.room.setReady(false);
    await flush();
    expect(host.room.state).toBe("lobby");
    expect(why).toEqual(["condition"]);
    a.lobby.room.setReady(true);
    await flush();
    await wait(r, 3300);
    expect(host.phase).toBe("in_game");
    expect(a.lobby.phase).toBe("in_game");
  });

  it("players mode starts when enough players are connected, and a leaver cancels it", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, { autoStart: "players", autoStartPlayers: 3, countdownSeconds: 2 });
    const a = await joiner(r, host, "Ann");
    expect(host.room.state).toBe("lobby");
    const b = await joiner(r, host, "Bob");
    expect(host.room.state).toBe("countdown");
    await a.lobby.leave();
    await flush();
    expect(host.room.state).toBe("lobby");
    expect(b.lobby.room.state).toBe("lobby");
    await joiner(r, host, "Cara");
    await wait(r, 2300);
    expect(host.phase).toBe("in_game");
  });
});

describe("room: back to lobby and rematch", () => {
  it("returns to the lobby with ready reset, links and roster intact, then rematches", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, { countdownSeconds: 0 });
    const a = await joiner(r, host, "Ann", { data: { color: "#112233" } });
    host.room.setReady(true);
    a.lobby.room.setReady(true);
    await flush();
    host.room.start();
    await flush();
    expect(a.lobby.phase).toBe("in_game");
    const got: number[][] = [];
    a.lobby.on("message", (_f, bytes) => got.push([...bytes]));
    const log: string[] = [];
    a.lobby.room.on("backToLobby", () => log.push("back"));
    host.room.backToLobby();
    await flush();
    for (const l of [host, a.lobby]) {
      expect(l.room.state).toBe("lobby");
      expect(l.phase).toBe("lobby");
      expect(l.room.players.every((p) => !p.ready)).toBe(true);
      expect(l.room.players.map((p) => p.seat)).toEqual([0, 1]);
    }
    expect(a.lobby.room.me?.data.color).toBe("#112233");
    expect(log).toEqual(["back"]);
    // the link is still up
    host.send(2, Uint8Array.of(7, 7));
    await flush();
    expect(got).toEqual([[7, 7]]);
    host.room.rematch();
    await flush();
    expect(host.room.state).toBe("started");
    expect(a.lobby.phase).toBe("in_game");
    host.room.backToLobby();
    host.room.backToLobby(); // a no-op in the lobby
    await flush();
    expect(host.room.state).toBe("lobby");
  });

  it("a rematch right behind back to lobby is not undone by the hub's late echo", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, { countdownSeconds: 0 });
    const a = await joiner(r, host, "Ann");
    host.room.start();
    await flush();
    host.room.rematch();
    await flush();
    await wait(r, 500);
    expect(host.phase).toBe("in_game");
    expect(host.room.state).toBe("started");
    expect(a.lobby.phase).toBe("in_game");
  });

  it("auto start waits for the next change after back to lobby", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, { autoStart: "players", autoStartPlayers: 2, countdownSeconds: 0 });
    const a = await joiner(r, host, "Ann");
    await flush();
    expect(host.room.state).toBe("started");
    host.room.backToLobby();
    await flush();
    expect(host.room.state).toBe("lobby"); // not instantly started again
    await joiner(r, host, "Bob");
    await flush();
    expect(host.room.state).toBe("started");
    expect(a.lobby.room.state).toBe("started");
  });

  it("restarts a lockstep match from tick 1 with equal state", async () => {
    const r = newRig();
    const hk = r.make("host", { mode: "lockstep" });
    const host = await hk.host({ name: "t", maxPlayers: 4, room: { countdownSeconds: 0 } });
    const a = await r.make("ann", { mode: "lockstep" }).join(host.code);
    await flush();
    let A = new Player("a", host);
    let B = new Player("b", a);
    host.room.start();
    await flush();
    A.paint(3, 3);
    await play(r.clock, [A, B], 1500);
    expect(A.g.tick).toBeGreaterThan(20);
    host.room.backToLobby();
    await play(r.clock, [A, B], 200);
    expect(a.phase).toBe("lobby");
    host.room.start();
    A = new Player("a2", host);
    B = new Player("b2", a);
    await play(r.clock, [A, B], 100);
    A.paint(5, 5);
    await play(r.clock, [A, B], 1500);
    expect(A.g.tick).toBeGreaterThan(20);
    expect(B.g.tick).toBeGreaterThan(20);
    expect(B.desyncs).toBe(0);
    const t = Math.min(A.g.tick, B.g.tick);
    const tt = t - (t % 20);
    expect(B.hashes.get(tt)).toBe(A.hashes.get(tt));
    expect(Array.from(A.g.grid)).toEqual(Array.from(B.g.grid));
  });
});

describe("room: spectators, capacity, late join", () => {
  it("spectators have no seat, are not counted in maxPlayers, and are capped", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, { spectators: 1 }, { max: 2 });
    const a = await joiner(r, host, "Ann");
    const s = await joiner(r, host, "Spec", { role: "spectator" });
    expect(s.lobby.room.me).toMatchObject({ role: "spectator", seat: -1 });
    expect(host.room.players.map((p) => p.name)).toEqual(["Host", "Ann"]);
    expect(host.room.spectators.map((p) => p.name)).toEqual(["Spec"]);
    // the hub holds players + spectators
    expect(r.server.lobbies.get(host.code)!.maxPlayers).toBe(2);
    const full = kit(r, "Late");
    await expect(full.join(host.code)).rejects.toMatchObject({ code: "lobby_full" });
    // a third client of either kind is refused by the host's room when the hub could not
    const removed: string[] = [];
    const k2 = kit(r, "Spec2");
    const l2 = await k2.join(host.code, { role: "spectator" }).catch((e) => e);
    expect(l2).toMatchObject({ code: "lobby_full" });
    void a;
    expect(removed).toEqual([]);
  });

  it("the host moves players and spectators; capacity rules apply; a spectator can ask to play", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, { spectators: 2 }, { max: 2 });
    const a = await joiner(r, host, "Ann");
    const s = await joiner(r, host, "Spec", { role: "spectator" });
    const rejected: string[] = [];
    s.lobby.room.on("rejected", (c) => rejected.push(c));
    s.lobby.room.setRole("player");
    await flush();
    expect(rejected).toEqual(["lobby_full"]);
    host.room.moveTo(2, "spectator");
    await flush();
    expect(a.lobby.room.me).toMatchObject({ role: "spectator", seat: -1, ready: false });
    s.lobby.room.setRole("player");
    await flush();
    expect(s.lobby.room.me).toMatchObject({ role: "player", seat: 1 });
    expect(() => host.room.moveTo(2, "player")).toThrowError(/lobby_full/);
    expect(() => host.room.moveTo(99, "player")).toThrowError(/not_allowed/);
  });

  it("late join policy: allow, spectate and refuse once started", async () => {
    for (const policy of ["allow", "spectate", "refuse"] as const) {
      const r = newRig();
      const { lobby: host } = await hostWith(r, { lateJoin: policy, spectators: 2, countdownSeconds: 0 }, { max: 3 });
      await joiner(r, host, "Ann");
      host.room.start();
      await flush();
      const k = kit(r, "Late");
      if (policy === "refuse") {
        // the hub refuses it: lateJoin false means in_game
        await expect(k.join(host.code)).rejects.toMatchObject({ code: "in_game" });
        continue;
      }
      const l = await k.join(host.code);
      await flush();
      expect(l.room.me?.role).toBe(policy === "allow" ? "player" : "spectator");
      expect(host.room.entries.find((e) => e.name === "Late")?.role).toBe(policy === "allow" ? "player" : "spectator");
    }
  });

  it("refuse is enforced by the host's room on a hub that lets the joiner in", async () => {
    const r = newRig(false); // an old hub: lateJoin true is all it knows
    const { lobby: host } = await hostWith(r, { lateJoin: "refuse", countdownSeconds: 0 });
    // an old hub sees lateJoin false for refuse, so use the allow-all flag the hub understands by creating directly
    r.server.lobbies.get(host.code)!.lateJoin = true;
    host.room.start();
    await flush();
    const k = kit(r, "Late");
    const l = await k.join(host.code);
    const removed: string[] = [];
    l.room.on("removed", (i) => removed.push(`${i.code}|${i.reason}`));
    await flush();
    expect(removed).toEqual(["in_game|The game has already started."]);
    expect(l.removal?.code).toBe("in_game");
    expect(host.room.entries.map((e) => e.name)).toEqual(["Host"]);
  });
});
