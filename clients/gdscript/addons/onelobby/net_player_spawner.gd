class_name OneLobbyNetPlayerSpawner
extends Node
## Makes one character per seated player. Give it the lobby (or the menu's `game_started` lobby), a `PackedScene` of the game's
## character (with a `OneLobbyNetPlayer` inside) and a parent to add them to; it creates the layer (`OneLobbyNetPlayers`),
## pumps it every frame, instances a character when the layer says a player joined (the local one included, marked local so the
## game can attach its camera and input), and frees it when the player leaves.
##
##     func _ready() -> void:
##         $Menu.game_started.connect(func(lobby: OneLobbyLobby) -> void:
##             var spawner := OneLobbyNetPlayerSpawner.new()
##             spawner.scene = preload("res://player.tscn")
##             spawner.spawn_point = func(peer: int) -> Vector3: return Vector3(peer * 2.0, 1.0, 0.0)
##             spawner.player_spawned.connect(func(peer: int, character: Node, is_local: bool) -> void:
##                 if is_local: character.get_node("Camera3D").current = true)
##             add_child(spawner)
##             spawner.start(lobby, OneLobbyConfig.load_file()))
##
## A game that wants to do this itself uses `OneLobbyNetPlayers` and `OneLobbyNetPlayer` directly (the spawner is a few dozen
## lines on top of them).

## A character was added: `character` is the scene's root, `is_local` is true for the player this machine controls.
signal player_spawned(peer_id: int, character: Node, is_local: bool)
## A character is about to be freed (its player left, or became a spectator).
signal player_removed(peer_id: int, character: Node)

## The game's character: a scene with a `OneLobbyNetPlayer` somewhere inside (its parent should be the character).
@export var scene: PackedScene
## Where the characters go: a path from this node, default this node's parent.
@export var spawn_parent: NodePath
## True: the spawner pumps the layer every frame (turn it off when your own code calls `players.pump()`).
@export var pump_layer := true

## `Callable(peer_id) -> Vector3 | Vector2`: where a player starts (a Vector3 for a 3D game, a Vector2 for 2D). Used for the
## character instance, and, with authority "host", as the player's place on the host. Default: the origin.
var spawn_point := Callable()
## Host authority: the movement step `Callable(state, input, dt) -> state` that goes to the layer (see `OneLobbyNetPlayer`).
var step_function := Callable()
## The layer (after `start` or `use_players`).
var players: OneLobbyNetPlayers
## peer id -> the character instance.
var characters := {}

var _conns: Array = []


## Make the layer from a lobby and start spawning. `cfg`: the game's `OneLobbyConfig` (null: the defaults of the player layer:
## owner authority, 3D). `opts`: extra options of `OneLobbyNetPlayers` (`step`, `limits`, ...).
func start(lobby: Variant, cfg: OneLobbyConfig = null, opts: Dictionary = {}) -> OneLobbyNetPlayers:
	var o := opts.duplicate()
	if step_function.is_valid() and not o.has("step"):
		o["step"] = step_function
	if spawn_point.is_valid() and not o.has("spawn"):
		o["spawn"] = _spawn_state
	var layer: OneLobbyNetPlayers
	if cfg != null:
		layer = OneLobbyNetPlayers.from_config(lobby, cfg, o)
	else:
		layer = OneLobbyNetPlayers.new(lobby, o)
	use_players(layer)
	return layer


## Spawn for a layer you made yourself.
func use_players(layer: OneLobbyNetPlayers) -> void:
	stop()
	players = layer
	_connect(layer.player_joined, _on_joined)
	_connect(layer.player_left, _on_left)
	if not layer.is_spectator(layer.local_peer_id):
		_on_joined(layer.local_peer_id) # this machine's own character at once: its state is what makes the player appear on the others
	for peer: int in layer.player_ids():
		_on_joined(peer)
	set_process(pump_layer)


## Stop spawning and free the characters. The layer stays yours.
func stop() -> void:
	for c: Array in _conns:
		if (c[0] as Signal).is_connected(c[1]):
			(c[0] as Signal).disconnect(c[1])
	_conns.clear()
	for peer: int in characters.keys():
		_on_left(peer)
	players = null


## The character of a peer, or null.
func character_of(peer_id: int) -> Node:
	return characters.get(peer_id)


func _ready() -> void:
	set_process(players != null and pump_layer)


func _process(_delta: float) -> void:
	if players != null and pump_layer:
		players.pump()


func _exit_tree() -> void:
	stop()


func _connect(sig: Signal, handler: Callable) -> void:
	sig.connect(handler)
	_conns.append([sig, handler])


## The host's start of a player (host authority): the spawn point as a state patch.
func _spawn_state(peer_id: int) -> Dictionary:
	return _patch(spawn_point.call(peer_id))


func _patch(v: Variant) -> Dictionary:
	if v is Vector3:
		return {"x": v.x, "y": v.y, "z": v.z}
	if v is Vector2:
		return {"x": v.x, "y": v.y}
	return {}


func _on_joined(peer: int) -> void:
	if characters.has(peer):
		return
	if scene == null:
		push_error("OneLobbyNetPlayerSpawner: set `scene` to the game's character (a PackedScene)")
		return
	var inst := scene.instantiate()
	inst.name = "Player%d" % peer
	var holder: Node = get_node_or_null(spawn_parent) if spawn_parent != NodePath() else get_parent()
	if holder == null:
		holder = get_parent()
	var np := _find_net_player(inst)
	if np == null:
		push_error("OneLobbyNetPlayerSpawner: the character scene has no OneLobbyNetPlayer inside")
		inst.free()
		return
	np.peer_id = peer
	if spawn_point.is_valid():
		var at: Variant = spawn_point.call(peer)
		if inst is Node3D and at is Vector3:
			(inst as Node3D).position = at
		elif inst is Node2D and at is Vector2:
			(inst as Node2D).position = at
	holder.add_child(inst)
	np.step_function = step_function
	np.bind(players)
	characters[peer] = inst
	inst.set_meta("onelobby_local", np.is_local)
	player_spawned.emit(peer, inst, np.is_local)


func _on_left(peer: int) -> void:
	var inst: Node = characters.get(peer)
	if inst == null:
		return
	characters.erase(peer)
	player_removed.emit(peer, inst)
	if is_instance_valid(inst):
		inst.queue_free()


func _find_net_player(n: Node) -> OneLobbyNetPlayer:
	if n is OneLobbyNetPlayer:
		return n
	for c in n.get_children():
		var f := _find_net_player(c)
		if f != null:
			return f
	return null
