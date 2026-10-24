# Keepalive

Keepalive adds Host lobby / Join lobby to any game: players share a join code and play together over a direct
(WebRTC) connection, with voice and text chat built in. The lobby server is open source and anyone can run one, so a
game outlives whoever made it (Stop Killing Games).

## I don't code

Put multiplayer on your web game by pasting a snippet: [docs/no-code.md](docs/no-code.md).
You also need a lobby server; [deploy/EASY_SERVER.md](deploy/EASY_SERVER.md) gets you a free one in a few clicks.

## Quickstart for developers

Install `@keepalive/client` (see [its README](clients/js/packages/client/README.md)), then in a browser module:

```js
import { Keepalive } from "@keepalive/client";
const kit = new Keepalive({ gameId: "com.you.game", netVersion: "1", lobbyServer: "wss://YOUR-SERVER/ws", mode: "raw" });
const code = new URLSearchParams(location.search).get("join");   // open the page with ?join=CODE to join
const lobby = code ? await kit.join(code) : await kit.host({ name: "My game", maxPlayers: 4 });
console.log("Join code:", lobby.code);
lobby.on("message", (from, bytes) => console.log(`peer ${from}:`, new TextDecoder().decode(bytes)));
lobby.on("peerReady", (peer) => lobby.send(peer.peerId, new TextEncoder().encode("hello!")));
```

Open it in two tabs (the second with `?join=` plus the code) and each logs the other's `hello!`.
For a local server use `ws://127.0.0.1:8080/ws` ([docs/recipes/self-host.md](docs/recipes/self-host.md)).
Next: [docs/recipes/js-web.md](docs/recipes/js-web.md), [raw-mode.md](docs/recipes/raw-mode.md), or C# and Godot in
[AGENTS.md](AGENTS.md). AI coding agents: start at [AGENTS.md](AGENTS.md) or [llms.txt](llms.txt).

## Run a server

- Easy: lobby server only, free host, a few clicks: [deploy/EASY_SERVER.md](deploy/EASY_SERVER.md)
- Advanced: lobby server plus TURN relay on your own machine: [deploy/RUN_YOUR_OWN.md](deploy/RUN_YOUR_OWN.md)

Design and wire protocol: [DESIGN.md](DESIGN.md). Status: MVP in progress on branch `dev`.
