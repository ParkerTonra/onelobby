import { describe, expect, it } from "vitest";
import { BanList, OneLobby } from "../src/internals.js";
import { flush, hostWith, joiner, kit, newRig, wait } from "./room-helpers.js";

type Raw = { handleFrame(from: number, body: Uint8Array): void };

describe("room: seats, reconnecting, seat dropped", () => {
  it("a player who leaves and joins again with the same install gets the same seat back", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, { rejoinWindowSeconds: 0 }); // the hub double reports a closed socket as a timeout
    const a = await joiner(r, host, "Ann");
    await joiner(r, host, "Bob");
    const dropped: string[] = [];
    const restored: string[] = [];
    host.room.on("seatDropped", (i) => dropped.push(`${i.seat}:${i.name}:${i.reason}:${i.afterWindow}`));
    host.room.on("seatRestored", (i) => restored.push(`${i.seat}:${i.name}:${i.returning}`));
    await a.lobby.leave();
    await flush();
    expect(host.room.players.map((p) => p.name)).toEqual(["Host", "Bob"]);
    expect(dropped).toEqual(["1:Ann:timeout:true"]);
    // a newcomer takes the next seat (seat 1 is remembered for Ann)
    const c = await joiner(r, host, "Cara");
    expect(c.lobby.room.me?.seat).toBe(3);
    const a2 = await a.k.join(host.code);
    await flush();
    expect(a2.room.me).toMatchObject({ seat: 1, name: "Ann" });
    expect(restored).toEqual(["1:Ann:true"]);
  });

  it("a dropped link keeps the entry as reconnecting; resuming with the same peer id brings it back", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, { seatDropped: "immediate" });
    const kitB = kit(r, "Bob");
    const lb = await kitB.join(host.code);
    await flush();
    lb.room.setData({ avatar: "5" });
    lb.room.setReady(true);
    await flush();
    const token = lb.resumeToken;
    const seen: string[] = [];
    host.room.on("playerChanged", (e, keys) => seen.push(`${e.name}:${e.status}:${keys.join(",")}`));
    const events: string[] = [];
    host.room.on("seatDropped", (i) => events.push(`dropped:${i.seat}:${i.reason}`));
    host.room.on("seatRestored", (i) => events.push(`restored:${i.seat}:${i.returning}`));
    r.server.sockets[1].close();
    await lb.leave();
    await wait(r, 500);
    expect(host.room.player(2)).toMatchObject({ status: "reconnecting", seat: 1, ready: true, role: "player" });
    expect(host.room.allReady).toBe(false);
    expect(events).toEqual(["dropped:1:disconnected"]); // immediate policy
    const lb2 = await kitB.rejoin(token);
    await wait(r, 1000);
    expect(host.room.player(2)).toMatchObject({ status: "connected", seat: 1, ready: true });
    expect(host.room.player(2)?.data.avatar).toBe("5");
    expect(lb2.room.supported).toBe(true);
    expect(lb2.room.me).toMatchObject({ seat: 1, status: "connected" });
    expect(events).toEqual(["dropped:1:disconnected", "restored:1:true"]);
    expect(seen).toContain("Bob:reconnecting:status");
  });

  it("past the rejoin window the entry is removed and the seat-dropped hook fires once", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, { rejoinWindowSeconds: 30 });
    const kitB = kit(r, "Bob");
    const lb = await kitB.join(host.code);
    await flush();
    const left: string[] = [];
    host.room.on("playerLeft", (e, why) => left.push(`${e.name}:${e.status}:${why}`));
    const dropped: string[] = [];
    host.room.on("seatDropped", (i) => dropped.push(`${i.seat}:${i.reason}:${i.afterWindow}:${i.name}`));
    r.server.sockets[1].close();
    await lb.leave();
    await wait(r, 29_000);
    expect(host.room.player(2)?.status).toBe("reconnecting");
    expect(dropped).toEqual([]);
    await wait(r, 2000);
    expect(host.room.player(2)).toBeUndefined();
    expect(left).toEqual(["Bob:left:timeout"]);
    expect(dropped).toEqual(["1:timeout:true:Bob"]);
  });

  it("a rejoin window of 0 removes at once", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, { rejoinWindowSeconds: 0 });
    const lb = await kit(r, "Bob").join(host.code);
    await flush();
    r.server.sockets[1].close();
    await lb.leave();
    await wait(r, 300);
    expect(host.room.player(2)).toBeUndefined();
  });
});

