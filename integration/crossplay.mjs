// OneLobby MVP exit test: browser demo (stream C) <-> Godot demo (stream D) through a real onelobby-server.
//   node integration/crossplay.mjs [--only=1,4,5] [--godot <console exe>] [--browser <msedge.exe>] [--seconds 60]
// Starts: server/OneLobby.Server, clients/js/demo/serve.mjs, headless Godot (demo-godot), one headless Edge.
// Checks: (1) Godot hosts, browser joins, hashes equal for N s  (2) chat both ways  (3) voice tone Godot -> browser
//         (4) browser hosts, Godot joins, hashes equal  (5) host migration in a mixed 3-peer lobby, both orders.
// Everything it starts is killed on exit. Godot is driven only through the demo's existing CLI hooks (Main.cs header).
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith("--" + n + "="));
  if (a) return a.slice(n.length + 3);
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const GODOT = arg("godot", process.env.GODOT ?? "godot");
const EDGE = arg("browser", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
const SECONDS = Number(arg("seconds", 60));
const only = (arg("only", "1,2,3,4,5")).split(",").map(Number);
const SPORT = Number(arg("server-port", 18080)), DPORT = Number(arg("demo-port", 15173));
const WS = `ws://127.0.0.1:${SPORT}/ws`;
const DEMO = `http://localhost:${DPORT}/`;   // localhost = secure context (getUserMedia); the lobby URL inside is 127.0.0.1
const demoGodot = join(root, "clients/dotnet/demo-godot");
const work = mkdtempSync(join(tmpdir(), "ka-cross-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { chromium } = createRequire(join(root, "clients/js/package.json"))("playwright-core");

// ---- results ---------------------------------------------------------------------------------------------------
const results = [];
const check = (name, ok, evidence = "") => { results.push({ name, ok, evidence }); console.log(`${ok ? "PASS" : "FAIL"} ${name}  ${evidence}`); };
const note = (name, evidence) => { results.push({ name, ok: null, evidence }); console.log(`SKIP ${name}  ${evidence}`); };

// ---- processes -------------------------------------------------------------------------------------------------
const procs = new Set();
function start(cmd, args, tag, opts = {}) {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...opts });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  p.tag = tag; p.exited = false; p.getOut = () => out;
  p.on("exit", () => { p.exited = true; procs.delete(p); });
  procs.add(p);
  return p;
}
function kill(p) {
  if (!p || p.exited) return;
  try { execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
}
function killAll() { for (const p of [...procs]) kill(p); }
process.on("exit", killAll);
process.on("SIGINT", () => { killAll(); process.exit(130); });

async function waitFor(fn, ms, what, step = 200) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout waiting for " + what);
    await sleep(step);
  }
}

// ---- godot helpers ---------------------------------------------------------------------------------------------
let gseq = 0;
function godot(name, extra) {
  const id = `${name}${++gseq}`;
  const result = join(work, id + ".txt"), log = join(work, id + ".log");
  writeFileSync(result, "");
  const p = start(GODOT, ["--headless", "--path", demoGodot, "--audio-driver", "Dummy", "--log-file", log, "--",
    `--server=${WS}`, `--name=${name}`, `--result-file=${result}`, ...extra], "godot-" + id);
  p.result = result; p.logFile = log;
  p.lines = () => readFileSync(result, "utf8").split(/\r?\n/).filter(Boolean);
  p.hashes = () => new Map(p.lines().filter((l) => l.startsWith("hash ")).map((l) => { const [, t, h] = l.split(" "); return [Number(t), h]; }));
  p.chats = () => p.lines().filter((l) => l.startsWith("chat ")).map((l) => l.replace(/^chat \d+ /, ""));
  p.stdout.setEncoding("utf8");
  return p;
}
const godotLog = (p) => (existsSync(p.logFile) ? readFileSync(p.logFile, "utf8") : "") + p.getOut();

// ---- browser helpers -------------------------------------------------------------------------------------------
let browser, ctx;
async function openTab(name) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log(`[${name}] pageerror`, e.message));
  await p.goto(DEMO);
  await p.fill("#name", name);
  p.nm = name;
  return p;
}
const bHashes = async (p) => new Map(await p.evaluate(() => [...window.__ka.hashes].map(([t, h]) => [t, h.toString()])));
const bTick = (p) => p.evaluate(() => window.__ka.game?.tick ?? 0);
const bLog = (p) => p.evaluate(() => document.getElementById("log").innerText);
async function paintLoop(p) {
  await p.evaluate(() => { window.__paint = setInterval(() => {
    const l = window.__ka.lobby; if (l && l.phase === "in_game") l.lockstep.submit(Uint8Array.of(1, Math.floor(Math.random() * 16), Math.floor(Math.random() * 16)));
  }, 400); });
}
async function chat(p, text) { await p.fill("#chat", text); await p.press("#chat", "Enter"); }

