extends Control
## The menu demo plus a game you can see: after "game started" a flat floor and one capsule per player, walking with the arrow keys
## or WASD and jumping with space. Every machine runs the same scene; the OneLobbyNetPlayer node in each capsule does the networking.
##   host:    godot --path clients/gdscript res://examples/net_player_demo/main.tscn -- --host --local --name=Sam
##   joiner:  godot --path clients/gdscript res://examples/net_player_demo/main.tscn -- --join=127.0.0.1:47810 --local --name=Alex
## (`--local` keeps both on 127.0.0.1; the game starts by itself when the second player is in). Add `--netplayer-test` to both and
## run them headless: the joiner walks a scripted path and the host prints NETPLAYER_OK or NETPLAYER_FAIL <why>.

const Game := preload("res://examples/net_player_demo/game.gd")

@onready var menu: OneLobbyMenu = $Menu

var game: Node3D


func _ready() -> void:
	menu.game_started.connect(func(lobby: OneLobbyLobby) -> void:
		if game != null:
			return
		game = Game.new()
		add_child(game)
		game.start(lobby, OneLobbyConfig.load_file(menu.config_path)))
