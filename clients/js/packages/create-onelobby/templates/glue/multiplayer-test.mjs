// Two players, a message each way, and (lockstep) frames advancing. `npm test` runs it.
//   no LOBBY_SERVER:  in-memory path (onelobby/testing doubles): no server, no browser, no network.
//   LOBBY_SERVER=ws://127.0.0.1:8080/ws npm test:  real path, two headless browsers against that server.
// It prints which path ran. Written by create-onelobby; yours to edit.
import { readFileSync } from "node:fs";
import { ManualClock, MemoryNetwork, MemoryServer } from "onelobby/testing";
//#if project
import { Gridpaint as Game, paintCmd } from "../src/game.js";
import { bindSession, features, makeKit } from "../src/session.js";
//#endif
//#if into
import { bindSession, features, makeKit } from "../multiplayer/session.js";
//#endif

const bp = JSON.parse(readFileSync(new URL("../onelobby.json", import.meta.url), "utf8"));
//#if into
// A stand-in game so this test runs before your own game is wired in. Swap in yours: step, snapshot, restore, hash.
class Game {
  constructor() {
    this.tick = 0;
    this.sum = 0n;
  }
  step(tick, cmds = []) {
    if (tick !== this.tick + 1) throw new Error(`expected tick ${this.tick + 1}, got ${tick}`);
    for (const c of cmds) this.sum = (this.sum * 31n + BigInt(c.peerId * 1000 + c.bytes[1])) & 0xffffffffffffffffn;
    this.tick = tick;
    return this.hash();
  }
  hash() {
    return this.sum;
  }
  snapshot() {
    const o = new Uint8Array(8);
    new DataView(o.buffer).setBigUint64(0, this.sum, true);
    return o;
  }
  restore(tick, bytes) {
    this.tick = tick;
    this.sum = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
  }
}
const paintCmd = (x) => Uint8Array.of(1, x);
//#endif

