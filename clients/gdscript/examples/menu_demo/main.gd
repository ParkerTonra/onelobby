extends Control
## The whole integration: the menu scene is a child, and the game starts when it says so.
##   godot --path clients/gdscript res://examples/menu_demo/main.tscn -- --host      (or --join=<code>, --name=Sam)

@onready var menu: OneLobbyMenu = $Menu
@onready var in_game: Label = $InGame


func _ready() -> void:
	in_game.hide()
	menu.game_started.connect(func(lobby: OneLobbyLobby) -> void:
		in_game.text = "in game (%d players)" % lobby.room.players().size()
		in_game.show())
	menu.returned_to_lobby.connect(func(_lobby: OneLobbyLobby) -> void: in_game.hide())
