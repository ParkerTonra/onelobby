# onelobby (browser / JS)

TypeScript, ESM + `.d.ts`, zero runtime dependencies. Implements DESIGN s.11.2 over the frozen protocol in `spec/`:
signaling client, WebRTC transport (three negotiated data channels, ids 0/1/2), binary codec, chunking, lockstep
(host frame emission on a Worker timer, catch-up, hashes, desync -> snapshot, late join, 3-strike drop), host migration,
raw mode, text chat, voice (AudioWorklet capture, WebCodecs Opus behind a pluggable `VoiceCodec`, PTT/VAD, jitter buffer).

```ts
import { OneLobby } from "onelobby";
const kit = new OneLobby({ gameId: "dev.example.game", netVersion: "1", lobbyServer: "wss://lobby.example/ws" });
const lobby = await kit.host({ name: "my game", maxPlayers: 4 });   // or: await kit.join("7HQ 4K2")
lobby.lockstep.snapshot = () => game.snapshot();
lobby.lockstep.restore = (tick, bytes) => game.restore(tick, bytes);
await lobby.start();
setInterval(() => { let f; while ((f = lobby.lockstep.nextFrame())) lobby.lockstep.reportHash(f.tick, game.step(f.tick, f.commands)); }, 25);
```

Binary replication (host-authoritative real-time games; `docs/recipes/replication.md` s.5, wire format `spec/replication.md`): on a `mode: "raw"` lobby,
`new ReplicationSession(lobby)` gives delta snapshots (bit-packed, quantised, against the last acked baseline; a reliable keyframe on join and every 5 s),
a redundant input stream, events (also numbered streams), interpolated sampling, a tick clock and per-second byte rates, compatible byte for byte with the
C# `OneLobby.Replication`. `describeReplication(bytes)` / `rep.packetLog = true` read packets by eye. Call `rep.pump()` every frame.
`Reconciler`, `PredictionSmoother` and `HistoryRing` (prediction and hit rewind) are the JS twins of the C# helpers.

