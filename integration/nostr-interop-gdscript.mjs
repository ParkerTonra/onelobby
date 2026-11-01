// Nostr signaling interop, GDScript <-> JS, both host directions (spec/nostr-signaling.md). Real processes, real WebRTC
// on loopback, real Nostr frames; only the relay differs by mode. The GDScript side is clients/gdscript/tests/direct_interop.gd
// (headless Godot with webrtc-native), the JS side is integration/nostr-interop-peer.mjs.
//   cd clients/js && npm ci && npm run build        # once: the built client the JS peer imports
//   cd conformance && npm install                   # once: `ws` for the local relay
//   GODOT=/path/to/godot node integration/nostr-interop-gdscript.mjs            # local relay, no internet
//   GODOT=/path/to/godot node integration/nostr-interop-gdscript.mjs --real     # the library's default public relays + STUN
// Checks: (A) JS host <- GDScript joiner  (B) GDScript host <- JS joiner: join by the Nostr (version 1) code, data channels
// open, reliable + fast message each way (the joiner sends, the host echoes). Exit 0 when both pass.
import { spawn, execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startRelay } from "./nostr-test-relay.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const real = process.argv.includes("--real");
const godot = process.env.GODOT;
if (!godot) {
  console.error("set GODOT to a Godot 4.4+ executable");
  process.exit(2);
}
const PORT_JS = 47841;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, evidence = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}  ${evidence}`);
};
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
const summary = (out, re) => out.trim().split(/\r?\n/).filter((l) => re.test(l)).join(" | ");

const relay = real ? null : await startRelay();
console.log(real ? "mode: real public relays + default STUN" : `mode: local relay ${relay.url}`);
const jsPeer = join(here, "nostr-interop-peer.mjs");
const project = join(root, "clients/gdscript");
const gd = (...a) => start(godot, ["--headless", "--audio-driver", "Dummy", "--path", project, "-s", "res://tests/direct_interop.gd", "--", ...a], "gd");
const relayJs = relay ? ["--relays", relay.url, "--stun", "none"] : [];
const relayGd = relay ? [`--relay=${relay.url}`, "--stun=none"] : [];

try {
  // (A) JS host, GDScript joiner
  {
    const host = start("node", [jsPeer, "host", "--port", String(PORT_JS), ...relayJs], "js-host");
    try {
      const m = await waitFor(() => /join code (\S+) \((\w+)\)/.exec(host.getOut()), 40000, "JS host code");
      const [, code, kind] = m;
      if (kind !== "nostr") throw new Error(`JS host code kind is ${kind}, not nostr`);
      const peer = gd("--role=join", `--code=${code}`, ...relayGd);
      await waitFor(() => peer.exited, 70000, "GDScript joiner");
      await waitFor(() => host.exited, 15000, "JS host exit").catch(() => {});
      check("A JS host <- GDScript joiner over Nostr: reliable + fast echoed back", peer.code === 0 && /PASS/.test(peer.getOut()) && host.code === 0,
        `code ${code}; GDScript joiner: ${summary(peer.getOut(), /ready|got|PASS|FAIL/)}; JS host: ${summary(host.getOut(), /got|PASS|FAIL/)}`);
    } catch (e) {
      check("A JS host <- GDScript joiner over Nostr", false, `${e.message}; JS host: ${summary(host.getOut(), /./)}`);
    } finally {
      kill(host);
    }
  }
  // (B) GDScript host, JS joiner
  {
    const host = gd("--role=host", ...relayGd);
    try {
      const m = await waitFor(() => /join code (\S+) \((\w+)\)/.exec(host.getOut()), 60000, "GDScript host code");
      const [, code] = m;
      const peer = start("node", [jsPeer, "join", code, ...relayJs], "js-join");
      await waitFor(() => peer.exited, 70000, "JS joiner");
      await waitFor(() => host.exited, 15000, "GDScript host exit").catch(() => {});
      check("B GDScript host <- JS joiner over Nostr: reliable + fast echoed back", peer.code === 0 && /PASS/.test(peer.getOut()) && host.code === 0,
        `code ${code}; JS joiner: ${summary(peer.getOut(), /ready|PASS|FAIL/)}; GDScript host: ${summary(host.getOut(), /got|PASS|FAIL|join code/)}`);
    } catch (e) {
      check("B GDScript host <- JS joiner over Nostr", false, `${e.message}; GDScript host: ${summary(host.getOut(), /./)}`);
    } finally {
      kill(host);
    }
  }
} finally {
  if (relay) {
    console.log(`relay saw ${relay.stats.events} events over ${relay.stats.connections} connections`);
    await relay.close();
  }
}
process.exit(results.every((r) => r.ok) && results.length === 2 ? 0 : 1);
