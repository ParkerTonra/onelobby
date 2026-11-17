import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlayerCodec, defaultPlayerInput, defaultPlayerState, type ActionName, type PlayerInput, type PlayerState, type PlayerWireConfig } from "../src/index.js";
import {
  ACTION_EVENTS, ReplicationError, decodePlayerEvents, encodePlayerEvents, fromHex, positionBits, toHex, type WireEvent,
} from "../src/internals.js";
import { specJson } from "./spec.js";

// spec/vectors/net-player.json is generated from this file: `ONELOBBY_WRITE_VECTORS=1 npx vitest run test/net-player-vectors.test.ts`
// from clients/js/packages/client (spec/net-player.md "Vectors"). Without the variable the file is only read and checked.

const CONFIGS: Record<string, PlayerWireConfig> = {
  default3d: { space: "3d", range: 300, velocityRange: 32, omit: [] },
  default2d: { space: "2d", range: 300, velocityRange: 32, omit: [] },
  wide3d: { space: "3d", range: 1000, velocityRange: 64, omit: [] },
  small2d: { space: "2d", range: 50, velocityRange: 16, omit: [] },
  lean3d: { space: "3d", range: 300, velocityRange: 32, omit: ["velocity", "pitch", "blocking", "aiming", "team", "health", "alive", "emote", "use"] },
  // the same as default3d, written the way a game does: no health or team and no hit events
  noHealth3d: { space: "3d", range: 300, velocityRange: 32, omit: ["health", "alive", "team", "hit", "death"] },
};

const st = (o: Partial<PlayerState>): PlayerState => defaultPlayerState(o);

const STATES: { name: string; config: string; state: PlayerState }[] = [
  { name: "origin_defaults", config: "default3d", state: st({}) },
  { name: "walking", config: "default3d", state: st({ x: 12.34, y: 1.5, z: -56.78, vx: 3.2, vy: 0, vz: -4.1, yaw: 135, pitch: -20, mode: 2, item: 3, health: 87, team: 2 }) },
  { name: "all_flags_and_teleport", config: "default3d", state: st({ x: -300, y: 300, z: 0.01, vx: -32, vy: 32, vz: 0, yaw: 359.9, pitch: 90, onGround: false, mode: 15, item: 15, aiming: true, blocking: true, health: 255, alive: false, team: 15, teleport: 7 }) },
  { name: "clamped_out_of_range", config: "default3d", state: st({ x: 999, y: -999, z: 301, vx: 100, vz: -100, pitch: 200 }) },
  { name: "wide_range_18_bits", config: "wide3d", state: st({ x: 512.25, y: -3, z: -777.77, vx: 40, yaw: 10 }) },
  { name: "two_d", config: "default2d", state: st({ x: -120.5, y: 75.25, vx: -5, vy: 2.5, yaw: 270, mode: 1, health: 100, teleport: 3 }) },
  { name: "two_d_small_range", config: "small2d", state: st({ x: 49.99, y: -49.99, vx: 16, vy: -16, yaw: 1 }) },
  { name: "lean_left_out_fields", config: "lean3d", state: st({ x: 1, y: 2, z: 3, yaw: 90, onGround: false, mode: 4, item: 9, teleport: 1 }) },
  { name: "no_health_team", config: "noHealth3d", state: st({ x: 7.77, y: 0, z: -7.77, vx: 1, vz: 1, yaw: 45, pitch: 10, mode: 3, aiming: true }) },
  { name: "carried_walking", config: "default3d", state: st({ x: 12.34, y: 1.5, z: -56.78, vx: 3.2, vy: 0, vz: -4.1, yaw: 135, pitch: -20, mode: 2, item: 3, health: 87, team: 2, carried: true }) },
  { name: "lean_carried", config: "lean3d", state: st({ x: 1, y: 2, z: 3, yaw: 90, onGround: false, mode: 4, item: 9, teleport: 1, carried: true }) },
];

