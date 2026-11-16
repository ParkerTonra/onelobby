extends Control
## The drop-in menu is the whole front end; the game (game.gd) starts when it says so, and one character per player appears in it.
## Flags after `--`:
##   godot --path . -- --host --name=Sam            (--local: 127.0.0.1 only, no Nostr, nothing leaves this PC)
##   godot --path . -- --join=<code or ip:port> --name=Ann
##   add --autostart to BOTH copies for a test with no clicks: the host starts the match as soon as a second player has joined, and
##   every copy walks its own player and prints one line when it sees another player move (see game.gd):
##     godot --headless --audio-driver Dummy --path . --quit-after 1500 -- --host --local --autostart --name=Sam
##     godot --headless --audio-driver Dummy --path . --quit-after 1500 -- --join=127.0.0.1:47810 --local --autostart --name=Ann

const Game := preload("res://game.gd")

@onready var menu: OneLobbyMenu = $Menu

var game: Node
var _autostart := "--autostart" in OS.get_cmdline_user_args() # tests only: no menu click needed to start the match
var _autostarted := false


func _enter_tree() -> void:
	$Menu.client = Net.client # the menu drives the autoload's client; set before the menu's own _ready


func _ready() -> void:
	menu.game_started.connect(func(lobby: OneLobbyLobby) -> void:
		if game != null:
			return
		game = Game.new()
		add_child(game)
		game.start(lobby, Net.client.config)) # the menu hid itself; the lobby and onelobby.json go to the game
	menu.returned_to_lobby.connect(func(_lobby: OneLobbyLobby) -> void: _end_game()) # end the match
	menu.left.connect(_end_game)
	# --host, --join=<code>, --name=<name> and --local are the menu's own boot flags (boot_flags is on): nothing to do here
	if _autostart:
		menu.model.changed.connect(_try_autostart)


## --autostart: the host starts the match by itself, once, as soon as a second player is in the room (what the Start button does).
func _try_autostart() -> void:
	var m := menu.model
	if _autostarted or game != null or m.lobby == null or not m.lobby.is_host or m.lobby.room.players().size() < 2:
		return
	_autostarted = true
	m.start_game()


func _end_game() -> void:
	if game != null:
		game.queue_free()
		game = null
