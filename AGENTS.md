# Keepalive for AI coding agents

Keepalive is an open-source, game-agnostic multiplayer kit: a lobby server (join codes, public list), a TURN relay, and
client libraries (`@keepalive/client` for JS, `Keepalive.Core` + `Keepalive.Godot` for C#). Peers talk over WebRTC data channels;
the server never sees game data.
Pick a mode: `lockstep` (deterministic sim, host orders commands per tick) or `raw` (you send bytes, you own the netcode).
You do not need to open `clients/`, `server/` or `spec/` to integrate a game. This file plus one recipe is enough.

## API surface (same shape in both languages)

```csharp
// C#: Keepalive.Core (Godot: add new GodotTransport())
var client = new LobbyClient(new KeepaliveConfig("com.you.game", "1", new Uri(lobbyServerUrl),
                             SyncMode.Raw, DisplayName: "Ann"), transport);
Lobby lobby = await client.HostAsync(new LobbyOptions("Ann's game", MaxPlayers: 4, Visibility: Visibility.Public));
Lobby lobby = await client.JoinAsync("7HQ 4K2");          // also RejoinAsync(resumeToken)
IReadOnlyList<LobbySummary> list = await client.ListAsync();
lobby.Pump();                                              // every frame; events fire on the calling thread
lobby.Send(peerId, bytes); lobby.Broadcast(bytes);         // Channel.Reliable (default) or Channel.Fast
lobby.MessageReceived += (from, payload, channel) => { };
lobby.PeerJoined / PeerLeft / HostChanged / PhaseChanged / SessionEnded
await lobby.StartAsync(); await lobby.KickAsync(id); await lobby.LeaveAsync();
lobby.Chat.Send("gg"); lobby.Chat.Received += line => { };
lobby.Voice.Enabled = true; lobby.Voice.PushToTalk(down);
lobby.Lockstep!.Submit(cmd); while (lobby.Lockstep.TryNextFrame(out var f)) { /* f.Tick, f.Commands */ }
lobby.Lockstep.ReportHash(tick, hash); lobby.Lockstep.Snapshot = () => bytes; lobby.Lockstep.Restore = (tick, b) => { };
```

```ts
// JS: @keepalive/client (no pump(): events come from the event loop)
const kit = new Keepalive({ gameId: "com.you.game", netVersion: "1", lobbyServer, mode: "raw", displayName: "Ann" });
const lobby = await kit.host({ name: "Ann's game", maxPlayers: 4, visibility: "public" });
const lobby = await kit.join("7HQ 4K2");                   // also kit.rejoin(resumeToken)
const list = await kit.list();                             // LobbySummary[]
lobby.send(peerId, bytes); lobby.broadcast(bytes);         // { channel: "fast" } optional
lobby.on("message", (from, bytes, channel) => {});
lobby.on("peerJoined" | "peerLeft" | "hostChanged" | "phase" | "sessionEnded", handler);
await lobby.start(); await lobby.kick(id); await lobby.leave();
lobby.chat.send("gg"); lobby.chat.on("message", ({ peerId, text }) => {});
lobby.voice.enabled = true; lobby.voice.pushToTalk(down);
lobby.lockstep.submit(cmd); for (let f; (f = lobby.lockstep.nextFrame()); ) { /* f.tick, f.commands */ }
lobby.lockstep.reportHash(tick, hash); lobby.lockstep.snapshot = () => bytes; lobby.lockstep.restore = (tick, b) => {};
```

Useful fields: `lobby.code`, `localPeerId`, `hostPeerId`, `isHost`, `phase`, `peers`, `meta`, `resumeToken`.
Full reference (generated): `docs/api/`.

## Rules

1. **The game owns the command bytes.** Keepalive moves opaque `Uint8Array` / `byte[]`. Encode and decode yourself; pass
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
- Browser JS: `docs/recipes/js-web.md`
- Any .NET app (console, Unity-free engines, tests): `docs/recipes/dotnet-generic.md`
- Raw mode (your own netcode, e.g. turn-based or arcade): `docs/recipes/raw-mode.md`
- Voice and text chat: `docs/recipes/voice-and-chat.md`
- Run your own server: `docs/recipes/self-host.md`

Example target for practice: `examples/tictactoe/` (single player, no networking).
Docs index for tools: `llms.txt`. Design and wire protocol: `DESIGN.md`, `spec/`.