const INPUTS: { name: string; config: string; input: PlayerInput }[] = [
  { name: "idle", config: "default3d", input: defaultPlayerInput() },
  { name: "forward_right_jump_fire", config: "default3d", input: defaultPlayerInput({ moveX: 0.5, moveY: 1, yaw: 200, pitch: -35, buttons: { jump: true, fire: true } as never }) },
  { name: "every_button", config: "default3d", input: defaultPlayerInput({ moveX: -1, moveY: -1, yaw: 359.9, pitch: 90, buttons: { jump: true, crouch: true, sprint: true, aim: true, block: true, fire: true, use: true, reload: true } as never }) },
  { name: "two_d", config: "default2d", input: defaultPlayerInput({ moveX: -0.25, moveY: 0.75, yaw: 90, buttons: { sprint: true, use: true } as never }) },
];

const ARGS: { name: string; config: string; event: ActionName; args: Record<string, number> }[] = [
  { name: "jump", config: "default3d", event: "jump", args: {} },
  { name: "land", config: "default3d", event: "land", args: { impact: 12.5 } },
  { name: "shoot", config: "default3d", event: "shoot", args: { yaw: 123.4, pitch: -12.5, view: 1234567 } },
  { name: "shoot_2d", config: "default2d", event: "shoot", args: { yaw: 45, view: 99 } },
  { name: "melee", config: "default3d", event: "melee", args: { swing: 200 } },
  { name: "reload", config: "default3d", event: "reload", args: {} },
  { name: "use", config: "default3d", event: "use", args: { target: 4242 } },
  { name: "item_switch", config: "default3d", event: "itemSwitch", args: { slot: 5 } },
  { name: "throw", config: "default3d", event: "throw", args: { yaw: 10, pitch: 30, power: 0.5 } },
  { name: "hit", config: "default3d", event: "hit", args: { by: 3, damage: 25 } },
  { name: "death", config: "default3d", event: "death", args: { by: 2 } },
  { name: "respawn", config: "default3d", event: "respawn", args: {} },
  { name: "emote", config: "default3d", event: "emote", args: { emote: 17 } },
];

const EVENT_MESSAGES: { name: string; events: { player: number; seq: number; id: number; tick: number; argsHex: string }[] }[] = [
  { name: "one_jump", events: [{ player: 2, seq: 1, id: 1, tick: 100, argsHex: "" }] },
  { name: "shoot_with_args", events: [{ player: 3, seq: 17, id: 3, tick: 4000, argsHex: "7a12a08d1500" }] },
  { name: "three_repeated_copies_of_different_players", events: [
    { player: 2, seq: 5, id: 4, tick: 777, argsHex: "03" },
    { player: 3, seq: 9, id: 2, tick: 778, argsHex: "21" },
    { player: 2, seq: 6, id: 1, tick: 780, argsHex: "" },
  ] },
  { name: "large_numbers", events: [{ player: 2147483647, seq: 4294967295, id: 12, tick: 4294967295, argsHex: "3f" }] },
];

