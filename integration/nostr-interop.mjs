// Nostr signaling interop, JS <-> C#, both host directions (spec/nostr-signaling.md). Real processes, real WebRTC on
// loopback, real Nostr frames; only the relay differs by mode.
//   cd clients/js && npm ci && npm run build        # once: the built client the JS peer imports
//   cd conformance && npm install                   # once: `ws` for the local relay
//   node integration/nostr-interop.mjs              # local relay (integration/nostr-test-relay.mjs on 127.0.0.1), no internet
//   node integration/nostr-interop.mjs --real       # the library's default public relays and STUN (anonymous random keys only)
// Checks: (A) JS host <- C# joiner  (B) C# host <- JS joiner: join by the Nostr (version 1) code, data channels open,
// reliable + fast message each way (the joiner sends, the host echoes). Exit 0 when both pass.
// The C# side is clients/dotnet/OneLobby.DataChannel.Smoke (host-direct / join-direct --nostr-relays=... --stun=...);
// it needs the native libdatachannel (clients/dotnet/OneLobby.DataChannel/native/build-windows.ps1 on Windows).
// Ports: --port-js 47831 --port-cs 47832 (the host's TCP+UDP port; the code carries no address, only the room).
import { spawn, execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startRelay } from "./nostr-test-relay.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const flag = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const real = process.argv.includes("--real");
const PORT_JS = Number(flag("port-js", 47831));
const PORT_CS = Number(flag("port-cs", 47832));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, evidence = "") => {
  results.push({ name, ok, evidence });
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
// local: the relay list is ours, and no STUN (loopback needs none); real: library defaults for both
const relayArgJs = relay ? ["--relays", relay.url, "--stun", "none"] : [];
const relayArgCs = relay ? [`--nostr-relays=${relay.url}`, "--stun=none"] : [];
console.log(real ? "mode: real public relays + default STUN" : `mode: local relay ${relay.url}`);

execFileSync("dotnet", ["build", join(root, "clients/dotnet/OneLobby.DataChannel.Smoke"), "-v", "quiet", "--nologo"], { stdio: "inherit" });
const smoke = ["run", "--no-build", "--project", join(root, "clients/dotnet/OneLobby.DataChannel.Smoke"), "--"];
const jsPeer = join(here, "nostr-interop-peer.mjs");

try {
  // (A) JS host, C# joiner
  {
    const host = start("node", [jsPeer, "host", "--port", String(PORT_JS), ...relayArgJs], "js-host");
    try {
      const m = await waitFor(() => /join code (\S+) \((\w+)\)/.exec(host.getOut()), 40000, "JS host code");
      const [, code, kind] = m;
      if (kind !== "nostr") throw new Error(`JS host code kind is ${kind}, not nostr: ${summary(host.getOut(), /join code|nostr|FAIL/)}`);
      const peer = start("dotnet", [...smoke, "join-direct", code, ...relayArgCs], "cs-join");
      await waitFor(() => peer.exited, 60000, "C# joiner");
      await waitFor(() => host.exited, 15000, "JS host exit").catch(() => {});
      check("A JS host <- C# joiner over Nostr: reliable + fast echoed back", peer.code === 0 && /PASS/.test(peer.getOut()) && host.code === 0,
        `code ${code}; C# joiner: ${summary(peer.getOut(), /ready|PASS|FAIL|session/)}; JS host: ${summary(host.getOut(), /got|PASS|FAIL|OneLobby: direct/)}`);
    } catch (e) {
      check("A JS host <- C# joiner over Nostr", false, `${e.message}; JS host: ${summary(host.getOut(), /./)}`);
    } finally {
      kill(host);
    }
  }
  // (B) C# host, JS joiner
  {
    const host = start("dotnet", [...smoke, "host-direct", String(PORT_CS), "-", "--no-upnp", "--wait=60", ...relayArgCs], "cs-host");
    try {
      const m = await waitFor(() => /join code (\S+) \((\w+)\)/.exec(host.getOut()), 40000, "C# host code");
      const [, code, kind] = m;
      if (kind !== "Nostr") throw new Error(`C# host code kind is ${kind}, not Nostr: ${summary(host.getOut(), /join code|nostr|FAIL/)}`);
      const peer = start("node", [jsPeer, "join", code, ...relayArgJs], "js-join");
      await waitFor(() => peer.exited, 60000, "JS joiner");
      await waitFor(() => host.exited, 15000, "C# host exit").catch(() => {});
      check("B C# host <- JS joiner over Nostr: reliable + fast echoed back", peer.code === 0 && /PASS/.test(peer.getOut()) && host.code === 0,
        `code ${code}; JS joiner: ${summary(peer.getOut(), /ready|PASS|FAIL/)}; C# host: ${summary(host.getOut(), /got|PASS|FAIL|join code/)}`);
    } catch (e) {
      check("B C# host <- JS joiner over Nostr", false, `${e.message}; C# host: ${summary(host.getOut(), /./)}`);
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
