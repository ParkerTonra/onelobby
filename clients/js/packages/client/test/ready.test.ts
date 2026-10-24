import { describe, expect, it } from "vitest";
import { settle } from "../src/testing.js";
import { rig } from "./helpers.js";

const b = (...n: number[]) => Uint8Array.of(...n);

describe("sends before the peer's channels are open", () => {
  it("host: reliable send/broadcast to a just-joined peer is queued and flushed in order after peerReady", async () => {
    const r = rig();
    const la = await r.make("alice", { mode: "raw" }).host({ name: "t", maxPlayers: 4 });
    const order: string[] = [];
    la.on("peerJoined", (p) => {
      order.push("joined");
      la.send(p.peerId, b(1));
      la.broadcast(b(2));
      la.send(p.peerId, b(3), { channel: "fast" }); // lossy by contract: dropped, not queued
      la.chat.send("hello"); // chat to a not-yet-connected peer is covered by chat_history
    });
    la.on("peerReady", (p) => order.push("ready" + p.peerId));
    const lb = await r.make("bob", { mode: "raw" }).join(la.code);
    const got: [number, number, string][] = [];
    lb.on("message", (from, bytes, ch) => got.push([from, bytes[0], ch]));
    await settle();
    expect(order).toEqual(["joined", "ready2"]);
    expect(got).toEqual([[1, 1, "reliable"], [1, 2, "reliable"]]);
    expect(lb.chat.history.map((m) => m.text)).toEqual(["hello"]);
  });

  it("joiner: ready resolves when the host link is open; earlier raw sends and chat flush in order", async () => {
    const r = rig();
    const la = await r.make("alice", { mode: "raw" }).host({ name: "t", maxPlayers: 4 });
    const atHost: [number, number][] = [];
    la.on("message", (from, bytes) => atHost.push([from, bytes[0]]));
    const chats: string[] = [];
    la.chat.on("message", (m) => chats.push(m.text));
    await la.ready; // the host is ready immediately
    const lb = await r.make("bob", { mode: "raw" }).join(la.code);
    let readyFired = 0;
    lb.on("ready", () => readyFired++);
    const states: boolean[] = [];
    void lb.ready.then(() => states.push(true));
    lb.send(1, b(10));
    lb.broadcast(b(11));
    lb.chat.send("early");
    await lb.ready;
    lb.send(1, b(12));
    await settle();
    expect(readyFired).toBe(1);
    expect(states).toEqual([true]);
    expect(atHost).toEqual([[2, 10], [2, 11], [2, 12]]);
    expect(chats).toEqual(["early"]);
  });

  it("lockstep joiner: commands submitted before the link opens are delivered", async () => {
    const r = rig();
    const la = await r.make("alice").host({ name: "t", maxPlayers: 4 });
    const lb = await r.make("bob").join(la.code);
    lb.lockstep.submit(b(1, 5, 5));
    await settle();
    await la.start();
    r.clock.advance(200);
    await settle();
    const seen: number[] = [];
    let f;
    while ((f = la.lockstep.nextFrame())) for (const c of f.commands) seen.push(c.peerId);
    expect(seen).toEqual([2]);
  });
});
