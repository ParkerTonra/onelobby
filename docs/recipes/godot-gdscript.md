# Recipe: Godot 4 GDScript (desktop)

A GDScript-only addon, no .NET: `clients/gdscript/addons/onelobby/`. It is raw mode (your own messages over the host's
star, host migration included); lockstep, voice and replication are C# / JS only for now. It reads `onelobby.json` too (section 5). Godot 4.4 or newer. Its
`gdscript compile` snippets below are parse-checked by `check-snippets.mjs` when `GODOT` points at a Godot executable.

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

## 3. Host / Join / Browse buttons

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
- GDScript speaks `sync.mode` `"raw"` only: `lockstep` and `replication` fail `from_config` with `bad_config`, rule
  `gdscript_raw_only` (C# and JS read the same file fully).
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

- The menu shows Host / Join / Browse and the project opens without script errors.
- With a local `onelobby-server`, two Godot instances (`-- --lobby-server=ws://127.0.0.1:8080/ws`; use 127.0.0.1, not
  localhost): one presses Host and shows a code, the other joins it, and its "hello" shows on the host.
- With the server address wrong, the game still starts and the menu shows "Multiplayer unavailable".
