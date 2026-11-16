extends Node3D
## The game, started by main.gd when the menu says the game started: a flat floor, a light, a camera that follows your character and one
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
var camera: Camera3D
var local_character: Node3D


## `game_lobby`: the menu's `game_started` lobby; `cfg`: the game's onelobby.json (Net.client.config).
func start(game_lobby: OneLobbyLobby, cfg: OneLobbyConfig) -> void:
	lobby = game_lobby
	_build_world()
	spawner = OneLobbyNetPlayerSpawner.new()
	spawner.scene = PlayerScene
	spawner.spawn_point = func(peer: int) -> Vector3: return Vector3(-6.0 + 3.0 * float(_seat(peer)), 1.0, 0.0) # a place per seat
#@if host
	spawner.step_function = PlayerScript.step
#@end
	spawner.player_spawned.connect(_on_spawned)
	add_child(spawner)
	players = spawner.start(game_lobby, cfg)


func _seat(peer: int) -> int:
	return maxi(0, int(lobby.room.player(peer).get("seat", 0)))


func _on_spawned(peer: int, character: Node, is_local: bool) -> void:
	character.call("setup", str(lobby.room.player(peer).get("name", "player %d" % peer)), _seat(peer))
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
	var box_mesh := BoxMesh.new()
	box_mesh.size = box.size
	var material := StandardMaterial3D.new()
	material.albedo_color = Color(0.35, 0.4, 0.35)
	mesh.mesh = box_mesh
	mesh.material_override = material
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