const INVALID: { name: string; kind: "state" | "input" | "args" | "events"; config: string; event?: string; hex: string; error: string }[] = [
  { name: "state_one_byte_short", kind: "state", config: "default3d", hex: "00".repeat(15), error: "length" },
  { name: "state_one_byte_long", kind: "state", config: "default3d", hex: "00".repeat(17), error: "length" },
  { name: "state_empty", kind: "state", config: "default2d", hex: "", error: "length" },
  { name: "lean_state_given_the_full_length", kind: "state", config: "lean3d", hex: "00".repeat(16), error: "length" },
  { name: "input_short", kind: "input", config: "default3d", hex: "000000", error: "length" },
  { name: "input_long", kind: "input", config: "default2d", hex: "000000000000", error: "length" },
  { name: "shoot_args_short", kind: "args", config: "default3d", event: "shoot", hex: "0000", error: "length" },
  { name: "jump_args_not_empty", kind: "args", config: "default3d", event: "jump", hex: "00", error: "length" },
  { name: "events_empty_message_body", kind: "events", config: "default3d", hex: "520105", error: "too_short" },
  { name: "events_count_zero", kind: "events", config: "default3d", hex: "52010500", error: "count_0" },
  { name: "events_record_cut_short", kind: "events", config: "default3d", hex: "5201050102010164", error: "too_short" },
  { name: "events_args_cut_short", kind: "events", config: "default3d", hex: "520105010201016401" , error: "too_short" },
  { name: "events_trailing_byte", kind: "events", config: "default3d", hex: "520105010201016400" + "00", error: "trailing" },
  { name: "events_player_zero", kind: "events", config: "default3d", hex: "52010501" + "00" + "01" + "01" + "64" + "00", error: "player_0" },
  { name: "events_seq_zero", kind: "events", config: "default3d", hex: "52010501" + "02" + "00" + "01" + "64" + "00", error: "seq_0" },
  { name: "events_id_zero", kind: "events", config: "default3d", hex: "52010501" + "02" + "01" + "00" + "64" + "00", error: "event_id" },
  { name: "events_tick_over_32_bits", kind: "events", config: "default3d", hex: "52010501" + "02" + "01" + "01" + "ffffffff1f" + "00", error: "range" },
  { name: "events_varint_too_long", kind: "events", config: "default3d", hex: "52010501" + "02" + "01" + "01" + "ffffffffffffffffff7f" + "00", error: "varint" },
];

function build() {
  const codec = (c: string) => new PlayerCodec(CONFIGS[c]);
  const roundtrip = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  return {
    desc:
      "Vectors of spec/net-player.md. configs: the sync.player settings that shape the wire (space, range, velocityRange, omit). states: encode `state` for `config` to `hex` (`bits` is the layout's length; a value out of range is clamped) and decode `hex` to `decoded` (compare floats with a tolerance of 1e-5). " +
      "inputs: the same for the input preset. args: the arguments of one action event. events: kind 5 messages (`argsHex` of each record). invalid: decoding `hex` as `kind` (state, input, args of `event`, or a kind 5 message) must fail with `error` (`length` for a state, input or arguments of the wrong length; the others are the replication error names). Generated from the JS client: see the spec.",
    configs: CONFIGS,
    positionBits: [1, 10, 50, 300, 1000, 10000, 100000, 1e7].map((range) => ({ range, bits: positionBits(range) })),
    states: STATES.map((v) => {
      const c = codec(v.config);
      const bytes = c.encodeState(v.state);
      return { name: v.name, config: v.config, state: roundtrip(v.state), hex: toHex(bytes), bits: c.stateBits, decoded: roundtrip(c.decodeState(bytes)) };
    }),
    inputs: INPUTS.map((v) => {
      const c = codec(v.config);
      const bytes = c.encodeInput(v.input);
      return { name: v.name, config: v.config, input: roundtrip(v.input), hex: toHex(bytes), decoded: roundtrip(c.decodeInput(bytes)) };
    }),
    args: ARGS.map((v) => {
      const c = codec(v.config);
      const bytes = c.encodeArgs(v.event, v.args);
      return { name: v.name, config: v.config, event: v.event, id: ACTION_EVENTS.find((e) => e.name === v.event)!.id, args: v.args, hex: toHex(bytes), decoded: roundtrip(c.decodeArgs(v.event, bytes)) };
    }),
    events: EVENT_MESSAGES.map((v) => {
      const evs: WireEvent[] = v.events.map((e) => ({ player: e.player, seq: e.seq, id: e.id, tick: e.tick, args: fromHex(e.argsHex) }));
      return { name: v.name, events: v.events, hex: toHex(encodePlayerEvents(evs)) };
    }),
    invalid: INVALID,
  };
}

