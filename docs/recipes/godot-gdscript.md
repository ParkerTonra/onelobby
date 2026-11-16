# Recipe: Godot 4 GDScript (desktop)

A GDScript-only addon, no .NET: `clients/gdscript/addons/onelobby/`. It does raw mode (your own messages over the host's
star, host migration included), lockstep, replication (host-authoritative binary snapshots, `docs/recipes/replication.md` section 6), text chat and the shared pause (section 4b); voice is C# / JS only. It reads `onelobby.json` too (section 5). Godot 4.4 or newer. Its
`gdscript compile` snippets below are parse-checked by `check-snippets.mjs` when `GODOT` points at a Godot executable.

## One command

`create-onelobby` does sections 1 to 3 below and the test of "Testing headless" for you: it copies the add-on (pinned by `addons/onelobby/PIN.json`),
installs the WebRTC natives (a download whose SHA-256 is checked), registers the autoload `Net` in `project.godot`, writes `onelobby.json`, a
`tests/multiplayer.gd` and an olc entry, and keeps the add-on LF in git.

```
npx create-onelobby my-game --template godot-gdscript --yes                # a new project with the drop-in menu as its main scene
npx create-onelobby --into path/to/your-project                            # an existing GDScript project; your main scene is not touched
cd my-game
godot --headless --import --path .                                         # once: registers the WebRTC extension and the add-on's classes
godot --headless --audio-driver Dummy --path . -s res://tests/multiplayer.gd    # prints MULTIPLAYER_OK (two peers on 127.0.0.1)
```

`npx create-onelobby verify` is THE test command: it checks the add-on against `PIN.json`, the natives and `onelobby.json`, then proves two peers on 127.0.0.1 directly, through a local Nostr relay and relay-only through a local TURN server, and ends with one line, `VERIFY_OK` or `VERIFY_FAIL <check>: <next step>` (add `--fetch-helpers` the first time: it downloads the TURN helper anonymously into the gitignored `.onelobby/`). `npx create-onelobby update` re-vendors the add-on when a new one is out (it stops on files you edited unless `--force`, and tells you to run `godot --headless --import --path .` after).

