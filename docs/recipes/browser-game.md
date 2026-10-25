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
npm install onelobby@^0.4.0
npm install --save-optional node-datachannel@^0.33.4     # WebRTC for Node (libdatachannel); the host needs it
```

```json
{
  "dependencies": { "onelobby": "^0.4.0" },
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

- Router: UPnP or NAT-PMP on, or TCP and UDP 47810 forwarded by hand. Otherwise `joinUrl` is a same-network address
  and only players on the host's own network can use it; say so on screen (`kind`).
- Windows: the network must be **Private**, and `node.exe` (or your packaged exe) allowed through the firewall on
  Private. An old Public-only answer silently blocks friends. Details: [direct-ip.md s.6](direct-ip.md#6-shipping-the-firewall).
- No host migration: when the host stops, the session ends for everyone (direct lobbies never emit `hostChanged`).

## Done when

1. `node host.mjs` prints `Send this link: http://...:47810/` (or the `off` reason, and the game still runs).
2. Opening the link in a browser on the same machine or network loads the game, `dial(location.host)` resolves, and the
   host's `conn.onmessage` sees the page's first message.
3. Stopping the host fires the page's `onclose` with code 1001 and reason `"host_left"`.
4. From another network (a phone on mobile data is enough) the same link joins when `kind` is `"internet"`.
