class_name OneLobbyNetPlayer
extends Node
## One networked player, as a node under the game's character (`CharacterBody3D`, `CharacterBody2D`, or any `Node3D` / `Node2D`).
## Put it under the character, set `peer_id` (the spawner does), and the character is in the world on every screen: position,
## facing, movement state and the action events, smooth on the other machines. No player sync of your own.
##
## 2D or 3D follows `sync.player.space` of the layer (`OneLobbyNetPlayers`); a parent of the other kind is one clear error.
## Positions are the parent's `global_position`; the facing is `rotation_degrees.y` (3D) or `rotation_degrees` (2D), wrapped to
## [0, 360). The state is the preset of spec/net-player.md; the layer does the networking, this node is the engine side.
##
## Three roles, decided by `peer_id` and the layer's authority:
## - **The machine that owns the player, authority "owner"** (the default): the game moves its character as it always did; each
##   physics frame this node reads the parent (position, `velocity` and `is_on_floor()` of a CharacterBody, yaw) plus the values
##   the game sets here (`pitch`, `mode`, `item`, `aiming`, `blocking`, `health`, `alive`, `team`) and hands them to the layer.
## - **The machine that owns the player, authority "host"**: the game gives this node its input each physics frame
##   (`set_input`), the node predicts with `step_function` (a `Callable(state, input, dt) -> state` the game supplies; it must be
##   deterministic, it runs on the host too) and writes the predicted position, plus the smoothed correction, into the parent.
## - **Every other machine**: each rendered frame the node writes the layer's smoothed state into the parent (position, yaw; a
##   teleport snaps) and exposes the rest as properties (`pitch`, `mode`, `on_ground`, `item`, `aiming`, `blocking`, `health`,
##   `alive`, `team`, `velocity`).
##
## Action events are signals, played at the right tick (a jump lines up with the body that jumps); the owner starts one with a
## method of the same word (`jump()`, `shoot(yaw, pitch)` ...). `melee` is the one signal whose method needs another name
## (`melee_attack`), and the host raises `hit` and `died` with `hurt` and `kill`.
##
## Animation, optional and by name: `animation_player` (a path) plays `mode_animations[mode]`; or `animation_tree` (a path) gets
## the values of `animation_params`. No path set: nothing happens. A name the player does not have is skipped silently.
##
##     # a character scene: CharacterBody3D "Player" with a child OneLobbyNetPlayer; the spawner binds it
##     func _on_player_spawned(peer: int, character: Node, is_local: bool) -> void: ...

## An action event of this player, once it plays (also for the local player, at once).
signal jumped
signal landed(impact: float)
signal shot(yaw: float, pitch: float, view: int)
signal melee(swing: int)
signal reloaded
signal used(target: int)
signal item_switched(slot: int)
signal thrown(yaw: float, pitch: float, power: float)
## The host judged a hit on this player.
signal hit(by: int, damage: int)
signal died(by: int)
signal respawned
signal emoted(emote: int)

## The peer this player belongs to (set by the spawner or the game).
@export var peer_id := 0
## Path to an `AnimationPlayer`; it plays `mode_animations[mode]` on the owner's machine (from the local state) and on remote ones.
@export_node_path("AnimationPlayer") var animation_player: NodePath
## Path to an `AnimationTree`; each key of `animation_params` that this node knows is set on it.
@export_node_path("AnimationTree") var animation_tree: NodePath
## Mode number -> animation name: the nine modes of the preset (idle walk run crouch jump fall swim climb fly).
@export var mode_animations := {0: "idle", 1: "walk", 2: "run", 3: "crouch", 4: "jump", 5: "fall", 6: "swim", 7: "climb", 8: "fly"}
## Value name -> AnimationTree parameter path. Names: `mode`, `speed` (horizontal speed), `on_ground`, `aiming`, `blocking`,
## `alive`, `health`, `item`, `team`. Example: `{"speed": "parameters/Move/blend_position", "on_ground": "parameters/conditions/grounded"}`.
@export var animation_params := {}
## True: the node derives `mode` on the owner's machine (idle, walk, jump, fall) from the parent's movement; set `mode` yourself and switch this off to use the others.
@export var auto_mode := true
## True: a remote player's character stays hidden until its first state has arrived (nobody sees a player flash at the origin).
@export var hide_until_first_state := true

## Host authority: the game's movement step `Callable(state, input, dt) -> state`. It goes to the layer the node is bound to
## (the same function must run on the host and on every owner).
var step_function := Callable()
## True for the player this machine controls (set by `bind`).
var is_local := false

