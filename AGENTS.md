# OneLobby for AI coding agents

OneLobby is an open-source, game-agnostic multiplayer kit: a lobby server (join codes, public list), a TURN relay, and
client libraries (`onelobby` for JS; `OneLobby.Core` + a transport for C#: `OneLobby.Godot`, `OneLobby.DataChannel`
(libdatachannel WebRTC for any .NET app) or the `com.onelobby.unity` package). Peers talk over WebRTC data channels;
the server never sees game data.
Pick a mode: `lockstep` (deterministic sim, host orders commands per tick) or `raw` (you send bytes, you own the netcode).
You do not need to open `clients/`, `server/` or `spec/` to integrate a game. This file plus one recipe is enough.

## API surface (same shape in both languages)

```csharp
// C#: OneLobby.Core + a transport: new DataChannelTransport() (any .NET), new GodotTransport(), Unity: new UnityTransport() or OneLobbyRunner
var client = new LobbyClient(new OneLobbyConfig("com.you.game", "1", new Uri(lobbyServerUrl),
                             SyncMode.Raw, DisplayName: "Ann"), transport);
Lobby lobby = await client.HostAsync(new LobbyOptions("Ann's game", MaxPlayers: 4, Visibility: Visibility.Public));
Lobby lobby = await client.JoinAsync("7HQ 4K2");          // also RejoinAsync(resumeToken)
IReadOnlyList<LobbySummary> list = await client.ListAsync();
client.Pump();                                             // only until you hold a Lobby (Host/Join/List complete here)
lobby.Pump();                                              // then this, every frame; events fire on the calling thread
lobby.Send(peerId, bytes); lobby.Broadcast(bytes);         // Channel.Reliable (default) or Channel.Fast
lobby.MessageReceived += (from, payload, channel) => { };
lobby.PeerJoined / PeerReady / PeerLeft / HostChanged / PhaseChanged / SessionEnded
lobby.Ready += () => { }; await lobby.ReadyAsync;          // joiner: link to host open (host: at once)
await lobby.StartAsync(); await lobby.KickAsync(id); await lobby.LeaveAsync();
lobby.Chat.Send("gg"); lobby.Chat.Received += line => { };
lobby.Voice.Enabled = true; lobby.Voice.PushToTalk(down);
lobby.Lockstep!.Submit(cmd); while (lobby.Lockstep.TryNextFrame(out var f)) { /* f.Tick, f.Commands */ }
lobby.Lockstep.ReportHash(tick, hash); lobby.Lockstep.Snapshot = () => bytes; lobby.Lockstep.Restore = (tick, b) => { };
```

```ts
// JS: onelobby (no pump(): events come from the event loop)
const kit = new OneLobby({ gameId: "com.you.game", netVersion: "1", lobbyServer, mode: "raw", displayName: "Ann" });
const lobby = await kit.host({ name: "Ann's game", maxPlayers: 4, visibility: "public" });
const lobby = await kit.join("7HQ 4K2");                   // also kit.rejoin(resumeToken), kit.resume()
const list = await kit.list();                             // LobbySummary[]
lobby.send(peerId, bytes); lobby.broadcast(bytes);         // { channel: "fast" } optional
lobby.on("message", (from, bytes, channel) => {});
lobby.on("peerJoined" | "peerReady" | "peerLeft" | "hostChanged" | "phase" | "sessionEnded", handler);
lobby.on("ready", () => {}); await lobby.ready;            // joiner: link to host open (host: at once)
await lobby.start(); await lobby.kick(id); await lobby.leave();
lobby.chat.send("gg"); lobby.chat.on("message", ({ peerId, text }) => {});
lobby.voice.enabled = true; lobby.voice.pushToTalk(down);
lobby.lockstep.submit(cmd); for (let f; (f = lobby.lockstep.nextFrame()); ) { /* f.tick, f.commands */ }
lobby.lockstep.reportHash(tick, hash); lobby.lockstep.snapshot = () => bytes; lobby.lockstep.restore = (tick, b) => {};
```

## Install

```
npm install onelobby
```

No bundler: `<script src="https://cdn.jsdelivr.net/npm/onelobby@0.1.0/dist/onelobby.global.min.js">` sets
`window.OneLobby` (so `new OneLobby.OneLobby({...})`), or import the single-file ES module
`https://cdn.jsdelivr.net/npm/onelobby@0.1.0/dist/onelobby.bundle.mjs`. Low-level pieces (codec, chunking,
migration, WebRTC classes) are in `onelobby/internals`; in-memory test doubles in `onelobby/testing`.

### From a clone of this repo (before a release is on npm, or to try unreleased changes)

Build it once, then point your project at the build:

```
git clone https://github.com/ParkerTonra/onelobby
cd onelobby/clients/js && npm ci && npm run build -w packages/client     # writes packages/client/dist
```

Either depend on it with a `file:` path, or bundle with an esbuild alias (no package install in your project):

