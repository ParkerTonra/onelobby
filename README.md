# OneLobby

**Multiplayer that outlives its servers.** Players host and join with a short code, peer to peer. There is no backend
you have to keep paying for, so when you stop running servers (or never start), your game's multiplayer keeps working.
Free, open source (MIT), with voice and text chat built in.

- **No server at all:** a .NET, Unity or Node game hosts straight from the player's PC and shows a join code
  (`6B01-RGFE-P2B`); friends paste it and play, like Terraria's "Host & Play".
- **Or a server anyone can run:** web games use a tiny lobby server that only introduces players. Its address is a
  setting, so players or a community can run their own long after you've moved on.
- **The game data never touches a server:** peers talk over WebRTC data channels.

Engines: browser JS, Godot 4 (C#), Unity 6 (desktop and mobile), any .NET app, Node.

## Status

Early software (0.x): the API can still change between minor versions. Work goes where a shipping game needs it.

- **Maintained:** the C# core in raw mode, `OneLobby.DataChannel`, the Unity package, `OneLobby.Replication` and the
  lobby server. Bugs here get fixed and features still land.
- **Frozen:** the JS client (`onelobby` on npm), the Godot glue, lockstep mode and voice. They work and keep their
  tests, but get no new features until a second game needs them. Bug reports are still welcome.

## Using an AI coding agent?

Tell it:

> Read https://github.com/ParkerTonra/onelobby/blob/main/AGENTS.md and add host/join multiplayer to my game.

[AGENTS.md](AGENTS.md) is the whole API on one page plus a copy-paste recipe for each engine, and every recipe ends with
a "Done when" check the agent can run. Doc tools can read [llms.txt](llms.txt).

## Pick your path

| You have | Start here |
| --- | --- |
| A Unity game | [Unity recipe](docs/recipes/unity.md) (host by IP: [direct-ip.md](docs/recipes/direct-ip.md)) |
| A Godot 4 C# game | [Godot recipe](docs/recipes/godot-csharp.md) (Godot hosting by IP comes later) |
| A browser game | [JS recipe](docs/recipes/js-web.md), or the quickstart below |
| A browser game with a Node server on the host's PC | [browser-game.md](docs/recipes/browser-game.md) |
| Any other .NET app (MonoGame, console, bots) | [.NET recipe](docs/recipes/dotnet-generic.md) |
| A real-time action game (shooter, physics) | [Replication recipe](docs/recipes/replication.md): snapshots, interpolation, prediction |
| No code, just a web game | Paste a snippet: [no-code.md](docs/no-code.md) |

## Quickstart (browser)

`npm install onelobby` (or a `<script>` tag, see [its README](clients/js/packages/client/README.md)), then in a module:

```js
import { OneLobby } from "onelobby";
const kit = new OneLobby({ gameId: "com.you.game", netVersion: "1", lobbyServer: "wss://YOUR-SERVER/ws", mode: "raw" });
const code = new URLSearchParams(location.search).get("join");   // open the page with ?join=CODE to join
const lobby = code ? await kit.join(code) : await kit.host({ name: "My game", maxPlayers: 4 });
console.log("Join code:", lobby.code);
lobby.on("message", (from, bytes) => console.log(`peer ${from}:`, new TextDecoder().decode(bytes)));
lobby.on("peerReady", (peer) => lobby.send(peer.peerId, new TextEncoder().encode("hello!")));
```

Open it in two tabs (the second with `?join=` plus the code) and each logs the other's `hello!`. `YOUR-SERVER` is a
lobby server: run one locally and use `ws://127.0.0.1:8080/ws` ([self-host.md](docs/recipes/self-host.md)), or get a
free one in a few clicks ([deploy/EASY_SERVER.md](deploy/EASY_SERVER.md)).

## Run a lobby server

- Easy: a free lobby server in a few clicks: [deploy/EASY_SERVER.md](deploy/EASY_SERVER.md)
- Advanced: lobby server plus TURN relay on your own machine: [deploy/RUN_YOUR_OWN.md](deploy/RUN_YOUR_OWN.md)

## Project notes

Status: early (0.4). Design and wire protocol: [DESIGN.md](DESIGN.md) and [spec/](spec/). Generated API reference:
[docs/api/](docs/api/). Formerly Keepalive: the JS names `Keepalive` / `KeepaliveError` and the server's `KEEPALIVE_*`
environment variables still work but are deprecated.
