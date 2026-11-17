/**
 * The player preset as bytes (spec/net-player.md): the state of one networked player, the input preset of host-decides
 * mode, the action events and the kind 5 message that carries them. Pure functions and one codec class per configuration;
 * no lobby, no session.
 */
import { NetMath, NetReader, NetWriter, Quantize } from "./bits.js";
import { ByteWriter, MAGIC, ReplicationError, VERSION, fromHex, toHex } from "./protocol.js";

/** The reserved entity type id of a networked player (spec/net-player.md "Type id"). */
export const PLAYER_TYPE_ID = 65535;
/** Message kind of the action events (additive to replication version 1). */
export const KIND_PLAYER_EVENTS = 5;
/** The teleport counter wraps at this value (3 bits). */
export const TELEPORT_MODULO = 8;

export type PlayerSpace = "2d" | "3d";

/** What configures the preset on the wire. Everything else about the layer is local behaviour. */
export interface PlayerWireConfig {
  space: PlayerSpace;
  /** Positions are quantised to [-range, range] on every axis. */
  range: number;
  /** Velocities are quantised to [-velocityRange, velocityRange] per axis. */
  velocityRange: number;
  /** Preset fields and events left out (see {@link OMITTABLE}). */
  omit: readonly string[];
}

export const DEFAULT_PLAYER_WIRE: Readonly<PlayerWireConfig> = { space: "3d", range: 300, velocityRange: 32, omit: [] };

/** Movement modes of the preset; 9 to 15 are the game's own. */
export const MOVEMENT_MODES = ["idle", "walk", "run", "crouch", "jump", "fall", "swim", "climb", "fly"] as const;

/** One player's state. 2D uses x, y and vx, vy (z, vz and pitch stay 0); a field that is left out holds its default. */
export interface PlayerState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Facing in degrees [0, 360). */
  yaw: number;
  /** Aim in degrees [-90, 90] (3D). */
  pitch: number;
  onGround: boolean;
  /** 0..15: see {@link MOVEMENT_MODES}. */
  mode: number;
  /** Held item or slot, 0..15. */
  item: number;
  aiming: boolean;
  blocking: boolean;
  /** 0..255. */
  health: number;
  alive: boolean;
  /** Team or colour, 0..15. */
  team: number;
  /** 0..7, wraps. A difference between two samples means "snap, do not slide". */
  teleport: number;
  /**
   * Set by the host when it carried this state on by velocity on a tick with no input from the owner (host authority; owner mode
   * too, where the host carries a stalled player on). The owner does not replay from it. The host's bit: an owner's own is ignored.
   */
  carried: boolean;
}

export function defaultPlayerState(over: Partial<PlayerState> = {}): PlayerState {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, onGround: true, mode: 0, item: 0, aiming: false, blocking: false,
    health: 100, alive: true, team: 0, teleport: 0, carried: false, ...over,
  };
}

/** The buttons of the input preset, in wire order. */
export const BUTTONS = ["jump", "crouch", "sprint", "aim", "block", "fire", "use", "reload"] as const;
export type ButtonName = (typeof BUTTONS)[number];

/** One input of host-decides mode (the input preset). `moveX` is strafe right, `moveY` is forward (2D: down is +1). */
export interface PlayerInput {
  moveX: number;
  moveY: number;
  yaw: number;
  pitch: number;
  buttons: Record<ButtonName, boolean>;
}

export function defaultPlayerInput(over: Partial<PlayerInput> = {}): PlayerInput {
  const buttons = {} as Record<ButtonName, boolean>;
  for (const b of BUTTONS) buttons[b] = false;
  return { moveX: 0, moveY: 0, yaw: 0, pitch: 0, ...over, buttons: { ...buttons, ...(over.buttons ?? {}) } };
}

/** Names that may go into `omit`: state fields and events. Position and teleport can never be left out. */
export const OMITTABLE_FIELDS = ["velocity", "yaw", "pitch", "onGround", "mode", "item", "aiming", "blocking", "health", "alive", "team"] as const;

