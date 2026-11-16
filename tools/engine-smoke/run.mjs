// engine-smoke: a simulated game per engine client (JS, GDScript, C#) over every route that client supports.
//   node tools/engine-smoke/run.mjs [--engines=js,gd,cs] [--routes=server,nostr,typed,ipcode,turn] [--cases=js,js+gd] [--verbose]
//        [--godot=<path to godot>] [--no-build] [--rounds=3] [--timeout=60]
// One host + two joiners per case exchange a few rounds of game messages (reliable and fast) on one route. Prints one
// line per case and finally ENGINE_SMOKE_OK or ENGINE_SMOKE_FAIL <list>. Everything binds 127.0.0.1; see README.md.
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startRelay } from "../../integration/nostr-test-relay.mjs";
import { startTurn } from "./turn-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const flags = {};
for (const x of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/s.exec(x);
  if (m) flags[m[1]] = m[2] ?? "1";
}
// --room: the room layer scenario (password, data, ready, countdown, start, kick with a reason, a wrong password) between JS, GDScript and C# peers
const ROOM = !!flags.room;
const ENGINES = (flags.engines ?? "js,gd,cs").split(",");
const ROUTES = (flags.routes ?? (ROOM ? "server,typed" : "server,nostr,typed,ipcode,turn")).split(",");
const ROUNDS = Number(flags.rounds ?? 3);
const CASE_TIMEOUT = Number(flags.timeout ?? 60);
const REPEAT = Number(flags.repeat ?? 1); // run every case this many times (flake hunting)
const verbose = !!flags.verbose;
const ENGINE_NAME = { js: "JS", gd: "GDScript", cs: "C#" };
// Routes each engine supports as host and as joiner. (Unity is represented by the C# client over its DataChannel transport.)
const SUPPORTS = { js: ROUTES, gd: ROUTES, cs: ROUTES };

// Cases: every engine alone (host + 2 joiners of that engine), then each host with the two OTHER engines as its joiners.
// "js+gd" style cases from --cases are host + joiner engines, e.g. --cases=js,js+gd+cs (host js, joiners gd and cs).
function cases() {
  if (ROOM) return ENGINES.flatMap((h) => ENGINES.map((j) => ({ host: h, joiners: [j, j] }))); // joiner 1 is a good one, joiner 2 uses a wrong password
  if (flags.cases) return flags.cases.split(",").map((c) => { const [h, ...j] = c.split("+"); return { host: h, joiners: j.length === 1 ? [j[0], j[0]] : j.length ? j : [h, h] }; });
  const out = [];
  for (const e of ENGINES) out.push({ host: e, joiners: [e, e] });
  for (const e of ENGINES) {
    const others = ENGINES.filter((x) => x !== e);
    if (others.length >= 2) out.push({ host: e, joiners: others.slice(0, 2) });
    else if (others.length === 1) out.push({ host: e, joiners: [others[0], others[0]] });
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = new Set();
function start(cmd, args, opts = {}) {
  // detached on POSIX: the peer gets its own process group, so kill() takes down what `dotnet run` started too
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32", ...opts });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  p.exited = false; p.code = null; p.getOut = () => out;
  p.on("exit", (c) => { p.exited = true; p.code = c; procs.delete(p); });
  procs.add(p);
  return p;
}
function kill(p) {
  if (!p || p.exited) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-p.pid, "SIGKILL");
  } catch { /* gone */ }
}
process.on("exit", () => { for (const p of [...procs]) kill(p); });
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout waiting for " + what);
    await sleep(50);
  }
}
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts });

// ---- prerequisites ---------------------------------------------------------------------------------------------------
const godot = flags.godot ?? process.env.GODOT ?? "";
const need = (c, what) => { if (!c) { console.error("engine-smoke: " + what); process.exit(2); } };
if (ENGINES.includes("js")) need(existsSync(join(root, "clients/js/packages/client/dist/index.js")), "build the JS client first: cd clients/js && npm ci && npm run build");
if (ENGINES.includes("gd")) {
  need(godot, "set GODOT (or --godot=) to a Godot 4.4+ executable");
  need(existsSync(join(root, "clients/gdscript/.godot/extension_list.cfg")), "prepare the GDScript project: bash clients/gdscript/fetch-webrtc.sh && godot --headless --import --path clients/gdscript");
}
const csOut = join(here, ".build", "csharp");
if (!flags["no-build"]) {
  if (ROUTES.includes("server")) { console.log("build: lobby server"); run("dotnet", ["build", join(root, "server/OneLobby.Server"), "-c", "Release", "-v", "q", "--nologo"]); }
  if (ENGINES.includes("cs")) { console.log("build: C# peer"); run("dotnet", ["build", join(here, "csharp-peer"), "-c", "Release", "-o", csOut, "-v", "q", "--nologo"]); }
}
if (ENGINES.includes("cs")) need(existsSync(join(csOut, "EngineSmokePeer.dll")), "C# peer is not built (run without --no-build)");

// ---- shared services ---------------------------------------------------------------------------------------------------
const relay = await startRelay();
const turn = ROUTES.includes("turn") ? await startTurn() : null;
let server = null, serverUrl = "";
if (ROUTES.includes("server")) {
  const sp = await freePort();
  // a dead local STUN entry keeps the server from advertising Google's STUN: nothing in this run leaves the machine
  server = start("dotnet", ["run", "--no-build", "-c", "Release", "--project", join(root, "server/OneLobby.Server"), "--", "--listen", `127.0.0.1:${sp}`,
    "--stun-urls", "stun:127.0.0.1:9", "--disable-ip-limits"]);
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${sp}/healthz`)).ok; } catch { return false; } }, 90000, "lobby server");
  serverUrl = `ws://127.0.0.1:${sp}/ws`;
}
console.log(`services: nostr relay ${relay.url}${turn ? `, TURN 127.0.0.1:${turn.port}` : ""}${server ? `, lobby server ${serverUrl}` : ""}`);

// ---- peers -------------------------------------------------------------------------------------------------------------
function peer(engine, args, tag) {
  const a = args;
  let p;
  if (engine === "js") p = start("node", [join(here, "js-peer.mjs"), ...a]);
  else if (engine === "cs") p = start("dotnet", [join(csOut, "EngineSmokePeer.dll"), ...a]);
  else p = start(godot, ["--headless", "--audio-driver", "Dummy", "--path", join(root, "clients/gdscript"), "-s", "res://tests/engine_smoke_peer.gd", "--", ...a]);
  p.tag = tag;
  return p;
}