```
# in your project
npm install file:/path/to/onelobby/clients/js/packages/client
# or, plain-JS project with no package.json
/path/to/onelobby/clients/js/node_modules/.bin/esbuild src/main.js --bundle --format=esm --outfile=dist/app.js   --alias:onelobby=/path/to/onelobby/clients/js/packages/client/dist/index.js
```

Then load the bundle from the page: `<script type="module" src="./dist/app.js"></script>`. A page that only has
`<script type="module" src="./src/main.js">` cannot resolve the bare name `onelobby`, so bundle first.
Lobby URL: the server's WebSocket endpoint is `ws://HOST:8080/ws` (`wss://HOST/ws` behind Caddy).

## Codes and peers

The server returns codes ungrouped (`C5AFX8`); show them grouped (`C5A FX8`) with `formatCode` or by hand. `join` accepts
either form. `lobby.peers` includes the local player and the host, so a two-player lobby has `peers.length === 2` on both sides.

Useful fields: `lobby.code`, `localPeerId`, `hostPeerId`, `isHost`, `phase`, `peers`, `meta`, `resumeToken`.
Full reference (generated): `docs/api/`.

## Friendly defaults (JS)

- `readyTimeoutMs` (default 15000, 0 = wait forever): a joiner that cannot reach the host gives up. `lobby.ready`
  rejects with `OneLobbyError` code `ice_failed`, `kit.on("error")` fires, the lobby is left and `sessionEnded` fires
  with reason `"ice_failed"`. When the server offers TURN, the second half of the budget is one relay-only retry.
- `rememberSeat` (default on where `sessionStorage` exists): after a page reload `kit.join(sameCode)` takes the old
  seat back instead of joining as a new player; `await kit.resume()` does it without a code (null when there is no seat
  or the server dropped it) and `kit.rememberedCode` tells you whether there is one. Forgotten when the session ends.
- `host()` defaults to `visibility: "unlisted"`: joinable by code or link, not shown by `list()`. Pass `"public"` to list it.
- An empty `displayName` (the default) shows to everyone as `"Player N"`, N being the seat (peer id).
- Test and runtime seams (`socketFactory`, `linkFactory`, `clock`, `wallClock`, `voiceCodec`, `createMic`,
  `createSink`, `storage`) go under `options.advanced`; the old top-level keys still work but are deprecated.
- Player-facing helpers: `describeError(e)` gives `{ code, message, hint? }` in plain language for any kit or server
  error; `shareUrl(code)` makes a `?join=7HQ-4K2` link to the current page; `codeFromUrl()` reads it back (or null).

## Rules

1. **The game owns the command bytes.** OneLobby moves opaque `Uint8Array` / `byte[]`. Encode and decode yourself; pass
   ids and numbers, never display names or object graphs.
2. **The host is truth.** In `raw` mode the host's state wins: joiners send intents, the host validates and broadcasts the
   result. In `lockstep` the host only orders commands; every peer runs the same sim.
3. **Lockstep needs determinism.** Same commands in the same order must give the same state on every peer: in-state RNG
   only (seeded from the lobby code or a lobby field), no wall clock, no unordered iteration, no floats that differ by
   platform. Report a state hash every `HashEveryTicks` ticks; a mismatch raises `Desync`.
4. **Never block on the server.** Games stay fully playable offline. Multiplayer is the only code that touches the
   network, and every lobby call can fail (offline, full, wrong version): show the error, keep the game running.
5. **The lobby server URL is a setting**, not a constant. Default pre-filled, user-editable, overridable by a flag or
   `<meta>` tag. Anyone can self-host (`docs/recipes/self-host.md`).
6. `GameId` + `NetVersion` gate lobbies: bump `NetVersion` whenever your command bytes or rules change.
7. Late join and host migration in lockstep need `Snapshot`/`Restore`. In raw mode, handle `HostChanged` yourself.
8. Voice and chat are outside the sim: never put them in a lockstep frame or a hash.

## Recipes (each is copy-paste and ends with a "Done when" check)

- Godot 4 C# (desktop + web): `docs/recipes/godot-csharp.md`
- Unity 6 (desktop + mobile, no WebGL): `docs/recipes/unity.md`
- Browser JS: `docs/recipes/js-web.md`
- Any .NET app (console, MonoGame, bots, tests; real WebRTC via `OneLobby.DataChannel`): `docs/recipes/dotnet-generic.md`
- Raw mode (your own netcode, e.g. turn-based or arcade): `docs/recipes/raw-mode.md`
- Voice and text chat: `docs/recipes/voice-and-chat.md`
- Test two players headless (playwright-core): `docs/recipes/testing.md`
- Run your own server: `docs/recipes/self-host.md`

Example target for practice: `examples/tictactoe/` (single player, no networking).
Docs index for tools: `llms.txt`. Design and wire protocol: `DESIGN.md`, `spec/`.
