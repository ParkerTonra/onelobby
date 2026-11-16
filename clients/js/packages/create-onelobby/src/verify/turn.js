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
const INSTALL_FLAGS = ["--no-audit", "--no-fund", "--ignore-scripts"];
const installArgs = (prefix) => ["install", "--prefix", prefix, `${TURN_HELPER.name}@${TURN_HELPER.version}`, ...INSTALL_FLAGS];

/**
 * The one command that gets the helper (also what `--fetch-helpers` runs), as one line for a person to paste into the shell of
 * `platform`: a POSIX shell gets single quotes (every quote inside is closed and re-opened), cmd.exe gets double quotes. cmd.exe has
 * no way to quote a `%` or a `"` inside a path, so for such a folder the line uses the relative prefix and is meant to be run in
 * the game folder.
 */
export function fetchCommand(projectDir, platform = process.platform) {
  const abs = helperDir(projectDir);
  let prefix;
  if (platform === "win32") prefix = /["%]/.test(abs) ? join(".onelobby", "helpers") : `"${abs}"`;
  else prefix = `'${abs.replace(/'/g, `'\\''`)}'`;
  return `npm ${installArgs(prefix).join(" ")}`;
}

/**
 * How to start npm without any shell: [file, args]. npm's own JS entry runs under the node that is running us (found through
 * $npm_execpath when it names npm-cli.js, else next to node), so no part of a path is ever parsed by cmd.exe or sh. Returns null
 * when it cannot be found on Windows (npm there is a .cmd file, which needs a shell); elsewhere the `npm` executable is spawned
 * directly (still no shell).
 */
export function npmCommand(args, { platform = process.platform, execPath = process.execPath, env = process.env, exists = existsSync } = {}) {
  const sep = platform === "win32" ? "\\" : "/";
  const fromEnv = env.npm_execpath;
  if (fromEnv && /(^|[\\/])npm-cli\.js$/.test(fromEnv) && exists(fromEnv)) return [execPath, [fromEnv, ...args]];
  const nodeDir = execPath.slice(0, Math.max(execPath.lastIndexOf("/"), execPath.lastIndexOf("\\")));
  for (const rel of platform === "win32" ? [["node_modules", "npm", "bin", "npm-cli.js"]] : [["..", "lib", "node_modules", "npm", "bin", "npm-cli.js"], ["node_modules", "npm", "bin", "npm-cli.js"]]) {
    const cli = [nodeDir, ...rel].join(sep);
    if (exists(cli)) return [execPath, [cli, ...args]];
  }
  return platform === "win32" ? null : ["npm", args];
}

/** `npm install` the helper into <game>/.onelobby/helpers (anonymous; the registry is the only host). Resolves { ok, out }. */
export async function fetchTurnHelper(projectDir, { runImpl = run, ...env } = {}) {
  const args = installArgs(helperDir(projectDir));
  const cmd = npmCommand(args, env);
  if (!cmd) return { ok: false, out: `could not find npm's own script next to this node; run it yourself: ${fetchCommand(projectDir, env.platform)}` };
  const r = await runImpl(cmd[0], cmd[1], { cwd: projectDir, timeoutMs: 180000 });
  return { ok: r.code === 0 && findTurnHelper(projectDir) !== null, out: (r.out ?? "").trim().split(/\r?\n/).slice(-3).join(" | ") };
}

/** Where node-turn is installed for this game, or null: the game's own node_modules first, then the helper cache. */
export function findTurnHelper(projectDir) {
  for (const base of [projectDir, helperDir(projectDir)]) {
    if (existsSync(join(base, "node_modules", TURN_HELPER.name, "package.json"))) return base;
  }
  return null;
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
