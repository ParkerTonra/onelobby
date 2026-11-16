extends Node3D
## The sample game: a flat floor, one capsule per player (a colour per team, a label per name), a camera that follows the local one.
## All the networking is the spawner and the node inside player.tscn; this script only builds the world and hands them the lobby.

const PlayerScene := preload("res://examples/net_player_demo/player.tscn")
const Autotest := preload("res://examples/net_player_demo/autotest.gd")

var spawner: OneLobbyNetPlayerSpawner
var players: OneLobbyNetPlayers
var lobby: Variant
var local_character: Node3D
var camera: Camera3D
var autotest: Node


## `lobby`: the menu's `game_started` lobby; `cfg`: the game's onelobby.json.
func start(game_lobby: OneLobbyLobby, cfg: OneLobbyConfig) -> void:
	lobby = game_lobby
	_build_world()
	spawner = OneLobbyNetPlayerSpawner.new()
	_wire_spawner()
	add_child(spawner)
	players = spawner.start(game_lobby, cfg)
	_start_test()


## For a test that made its own layer (the rig): the same game on a layer you give.
func start_with_layer(game_lobby: Variant, layer: OneLobbyNetPlayers) -> void:
	lobby = game_lobby
	_build_world()
	spawner = OneLobbyNetPlayerSpawner.new()
	spawner.pump_layer = false
	_wire_spawner()
	add_child(spawner)
	spawner.use_players(layer)
	players = layer


func _wire_spawner() -> void:
	spawner.scene = PlayerScene
	spawner.spawn_point = func(peer: int) -> Vector3: return Vector3(-6.0 + 3.0 * float(maxi(0, _seat(peer))), 1.0, 0.0)
	spawner.player_spawned.connect(_on_spawned)


func _seat(peer: int) -> int:
	var e: Variant = lobby.room.player(peer) if lobby != null and lobby.get("room") != null and lobby.room.has_method("player") else null
	return int((e as Dictionary).get("seat", 0)) if e is Dictionary and not (e as Dictionary).is_empty() else 0


func _name_of(peer: int) -> String:
	var e: Variant = lobby.room.player(peer) if lobby != null and lobby.get("room") != null and lobby.room.has_method("player") else null
	return str((e as Dictionary).get("name", "player %d" % peer)) if e is Dictionary and not (e as Dictionary).is_empty() else "player %d" % peer


func _on_spawned(peer: int, character: Node, is_local: bool) -> void:
	(character as Node).call("setup", _name_of(peer), _seat(peer))
	if is_local:
		local_character = character as Node3D


func _build_world() -> void:
	var floor_body := StaticBody3D.new()
	var shape := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(40.0, 1.0, 40.0)
	shape.shape = box
	floor_body.add_child(shape)
	var mesh := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = box.size
	mesh.mesh = bm
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.35, 0.4, 0.35)
	mesh.material_override = mat
	floor_body.add_child(mesh)
	floor_body.position = Vector3(0.0, -0.5, 0.0) # the top is at y = 0
	add_child(floor_body)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-55.0, 30.0, 0.0)
	add_child(sun)
	camera = Camera3D.new()
	camera.position = Vector3(0.0, 9.0, 11.0)
	add_child(camera)
	camera.look_at(Vector3.ZERO)
	camera.current = true


func _process(_delta: float) -> void:
	if local_character != null and is_instance_valid(local_character):
		var p := local_character.global_position
		camera.global_position = camera.global_position.lerp(p + Vector3(0.0, 9.0, 11.0), 0.1)
		camera.look_at(p)


func _start_test() -> void:
	if not ("--netplayer-test" in OS.get_cmdline_user_args()):
		return
	autotest = Autotest.new()
	add_child(autotest)
	autotest.attach(self)