function compare(a, b, minTick = 0) {
  let common = 0, bad = 0, first = null;
  for (const [t, h] of a) {
    if (t < minTick || !b.has(t)) continue;
    common++;
    if (b.get(t) !== h) { bad++; first ??= `tick ${t}: ${h} vs ${b.get(t)}`; }
  }
  return { common, bad, first };
}
const span = (m, minTick = 0) => { const ts = [...m.keys()].filter((t) => t >= minTick); return ts.length ? Math.max(...ts) - Math.min(...ts) : 0; };

// ---- scenarios -------------------------------------------------------------------------------------------------
const TICKS = Math.round(SECONDS * 20) + 100;

async function scenarioGodotHosts() {
  console.log("\n== scenario 1+2: Godot hosts, browser joins ==");
  const codeFile = join(work, "code1.txt");
  const g = godot("godot", ["--auto-host", "--expect-peers=1", `--code-file=${codeFile}`, "--paint", "--voice-tone", `--run-ticks=${TICKS}`]);
  const code = await waitFor(() => existsSync(codeFile) && readFileSync(codeFile, "utf8").trim(), 40000, "godot host code");
  console.log("godot hosting", code);
  const B = await openTab("browser");
  await B.fill("#code", code); await B.click("#join");
  await B.waitForFunction(() => window.__ka.lobby, null, { timeout: 20000 });
  await B.waitForFunction(() => window.__ka.game.tick > 20, null, { timeout: 30000 });
  check("1 browser joiner receives frames from Godot host", true);
  await paintLoop(B);
  await sleep(3000);
  await voiceChecks(B, g);
  await sleep(3000);
  await chat(B, "hello from the browser");
  await waitFor(() => g.exited, (SECONDS + 60) * 1000, "godot run-ticks to finish", 1000);
  const gh = g.hashes(), bh = await bHashes(B);
  const c = compare(gh, bh);
  const sp = Math.min(span(gh), span(bh)) / 20;
  check(`1 gridpaint hashes equal for ${SECONDS} s (Godot host -> browser)`, c.bad === 0 && c.common >= SECONDS && sp >= SECONDS - 1,
    `${c.common} common hash ticks over ${sp.toFixed(0)} s, ${c.bad} mismatches ${c.first ?? ""}`);
  const blog = await bLog(B);
  check("2 chat Godot -> browser", /hello from godot/.test(blog), blog.split("\n").filter((l) => /hello/.test(l)).join(" | "));
  check("2 chat browser -> Godot", g.chats().some((t) => t.includes("hello from the browser")), g.chats().join(" | "));
  check("1 Godot final line written", g.lines().some((l) => l.startsWith("final ")));
  await B.close();
}

// Check 3, run inside scenario 1 (Godot host peer 1 with --voice-tone, browser joiner peer 2, fake mic device in Edge).
async function voiceChecks(B, g) {
  console.log("-- check 3: voice");
  check("3 Godot --voice-tone started", await waitFor(() => g.lines().includes("voice_started"), 10000, "voice_started").then(() => true, () => false));
  await B.evaluate(() => { window.__ka.lobby.voice.enabled = true; });
  const heard = await B.waitForFunction(() => window.__ka.speaking.has(1), null, { timeout: 15000 }).then(() => true, () => false);
  check("3 voice tone Godot -> browser (speaking gains Godot peer 1, Opus decoded)", heard);
  // browser -> Godot: Edge's fake mic device beeps; hold V (as tabs.mjs does)
  await B.evaluate(() => document.activeElement.blur());
  await B.keyboard.down("v");
  const rx = await waitFor(() => g.lines().find((l) => l.startsWith("voice_rx ")), 12000, "voice_rx").catch(() => null);
  const level = await B.evaluate(() => window.__ka.lobby.voice.inputLevel);
  await B.keyboard.up("v");
  check("3 voice browser (fake mic) -> Godot decodes (voice_rx)", !!rx, `${rx ?? "no voice_rx"}; browser input level ${level}`);
}

