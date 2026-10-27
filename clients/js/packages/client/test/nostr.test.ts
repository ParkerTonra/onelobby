import { describe, expect, it } from "vitest";
import { decodeJoinCode, encodeRoomCode, encodeRoomCodeFor, normalizeJoinCode } from "../src/joincode.js";
import { schnorrPublicKey, schnorrSign, schnorrVerify } from "../src/nostr/secp256k1.js";
import { decryptContent, deriveRoomKeys, encryptContent, fromHex, toHex } from "../src/nostr/crypto.js";
import { eventId, makeEvent, checkNostrRelays, RelayPool, DEFAULT_NOSTR_RELAYS } from "../src/nostr/relays.js";
import { ReliableLink, type Frame, type OutFrame } from "../src/nostr/link.js";
import { ManualClock } from "../src/testing.js";
import { systemClock } from "../src/clock.js";
import { JOIN_CODE_KINDS, joinCodeKindName } from "../src/join-code-kind.js";
import * as L from "../src/nostr/limits.js";
import { FakeRelays } from "./fake-relay.js";
import { specJson } from "./spec.js";

const vec = specJson("vectors/nostr.json");
const jc = specJson("vectors/joincode.json");

describe("limits and timers (spec/vectors/nostr-limits.json)", () => {
  const lim = specJson("vectors/nostr-limits.json");
  const expected: Record<string, Record<string, number>> = {
    link: { batchMs: L.BATCH_MS, resendMs: L.RESEND_MS, maxResends: L.MAX_RESENDS, beatMs: L.BEAT_MS, silenceMs: L.SILENCE_MS, maxHeld: L.MAX_HELD,
      maxOutFrames: L.MAX_OUT_FRAMES, maxOutBytes: L.MAX_OUT_BYTES, maxFrameBytes: L.MAX_FRAME_BYTES, tickMs: L.TICK_MS },
    host: { newSessionBurst: L.NEW_SESSION_BURST, maxSessionBurst: L.MAX_SESSION_BURST, newSessionRefillMs: L.NEW_SESSION_REFILL_MS,
      waitingMax: L.WAITING_MAX, waitingStaleMs: L.WAITING_STALE_MS },
    socket: { openEveryMs: L.OPEN_EVERY_MS, giveUpMs: L.GIVE_UP_MS },
    relays: { hostFirstRelayMs: L.HOST_FIRST_RELAY_MS, hostNostrFirstRelayMs: L.HOST_NOSTR_FIRST_RELAY_MS, joinerFirstRelayMs: L.JOINER_FIRST_RELAY_MS,
      restWaitMs: L.RELAY_REST_WAIT_MS, restPollMs: L.RELAY_REST_POLL_MS },
  };
  it("the code's constants equal the vector, key for key", () => {
    for (const group of Object.keys(expected)) expect(expected[group], group).toEqual(lim[group]);
    expect(Object.keys(lim).filter((k) => k !== "$comment").sort()).toEqual(Object.keys(expected).sort());
  });
});

describe("version 1 join codes (spec/vectors/joincode.json)", () => {
  it("rooms encode and decode", () => {
    for (const r of jc.rooms) {
      expect(encodeRoomCodeFor(r.room)).toBe(r.code);
      expect(decodeJoinCode(r.code)).toEqual({ room: r.room });
    }
    for (const a of jc.roomAliases) expect(decodeJoinCode(a.input)).toEqual({ room: a.room });
  });
  it("random rooms are 12 hex digits and differ", () => {
    const a = encodeRoomCode();
    const b = encodeRoomCode();
    expect(a).not.toBe(b);
    const d = decodeJoinCode(a);
    expect("room" in d && /^[0-9a-f]{12}$/.test(d.room)).toBe(true);
  });
  it("a typo in a room code fails the check; versions 2 and 3 stay unknown", () => {
    const code = normalizeJoinCode(encodeRoomCodeFor("0123456789ab"))!;
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    for (let i = 0; i < code.length; i++)
      for (const c of alphabet) if (c !== code[i]) expect("error" in decodeJoinCode(code.slice(0, i) + c + code.slice(i + 1))).toBe(true);
  });
});

