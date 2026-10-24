// Cross-play: browser (onelobby JS in headless Edge) <-> .NET (OneLobby.DataChannel / libdatachannel) through a real
// onelobby-server, raw mode, both host directions. The .NET side is clients/dotnet/OneLobby.DataChannel.Smoke, the same
// transport the Unity package uses.
//   cd clients/js && npm ci && npm run build      # once: dist/onelobby.global.min.js
//   node integration/crossplay-datachannel.mjs [--browser <msedge.exe>] [--server-port 18091]
// Checks: (A) browser hosts, .NET joins: reliable + fast echo  (B) .NET hosts, browser joins: reliable + fast echo.
// Needs the native library built (clients/dotnet/OneLobby.DataChannel/native/build-windows.ps1).
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const EDGE = arg("browser", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
const SPORT = Number(arg("server-port", 18091));
const WS = `ws://127.0.0.1:${SPORT}/ws`;
const { chromium } = createRequire(join(root, "clients/js/package.json"))("playwright-core");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, evidence = "") => { results.push({ name, ok, evidence }); console.log(`${ok ? "PASS" : "FAIL"} ${name}  ${evidence}`); };

const procs = new Set();
function start(cmd, args, tag) {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  p.tag = tag; p.exited = false; p.code = null; p.getOut = () => out;
  p.on("exit", (c) => { p.exited = true; p.code = c; procs.delete(p); });
  procs.add(p);
  return p;
}
function kill(p) {
  if (!p || p.exited) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else p.kill("SIGKILL");
  } catch { /* gone */ }
}
process.on("exit", () => { for (const p of [...procs]) kill(p); });
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout waiting for " + what);
    await sleep(100);
  }
}

// ---- page: the onelobby global bundle plus a tiny echo/probe driven from playwright -----------------------------
const bundle = readFileSync(join(root, "clients/js/packages/client/dist/onelobby.global.min.js"));
const page = `<!doctype html><meta charset="utf-8"><script src="/onelobby.js"></script><script>
const enc = new TextEncoder(), dec = new TextDecoder();
window.log = [];
window.kit = () => new OneLobby.OneLobby({ gameId: "com.onelobby.crossplay", netVersion: "1", lobbyServer: ${JSON.stringify(WS)}, mode: "raw", displayName: "Browser" });
window.hostEcho = async () => {
  const lobby = await window.kit().host({ name: "crossplay", maxPlayers: 2 });
  lobby.on("message", (from, bytes, channel) => {
    const t = dec.decode(bytes); window.log.push(channel + " " + from + " " + t);
    if (t !== "bye" && !t.startsWith("echo:")) lobby.send(from, enc.encode("echo:" + t), { channel });
  });
  return lobby.code;
};
window.joinProbe = async (code) => {
  const lobby = await window.kit().join(code);
  await lobby.ready;
  const got = { reliable: false, fast: false };
  lobby.on("message", (from, bytes, channel) => {
    const t = dec.decode(bytes); window.log.push(channel + " " + from + " " + t);
    if (t === "echo:hello from browser" && channel === "reliable") got.reliable = true;
    if (t === "echo:fast from browser" && channel === "fast") got.fast = true;
  });
  lobby.send(lobby.hostPeerId, enc.encode("hello from browser"));
  for (let i = 0; i < 100 && !(got.reliable && got.fast); i++) {
    if (!got.fast) lobby.send(lobby.hostPeerId, enc.encode("fast from browser"), { channel: "fast" });
    await new Promise((r) => setTimeout(r, 100));
  }
  lobby.send(lobby.hostPeerId, enc.encode("bye"));
  await new Promise((r) => setTimeout(r, 300));
  return got;
};
</script>`;
const http = createServer((req, res) => {
  if (req.url === "/onelobby.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(bundle); return; }
  res.writeHead(200, { "content-type": "text/html" }); res.end(page);
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const pageUrl = `http://localhost:${http.address().port}/`;

// ---- run ----------------------------------------------------------------------------------------------------------
execFileSync("dotnet", ["build", join(root, "clients/dotnet/OneLobby.DataChannel.Smoke"), "-v", "quiet", "--nologo"], { stdio: "inherit" });
execFileSync("dotnet", ["build", join(root, "server/OneLobby.Server"), "-v", "quiet", "--nologo"], { stdio: "inherit" });
const smoke = ["run", "--no-build", "--project", join(root, "clients/dotnet/OneLobby.DataChannel.Smoke"), "--"];
const server = start("dotnet", ["run", "--no-build", "--project", join(root, "server/OneLobby.Server"), "--", "--listen", `:${SPORT}`], "server");
await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${SPORT}/healthz`)).ok; } catch { return false; } }, 60000, "server");

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
try {
  // (A) browser hosts, .NET joins
  {
    const tab = await (await browser.newContext()).newPage();
    await tab.goto(pageUrl);
    const code = await tab.evaluate(() => window.hostEcho());
    const peer = start("dotnet", [...smoke, "join", WS, code], "dotnet-join");
    await waitFor(() => peer.exited, 45000, ".NET joiner").catch(() => {});
    const out = peer.getOut();
    const log = await tab.evaluate(() => window.log);
    check("A browser host <- .NET joiner: reliable + fast echoed back", peer.code === 0 && /PASS/.test(out),
      `code ${code}; .NET: ${out.trim().split(/\r?\n/).filter((l) => /ready|PASS|FAIL/.test(l)).join(" | ")}; browser saw: ${log.join(" | ")}`);
    await tab.context().close();
  }
  // (B) .NET hosts, browser joins
  {
    const peer = start("dotnet", [...smoke, "host", WS], "dotnet-host");
    const code = await waitFor(() => /code (\w+)/.exec(peer.getOut())?.[1], 30000, ".NET host code");
    const tab = await (await browser.newContext()).newPage();
    await tab.goto(pageUrl);
    const got = await tab.evaluate((c) => window.joinProbe(c), code).catch((e) => ({ error: String(e) }));
    await waitFor(() => peer.exited, 15000, ".NET host exit").catch(() => {});
    const out = peer.getOut();
    check("B .NET host <- browser joiner: reliable + fast echoed back", got.reliable === true && got.fast === true && /PASS/.test(out),
      `code ${code}; browser: ${JSON.stringify(got)}; .NET host: ${out.trim().split(/\r?\n/).filter((l) => /got|PASS|FAIL/.test(l)).join(" | ")}`);
    await tab.context().close();
  }
} catch (e) {
  check("harness", false, String(e));
} finally {
  await browser.close();
  http.close();
  kill(server);
}
writeFileSync(join(here, "last-run-datachannel.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => r.ok === false).length;
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