Players in the world are one command too: add `--mode replication --set sync.player.authority=owner` (or `host`; `--set sync.player.space=2d` for a side-on game), or a
`--recommend "co-op survival sandbox for 4"`, and a new project also gets `player.tscn` / `player.gd` (a character with the `OneLobbyNetPlayer` node that walks and jumps),
`game.gd` (a floor, a camera and the `OneLobbyNetPlayerSpawner`), a main scene that opens the game when the menu starts it, and a player check in `tests/multiplayer.gd`
(the joiner's player appears on the host, follows it, one jump arrives once). They are yours to edit; `update` never rewrites them. `--yes` alone does not turn it on. `--into`
writes no scene into your game: it prints the lines that add the spawner. What the node and the spawner do: `net-player.md` section 10.

For `--into` the output prints the lines that add `res://addons/onelobby/menu/menu.tscn` to your main scene and connect its signals (section 3).
A second run changes nothing; files that exist are skipped and listed (`--force` overwrites them). Flags for offline use: `--webrtc-zip <file>`,
`--webrtc-dir <folder>`, `--no-natives`, `--addon-from <checkout>`; `--dry-run` shows the file list and downloads nothing. A Godot C# project
has its own template (`wrong_template` here): use [godot-csharp.md](godot-csharp.md). Details: `clients/js/packages/create-onelobby/README.md`.

## By hand

What the command did, step by step: sections 1 to 3. The rest of the page (game traffic, chat, pause, lockstep, exporting) is the same either way.

## 1. Add the addon

Copy `clients/gdscript/addons/onelobby/` into your project's `addons/`. It is plain scripts with `class_name`s
(`OneLobbyClient`, `OneLobbyLobby`, `OneLobbyWire`, ...); there is no plugin to enable.

Desktop needs Godot's WebRTC GDExtension: run `clients/gdscript/fetch-webrtc.sh` (or `.ps1`) with your project as the
target folder, or copy `addons/godot_webrtc/` from the `webrtc-native` release, then `godot --headless --import` once.

## 2. Autoload `net.gd`

Add it under Project Settings, Autoload, as `Net`. The lobby server is a setting with a pre-filled default.

```gdscript compile file=net.gd
class_name NetService
extends Node

const DEFAULT_SERVER := "wss://lobby.onelobby.example/ws"

signal status(text: String)
signal message(from: int, text: String)

var client := OneLobbyClient.new()
var lobby: OneLobbyLobby


func _ready() -> void:
	var server := DEFAULT_SERVER
	for arg in OS.get_cmdline_user_args(): # godot -- --lobby-server=ws://127.0.0.1:8080/ws
		if arg.begins_with("--lobby-server="):
			server = arg.get_slice("=", 1)
	var cfg := ConfigFile.new()
	if cfg.load("user://settings.cfg") == OK:
		server = str(cfg.get_value("multiplayer", "lobby_server", server))
	client.game_id = "com.you.yourgame"
	client.net_version = "1"
	client.lobby_server = server
	client.display_name = "Player"
	client.error.connect(func(_code: String, msg: String) -> void: status.emit("Multiplayer unavailable: " + msg))
	add_child(client) # pumps signaling and peer links every frame; signals fire on the main thread


func host() -> String:
	lobby = await client.host({"name": "My game", "max_players": 2, "visibility": "public"})
	if lobby == null:
		return ""
	_wire()
	return OneLobbyJoinCode.display(lobby.code)


func join(code: String) -> bool:
	lobby = await client.join(code) # "7HQ 4K2", "7hq-4k2" and look-alike letters are fine
	if lobby == null:
		return false
	_wire()
	return true


func browse() -> Array:
	return await client.list() # [{code, name, host_name, players, max_players, phase, meta, region}]


func say(text: String) -> void:
	if lobby != null:
		lobby.broadcast(text.to_utf8_buffer()) # reliable; pass OneLobbyWire.FAST for unreliable


func _wire() -> void:
	lobby.peer_ready.connect(func(p: Dictionary) -> void: status.emit("%s connected" % p["name"]))
	lobby.peer_left.connect(func(p: Dictionary, why: String) -> void: status.emit("%s left (%s)" % [p["name"], why]))
	lobby.host_changed.connect(func(id: int) -> void: status.emit("host is now %d" % id))
	lobby.session_ended.connect(func(why: String) -> void:
		status.emit("Session ended: " + why)
		lobby = null)
	lobby.message_received.connect(func(from: int, bytes: PackedByteArray, _channel: int) -> void:
		message.emit(from, bytes.get_string_from_utf8()))
```

## 3. Add the menu scene

One scene gives the player Name, Host, Join (a code, `ip:port` or an invite link), Browse, a lobby with ready / start / kick / ban,
a relay field, a connection check and plain-words errors, all driven by `onelobby.json` (`ui.kind` is `drop-in` for this engine).
Add `res://addons/onelobby/menu/menu.tscn` to your main scene and connect one signal; there is no other game code:

```gdscript compile file=main.gd
extends Control

@onready var menu: OneLobbyMenu = $OneLobbyMenu


func _ready() -> void:
	menu.game_started.connect(func(lobby: OneLobbyLobby) -> void:
		print("go: ", lobby.room.players().size(), " players"))   # the menu hid itself; start your game here
	menu.returned_to_lobby.connect(func(_lobby: OneLobbyLobby) -> void: pass)   # the menu is back; end the match
```

The menu makes its own `OneLobbyClient` from `res://onelobby.json` (`config_path`), pumps it, saves the name, relay line and last code,
and takes `--host`, `--join=<code>` and `--name=<name>` after `--` on the command line. Restyle it with a `Theme`, reword it with a
text table, hand it your own client: [docs/recipes/menu.md](menu.md). A runnable demo: `clients/gdscript/examples/menu_demo/`.

### Build your own

The menu is built on public calls only, so you can draw your own. This is the same flow with hand-made buttons:

```gdscript compile file=menu.gd
extends Control

@onready var net: NetService = get_node("/root/Net")
@onready var status_label: Label = $Status


func _ready() -> void:
	net.status.connect(func(text: String) -> void: status_label.text = text)
	net.message.connect(func(from: int, text: String) -> void: status_label.text = "%d: %s" % [from, text])
	($Host as Button).pressed.connect(_on_host)
	($Join as Button).pressed.connect(_on_join)
	($Browse as Button).pressed.connect(_on_browse)


func _on_host() -> void:
	var code := await net.host()
	if code != "":
		status_label.text = "Share this code: " + code


func _on_join() -> void:
	if await net.join(($Code as LineEdit).text):
		status_label.text = "Joined."
		net.say("hello")


func _on_browse() -> void:
	var list := $Lobbies as ItemList
	list.clear()
	for s: Dictionary in await net.browse():
		list.add_item("%s (%d/%d)" % [s["name"], s["players"], s["max_players"]])
```

## 4. Game traffic

`lobby.send(peer_id, bytes, channel)` / `lobby.broadcast(bytes, channel)` and the `message_received` signal; the rules
are the same as `raw-mode.md` (a joiner's send goes through the host, `from` is always the real sender). Other API:
`lobby.peers()`, `ping_ms(id)`, `start()` / `end_game()` (phase), `set_lobby_meta`, `kick`, `leave()`, and
`client.rejoin(lobby.resume_token)` after a drop. Big payloads are fine: frames over 16 KB are chunked for you.

No lobby server? Direct mode: `await client.host_direct({"name": "My game", "max_players": 4})` shows `lobby.code`
("D1PB-1X9S-FPV"), joiners call `await client.join_direct(code)`; everything after that is the same lobby API. See
`clients/gdscript/README.md`.

To pump from `_physics_process` instead, set `client.auto_pump = false` and call `client.pump()` yourself.

## 4b. Chat, pause and lockstep

Same wire as the JS and C# ones, so players on any client share a lobby. Chat and the shared pause work in raw and lockstep lobbies;
`lobby.lockstep` runs in a lobby the host made with `client.sync_mode = "lockstep"` (set it before `host()`; joiners take the host's
mode; or `sync.mode` in `onelobby.json`). Your game keeps a deterministic sim; OneLobby orders the commands and gives you the frames:

```gdscript compile file=lockstep_game.gd
extends Node

var lobby: OneLobbyLobby
var sim_state := PackedByteArray()
var tick := 0


func attach(l: OneLobbyLobby) -> void: # the lobby comes from net.gd (section 2) with client.sync_mode = "lockstep"
	lobby = l
	lobby.lockstep.snapshot = func() -> PackedByteArray: return sim_state # the state after the last frame you took
	lobby.lockstep.restore = func(t: int, bytes: PackedByteArray) -> void: # a late join or a resync
		sim_state = bytes
		tick = t
	lobby.chat.message.connect(func(line: Dictionary) -> void: print("%d: %s" % [line["peer_id"], line["text"]]))
	lobby.pause.changed.connect(func(s: Dictionary) -> void: get_tree().paused = s["paused"])


func command(bytes: PackedByteArray) -> void:
	lobby.lockstep.submit(bytes) # any peer, any time; it comes back in a frame


func _process(_delta: float) -> void:
	if lobby == null:
		return
	var f := lobby.lockstep.next_frame() # {tick, commands: [{peer_id, bytes}]}, {} when none
	while not f.is_empty():
		tick = f["tick"]
		for c: Dictionary in f["commands"]:
			sim_state = c["bytes"] # a real game applies the command to its state here
		lobby.lockstep.report_hash(tick, hash(sim_state)) # a u64 in an int; sent every hash_every_ticks
		f = lobby.lockstep.next_frame()
```

- The host emits one frame per `tick_rate` and never waits (`lobby.start()` begins it). Ticks count from 1; tick T is the state after
  frame T. Your step must be a pure function of (state, frame): no `randf()`, no frame delta, no physics, same order everywhere.
- `report_hash` is how a drift is found: the host compares hashes, sends a snapshot (your `restore` runs, `lobby.lockstep.desync`
  and `restored` fire) and drops a peer on its third mismatch. A late joiner is served from `snapshot`.
- `lobby.pause.request(true)` (after `start()`) pauses everyone: the host stops its frames. `pause.policy` and `pause.clear()` are host only.
- `lobby.chat.send(text)`: 256 bytes, a burst of 3 then 5 per 5 s per player, control characters stripped.
- Input redundancy (sending the last few ticks of input on the fast channel) is not in the wire yet: commands travel on the reliable channel.

## 5. From onelobby.json (optional)

Every multiplayer choice can live in one file, `onelobby.json` (schema `spec/blueprint.schema.json`; smallest file
`{ "game": { "id": "com.you.yourgame" }, "engine": "godot-gdscript" }`). `OneLobbyClient.from_config` reads it and
`host()` / `join()` take their defaults from it, so the autoload shrinks to a few lines:

```gdscript compile file=net_blueprint.gd
extends Node

var client: OneLobbyClient
var lobby: OneLobbyLobby


func _ready() -> void:
	client = OneLobbyClient.from_config("res://onelobby.json", {"display_name": "Sam"})
	if not client.config_error.is_empty():
		push_error(client.config_error["message"]) # path and rule are in the dictionary too
	add_child(client)


func host() -> String:
	lobby = await client.host() # a lobby server when hosting.server is true, else a direct lobby with a Nostr code
	return lobby.code if lobby != null else ""


func join(code: String) -> bool:
	lobby = await client.join(code) # a lobby code goes to the server, a direct code or an address to join_direct
	if lobby == null:
		push_error(OneLobbyFriendly.describe_error(client.last_error)["message"]) # plain words for the player
	return lobby != null
```

- Add `*.json` (or `onelobby.json`) to the export preset's "Filters to export non-resource files", or the exported game has no file.
- GDScript speaks `sync.mode` `"raw"`, `"lockstep"` (`sync.tickRate`, `sync.hashEveryTicks`) and `"replication"` (`from_config` gives a raw
  lobby; build `OneLobbyReplicationSession.new(lobby)` on it, see docs/recipes/replication.md). `chat.text` false and `session.pause` `"off"` (the
  default) make `lobby.chat.send()` / `lobby.pause.request()` raise the client error `chat_disabled` / `pause_disabled`.
- `OneLobbyConfig.load_file()` gives the validated fields (`cfg.lobby["max_players"]`, `cfg.hosting["lobby_server"]`, ...) and
  `ok` / `error` without making a client; `OneLobbyFriendly.describe_error(...)` and `OneLobbyInvite.make(code, base_url)` /
  `OneLobbyInvite.parse(text)` are the player-facing helpers (same text and link format as JS and C#).

## Testing headless

`clients/gdscript/headless-test.sh ws://127.0.0.1:8080/ws` runs two headless instances that host/join by code and
exchange a message; `tests/vectors.gd` runs the spec vectors; `conformance-adapter.mjs` runs `conformance/peer`.
Always pass `--headless --audio-driver Dummy`.

Godot's WebRTC loads and works under `--headless`. Several processes on one PC are separate peers; `user://` is shared
between them, so give your own settings or save files a per-process suffix (the addon itself does not use `user://`).
On one PC the data almost certainly stays on the machine, so such a run proves your game logic and signaling, not NAT
traversal, real latency or real loss.

## Exporting

A Windows export with `webrtc-native` in `addons/` writes three files, with no extra setup and no .NET:

```
game.exe
game.pck
libwebrtc_native.windows.template_release.x86_64.dll
```

- Ship the DLL beside the exe. Without it the build has no WebRTC.
- `-s res://...` does not work in an exported build: official templates ignore it, and the main scene runs instead.
  To test the export, have your main scene or an autoload read a flag from `OS.get_cmdline_user_args()`:
  `./game.exe --headless --audio-driver Dummy -- --my-test-role=host`.

## Done when

- The menu (the scene, or your own buttons) shows Host / Join / Browse and the project opens without script errors.
- With a local `onelobby-server`, two Godot instances (`-- --lobby-server=ws://127.0.0.1:8080/ws`; use 127.0.0.1, not
  localhost): one presses Host and shows a code, the other joins it, and its "hello" shows on the host.
- With the server address wrong, the game still starts and the menu shows "Multiplayer unavailable".