describe("room: kick, ban, reasons", () => {
  it("kick shows the removed player a code and a plain sentence, and it may come back", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r);
    const a = await joiner(r, host, "Ann");
    const seen: string[] = [];
    a.lobby.room.on("removed", (i) => seen.push(`${i.code}|${i.reason}|${i.ban}`));
    const ended: string[] = [];
    a.lobby.on("sessionEnded", (why) => ended.push(why));
    host.room.kick(2, { code: "too_loud", reason: "Please use push to talk." });
    await flush();
    expect(seen).toEqual(["too_loud|Please use push to talk.|false"]);
    expect(a.lobby.removal).toEqual({ code: "too_loud", reason: "Please use push to talk.", ban: false });
    expect(ended).toEqual(["disconnected"]);
    expect(host.room.player(2)).toBeUndefined();
    const again = await a.k.join(host.code);
    expect(again.room.me?.name).toBe("Ann");
    const seen2: string[] = [];
    again.room.on("removed", (i) => seen2.push(`${i.code}|${i.reason}`));
    host.room.kick(again.localPeerId);
    await flush();
    expect(seen2).toEqual(["kicked|The host removed you from the game."]);
  });

  it("ban removes for good: the hub refuses the player id at join(), the list survives and unban lifts it", async () => {
    const r = newRig();
    const { k, lobby: host } = await hostWith(r);
    const a = await joiner(r, host, "Ann");
    const seen: string[] = [];
    a.lobby.room.on("removed", (i) => seen.push(`${i.code}|${i.reason}|${i.ban}`));
    host.room.ban(2, { reason: "spam" });
    await flush();
    expect(seen).toEqual(["banned|spam|true"]);
    const list = host.room.bans.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: a.k.playerId, name: "Ann", reason: "spam", code: "banned" });
    expect(r.server.received.some((m) => m.t === "bans" && (m.ids as string[]).includes(a.k.playerId))).toBe(true);
    await expect(a.k.join(host.code)).rejects.toMatchObject({ code: "banned" });
    // a fresh BanList over the same store (a restart) still has it
    expect(new BanList(k.banKv, "gridpaint").list().map((e) => e.id)).toEqual([a.k.playerId]);
    expect(host.room.unban(a.k.playerId)).toBe(1);
    const back = await a.k.join(host.code);
    expect(back.room.me?.name).toBe("Ann");
  });

  it("on a hub without the room feature the host's room still refuses a banned id, with the reason", async () => {
    const r = newRig(false);
    const { lobby: host } = await hostWith(r);
    const a = await joiner(r, host, "Ann");
    host.room.ban(2, { reason: "spam" });
    await flush();
    const l = await a.k.join(host.code);
    const seen: string[] = [];
    l.room.on("removed", (i) => seen.push(`${i.code}|${i.reason}`));
    await flush();
    expect(seen).toEqual(["banned|You are banned from this game."]);
    expect(l.removal?.code).toBe("banned");
    expect(host.room.entries.map((e) => e.name)).toEqual(["Host"]);
  });

  it("a ban by address alone (no player id) catches a client by its link address", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r);
    host.room.bans.add({ ip: "192.0.2.7", reason: "earlier" });
    const a = await joiner(r, host, "Ann");
    expect(host.room.player(2)).toBeDefined();
    const seen: string[] = [];
    a.lobby.room.on("removed", (i) => seen.push(i.code));
    host.room.onLinkAddress(2, "::ffff:192.0.2.7");
    await flush();
    expect(seen).toEqual(["banned"]);
    expect(() => host.room.bans.add({ ip: "127.0.0.1" })).toThrowError(/needs a player id or an address/);
  });

  it("bad kick codes throw; only the host can kick", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r);
    const a = await joiner(r, host, "Ann");
    expect(() => host.room.kick(2, { code: "Bad Code" })).toThrowError(RangeError);
    expect(() => a.lobby.room.kick(1)).toThrowError(/only the host/);
  });
});