export interface ActionEventDef {
  id: number;
  name: string;
  /** Which sides may start it: `owner` (the player's own peer, or the host for any player) or `host` only. */
  origin: "owner" | "host";
}

/** The action events, in id order. */
export const ACTION_EVENTS: readonly ActionEventDef[] = [
  { id: 1, name: "jump", origin: "owner" },
  { id: 2, name: "land", origin: "owner" },
  { id: 3, name: "shoot", origin: "owner" },
  { id: 4, name: "melee", origin: "owner" },
  { id: 5, name: "reload", origin: "owner" },
  { id: 6, name: "use", origin: "owner" },
  { id: 7, name: "itemSwitch", origin: "owner" },
  { id: 8, name: "throw", origin: "owner" },
  { id: 9, name: "hit", origin: "host" },
  { id: 10, name: "death", origin: "host" },
  { id: 11, name: "respawn", origin: "owner" },
  { id: 12, name: "emote", origin: "owner" },
];
export const OMITTABLE: readonly string[] = [...OMITTABLE_FIELDS, ...ACTION_EVENTS.map((e) => e.name)];
export type ActionName = "jump" | "land" | "shoot" | "melee" | "reload" | "use" | "itemSwitch" | "throw" | "hit" | "death" | "respawn" | "emote";

/** Arguments of each action event (names are the wire names of spec/net-player.md). */
export interface ActionArgs {
  jump: Record<string, never>;
  land: { impact: number };
  shoot: { yaw: number; pitch: number; view: number };
  melee: { swing: number };
  reload: Record<string, never>;
  use: { target: number };
  itemSwitch: { slot: number };
  throw: { yaw: number; pitch: number; power: number };
  hit: { by: number; damage: number };
  death: { by: number };
  respawn: Record<string, never>;
  emote: { emote: number };
}

export function actionByName(name: string): ActionEventDef | undefined {
  return ACTION_EVENTS.find((e) => e.name === name);
}
export function actionById(id: number): ActionEventDef | undefined {
  return ACTION_EVENTS.find((e) => e.id === id);
}

/** Bits of a position axis: the smallest b in 8..24 with 2^b - 1 >= ceil(2 x range / 0.01) (about 1 cm a step). */
export function positionBits(range: number): number {
  const steps = Math.ceil((2 * range) / 0.01);
  let b = 8;
  while (b < 24 && 2 ** b - 1 < steps) b++;
  return b;
}

const VEL_BITS = 10;
const YAW_BITS = 12;
const PITCH_BITS = 10;
const MOVE_BITS = 7;

/** Encodes and decodes the preset for one configuration. */
export class PlayerCodec {
  readonly config: Readonly<PlayerWireConfig>;
  readonly posBits: number;
  private readonly omitted: ReadonlySet<string>;
  private readonly w = new NetWriter();
  private readonly r = new NetReader();

  constructor(config: Partial<PlayerWireConfig> = {}) {
    this.config = { ...DEFAULT_PLAYER_WIRE, ...config };
    if (!(this.config.range > 0)) throw new RangeError("range must be positive");
    if (!(this.config.velocityRange > 0)) throw new RangeError("velocityRange must be positive");
    for (const n of this.config.omit) if (!OMITTABLE.includes(n)) throw new RangeError(`cannot leave out "${n}"`);
    this.omitted = new Set(this.config.omit);
    this.posBits = positionBits(this.config.range);
  }

  get is3d(): boolean {
    return this.config.space === "3d";
  }
  has(name: string): boolean {
    return !this.omitted.has(name);
  }

  /** Bits of one state. */
  get stateBits(): number {
    return this.stateBitsOf();
  }
  get stateBytes(): number {
    return (this.stateBits + 7) >> 3;
  }
  private stateBitsOf(): number {
    this.w.reset();
    this.writeState(this.w, defaultPlayerState());
    return this.w.bitCount;
  }

