# OneLobby

OneLobby adds **Host a game** and **Join a game** buttons to your web game: players share a short code and play
together, with voice and text chat built in. Anyone can run the small server that introduces players, so your game
keeps working even if you stop running one yourself.

## I don't code

Put multiplayer on your web game by pasting a snippet: [docs/no-code.md](docs/no-code.md).
You also need a lobby server; [deploy/EASY_SERVER.md](deploy/EASY_SERVER.md) gets you a free one in a few clicks.

## Quickstart for developers

Install `onelobby` (see [its README](clients/js/packages/client/README.md)), then in a browser module:

```js
import { OneLobby } from "onelobby";
const kit = new OneLobby({ gameId: "com.you.game", netVersion: "1", lobbyServer: "wss://YOUR-SERVER/ws", mode: "raw" });
const code = new URLSearchParams(location.search).get("join");   // open the page with ?join=CODE to join
const lobby = code ? await kit.join(code) : await kit.host({ name: "My game", maxPlayers: 4 });
console.log("Join code:", lobby.code);
lobby.on("message", (from, bytes) => console.log(`peer ${from}:`, new TextDecoder().decode(bytes)));
lobby.on("peerReady", (peer) => lobby.send(peer.peerId, new TextEncoder().encode("hello!")));
```

Open it in two tabs (the second with `?join=` plus the code) and each logs the other's `hello!`.
For a local server use `ws://127.0.0.1:8080/ws` ([docs/recipes/self-host.md](docs/recipes/self-host.md)).
Next: [docs/recipes/js-web.md](docs/recipes/js-web.md), [raw-mode.md](docs/recipes/raw-mode.md), or C# with Godot, Unity or any .NET engine in
[AGENTS.md](AGENTS.md) ([Unity recipe](docs/recipes/unity.md), [.NET recipe](docs/recipes/dotnet-generic.md)). AI coding agents: start at [AGENTS.md](AGENTS.md) or [llms.txt](llms.txt).

## Run a server

- Easy: a free lobby server in a few clicks: [deploy/EASY_SERVER.md](deploy/EASY_SERVER.md)
- Advanced: lobby server plus TURN relay on your own machine: [deploy/RUN_YOUR_OWN.md](deploy/RUN_YOUR_OWN.md)

## For developers: project notes

Players' browsers connect directly (WebRTC); the lobby server only introduces them. Design and wire protocol:
[DESIGN.md](DESIGN.md). Status: early (version 0.1). Formerly Keepalive: the JS names `Keepalive` / `KeepaliveError`
and the server's `KEEPALIVE_*` environment variables still work for one version (deprecated).