describe("room: passwords", () => {
  it("a server lobby with a password refuses a missing or wrong one with bad_password", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, {}, { password: "Hunter2" });
    await expect(kit(r, "A").join(host.code)).rejects.toMatchObject({ code: "bad_password" });
    await expect(kit(r, "B").join(host.code, { password: "hunter2" })).rejects.toMatchObject({ code: "bad_password" });
    const ok = await kit(r, "C").join(host.code, { password: "Hunter2" });
    await flush();
    expect(ok.room.supported).toBe(true);
    expect(host.room.players.map((p) => p.name)).toEqual(["Host", "C"]);
  });

  it("on a hub that does not know passwords the host's room checks it and the joiner is told why", async () => {
    const r = newRig(false);
    const { lobby: host } = await hostWith(r, {}, { password: "Hunter2" });
    const errors: string[] = [];
    const bad = kit(r, "Bad");
    bad.on("error", (e) => errors.push((e as { code?: string }).code ?? e.message));
    const lb = await bad.join(host.code, { password: "nope" });
    const seen: string[] = [];
    lb.room.on("removed", (i) => seen.push(`${i.code}|${i.reason}`));
    await flush();
    expect(seen).toEqual(["bad_password|Wrong password."]);
    expect(errors).toEqual(["bad_password"]);
    const good = await kit(r, "Good").join(host.code, { password: "Hunter2" });
    await flush();
    expect(good.room.supported).toBe(true);
    expect(host.room.players.map((p) => p.name)).toEqual(["Host", "Good"]);
    expect(host.room.entries.some((e) => e.name === "Bad")).toBe(false);
  });

  it("the password never appears in the room state", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r, {}, { password: "Hunter2" });
    const a = await kit(r, "A").join(host.code, { password: "Hunter2" });
    await flush();
    expect(JSON.stringify([a.room.entries, a.room.settings])).not.toContain("Hunter2");
  });

  it("room.passwordRequired makes host() fail without one", async () => {
    const r = newRig();
    await expect(kit(r, "H").host({ name: "t", maxPlayers: 2, room: { passwordRequired: true } })).rejects.toMatchObject({ code: "password_required" });
    const ok = await kit(r, "H2").host({ name: "t", maxPlayers: 2, room: { passwordRequired: true }, password: "x" });
    expect(ok.code).toBeTruthy();
  });
});

describe("room: compatibility", () => {
  it("a joiner of a host without the room layer learns it after the wait, reads the hub roster and cannot mutate", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r);
    (host.room as unknown as Raw).handleFrame = () => {}; // an older host ignores the room frame
    const l = await kit(r, "Ann").join(host.code);
    const events: string[] = [];
    l.room.on("unsupported", () => events.push("unsupported"));
    await flush();
    expect(l.room.supported).toBeUndefined();
    expect(l.room.players.map((p) => [p.id, p.name])).toEqual([[1, "Host"], [2, "Ann"]]);
    await wait(r, 3100);
    expect(l.room.supported).toBe(false);
    expect(events).toEqual(["unsupported"]);
    expect(() => l.room.setReady(true)).toThrowError(/room_unsupported/);
    expect(l.room.state).toBe("lobby");
  });

  it("an old joiner is admitted as a legacy player: no room frames, never ready, not counted", async () => {
    const r = newRig();
    const { k: hk, lobby: host } = await hostWith(r, { autoStart: "all_ready", countdownSeconds: 0, minPlayers: 1 });
    const errors: Error[] = [];
    hk.on("error", (e) => errors.push(e));
    const l = await kit(r, "Old").join(host.code);
    (l.room as unknown as { onHostLink: () => void }).onHostLink = () => {}; // an older client sends no room join
    await wait(r, 500);
    expect(host.room.player(2)).toBeUndefined(); // still inside the wait
    await wait(r, 3000);
    expect(host.room.player(2)).toMatchObject({ legacy: true, role: "player", seat: 1, ready: false, name: "Old" });
    host.room.setReady(true);
    await flush();
    expect(host.room.state).toBe("started"); // the legacy player does not block all_ready
    expect(errors).toEqual([]);
    expect(l.room.supported).toBeUndefined();
  });

  it("a hub without the room feature gets the spectator slots added to its capacity, and the room splits them", async () => {
    const r = newRig(false);
    const { lobby: host } = await hostWith(r, { spectators: 2 }, { max: 2 });
    expect(r.server.lobbies.get(host.code)!.maxPlayers).toBe(4);
    expect(host.room.settings.maxPlayers).toBe(2);
    await joiner(r, host, "Ann");
    const c = await joiner(r, host, "Cara"); // would be a third player: the room refuses it
    expect(c.lobby.removal?.code).toBe("lobby_full");
    expect(host.room.players).toHaveLength(2);
    const s = await joiner(r, host, "Spec", { role: "spectator" });
    expect(s.lobby.room.me?.role).toBe("spectator");
  });

  it("a game that never touches lobby.room sees no change in peers, phase or messages", async () => {
    const r = newRig(false);
    const { lobby: host } = await hostWith(r);
    const a = await joiner(r, host, "Ann");
    const got: number[][] = [];
    a.lobby.on("message", (_f, b) => got.push([...b]));
    host.broadcast(Uint8Array.of(1, 2, 3));
    await host.start();
    await flush();
    expect(got).toEqual([[1, 2, 3]]);
    expect(a.lobby.phase).toBe("in_game");
    expect(host.peers.map((p) => p.name)).toEqual(["Host", "Ann"]);
    expect(host.room.state).toBe("started"); // the room follows a direct lobby.start()
  });
});

