// Real-browser end to end for <keepalive-lobby> and examples/drop-in: two browser profiles host and join through the
// element (invite link from the Copy button), start, sync a shared counter, send a message; plus a friendly error.
// Self-contained: builds nothing, but starts the C# lobby server (dotnet, Release build) unless --lobby is given.
//   npm run build && node e2e/dropin.mjs [--lobby ws://localhost:8080/ws] [--browser "C:/.../msedge.exe"] [--shots dir]
import { chromium } from "playwright-core";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const dist = join(here, "../packages/client/dist");
const example = join(repo, "examples/drop-in");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; };
const exe = arg("browser", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
const shots = arg("shots", join(example, "screenshots"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); };

// ---- lobby server ----------------------------------------------------------------------------------------------
let lobby = arg("lobby", "");
let server = null;
if (!lobby) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  lobby = `ws://localhost:${port}/ws`;
  // run the built dll directly (killing `dotnet run` can orphan the server on Windows); build it if missing
  const dll = join(repo, "server/Keepalive.Server/bin/Release/net10.0/keepalive-server.dll");
  if (!existsSync(dll)) execFileSync("dotnet", ["build", join(repo, "server/Keepalive.Server"), "-c", "Release"], { stdio: "inherit" });
  server = spawn("dotnet", [dll, "--listen", `:${port}`], { stdio: "ignore" });
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(`http://localhost:${port}/healthz`)).ok) break; } catch {}
    if (Date.now() - t0 > 90000) throw new Error("lobby server did not start");
    await sleep(300);
  }
}

