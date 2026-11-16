# onelobby (Godot 4, GDScript)

A pure GDScript client for Godot 4.4+, no .NET. Raw, lockstep and replication modes, through a lobby server or Direct (no server, Nostr join codes): your own messages over the host's star (a joiner's
send goes through the host, `from` is always the real sender), host migration, chunking of big payloads, join codes,
lobby browse, kick/approve, rejoin, text chat, the shared pause, lockstep, the room layer (below) `OneLobbyReplicationSession` (binary delta snapshots, the same wire as C# and JS: [docs/recipes/replication.md](../../docs/recipes/replication.md) section 6) and `onelobby.json` (`OneLobbyConfig`, below). Voice is in the C# and JS clients. Written from `spec/`;
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

## The drop-in menu

`addons/onelobby/menu/menu.tscn` (`OneLobbyMenu`) is a whole multiplayer menu: name, host, join by code / address / invite link, browse, lobby with ready / start / kick / ban, relay field, connection check and plain-words errors, driven by `onelobby.json`. Add the scene, connect `game_started(lobby)`, done. The logic is `OneLobbyMenuModel` (no nodes), every string is in `OneLobbyMenuText`. [docs/recipes/menu.md](../../docs/recipes/menu.md); demo: `examples/menu_demo/`; tests: `tests/menu.gd`, `tests/menu_scene.gd`.

## From onelobby.json

One settings file for the game's multiplayer (`spec/blueprint.schema.json`, `docs/design/blueprint.md`; the same file JS and C#
read). `from_config` makes a client from it and `host()` / `join()` do the rest:

```gdscript
var client := OneLobbyClient.from_config("res://onelobby.json", {"display_name": "Sam"})   # path, OneLobbyConfig or Dictionary
if not client.config_error.is_empty(): push_error(client.config_error["message"])           # {code, path, rule, message}
add_child(client)
var lobby := await client.host()        # max players, visibility, late join, meta, rate limit from the file; hosting.server false = direct lobby
var lobby := await client.join(code)    # lobby code -> server; direct code or "ip:port" -> join_direct
```

`OneLobbyConfig.load_file(path = "res://onelobby.json")` / `parse(text_or_dictionary)` give the validated file with every default
filled in and never throw: check `cfg.ok` and read `cfg.error`. Fields: `game_id`, `net_version`, `title`, `engine`, and the sections
`hosting`, `lobby`, `sync`, `players`, `chat`, `session`, `platforms`, `ui` as snake_case dictionaries (`cfg.hosting["lobby_server"]`);
`cfg.data` is the camelCase tree of the file. `engine` may be `godot-gdscript` (a direct-only game by default). The rules, defaults and
failures are the shared ones (`spec/vectors/blueprint.json`), with these GDScript specifics:

- `from_config` overrides: `display_name` (checked against `players.identity` / `players.maxNameLength`), `lobby_server` (wins over the file).
- `sync.mode` `raw` and `lockstep` run (`sync.tickRate` and `sync.hashEveryTicks` set `client.tick_rate` and `hash_every_ticks`). `replication`
  builds a raw lobby (`from_config` sets `sync_mode` raw); you build an `OneLobbyReplicationSession` on it (docs/recipes/replication.md). `chat.text` false makes `lobby.chat.send()` raise the
  client error `chat_disabled`; `session.pause` is `"off"` (the default: `lobby.pause.request()` raises `pause_disabled`), `"host"` or
  `"anyone"`. `chat.voice` and `session.hostLeaves` are read but not enforced (no voice in GDScript).
- `list()` with `hosting.server` false fails `listing_disabled`; a lobby code with no server fails `no_server`; a name for an
  anonymous game fails `identity_anonymous`. All arrive as `client.last_error` and the `error` signal like any other failure.