# The values of the player (the game sets them for its own player; they are read-only on remote machines).
var pitch := 0.0
var mode := 0
var on_ground := true
var item := 0
var aiming := false
var blocking := false
var health := 100
var alive := true
var team := 0
## Metres per second: a Vector3 for a 3D player, a Vector2 for a 2D one.
var velocity: Variant = Vector3.ZERO

var _players: OneLobbyNetPlayers
var _parent: Node
var _have_state := false
var _warned := false
var _input := {}
var _conns: Array = []


## Join a layer (the spawner calls this; a game that makes its own layer calls it for each character). Binding again moves the
## node to another layer.
func bind(players: OneLobbyNetPlayers) -> void:
	unbind()
	_players = players
	_parent = get_parent()
	if not _check_space():
		_players = null
		return
	is_local = peer_id == players.local_peer_id
	if step_function.is_valid() and not players.step.is_valid():
		players.step = step_function
	_connect(players.action_played, _on_action)
	_connect(players.corrected, _on_corrected)
	_have_state = false
	if hide_until_first_state and not is_local:
		_set_visible(false)
	set_process(true)
	set_physics_process(true)


## Leave the layer (the node does nothing until bound again).
func unbind() -> void:
	for c: Array in _conns:
		if (c[0] as Signal).is_connected(c[1]):
			(c[0] as Signal).disconnect(c[1])
	_conns.clear()
	_players = null
	is_local = false


func is_bound() -> bool:
	return _players != null


## The layer this node is bound to, or null.
func players() -> OneLobbyNetPlayers:
	return _players


func _connect(sig: Signal, handler: Callable) -> void:
	sig.connect(handler)
	_conns.append([sig, handler])


func _ready() -> void:
	set_process(false)
	set_physics_process(false)


func _exit_tree() -> void:
	unbind()


# ---- the game's side ---------------------------------------------------------------------------------------------------

## Host authority, local player: this physics frame's input (`move_x`, `move_y`, `yaw`, `pitch`, `buttons`: a Dictionary of
## `jump crouch sprint aim block fire use reload`). A partial patch is merged; call it every physics frame.
func set_input(patch: Dictionary) -> void:
	for k: String in patch:
		if k == "buttons":
			var b: Dictionary = _input.get("buttons", {})
			for n: String in patch["buttons"]:
				b[n] = patch["buttons"][n]
			_input["buttons"] = b
		else:
			_input[k] = patch[k]


## Put the player somewhere else without sliding (the owner; the host for any player through `players().teleport_player`). `to` is a
## Vector3 (3D) or Vector2 (2D); it moves the parent too.
func teleport(to: Variant) -> void:
	if _players == null:
		return
	_set_position(to)
	_players.teleport(_position_patch(to))


## Respawn: a teleport that also makes the player alive with full health, then the `respawned` event.
func respawn(to: Variant = null) -> void:
	if _players == null:
		return
	var patch := {} if to == null else _position_patch(to)
	if to != null:
		_set_position(to)
	alive = true
	health = 100
	_players.respawn(patch)


# Starting an action event (the owner; the host may start any player's through `players()`):

func jump() -> void:
	_send("jump", {})


func land(impact: float) -> void:
	_send("land", {"impact": impact})


func shoot(yaw: float, shoot_pitch: float = 0.0) -> void:
	_send("shoot", {"yaw": yaw, "pitch": shoot_pitch})


## `melee` is the signal, this starts it (`swing` is the game's swing id, 0..255).
func melee_attack(swing: int = 0) -> void:
	_send("melee", {"swing": swing})


func reload() -> void:
	_send("reload", {})


func use(target: int = 0) -> void:
	_send("use", {"target": target})


func switch_item(slot: int) -> void:
	item = slot
	_send("item_switch", {"slot": slot})


func throw_item(yaw: float, throw_pitch: float, power: float) -> void:
	_send("throw", {"yaw": yaw, "pitch": throw_pitch, "power": power})


func emote(emote_id: int) -> void:
	_send("emote", {"emote": emote_id})


## Host only: this player took a hit (the host judged a shot).
func hurt(by: int, damage: int) -> void:
	if _players != null:
		_players.host_action(peer_id, "hit", {"by": by, "damage": damage})


## Host only: this player died.
func kill(by: int) -> void:
	if _players != null:
		_players.host_action(peer_id, "death", {"by": by})


func _send(name: String, args: Dictionary) -> void:
	if _players == null:
		push_error("OneLobbyNetPlayer: not bound to a layer (the spawner binds it; or call bind)")
		return
	if not is_local:
		# the host may start any player's owner event
		if _players.is_host:
			_players.host_action(peer_id, name, args)
		else:
			push_error("OneLobbyNetPlayer: %s() is for the player this machine controls" % name)
		return
	_players.send_action(name, args)


# ---- frames ------------------------------------------------------------------------------------------------------------

