# OneLobby for AI coding agents

OneLobby is an open-source, game-agnostic multiplayer kit: a lobby server (join codes, public list), a TURN relay, and
client libraries (`onelobby` for JS; `OneLobby.Core` + a transport for C#: `OneLobby.Godot`, `OneLobby.DataChannel`
(libdatachannel WebRTC for any .NET app) or the `com.onelobby.unity` package). Peers talk over WebRTC data channels;
the server never sees game data.
Pick a mode: `lockstep` (deterministic sim, host orders commands per tick) or `raw` (you send bytes, you own the netcode).
Real-time host-authoritative games (shooters, physics, AI; anything non-deterministic) use `raw` plus
`OneLobby.Replication` (C#): delta snapshots, interpolation, inputs, events, prediction and lag-compensation helpers.
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
await lobby.StartAsync(); await lobby.KickAsync(id); await lobby.LeaveAsync();   // KickAsync bans; DisconnectAsync(id, code?, reason?) does not
bool sent = await lobby.FlushAsync(TimeSpan.FromSeconds(1));   // before LeaveAsync: last reliable messages leave first (keep pumping)
lobby.Chat.Send("gg"); lobby.Chat.Received += line => { };
lobby.Voice.Enabled = true; lobby.Voice.PushToTalk(down);
lobby.Voice.ReleaseHangMs = 150; lobby.Voice.MuteAll(true); lobby.Voice.IsMuted(id); lobby.Voice.InputLevel; lobby.Voice.IsTransmitting;
lobby.Lockstep!.Submit(cmd); while (lobby.Lockstep.TryNextFrame(out var f)) { /* f.Tick, f.Commands */ }
lobby.Lockstep.ReportHash(tick, hash); lobby.Lockstep.Snapshot = () => bytes; lobby.Lockstep.Restore = (tick, b) => { };
```

```csharp
// C#: OneLobby.Replication, on a SyncMode.Raw lobby (docs/recipes/replication.md)
var rep = new ReplicationSession(lobby);                   // 30 Hz tick + snapshots, 100 ms interpolation
rep.Pump();                                                // every frame, instead of lobby.Pump()
NetId id = rep.Spawn(typeId, ownerPeerId, entity);         // host; entity : IReplicatedEntity { Write(NetWriter) }
while (rep.Clock.TryAdvance()) { rep.TryGetInput(peer, out InputFrame f); /* sim step */ rep.SendSnapshot(); }   // host
while (rep.Clock.TryAdvance()) rep.SubmitInput(inputBytes);                                                   // client
rep.EntitySpawned / EntityDespawned / EventReceived / HostLost; rep.SendEvent(bytes);
rep.SendEvent(bytes, peer, Channel.Reliable, stream: 3); rep.EventDelivered += e => { /* e.Stream, e.Seq */ }; rep.EventGap += g => { /* g.Stream, g.FirstMissing, g.NextDelivered */ };
rep.TrySample<TState>(id, out var s);                      // client: TState : IReplicatedState<TState>, at rep.RenderTick
rep.RttMs; rep.PeerRttMs(peer); rep.SnapshotAgeMs; rep.InputStatsFor(peer); rep.SendFullSnapshot(peer);   // overlay, resync
new Reconciler<TInput, TState>(start, step); new HistoryRing<T>(ticks, lerp); rep.RewindTick(f);   // prediction, hitscan
new PredictionSmoother().Correct(dx, dy, dz, sequence); smoother.Update(ms); smoother.Offset; NetMath.LerpOrSnap(a, b, t, maxDistance);
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
await lobby.start(); await lobby.kick(id); await lobby.leave();   // kick bans the address; lobby.disconnect(id, code?, reason?) does not
lobby.chat.send("gg"); lobby.chat.on("message", ({ peerId, text }) => {});
const ws = lobby.asWebSocket();                            // joiner: WebSocket-shaped link to the host (text; { binary: true })
lobby.onConnection((conn) => { conn.onmessage = (e) => conn.send(e.data); });   // host: one WebSocket-shaped conn per joiner
lobby.voice.enabled = true; lobby.voice.pushToTalk(down);
lobby.lockstep.submit(cmd); for (let f; (f = lobby.lockstep.nextFrame()); ) { /* f.tick, f.commands */ }
lobby.lockstep.reportHash(tick, hash); lobby.lockstep.snapshot = () => bytes; lobby.lockstep.restore = (tick, b) => {};
```

## Install

```
npm install onelobby
```

Right after a release, npm's local cache can still list only the old versions, so asking for the new one fails with
`ETARGET` even though `npm view` shows it; add `--prefer-online` to the install.

No bundler: `<script src="https://cdn.jsdelivr.net/npm/onelobby@0.4.0/dist/onelobby.global.min.js">` sets
`window.OneLobby` (so `new OneLobby.OneLobby({...})`), or import the single-file ES module
`https://cdn.jsdelivr.net/npm/onelobby@0.4.0/dist/onelobby.bundle.mjs`. Low-level pieces (codec, chunking,
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

Installing a folder only links it (npm runs no build), so build before every `npm install <folder>` that should pick
up new changes. Then load the bundle from the page: `<script type="module" src="./dist/app.js"></script>`. A page that only has
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
- Liveness: a silently dead peer surfaces on its own within about 30 s (host: `peerLeft`; joiner: `hostChanged` after
  a migration, or `sessionEnded("host_left")` on a direct lobby). `peerTimeoutMs` (default 0 = that) shortens it using
  OneLobby's own 2 s pings (minimum 6000), so games need no heartbeat of their own.
- `rateLimit: { messages, perMs }` on `host()` / `hostDirect()` caps each joiner's incoming raw messages; the excess is
  dropped before `message` fires or is relayed.
- Direct lobbies have no migration and never emit `hostChanged`: when the host goes, joiners get `sessionEnded("host_left")`.
- Sockets close with 1000 (you closed, or the host's `disconnect()`), 1001 (the other end left, `host_left`,
  `host_changed`), 4000 (kicked) or 1006 (`timeout`, `ice_failed`, ...); `e.reason` is the lobby's reason. A code and
  reason the host passes to `disconnect(id, code, reason)` / `kick(id, { code, reason })` reach the joiner's `onclose`
  as given. The library version is `LIB_VERSION`.
- `lobby.kick(id)` bans that player's address from the lobby for as long as it lasts (a reload or new tab included).
  To end one connection without the ban (a seat taken over by another tab), use `lobby.disconnect(id, code?, reason?)`:
  the joiner's lobby ends with `sessionEnded("disconnected")` and it may join again. A ban is per address, so a player
  on a new address (another network, a VPN, a phone hotspot) can return; use a lobby password to keep strangers out.
- `asWebSocket()` fires `onopen` on a later task, like a real WebSocket, so a handler assigned after any number of
  `await`s still runs (once). `readyState === 1` also tells you it is open.
- `host()` defaults to `visibility: "unlisted"`: joinable by code or link, not shown by `list()`. Pass `"public"` to list it.
- An empty `displayName` (the default) shows to everyone as `"Player N"`, N being the seat (peer id).
- Test and runtime seams (`socketFactory`, `linkFactory`, `clock`, `wallClock`, `voiceCodec`, `createMic`,
  `createSink`, `storage`) go under `options.advanced`; the old top-level keys still work but are deprecated.

## Friendly defaults (C#)

- `OneLobbyConfig.ReadyTimeout` (default 15 s, `TimeSpan.Zero` = wait forever; set with `config with { ReadyTimeout = ... }`):
  same rules as JS `readyTimeoutMs`. `ReadyAsync` faults with `OneLobbyException` code `ice_failed`, `client.Error`
  fires, the lobby is left and `SessionEnded("ice_failed")` fires; the relay-only retry runs when the server offers
  TURN. Direct-IP joiners get the same timeout (no relay retry: direct IP has no TURN).
- Unity `OneLobbyRunner` sets `Application.runInBackground = true` from Host/Join until the lobby ends (then restores
  it), so an unfocused window keeps pumping; opt out with `KeepRunningInBackground = false`.
- A peer that leaves on purpose is not cut off: when the server (or a direct host's socket) says it is gone, the lobby
  keeps reading its link until that closes (at most `Lobby.LeaveGraceMs`, 500 ms), so messages it sent before
  `LeaveAsync` arrive before `PeerLeft` / `HostChanged` / `SessionEnded`. `FlushAsync` makes sure they left its machine.
  The same grace applies when the server times a peer out or its seat is taken over; `KickAsync` / `DisconnectAsync`
  cut it off at once.
- Every C# event (lobby, chat, voice, replication) fires synchronously inside `Pump()` on the calling thread, and
  `ReadyAsync` / `HostAsync` / `JoinAsync` complete there too: pump from the engine's main loop and touch engine APIs
  directly in handlers.
- `ReplicationSession.Clients` (host) holds only peers whose link is up (`PeerReady`); `ClientReady` fires when one
  joins it and its first snapshot is a full one.
- Error codes are constants: `LobbyErrorCodes.LobbyFull` (C#) / `ErrorCodes.LobbyFull` (JS) = `"lobby_full"`,
  `VersionMismatch` = `"version_mismatch"`, `InGame`, `UnknownCode`, `IceFailed`, ... Compare `e.Code` / `e.code` to them.
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
   With `OneLobby.Replication` late join is automatic (full snapshot, then deltas); host migration is not supported:
   end the match on `HostLost`. Clients send inputs, never positions; one-off facts (points, kills) go in `SendEvent`.
8. Voice and chat are outside the sim: never put them in a lockstep frame or a hash.

## Recipes (each is copy-paste and ends with a "Done when" check)

- Godot 4 C# (desktop + web): `docs/recipes/godot-csharp.md`
- Unity 6 (desktop + mobile, no WebGL): `docs/recipes/unity.md`
- Browser JS: `docs/recipes/js-web.md`
- Any .NET app (console, MonoGame, bots, tests; real WebRTC via `OneLobby.DataChannel`): `docs/recipes/dotnet-generic.md`
- Raw mode (your own netcode, e.g. turn-based or arcade): `docs/recipes/raw-mode.md`
- Replicated state (host-authoritative real-time: shooters, physics, AI), C#: `docs/recipes/replication.md`
- Voice and text chat: `docs/recipes/voice-and-chat.md`
- Test two players headless (playwright-core): `docs/recipes/testing.md`
- Host with a join code, no server (.NET desktop, Unity, Node): `docs/recipes/direct-ip.md` (C#: `client.HostDirectAsync`
  / `JoinDirectAsync` / `RejoinDirectAsync(code, token)` from `OneLobby.Direct`; Unity: `OneLobbyRunner.HostDirectAsync` / `JoinDirectAsync` / `RejoinDirectAsync`; Node: `hostDirect(kit)` from `onelobby/direct`; JS joiners:
  `kit.joinDirect(code)`, `kit.rejoinDirect(code, token)`. The code `6B01-RGFE-P2B` is the host's address; the router is asked to open port 47810 TCP+UDP
  (or the next free port up to 47819 when another program holds it; the code carries the port); a joiner's `joinCode`
  is the code it joined with; host leaving ends the session)
- Browser game whose server is a Node process on the host's PC (join link, page served on 47810, WebSocket-shaped
  adapter): `docs/recipes/browser-game.md`
- Run your own server: `docs/recipes/self-host.md` (the hosted backend; parked behind direct IP for now)

Example target for practice: `examples/tictactoe/` (single player, no networking).
Docs index for tools: `llms.txt`. Design and wire protocol: `DESIGN.md`, `spec/`.
