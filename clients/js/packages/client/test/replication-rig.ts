import { NetMath, ReplicationSession, replicated } from "../src/index.js";
import type { EntityInfo, Lobby, ReplicationConfig, StateSchema } from "../src/internals.js";
import { settle } from "../src/testing.js";
import { rig as baseRig } from "./helpers.js";

/** Deterministic random numbers (mulberry32), so a failing run can be repeated. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A typical creature: position on a 512 m map, height, yaw, animation, health. 64 bits on the wire. */
export interface AlienState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  anim: number;
  hp: number;
}

export const alienSchema: StateSchema<AlienState> = {
  write(w, s) {
    w.writeQuantized(s.x, -256, 256, 16);
    w.writeQuantized(s.y, -32, 32, 12);
    w.writeQuantized(s.z, -256, 256, 16);
    w.writeAngle(s.yaw, 9);
    w.writeBits(s.anim, 4);
    w.writeBits(s.hp, 7);
  },
  read(r) {
    return {
      x: r.readQuantized(-256, 256, 16),
      y: r.readQuantized(-32, 32, 12),
      z: r.readQuantized(-256, 256, 16),
      yaw: r.readAngle(9),
      anim: r.readBits(4),
      hp: r.readBits(7),
    };
  },
  lerp(a, b, t) {
    return {
      x: NetMath.lerp(a.x, b.x, t), y: NetMath.lerp(a.y, b.y, t), z: NetMath.lerp(a.z, b.z, t),
      yaw: NetMath.lerpAngle(a.yaw, b.yaw, t), anim: t < 0.5 ? a.anim : b.anim, hp: t < 0.5 ? a.hp : b.hp,
    };
  },
};

export const newAlien = (init: Partial<AlienState> = {}): AlienState => ({ x: 0, y: 0, z: 0, yaw: 0, anim: 0, hp: 100, ...init });
export const alienEntity = (a: AlienState) => replicated(alienSchema, () => a);

export interface EventRecord {
  from: number;
  tick: number;
  payload: Uint8Array;
}

export class RepPlayer {
  session!: ReplicationSession;
  readonly spawned: EntityInfo[] = [];
  readonly despawned: EntityInfo[] = [];
  readonly events: EventRecord[] = [];
  /** Client: called once per local input tick; returns the input bytes (null = send nothing). */
  makeInput: ((tick: number) => Uint8Array | null) | null = null;
  readonly submittedSeqs: number[] = [];

  constructor(readonly name: string, readonly lobby: Lobby) {}

  get peerId(): number {
    return this.lobby.localPeerId;
  }

  attach(config?: Partial<ReplicationConfig>): void {
    this.session = new ReplicationSession(this.lobby, config);
    this.session.on("entitySpawned", (e) => this.spawned.push(e));
    this.session.on("entityDespawned", (e) => this.despawned.push(e));
    this.session.on("eventReceived", (from, tick, payload) => this.events.push({ from, tick, payload }));
  }
}

/** Host + clients on the in-memory network with latency, loss and jitter, stepped in 16 ms frames. */
export class RepRig {
  readonly base = baseRig();
  readonly players: RepPlayer[] = [];
  readonly random: () => number;
  host!: RepPlayer;
  /** Host sim step, run once per host tick before the snapshot. */
  hostTick: ((tick: number) => void) | null = null;
  frameMs = 16;

  constructor(private config?: Partial<ReplicationConfig>, opts: { latencyMs?: number; lossRate?: number; jitterMs?: number; seed?: number } = {}) {
    this.random = rng(opts.seed ?? 1234);
    const net = this.base.net;
    net.clock = this.base.clock;
    net.latencyMs = opts.latencyMs ?? 30;
    if (opts.lossRate) net.dropFast = () => this.random() < opts.lossRate!;
    if (opts.jitterMs) net.extraDelayMs = () => this.random() * opts.jitterMs!;
  }

  get net() {
    return this.base.net;
  }

  async startHost(): Promise<RepPlayer> {
    const lobby = await this.base.make("host", { mode: "raw" }).host({ name: "room", maxPlayers: 8 });
    const p = new RepPlayer("host", lobby);
    this.players.push(p);
    p.attach(this.config);
    this.host = p;
    return p;
  }

  async join(name: string): Promise<RepPlayer> {
    const lobby = await this.base.make(name, { mode: "raw" }).join(this.host.lobby.code);
    const p = new RepPlayer(name, lobby);
    this.players.push(p);
    p.attach(this.config);
    await this.until(() => lobby.connectedPeers.includes(lobby.hostPeerId), 400);
    return p;
  }

  /** One render frame on every peer: advance time, pump, run due ticks (host: sim + snapshot; client: inputs). */
  async step(): Promise<void> {
    this.base.clock.advance(this.frameMs);
    await settle();
    for (const p of [...this.players]) {
      p.session.pump();
      if (p.session.isHost) {
        while (p.session.clock.tryAdvance()) {
          this.hostTick?.(p.session.clock.tick);
          p.session.sendSnapshot();
        }
      } else {
        while (p.session.clock.tryAdvance()) {
          const input = p.makeInput?.(p.session.clock.tick);
          if (input) p.submittedSeqs.push(p.session.submitInput(input));
        }
      }
    }
  }

  async run(seconds: number): Promise<void> {
    const n = (seconds * 1000) / this.frameMs;
    for (let i = 0; i < n; i++) await this.step();
  }

  async until(cond: () => boolean, maxSteps = 1200): Promise<boolean> {
    for (let i = 0; i < maxSteps; i++) {
      if (cond()) return true;
      await this.step();
    }
    return cond();
  }

  /** Bytes the link of `p` handed to the network on a channel (lobby frames included). */
  sentBytes(p: RepPlayer, channel: "reliable" | "fast"): number {
    return this.net.links.filter((l) => l.owner === p.name).reduce((n, l) => n + l.sent[channel], 0);
  }
}