Networked players (`docs/recipes/net-player.md`, `spec/net-player.md`): `new NetPlayers(lobby)` puts every seated peer's player in the world with no
player sync of your own: position, facing and movement state smooth on every other screen, and jump, shoot, melee and the rest arrive exactly once at the
right moment. `sync.player.authority` `"owner"` (the player's own PC places it, the default) or `"host"` (the host steps it and the owner predicts); the
host's limits and hit rewind are included. Call `players.pump()` instead of `rep.pump()`. JS only for now (the Godot node and the Unity component are next);
proven on an in-memory network, not yet in a real engine.

Tick convention (spec/binary.md): the initial state is tick 0; `frame(T)` produces tick T; call `reportHash(tick, hash)` after
applying each frame (the library only sends it when `tick % hashEveryTicks == 0`). `snapshot()` returns the state after the last
frame handed out by `nextFrame()`; `restore(tick, bytes)` receives that tick and the next frame is `tick + 1`.

## Layout

| Path | What |
|---|---|
| `packages/client` | the library (`src/`), vitest suite (`test/`) |
| `packages/client/src/internals.ts` | low-level pieces (codec, chunking, migration, jitter buffer, gridpaint, clocks); export `onelobby/internals`. The root export is the small public API |
| `packages/client/dist/onelobby.global*.js`, `onelobby.bundle.mjs` | single-file `<script src>` (sets `window.OneLobby`) and ESM bundles, from `src/global.ts` via `scripts/bundle.mjs`; publish steps in `packages/client/PUBLISHING.md` |
| `packages/client/src/testing.ts` | `ManualClock`, `MemoryNetwork` (in-memory peer links), `MemoryServer` (lk1 server double); export `onelobby/testing` |
| `demo/` | gridpaint in the browser: plain HTML + the built lib, `serve.mjs` dev server |
| `e2e/tabs.mjs` | Playwright (core) script: host, joiner, late joiner, chat, voice, host-close migration in real Edge/Chrome |
| `conformance-adapter.mjs` | adapter for `conformance/peer` |

## Commands

```
cd clients/js
npm install
npm test                 # vitest (172 tests); also: npm run typecheck, npm run build
ONELOBBY_SERVER=ws://localhost:8080/ws npm test    # adds the real-server smoke test (real WebSocket, in-memory peer links)
node ../../conformance/peer/run.mjs --adapter=../clients/js/conformance-adapter.mjs   # after npm run build; 28/28
```

## Run the demo (two tabs)

1. Start a lobby server: `dotnet run --project server/OneLobby.Server -- --listen :8080` (from the repo root).
2. `cd clients/js && npm install && npm run build && node demo/serve.mjs --lobby ws://localhost:8080/ws`
   (the lobby URL is also the `<meta name="onelobby-server">` tag in `demo/index.html`; `serve.mjs` rewrites it from `--lobby`).
3. Open `http://localhost:5173/` in two tabs. Tab 1: **Host**, then **Start game**. Tab 2: type the join code (or **Browse**, click a row)
   and **Join**. Click the grid to paint; the status line shows tick, hash and "in sync". Chat line under the log.
   **Enable voice** in both tabs, hold **V** to talk (mic meter shows input level). A late third tab joins by snapshot and gets chat history.
   Close the host tab: the lowest peer id takes over within a few seconds. Hosting needs the tab visible and open.
4. Automated version of step 3: `node e2e/tabs.mjs --demo http://localhost:5173/ --metrics http://localhost:8080/metrics` (uses Edge via `playwright-core`; pass `--browser <path>` for Chrome).

`http://localhost` counts as a secure context, so `getUserMedia` works without TLS; anywhere else serve over https.

## Direct mode behind a strict NAT (TURN)

Players behind a symmetric or carrier-grade NAT cannot open a direct link; a TURN relay gets them in. Pass
`iceServers: [{ urls: "turn:turn.example.com:3478", username, credential }]` to `hostDirect` / `hostNostr` (every joiner gets
it in `welcome.ice`) or to `kit.joinDirect(code, { iceServers })` (added to the host's list). For a TURN server with a shared
secret, `turnLogin(secret, id, ttlSeconds)` mints a short-lived login (spec/turn-rest.md). `relayOnly` sends and accepts only
relay candidates. Setup, coturn and hosted options, expiring logins: `docs/recipes/turn.md`. Keep TURN passwords out of your repo.

## LAN games (opt-in)

Players on one local network can find a direct host with no code (`spec/lan-discovery.md`; recipe `docs/recipes/direct-ip.md`
section 7b). Off unless `hosting.lan` is true in `onelobby.json` (it needs `hosting.direct`) or you pass `lan: true` to
`hostDirect`; then the host answers a broadcast question on UDP 47840 while its lobby is open, and `kit.lanFinder()` lists the hosts.
`finder.start()` opens one UDP socket, `finder.games` is the list (`name`, `hostName`, `players`, `maxPlayers`, `hasPassword`,
`sameVersion`, `address`, `port`), `finder.on("changed", ...)` fires on changes, `finder.askNow()` asks again, `finder.stop()`
closes the socket. Node only: in a browser `start()` resolves with status `"browser"`. Tests pass `targets: ["127.0.0.1"]` and a host
with `bindHost: "127.0.0.1"`, so nothing leaves the machine. Proven on one machine only, not yet on a real network.

## Saved player settings

`kit.settings` keeps the player's name, TURN relay line, last join code and lobby server in `localStorage` (Node: pass
`settingsFile`) and applies them as defaults; an explicit option always wins. `kit.settings.save({ relay })` rejects a line the
relay parser does not accept, `kit.settings.maskedRelay()` is the text for a settings field, and the relay line is never logged.
Recipe: `docs/recipes/settings.md`; contract: `spec/settings.md`.

## Seams

`new OneLobby({ socketFactory, linkFactory, clock, wallClock, voiceCodec, createMic, createSink })` replace the browser pieces.
For browsers without WebCodecs Opus, implement `VoiceCodec` (a WASM libopus wrapper) and pass it as `voiceCodec`.
