extends Control
## The drop-in menu is the whole front end; the game (game.gd) starts when it says so, and one character per player appears in it.
## Flags after `--`:
##   godot --path . -- --host --name=Sam            (--local: 127.0.0.1 only, no Nostr, nothing leaves this PC)
##   godot --path . -- --join=<code or ip:port> --name=Ann
##   add --autostart to BOTH copies for a test with no clicks: the menu's own flag makes the host start the match as soon as a second player
##   has joined, and every copy walks its own player and prints one line when it sees another player move (see game.gd):
##     timeout 90 godot --headless --audio-driver Dummy --path . --log-file host.log -- --host --local --autostart --name=Sam
##     timeout 90 godot --headless --audio-driver Dummy --path . --log-file join.log -- --join=<the code host.log prints after "join code"> --local --autostart --name=Ann
##   (join by the printed code, not a fixed port; stop by timeout, not --quit-after, which counts frames; --log-file because redirected stdout is lost on a kill)

const Game := preload("res://game.gd")

@onready var menu: OneLobbyMenu = $Menu

var game: Node


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
	# --host, --join=<code>, --name=<name>, --local and --autostart are the menu's own boot flags (boot_flags is on): nothing to do here


func _end_game() -> void:
	if game != null:
		game.queue_free()
		game = null