describe("BIP340 Schnorr (official vectors)", () => {
  for (const v of vec.bip340) {
    it(`signs vector ${v.index}`, async () => {
      expect(toHex(schnorrPublicKey(fromHex(v.secretKey))).toUpperCase()).toBe(v.publicKey);
      const sig = await schnorrSign(fromHex(v.message), fromHex(v.secretKey), fromHex(v.auxRand));
      expect(toHex(sig).toUpperCase()).toBe(v.signature);
      expect(await schnorrVerify(sig, fromHex(v.message), fromHex(v.publicKey))).toBe(true);
    });
  }
  it("rejects a tampered message or signature", async () => {
    const v = vec.bip340[1];
    const sig = fromHex(v.signature);
    const msg = fromHex(v.message);
    const bad = msg.slice();
    bad[0] ^= 1;
    expect(await schnorrVerify(sig, bad, fromHex(v.publicKey))).toBe(false);
    const badSig = sig.slice();
    badSig[40] ^= 1;
    expect(await schnorrVerify(badSig, msg, fromHex(v.publicKey))).toBe(false);
  });
});

describe("keys, encryption and events (spec/vectors/nostr.json)", () => {
  it("derives key and topic", async () => {
    const k = await deriveRoomKeys(normalizeJoinCode(vec.keys.code)!);
    expect(toHex(k.key)).toBe(vec.keys.key);
    expect(k.topic).toBe(vec.keys.topic);
    expect(normalizeJoinCode(vec.keys.code)).toBe(vec.keys.normalized);
  });
  it("encrypts and decrypts the vector frame", async () => {
    const content = await encryptContent(fromHex(vec.crypto.key), vec.crypto.plaintext, fromHex(vec.crypto.iv));
    expect(content).toBe(vec.crypto.content);
    expect(await decryptContent(fromHex(vec.crypto.key), vec.crypto.content)).toBe(vec.crypto.plaintext);
    expect(await decryptContent(fromHex(vec.crypto.key).map((b) => b ^ 1), vec.crypto.content)).toBeNull();
    expect(await decryptContent(fromHex(vec.crypto.key), "not base64!!")).toBeNull();
  });
  it("computes the NIP-01 event id", async () => {
    const e = vec.event;
    expect(await eventId(e.pubkey, e.created_at, e.kind, e.tags, e.content)).toBe(e.id);
  });
  it("makeEvent signs a verifiable kind 25050 event under the topic", async () => {
    const secret = fromHex(vec.bip340[1].secretKey);
    const ev = await makeEvent(secret, vec.keys.topic, "x", 1700000000);
    expect(ev.kind).toBe(25050);
    expect(ev.tags).toEqual([["t", vec.keys.topic]]);
    expect(ev.pubkey).toBe(vec.bip340[1].publicKey.toLowerCase());
    expect(await eventId(ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content)).toBe(ev.id);
    expect(await schnorrVerify(fromHex(ev.sig), fromHex(ev.id), fromHex(ev.pubkey))).toBe(true);
  });
});

/** Two links joined by a channel the test can drop, reorder and duplicate on. */
function pair(clock: ManualClock, opts: { drop?: (f: OutFrame, dir: "ab" | "ba") => boolean } = {}) {
  const gotA: string[] = [];
  const gotB: string[] = [];
  const dead = { a: "", b: "" };
  const closed = { a: "", b: "" };
  const wire: { a: ReliableLink | null; b: ReliableLink | null } = { a: null, b: null };
  const sent = { ab: [] as OutFrame[], ba: [] as OutFrame[] };
  const deliver = (to: "a" | "b", f: OutFrame, dir: "ab" | "ba") => {
    sent[dir].push(f);
    if (opts.drop?.(f, dir)) return;
    const frame = { v: 1, from: "", to: "", ...f } as Frame;
    wire[to]!.receive(frame);
  };
  wire.a = new ReliableLink({
    clock,
    send: (f) => deliver("b", f, "ab"),
    deliver: (t) => gotA.push(t),
    onPeerClose: (r) => (closed.a = r || "closed"),
    onDead: (r) => (dead.a = r),
  });
  wire.b = new ReliableLink({
    clock,
    send: (f) => deliver("a", f, "ba"),
    deliver: (t) => gotB.push(t),
    onPeerClose: (r) => (closed.b = r || "closed"),
    onDead: (r) => (dead.b = r),
  });
  return { a: wire.a, b: wire.b, gotA, gotB, dead, closed, sent };
}

