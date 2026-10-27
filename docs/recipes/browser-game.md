# Recipe: a browser game hosted from Node (join link, no server)

A browser game whose authoritative server is a Node process the host runs on their own PC. That process becomes a
OneLobby **direct host**: it listens on one port, **47810** (TCP for signaling, UDP for the game), asks the router to
open it, and serves the game page on the same port. The host sends friends one link, `http://<host address>:47810/`.
The page joins the address it came from, so there is no code to type, no lobby server, nothing else to keep online.

This is the whole-game shape of [the direct-IP recipe](direct-ip.md) s.3 and s.4b. Read that recipe for join codes,
errors, the router and the firewall; this one shows how a real game wires them. Both sides use WebSocket-shaped
objects (`lobby.onConnection` on the host, `lobby.asWebSocket()` in the page), so a game that started on WebSockets
keeps its message code unchanged.

## 1. Install

```
npm install onelobby@^0.5.0
npm install --save-optional node-datachannel@^0.33.4     # WebRTC for Node (libdatachannel); the host needs it
```

```json
{
  "dependencies": { "onelobby": "^0.5.0" },
  "optionalDependencies": { "node-datachannel": "^0.33.4" }
}
```

Optional, so the game still installs (and runs single-player or same-machine) where the native module can't.

Testing an unreleased OneLobby from a clone: build it first (`npm run build` in `clients/js/packages/client`), then
`npm install <clone>/clients/js/packages/client`. Installing a folder only links it, so an unbuilt one has no `dist/`.

## 2. Shared constants

