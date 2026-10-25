import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { Gridpaint, OneLobby, type Lobby } from "../src/internals.js";
import type { AudioSink, FrameSource, VoiceCodec } from "../src/internals.js";
import { ManualClock, MemoryNetwork, MemoryServer } from "../src/testing.js";

export class FakeCodec implements VoiceCodec {
  createEncoder(_o: { bitrate: number }, onFrame: (o: Uint8Array) => void) {
    return {
      // "opus" = 8 coarse samples, enough to see the tone cross the wire
      encode(pcm: Float32Array) {
        const out = new Uint8Array(8);
        for (let i = 0; i < 8; i++) out[i] = Math.round((pcm[i * 120] * 0.5 + 0.5) * 255);
        onFrame(out);
      },
      close() {},
    };
  }
  createDecoder(onPcm: (p: Float32Array) => void) {
    return {
      decode(opus: Uint8Array | null) {
        const pcm = new Float32Array(960);
        if (opus) for (let i = 0; i < 8; i++) pcm.fill((opus[i] / 255 - 0.5) * 2, i * 120, (i + 1) * 120);
        onPcm(pcm);
      },
      close() {},
    };
  }
}

export class RecordingSink implements AudioSink {
  played: { peerId: number; pcm: Float32Array; gain: number }[] = [];
  play(peerId: number, pcm: Float32Array, gain: number) {
    this.played.push({ peerId, pcm, gain });
  }
  close() {}
}

export class ToneMic implements FrameSource {
  onFrame: ((p: Float32Array) => void) | null = null;
  async start(cb: (p: Float32Array) => void) {
    this.onFrame = cb;
  }
  stop() {
    this.onFrame = null;
  }
}

export interface Rig {
  clock: ManualClock;
  server: MemoryServer;
  net: MemoryNetwork;
  make(name: string, opts?: { mode?: "lockstep" | "raw"; hashEveryTicks?: number; peerTimeoutMs?: number }): OneLobby;
  sinks: Map<string, RecordingSink>;
  mics: Map<string, ToneMic>;
}

export function rig(): Rig {
  const clock = new ManualClock();
  const server = new MemoryServer();
  const net = new MemoryNetwork();
  const sinks = new Map<string, RecordingSink>();
  const mics = new Map<string, ToneMic>();
  return {
    clock,
    server,
    net,
    sinks,
    mics,
    make(name, opts = {}) {
      const sink = new RecordingSink();
      const mic = new ToneMic();
      sinks.set(name, sink);
      mics.set(name, mic);
      return new OneLobby({
        gameId: "gridpaint",
        netVersion: "1",
        lobbyServer: "mem://server",
        mode: opts.mode ?? "lockstep",
        tickRate: 20,
        hashEveryTicks: opts.hashEveryTicks ?? 20,
        peerTimeoutMs: opts.peerTimeoutMs,
        displayName: name,
        socketFactory: server.socketFactory,
        linkFactory: net.factoryFor(name),
        clock,
        wallClock: () => 1_700_000_000_000 + clock.now(),
        voiceCodec: new FakeCodec(),
        createMic: () => mic,
        createSink: () => sink,
      });
    },
  };
}

/** A gridpaint game bound to a lobby, like the demo wires it. */
export class Player {
  g: Gridpaint;
  hashes = new Map<number, bigint>();
  desyncs = 0;
  restores: number[] = [];
  corruptAt = -1;

  constructor(public name: string, public lobby: Lobby) {
    this.g = new Gridpaint(lobby.code);
    lobby.lockstep.snapshot = () => this.g.snapshot();
    lobby.lockstep.restore = (tick, bytes) => {
      this.g.restore(tick, bytes);
      this.restores.push(tick);
    };
    lobby.lockstep.on("desync", () => this.desyncs++);
  }

  /** Apply every available frame (what a game loop does each tick). */
  pump(): void {
    let f;
    while ((f = this.lobby.lockstep.nextFrame())) {
      if (this.corruptAt === f.tick) this.g.grid.fill(9); // a deliberate determinism bug
      const h = this.g.step(f.tick, f.commands);
      this.hashes.set(f.tick, h);
      this.lobby.lockstep.reportHash(f.tick, h);
    }
  }

  paint(x: number, y: number): void {
    this.lobby.lockstep.submit(Uint8Array.of(1, x, y));
  }
}

/** Run simulated time, pumping every player each 50 ms slice. */
export async function play(clock: ManualClock, players: Player[], ms: number, step = 25): Promise<void> {
  let left = ms;
  while (left > 0) {
    const d = Math.min(step, left);
    clock.advance(d);
    left -= d;
    await clock.run(0);
    for (const p of players) p.pump();
  }
  await clock.run(0);
  for (const p of players) p.pump();
}

const bindable = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const tcp = createServer();
    tcp.once("error", () => resolve(false));
    tcp.listen(port, () => {
      const udp = createSocket("udp4");
      udp.once("error", () => tcp.close(() => resolve(false)));
      udp.bind(port, () => udp.close(() => tcp.close(() => resolve(true))));
    });
  });

/**
 * A port that, with the `span - 1` after it, binds on TCP and UDP (a direct host takes both). Windows reserves UDP
 * ranges (Hyper-V, WSL) that a TCP-only probe misses, so an OS-picked TCP port alone is not enough.
 */
export async function freePort(span = 4): Promise<number> {
  for (let tries = 0; tries < 50; tries++) {
    const p = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => resolve(port));
      });
    });
    if (p + span > 65535) continue;
    let ok = true;
    for (let i = 0; i < span && ok; i++) ok = await bindable(p + i);
    if (ok) return p;
  }
  throw new Error("no free TCP+UDP port run found");
}
