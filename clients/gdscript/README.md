# onelobby (Godot 4, GDScript)

A pure GDScript client for Godot 4.4+, no .NET. Raw mode (through a lobby server) and Direct mode (no server, Nostr join codes): your own messages over the host's star (a joiner's
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

## Direct mode (no lobby server)

`host_direct` runs the whole lobby inside the host's game (the hub is ported from the JS one); joiners find it through
public Nostr relays by a short code, then talk over WebRTC. Same `OneLobbyLobby`, same signals and `send`/`broadcast`
as above, so game code does not change. No account, no server to keep alive.

```gdscript
# host
var lobby := await client.host_direct({"name": "My game", "max_players": 4})   # null on failure: client.last_error
print(lobby.code)                                  # "D1PB-1X9S-FPV": show it to the players

# joiner (the hyphens and case do not matter)
var lobby := await client.join_direct("D1PB-1X9S-FPV")
```

Options: `max_players` (2 to 250), `password`, `relays` (default: seven public relays), `stun` (default: public STUN; `[]`
for none, fine on a LAN), `upnp_port` (opt-in, off by default; asks the router via UPnP to forward that UDP port; untested,
and Godot's WebRTC picks its own ports, so it rarely helps). Direct mode has no host migration: when the host leaves,
joiners get `session_ended("host_left")`. `rejoin_direct(code, token)` takes a seat back. Version 0 (IP address) codes
are not supported yet and fail with `unsupported_code`.

Players behind a strict NAT (symmetric, carrier-grade) cannot open a direct link to anyone; a TURN relay gets them in.
Pass `ice_servers` (`[{urls, username, credential}]`) to `host_direct` (every joiner gets it in the welcome) or to
`join_direct` (added to the host's list). For a TURN server with a shared secret, `OneLobbyTurn.login(secret, id, ttl)`
mints a short-lived login. Godot's WebRTC reaches TURN over UDP only (libjuice): `?transport=tcp` and `turns:` URLs
are skipped, so a network that blocks all UDP still cannot connect. `client.relay_only = true` forces the relay (to
test it). Keep TURN passwords out of your repo: read them from an environment variable at export time.

Tests, no lobby server: `GODOT=... clients/gdscript/direct-test.sh` (two instances, real WebRTC, a local test relay;
pass `public` to use the real relays) and `GODOT=... node integration/nostr-interop-gdscript.mjs` (against the JS client,
both directions).

## Tips

- `OneLobbyJoinCode.display()` has a space ("7HQ 4K2") for lobby codes and hyphens for Direct codes; `join()` and
  `join_direct()` accept both. Quote the code on a command line (`--code="7HQ 4K2"`).
- A host that builds its own session state after `host()` returns should seed it from `lobby.peers()`: joiners may
  already be in by then, and `peer_joined` only fires for later ones.
- `await lobby.leave_and_flush()` instead of `leave()` when the game quits right after: it waits for your queued reliable
  messages and the leave to go out, then keeps the peer links open for a short linger (300 ms, `linger_ms`) so peers
  hear the leave before the channels close. No goodbye message of your own is needed. A send to a peer whose channel
  has closed is dropped without an engine error, and that link counts as closed from then on. `lobby.debug_drop()`
  closes the signaling socket like a dropped network, for testing `rejoin()`.
- After `await lobby.leave_and_flush()` the scene may be gone. To clean up on a timer, connect the method, not a lambda
  that captures a node: `timer.timeout.connect(node.queue_free)`. The engine drops a method connection with its node;
  a lambda keeps the freed capture and logs `Lambda capture at index 0 was freed`.
- `client.rejoin(token)` closes and reopens the signaling socket if it is still up, so it also takes over a seat from
  another socket.
- A game with an auto-rejoin loop should skip it on `session_ended("host_left")`: the host is gone (Direct mode has no
  migration), so there is no seat to take back. Rejoin only after a dropped connection.
- A public Nostr relay that is down makes Godot print `ERROR: Invalid status code. Got: '503', expected '101'.` and
  `ERROR: Invalid response headers.` per dial; the lobby keeps working over the other relays. A relay that never
  connects is dropped after 4 failed dials once another relay is up, so the lines stop within about 15 s. A test that
  fails on any engine `ERROR` should allow these two.
- Local dev server, from `server/`: `dotnet build -c Release`, then `dotnet run -c Release --no-build --project
  OneLobby.Server -- --listen 127.0.0.1:8787`, then `curl http://127.0.0.1:8787/healthz`, then set
  `client.lobby_server = "ws://127.0.0.1:8787/ws"`. Use 127.0.0.1, not `localhost` (IPv6 first, the connect stalls).

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
| `addons/onelobby/hub.gd`, `direct_host.gd`, `nostr_*.gd` | Direct mode: the in-process hub, the host, the Nostr relay pool / room / link / sockets, limits |
| `addons/onelobby/secp256k1.gd`, `nostr_crypto.gd` | pure GDScript BIP340, HKDF, AES-GCM |
| `tests/nostr_unit.gd`, `direct-test.sh`, `tests/direct_e2e.gd`, `tests/direct_interop.gd` | Direct unit tests, two-instance test, interop peer |
| `tests/vectors.gd` | the shared spec vectors (frames, invalid, chunking, join codes) |
| `tests/conformance_adapter.gd`, `conformance-adapter.mjs` | `conformance/peer` adapter |
| `tests/e2e.gd`, `headless-test.sh` | two instances host/join by code through a real server and exchange a message |

## Setup and tests

Desktop WebRTC needs the `webrtc-native` GDExtension (not committed): `./fetch-webrtc.sh` (or `fetch-webrtc.ps1`), then
`godot --headless --import --path .` once. Always run headless with `--headless --audio-driver Dummy`.

A desktop export copies `libwebrtc_native.*.dll` (or `.so`, `.dylib`) next to the executable: ship the whole folder, or
the build has no WebRTC. See "Exporting" in the [recipe](../../docs/recipes/godot-gdscript.md).

```
godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/vectors.gd
GODOT=/path/to/godot node conformance/peer/run.mjs --adapter=clients/gdscript/conformance-adapter.mjs
GODOT=/path/to/godot clients/gdscript/headless-test.sh ws://127.0.0.1:8080/ws    # with onelobby-server running
GODOT=/path/to/godot node docs/check-snippets.mjs                                 # parses the recipe's GDScript
```

Notes: 64-bit wire fields (`u64`) are Godot `int`s with the same bits (`OneLobbyWire.u64_to_string` prints them
unsigned). `relayed` on a peer reports `relay_only` (Godot's WebRTC does not expose the selected candidate pair).