func _physics_process(_delta: float) -> void:
	if _players == null or not is_local:
		return
	if _players.authority == "owner":
		_players.set_local_state(_read_parent())
	else:
		if not _players.step.is_valid() and not _warned:
			_warned = true
			push_error("OneLobbyNetPlayer: sync.player.authority is \"host\": give the node a step_function (a Callable(state, input, dt) -> state) or set OneLobbyNetPlayers.step")
		if not _input.is_empty():
			_players.set_local_input(_input)


func _process(_delta: float) -> void:
	if _players == null:
		return
	var s: Variant = _players.get_state(peer_id)
	if is_local:
		if _players.authority == "host" and s != null:
			if not _have_state and _players.latest_state(peer_id) == null:
				return # the host has not told us where we start yet: nothing to draw (no flash at the origin)
			var off := _players.smoother.offset
			_apply_state(s, off) # predicted state plus the smoothed correction
		elif _players.authority == "owner":
			_apply_local_values()
		_animate_local(s)
		return
	if s == null:
		return
	_apply_state(s, Vector3.ZERO)
	_animate(s)


## The game's side of an owner's state: what the parent says, plus the values set on this node.
func _read_parent() -> Dictionary:
	var p := get_parent()
	var d := {}
	if p is Node3D:
		var n3: Node3D = p
		var pos := n3.global_position
		d["x"] = pos.x
		d["y"] = pos.y
		d["z"] = pos.z
		d["yaw"] = fposmod(n3.global_rotation_degrees.y, 360.0)
		d["pitch"] = pitch
		if p is CharacterBody3D:
			var cb: CharacterBody3D = p
			d["vx"] = cb.velocity.x
			d["vy"] = cb.velocity.y
			d["vz"] = cb.velocity.z
			on_ground = cb.is_on_floor() or cb.motion_mode == CharacterBody3D.MOTION_MODE_FLOATING
			velocity = cb.velocity
	elif p is Node2D:
		var n2: Node2D = p
		var pos2 := n2.global_position
		d["x"] = pos2.x
		d["y"] = pos2.y
		d["yaw"] = fposmod(n2.global_rotation_degrees, 360.0)
		if p is CharacterBody2D:
			var cb2: CharacterBody2D = p
			d["vx"] = cb2.velocity.x
			d["vy"] = cb2.velocity.y
			on_ground = cb2.is_on_floor() or cb2.motion_mode == CharacterBody2D.MOTION_MODE_FLOATING # a top-down game is always on the ground
			velocity = cb2.velocity
	if auto_mode:
		mode = _derive_mode(d)
	d["on_ground"] = on_ground
	d["mode"] = mode
	d["item"] = item
	d["aiming"] = aiming
	d["blocking"] = blocking
	d["health"] = health
	d["alive"] = alive
	d["team"] = team
	return d


func _derive_mode(d: Dictionary) -> int:
	if not on_ground:
		return 4 if float(d.get("vy", 0.0)) > 0.0 and _players != null and _players.codec.is_3d() else 5
	var sp := sqrt(float(d.get("vx", 0.0)) ** 2 + float(d.get("vz", 0.0)) ** 2) if _players != null and _players.codec.is_3d() else sqrt(float(d.get("vx", 0.0)) ** 2 + float(d.get("vy", 0.0)) ** 2)
	return 1 if sp > 0.1 else 0


## Write a state into the parent (position, facing) and into the properties of this node.
func _apply_state(s: Dictionary, offset: Vector3) -> void:
	var p := get_parent()
	if p is Node3D:
		(p as Node3D).global_position = Vector3(float(s["x"]) + offset.x, float(s["y"]) + offset.y, float(s["z"]) + offset.z)
		(p as Node3D).global_rotation_degrees = Vector3((p as Node3D).global_rotation_degrees.x, float(s["yaw"]), (p as Node3D).global_rotation_degrees.z)
		velocity = Vector3(float(s["vx"]), float(s["vy"]), float(s["vz"]))
	elif p is Node2D:
		(p as Node2D).global_position = Vector2(float(s["x"]) + offset.x, float(s["y"]) + offset.z) # a 2D correction rides the smoother's x and z
		(p as Node2D).global_rotation_degrees = float(s["yaw"])
		velocity = Vector2(float(s["vx"]), float(s["vy"]))
	pitch = float(s["pitch"])
	mode = int(s["mode"])
	on_ground = bool(s["on_ground"])
	item = int(s["item"])
	aiming = bool(s["aiming"])
	blocking = bool(s["blocking"])
	health = int(s["health"])
	alive = bool(s["alive"])
	team = int(s["team"])
	if not _have_state:
		_have_state = true
		_set_visible(true)


func _apply_local_values() -> void:
	if not _have_state:
		_have_state = true
		_set_visible(true)


