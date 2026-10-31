# onelobby (Godot 4, GDScript)

A pure GDScript client for Godot 4.4+, no .NET. Raw mode only: your own messages over the host's star (a joiner's
send goes through the host, `from` is always the real sender), host migration, chunking of big payloads, join codes,
lobby browse, kick/approve, rejoin. Lockstep, voice and replication are in the C# and JS clients. Written from `spec/`;
the API mirrors `OneLobby.Core`'s, with signals for events. Recipe: [docs/recipes/godot-gdscript.md](../../docs/recipes/godot-gdscript.md).

```gdscript
var client := OneLobbyClient.new()   # a Node: add_child it, it pumps every frame
client.game_id = "com.you.yourgame"
client.lobby_server = "ws://127.0.0.1:8080/ws"
add_child(client)
var lobby := await client.host({"name": "My game"})   # or: await client.join("7HQ 4K2"); null on failure, see client.last_error
lobby.message_received.connect(func(from: int, bytes: PackedByteArray, channel: int) -> void: print(from, bytes))
lobby.broadcast("hi".to_utf8_buffer())
```

## Layout

| Path | What |
|---|---|
| `addons/onelobby/client.gd` | `OneLobbyClient` (Node): signaling, host / join / rejoin / list coroutines, `error` signal |
| `addons/onelobby/lobby.gd` | `OneLobbyLobby`: peers, send / broadcast, phase, meta, kick, approve, migration; signals |
| `addons/onelobby/wire.gd` | `OneLobbyWire`: the binary codec (`spec/binary.md`), channel and type constants |
| `addons/onelobby/chunker.gd` | `OneLobbyChunker`: split / reassemble frames over 16 KB |
| `addons/onelobby/join_code.gd` | `OneLobbyJoinCode`: normalize ("7hq-4k2" -> "7HQ4K2") and display ("7HQ 4K2") |
| `addons/onelobby/signaling.gd` | `OneLobbySignaling`: the JSON signaling messages (`spec/signaling.md`) |
| `addons/onelobby/transport.gd` | `OneLobbyTransport`: the socket + peer-link seam (swap it in tests) |
| `addons/onelobby/godot_transport.gd` | `OneLobbyGodotTransport`: WebSocketPeer + WebRTCPeerConnection, 3 negotiated channels (ids 0/1/2) |
| `tests/vectors.gd` | the shared spec vectors (frames, invalid, chunking, join codes) |
| `tests/conformance_adapter.gd`, `conformance-adapter.mjs` | `conformance/peer` adapter |
| `tests/e2e.gd`, `headless-test.sh` | two instances host/join by code through a real server and exchange a message |

## Setup and tests

Desktop WebRTC needs the `webrtc-native` GDExtension (not committed): `./fetch-webrtc.sh` (or `fetch-webrtc.ps1`), then
`godot --headless --import --path .` once. Always run headless with `--headless --audio-driver Dummy`.

```
godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/vectors.gd
GODOT=/path/to/godot node conformance/peer/run.mjs --adapter=clients/gdscript/conformance-adapter.mjs
GODOT=/path/to/godot clients/gdscript/headless-test.sh ws://127.0.0.1:8080/ws    # with onelobby-server running
GODOT=/path/to/godot node docs/check-snippets.mjs                                 # parses the recipe's GDScript
```

Notes: 64-bit wire fields (`u64`) are Godot `int`s with the same bits (`OneLobbyWire.u64_to_string` prints them
unsigned). `relayed` on a peer reports `relay_only` (Godot's WebRTC does not expose the selected candidate pair).
