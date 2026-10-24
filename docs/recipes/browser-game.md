# Recipe: a browser game hosted from Node (join link, no server)

A browser game whose authoritative server is a Node process the host runs on their own PC. That process becomes a
OneLobby **direct host**: it listens on one port, **47810** (TCP for signaling, UDP for the game), asks the router to
open it, and serves the game page on the same port. The host sends friends one link, `http://<host address>:47810/`.
The page joins the address it came from, so there is no code to type, no lobby server, nothing else to keep online.

This is the whole-game shape of [the direct-IP recipe](direct-ip.md) s.3 and s.4b: two small files of glue, one per
side. Read that recipe for join codes, errors, the router and the firewall; this one shows how a real game wires them.

## 1. Install

```
npm install onelobby@^0.1.0
npm install --save-optional node-datachannel@^0.33.4     # WebRTC for Node (libdatachannel); the host needs it
```

```json
{
  "dependencies": { "onelobby": "^0.1.0" },
  "optionalDependencies": { "node-datachannel": "^0.33.4" }
}
```

Optional, so the game still installs (and runs single-player or same-machine) where the native module can't.

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

const HB_MS = 5000;   // heartbeat; the page treats 12 s of silence as a dead connection
const enc = new TextEncoder();
const dec = new TextDecoder();

export async function startHost({ page, port = 47810, openPort = true, onMessage, onLeft }) {
  let OneLobby, webRtcLinkFactoryFor, hostDirect, RTCPeerConnection;
  try {
    ({ OneLobby, webRtcLinkFactoryFor } = await import("onelobby"));
    ({ hostDirect } = await import("onelobby/direct"));
    ({ RTCPeerConnection } = await import("node-datachannel/polyfill"));
  } catch (e) {
    return { off: `direct hosting unavailable: ${e.message.split("\n")[0]}` };   // keep the game running without it
  }

  const kit = new OneLobby({
    gameId: GAME_ID, netVersion: NET_VERSION, mode: "raw", lobbyServer: "", displayName: "My Game",
    advanced: { linkFactory: webRtcLinkFactoryFor(RTCPeerConnection) },
  });
  // One lobby is the whole server (every room or match on it), so size maxPlayers like a server, not a match.
  const lobby = await hostDirect(kit, { port, maxPlayers: 64, name: "My Game", openPort, http: page });

  const peers = new Map();   // peerId -> { allow }
  lobby.on("message", (from, bytes) => {
    let p = peers.get(from);
    if (!p) peers.set(from, (p = { allow: rateLimiter(60, 1000) }));
    if (!p.allow()) return;                                  // drop floods before parsing
    let msg;
    try { msg = JSON.parse(dec.decode(bytes)); } catch { return; }
    onMessage(from, msg, (reply) => lobby.send(from, enc.encode(JSON.stringify(reply))));   // host is truth: validate
  });
  lobby.on("peerLeft", (peer) => { peers.delete(peer.peerId); onLeft(peer.peerId); });

  const hb = enc.encode(JSON.stringify({ type: "hb" }));
  const timer = setInterval(() => { for (const id of peers.keys()) lobby.send(id, hb); }, HB_MS);

  return {
    joinUrl: lobby.joinUrl,        // http://<public ip>:47810/, or the same-network address if the router said no
    joinCode: lobby.joinCode,      // e.g. 6B01-RGFE-P2B, for a page served from somewhere else (?dc=CODE)
    kind: lobby.joinCodeKind,      // "internet" | "same_network": tell the host which (direct-ip.md s.5)
    broadcast: (msg) => lobby.broadcast(enc.encode(JSON.stringify(msg))),
    close() { clearInterval(timer); try { lobby.leave(); } catch {} },   // closes the port, removes the router mapping
  };
}

function rateLimiter(max, perMs) {
  let n = 0, t0 = Date.now();
  return () => { const now = Date.now(); if (now - t0 > perMs) { n = 0; t0 = now; } return ++n <= max; };
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
const host = await startHost({ page: (path) => files[path] ?? null, onMessage, onLeft });
console.log(host.off ?? `Send this link: ${host.joinUrl}`);
```

The `<meta name="onelobby">` marker lets one `index.html` work both from the host's port (join through OneLobby) and
from any other web server you already run. If the game already shares one page function between its own web server and
OneLobby, pass that same function as `page`.

**Already have a WebSocket room server?** Keep it: in the `message` handler, wrap each OneLobby peer as one more
connection object (`send` = `lobby.send(from, ...)`) and hand it to your existing room code; close it on `peerLeft`.

## 4. Page side (browser)

`dial()` joins and returns a WebSocket-shaped object, so existing WebSocket client code runs unchanged:

```js
// public/net/onelobby.mjs
import { GAME_ID, NET_VERSION } from "./ids.mjs";
const enc = new TextEncoder();
const dec = new TextDecoder();

// address: location.host when the page came from the host's port, else a join code.
export async function dial(address, { OneLobby, kitOptions = {} } = {}) {
  if (!OneLobby) ({ OneLobby } = await import("/onelobby.bundle.mjs"));   // the host serves the bundle
  const kit = new OneLobby({ gameId: GAME_ID, netVersion: NET_VERSION, mode: "raw", lobbyServer: "", ...kitOptions });
  const lobby = await kit.joinDirect(address);
  await lobby.ready;                                                        // sends arrive from here on

  const socket = {
    readyState: 1, onopen: null, onmessage: null, onclose: null,
    send: (s) => { if (socket.readyState === 1) lobby.send(lobby.hostPeerId, enc.encode(s)); },
    close: (code = 1000, reason = "left") => { gone(code, reason); try { lobby.leave(); } catch {} },
  };
  function gone(code, reason) {
    if (socket.readyState === 3) return;
    socket.readyState = 3;
    socket.onclose?.({ code, reason });
  }
  lobby.on("message", (_from, bytes) => { if (socket.readyState === 1) socket.onmessage?.({ data: dec.decode(bytes) }); });
  // Direct hosts have no host migration: when the host goes, the session is over.
  lobby.on("hostChanged", () => gone(4001, "The host left."));
  lobby.on("sessionEnded", (r) => gone(4001, r === "host_left" ? "The host closed the game." : `Session ended (${r}).`));
  return socket;
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
`describeError(e)` gives a plain-language line). On `onclose`, a page can keep redialling every few seconds so players
land back in when the host restarts. Treat 12 s without a message (the 5 s heartbeat) as a dead link.

The page must be plain `http`: an `https` page may not open `ws://` to an IP address.

## 5. What the host needs to know

- Router: UPnP or NAT-PMP on, or TCP and UDP 47810 forwarded by hand. Otherwise `joinUrl` is a same-network address
  and only players on the host's own network can use it; say so on screen (`kind`).
- Windows: the network must be **Private**, and `node.exe` (or your packaged exe) allowed through the firewall on
  Private. An old Public-only answer silently blocks friends. Details: [direct-ip.md s.6](direct-ip.md#6-shipping-the-firewall).
- No host migration: when the host stops, the session ends for everyone.

## Done when

1. `node host.mjs` prints `Send this link: http://...:47810/` (or the `off` reason, and the game still runs).
2. Opening the link in a browser on the same machine or network loads the game, `dial(location.host)` resolves, and the
   host's `onMessage` sees the page's first message; the page sees a heartbeat within 5 s.
3. Stopping the host fires the page's `onclose` with "The host closed the game."
4. From another network (a phone on mobile data is enough) the same link joins when `kind` is `"internet"`.