async function scenarioBrowserHosts() {
  console.log("\n== scenario 4: browser hosts, Godot joins ==");
  const A = await openTab("browserhost");
  await A.click("#host");
  await A.waitForFunction(() => window.__ka.lobby, null, { timeout: 20000 });
  const code = await A.evaluate(() => window.__ka.lobby.code);
  console.log("browser hosting", code);
  const g = godot("godot", [`--auto-join=${code}`, "--paint", `--run-ticks=${TICKS}`]);
  await waitFor(() => g.lines().some((l) => l.startsWith("lobby ")), 40000, "godot joined");
  await A.waitForFunction(() => window.__ka.lobby.peers.length >= 2, null, { timeout: 15000 });
  await sleep(1500);
  await A.click("#start");
  await A.waitForFunction(() => window.__ka.game.tick > 20, null, { timeout: 15000 });
  await paintLoop(A);
  await sleep(8000);
  await chat(A, "hello from the browser host");
  await waitFor(() => g.exited, (SECONDS + 60) * 1000, "godot run-ticks to finish", 1000);
  const gh = g.hashes(), bh = await bHashes(A);
  const c = compare(gh, bh);
  const sp = Math.min(span(gh), span(bh)) / 20;
  check(`4 gridpaint hashes equal for ${SECONDS} s (browser host -> Godot joiner)`, c.bad === 0 && c.common >= SECONDS && sp >= SECONDS - 1,
    `${c.common} common hash ticks over ${sp.toFixed(0)} s, ${c.bad} mismatches ${c.first ?? ""}`);
  const blog = await bLog(A);
  check("4 chat Godot -> browser host", /hello from godot/.test(blog));
  check("4 chat browser host -> Godot", g.chats().some((t) => t.includes("hello from the browser host")), g.chats().join(" | "));
  await A.close();
}

async function scenarioMigrationGodotHost() {
  console.log("\n== scenario 5a: Godot hosts (peer 1), browsers B1 (2) and B2 (3); Godot host dies ==");
  const codeFile = join(work, "code5a.txt");
  const g = godot("godot", ["--auto-host", "--expect-peers=2", `--code-file=${codeFile}`, "--paint", "--run-ticks=1000000"]);
  const code = await waitFor(() => existsSync(codeFile) && readFileSync(codeFile, "utf8").trim(), 40000, "godot host code");
  const B1 = await openTab("b1"), B2 = await openTab("b2");
  for (const B of [B1, B2]) {
    await B.fill("#code", code); await B.click("#join");
    await B.waitForFunction(() => window.__ka.lobby, null, { timeout: 20000 });
    await sleep(1000);
  }
  await B1.waitForFunction(() => window.__ka.game.tick > 20, null, { timeout: 30000 });
  await B2.waitForFunction(() => window.__ka.game.tick > 20, null, { timeout: 30000 });
  await paintLoop(B1); await paintLoop(B2);
  await sleep(12000);
  const pre = compare(await bHashes(B1), await bHashes(B2));
  check("5a pre-migration: B1 == B2 hashes", pre.bad === 0 && pre.common > 5, `${pre.common} common, ${pre.bad} bad`);
  const t1a = await bTick(B1), t2a = await bTick(B2);
  const killedAt = Date.now();
  kill(g);
  const ok = await Promise.all([
    B1.waitForFunction(() => window.__ka.lobby?.isHost, null, { timeout: 15000 }).then(() => true, () => false),
    B2.waitForFunction(() => window.__ka.lobby?.hostPeerId === 2, null, { timeout: 15000 }).then(() => true, () => false),
  ]);
  const ms = Date.now() - killedAt;
  check("5a Godot host dies: browser peer 2 takes over, peer 3 follows", ok[0] && ok[1], `${ms} ms after kill (kill is a hard process kill)`);
  await sleep(12000);
  const t1b = await bTick(B1), t2b = await bTick(B2);
  check("5a frames resume after migration", t1b > t1a + 100 && t2b > t2a + 100, `B1 ${t1a}->${t1b}, B2 ${t2a}->${t2b}`);
  const h1 = await bHashes(B1), h2 = await bHashes(B2);
  const post = compare(h1, h2, t1a);
  check("5a hashes equal across the migration and after", post.bad === 0 && post.common > 10, `${post.common} common ticks from ${t1a}, ${post.bad} bad ${post.first ?? ""}`);
  const gh = g.hashes(), cg = compare(gh, h2);
  check("5a Godot's pre-death hashes match the browsers' (same history)", cg.bad === 0 && cg.common > 10, `${cg.common} common, ${cg.bad} bad ${cg.first ?? ""}`);
  const log2 = await bLog(B2);
  console.log("[b2 log tail]", log2.split("\n").slice(-6).join(" | "));
  await B1.close(); await B2.close();
}

