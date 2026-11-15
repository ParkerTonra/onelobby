/** Room frames (spec/room.md 2-3): type 0x80, route 0, then one UTF-8 JSON object. */
import { decodeMessage, encodeMessage, type Message } from "./codec.js";
import type { RoomErrorCode, RoomRole, RoomState, RoomStatus, DataSpec, LateJoinPolicy, AutoStartMode, SeatDroppedPolicy } from "./room-rules.js";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

/** One roster row as replicated (spec/room.md 1). */
export interface RoomEntry {
  id: number;
  name: string;
  role: RoomRole;
  /** 0..maxPlayers-1 for a player, -1 for a spectator. */
  seat: number;
  ready: boolean;
  status: RoomStatus;
  data: Record<string, string>;
  /** The peer does not speak the room layer (spec/room.md 8). */
  legacy?: boolean;
}

export interface RoomSettings {
  maxPlayers: number;
  spectators: number;
  minPlayers: number;
  autoStart: AutoStartMode;
  autoStartPlayers: number;
  countdownMs: number;
  lateJoin: LateJoinPolicy;
  seatDropped: SeatDroppedPolicy;
  rejoinWindowMs: number;
  maxNameLength: number;
  /** The merged data declarations (built-ins plus the game's). */
  data: DataSpec;
}

export interface CountdownInfo {
  seq: number;
  total: number;
  left: number;
}

export type GoneWhy = "left" | "kicked" | "disconnected" | "timeout";

/** Every message of the room layer, both directions (the `t` field names it). */
export type RoomMsg =
  | { t: "join"; v: number; pid?: string; role?: RoomRole; password?: string; data?: Record<string, string> }
  | { t: "set"; data: Record<string, string> }
  | { t: "ready"; ready: boolean }
  | { t: "role"; role: RoomRole }
  | { t: "req"; what: "start" | "lobby" | "rematch" }
  | { t: "resync" }
  | { t: "snap"; v: number; rev: number; state: RoomState; countdown: CountdownInfo | null; settings: RoomSettings; players: RoomEntry[] }
  | { t: "upd"; rev: number; players?: RoomEntry[]; gone?: { id: number; why: GoneWhy }[]; state?: RoomState; countdown?: CountdownInfo | null; settings?: RoomSettings; cancel?: string }
  | { t: "cd"; seq: number; left: number }
  | { t: "deny"; code: RoomErrorCode | string; reason: string }
  | { t: "nack"; re: "set" | "ready" | "role" | "req" | "join"; code: RoomErrorCode | string; key?: string };

/** The `room` data-channel frame for one message. */
export function roomMessage(m: RoomMsg): Message {
  return { type: "room", body: enc.encode(JSON.stringify(m)) };
}

/** Bytes of one room frame (route 0). */
export function encodeRoomFrame(m: RoomMsg, allowOversize = false): Uint8Array {
  return encodeMessage(roomMessage(m), 0, allowOversize);
}

/** The JSON object of a room `body`, or null when it is not UTF-8, not an object, or has no string `t`. */
export function parseRoomBody(body: Uint8Array): RoomMsg | null {
  try {
    const v: unknown = JSON.parse(dec.decode(body));
    if (typeof v !== "object" || v === null || Array.isArray(v) || typeof (v as { t?: unknown }).t !== "string") return null;
    return v as RoomMsg;
  } catch {
    return null;
  }
}

/** Decode a whole frame (header included) to its room message; null for anything else or a bad body. */
export function decodeRoomFrame(frame: Uint8Array): RoomMsg | null {
  try {
    const d = decodeMessage(frame);
    return d && d.msg.type === "room" ? parseRoomBody(d.msg.body) : null;
  } catch {
    return null;
  }
}