describe("room: robustness", () => {
  it("a replica that misses an update asks for a snapshot and converges", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r);
    const a = await joiner(r, host, "Ann");
    const room = a.lobby.room as unknown as Raw;
    room.handleFrame(1, new TextEncoder().encode(JSON.stringify({ t: "upd", rev: a.lobby.room.revision + 5, players: [] })));
    await flush();
    expect(a.lobby.room.revision).toBe(host.room.revision);
    // junk is dropped, never thrown
    for (const junk of ["", "[]", "{", '{"t":5}', '{"t":"zzz"}', '{"t":"snap"}']) room.handleFrame(1, new TextEncoder().encode(junk));
    expect(a.lobby.room.players).toHaveLength(2);
  });

  it("too many requests in a second are refused with rate_limited", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r);
    const a = await joiner(r, host, "Ann");
    const codes: string[] = [];
    a.lobby.room.on("rejected", (c) => codes.push(c));
    for (let i = 0; i < 14; i++) a.lobby.room.setReady(i % 2 === 0);
    await flush();
    expect(codes.length).toBeGreaterThanOrEqual(3);
    expect(new Set(codes)).toEqual(new Set(["rate_limited"]));
  });

  it("host migration: the new host rebuilds the room from its replica and rebinds each player", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r);
    const a = await joiner(r, host, "Ann", { data: { color: "#abcdef" } });
    const b = await joiner(r, host, "Bob");
    a.lobby.room.setReady(true);
    await wait(r, 500);
    await host.leave();
    await wait(r, 3000);
    expect(a.lobby.isHost).toBe(true);
    expect(a.lobby.room.supported).toBe(true);
    expect(a.lobby.room.players.map((p) => [p.name, p.status])).toEqual([["Ann", "connected"], ["Bob", "connected"]]);
    expect(a.lobby.room.me?.data.color).toBe("#abcdef");
    expect(a.lobby.room.me?.ready).toBe(true);
    expect(b.lobby.room.players.map((p) => p.name)).toEqual(["Ann", "Bob"]);
    a.lobby.room.setData(3, { team: "2" });
    await flush();
    expect(b.lobby.room.me?.data.team).toBe("2");
  });
});

describe("room: blueprint", () => {
  it("onelobby.json room keys fill the host's settings", async () => {
    const r = newRig();
    const adv = (n: string) => ({ socketFactory: r.server.socketFactory, linkFactory: r.net.factoryFor(n), clock: r.clock, voiceCodec: null, createMic: null, createSink: null, storage: null });
    const file = {
      game: { id: "gridpaint" },
      hosting: { lobbyServer: "mem://server" },
      lobby: { maxPlayers: 4 },
      room: { autoStart: "players", autoStartPlayers: 3, minPlayers: 2, countdownSeconds: 5, spectators: 2, lateJoin: "spectate", seatDropped: "immediate", rejoinWindowSeconds: 10, data: { role: { type: "enum", values: ["a", "b"], default: "a" } } },
    };
    const host = await OneLobby.fromConfig(file, { advanced: adv("bp") }).host();
    expect(host.room.settings).toMatchObject({ autoStart: "players", autoStartPlayers: 3, minPlayers: 2, countdownMs: 5000, spectators: 2, lateJoin: "spectate", seatDropped: "immediate", rejoinWindowMs: 10_000, maxPlayers: 4 });
    expect(host.room.settings.data.role).toMatchObject({ type: "enum", default: "a" });
    expect(host.room.me?.data.role).toBe("a");
    expect(r.server.lobbies.get(host.code)!.maxPlayers).toBe(4); // the hub has the room feature: players only, spectators are extra slots
    const k2 = OneLobby.fromConfig({ game: { id: "gridpaint" }, hosting: { lobbyServer: "mem://server" }, room: { passwordRequired: true } }, { advanced: adv("bp2") });
    await expect(k2.host()).rejects.toMatchObject({ code: "password_required" });
  });
});
