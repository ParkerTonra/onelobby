// A real browser tab hosts with kit.hostNostr(); a Node joiner joins it through a local test relay.
// Needs a build (npm run build), node-datachannel, playwright-core and Edge/Chrome. Usage:
//   node e2e/browser-host.mjs [--browser "C:/.../msedge.exe"]
// Everything stays on 127.0.0.1 (test relay, static page, WebRTC); nothing goes to the internet.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { OneLobby, webRtcLinkFactoryFor } from "../packages/client/dist/index.js";
import { startRelay } from "../../../integration/nostr-test-relay.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; };
const exe = arg("browser", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
const bundle = readFileSync(join(here, "../packages/client/dist/onelobby.global.js"));
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); };

const relay = await startRelay();
const page = (relayUrl) => `<!doctype html><meta charset="utf-8"><title>host</title><body><pre id="out"></pre>
<script src="/onelobby.js"></script>
<script>
  const kit = new OneLobby.OneLobby({ gameId: "com.onelobby.browserhost", netVersion: "1", lobbyServer: "", mode: "raw", displayName: "Tab", rememberSeat: false });
  window.run = async () => {
    const lobby = await kit.hostNostr({ nostr: { relays: [${JSON.stringify(relayUrl)}], stun: [] }, maxPlayers: 3 });
    window.lobby = lobby;
    window.got = [];
    lobby.onConnection((c) => { c.onmessage = (e) => { window.got.push(String(e.data)); c.send("echo " + e.data); }; });
    return { code: lobby.joinCode, kind: lobby.joinCodeKind, line: lobby.directHostLog, hidden: lobby.hostHidden };
  };
</script>`;
const web = createServer((req, res) => {
  if (req.url === "/onelobby.js") res.writeHead(200, { "content-type": "text/javascript" }).end(bundle);
  else res.writeHead(200, { "content-type": "text/html" }).end(page(relay.url));
});
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${web.address().port}/`;

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  // keep host candidates as plain IPs (no mDNS names) so a Node peer can reach the tab on loopback
  args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
});
let failed = true;
try {
  const p = await (await browser.newContext()).newPage();
  p.on("pageerror", (e) => console.log("pageerror", e.message));
  await p.goto(origin);
  const host = await p.evaluate(() => window.run());
  console.log("host line:", host.line);
  check("tab hosts with a Nostr code", host.kind === "nostr" && /^[0-9A-Z-]+$/i.test(host.code), host.code);
  check("startup line", host.line.startsWith("OneLobby: browser host (no port); code ") && /nostr 1\/1 relays$/.test(host.line));

  const links = webRtcLinkFactoryFor(RTCPeerConnection);
  const kit = new OneLobby({ gameId: "com.onelobby.browserhost", netVersion: "1", lobbyServer: "", mode: "raw", displayName: "Node", rememberSeat: false, advanced: { linkFactory: links } });
  const lobby = await kit.joinDirect(host.code, { nostrRelays: [relay.url], stun: [] });
  await lobby.ready;
  check("Node joiner links to the tab", lobby.peers.length === 2);
  const ws = lobby.asWebSocket();
  const replies = [];
  ws.onmessage = (e) => replies.push(String(e.data));
  await new Promise((r) => (ws.onopen = r));
  ws.send("hello tab");
  for (let i = 0; i < 100 && replies.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  check("host-side onConnection logic runs in the tab", replies[0] === "echo hello tab", JSON.stringify(replies));
  check("tab saw the message", (await p.evaluate(() => window.got)).includes("hello tab"));
  await lobby.leave();
  await p.evaluate(() => window.lobby.leave());
  failed = results.some((x) => !x);
} catch (e) {
  console.log("ERROR", e);
} finally {
  await browser.close();
  web.close();
  await relay.close();
}
process.exit(failed ? 1 : 0);