func _set_visible(v: bool) -> void:
	var p := get_parent()
	if p is Node3D:
		(p as Node3D).visible = v
	elif p is CanvasItem:
		(p as CanvasItem).visible = v


func _position_patch(to: Variant) -> Dictionary:
	if to is Vector3:
		return {"x": to.x, "y": to.y, "z": to.z}
	if to is Vector2:
		return {"x": to.x, "y": to.y}
	return {}


func _set_position(to: Variant) -> void:
	var p := get_parent()
	if p is Node3D and to is Vector3:
		(p as Node3D).global_position = to
	elif p is Node2D and to is Vector2:
		(p as Node2D).global_position = to


## The 2D / 3D check: one clear error when the parent is the other kind.
func _check_space() -> bool:
	var space := _players.codec.space
	var p := get_parent()
	if p is Node3D and space == "2d":
		push_error("OneLobbyNetPlayer: the parent \"%s\" is a Node3D but sync.player.space is \"2d\"" % p.name)
		return false
	if p is Node2D and space == "3d":
		push_error("OneLobbyNetPlayer: the parent \"%s\" is a Node2D but sync.player.space is \"3d\" (set sync.player.space to \"2d\")" % p.name)
		return false
	if not (p is Node3D or p is Node2D):
		push_error("OneLobbyNetPlayer: put the node under a Node3D or Node2D (the character); the parent is %s" % (p.get_class() if p != null else "missing"))
		return false
	return true


# ---- events and animation ----------------------------------------------------------------------------------------------

func _on_action(e: Dictionary) -> void:
	if int(e["player"]) != peer_id:
		return
	var a: Dictionary = e["args"]
	match str(e["name"]):
		"jump":
			jumped.emit()
		"land":
			landed.emit(float(a.get("impact", 0.0)))
		"shoot":
			shot.emit(float(a.get("yaw", 0.0)), float(a.get("pitch", 0.0)), int(a.get("view", 0)))
		"melee":
			melee.emit(int(a.get("swing", 0)))
		"reload":
			reloaded.emit()
		"use":
			used.emit(int(a.get("target", 0)))
		"item_switch":
			item_switched.emit(int(a.get("slot", 0)))
		"throw":
			thrown.emit(float(a.get("yaw", 0.0)), float(a.get("pitch", 0.0)), float(a.get("power", 0.0)))
		"hit":
			hit.emit(int(a.get("by", 0)), int(a.get("damage", 0)))
		"death":
			died.emit(int(a.get("by", 0)))
		"respawn":
			respawned.emit()
		"emote":
			emoted.emit(int(a.get("emote", 0)))


## Owner mode: the host put this player back: take its state as ours.
func _on_corrected(s: Dictionary) -> void:
	if not is_local:
		return
	_apply_state(s, Vector3.ZERO)
	var p := get_parent()
	if p is CharacterBody3D:
		(p as CharacterBody3D).velocity = velocity as Vector3
	elif p is CharacterBody2D:
		(p as CharacterBody2D).velocity = velocity as Vector2


func _animate_local(s: Variant) -> void:
	_animate({"mode": mode, "on_ground": on_ground, "aiming": aiming, "blocking": blocking, "alive": alive, "health": health, "item": item, "team": team,
		"vx": (velocity as Vector3).x if velocity is Vector3 else (velocity as Vector2).x,
		"vy": (velocity as Vector3).y if velocity is Vector3 else (velocity as Vector2).y,
		"vz": (velocity as Vector3).z if velocity is Vector3 else 0.0})


func _animate(s: Dictionary) -> void:
	if animation_player != NodePath():
		var ap := get_node_or_null(animation_player) as AnimationPlayer
		if ap != null:
			var anim_name: String = str(mode_animations.get(int(s["mode"]), ""))
			if anim_name != "" and ap.has_animation(anim_name) and (ap.current_animation != anim_name or not ap.is_playing()):
				ap.play(anim_name)
	if animation_tree != NodePath() and not animation_params.is_empty():
		var tree := get_node_or_null(animation_tree) as AnimationTree
		if tree != null:
			var speed := sqrt(float(s["vx"]) ** 2 + float(s["vz"]) ** 2) if _players != null and _players.codec.is_3d() else sqrt(float(s["vx"]) ** 2 + float(s["vy"]) ** 2)
			var values := {"mode": int(s["mode"]), "speed": speed, "on_ground": bool(s["on_ground"]), "aiming": bool(s["aiming"]),
				"blocking": bool(s["blocking"]), "alive": bool(s["alive"]), "health": int(s["health"]), "item": int(s["item"]), "team": int(s["team"])}
			for k: String in animation_params:
				if values.has(k):
					tree.set(str(animation_params[k]), values[k])