describe("frame layer (ReliableLink)", () => {
  it("batches sends within 30 ms into one frame and acknowledges with a beat", () => {
    const clock = new ManualClock();
    const p = pair(clock);
    p.a.send("1");
    p.a.send("2");
    p.a.send("3");
    expect(p.sent.ab).toHaveLength(0);
    clock.advance(30);
    expect(p.sent.ab).toHaveLength(1);
    expect(p.sent.ab[0]).toMatchObject({ type: "data", seq: 1, msgs: ["1", "2", "3"] });
    expect(p.gotB).toEqual(["1", "2", "3"]);
    clock.advance(30);
    expect(p.sent.ba.at(-1)).toMatchObject({ type: "beat", ack: 1 });
    clock.advance(10_000); // acked: nothing to resend
    expect(p.sent.ab.filter((f) => f.type === "data")).toHaveLength(1);
  });

  it("splits a big batch under 32 KiB per frame", () => {
    const clock = new ManualClock();
    const p = pair(clock);
    const big = "x".repeat(12_000);
    for (let i = 0; i < 7; i++) p.a.send(big);
    clock.advance(30);
    const frames = p.sent.ab.filter((f) => f.type === "data");
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(JSON.stringify(f).length).toBeLessThan(32 * 1024);
    expect(p.gotB).toHaveLength(7);
  });

  it("delivers in order despite reordering, and drops duplicates", () => {
    const clock = new ManualClock();
    const held: OutFrame[] = [];
    const p = pair(clock, { drop: (f, dir) => (dir === "ab" && f.type === "data" && f.seq === 1 && held.length === 0 ? (held.push(f), true) : false) });
    p.a.send("one");
    clock.advance(30);
    p.a.send("two");
    clock.advance(30);
    expect(p.gotB).toEqual([]); // seq 2 is held until seq 1 arrives
    p.b.receive({ v: 1, from: "", to: "", ...held[0] } as Frame);
    expect(p.gotB).toEqual(["one", "two"]);
    p.b.receive({ v: 1, from: "", to: "", ...held[0] } as Frame); // duplicate
    expect(p.gotB).toEqual(["one", "two"]);
  });

  it("resends an unacknowledged frame after 3 s and recovers", () => {
    const clock = new ManualClock();
    let dropped = 0;
    const p = pair(clock, { drop: (f, dir) => dir === "ab" && f.type === "data" && dropped++ < 2 });
    p.a.send("hello");
    clock.advance(30);
    expect(p.gotB).toEqual([]);
    clock.advance(3300);
    expect(p.gotB).toEqual([]); // first resend dropped too
    clock.advance(3300);
    expect(p.gotB).toEqual(["hello"]);
    expect(p.dead.a).toBe("");
  });

  it("gives up after 5 resends: dead with reason timeout", () => {
    const clock = new ManualClock();
    const p = pair(clock, { drop: (_f, dir) => dir === "ab" });
    p.a.send("lost");
    clock.advance(30);
    for (let i = 0; i < 5; i++) {
      clock.advance(3300);
      expect(p.dead.a).toBe("");
    }
    clock.advance(3300);
    expect(p.dead.a).toBe("timeout");
    expect(p.sent.ab.filter((f) => f.type === "data")).toHaveLength(6); // first send + 5 resends
  });

  it("sends a beat after 10 s of quiet and times out after 30 s of silence", () => {
    const clock = new ManualClock();
    const p = pair(clock, { drop: (f, dir) => dir === "ba" && f.type === "beat" });
    clock.advance(10_250);
    expect(p.sent.ab.some((f) => f.type === "beat")).toBe(true);
    clock.advance(20_000);
    expect(p.dead.a).toBe("timeout");
  });

  it("close frame reaches the peer with its reason, after queued data", () => {
    const clock = new ManualClock();
    const p = pair(clock);
    p.a.send("last words");
    p.a.close("bye");
    expect(p.gotB).toEqual(["last words"]);
    expect(p.closed.b).toBe("bye");
    expect(p.a.closed).toBe(true);
  });
});

