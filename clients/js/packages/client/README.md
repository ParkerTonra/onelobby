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

## Files

| Import | What |
|---|---|
| `@keepalive/client` | the public API: `Keepalive`, `Lobby`, `Lockstep`, `Chat`, `Voice`, `KeepaliveError`, `normalizeCode`, `formatCode` |
| `@keepalive/client/testing` | in-memory server, peer network and clock for your own tests |
| `@keepalive/client/internals` | low-level pieces (codec, chunking, migration, jitter buffer, ...); no stability promise |
| `dist/keepalive.global.min.js` | the `<script>` build; sets `window.Keepalive` |

Guides, recipes and the API reference: [Keepalive docs](https://REPLACE-ME.example/keepalive#readme). MIT license.
