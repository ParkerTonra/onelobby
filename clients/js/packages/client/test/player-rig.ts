import { NetPlayers, type NetPlayersOptions, type PlayerState } from "../src/index.js";
import type { ReplicationConfig } from "../src/internals.js";
import { settle } from "../src/testing.js";
import { RepPlayer, RepRig } from "./replication-rig.js";

export interface PlayerRigOptions {
  latencyMs?: number;
  jitterMs?: number;
  lossRate?: number;
  /** Seed of the loss and jitter draws (default 1234). */
  seed?: number;
  /** Options of the layer (one set for every peer, `step` included), or per peer name. */
  layer?: NetPlayersOptions | ((name: string) => NetPlayersOptions);
  session?: Partial<ReplicationConfig>;
  /** Give the hub the room feature so a joiner can be a spectator. */
  room?: boolean;
}

/** The replication rig with a player layer on every peer; one `step` is one 16 ms frame of everyone's `pump()`. */
export class PlayerRig extends RepRig {
  readonly layers = new Map<string, NetPlayers>();
  /** Peers whose frames are skipped (a host that stopped sending, a client that went away). */
  readonly frozen = new Set<string>();
  private readonly layerOpts: PlayerRigOptions["layer"];
  private readonly withRoom: boolean;
  private readonly sessionConfig: Partial<ReplicationConfig>;

  constructor(opts: PlayerRigOptions = {}) {
    super({ adaptiveDelay: true, ...(opts.session ?? {}) }, { latencyMs: opts.latencyMs ?? 100, lossRate: opts.lossRate ?? 0.03, jitterMs: opts.jitterMs ?? 20, seed: opts.seed });
    this.layerOpts = opts.layer;
    this.withRoom = !!opts.room;
    this.sessionConfig = { adaptiveDelay: true, ...(opts.session ?? {}) };
    if (opts.room) this.base.server.features = ["set_name", "room"];
  }

  private optsFor(name: string): NetPlayersOptions {
    return typeof this.layerOpts === "function" ? this.layerOpts(name) : (this.layerOpts ?? {});
  }

  layer(p: RepPlayer | string): NetPlayers {
    return this.layers.get(typeof p === "string" ? p : p.name)!;
  }

  override async startHost(): Promise<RepPlayer> {
    if (!this.withRoom) return super.startHost();
    const lobby = await this.base.make("host", { mode: "raw" }).host({ name: "room", maxPlayers: 8, room: { spectators: 2 } });
    const p = new (RepPlayer as new (n: string, l: typeof lobby) => RepPlayer)("host", lobby);
    this.players.push(p);
    p.attach(this.sessionConfig);
    this.host = p;
    return p;
  }

  async hostPlayers(): Promise<{ p: RepPlayer; layer: NetPlayers }> {
    const p = await this.startHost();
    const layer = new NetPlayers(p.session, this.optsFor("host"));
    this.layers.set("host", layer);
    return { p, layer };
  }

  async joinPlayers(name: string, role?: "player" | "spectator"): Promise<{ p: RepPlayer; layer: NetPlayers }> {
    let p: RepPlayer;
    if (role) {
      const lobby = await this.base.make(name, { mode: "raw" }).join(this.host.lobby.code, { role });
      p = new (this.host.constructor as new (n: string, l: typeof lobby) => RepPlayer)(name, lobby);
      this.players.push(p);
      p.attach({ adaptiveDelay: true });
      await this.until(() => lobby.connectedPeers.includes(lobby.hostPeerId), 400);
    } else p = await this.join(name);
    const layer = new NetPlayers(p.session, this.optsFor(name));
    this.layers.set(name, layer);
    return { p, layer };
  }

  override async step(): Promise<void> {
    this.base.clock.advance(this.frameMs);
    await settle();
    for (const p of [...this.players]) {
      if (this.frozen.has(p.name)) continue;
      const layer = this.layers.get(p.name);
      if (layer) {
        layer.pump();
        continue;
      }
      p.session.pump();
      if (p.session.isHost) {
        while (p.session.clock.tryAdvance()) {
          this.hostTick?.(p.session.clock.tick);
          p.session.sendSnapshot();
        }
      } else while (p.session.clock.tryAdvance()) p.makeInput?.(p.session.clock.tick);
    }
  }

  /** Virtual time in ms. */
  get nowMs(): number {
    return this.base.clock.now();
  }
}

/** A smooth path in metres at a time in ms: a lap of a 12 m circle every ~8 s with a bob, so speed is about 9 m/s at most. */
export function pathAt(ms: number, phase = 0): PlayerState {
  const t = ms / 1000;
  const w = 0.8;
  const x = 12 * Math.sin(w * t + phase);
  const z = 12 * Math.cos(w * t + phase);
  const vx = 12 * w * Math.cos(w * t + phase);
  const vz = -12 * w * Math.sin(w * t + phase);
  const y = 0.5 * Math.sin(2 * t);
  const vy = 1.0 * Math.cos(2 * t);
  const yaw = ((Math.atan2(vx, vz) * 180) / Math.PI + 360) % 360;
  return { x, y, z, vx, vy, vz, yaw, pitch: 0, onGround: true, mode: 2, item: 0, aiming: false, blocking: false, health: 100, alive: true, team: 0, teleport: 0, carried: false };
}
