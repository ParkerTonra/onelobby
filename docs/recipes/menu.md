# Recipe: the drop-in menu for Godot (GDScript)

One scene, `res://addons/onelobby/menu/menu.tscn`, is the whole multiplayer front end: the player types a name, hosts, or joins with a
code, an `ip:port` or an invite link, waits in a lobby with a roster, readies up, and the host starts the game. When it works the
menu says so with a signal; when it does not, it says why in plain words. No game code beyond one connected signal.

```gdscript compile file=menu-hookup.gd
extends Node

@onready var menu: OneLobbyMenu = $OneLobbyMenu


func _ready() -> void:
	menu.game_started.connect(_on_game_started)
	menu.returned_to_lobby.connect(_on_back_in_lobby)
	menu.left.connect(_on_left)


func _on_game_started(lobby: OneLobbyLobby) -> void:
	print("start the match with ", lobby.room.players().size(), " players")


func _on_back_in_lobby(_lobby: OneLobbyLobby) -> void:
	print("end the match; the menu is showing the lobby again")


func _on_left() -> void:
	print("the player left the lobby")
```

## What it shows

- **Start.** Name (cleaned with the room's name rules and saved), Host, Join (cleaned as typed; offers the last code), Password,
  Browse (only when a lobby server is set), Settings.
- **Connecting.** What is being tried, and Cancel.
- **Lobby.** The code, large, with Copy code (and Copy invite when `invite_base` is set and the code is a lobby-server code); the roster
  (host mark, ready, watching, reconnecting, ping); a Ready toggle; for the host Start (everyone sees the countdown, the host can
  cancel it), Kick and Ban on every row with an optional reason, the ban list with Unban, the lobby settings the room layer lets the host
  change (start by itself, players needed, countdown, late join), and Let in / Refuse when the lobby asks to approve joins; text chat when
  `chat.text` is on; Leave. Against a host that has no room layer the lobby falls back to a plain peer list.
- **Removed / Error.** The sentence and the next step from `OneLobbyFriendly` and `OneLobbyDiagnose`, the code small underneath, Copy logs
  and Save logs (the net log, addresses masked), Back. A kicked or banned player reads the host's reason.
- **Settings.** The relay line (pasted, only ever shown masked, with its status), the lobby server, the Connection check (a one-line
  verdict and three facts) and Copy logs.

## Hand-off

| | |
|---|---|
| `game_started(lobby)` | the host started the game, or the player joined one already running; the menu hides itself when `auto_hide_on_start` is true (default) |
| `returned_to_lobby(lobby)` | the game went back to the lobby (`lobby.room.back_to_lobby()`); the menu shows again |
| `left()` | the player left the lobby |
| `client` | the `OneLobbyClient` the menu drives; default `OneLobbyClient.from_config(config_path)` (`config_path` defaults to `res://onelobby.json`). Set it before the menu enters the tree to use your own. |
| `pump` | true: the menu calls `client.pump()` every frame. Set false when your game pumps. |
| `host_options`, `join_options`, `route` | passed to `host()` / `join()`; `route` is `auto` (the blueprint decides), `direct` or `server` |
| `invite_base`, `texts`, `boot_flags`, `boot_args` | see below |

The lobby is `menu.client.lobby` (the signal gives it to you too). Nothing else is required of the game.

## Boot flags

With `boot_flags` on (default), `--host`, `--join=<code>` and `--name=<name>` after `--` act at once:

```
godot --path . -- --host --name=Sam
godot --path . -- --join=D1PB-1X9S-FPV --name=Ann
```

One switch (`boot_flags = false`) turns all three off. Tests give the flags to a menu with `boot_args` instead of the process command line.

## Restyling

The scene is stock Godot controls on the engine's default theme: no fonts, colours, images or sounds of its own (the join code and the
error code only change a font size). Give the menu, or any parent of it, a `Theme` resource and everything follows. `ui.theme` of the blueprint
is for the web element and does not apply here.

```gdscript compile file=menu-theme.gd
extends Control

@export var game_theme: Theme


func _ready() -> void:
	var menu: OneLobbyMenu = $OneLobbyMenu
	menu.theme = game_theme
```

## Rewording and translating

Every string of the menu is in `OneLobbyMenuText.TABLE`. Give the menu a Dictionary of the keys to change (`texts`, or
`OneLobbyMenuText.override(...)` before the menu appears):

```gdscript compile file=menu-text.gd
extends Node


func _ready() -> void:
	OneLobbyMenuText.override({"host": "Create game", "join": "Enter game", "players_header": "In this game: %d of %d"})
```

Sentences about errors, removals and the connection check come from the library (`OneLobbyFriendly`, `OneLobbyDiagnose`, the room's
removal reasons), so they are reworded at their source.

## What each blueprint key switches

| Key | Effect on the menu |
|---|---|
| `ui.kind` | `drop-in` (the default for `godot-gdscript`) is this menu; `generated` / `none` mean you draw your own |
| `players.identity: "anonymous"` | no name field |
| `players.maxNameLength` | the name is cut at this length |
| `hosting.server` / `hosting.lobbyServer` | Host and Join use the lobby server; without them a direct lobby with a Nostr code. Browse needs a server. |
| `lobby.approveJoins` | the host sees Let in / Refuse |
| `chat.text` | the lobby shows the chat box |
| `room.*` | countdown, auto start, spectators, late join, seat rules: the room layer's, shown as it runs |
| `diagnostics.showConnectionCheck` | false hides the Connection check button in Settings |
| `diagnostics.reportToHost`, `logSize`, `relayProbe` | applied to the client by `from_config` |

## For a controller of your own (C# or script)

`menu.gd` draws `OneLobbyMenuModel` (no nodes, takes its client by injection: `OneLobbyMenuModel.new(client)`, then `host()`, `join()`,
`toggle_ready()`, `start_game()`, `kick()`, `ban()`, `leave()`, ... and `changed`). Every node a controller may touch has a unique name
(`%HostButton`, `%RosterList`, ...); the list is the comment at the top of `menu.gd`, and `tests/menu_scene.gd` checks it. Roster, ban,
request and browse rows are built at run time inside `RosterList`, `BansList`, `RequestsList` and `BrowseList`.

## Not in the menu yet

Changing max players, the password or the listing of a lobby that is already open (the room layer does not offer it), voice, name tags,
quick chat, and a scoreboard overlay.

Tests: `clients/gdscript/tests/menu.gd` (the model, with real peers on 127.0.0.1) and `tests/menu_scene.gd` (the scene at 1280x720 and
640x360, and the demo with `--host` / `--join`).