async function scenarioMigrationBrowserHost() {
  console.log("\n== scenario 5b: browser A hosts (1), Godot (2), browser B (3); A closes, Godot must take over ==");
  const A = await openTab("a");
  await A.click("#host");
  await A.waitForFunction(() => window.__ka.lobby, null, { timeout: 20000 });
  const code = await A.evaluate(() => window.__ka.lobby.code);
  const g = godot("godot", [`--auto-join=${code}`, "--paint", "--run-ticks=1000000"]);
  await waitFor(() => g.lines().some((l) => l.startsWith("lobby ")), 40000, "godot joined");
  const gPeer = Number(g.lines().find((l) => l.startsWith("lobby ")).split(" ")[3]);
  const B = await openTab("b");
  await B.fill("#code", code); await B.click("#join");
  await B.waitForFunction(() => window.__ka.lobby, null, { timeout: 20000 });
  await A.waitForFunction(() => window.__ka.lobby.peers.length >= 3, null, { timeout: 15000 });
  await sleep(1000);
  await A.click("#start");
  await B.waitForFunction(() => window.__ka.game.tick > 20, null, { timeout: 30000 });
  await paintLoop(A); await paintLoop(B);
  await sleep(12000);
  const pre = compare(g.hashes(), await bHashes(B));
  check("5b pre-migration: Godot == browser B hashes", pre.bad === 0 && pre.common > 5, `${pre.common} common, ${pre.bad} bad; godot peer id ${gPeer}`);
  const tB0 = await bTick(B); const gT0 = Math.max(...g.hashes().keys());
  const closedAt = Date.now();
  await A.close({ runBeforeUnload: false });
  const took = await waitFor(() => /host is now #2\b/.test(godotLog(g)), 15000, "godot host_changed").then(() => true, () => false);
  const bFollows = await B.waitForFunction((id) => window.__ka.lobby?.hostPeerId === id, gPeer, { timeout: 15000 }).then(() => true, () => false);
  const ms = Date.now() - closedAt;
  check("5b browser host closes: Godot takes over, browser follows", took && bFollows && gPeer === 2, `${ms} ms; godot peer ${gPeer}; godot log: ${(godotLog(g).match(/host is now #\d+/g) ?? []).join(",")}`);
  await sleep(12000);
  const tB1 = await bTick(B), gT1 = Math.max(...g.hashes().keys());
  check("5b frames resume after migration", tB1 > tB0 + 100 && gT1 > gT0 + 100, `B ${tB0}->${tB1}, Godot hash tick ${gT0}->${gT1}`);
  const post = compare(g.hashes(), await bHashes(B), tB0 - 200);
  check("5b hashes equal across the migration and after", post.bad === 0 && post.common > 10, `${post.common} common, ${post.bad} bad ${post.first ?? ""}`);
  console.log("[godot log tail]", godotLog(g).split(/\r?\n/).filter((l) => /\[onelobby\]/.test(l)).slice(-8).join(" | "));
  await B.close();
  kill(g);
}

// ---- main ------------------------------------------------------------------------------------------------------
let exitCode = 1;
try {
  console.log("work dir", work);
  start("dotnet", ["run", "--project", join(root, "server/OneLobby.Server"), "--", "--listen", `127.0.0.1:${SPORT}`, "--rate-scale", "20"], "server");
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${SPORT}/healthz`)).ok; } catch { return false; } }, 120000, "server /healthz");
  start("node", [join(root, "clients/js/demo/serve.mjs"), "--port", String(DPORT), "--lobby", WS], "demo");
  await waitFor(async () => { try { return (await fetch(DEMO)).ok; } catch { return false; } }, 20000, "demo server");
  browser = await chromium.launch({ executablePath: EDGE, headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  ctx = await browser.newContext({ permissions: ["microphone"] });

  const run = async (n, fn) => { if (!only.includes(n)) return; try { await fn(); } catch (e) { check(`scenario ${n} threw`, false, e.message); } };
  await run(1, scenarioGodotHosts);        // covers checks 1 and 2
  await run(4, scenarioBrowserHosts);
  if (only.includes(5)) {
    await run(5, scenarioMigrationGodotHost);
    await run(5, scenarioMigrationBrowserHost);
  }
  const bad = results.filter((r) => r.ok === false).length;
  console.log(`\n${results.filter((r) => r.ok).length} passed, ${bad} failed, ${results.filter((r) => r.ok === null).length} blocked/skipped`);
  writeFileSync(join(here, "last-run.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.log("ERROR", e.stack ?? e.message);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  killAll();
  await sleep(500);
  if (exitCode !== 0 || process.argv.includes("--keep")) console.log("logs kept in", work); else { try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ } }
}
process.exit(exitCode);
