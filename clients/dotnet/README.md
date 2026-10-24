# OneLobby .NET and Godot clients

| Project | What |
|---|---|
| `OneLobby.Core` | Engine-agnostic client (netstandard2.1 + net8.0): `LobbyClient`, `Lobby`, `LockstepSession`, `VoiceChannel`, `TextChat`, `ITransport`/`IPeerLink`/`ISignalingSocket`, `IVoiceCodec`, `IVoiceAudio`, and `InMemoryNetwork` (a fake lobby server + loopback links + manual clock, for offline tests) |
| `OneLobby.Replication` | Host-authoritative state replication on a raw lobby (netstandard2.1 + net8.0, no engine types, no third-party deps): `ReplicationSession`, `NetworkClock`, `NetWriter`/`NetReader`/`Quantize`, `Reconciler`, `HistoryRing` (DESIGN s.19, `spec/replication.md`) |
| `OneLobby.Opus` | `OpusVoiceCodec` (Concentus, BSD-3-Clause; see `THIRD_PARTY.md`) |
| `OneLobby.Godot` | `GodotTransport` (WebSocketPeer + WebRtcPeerConnection), `GodotVoiceAudio` (mic capture, per-speaker playback) |
| `OneLobby.DataChannel` | Engine-agnostic `DataChannelTransport : ITransport` (libdatachannel WebRTC data channels via P/Invoke + `WebSocketSignalingSocket`); natives from `native/build-windows.ps1`, `build-linux.sh`, `build-posix.sh`. Tests: `OneLobby.DataChannel.Tests` (live two-peer WebRTC through an in-process server); `OneLobby.DataChannel.Smoke` (command-line peer for cross-play) |
| `../unity/com.onelobby.unity` | Unity 6 UPM package: `UnityTransport` (wraps `DataChannelTransport`), `UnityVoiceAudio`, `OneLobbyRunner`; ships Core/DataChannel/Opus DLLs and the natives via `clients/unity/build-unity-package.ps1` (`docs/recipes/unity.md`) |
| `OneLobby.Gridpaint` | The shared demo game (`spec/demo-game.md`) |
| `OneLobby.Core.Tests` | xunit: spec vectors, goldens, lobby, lockstep, migration, desync, chat, voice, Opus |
| `OneLobby.Replication.Tests` | xunit: wire vectors, spawn/despawn, delta after loss, late join, interpolation, input redundancy, prediction, lag compensation, 4 x 54-entity bandwidth |
| `OneLobby.Conformance` | stdio adapter for `conformance/peer` |
| `demo-godot` | Godot 4.5.1 .NET gridpaint demo (Host / Join / Browse, code field, chat line, hold V to talk) |

## Game loop

```csharp
var client = new LobbyClient(config, new GodotTransport());
var lobby = await client.HostAsync(new LobbyOptions("room", 8, Visibility.Public)); // call client.Pump() each frame until this returns
// from now on ONE call per frame:
lobby.Pump();
while (lobby.Lockstep!.TryNextFrame(out var f)) { /* apply f, report hashes */ }
```

Async calls throw `OneLobbyException` (`Code` = server error code, or `timeout` / `server_closed`).

## Build and test

```
dotnet build clients/dotnet            # 0 warnings
dotnet test clients/dotnet
node conformance/peer/run.mjs --stdio="dotnet run --project ../clients/dotnet/OneLobby.Conformance"   # from conformance/
```

## Godot demo

```
dotnet build clients/dotnet/demo-godot
clients/dotnet/demo-godot/fetch-webrtc.ps1        # or .sh: webrtc-native 1.2.2-stable into addons/godot_webrtc/ (not committed)
godot --headless --import --path clients/dotnet/demo-godot      # once, registers the extension
dotnet run --project server/OneLobby.Server -- --listen :8080
GODOT=... clients/dotnet/demo-godot/headless-test.sh            # two headless instances host/join, compares hashes
```

Use `ws://127.0.0.1:8080/ws`, not `localhost` (Godot's WebSocketPeer can stall on the IPv6 address).

## Cross-play with the browser demo

1. Start the server: `dotnet run --project server/OneLobby.Server -- --listen :8080`.
2. Browser: `node clients/js/demo/serve.mjs --lobby ws://127.0.0.1:8080/ws`, open http://localhost:5173.
3. Godot (windowed): `godot --path clients/dotnet/demo-godot --position 2000,420 --audio-driver Dummy --log-file k.log -- --server=ws://127.0.0.1:8080/ws`; click Host, then type the code in the browser tab and Join (or Host in the browser and type its code into the Godot code field).
4. Both show the same hash line every second; chat lines cross; hold V in either to talk.

## Deviations and notes

- A joiner treats 8 s of total silence from the host (no frames and no pongs) as host loss; 3 s without frames while a game runs sends `snapshot_req` (spec). Channel close migrates at once.
- Migration: peers that are ahead replay their buffered frames to the new host, which resumes after the highest tick it learns of (spec says min of survivors; this avoids rolling anyone back, hash checks still repair any difference).
- `GodotPeerLink.Relayed` is true only for `relayOnly` lobbies (Godot exposes no selected-pair stats), so the server's path telemetry counts relay use only in that case.
