import { afterEach, describe, expect, it } from "vitest";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { OneLobby } from "../src/onelobby.js";
import type { Lobby } from "../src/lobby.js";
import { webRtcLinkFactoryFor } from "../src/webrtc.js";
import { hostDirect, type DirectLobby, type DirectHostOptions } from "../src/direct/index.js";
import { memoryStore } from "../src/storage.js";
import { freePort, loopbackRtc } from "./helpers.js";
import { FakeRelays } from "./fake-relay.js";

/**
 * The room layer on the Direct routes with the real hub and real WebRTC on 127.0.0.1: an IP code (TCP to the host) and a
 * Nostr code (fake relays in memory). Every host binds 127.0.0.1.
 */
const URLS = ["wss://r1.test", "wss://r2.test"];
const links = webRtcLinkFactoryFor(loopbackRtc(RTCPeerConnection) as unknown as typeof globalThis.RTCPeerConnection);

const until = async (cond: () => boolean, what: string, ms = 10000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

function mk(name: string, relays: FakeRelays) {
  const pidStore = memoryStore();
  const k = new OneLobby({
    gameId: "com.onelobby.roomtest", netVersion: "1", lobbyServer: "", mode: "raw", displayName: name, rememberSeat: false,
    advanced: { linkFactory: links, nostrConnect: relays.connect, playerIdStore: pidStore, banStore: memoryStore(), storage: null },
  });
  return Object.assign(k, { pidStore });
}

type Route = "ip" | "nostr";

async function setup(route: Route, o: DirectHostOptions = {}) {
  const relays = new FakeRelays();
  const port = await freePort();
  const kit = mk("Host", relays);
  const host: DirectLobby = await hostDirect(kit, {
    bindHost: "127.0.0.1", port, openPort: false, log: false, maxPlayers: 2,
    nostr: route === "nostr" ? { relays: URLS, stun: [] } : false, ...o,
  });
  cleanup.push(() => host.leave());
  const join = async (name: string, jo: Record<string, unknown> = {}, k = mk(name, relays)) => {
    const lobby: Lobby = await (route === "nostr" ? k.joinDirect(host.joinCode, { nostrRelays: URLS, stun: [], ...jo }) : k.joinDirect(`127.0.0.1:${port}`, jo));
    cleanup.push(() => lobby.leave());
    return { k, lobby };
  };
  return { host, kit, join, relays, port };
}

for (const route of ["ip", "nostr"] as Route[]) {
  describe(`room over a Direct ${route} lobby`, () => {
    it("replicates the roster, per-player data and ready flags over real links; countdown and start reach everyone", async () => {
      const { host, join } = await setup(route, { room: { countdownSeconds: 1, autoStart: "all_ready", minPlayers: 2 } });
      const ann = await join("Ann", { data: { color: "#ff0000" } });
      await until(() => ann.lobby.room.supported === true && ann.lobby.room.players.length === 2, "room snapshot");
      expect(host.room.player(2)?.data.color).toBe("#ff0000");
      expect(ann.lobby.room.players.map((p) => [p.name, p.seat])).toEqual([["Host", 0], ["Ann", 1]]);
      ann.lobby.room.setReady(true);
      host.room.setReady(true);
      await until(() => ann.lobby.room.state === "countdown", "countdown reaches the joiner");
      await until(() => ann.lobby.phase === "in_game" && host.phase === "in_game", "game starts", 6000);
      expect(ann.lobby.room.state).toBe("started");
      host.room.backToLobby();
      await until(() => ann.lobby.room.state === "lobby" && ann.lobby.phase === "lobby", "back to lobby");
      expect(ann.lobby.room.players.every((p) => !p.ready)).toBe(true);
    }, 40000);

    it("a password is checked by the hub: wrong or missing gives bad_password at join", async () => {
      const { join } = await setup(route, { password: "pw" });
      await expect(join("A")).rejects.toMatchObject({ code: "bad_password" });
      await expect(join("B", { password: "PW" })).rejects.toMatchObject({ code: "bad_password" });
      const c = await join("C", { password: "pw" });
      await until(() => c.lobby.room.supported === true, "room snapshot");
    }, 40000);

    it("spectators ride on extra slots: players are capped, spectators capped separately", async () => {
      const { host, join } = await setup(route, { room: { spectators: 1 } });
      const ann = await join("Ann");
      const spec = await join("Spec", { role: "spectator" });
      await until(() => spec.lobby.room.me?.role === "spectator", "spectator admitted");
      await until(() => ann.lobby.room.supported === true && host.room.players.length === 2, "the player admitted too");
      expect(host.room.players).toHaveLength(2);
      expect(host.room.spectators).toHaveLength(1);
      await expect(join("Late")).rejects.toMatchObject({ code: "lobby_full" });
      void ann;
    }, 40000);

    it("kick shows its reason; ban is refused by the hub by player id at the next join, and unban lifts it", async () => {
      const { host, join } = await setup(route);
      const ann = await join("Ann");
      await until(() => ann.lobby.room.supported === true, "room snapshot");
      const seen: string[] = [];
      ann.lobby.room.on("removed", (i) => seen.push(`${i.code}|${i.reason}|${i.ban}`));
      host.room.ban(2, { reason: "No spoilers" });
      await until(() => seen.length > 0, "removed");
      expect(seen).toEqual(["banned|No spoilers|true"]);
      await expect(join("Ann", {}, ann.k)).rejects.toMatchObject({ code: "banned" });
      expect(host.room.unban(ann.k.playerId)).toBe(1);
      const back = await join("Ann", {}, ann.k);
      await until(() => back.lobby.room.supported === true, "room snapshot after unban");
    }, 40000);
  });
}
