extends Control
## The drop-in menu is the whole front end; the game starts when it says so. Flags after `--`:
##   godot --path . -- --host --name=Sam            (--local: 127.0.0.1 only, no Nostr, nothing leaves this PC)
##   godot --path . -- --join=<code or ip:port> --name=Ann

@onready var menu: OneLobbyMenu = $Menu
@onready var in_game: Label = $InGame


func _enter_tree() -> void:
	$Menu.client = Net.client # the menu drives the autoload's client; set before the menu's own _ready


func _ready() -> void:
	in_game.hide()
	menu.game_started.connect(func(lobby: OneLobbyLobby) -> void:
		var names := PackedStringArray(lobby.room.players().map(func(p: Dictionary) -> String: return p["name"]))
		in_game.text = "in game: " + ", ".join(names) # start your game here; the menu hid itself
		in_game.show())
	menu.returned_to_lobby.connect(func(_lobby: OneLobbyLobby) -> void: in_game.hide()) # end the match
	menu.left.connect(func() -> void: in_game.hide())
	var args := OS.get_cmdline_user_args()
	if "--local" in args:
		menu.route = "direct"
		menu.host_options = {"nostr": false, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1"}
	menu.model.apply_boot_flags(args) # --host, --join=<code> and --name=<name> (boot_flags is off in main.tscn so --local lands first)
