// conformance/peer adapter for onelobby (in-process). Run (after `npm run build` in clients/js):
//   node conformance/peer/run.mjs --adapter=../clients/js/conformance-adapter.mjs
// The library runs for real (real timers); only the three data channels per peer and the signaling socket are replaced:
// channels go through the harness as `send`/`recv`, signaling is a stub. The game is gridpaint, written against the public API.
import { Gridpaint, Lobby, paintCmd, systemClock } from "./packages/client/dist/internals.js";

const hex = (b) => Buffer.from(b).toString("hex");
const unhex = (s) => new Uint8Array(Buffer.from(s, "hex"));

export default function createAdapter() {
  let handler = () => {};
  const emit = (e) => handler(e);
  let lobby = null;
  let game = null;
  let loop = null;
  let ready = false; // set once start() finished: links created later are migration dials
  const hashes = new Map();
  const links = new Map();

  class HarnessLink {
    constructor(opts) {
      this.remoteId = opts.remoteId;
      this.isOpen = false;
      this.onSignal = null; this.onOpen = null; this.onClose = null; this.onMessage = null; this.onPath = null;
      links.set(this.remoteId, this);
      if (ready) emit({ ev: "dial", peerId: this.remoteId });
    }
    startOffer() {}
    handleSignal() {}
    send(channel, bytes) { if (this.isOpen) emit({ ev: "send", to: this.remoteId, channel, hex: hex(bytes) }); }
    close() {
      if (this.closedByUs) return;
      this.closedByUs = true;
      const was = this.isOpen;
      this.isOpen = false;
      if (links.get(this.remoteId) === this) links.delete(this.remoteId);
      if (was) emit({ ev: "close", peerId: this.remoteId });
      this.onClose?.("closed");
    }
  }

  const stubSignaling = { onMessage: null, onClose: null, isOpen: false, send() {}, close() {}, expect: () => new Promise(() => {}), request: () => new Promise(() => {}) };

  function pump() {
    if (!lobby || !game) return;
    let f;
    while ((f = lobby.lockstep.nextFrame())) {
      const h = game.step(f.tick, f.commands);
      hashes.set(f.tick, h);
      if (hashes.size > 1200) hashes.delete(f.tick - 1000);
      lobby.lockstep.reportHash(f.tick, h);
    }
  }

  function wire(a) {
    const ls = lobby.lockstep;
    ls.snapshot = () => game.snapshot();
    ls.restore = (tick, bytes) => {
      game.restore(tick, bytes);
      hashes.clear();
      hashes.set(tick, game.hash());
      emit({ ev: "snapshot_restored", tick });
    };
    ls.on("desync", (d) => emit({ ev: "desync", tick: d.tick, hostHash: d.hostHash.toString(), yourHash: d.yourHash.toString() }));
    lobby.on("hostChanged", (hostId) => emit({ ev: "host_changed", hostId, epoch: lobby.hostEpoch }));
    lobby.on("peerLeft", (p, reason) => { if (reason === "desync") emit({ ev: "peer_dropped", peerId: p.peerId, reason }); });
    lobby.on("message", (from, bytes, channel) => emit({ ev: "raw", from, channel, hex: hex(bytes) }));
    lobby.chat.on("message", (m) => emit({ ev: "chat", peerId: m.peerId, id: m.id, ts: m.ts, text: m.text }));
    lobby.chat.on("history", (lines) => emit({ ev: "chat_history", lines: lines.map((l) => ({ peerId: l.peerId, id: l.id, ts: l.ts, text: l.text })) }));
    lobby.chat.on("rejected", (id, reason) => emit({ ev: "chat_rejected", id, reason: { rate: 1, length: 2, muted_by_host: 3 }[reason] ?? 0 }));
    lobby.voice.on("packet", (peerId, seq, flags, frames) => emit({ ev: "voice", peerId, seq, flags, frames: frames.map(hex) }));
    void a;
  }

  async function start(a) {
    ready = false;
    hashes.clear();
    links.clear();
    const state = {
      t: "lobby", code: a.code, gameId: "gridpaint", netVersion: "1", hostId: a.hostId, you: a.peerId,
      mode: a.mode ?? "lockstep", tickRate: a.tickRate, lateJoin: true, phase: "lobby", meta: {},
      peers: (a.peers ?? []).map((id) => ({ peerId: id, name: id === a.peerId ? (a.name ?? "lib") : "p" + id })),
      resumeToken: "t",
    };
    if (!state.peers.some((p) => p.peerId === a.peerId)) state.peers.push({ peerId: a.peerId, name: a.name ?? "lib" });
    lobby = new Lobby({
      signaling: stubSignaling, state, ice: [], links: { create: (o) => new HarnessLink(o) }, clock: systemClock,
      wall: () => Date.now(), hashEveryTicks: a.hashEvery ?? a.tickRate, relayOnly: false,
      voice: { codec: null, createSource: null, createSink: null }, displayName: a.name ?? "lib",
    });
    lobby.errorSink = (e) => console.error("[lib error]", e.message);
    if (a.chunkSize) lobby.snapshotChunkSize = a.chunkSize;
    game = new Gridpaint(a.code);
    wire(a);
    if (state.hostId === a.peerId) {
      for (const p of state.peers) if (p.peerId !== a.peerId) lobby._offer(p.peerId);
    } else {
      lobby._answer(a.hostId);
    }
    loop = setInterval(pump, 4);
    ready = true;
  }

  return {
    set onevent(h) { handler = h; },
    async call(op, a = {}) {
      switch (op) {
        case "init": return { name: "onelobby (js)", capabilities: ["host", "joiner", "lockstep", "raw", "chat", "voice", "migration", "deflate"] };
        case "start": await start(a); return {};
        case "begin": await lobby.start(); return {};
        case "link_open": {
          let l = links.get(a.peerId);
          if (!l) l = lobby._answer(a.peerId); // a peer that dialled us (migration): answering side
          l.isOpen = true;
          l.onOpen?.();
          return {};
        }
        case "link_close": {
          const l = links.get(a.peerId);
          if (l) { l.closedByUs = true; l.isOpen = false; links.delete(a.peerId); l.onClose?.("remote closed"); }
          return {};
        }
        case "recv": {
          const l = links.get(a.from);
          if (l?.isOpen) { try { l.onMessage?.(a.channel, unhex(a.hex)); } catch { /* never throws */ } pump(); }
          return {};
        }
        case "command": lobby.lockstep.submit(paintCmd(a.x, a.y)); return {};
        case "chat_send": lobby.chat.send(a.text); return {};
        case "chat_host_mute": lobby.chat.hostMute(a.peerId, a.muted); return {};
        case "voice_send": lobby.voice.sendEncoded(a.frames.map(unhex), !!a.endOfBurst); return {};
        case "raw_send": if (a.to === 0) lobby.broadcast(unhex(a.hex), { channel: a.channel ?? "reliable" }); else lobby.send(a.to, unhex(a.hex), { channel: a.channel ?? "reliable" }); return {};
        case "hash_at": pump(); return { hash: hashes.has(a.tick) ? hashes.get(a.tick).toString() : (a.tick === 0 ? new Gridpaint("000000").hash().toString() : null) };
        case "state": pump(); return { tick: game.tick, hash: game.hash().toString() };
        case "stop":
          clearInterval(loop);
          loop = null;
          if (lobby) { const l = lobby; lobby = null; await l.leave(); }
          return {};
        default: throw new Error("unknown op " + op);
      }
    },
    async dispose() { clearInterval(loop); if (lobby) { await lobby.leave(); lobby = null; } },
  };
}
