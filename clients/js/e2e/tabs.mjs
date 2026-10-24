// End-to-end in a real browser: host tab, joiner tab, late-joiner tab, voice, host-close migration.
// Needs: a running keepalive-server, the demo server, and Edge/Chrome. Usage:
//   node e2e/tabs.mjs [--demo http://localhost:5173/] [--browser "C:/.../msedge.exe"]
import { chromium } from "playwright-core";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; };
const demo = arg("demo", "http://localhost:5173/");
const metricsUrl = arg("metrics", "http://localhost:8080/metrics");
const pathCount = async () => {
  const t = await (await fetch(metricsUrl)).text();
  return [...t.matchAll(/^keepalive_path_total\{path="(\w+)"\} (\d+)/gm)].reduce((a, m) => a + Number(m[2]), 0);
};
const exe = arg("browser", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); };

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ permissions: ["microphone"] });
const open = async (name) => {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log(`[${name}] pageerror`, e.message));
  p.on("console", (m) => { if (m.type() === "error") console.log(`[${name}] console.error`, m.text()); });
  await p.goto(demo);
  await p.fill("#name", name);
  return p;
};
const state = (p) => p.evaluate(() => ({ tick: window.__ka.game?.tick, status: document.getElementById("status").textContent, log: document.getElementById("log").innerText }));
const hashAt = (p, t) => p.evaluate((t) => window.__ka.hashes?.get(t)?.toString(), t);

try {
  const paths0 = await pathCount();
  const A = await open("alice");
  await A.click("#host");
  await A.waitForFunction(() => window.__ka.lobby);
  const code = await A.evaluate(() => window.__ka.lobby.code);
  const B = await open("bob");
  await B.fill("#code", code);
  await B.click("#join");
  await B.waitForFunction(() => window.__ka.lobby);
  await sleep(1500);
  await A.click("#start");
  await A.waitForFunction(() => window.__ka.game.tick > 20, null, { timeout: 15000 });
  check("host runs", true);
  await B.waitForFunction(() => window.__ka.game.tick > 20, null, { timeout: 15000 });
  check("joiner receives frames over WebRTC", true);
  // paint from both
  await A.evaluate(() => window.__ka.lobby.lockstep.submit(Uint8Array.of(1, 3, 3)));
  await B.evaluate(() => window.__ka.lobby.lockstep.submit(Uint8Array.of(1, 12, 12)));
  await sleep(10000);
  const [sa, sb] = [await state(A), await state(B)];
  const common = Math.min(sa.tick, sb.tick) - 10;
  const t = common - (common % 20);
  const [ha, hb] = [await hashAt(A, t), await hashAt(B, t)];
  check("equal hashes after 10 s", ha && ha === hb, `tick ${t} ${ha}`);
  check("status says in sync", /in sync/.test(sb.status), sb.status);

  // chat both ways
  await B.fill("#chat", "hello from bob"); await B.press("#chat", "Enter");
  await A.fill("#chat", "hi from alice"); await A.press("#chat", "Enter");
  await sleep(800);
  check("chat crosses both ways", (await state(A)).log.includes("hello from bob") && (await state(B)).log.includes("hi from alice"));

  // late joiner: snapshot + chat_history
  const C = await open("cara");
  await C.fill("#code", code);
  await C.click("#join");
  await C.waitForFunction(() => window.__ka.lobby);
  await C.waitForFunction(() => window.__ka.game.tick > 50, null, { timeout: 20000 });
  await sleep(2500);
  const sc = await state(C);
  check("late joiner restored from snapshot", /restored snapshot/.test(sc.log), "");
  check("late joiner got chat_history", sc.log.includes("hello from bob") && sc.log.includes("hi from alice"));
  const [s1, s2] = [await state(A), await state(C)];
  const t2 = Math.min(s1.tick, s2.tick) - 10; const tt = t2 - (t2 % 20);
  const [h1, h2] = [await hashAt(A, tt), await hashAt(C, tt)];
  check("late joiner hash equals host", h1 && h1 === h2, `tick ${tt}`);

  // ICE path telemetry: each WebRTC link reported direct/relayed to the server
  const paths1 = await pathCount();
  check("path reports reached keepalive_path_total", paths1 >= paths0 + 4, `${paths0} -> ${paths1}`);

  // rejoin: bob's signaling socket drops, he resumes with the token, same peerId, back in sync
  const pid = await B.evaluate(() => window.__ka.dropAndRejoin());
  check("rejoin keeps the peerId", pid === 2, `peer ${pid}`);
  await B.waitForFunction(() => window.__ka.game.tick > 20, null, { timeout: 15000 });
  await sleep(3000);
  const [r1, r2] = [await state(A), await state(B)];
  const t5 = Math.min(r1.tick, r2.tick) - 10; const t6 = t5 - (t5 % 20);
  const [rh1, rh2] = [await hashAt(A, t6), await hashAt(B, t6)];
  check("rejoined peer converges (hash equals host)", !!rh1 && rh1 === rh2, `tick ${t6}`);

  // voice: fake mic device emits a beep; bob holds V
  await B.evaluate(() => { window.__ka.lobby.voice.enabled = true; });
  await A.evaluate(() => { window.__ka.lobby.voice.enabled = true; });
  await sleep(1500);
  await B.evaluate(() => document.activeElement.blur());
  await B.keyboard.down("v");
  const heard0 = 0;
  const heard = await A.waitForFunction(() => window.__ka.speaking?.has(2), null, { timeout: 4000 }).then(() => true, () => false);
  const level = await B.evaluate(() => window.__ka.lobby.voice.inputLevel);
  await B.keyboard.up("v");
  check("mic produces input level", level > 0, `level ${level}`);
  const alog = (await state(A)).log;
  check("voice from bob heard (speaking) at alice", heard === true, alog.split(String.fromCharCode(10)).filter((l) => /voice/i.test(l)).join("|"));

  // host tab closes: bob (peer 2) must take over within 5 s
  const closedAt = Date.now();
  await A.close({ runBeforeUnload: false });
  await B.waitForFunction(() => window.__ka.lobby.isHost, null, { timeout: 8000 });
  check("host close migrates", true, `${Date.now() - closedAt} ms`);
  await C.waitForFunction(() => window.__ka.lobby.hostPeerId === 2, null, { timeout: 8000 });
  const [b1, c1] = [(await state(B)).tick, (await state(C)).tick];
  await sleep(4000);
  const [b2, c2] = [(await state(B)).tick, (await state(C)).tick];
  check("frames resume after migration", b2 > b1 + 40 && c2 > c1 + 40, `${b1}->${b2}, ${c1}->${c2}`);
  const t3 = Math.min(b2, c2) - 10; const t4 = t3 - (t3 % 20);
  check("hashes equal after migration", (await hashAt(B, t4)) === (await hashAt(C, t4)) && !!(await hashAt(B, t4)), `tick ${t4}`);
} catch (e) {
  console.log("ERROR", e.message);
  results.push(false);
} finally {
  await browser.close();
}
console.log(results.every(Boolean) ? "ALL PASS" : "SOME FAILED");
process.exit(results.every(Boolean) ? 0 : 1);