  writeState(w: NetWriter, s: PlayerState): void {
    const { range: R, velocityRange: V } = this.config;
    const pb = this.posBits;
    w.writeQuantized(s.x, -R, R, pb);
    w.writeQuantized(s.y, -R, R, pb);
    if (this.is3d) w.writeQuantized(s.z, -R, R, pb);
    if (this.has("velocity")) {
      w.writeQuantized(s.vx, -V, V, VEL_BITS);
      w.writeQuantized(s.vy, -V, V, VEL_BITS);
      if (this.is3d) w.writeQuantized(s.vz, -V, V, VEL_BITS);
    }
    if (this.has("yaw")) w.writeAngle(s.yaw, YAW_BITS);
    if (this.is3d && this.has("pitch")) w.writeQuantized(s.pitch, -90, 90, PITCH_BITS);
    if (this.has("onGround")) w.writeBool(s.onGround);
    if (this.has("mode")) w.writeBits(s.mode, 4);
    if (this.has("item")) w.writeBits(s.item, 4);
    if (this.has("aiming")) w.writeBool(s.aiming);
    if (this.has("blocking")) w.writeBool(s.blocking);
    if (this.has("health")) w.writeBits(s.health, 8);
    if (this.has("alive")) w.writeBool(s.alive);
    if (this.has("team")) w.writeBits(s.team, 4);
    w.writeBits(s.teleport, 3);
    w.writeBool(s.carried);
  }

  readState(r: NetReader): PlayerState {
    const { range: R, velocityRange: V } = this.config;
    const pb = this.posBits;
    const s = defaultPlayerState();
    s.x = r.readQuantized(-R, R, pb);
    s.y = r.readQuantized(-R, R, pb);
    if (this.is3d) s.z = r.readQuantized(-R, R, pb);
    if (this.has("velocity")) {
      s.vx = r.readQuantized(-V, V, VEL_BITS);
      s.vy = r.readQuantized(-V, V, VEL_BITS);
      if (this.is3d) s.vz = r.readQuantized(-V, V, VEL_BITS);
    }
    if (this.has("yaw")) s.yaw = r.readAngle(YAW_BITS);
    if (this.is3d && this.has("pitch")) s.pitch = r.readQuantized(-90, 90, PITCH_BITS);
    if (this.has("onGround")) s.onGround = r.readBool();
    if (this.has("mode")) s.mode = r.readBits(4);
    if (this.has("item")) s.item = r.readBits(4);
    if (this.has("aiming")) s.aiming = r.readBool();
    if (this.has("blocking")) s.blocking = r.readBool();
    if (this.has("health")) s.health = r.readBits(8);
    if (this.has("alive")) s.alive = r.readBool();
    if (this.has("team")) s.team = r.readBits(4);
    s.teleport = r.readBits(3);
    s.carried = r.readBool();
    return s;
  }

  /** The state as bytes (what goes into an entity's state, or into an input in owner mode). */
  encodeState(s: PlayerState): Uint8Array {
    this.w.reset();
    this.writeState(this.w, s);
    return this.w.toBytes();
  }

  /** The state from bytes; null when the length is not exactly the layout's (a malformed state). */
  decodeState(b: Uint8Array): PlayerState | null {
    if (b.length !== this.stateBytes) return null;
    this.r.reset(b);
    return this.readState(this.r);
  }

  /** What `s` becomes after one trip over the wire (quantised, omitted fields at their defaults). */
  quantize(s: PlayerState): PlayerState {
    return this.decodeState(this.encodeState(s))!;
  }

  /** Blend two states for rendering: numbers by `t`, yaw on the shortest arc, everything else from `a`; a teleport snaps. */
  lerp(a: PlayerState, b: PlayerState, t: number): PlayerState {
    if (a.teleport !== b.teleport) return a; // the snap happens when render time reaches b's tick
    return {
      ...a,
      x: NetMath.lerp(a.x, b.x, t), y: NetMath.lerp(a.y, b.y, t), z: NetMath.lerp(a.z, b.z, t),
      vx: NetMath.lerp(a.vx, b.vx, t), vy: NetMath.lerp(a.vy, b.vy, t), vz: NetMath.lerp(a.vz, b.vz, t),
      yaw: NetMath.lerpAngle(a.yaw, b.yaw, t), pitch: NetMath.lerp(a.pitch, b.pitch, t),
    };
  }