let failures = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " " + extra : ""}`);
};

async function inMemory() {
  console.log("path: in-memory (onelobby/testing doubles; set LOBBY_SERVER to run against a real server)");
  const clock = new ManualClock();
  const srv = new MemoryServer();
  const net = new MemoryNetwork();
  const make = (name) =>
    makeKit(bp, {
      displayName: name,
      lobbyServer: "mem://server",
      advanced: { socketFactory: srv.socketFactory, linkFactory: net.factoryFor(name), clock, wallClock: () => 1_700_000_000_000 + clock.now(), storage: null },
    });
  const sessions = [];
  const play = async (ms) => {
    for (let left = ms; left > 0; left -= 25) {
      clock.advance(25);
      await clock.run(0);
      for (const s of sessions) s.pump(clock.now());
    }
  };

  const ann = make("Ann");
  const bob = make("Bob");
  check("file loads through OneLobby.fromConfig", ann.blueprint.game.id === bp.game.id, ann.blueprint.game.id);
  const a = await ann.host();
  const joining = bob.join(a.code);
  await clock.run(1000);
  const b = await joining;
  await b.ready;
  await clock.run(500);
  check("two players in the lobby", a.peers.length === 2 && b.peers.length === 2, `peers ${a.peers.length}/${b.peers.length}`);

  // a message each way (game-owned bytes: tag 0xf0 is ignored by the session glue)
  const got = { a: [], b: [] };
  a.on("message", (from, bytes) => bytes[0] === 0xf0 && got.a.push([from, bytes[1]]));
  b.on("message", (from, bytes) => bytes[0] === 0xf0 && got.b.push([from, bytes[1]]));
  a.send(b.localPeerId, Uint8Array.of(0xf0, 7));
  b.send(a.localPeerId, Uint8Array.of(0xf0, 9));
  await clock.run(500);
  check("message host -> joiner", got.b.length === 1 && got.b[0][0] === a.localPeerId && got.b[0][1] === 7);
  check("message joiner -> host", got.a.length === 1 && got.a[0][0] === b.localPeerId && got.a[0][1] === 9);

  const f = features(ann.blueprint);
  if (f.chat) {
    const lines = [];
    b.chat.on("message", (m) => lines.push(m.text));
    a.chat.send("hello");
    await clock.run(500);
    check("text chat (chat.text is on)", lines.includes("hello"));
  } else {
    let err = "";
    try {
      a.chat.send("hello");
    } catch (e) {
      err = e.code;
    }
    check("text chat refused (chat.text is off)", err === "chat_disabled", err);
  }
  if (!f.voice) {
    let err = "";
    try {
      a.voice.enabled = true;
    } catch (e) {
      err = e.code;
    }
    check("voice refused (chat.voice is off)", err === "voice_disabled", err);
  }

  // the game: bind before start, then play
  const ga = new Game(a.code);
  const gb = new Game(b.code);
  const initial = ga.hash();
  const sa = bindSession(a, ann.blueprint, ga);
  const sb = bindSession(b, bob.blueprint, gb);
  sessions.push(sa, sb);
  await a.start();
  await play(1000);
  sa.send(paintCmd(1, 1));
  sb.send(paintCmd(2, 3));
  await play(2000);
  const mode = ann.blueprint.sync.mode;
  check(`${mode}: frames advance`, sa.frames > 10 && sb.frames > 10 && ga.tick > 10 && gb.tick > 10, `host tick ${ga.tick}, joiner tick ${gb.tick}`);
  // compare when both sit on the same tick (the joiner may trail the host by one in flight)
  let same = ga.tick === gb.tick;
  for (let i = 0; i < 40 && !same; i++) {
    await play(25);
    same = ga.tick === gb.tick;
  }
  check(`${mode}: both players see the same state`, same && ga.hash() === gb.hash(), `tick ${ga.tick}`);
  check(`${mode}: commands from both players were applied`, ga.hash() !== initial);
  if (mode === "lockstep") check("lockstep: no desync", sa.desyncs === 0 && sb.desyncs === 0);

  //#if project
  await runtimeFileCheck();
  //#endif
  await b.leave();
  await a.leave();
}

//#if project
// Editing onelobby.json by hand must change the controls with no rebuild: the dev server serves the file fresh and the
// page reads it at runtime (src/session.js loadBlueprint -> kit.blueprint -> features).
async function runtimeFileCheck() {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { startServer } = await import("../scripts/serve.mjs");
  const { loadBlueprint } = await import("../src/session.js");
  const root = mkdtempSync(join(tmpdir(), "onelobby-test-"));
  const web = await startServer({ port: 0, root });
  try {
    const voiceShown = async () => features(makeKit(await loadBlueprint(web.url + "onelobby.json")).blueprint).voice;
    writeFileSync(join(root, "onelobby.json"), JSON.stringify({ ...bp, chat: { ...bp.chat, voice: true } }));
    const on = await voiceShown();
    writeFileSync(join(root, "onelobby.json"), JSON.stringify({ ...bp, chat: { ...bp.chat, voice: false } }));
    const off = await voiceShown();
    check("editing chat.voice by hand toggles the voice control, no rebuild", on === true && off === false);
  } finally {
    web.server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function realServer(lobbyServer) {
  console.log(`path: real server ${lobbyServer} with two headless browsers`);
  const { existsSync } = await import("node:fs");
  const { chromium } = await import("playwright-core");
  const { startServer } = await import("../scripts/serve.mjs");
  const exe = [
    process.env.BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/microsoft-edge",
  ].find((p) => p && existsSync(p));
  if (!exe) throw new Error("no Edge or Chrome found: set BROWSER=/path/to/browser");
  const web = await startServer({ port: 0 });
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    const url = web.url + "?lobby=" + encodeURIComponent(lobbyServer);
    const player = async (name) => {
      const page = await (await browser.newContext()).newPage();
      page.on("pageerror", (e) => console.error(`[${name}] pageerror`, e.message));
      await page.goto(url);
      await page.waitForFunction(() => document.getElementById("net-status").textContent !== "" || !document.getElementById("net").hidden);
      if (await page.locator("#name").isVisible()) await page.fill("#name", name);
      return page;
    };
    const statusHas = (page, re) => page.waitForFunction((s) => new RegExp(s).test(document.getElementById("status").textContent), re, { timeout: 20000 });
    const host = await player("Ann");
    const joiner = await player("Bob");
    await host.click("#host");
    await host.waitForFunction(() => /Lobby code/.test(document.getElementById("net-status").textContent), null, { timeout: 20000 });
    const code = (await host.textContent("#net-status")).match(/Lobby code: ([A-Z0-9 ]+?)(\s{2}|$)/)[1].replace(/\s/g, "");
    await joiner.fill("#code", code);
    await joiner.click("#join");
    await statusHas(host, "players 2");
    check("two players in the lobby (real server)", true, `code ${code}`);
    const f = features(makeKit(bp).blueprint);
    check("voice control matches chat.voice", (await host.locator("#voice").isVisible()) === f.voice);
    check("chat panel matches chat.text", (await host.locator("#chat").isVisible()) === f.chat);
    if (f.chat) {
      await host.fill("#chat-input", "hello from Ann");
      await host.press("#chat-input", "Enter");
      await joiner.waitForFunction(() => /hello from Ann/.test(document.getElementById("chat-log").textContent), null, { timeout: 20000 });
      check("message host -> joiner (chat)", true);
      await joiner.fill("#chat-input", "hello from Bob");
      await joiner.press("#chat-input", "Enter");
      await host.waitForFunction(() => /hello from Bob/.test(document.getElementById("chat-log").textContent), null, { timeout: 20000 });
      check("message joiner -> host (chat)", true);
    }
    await host.click("#start");
    await statusHas(joiner, "tick [1-9][0-9]");
    await host.locator("#grid").click({ position: { x: 40, y: 40 } });
    await joiner.locator("#grid").click({ position: { x: 200, y: 120 } });
    await new Promise((r) => setTimeout(r, 2000));
    const trail = (p) => p.evaluate(() => globalThis.onelobbyDebug.trail());
    const [ta, tb] = [new Map(await trail(host)), new Map(await trail(joiner))];
    const common = [...ta.keys()].filter((t) => tb.has(t));
    check("frames advance and both players share state", common.length > 5 && common.every((t) => ta.get(t) === tb.get(t)), `${common.length} common ticks`);
  } finally {
    await browser.close();
    web.server.close();
  }
}
//#endif

const server = process.env.LOBBY_SERVER;
//#if project
if (server) await realServer(server);
else await inMemory();
//#endif
//#if into
if (server) console.log("LOBBY_SERVER is set, but the real-server path drives the generated page, which --into does not write; running in-memory.");
await inMemory();
//#endif
console.log(failures ? `${failures} check(s) failed` : "ok");
process.exit(failures ? 1 : 0);
