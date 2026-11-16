import type { NetPlayers, PlayerInput, PlayerState } from "../src/index.js";
import type { RepPlayer } from "./replication-rig.js";
import { PlayerRig, pathAt, type PlayerRigOptions } from "./player-rig.js";

export type Mode = "owner" | "host";

/** Host mode movement: 6 m/s on X and Z, facing the input's yaw. The same function runs on the host and in the owner's prediction. */
export function walkStep(s: PlayerState, i: PlayerInput, dt: number): PlayerState {
  return { ...s, x: s.x + i.moveX * 6 * dt, z: s.z + i.moveY * 6 * dt, vx: i.moveX * 6, vz: i.moveY * 6, yaw: i.yaw };
}

export interface Scene {
  rig: PlayerRig;
  host: RepPlayer;
  a: RepPlayer;
  b: RepPlayer;
  hl: NetPlayers;
  al: NetPlayers;
  bl: NetPlayers;
}

/** Host + two clients (A moves, B watches) at 100 ms latency, 20 ms jitter, 3% loss on `fast` unless said otherwise. */
export async function scene(mode: Mode, o: PlayerRigOptions = {}): Promise<Scene> {
  const rig = new PlayerRig({ layer: { authority: mode, step: walkStep }, ...o });
  const { p: host, layer: hl } = await rig.hostPlayers();
  const { p: a, layer: al } = await rig.joinPlayers("a");
  const { p: b, layer: bl } = await rig.joinPlayers("b");
  return { rig, host, a, b, hl, al, bl };
}

/** Make A walk its path: its state each tick (owner mode) or its input each tick (host mode). */
export function drive(s: Scene, phase = 0): void {
  if (s.al.authority === "owner") {
    s.al.on("tick", () => {
      const { teleport: _t, ...rest } = pathAt(s.rig.nowMs, phase); // the teleport counter is the layer's to keep
      s.al.setLocalState(rest);
    });
  }
  else {
    s.al.on("tick", () => {
      const t = s.rig.nowMs / 1000;
      s.al.setLocalInput({ moveX: Math.sin(0.8 * t + phase), moveY: Math.cos(0.8 * t + phase), yaw: 90 });
    });
  }
}

export interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
}
export const dist = (a: Sample, b: Sample): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The owner's path at time `t`, interpolated between its frame samples. */
export function at(path: Sample[], t: number): Sample | undefined {
  if (path.length === 0 || t < path[0].t || t > path[path.length - 1].t) return undefined;
  let lo = 0;
  let hi = path.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (path[m].t <= t) lo = m;
    else hi = m;
  }
  const a = path[lo];
  const b = path[hi];
  const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
}

/**
 * Two paths that are a render delay apart: find the one constant lag (0 to 600 ms, 8 ms steps) at which the watched path
 * is closest to the owner's path on average, then report the mean, the 99th percentile and the worst distance at that lag.
 */
export function comparePaths(owner: Sample[], watched: Sample[]): { lagMs: number; mean: number; max: number; p99: number } {
  let best = { lagMs: 0, mean: Infinity, max: Infinity, p99: Infinity };
  for (let lag = 0; lag <= 600; lag += 8) {
    let sum = 0;
    let max = 0;
    const errs: number[] = [];
    for (const w of watched) {
      const o = at(owner, w.t - lag);
      if (!o) continue;
      const d = dist(w, o);
      sum += d;
      if (d > max) max = d;
      errs.push(d);
    }
    const n = errs.length;
    if (n > 20 && sum / n < best.mean) {
      errs.sort((a, b) => a - b);
      best = { lagMs: lag, mean: sum / n, max, p99: errs[Math.min(n - 1, Math.floor(0.99 * n))] };
    }
  }
  return best;
}

/** Run `seconds` of frames, recording A's own path and B's view of A each frame. */
export async function record(s: Scene, seconds: number, skipSeconds = 0): Promise<{ owner: Sample[]; watched: Sample[] }> {
  const owner: Sample[] = [];
  const watched: Sample[] = [];
  const frames = (seconds * 1000) / s.rig.frameMs;
  for (let i = 0; i < frames; i++) {
    await s.rig.step();
    const t = s.rig.nowMs;
    const mine = s.al.get(s.al.localPeerId);
    if (mine) owner.push({ t, x: mine.x, y: mine.y, z: mine.z });
    const seen = s.bl.get(s.al.localPeerId);
    if (seen && i * s.rig.frameMs >= skipSeconds * 1000) watched.push({ t, x: seen.x, y: seen.y, z: seen.z });
  }
  return { owner, watched };
}
