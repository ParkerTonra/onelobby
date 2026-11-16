extends Node2D
## The game, started by main.gd when the menu says the game started: a flat floor, a camera that follows your character and one
## character (player.tscn) per player in the lobby. All the networking is the spawner below and the OneLobbyNetPlayer node inside
## player.tscn; this script builds the world and hands them the lobby. Yours to edit: put your own level in _build_world().
## Players who join or leave later appear and disappear on their own.

const PlayerScene := preload("res://player.tscn")
#@if host
const PlayerScript := preload("res://player.gd") # its static step() is the movement the host and every owner run
#@end

var spawner: OneLobbyNetPlayerSpawner
var players: OneLobbyNetPlayers # the layer behind the spawner: players.stats, players.rewound(...), players.host_action(...)
var lobby: OneLobbyLobby
var camera: Camera2D
var local_character: Node2D
var _autotest := "--autostart" in OS.get_cmdline_user_args() # tests only (see main.gd): this copy walks its player and reports movers
var _seen := {} # peer -> x where this copy first saw that player
var _reported := {}


## `game_lobby`: the menu's `game_started` lobby; `cfg`: the game's onelobby.json (Net.client.config).
func start(game_lobby: OneLobbyLobby, cfg: OneLobbyConfig) -> void:
	lobby = game_lobby
	_build_world()
	spawner = OneLobbyNetPlayerSpawner.new()
	spawner.scene = PlayerScene
	spawner.spawn_point = func(peer: int) -> Vector2: return Vector2(-120.0 + 80.0 * float(_seat(peer)), -16.0) # a place per seat, standing on the floor
#@if host
	spawner.step_function = PlayerScript.step
#@end
	spawner.player_spawned.connect(_on_spawned)
	add_child(spawner)
	players = spawner.start(game_lobby, cfg)
	if _autotest:
		Input.action_press("ui_right") # the arrow key, held by code: the local player walks right with nobody at the keyboard


func _seat(peer: int) -> int:
	return maxi(0, int(lobby.room.player(peer).get("seat", 0)))


func _on_spawned(peer: int, character: Node, is_local: bool) -> void:
	character.call("setup", str(lobby.room.player(peer).get("name", "player %d" % peer)), _seat(peer))
	if is_local:
		local_character = character as Node2D


func _build_world() -> void:
	var floor_body := StaticBody2D.new()
	var shape := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = Vector2(4000.0, 40.0)
	shape.shape = box
	floor_body.add_child(shape)
	var visual := Polygon2D.new()
	visual.polygon = PackedVector2Array([Vector2(-2000.0, -20.0), Vector2(2000.0, -20.0), Vector2(2000.0, 20.0), Vector2(-2000.0, 20.0)])
	visual.color = Color(0.35, 0.4, 0.35)
	floor_body.add_child(visual)
	floor_body.position = Vector2(0.0, 20.0) # the top is at y = 0
	add_child(floor_body)
	camera = Camera2D.new()
	camera.position = Vector2(0.0, -120.0)
	add_child(camera)
	camera.make_current()


func _process(_delta: float) -> void:
	if _autotest:
		_report_movers()
	if local_character != null and is_instance_valid(local_character):
		camera.global_position = camera.global_position.lerp(local_character.global_position + Vector2(0.0, -80.0), 0.1)


## --autostart: print one line per other player this copy has seen move more than two units.
func _report_movers() -> void:
	for e: Dictionary in lobby.room.players():
		var peer := int(e["id"])
		var c := spawner.character_of(peer) as Node2D
		if peer == lobby.local_peer_id or c == null or not c.visible or _reported.has(peer):
			continue
		if not _seen.has(peer):
			_seen[peer] = c.global_position.x
		elif absf(c.global_position.x - float(_seen[peer])) > 2.0:
			_reported[peer] = true
			print("MULTIPLAYER_PLAYER %s sees %s (peer %d) move: from x = %.2f to x = %.2f" % [lobby.room.me().get("name", "?"), e["name"], peer, float(_seen[peer]), c.global_position.x])
