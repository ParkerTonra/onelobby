// Cross-client LAN discovery run (spec/lan-discovery.md), everything on 127.0.0.1: nothing is broadcast.
//   1. a GDScript host answers, the Node finder must list it;  2. a Node host answers, the GDScript finder must list it.
// Needs a build (npm run build) and a Godot 4 console binary: GODOT=/path/to/godot node e2e/lan-cross.mjs
// Starts two short-lived Godot processes (headless, no window) and stops them itself.
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LanFinder, LanHost } from "../packages/client/dist/index.js";

const godot = process.env.GODOT;
if (!godot) throw new Error("set GODOT to a Godot 4 executable");
const project = join(dirname(fileURLToPath(import.meta.url)), "../../gdscript");
const run = (args, onLine) => {
  const p = spawn(godot, ["--headless", "--audio-driver", "Dummy", "--path", project, "-s", "res://tests/lan_peer.gd", "--", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      onLine(line);
    }
  });
  const done = new Promise((r) => p.on("exit", (code) => r(code)));
  return { p, done };
};
const freeUdpPort = async () => {
  const s = createSocket("udp4");
  await new Promise((r) => s.bind(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
};
const until = async (cond, ms, what) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out: " + what);
    await new Promise((r) => setTimeout(r, 20));
  }
};
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${what}`);
  if (!ok) failed++;
};

// 1. GDScript host, Node finder
{
  const port = await freeUdpPort();
  let ready = false;
  const g = run(["host", String(port), "Ants!", "Sam", "47812", "12"], (l) => { console.log("  godot: " + l); if (l === "HOST_READY") ready = true; });
  try {
    await until(() => ready, 20000, "godot host ready");
    const f = new LanFinder({ gameId: "cross", netVersion: "1", targets: ["127.0.0.1"], port, askIntervalMs: 200, minGapMs: 100 });
    await f.start();
    await until(() => f.games.length > 0, 8000, "node finder row");
    const r = f.games[0];
    console.log("  node row: " + JSON.stringify(r));
    f.stop();
    check(r.address === "127.0.0.1" && r.port === 47812 && r.name === "Ants!" && r.hostName === "Sam" && r.players === 2 && r.maxPlayers === 4 && r.hasPassword === true && r.sameVersion === true, "GDScript host found by the Node finder with the right fields");
  } finally {
    g.p.kill();
    await g.done;
  }
}

// 2. Node host, GDScript finder
{
  const port = await freeUdpPort();
  const host = new LanHost({ gameId: "cross", netVersion: "1", port, bindHost: "127.0.0.1", info: () => ({ lobbyName: "Bees", hostName: "Ann", players: 1, maxPlayers: 6, password: false, port: 47813 }) });
  check(await host.start(), "Node host opens its answering socket on 127.0.0.1");
  let row = null;
  let noRow = false;
  const g = run(["find", String(port), "cross", "1"], (l) => { console.log("  godot: " + l); if (l.startsWith("ROW ")) row = JSON.parse(l.slice(4)); if (l === "NO_ROW") noRow = true; });
  try {
    await until(() => row || noRow, 20000, "godot finder result");
    check(!!row && row.address === "127.0.0.1" && row.port === 47813 && row.name === "Bees" && row.host_name === "Ann" && row.players === 1 && row.max_players === 6 && row.has_password === false && row.same_version === true, "Node host found by the GDScript finder with the right fields");
  } finally {
    g.p.kill();
    await g.done;
    host.close();
  }
}
console.log(failed === 0 ? "lan-cross ok" : `lan-cross FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
