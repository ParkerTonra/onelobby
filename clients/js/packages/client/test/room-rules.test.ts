import { describe, expect, it } from "vitest";
import {
  admit, applyData, autoStartHolds, banMatches, chooseSeat, countdownRemaining, dataDefaults, effectiveName, isPlayerId, mergeDataSpec,
  newPlayerId, removalReason, DEFAULT_REASONS, type StartPlayer, type TextFilter,
} from "../src/room-rules.js";
import { encodeRoomFrame, decodeRoomFrame } from "../src/room-wire.js";
import { hex, specJson } from "./spec.js";

const V = specJson("vectors/room.json");

describe("room vectors: names", () => {
  const filters: Record<string, TextFilter | null> = {};
  for (const [k, f] of Object.entries<any>(V.names.filters)) filters[k] = f ? (t) => t.split(f.replace[0]).join(f.replace[1]) : null;
  for (const c of V.names.cases)
    it(c.name, () => expect(effectiveName(c.input, c.peerId, c.others, c.max, filters[c.filter ?? "none"])).toBe(c.expect));
});

describe("room vectors: data", () => {
  const spec = mergeDataSpec(V.data.spec);
  for (const c of V.data.cases)
    it(c.name, () => {
      const r = applyData(spec, c.before, c.set, c.byHost);
      expect(r).toEqual(c.expect);
    });
  for (const c of V.data.defaultsAtAdmission) it(c.name, () => expect(dataDefaults(spec, c.data)).toEqual(c.expect));
});

describe("room vectors: seats", () => {
  for (const c of V.seats)
    it(c.name, () => {
      const memory = new Map<string, number>();
      const held = new Map<string, number>(); // pid -> seat of entries now in the room (players)
      const got: (number | null)[] = [];
      const seatOf = (pid: string, role: string) => {
        if (role === "spectator") return -1;
        const r = chooseSeat(c.maxPlayers, new Set(held.values()), memory, pid);
        if (r.takeOver) memory.delete(r.takeOver);
        if (r.seat >= 0) {
          held.set(pid, r.seat);
          if (pid) memory.set(pid, r.seat);
        }
        return r.seat;
      };
      for (const [op, pid, role] of c.ops as [string, string, string][]) {
        if (op === "join") got.push(seatOf(pid, role));
        else if (op === "drop") {
          held.delete(pid);
          got.push(null);
        } else {
          held.delete(pid); // role change: the entry keeps the memory
          got.push(seatOf(pid, role));
        }
      }
      expect(got).toEqual(c.expect);
    });
});

describe("room vectors: bans, auto start, countdown, admission, reasons, ids", () => {
  for (const c of V.bans.cases) it(`ban ${c.name}`, () => expect(banMatches({ ...c.entry, at: 0 }, c.candidate)).toBe(c.expect));

  const tok = (t: string): StartPlayer => ({ role: t[0] === "s" ? "spectator" : "player", status: t[1] === "x" ? "reconnecting" : "connected", ready: t[1] === "r", legacy: t[1] === "l" });
  for (const c of V.autoStart.cases) it(`autostart ${c.name}`, () => expect(autoStartHolds(c.rule, c.players.map(tok))).toBe(c.expect));

  for (const c of V.countdown.cases) it(`countdown ${c.name}`, () => expect(countdownRemaining(c.left, c.rtt)).toBe(c.expect));

  for (const c of V.admission.cases) it(`admission ${c.name}`, () => expect(admit({ ...V.admission.base, ...c.with })).toEqual(c.expect));

  it("default reasons", () => {
    for (const [code, text] of Object.entries<string>(V.defaultReasons)) expect(removalReason(code, "")).toBe(text);
    expect(DEFAULT_REASONS.banned).toBe(V.defaultReasons.banned);
  });
  for (const [i, c] of V.reasonRules.cases.entries()) it(`reason rule ${i}`, () => expect(removalReason(c.code, c.text)).toBe(c.expect));

  it("player ids", () => {
    for (const s of V.playerId.valid) expect(isPlayerId(s)).toBe(true);
    for (const s of V.playerId.invalid) expect(isPlayerId(s)).toBe(false);
    const a = newPlayerId();
    expect(isPlayerId(a)).toBe(true);
    expect(newPlayerId()).not.toBe(a);
  });
});

describe("room vectors: frames", () => {
  for (const f of V.frames)
    it(`frame ${f.name}`, () => {
      expect(hex(encodeRoomFrame(f.json))).toBe(f.hex);
      expect(decodeRoomFrame(Uint8Array.from(Buffer.from(f.hex, "hex")))).toEqual(f.json);
    });
  it("bad bodies decode to null", () => {
    expect(decodeRoomFrame(Uint8Array.from([0x80, 0, 0, 0xff, 0xfe]))).toBeNull(); // not UTF-8
    expect(decodeRoomFrame(Uint8Array.from([0x80, 0, 0, ...Buffer.from("[1]")]))).toBeNull(); // not an object
    expect(decodeRoomFrame(Uint8Array.from([0x80, 0, 0, ...Buffer.from('{"x":1}')]))).toBeNull(); // no t
    expect(decodeRoomFrame(Uint8Array.from([0x80, 0, 0, ...Buffer.from("{")]))).toBeNull();
  });
});
