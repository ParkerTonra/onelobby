// Runs only when ONELOBBY_SERVER=ws://127.0.0.1:PORT/ws is set (the C# server): the room additions against the real hub.
// Peer links are in-memory (Node has no RTCPeerConnection here); the signaling is a real WebSocket.
import { describe, expect, it } from "vitest";
import { OneLobby } from "../src/internals.js";
import { MemoryNetwork } from "../src/testing.js";
import { memoryStore } from "../src/storage.js";
import { FakeCodec } from "./helpers.js";

const url = process.env.ONELOBBY_SERVER;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!f() && Date.now() - t < ms) await wait(20);
  if (!f()) throw new Error("timeout");
};

describe.skipIf(!url)("the room layer against a real onelobby-server", () => {
  const net = new MemoryNetwork();
  const game = `roomtest-${Math.random().toString(36).slice(2, 8)}`;
  const mk = (name: string, idStore = memoryStore()) =>
    Object.assign(
      new OneLobby({
        gameId: game, netVersion: "1", lobbyServer: url!, mode: "raw", displayName: name, rememberSeat: false,
        linkFactory: net.factoryFor(name + Math.random()), voiceCodec: new FakeCodec(), createMic: null, createSink: null,
        advanced: { playerIdStore: idStore, banStore: memoryStore(), storage: null },
      }),
      { pidKv: idStore },
    );

  it("password, spectator slots, player-id ban and kick code all work on the real hub", async () => {
    const hk = mk("host");
    const host = await hk.host({ name: "r", maxPlayers: 2, password: "pw", room: { spectators: 1, countdownSeconds: 0 } });
    await expect(mk("a").join(host.code)).rejects.toMatchObject({ code: "bad_password" });
    await expect(mk("b").join(host.code, { password: "PW" })).rejects.toMatchObject({ code: "bad_password" });
    const ak = mk("ann");
    const ann = await ak.join(host.code, { password: "pw" });
    const spec = await mk("spec").join(host.code, { password: "pw", role: "spectator" });
    await until(() => ann.room.supported === true && spec.room.supported === true);
    expect(host.room.players.map((p) => p.name)).toEqual(["host", "ann"]);
    expect(host.room.spectators.map((p) => p.name)).toEqual(["spec"]);
    await expect(mk("late").join(host.code, { password: "pw" })).rejects.toMatchObject({ code: "lobby_full" });
    expect((await hk.list({})).length).toBeGreaterThanOrEqual(0);

    const seen: string[] = [];
    ann.room.on("removed", (i) => seen.push(`${i.code}|${i.reason}`));
    host.room.ban(2, { code: "spam", reason: "No spam." });
    await until(() => seen.length > 0);
    expect(seen).toEqual(["spam|No spam."]);
    await expect(ak.join(host.code, { password: "pw" })).rejects.toMatchObject({ code: "banned" });
    host.room.unban(ak.playerId);
    const back = await ak.join(host.code, { password: "pw" });
    await until(() => back.room.supported === true);
    await host.leave();
  }, 30000);
});