One module both sides import (the browser loads it from the host's port, Node imports it from disk):

```js
// public/net/ids.mjs
export const GAME_ID = "com.example.mygame";
// Bump when message shapes change: OneLobby refuses to put clients with different netVersions together.
export const NET_VERSION = "1";
```

## 3. Host side (Node)

```js
// host.mjs: the game server becomes a OneLobby direct host. page(path) returns { type, body } or null (404).
import { GAME_ID, NET_VERSION } from "./public/net/ids.mjs";

export async function startHost({ page, port = 47810, openPort = true, onConnection }) {
  let OneLobby, webRtcLinkFactoryFor, hostDirect, RTCPeerConnection, LIB_VERSION;
  try {
    ({ OneLobby, webRtcLinkFactoryFor, LIB_VERSION } = await import("onelobby"));
    ({ hostDirect } = await import("onelobby/direct"));
    ({ RTCPeerConnection } = await import("node-datachannel/polyfill"));
  } catch (e) {
    return { off: `direct hosting unavailable: ${e.message.split("\n")[0]}` };   // keep the game running without it
  }

  const kit = new OneLobby({
    gameId: GAME_ID, netVersion: NET_VERSION, mode: "raw", lobbyServer: "", displayName: "My Game",
    peerTimeoutMs: 12000,   // a silent joiner leaves after 12 s (off by default: then about 30 s)
    advanced: { linkFactory: webRtcLinkFactoryFor(RTCPeerConnection) },
  });
  // One lobby is the whole server (every room or match on it), so size maxPlayers like a server, not a match.
  const lobby = await hostDirect(kit, {
    port, maxPlayers: 64, name: "My Game", openPort, http: page,
    rateLimit: { messages: 60, perMs: 1000 },   // per joiner; floods are dropped before you see them
  });

  // One WebSocket-shaped connection per joiner: conn.send(text), conn.onmessage, conn.onclose, conn.peerId.
  lobby.onConnection(onConnection);

  return {
    version: LIB_VERSION,
    joinUrl: lobby.joinUrl,        // http://<public ip>:47810/, or the same-network address if the router said no
    joinCode: lobby.joinCode,      // e.g. 6B01-RGFE-P2B, for a page served from somewhere else (?dc=CODE)
    kind: lobby.joinCodeKind,      // "internet" | "same_network": tell the host which (direct-ip.md s.5)
    close() { try { lobby.leave(); } catch {} },   // closes the port, removes the router mapping
  };
}
```

A connection is what a WebSocket server hands you, so the game's server code looks the same as before:

```js
function onConnection(conn) {
  conn.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    conn.send(JSON.stringify({ type: "echo", msg }));   // the host is truth: validate, then act
  };
  conn.onclose = (e) => console.log(`player ${conn.peerId} left (${e.reason})`);
}
```

Serving the page. `page(path)` answers plain `GET`s on the port; serve fixed paths from memory, never files by path.
The page needs OneLobby's single-file browser bundle, so serve that too:

```js
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const bundlePath = createRequire(import.meta.url).resolve("onelobby").replace(/index\.js$/, "onelobby.bundle.mjs");
const files = {
  "/": { type: "text/html; charset=utf-8", body: readFileSync("public/index.html", "utf8")
           .replace("<head>", '<head><meta name="onelobby" content="here">') },
  "/onelobby.bundle.mjs": { type: "text/javascript; charset=utf-8", body: readFileSync(bundlePath) },
  "/net/ids.mjs": { type: "text/javascript; charset=utf-8", body: readFileSync("public/net/ids.mjs") },
  "/net/onelobby.mjs": { type: "text/javascript; charset=utf-8", body: readFileSync("public/net/onelobby.mjs") },
  // ...the rest of the game's files
};
const host = await startHost({ page: (path) => files[path] ?? null, onConnection });
console.log(host.off ?? `OneLobby ${host.version}. Send this link: ${host.joinUrl}`);
```

The `<meta name="onelobby">` marker lets one `index.html` work both from the host's port (join through OneLobby) and
from any other web server you already run. If the game already shares one page function between its own web server and
OneLobby, pass that same function as `page`.

**Already have a WebSocket room server?** Hand each `conn` to the code that took a WebSocket connection before.

## 4. Page side (browser)

`dial()` joins and returns `lobby.asWebSocket()`, so existing WebSocket client code runs unchanged:

```js
// public/net/onelobby.mjs
import { GAME_ID, NET_VERSION } from "./ids.mjs";

// address: location.host when the page came from the host's port, else a join code.
export async function dial(address, { OneLobby, kitOptions = {} } = {}) {
  if (!OneLobby) ({ OneLobby } = await import("/onelobby.bundle.mjs"));   // the host serves the bundle
  const kit = new OneLobby({ gameId: GAME_ID, netVersion: NET_VERSION, mode: "raw", lobbyServer: "",
    peerTimeoutMs: 12000, ...kitOptions });                                 // a silent host ends the session in 12 s
  const lobby = await kit.joinDirect(address);
  await lobby.ready;
  return lobby.asWebSocket();   // OPEN now; onclose { code: 1001, reason: "host_left" } when the host stops
}
```

Choosing the address in the page:

```js
import { dial } from "./net/onelobby.mjs";
const fromHost = document.querySelector('meta[name="onelobby"]')?.content === "here";
const code = new URLSearchParams(location.search).get("dc");
const ws = fromHost ? await dial(location.host)
         : code ? await dial(code)
         : new WebSocket(`ws://${location.host}/ws`);   // your own server, as before
```

Wrap `dial` in `try`: it rejects with a `OneLobbyError` (`direct_unreachable`, `lobby_full`, `version_mismatch`, ...;
`describeError(e)` gives a plain-language line). `onclose` codes: 1000 you closed, 1001 the host left, 4000 kicked,
1006 anything abnormal (`timeout`, `ice_failed`); `e.reason` carries the lobby's reason. On `onclose` a page can keep
redialling every few seconds so players land back in when the host restarts. No heartbeat of your own is needed: with
`peerTimeoutMs` set, OneLobby's own 2 s pings end a silent link on both sides.

The page must be plain `http`: an `https` page may not open `ws://` to an IP address.

The host only upgrades WebSockets whose `Origin` is the page it serves itself (same host and port as the request),
a loopback page, or one you list in `hostDirect(kit, { allowedOrigins: [...] })`; every other web page gets `403`, so a
site the host happens to visit cannot reach the lobby. The page this recipe serves needs no setting.

## 5. What the host needs to know

- Router: UPnP or NAT-PMP on, or TCP and UDP 47810 forwarded by hand (then start with `ONELOBBY_PUBLIC_IP=<public ip>`
  or `publicAddress`). Otherwise `joinUrl` is a same-network address and only players on the host's own network can use
  it; say so on screen (`kind`). The host keeps asking the router in the background; `lobby.on("joinCodeChanged")` fires
  when the link turns into an internet one, no restart needed.
- The page itself shows the share link from `await directJoinInfo()` (`onelobby`), not `location.href`: the host may
  have opened it at a LAN or `localhost` address.
- Windows: the network must be **Private**, and `node.exe` (or your packaged exe) allowed through the firewall on
  Private. An old Public-only answer silently blocks friends. Details: [direct-ip.md s.6](direct-ip.md#6-shipping-the-firewall).
- No host migration: when the host stops, the session ends for everyone (direct lobbies never emit `hostChanged`).
- The port also answers `GET /healthz` and loopback-only `GET /metrics` in the same format as onelobby-server; these win over
  your `http` callback. `hostDirect` prints one startup line (`OneLobby: direct host listening on TCP+UDP :<port>; ...`) to
  `console.log`; see [direct-ip.md](direct-ip.md) for `log`.

## 6. Host from the browser (no Node process)

The host can be a browser tab instead: `kit.hostNostr()` runs the same signaling hub inside the page, with no Node process
and no listening port. Friends join through public Nostr relays with the normal version 1 code
([nostr-signaling spec](../../spec/nostr-signaling.md)), so the host needs no router setup and the game page can be a
static file on any site (GitHub Pages, itch.io). The game's host-side logic (the `lobby.onConnection` code from section 3)
runs in the tab unchanged; joiners still use `kit.joinDirect(code)` and `lobby.asWebSocket()` (section 4).

```ts compile file=browser-host.ts
import { OneLobby, describeError, shareUrl } from "onelobby";

const kit = new OneLobby({ gameId: "com.you.game", netVersion: "1", lobbyServer: "", mode: "raw", displayName: "Ann" });

export async function host(show: (text: string) => void): Promise<void> {
  try {
    const lobby = await kit.hostNostr({ maxPlayers: 4 });          // resolves once a relay is up (max 10 s)
    show(`Code ${lobby.joinCode}  Link ${shareUrl(lobby.joinCode)}`);
    lobby.onConnection((conn) => {                                 // your game's host logic, as in section 3
      conn.onmessage = (e) => conn.send(`echo ${e.data}`);
    });
    lobby.on("hostHiddenChanged", (hidden) => show(hidden ? "Keep this tab visible, or players will lag." : "Hosting"));
  } catch (e) {
    show(describeError(e).message);                                // direct_unreachable: no Nostr relay reachable
  }
}

export async function join(code: string, show: (text: string) => void): Promise<WebSocket | null> {
  try {
    const lobby = await kit.joinDirect(code);
    await lobby.ready;
    const ws = lobby.asWebSocket() as unknown as WebSocket;
    ws.onmessage = (e) => show(String(e.data));
    return ws;
  } catch (e) {
    show(describeError(e).message);
    return null;
  }
}
```

A minimal static page (bundle from the CDN, no build step):

```html
<script src="https://cdn.jsdelivr.net/npm/onelobby@0.5.0/dist/onelobby.global.min.js"></script>
<button id="host">Host</button> <input id="code" placeholder="code"> <button id="join">Join</button> <pre id="out"></pre>
<script>
  const kit = new OneLobby.OneLobby({ gameId: "com.you.game", netVersion: "1", lobbyServer: "", mode: "raw" });
  const out = (t) => (document.getElementById("out").textContent = t);
  document.getElementById("host").onclick = async () => {
    try {
      const lobby = await kit.hostNostr();
      out(`Code ${lobby.joinCode}\nLink ${OneLobby.shareUrl(lobby.joinCode)}`);
      lobby.onConnection((c) => (c.onmessage = (e) => c.send("echo " + e.data)));
    } catch (e) { out(OneLobby.describeError(e).message); }
  };
  document.getElementById("join").onclick = async () => {
    const lobby = await kit.joinDirect(document.getElementById("code").value);
    await lobby.ready;
    const ws = lobby.asWebSocket();
    ws.onmessage = (e) => out(e.data);
    ws.onopen = () => ws.send("hello");
  };
</script>
```

`hostNostr(options?)` takes `password`, `maxPlayers`, `name`, `lateJoin`, `meta`, `rateLimit` and
`nostr: { relays, stun }`, like `hostDirect` minus everything about ports (`port`, `openPort`, `publicAddress`, `http`,
`allowedOrigins`). It resolves with a normal host `Lobby` whose `joinCode` is the version 1 code, `joinCodeKind` is
`"nostr"` and `directCode` is `""` (kind `"none"`). With `OneLobby.fromConfig(...)` the `lobby.*`, `session.rateLimit` and
`hosting.nostrRelays` keys apply as in `host()`; `hosting.nostr: false` makes `hostNostr()` reject with `nostr_disabled`
(a browser host has no other way to be reached). With no relay answering within 10 s it rejects with `direct_unreachable`
("no Nostr relay reachable"): there is no IP fallback. It prints one startup line (to `console.log`, or `log`):
`OneLobby: browser host (no port); code <v1 code> (Nostr); nostr <connected>/<total> relays`.

Caveats:

- **Keep the host tab visible.** Browsers slow the timers of hidden tabs to about once a second, and after 5 minutes hidden
  to about once a minute, so the hub's keep-alive and your game loop stall and players drop. The lobby tracks it:
  `lobby.hostHidden` and the `hostHiddenChanged` event (plus a `console.warn`); show a "keep this tab open" banner. There is
  no workaround in the library on purpose. Closing the tab ends the session for everyone, like a Node host exiting.
- **No UPnP.** The tab cannot open a router port, so links rely on STUN hole punching. Most home networks work; a pair where
  both sides are behind strict (symmetric or carrier-grade) NAT fails with `ice_failed` for that joiner. Those games need
  a Node or native host with a forwarded port (sections 3 and 5) or a TURN relay.
- An `https` page may only connect to `wss://` relays; the default relays all are. A test relay on `ws://127.0.0.1` needs
  an `http://127.0.0.1` page (`clients/js/e2e/browser-host.mjs` does exactly that).

## Done when

1. `node host.mjs` prints `Send this link: http://...:47810/` (or the `off` reason, and the game still runs).
2. Opening the link in a browser on the same machine or network loads the game, `dial(location.host)` resolves, and the
   host's `conn.onmessage` sees the page's first message.
3. Stopping the host fires the page's `onclose` with code 1001 and reason `"host_left"`.
4. From another network (a phone on mobile data is enough) the same link joins when `kind` is `"internet"`.
5. A page opened from `http://127.0.0.1` calls `kit.hostNostr()` and shows a code; a second browser or Node process joins it with
   `kit.joinDirect(code)` and its `asWebSocket()` messages reach the tab's `conn.onmessage` (`clients/js/e2e/browser-host.mjs`).
