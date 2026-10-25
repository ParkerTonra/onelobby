// OneLobby glue, no DOM: load onelobby.json, build the kit from it, bind a game to a lobby. Safe to import from Node
// (the two-player test does). Written by create-onelobby; yours to edit.
//
// A game plugs in with four members: step(tick, commands) -> hash, snapshot() -> bytes, restore(tick, bytes), hash().
// Commands are opaque bytes you define (rule 1 in AGENTS.md); OneLobby never looks inside.
import { OneLobby } from "onelobby";

const STORAGE_KEY = "onelobby.lobbyServer";

/** Fetch onelobby.json at runtime: editing the file changes the game on the next load, with no rebuild. */
export async function loadBlueprint(url = "./onelobby.json") {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`could not load ${url} (HTTP ${res.status})`);
  return res.json();
}

/**
 * The lobby server URL is a player-editable setting (AGENTS.md rule 5). Precedence: ?lobby= in the page URL, then what
 * the player saved, then <meta name="lobby-server">, then hosting.lobbyServer from onelobby.json.
 */
export function lobbyServerSetting(blueprint) {
  try {
    const fromUrl = new URLSearchParams(globalThis.location?.search ?? "").get("lobby");
    if (fromUrl) return fromUrl;
  } catch {}
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (saved) return saved;
  } catch {}
  const meta = globalThis.document?.querySelector?.('meta[name="lobby-server"]')?.content;
  if (meta) return meta;
  return blueprint?.hosting?.lobbyServer ?? "";
}

export function saveLobbyServer(url) {
  try {
    if (url) globalThis.localStorage?.setItem(STORAGE_KEY, url);
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {}
}

/** Build a kit from the file. Throws OneLobbyError("bad_config") with the path of the first bad key. */
export function makeKit(blueprint, { displayName = "", lobbyServer, advanced } = {}) {
  return OneLobby.fromConfig(blueprint, { displayName, lobbyServer: lobbyServer ?? lobbyServerSetting(blueprint), advanced });
}

/** Which controls the page shows. `bp` is kit.blueprint (validated, defaults filled in). */
export function features(bp) {
  return {
    voice: bp.chat.voice,
    chat: bp.chat.text,
    browse: bp.hosting.server && bp.lobby.listed,
    joinLink: bp.lobby.joinLink,
    nameBox: bp.players.identity !== "anonymous",
    server: bp.hosting.server,
  };
}

// raw mode wire format (first byte is a tag; other tags are free for your game)
const TAG_COMMAND = 1; // joiner -> host: [1, ...command]
const TAG_STATE = 2; // host -> everyone: [2, tick u32 LE, ...snapshot]

/**
 * Bind a game to a lobby. lockstep: the library orders commands, every player runs the same sim and compares hashes.
 * raw: the host runs the sim and broadcasts its state, joiners send commands and show what the host says.
 * Call `pump(nowMs)` every frame. `send(commandBytes)` is how a player acts.
 */
export function bindSession(lobby, bp, game) {
  const mode = bp.sync.mode === "lockstep" ? "lockstep" : "raw";
  const s = { mode, lobby, game, desyncs: 0, hash: game.hash(), frames: 0, pump: null, send: null };

  if (mode === "lockstep") {
    lobby.lockstep.snapshot = () => game.snapshot();
    lobby.lockstep.restore = (tick, bytes) => game.restore(tick, bytes);
    lobby.lockstep.on("desync", () => s.desyncs++);
    s.pump = () => {
      let f;
      while ((f = lobby.lockstep.nextFrame())) {
        s.hash = game.step(f.tick, f.commands);
        s.frames++;
        lobby.lockstep.reportHash(f.tick, s.hash);
      }
    };
    s.send = (bytes) => lobby.lockstep.submit(bytes);
    return s;
  }

  const queue = [];
  const stepMs = 1000 / bp.sync.tickRate;
  let last = null;
  lobby.on("message", (from, bytes) => {
    if (bytes[0] === TAG_COMMAND && lobby.isHost) queue.push({ peerId: from, bytes: bytes.slice(1) });
    else if (bytes[0] === TAG_STATE && !lobby.isHost) {
      const tick = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0, true);
      game.restore(tick, bytes.slice(5));
      s.hash = game.hash();
      s.frames++;
    }
  });
  s.pump = (nowMs = 0) => {
    if (!lobby.isHost || lobby.phase !== "in_game") {
      last = null;
      return;
    }
    last ??= nowMs;
    while (nowMs - last >= stepMs) {
      last += stepMs;
      s.hash = game.step(game.tick + 1, queue.splice(0));
      s.frames++;
      const snap = game.snapshot();
      const msg = new Uint8Array(5 + snap.length);
      msg[0] = TAG_STATE;
      new DataView(msg.buffer).setUint32(1, game.tick, true);
      msg.set(snap, 5);
      lobby.broadcast(msg);
    }
  };
  s.send = (bytes) => {
    if (lobby.isHost) queue.push({ peerId: lobby.localPeerId, bytes });
    else {
      const msg = new Uint8Array(1 + bytes.length);
      msg[0] = TAG_COMMAND;
      msg.set(bytes, 1);
      lobby.send(lobby.hostPeerId, msg);
    }
  };
  return s;
}