  // ---- input preset (host-decides mode) -------------------------------------------------------------------------

  writeInput(w: NetWriter, i: PlayerInput): void {
    w.writeQuantized(i.moveX, -1, 1, MOVE_BITS);
    w.writeQuantized(i.moveY, -1, 1, MOVE_BITS);
    w.writeAngle(i.yaw, YAW_BITS);
    if (this.is3d) w.writeQuantized(i.pitch, -90, 90, PITCH_BITS);
    for (const b of BUTTONS) w.writeBool(i.buttons[b]);
  }

  readInput(r: NetReader): PlayerInput {
    const i = defaultPlayerInput();
    i.moveX = r.readQuantized(-1, 1, MOVE_BITS);
    i.moveY = r.readQuantized(-1, 1, MOVE_BITS);
    i.yaw = r.readAngle(YAW_BITS);
    if (this.is3d) i.pitch = r.readQuantized(-90, 90, PITCH_BITS);
    for (const b of BUTTONS) i.buttons[b] = r.readBool();
    return i;
  }

  get inputBytes(): number {
    this.w.reset();
    this.writeInput(this.w, defaultPlayerInput());
    return this.w.byteCount;
  }

  encodeInput(i: PlayerInput): Uint8Array {
    this.w.reset();
    this.writeInput(this.w, i);
    return this.w.toBytes();
  }

  decodeInput(b: Uint8Array): PlayerInput | null {
    if (b.length !== this.inputBytes) return null;
    this.r.reset(b);
    return this.readInput(this.r);
  }

  /** What an input becomes after one trip over the wire. */
  quantizeInput(i: PlayerInput): PlayerInput {
    return this.decodeInput(this.encodeInput(i))!;
  }

  // ---- action events ---------------------------------------------------------------------------------------------

  /** Whether the game uses this event (not left out; and for an event with no arguments, always true unless omitted). */
  hasEvent(name: string): boolean {
    return this.has(name);
  }

  writeArgs(w: NetWriter, name: ActionName, a: Record<string, number>): void {
    switch (name) {
      case "land": w.writeQuantized(a.impact ?? 0, 0, 64, 6); break;
      case "shoot":
        w.writeAngle(a.yaw ?? 0, YAW_BITS);
        if (this.is3d) w.writeQuantized(a.pitch ?? 0, -90, 90, PITCH_BITS);
        w.writeUInt32(a.view ?? 0);
        break;
      case "melee": w.writeBits(a.swing ?? 0, 8); break;
      case "use": w.writeBits(a.target ?? 0, 16); break;
      case "itemSwitch": w.writeBits(a.slot ?? 0, 4); break;
      case "throw":
        w.writeAngle(a.yaw ?? 0, YAW_BITS);
        if (this.is3d) w.writeQuantized(a.pitch ?? 0, -90, 90, PITCH_BITS);
        w.writeQuantized(a.power ?? 0, 0, 1, 6);
        break;
      case "hit": w.writeBits(a.by ?? 0, 16); w.writeBits(a.damage ?? 0, 8); break;
      case "death": w.writeBits(a.by ?? 0, 16); break;
      case "emote": w.writeBits(a.emote ?? 0, 6); break;
      default: break; // jump, reload, respawn: no arguments
    }
  }

  readArgs(r: NetReader, name: ActionName): Record<string, number> {
    switch (name) {
      case "land": return { impact: r.readQuantized(0, 64, 6) };
      case "shoot": {
        const yaw = r.readAngle(YAW_BITS);
        const pitch = this.is3d ? r.readQuantized(-90, 90, PITCH_BITS) : 0;
        return { yaw, pitch, view: r.readUInt32() };
      }
      case "melee": return { swing: r.readBits(8) };
      case "use": return { target: r.readBits(16) };
      case "itemSwitch": return { slot: r.readBits(4) };
      case "throw": {
        const yaw = r.readAngle(YAW_BITS);
        const pitch = this.is3d ? r.readQuantized(-90, 90, PITCH_BITS) : 0;
        return { yaw, pitch, power: r.readQuantized(0, 1, 6) };
      }
      case "hit": return { by: r.readBits(16), damage: r.readBits(8) };
      case "death": return { by: r.readBits(16) };
      case "emote": return { emote: r.readBits(6) };
      default: return {};
    }
  }

