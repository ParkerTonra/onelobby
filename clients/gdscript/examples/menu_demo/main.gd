extends Control
## The whole integration: the menu scene is a child, and the game starts when it says so.
##   godot --path clients/gdscript res://examples/menu_demo/main.tscn -- --host      (or --join=<code>, --name=Sam)
## The blueprint has hosting.lan on: on one PC, a host window with `-- --local --host --name=Sam` and a second window with
## `-- --local --name=Ann` (press Browse games) show the host in the LAN games list.

@onready var menu: OneLobbyMenu = $Menu
@onready var in_game: Label = $InGame


func _ready() -> void:
	in_game.hide()
	menu.game_started.connect(func(lobby: OneLobbyLobby) -> void:
		in_game.text = "in game (%d players)" % lobby.room.players().size()
		in_game.show())
	menu.returned_to_lobby.connect(func(_lobby: OneLobbyLobby) -> void: in_game.hide())