// ---- static site: the example page, with its server="..." pointed at our lobby ----------------------------------
const types = { ".html": "text/html", ".js": "text/javascript", ".map": "application/json" };
const site = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    let p = decodeURIComponent(url.pathname);
    if (p === "/") p = "/index.html";
    const rel = normalize(p.slice(1));
    if (rel.startsWith("..")) throw new Error("bad path");
    let body = await readFile(join(example, rel));
    if (rel === "index.html") body = Buffer.from(body.toString().replace(/server="wss:\/\/YOUR-LOBBY-SERVER[^"]*"/,`server="${lobby}"`));
    res.writeHead(200, { "content-type": types[extname(rel)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => site.listen(0, r));
const page0 = `http://localhost:${site.address().port}/`;

const browser = await chromium.launch({ executablePath: exe, headless: true });
// The page loads the element from unpkg; serve that URL from this checkout's build instead.
const profile = async (viewport) => {
  const ctx = await browser.newContext({ viewport, permissions: ["clipboard-read", "clipboard-write"] });
  await ctx.route("https://unpkg.com/@keepalive/client/dist/**", async (route) => {
    const rel = new URL(route.request().url()).pathname.replace(/^\/@keepalive\/client\/dist\//, "");
    try { route.fulfill({ status: 200, contentType: types[extname(rel)] ?? "text/plain", body: await readFile(join(dist, rel)) }); }
    catch { route.fulfill({ status: 404, body: "" }); }
  });
  return ctx;
};
const open = async (ctx, url, name) => {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log(`[${name}] pageerror`, e.message));
  p.on("console", (m) => { if (m.type() === "error") console.log(`[${name}] console.error`, m.text()); });
  await p.goto(url);
  return p;
};
const status = (p) => p.locator("keepalive-lobby #status").textContent();
const waitStatus = (p, re, ms = 20000) =>
  p.waitForFunction((src) => new RegExp(src).test(document.querySelector("keepalive-lobby").shadowRoot.getElementById("status").textContent), re.source, { timeout: ms });

try {
  await mkdir(shots, { recursive: true });
  const ctxA = await profile({ width: 900, height: 800 });
  const ctxB = await profile({ width: 390, height: 844 }); // a phone
  const A = await open(ctxA, page0, "Sam");
  await A.screenshot({ path: join(shots, "1-start.png") });
  await A.fill("keepalive-lobby #name", "Sam");
  await A.click("keepalive-lobby #host");
  await waitStatus(A, /Waiting for players/);
  check("host shows the waiting status", true, await status(A));
  const code = (await A.locator("keepalive-lobby #codeText").textContent()).replace(/\s/g, "");
  check("code shown big", /^[0-9A-Z]{6}$/.test(code), code);
  await A.click("keepalive-lobby #copyLink");
  const invite = await A.evaluate(() => navigator.clipboard.readText());
  check("copy invite link puts a join link on the clipboard", invite.replace(/-/g, "").includes(`join=${code}`), invite);
  check("copy button confirms", (await A.locator("keepalive-lobby #copyLink").textContent()) === "Link copied!");
  await A.screenshot({ path: join(shots, "2-host-waiting.png") });

  const B = await open(ctxB, invite, "Alex");
  await waitStatus(B, /invited/);
  check("invite link pre-fills the code and asks for a name", (await B.inputValue("keepalive-lobby #code")).replace(/\s/g, "") === code);
  await B.fill("keepalive-lobby #name", "Alex");
  await B.click("keepalive-lobby #join");
  await waitStatus(B, /Connected! Waiting for Sam to start/);
  check("joiner connects to the host", true, await status(B));
  await waitStatus(A, /2 players here/);
  const names = await A.locator("keepalive-lobby #players li").allTextContents();
  check("player list has both names", names.some((n) => n.startsWith("Sam")) && names.some((n) => n.startsWith("Alex")), JSON.stringify(names));
  check("start button only for the host", (await A.isVisible("keepalive-lobby #start")) && !(await B.isVisible("keepalive-lobby #start")));
  await B.screenshot({ path: join(shots, "3-joiner-phone.png") });

  await A.click("keepalive-lobby #start");
  await A.waitForSelector("#game:not([hidden])");
  await B.waitForSelector("#game:not([hidden])", { timeout: 10000 });
  check("start reaches both pages", true);

  for (let i = 0; i < 3; i++) await A.click("#click");
  for (let i = 0; i < 2; i++) await B.click("#click");
  await A.waitForFunction(() => document.querySelector("#count").textContent === "5", null, { timeout: 10000 });
  await B.waitForFunction(() => document.querySelector("#count").textContent === "5", null, { timeout: 10000 });
  check("shared counter agrees on both pages", true, "5");

  await B.click("#wave");
  await A.waitForFunction(() => document.querySelector("#news").textContent === "Alex waves at you!", null, { timeout: 10000 });
  check("message arrives with the sender's name", true);
  await A.screenshot({ path: join(shots, "4-playing.png") });

  // the joiner reloads mid-game: same seat, game still showing, count intact
  await B.reload();
  await B.waitForSelector("#game:not([hidden])", { timeout: 20000 });
  await B.waitForFunction(() => document.querySelector("#count").textContent === "5", null, { timeout: 10000 });
  await sleep(500);
  const afterReload = await A.locator("keepalive-lobby #players li").count();
  check("reload takes the same seat back", afterReload === 2, `${afterReload} players at the host`);
  await B.click("#click");
  await A.waitForFunction(() => document.querySelector("#count").textContent === "6", null, { timeout: 10000 });
  check("clicks after the reload still count", true);

  // late joiner gets the current count
  const ctxC = await profile({ width: 800, height: 700 });
  const C = await open(ctxC, invite, "Kim");
  await C.fill("keepalive-lobby #name", "Kim");
  await C.click("keepalive-lobby #join");
  await C.waitForSelector("#game:not([hidden])", { timeout: 15000 });
  await C.waitForFunction(() => document.querySelector("#count").textContent === "6", null, { timeout: 10000 });
  check("late joiner sees the game and the current count", true);

  // friendly error + retry
  const D = await open(ctxC, page0, "Lee");
  await D.fill("keepalive-lobby #name", "Lee");
  await D.fill("keepalive-lobby #code", "ZZZ ZZZ");
  await D.click("keepalive-lobby #join");
  await waitStatus(D, /couldn't find a lobby with that code/);
  check("unknown code: plain-language error with a retry button", await D.isVisible("keepalive-lobby #retry"), await status(D));
  await D.screenshot({ path: join(shots, "5-error.png") });
  await D.click("keepalive-lobby #back");
  check("back returns to the start", await D.isVisible("keepalive-lobby #host"));

  // keyboard: Tab to the host button and press Enter
  const E = await open(await profile({ width: 800, height: 700 }), page0, "Keys");
  await E.focus("keepalive-lobby #name");
  await E.keyboard.type("Keys");
  await E.keyboard.press("Tab");
  await E.keyboard.press("Enter");
  await waitStatus(E, /Waiting for players/);
  check("keyboard only: Tab + Enter hosts", true);
} catch (e) {
  console.log("FAIL exception", e);
  results.push(false);
} finally {
  await browser.close();
  site.close();
  server?.kill();
}
const ok = results.length > 0 && results.every(Boolean);
console.log(ok ? `ALL ${results.length} PASS` : "SOME FAILED");
process.exit(ok ? 0 : 1);