  encodeArgs(name: ActionName, a: Record<string, number> = {}): Uint8Array {
    this.w.reset();
    this.writeArgs(this.w, name, a);
    return this.w.bitCount === 0 ? new Uint8Array(0) : this.w.toBytes();
  }

  /** Bytes of this event's arguments. */
  argsBytes(name: ActionName): number {
    return this.encodeArgs(name).length;
  }

  /** Decode arguments; null when the length is not exactly the layout's. */
  decodeArgs(name: ActionName, b: Uint8Array): Record<string, number> | null {
    if (b.length !== this.argsBytes(name)) return null;
    this.r.reset(b);
    return this.readArgs(this.r, name);
  }
}

// ---- kind 5: player events ---------------------------------------------------------------------------------------

/** One action event as it travels. */
export interface WireEvent {
  /** Peer id of the player it belongs to. */
  player: number;
  /** 1, 2, 3 ... per player. */
  seq: number;
  /** Event id (1..12 today). */
  id: number;
  /** Host tick it happened (a client's claim to the host; the host's own stamp when relayed). */
  tick: number;
  args: Uint8Array;
}

/** Records one message may carry (a u8 count) and the size past which older copies are left out. */
export const MAX_EVENTS_PER_MESSAGE = 255;
export const MAX_EVENT_MESSAGE_BYTES = 1000;

export function encodePlayerEvents(events: readonly WireEvent[], w = new ByteWriter()): Uint8Array {
  if (events.length === 0 || events.length > MAX_EVENTS_PER_MESSAGE) throw new RangeError("1..255 events per message");
  w.clear();
  w.u8(MAGIC);
  w.u8(VERSION);
  w.u8(KIND_PLAYER_EVENTS);
  w.u8(events.length);
  for (const e of events) {
    if (e.args.length > 255) throw new RangeError("event arguments over 255 bytes");
    w.varuint(e.player);
    w.varuint(e.seq);
    w.u8(e.id);
    w.varuint(e.tick);
    w.u8(e.args.length);
    w.bytes(e.args);
  }
  return w.toBytes();
}

/** Decode a kind 5 message. Throws {@link ReplicationError} with `too_short`, `trailing`, `varint`, `range`, `count_0`, `player_0`, `seq_0` or `event_id`. */
export function decodePlayerEvents(p: Uint8Array): WireEvent[] {
  let pos = 3;
  const u8 = (): number => {
    if (pos >= p.length) throw new ReplicationError("too_short");
    return p[pos++];
  };
  const var32 = (): number => {
    let v = 0;
    let scale = 1;
    for (let shift = 0; shift < 70; shift += 7) {
      const b = u8();
      if (shift === 63 && b > 1) throw new ReplicationError("varint");
      v += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) {
        if (v > 0xffffffff) throw new ReplicationError("range");
        return v;
      }
      scale *= 128;
    }
    throw new ReplicationError("varint");
  };
  if (p.length < 4) throw new ReplicationError("too_short");
  const count = u8();
  if (count === 0) throw new ReplicationError("count_0");
  const out: WireEvent[] = [];
  for (let i = 0; i < count; i++) {
    const player = var32();
    const seq = var32();
    const id = u8();
    const tick = var32();
    const len = u8();
    if (pos + len > p.length) throw new ReplicationError("too_short");
    if (player === 0) throw new ReplicationError("player_0");
    if (seq === 0) throw new ReplicationError("seq_0");
    if (id === 0) throw new ReplicationError("event_id");
    out.push({ player, seq, id, tick, args: p.slice(pos, pos + len) });
    pos += len;
  }
  if (pos !== p.length) throw new ReplicationError("trailing");
  return out;
}

export { toHex, fromHex, Quantize };