- The file must be in the export (export preset, "Filters to export non-resource files": `*.json`). JSON comments are not allowed (GDScript's parser has none).
- `hosting.openPort` (UPnP) and `lobby.password` are read but not applied; pass `upnp_port` / `password` to `host_direct` yourself.
- The `room` section is read: `cfg.room` (snake_case keys, `data` as in the file) and `cfg.room_options()`; `host()` / `host_direct()` take it as
  the default for their `room` option. `room.lateJoin` defaults from `lobby.lateJoin` and the cross rules `late_join_conflict`,
  `min_exceeds_max` and `autostart_exceeds_players` apply (`spec/vectors/blueprint.json` `roomValid` / `roomInvalid`).

### Plain-language errors and invite links

```gdscript
var d := OneLobbyFriendly.describe_error(client.last_error)   # {code, message, hint?}: the JS describeError text, word for word
label.text = d["message"] + (" " + d["hint"] if d.has("hint") else "")
var link := OneLobbyInvite.make(lobby.code, "https://game.example/play")   # "https://game.example/play?join=7HQ-4K2" ("" if invalid)
var code := OneLobbyInvite.parse(pasted)    # "7HQ4K2" from a pasted link (query or #fragment, "+" or "%20" for a space), else ""
```

`describe_error` also takes a bare code, a `"code: text"` string, or a Dictionary `{code, data, message, name}`. Invite links carry
lobby codes of a server lobby only and are not registered with the OS (a deep link is the game's job). Both match JS (`describeError`,
`shareUrl`, `codeFromUrl`) and C# (`Friendly.DescribeError`, `InviteLink.Make` / `Parse`) through `spec/vectors/describe-error.json` and
`invite-link.json`.

## Telling the player why a connection failed

`OneLobbyFriendly.describe_error(client.last_error)` returns `cause` and `stage` next to the unchanged code for a failure that
knows why (`last_error["diagnosis"]` is `{cause, message, hint, stage}`). The host gets `lobby.peer_diagnosis` (`info["line"]`:
"Sam: strict NAT, no relay set, stopped at the connection check after 15 s."), `client.get_net_log().export()` is the Copy-logs text
(masked), and `await client.check_connection()` runs the connection check (raw UDP through `PacketPeerUDP`, a TURN Allocate probe
for the relay; names are resolved without blocking a frame and asked over IPv4 first). The drop-in menu runs it once when it opens
(`diagnostics.checkOnOpen: false` in `onelobby.json` for button only; never with `--local`). The log is saved to `log_path` (`user://onelobby-netlog.txt`) when the scene tree exits and after every `error`
entry: GDScript cannot hook a crash. Exports: `report_to_host`, `log_size`, `log_path`, `relay_probe`. See
`docs/recipes/diagnostics.md`.

## Text chat, shared pause and lockstep

All three are on the same wire as the JS and C# ones, so GDScript, JS and C# players mix in one lobby (server and Direct,
host or joiner). Details and the rules: `spec/binary.md` (Chat, Pause, Lockstep), `docs/recipes/godot-gdscript.md`.

```gdscript
lobby.chat.message.connect(func(line: Dictionary) -> void: print(line["peer_id"], ": ", line["text"]))   # {peer_id, id, ts, text}
lobby.chat.send("gg")             # 256 bytes, burst of 3 then 5 per 5 s; lobby.chat.rejected(id, "rate" | "length" | "muted_by_host")
lobby.chat.host_mute(peer_id, true)   # host only; lobby.chat.history() has the last 100 lines

lobby.pause.changed.connect(func(s: Dictionary) -> void: get_tree().paused = s["paused"])   # {paused, by_peer, pauser_left}
lobby.pause.request(true)         # after start(); lobby.pause.refused("not_in_game" | "rate_limited" | "not_allowed")
lobby.pause.can_resume; lobby.pause.policy = func(peer: int, want_paused: bool) -> bool: return true   # policy and clear(): host only
lobby.pause.clear()

client.sync_mode = "lockstep"     # before host(); a joiner takes the host's mode (or sync.mode in onelobby.json)
lobby.lockstep.snapshot = func() -> PackedByteArray: return game.save()                 # state after the last frame you took
lobby.lockstep.restore = func(tick: int, bytes: PackedByteArray) -> void: game.load(tick, bytes)
lobby.lockstep.submit(command_bytes)
func _process(_dt: float) -> void:
    var f := lobby.lockstep.next_frame()                    # {tick, commands: [{peer_id, bytes}]}, {} when none
    while not f.is_empty():
        var h := game.step(f["tick"], f["commands"])        # deterministic; h is a u64 in an int
        lobby.lockstep.report_hash(f["tick"], h)            # sent every hash_every_ticks (default: once a second)
        f = lobby.lockstep.next_frame()
```

