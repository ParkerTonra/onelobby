# @keepalive/client

Multiplayer for browser games. Players host a lobby, share a six-letter code, and join each other over peer-to-peer
WebRTC. Includes lockstep sync, raw messages, text chat and voice chat. No runtime dependencies.

You need a Keepalive lobby server (the WebSocket URL, like `wss://lobby.example.com/ws`). See the
[docs](https://REPLACE-ME.example/keepalive#readme) to run one.

## Use it from a `<script>` tag (no build tools)

```html
<script src="https://cdn.jsdelivr.net/npm/@keepalive/client@0.1/dist/keepalive.global.min.js"></script>
<script>
  const kit = new Keepalive.Keepalive({
    gameId: "com.you.yourgame",            // any unique name for your game
    netVersion: "1",
    lobbyServer: "wss://lobby.example.com/ws",
    mode: "raw",
  });
  // Host:  const lobby = await kit.host({ name: "My game", maxPlayers: 4 }); show Keepalive.formatCode(lobby.code)
  // Join:  const lobby = await kit.join("C5A FX8");
</script>
```

The file also works saved next to your page (`<script src="keepalive.global.min.js">`), including pages opened from disk.

## No code at all

`<keepalive-lobby server="wss://lobby.example.com/ws" game="my-game" max-players="4"></keepalive-lobby>` after the
`<script>` tag above gives a complete lobby box. See the [no-code guide](https://REPLACE-ME.example/keepalive/blob/main/docs/no-code.md).

## Install with npm

```
npm install @keepalive/client
```

```ts
import { Keepalive, formatCode } from "@keepalive/client";

const kit = new Keepalive({ gameId: "com.you.yourgame", netVersion: "1", lobbyServer: "wss://lobby.example.com/ws" });
const lobby = await kit.host({ name: "My game", maxPlayers: 4 });
console.log("Tell your friend this code:", formatCode(lobby.code));
```

Without a bundler: `import { Keepalive } from "https://cdn.jsdelivr.net/npm/@keepalive/client@0.1/dist/keepalive.bundle.mjs"`.

## Made for players

- Lobbies are **unlisted** by default: friends join with the code or a link (`Keepalive.shareUrl(lobby.code)` makes
  `https://your.game/?join=C5A-FX8`; `Keepalive.codeFromUrl()` reads it back). Pass `visibility: "public"` to list it.
- Players without a name show as **"Player 2"**, "Player 3", ...
- A joiner that can't connect gets an error after 15 s (`readyTimeoutMs`) instead of waiting forever: code
  `ice_failed`, and `sessionEnded` with that reason. One relay retry happens first when the server offers TURN.
- A page **reload keeps the seat** (`rememberSeat`, on by default): `kit.join(sameCode)` or `kit.resume()` takes it back;
  `kit.rememberedCode` says which lobby.
- `Keepalive.describeError(err)` turns any error into `{ message, hint }` you can show as-is.
- Test seams go under `advanced: { socketFactory, linkFactory, clock, storage, ... }`.

## Files

| Import | What |
|---|---|
| `@keepalive/client` | the public API: `Keepalive`, `Lobby`, `Lockstep`, `Chat`, `Voice`, `KeepaliveError`, `normalizeCode`, `formatCode`, `describeError`, `shareUrl`, `codeFromUrl` |
| `@keepalive/client/ui` | the `<keepalive-lobby>` drop-in element (host, join, invite link, players, start); also in the `<script>` build |
| `@keepalive/client/testing` | in-memory server, peer network and clock for your own tests |
| `@keepalive/client/internals` | low-level pieces (codec, chunking, migration, jitter buffer, ...); no stability promise |
| `dist/keepalive.global.min.js` | the `<script>` build; sets `window.Keepalive` |

Guides, recipes and the API reference: [Keepalive docs](https://REPLACE-ME.example/keepalive#readme). MIT license.
