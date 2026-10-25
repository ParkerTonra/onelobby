# onelobby

Multiplayer for browser games. Players host a lobby, share a six-letter code, and join each other over peer-to-peer
WebRTC. Includes lockstep sync, raw messages, text chat and voice chat. No runtime dependencies.

You need a OneLobby lobby server (the WebSocket URL, like `wss://lobby.example.com/ws`). See the
[docs](https://github.com/ParkerTonra/onelobby#readme) to run one.

## Use it from a `<script>` tag (no build tools)

```html
<script src="https://cdn.jsdelivr.net/npm/onelobby@0.4.1/dist/onelobby.global.min.js"></script>
<script>
  const kit = new OneLobby.OneLobby({
    gameId: "com.you.yourgame",            // any unique name for your game
    netVersion: "1",
    lobbyServer: "wss://lobby.example.com/ws",
    mode: "raw",
  });
  // Host:  const lobby = await kit.host({ name: "My game", maxPlayers: 4 }); show OneLobby.formatCode(lobby.code)
  // Join:  const lobby = await kit.join("C5A FX8");
</script>
```

The file also works saved next to your page (`<script src="onelobby.global.min.js">`), including pages opened from disk.

## No code at all

After the `<script>` tag above, this gives a complete lobby box (the sentence inside only shows if the script did not
load):

```html
<one-lobby server="https://your-name.onrender.com" game="my-game" max-players="4">
  If you can read this, the OneLobby script didn't load.
</one-lobby>
```

See the [no-code guide](https://github.com/ParkerTonra/onelobby/blob/main/docs/no-code.md).

## Install with npm

```
npm install onelobby
```

```ts
import { OneLobby, formatCode } from "onelobby";

const kit = new OneLobby({ gameId: "com.you.yourgame", netVersion: "1", lobbyServer: "wss://lobby.example.com/ws" });
const lobby = await kit.host({ name: "My game", maxPlayers: 4 });
console.log("Tell your friend this code:", formatCode(lobby.code));
```

Without a bundler: `import { OneLobby } from "https://cdn.jsdelivr.net/npm/onelobby@0.4.1/dist/onelobby.bundle.mjs"`.

## Made for players

- Lobbies are **unlisted** by default: friends join with the code or a link (`OneLobby.shareUrl(lobby.code)` makes
  `https://your.game/?join=C5A-FX8`; `OneLobby.codeFromUrl()` reads it back). Pass `visibility: "public"` to list it.
- Players without a name show as **"Player 2"**, "Player 3", ...
- A joiner that can't connect gets an error after 15 s (`readyTimeoutMs`) instead of waiting forever: code
  `ice_failed`, and `sessionEnded` with that reason. One relay retry happens first when the server offers TURN.
- A page **reload keeps the seat** (`rememberSeat`, on by default): `kit.join(sameCode)` or `kit.resume()` takes it back;
  `kit.rememberedCode` says which lobby.
- `OneLobby.describeError(err)` turns any error into `{ message, hint }` you can show as-is.
- Test seams go under `advanced: { socketFactory, linkFactory, clock, storage, ... }`.

## Files

| Import | What |
|---|---|
| `onelobby` | the public API: `OneLobby`, `Lobby`, `Lockstep`, `Chat`, `Voice`, `OneLobbyError`, `normalizeCode`, `formatCode`, `describeError`, `shareUrl`, `codeFromUrl` |
| `onelobby/ui` | the `<one-lobby>` drop-in element (host, join, invite link, players, start); also in the `<script>` build |
| `onelobby/testing` | in-memory server, peer network and clock for your own tests |
| `onelobby/internals` | low-level pieces (codec, chunking, migration, jitter buffer, ...); no stability promise |
| `dist/onelobby.global.min.js` | the `<script>` build; sets `window.OneLobby` |

Guides, recipes and the API reference: [OneLobby docs](https://github.com/ParkerTonra/onelobby#readme). MIT license.
