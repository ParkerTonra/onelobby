# @keepalive/client (browser / JS)

TypeScript, ESM + `.d.ts`, zero runtime dependencies. Implements DESIGN s.11.2 over the frozen protocol in `spec/`:
signaling client, WebRTC transport (three negotiated data channels, ids 0/1/2), binary codec, chunking, lockstep
(host frame emission on a Worker timer, catch-up, hashes, desync -> snapshot, late join, 3-strike drop), host migration,
raw mode, text chat, voice (AudioWorklet capture, WebCodecs Opus behind a pluggable `VoiceCodec`, PTT/VAD, jitter buffer).

```ts
import { Keepalive } from "@keepalive/client";
const kit = new Keepalive({ gameId: "dev.example.game", netVersion: "1", lobbyServer: "wss://lobby.example/ws" });
const lobby = await kit.host({ name: "my game", maxPlayers: 4 });   // or: await kit.join("7HQ 4K2")
lobby.lockstep.snapshot = () => game.snapshot();
lobby.lockstep.restore = (tick, bytes) => game.restore(tick, bytes);
await lobby.start();
setInterval(() => { let f; while ((f = lobby.lockstep.nextFrame())) lobby.lockstep.reportHash(f.tick, game.step(f.tick, f.commands)); }, 25);
```

Tick convention (spec/binary.md): the initial state is tick 0; `frame(T)` produces tick T; call `reportHash(tick, hash)` after
applying each frame (the library only sends it when `tick % hashEveryTicks == 0`). `snapshot()` returns the state after the last
frame handed out by `nextFrame()`; `restore(tick, bytes)` receives that tick and the next frame is `tick + 1`.

## Layout

| Path | What |
|---|---|
| `packages/client` | the library (`src/`), vitest suite (`test/`) |
| `packages/client/src/testing.ts` | `ManualClock`, `MemoryNetwork` (in-memory peer links), `MemoryServer` (lk1 server double); export `@keepalive/client/testing` |
| `demo/` | gridpaint in the browser: plain HTML + the built lib, `serve.mjs` dev server |
| `e2e/tabs.mjs` | Playwright (core) script: host, joiner, late joiner, chat, voice, host-close migration in real Edge/Chrome |
| `conformance-adapter.mjs` | adapter for `conformance/peer` |

## Commands

```
cd clients/js
npm install
npm test                 # vitest (165 tests); also: npm run typecheck, npm run build
KEEPALIVE_SERVER=ws://localhost:8080/ws npm test    # adds the real-server smoke test (real WebSocket, in-memory peer links)
node ../../conformance/peer/run.mjs --adapter=../clients/js/conformance-adapter.mjs   # after npm run build; 28/28
```

## Run the demo (two tabs)

1. Start a lobby server: `dotnet run --project server/Keepalive.Server -- --listen :8080` (from the repo root).
2. `cd clients/js && npm install && npm run build && node demo/serve.mjs --lobby ws://localhost:8080/ws`
   (the lobby URL is also the `<meta name="keepalive-lobby-server">` tag in `demo/index.html`; `serve.mjs` rewrites it from `--lobby`).
3. Open `http://localhost:5173/` in two tabs. Tab 1: **Host**, then **Start game**. Tab 2: type the join code (or **Browse**, click a row)
   and **Join**. Click the grid to paint; the status line shows tick, hash and "in sync". Chat line under the log.
   **Enable voice** in both tabs, hold **V** to talk (mic meter shows input level). A late third tab joins by snapshot and gets chat history.
   Close the host tab: the lowest peer id takes over within a few seconds. Hosting needs the tab visible and open.
4. Automated version of step 3: `node e2e/tabs.mjs --demo http://localhost:5173/ --metrics http://localhost:8080/metrics` (uses Edge via `playwright-core`; pass `--browser <path>` for Chrome).

`http://localhost` counts as a secure context, so `getUserMedia` works without TLS; anywhere else serve over https.

## Seams

`new Keepalive({ socketFactory, linkFactory, clock, wallClock, voiceCodec, createMic, createSink })` replace the browser pieces.
For browsers without WebCodecs Opus, implement `VoiceCodec` (a WASM libopus wrapper) and pass it as `voiceCodec`.
