import { memoryStore, type Lobby, type RoomOptions } from "../src/internals.js";
import { settle } from "../src/testing.js";
import { rig, type Rig } from "./helpers.js";

export const flush = () => settle();
/** Run simulated time (100 ms slices, letting promises settle in between). */
export const wait = (r: Rig, ms: number) => r.clock.run(ms, 100);

/** A rig whose hub has the room feature (passwords, spectator slots, id bans, kick codes), or an older one without. */
export function newRig(room = true): Rig {
  const r = rig();
  if (room) r.server.features = ["set_name", "room"];
  return r;
}

/** A kit with its own (memory) stores, so players have their own ids and ban lists. */
export function kit(r: Rig, name: string, extra: Record<string, unknown> = {}) {
  const idStore = memoryStore();
  const banStore = memoryStore();
  const k = r.make(name, {
    mode: "raw",
    extra: {
      advanced: {
        playerIdStore: idStore, banStore, socketFactory: r.server.socketFactory, linkFactory: r.net.factoryFor(name), clock: r.clock,
        wallClock: () => 1_700_000_000_000 + r.clock.now(), voiceCodec: null, createMic: null, createSink: null, storage: null,
      },
      ...extra,
    } as never,
  });
  return Object.assign(k, { pidStore: idStore, banKv: banStore });
}

export async function hostWith(r: Rig, room: RoomOptions = {}, o: { max?: number; password?: string; name?: string } = {}) {
  const k = kit(r, o.name ?? "Host");
  const lobby = await k.host({ name: "t", maxPlayers: o.max ?? 4, room, ...(o.password ? { password: o.password } : {}) });
  return { k, lobby };
}

export async function joiner(r: Rig, host: Lobby, name: string, join: { role?: "player" | "spectator"; data?: Record<string, string>; password?: string } = {}, extra: Record<string, unknown> = {}) {
  const k = kit(r, name, extra);
  const lobby = await k.join(host.code, join);
  await flush();
  return { k, lobby };
}

export const names = (l: Lobby) => l.room.players.map((p) => p.name);