The host emits one frame per tick and never waits (`lobby.start()` begins it; a shared pause stops it). A hash mismatch makes the
host send a snapshot (your `restore` runs; signals `lobby.lockstep.desync` and `restored`); a third mismatch drops that peer.
A late joiner is served from `snapshot` (deflated above 1 KiB, as in JS and C#). `lobby.lockstep.catching_up` is true when more
than 2 frames are waiting. Tests: `tests/sync.gd` (real peers on loopback) and, against JS and C# peers, `tools/engine-smoke`.

## Room layer (ready, countdown, spectators, kick and ban)

`lobby.room` is the roster a lobby screen shows, on the same wire as the JS and C# ones (`spec/room.md`): per-player data
(colour, avatar, team, your own keys), ready, a start countdown, auto start, back to lobby and rematch, spectators, seats that
stay with a player, a "reconnecting" state, a `seat_dropped` hook, kick and ban with a reason the player sees, bans that survive
the lobby (keyed by a per-install player id, kept in `client.store`), and a password on every route. Recipe and signals:
[docs/recipes/room.md](../../docs/recipes/room.md) (section "GDScript"); tests: `tests/room_vectors.gd`, `tests/room.gd`.

```gdscript
lobby.room.set_data({"color": "#ff8800"}); lobby.room.set_ready(true)           # a joiner asks, the host decides: `rejected(code, re, key)` on refusal
lobby.room.changed.connect(func() -> void: draw(lobby.room.entries()))            # {id, name, role, seat, ready, status, data}
lobby.room.started.connect(func() -> void: print("go"))                           # after the host's countdown; lobby.phase is "in_game"
lobby.room.start(); lobby.room.kick(peer_id, {"reason": "afk"}); lobby.room.ban(peer_id, {})   # host; the player gets lobby.removal {code, reason, ban}
var lobby := await client.host({"password": "tulip", "room": {"spectators": 2, "auto_start": "all_ready"}})
var lobby := await client.join(code, {"password": "tulip", "role": "spectator"})
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
joiners get `session_ended("host_left")`. `rejoin_direct(code, token)` takes a seat back.

### Join by IP (no relay, no Nostr)

For players a relay cannot help (or when you would rather not use one), the host port-forwards a known UDP range and
friends join by the host's address:

```gdscript
# host: forward TCP 47810 and UDP 47900-47909 on the router (UPnP is not used)
var lobby := await client.host_direct({"udp_port_range": [47900, 47909], "public_ip": "203.0.113.7"})
print(lobby.ip_code)    # version 0 code of 203.0.113.7:47810, e.g. "6B01-RGFE-P2B"; lobby.code is still the Nostr code

# joiner: the v0 code, or a plain address ("203.0.113.7" or "203.0.113.7:47810")
var lobby := await client.join_direct("6B01-RGFE-P2B")
```

Options: `udp_port_range` `[begin, end]` (turns the IP path on; applies to every peer connection the host makes),
`tcp_port` (signaling, default 47810; 0 picks a free one), `public_ip` (the address put in the code; default: this
machine's first private IPv4, which only works on the same network), `listen_address` (default `"*"`; `"127.0.0.1"`
keeps it on this machine), `nostr: false` (skip the relays: no internet needed, `lobby.code` is the IP code).
**One UDP port per player:** a range of N ports serves N joiners at once (ports free up when a player leaves). When the
range is used up the host gets an `ice_failed` error naming the range ("No free UDP port left in the host's port range
..."), not a hang; widen the range or use TURN. A joiner that cannot connect gets `ice_failed` saying the host must
port-forward its UDP range or use TURN. webrtc-native only honours the range inside a nested `{"libdatachannel":
{"portRangeBegin", "portRangeEnd"}}` config dictionary (a top-level key is ignored); the addon does that for you.
Browser joiners are not supported on this path (Godot's WebSocket server checks no `Origin`, so a rebound page could
connect: keep `listen_address` private when testing).

Players behind a strict NAT (symmetric, carrier-grade) cannot open a direct link to anyone; a TURN relay gets them in.
Pass `ice_servers` (`[{urls, username, credential}]`) to `host_direct` (every joiner gets it in the welcome) or to
`join_direct` (added to the host's list). For a TURN server with a shared secret, `OneLobbyTurn.login(secret, id, ttl)`
mints a short-lived login. Godot's WebRTC reaches TURN over UDP only (libjuice): `?transport=tcp` and `turns:` URLs
are skipped, so a network that blocks all UDP still cannot connect. `client.relay_only = true` forces the relay (to
test it). Setup, coturn and hosted options, expiring logins: `docs/recipes/turn.md`. A settings field where a player pastes their own relay (`turn:host:3478 user pass`): `OneLobbyTurn.parse_line(text)` returns `{ok, server, error, warnings}` (warns on `turns:` / `?transport=tcp`), and `server` goes into `ice_servers` (docs/recipes/turn.md, "Let players set their own relay"). Keep TURN passwords out of your repo: read them from an environment variable at export time.

Tests, no lobby server: `GODOT=... clients/gdscript/direct-test.sh` (two instances, real WebRTC, a local test relay;
pass `public` to use the real relays) and `GODOT=... node integration/nostr-interop-gdscript.mjs` (against the JS client,
both directions).

## Saved player settings

`client.settings` (`OneLobbySettings`) keeps the player's name, TURN relay line, last join code and lobby server in `client.store`
(by default `user://onelobby.json`) and applies them as defaults: an empty `display_name` (or "Player") and an empty `lobby_server`
take the saved ones, the saved relay entry joins `client.ice`, `last_code` is written after a host or join. `client.settings.save({"relay": text})`
returns `{ok, rejected}`, `client.settings.masked_relay()` is the text for a settings field, `client.settings_use["relay"] = false` switches a
default off, and `ONELOBBY_NAME`, `ONELOBBY_RELAY`, `ONELOBBY_LAST_CODE` and `ONELOBBY_LOBBY_SERVER` (`OS.get_environment`) override for a run.
Recipe: `docs/recipes/settings.md`; contract: `spec/settings.md`; test: `tests/settings.gd`.

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
| `addons/onelobby/config.gd` | `OneLobbyConfig`: load and validate `onelobby.json`; `OneLobbyClient.from_config` (in client.gd) runs from it |
| `addons/onelobby/friendly.gd`, `invite.gd` | `OneLobbyFriendly.describe_error`; `OneLobbyInvite.make` / `parse` |
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
| `tests/relay_retry.gd` | ready-timeout relay-only retry and the ice_failed message (no network) |
| `tests/vectors.gd` | the shared spec vectors (frames, invalid, chunking, join codes) |
| `tests/blueprint.gd` | `OneLobbyConfig` against `spec/vectors/blueprint.json`, `from_config`, one-call host and join on 127.0.0.1 |
| `tests/friendly.gd` | `describe_error`, the `ice_failed` messages and invite links against their shared vectors |
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