if (process.env.ONELOBBY_WRITE_VECTORS) {
  const file = join(dirname(fileURLToPath(import.meta.url)), "../../../../../spec/vectors/net-player.json");
  const v = build() as Record<string, unknown>;
  const nl = String.fromCharCode(10);
  const rows = (val: unknown[]) => val.map((x) => "    " + JSON.stringify(x)).join("," + nl);
  const lines = Object.entries(v).map(([k, val]) => (Array.isArray(val) ? `  "${k}": [${nl}${rows(val)}${nl}  ]` : `  "${k}": ${JSON.stringify(val)}`));
  writeFileSync(file, "{" + nl + lines.join("," + nl) + nl + "}" + nl, "utf8");
}

const V = specJson("vectors/net-player.json");
const close = (a: unknown, b: unknown, path = ""): void => {
  if (typeof a === "number" && typeof b === "number") expect(a, path).toBeCloseTo(b, 4);
  else if (a && typeof a === "object" && b && typeof b === "object") {
    expect(Object.keys(a as object).sort(), path).toEqual(Object.keys(b as object).sort());
    for (const k of Object.keys(a as object)) close((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
  } else expect(a, path).toBe(b);
};

describe("net-player vectors", () => {
  it("the position bits for a range", () => {
    for (const p of V.positionBits) expect(positionBits(p.range), `range ${p.range}`).toBe(p.bits);
  });
  for (const v of V.states) {
    it(`state ${v.name}`, () => {
      const c = new PlayerCodec(V.configs[v.config]);
      expect(toHex(c.encodeState(v.state))).toBe(v.hex);
      expect(c.stateBits).toBe(v.bits);
      close(c.decodeState(fromHex(v.hex)), v.decoded);
    });
  }
  for (const v of V.inputs) {
    it(`input ${v.name}`, () => {
      const c = new PlayerCodec(V.configs[v.config]);
      expect(toHex(c.encodeInput(v.input))).toBe(v.hex);
      close(c.decodeInput(fromHex(v.hex)), v.decoded);
    });
  }
  for (const v of V.args) {
    it(`args ${v.name}`, () => {
      const c = new PlayerCodec(V.configs[v.config]);
      expect(toHex(c.encodeArgs(v.event, v.args))).toBe(v.hex);
      close(c.decodeArgs(v.event, fromHex(v.hex)), v.decoded);
      expect(ACTION_EVENTS.find((e) => e.name === v.event)!.id).toBe(v.id);
    });
  }
  for (const v of V.events) {
    it(`events ${v.name}`, () => {
      const evs: WireEvent[] = v.events.map((e: { player: number; seq: number; id: number; tick: number; argsHex: string }) => ({ ...e, args: fromHex(e.argsHex) }));
      expect(toHex(encodePlayerEvents(evs))).toBe(v.hex);
      const back = decodePlayerEvents(fromHex(v.hex));
      expect(back.map((e) => ({ player: e.player, seq: e.seq, id: e.id, tick: e.tick, argsHex: toHex(e.args) }))).toEqual(v.events);
    });
  }
  for (const v of V.invalid) {
    it(`rejects ${v.name}`, () => {
      const c = new PlayerCodec(V.configs[v.config]);
      const bytes = fromHex(v.hex);
      if (v.kind === "state") expect(c.decodeState(bytes)).toBeNull();
      else if (v.kind === "input") expect(c.decodeInput(bytes)).toBeNull();
      else if (v.kind === "args") expect(c.decodeArgs(v.event, bytes)).toBeNull();
      else {
        let code = "";
        try {
          decodePlayerEvents(bytes);
        } catch (e) {
          code = e instanceof ReplicationError ? e.code : "other";
        }
        expect(code).toBe(v.error);
      }
    });
  }
  it("every replication error a kind 5 message can raise is covered", () => {
    const covered = new Set(V.invalid.filter((i: { kind: string }) => i.kind === "events").map((i: { error: string }) => i.error));
    for (const e of ["too_short", "trailing", "varint", "range", "count_0", "player_0", "seq_0", "event_id"]) expect(covered.has(e), e).toBe(true);
  });
});