async function runCase(c, route, idx) {
  const label = `${ENGINE_NAME[c.host]} host + ${c.joiners.map((j) => ENGINE_NAME[j]).join(" + ")} joiners${ROOM ? " (room)" : ""}`;
  const t0 = Date.now();
  const port = 47900 + (idx % 40) * 8;
  const common = [`--route=${route}`, `--rounds=${ROUNDS}`, `--timeout=${CASE_TIMEOUT}`, ...(flags.loopback ? ["--loopback"] : []), ...(ROOM ? ["--scenario=room"] : [])];
  if (route === "server") common.push(`--server=${serverUrl}`);
  else common.push(`--relay=${relay.url}`);
  if (route === "turn") common.push(`--turn=${turn.line}`);
  const allocBefore = turn?.stats.allocations ?? 0, relayedBefore = turn?.stats.relayed ?? 0;
  const ps = [];
  const host = peer(c.host, ["--role=host", "--name=host-" + c.host, `--port=${port}`, "--joiners=" + (ROOM ? 1 : c.joiners.length), ...common], "host");
  ps.push(host);
  let detail = "";
  let warn = "", note = "";
  let ok = false;
  try {
    const m = await waitFor(() => /HOST_READY code=(\S*) typed=(\S*) ipcode=(\S*)/.exec(host.getOut()) ?? (host.exited ? { fail: true } : null), CASE_TIMEOUT * 1000, "host code");
    if (m.fail) throw new Error("host exited before it was ready");
    const code = m[1];
    const joiners = c.joiners.map((j, i) => peer(j, ["--role=join", `--name=join${i + 1}-${j}`, `--code=${code}`, ...(ROOM && i === 1 ? ["--wrongpw"] : []), ...common], "join"));
    ps.push(...joiners);
    await waitFor(() => ps.every((p) => p.exited), CASE_TIMEOUT * 1000 + 5000, "all peers to finish");
    // the verdict is each peer's own RESULT line; a non-zero exit AFTER a PASS (a native crash at shutdown) is reported, not hidden
    ok = ps.every((p) => /RESULT PASS/.test(p.getOut()));
    const crashed = ps.filter((p) => p.code !== 0 && /RESULT PASS/.test(p.getOut()));
    if (crashed.length) warn = `exit code ${[...new Set(crashed.map((p) => p.code))].join("/")} after RESULT PASS in ${crashed.length} peer(s)`;
    detail = ps.map((p) => (/RESULT (PASS|FAIL)[^\r\n]*/.exec(p.getOut())?.[0] ?? `no RESULT (exit ${p.code})`)).join(" | ");
    if (ok && route === "turn") {
      const n = turn.stats.allocations - allocBefore, k = turn.stats.relayed - relayedBefore;
      if (n < 1 || k < 1) { ok = false; detail += ` | TURN server saw ${n} allocations and ${k} relayed packets: relay not used`; } else note = `TURN: ${n} relay allocations, ${k} relayed packets`;
    }
  } catch (e) {
    detail = e.message + " | " + ps.map((p) => (/RESULT[^\r\n]*/.exec(p.getOut())?.[0] ?? "no RESULT")).join(" | ");
  }
  if (!ok || verbose) {
    for (const p of ps) console.log(`  --- ${p.tag} output ---\n${p.getOut().split(/\r?\n/).filter((l) => !/resources still in use|ObjectDB|^\s*$|Godot Engine v|WARNING: .*leaked|at: .*\(/i.test(l)).slice(-40).join("\n")}`);
  }
  for (const p of ps) kill(p);
  await sleep(300); // let the OS release the case's ports
  return { name: `${c.host}${c.joiners.every((j) => j === c.host) ? "" : `->${c.joiners.join("+")}`} ${route}`, label, route, ok, warn, note, secs: (Date.now() - t0) / 1000, detail };
}

const results = [];
let idx = 0;
try {
  for (const c of cases()) {
    for (const route of ROUTES) for (let rep = 0; rep < REPEAT; rep++) {
      if (![c.host, ...c.joiners].every((e) => SUPPORTS[e]?.includes(route))) continue;
      const r = await runCase(c, route, idx++);
      results.push(r);
      console.log(`${r.ok ? "PASS" : "FAIL"} ${r.route.padEnd(6)} ${r.label.padEnd(34)} ${r.secs.toFixed(1)}s  ${r.ok ? [r.note, r.warn ? "WARN " + r.warn : ""].filter(Boolean).join("  ") : r.detail}`);
    }
  }
} finally {
  kill(server);
  await relay.close();
  await turn?.close();
}
const failed = results.filter((r) => !r.ok);
const outDir = join(here, ".build");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "last-run.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
const warned = results.filter((r) => r.warn).length;
console.log(`engine-smoke: ${results.length - failed.length}/${results.length} cases passed${warned ? `, ${warned} with a warning (a peer exited non-zero after its PASS)` : ""}`);
console.log(failed.length === 0 && results.length > 0 ? "ENGINE_SMOKE_OK" : `ENGINE_SMOKE_FAIL ${failed.length ? failed.map((r) => `${r.name.replace(/ /g, ":")}`).join(",") : "no cases ran"}`);
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