describe("relay pool", () => {
  it("dedupes events, skips a relay that refuses events, reconnects with backoff", async () => {
    const relays = new FakeRelays();
    const urls = ["wss://a.test", "wss://b.test", "wss://c.test"];
    relays.down.add("wss://c.test");
    const got: string[] = [];
    const pool = new RelayPool({ urls, topic: "tt", connect: relays.connect, clock: systemClock, wall: Date.now, onEvent: (e) => got.push(e.id) });
    pool.start();
    expect(await pool.whenUp(2000)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(pool.connected).toBe(2);
    const secret = fromHex(vec.bip340[1].secretKey);
    const ev = await makeEvent(secret, "tt", "c", Math.floor(Date.now() / 1000));
    pool.publish(ev);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([ev.id]); // echoed by both relays, delivered once
    relays.refuse.add("wss://b.test");
    pool.publish(await makeEvent(secret, "tt", "d", Math.floor(Date.now() / 1000)));
    await new Promise((r) => setTimeout(r, 50));
    expect(pool.connected).toBe(1);
    pool.close();
  });
});

describe("join code kinds (spec/vectors/join-code-kinds.json)", () => {
  it("the tuple and the name mapper match the vector, in order", () => {
    const kinds: { wire: string; name: string }[] = specJson("vectors/join-code-kinds.json").kinds;
    expect([...JOIN_CODE_KINDS]).toEqual(kinds.map((k) => k.wire));
    for (const k of kinds) expect(joinCodeKindName(k.wire as (typeof JOIN_CODE_KINDS)[number])).toBe(k.name);
  });
});

describe("default relay list", () => {
  it("is the default in spec/blueprint.schema.json (hosting.nostrRelays)", () => {
    const schema = specJson("blueprint.schema.json");
    expect([...DEFAULT_NOSTR_RELAYS]).toEqual(schema.properties.hosting.properties.nostrRelays.default);
  });
});

describe("relay pool settled", () => {
  it("is true once every relay has connected or failed, not before; a dead relay counts", async () => {
    const relays = new FakeRelays();
    relays.down.add("wss://c.test");
    const pool = new RelayPool({ urls: ["wss://a.test", "wss://b.test", "wss://c.test"], topic: "tt", connect: relays.connect, clock: systemClock, wall: Date.now, onEvent: () => {} });
    expect(pool.settled).toBe(false);
    pool.start();
    expect(pool.settled).toBe(false); // nothing has answered yet
    await new Promise((r) => setTimeout(r, 50));
    expect(pool.settled).toBe(true);
    expect(pool.connected).toBe(2); // c is dead but known to be
    pool.close();
  });
});

describe("checkNostrRelays", () => {
  it("reports ok for an echoing relay, and the reason for the others", async () => {
    const relays = new FakeRelays();
    relays.down.add("wss://down.test");
    relays.refuse.add("wss://refuses.test");
    const res = await checkNostrRelays(["wss://ok.test", "wss://down.test", "wss://refuses.test"], 3000, { connect: relays.connect });
    expect(res.find((r) => r.url === "wss://ok.test")).toMatchObject({ ok: true });
    expect(res.find((r) => r.url === "wss://down.test")).toMatchObject({ ok: false });
    expect(res.find((r) => r.url === "wss://refuses.test")).toMatchObject({ ok: false, error: expect.stringContaining("refused") });
  });
  it("the default list is wss:// URLs", () => {
    expect(DEFAULT_NOSTR_RELAYS.length).toBeGreaterThanOrEqual(5);
    for (const u of DEFAULT_NOSTR_RELAYS) expect(u).toMatch(/^wss:\/\//);
  });
});
