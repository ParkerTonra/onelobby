// Runs only when KEEPALIVE_SERVER=ws://localhost:8080/ws is set (stream A's server). Real WebSocket + real timers;
// peer links are in-memory (Node has no RTCPeerConnection), so this checks the signaling contract end to end.
import { describe, expect, it } from "vitest";
import { Keepalive, KeepaliveError } from "../src/index.js";
import { MemoryNetwork } from "../src/testing.js";
import { FakeCodec, Player } from "./helpers.js";

const url = process.env.KEEPALIVE_SERVER;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!f() && Date.now() - t < ms) await wait(20);
  if (!f()) throw new Error("timeout");
};

describe.skipIf(!url)("against a real keepalive-server", () => {
  const net = new MemoryNetwork();
  const mk = (name: string, netVersion = "1") =>
    new Keepalive({
      gameId: "gridpaint", netVersion, lobbyServer: url!, mode: "lockstep", tickRate: 20, displayName: name,
      linkFactory: net.factoryFor(name), voiceCodec: new FakeCodec(), createMic: null, createSink: null,
    });

  it("host, list, join, play with equal hashes, chat, migrate, version gate", async () => {
    const a = mk("alice");
    const la = await a.host({ name: "e2e", maxPlayers: 4, visibility: "public", lateJoin: true, meta: { map: "x" } });
    expect(la.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(la.localPeerId).toBe(1);

    const listed = await mk("lister").list({ meta: { map: "x" } });
    expect(listed.map((l) => l.code)).toContain(la.code);

    await expect(mk("old", "0").join(la.code)).rejects.toMatchObject({ code: "version_mismatch" });
    await expect(mk("nobody").join("ZZZZZZ")).rejects.toBeInstanceOf(KeepaliveError);

    const lb = await mk("bob").join(la.code.slice(0, 3).toLowerCase() + " " + la.code.slice(3));
    const lc = await mk("cara").join(la.code);
    await until(() => la.peers.length === 3);
    const [A, B, C] = [new Player("a", la), new Player("b", lb), new Player("c", lc)];
    const chats: string[] = [];
    lc.chat.on("message", (m) => chats.push(m.text));
    await la.start();
    const pump = setInterval(() => [A, B, C].forEach((p) => p.pump()), 20);
    A.paint(3, 3);
    B.paint(9, 9);
    await wait(100);
    lb.chat.send("hello from bob");
    await until(() => A.g.tick >= 60 && C.g.tick >= 60, 10000);
    expect(chats).toContain("hello from bob");
    for (const t of [20, 40, 60]) {
      expect(B.hashes.get(t)).toBe(A.hashes.get(t));
      expect(C.hashes.get(t)).toBe(A.hashes.get(t));
    }
    expect(lb.phase).toBe("in_game");

    // host leaves: server picks bob (lowest remaining id); play continues
    await la.leave();
    await until(() => lb.isHost && lc.hostPeerId === 2, 8000);
    const t0 = B.g.tick;
    await until(() => B.g.tick > t0 + 40 && C.g.tick > t0 + 30, 8000);
    const t = Math.min(B.g.tick, C.g.tick);
    const tt = t - (t % 20);
    await until(() => B.hashes.has(tt) && C.hashes.has(tt));
    expect(C.hashes.get(tt)).toBe(B.hashes.get(tt));
    clearInterval(pump);
    await lb.leave();
    await lc.leave();
  }, 40000);
});
