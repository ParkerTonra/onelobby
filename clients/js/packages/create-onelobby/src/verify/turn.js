// The local TURN server `verify` uses to prove the relay-only path, built on the npm package node-turn (pinned). create-onelobby has no
// runtime dependencies, so node-turn is a helper that `verify` loads only when it runs, from the game's own node_modules or from
// <game>/.onelobby/helpers (fetched anonymously there by `verify --fetch-helpers`). Never installed by scaffolding.
// The server binds 127.0.0.1 only, picks a free UDP port, and uses a fresh random login per run that is never written anywhere.
// The patches below are the ones tools/engine-smoke/turn-server.mjs documents: node-turn needs them to talk to libjuice
// (the ICE library inside Godot's WebRTC and libdatachannel).
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { run } from "./procs.js";

export const TURN_HELPER = { name: "node-turn", version: "0.0.6" };
export const helperDir = (projectDir) => join(resolve(projectDir), ".onelobby", "helpers");
/** The one command that gets the helper (also what `--fetch-helpers` runs). */
export const fetchCommand = (projectDir) => `npm install --prefix ${JSON.stringify(helperDir(projectDir))} ${TURN_HELPER.name}@${TURN_HELPER.version} --no-audit --no-fund --ignore-scripts`;

/** Where node-turn is installed for this game, or null: the game's own node_modules first, then the helper cache. */
export function findTurnHelper(projectDir) {
  for (const base of [projectDir, helperDir(projectDir)]) {
    if (existsSync(join(base, "node_modules", TURN_HELPER.name, "package.json"))) return base;
  }
  return null;
}

/** `npm install` the helper into <game>/.onelobby/helpers (anonymous; the registry is the only host). Resolves { ok, out }. */
export async function fetchTurnHelper(projectDir) {
  const dir = helperDir(projectDir);
  const args = ["install", "--prefix", dir, `${TURN_HELPER.name}@${TURN_HELPER.version}`, "--no-audit", "--no-fund", "--ignore-scripts"];
  const [file, fileArgs] = process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", ["npm", ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" ")]] : ["npm", args];
  const r = await run(file, fileArgs, { cwd: projectDir, timeoutMs: 180000 });
  return { ok: r.code === 0 && findTurnHelper(projectDir) !== null, out: r.out.trim().split(/\r?\n/).slice(-3).join(" | ") };
}

function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const s = createSocket("udp4");
    s.once("error", reject);
    s.bind(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/**
 * Start the TURN server from the helper installed under `base`. Resolves
 * { port, line, stats: { allocations, relayed }, close() }: `line` is the text a player would paste ("turn:127.0.0.1:PORT user pass").
 */
export async function startTurn(base) {
  const require = createRequire(join(base, "package.json"));
  const Turn = require("node-turn");
  // sign ChannelBind replies (RFC 8656 wants MESSAGE-INTEGRITY; libjuice ignores them otherwise)
  const ChannelBind = require("node-turn/lib/methods/channelBind.js");
  if (!ChannelBind.prototype.__onelobbyPatched) {
    const channelBind = ChannelBind.prototype.channelBind;
    ChannelBind.prototype.channelBind = function (msg, reply) {
      const resolve = reply.resolve.bind(reply);
      reply.resolve = () => {
        reply.addAttribute("software", this.server.software);
        reply.addAttribute("message-integrity");
        resolve();
      };
      return channelBind.call(this, msg, reply);
    };
    ChannelBind.prototype.__onelobbyPatched = true;
    // a Refresh without LIFETIME must keep the allocation's own lifetime (node-turn would re-arm its timer with NaN)
    const Allocation = require("node-turn/lib/allocation.js");
    const update = Allocation.prototype.update;
    Allocation.prototype.update = function (lifetime) {
      return update.call(this, lifetime || this.lifetime);
    };
  }
  const port = await freeUdpPort();
  const username = "verify" + randomBytes(3).toString("hex");
  const password = randomBytes(12).toString("hex"); // per run, never stored
  const stats = { allocations: 0, relayed: 0 };
  const server = new Turn({
    authMech: "long-term",
    credentials: { [username]: password },
    listeningPort: port,
    listeningIps: ["127.0.0.1"],
    relayIps: ["127.0.0.1"],
    minPort: 49152,
    maxPort: 65535,
    debugLevel: "DEBUG", // the hook below only counts; nothing is printed
    debug: (_level, message) => {
      const m = String(message);
      if (/^Sending .* allocate success/i.test(m)) stats.allocations++;
      if (/send indication|channel_bind|channel data/i.test(m)) stats.relayed++;
    },
  });
  server.start();
  // node-turn drops ChannelData from a client (it relays only Send indications); relay it as RFC 8656 section 12 says
  for (const sock of server.network.sockets) {
    sock.prependListener("message", (buf, rinfo) => {
      if (buf.length < 4 || buf[0] < 0x40 || buf[0] > 0x7f) return;
      const alloc = Object.values(server.allocations).find((x) => x.mappedAddress.address === rinfo.address && x.mappedAddress.port === rinfo.port);
      const peer = alloc?.channelBindings[buf.readUInt16BE(0)];
      if (!peer) return;
      stats.relayed++;
      alloc.sockets[0].send(buf.subarray(4, 4 + buf.readUInt16BE(2)), peer.port, peer.address);
    });
  }
  await new Promise((r) => setTimeout(r, 200));
  return {
    port,
    stats,
    line: `turn:127.0.0.1:${port} ${username} ${password}`,
    close: async () => {
      try {
        server.stop();
      } catch {
        /* already gone */
      }
    },
  };
}
