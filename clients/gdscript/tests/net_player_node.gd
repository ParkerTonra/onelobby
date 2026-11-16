extends SceneTree
## The node (OneLobbyNetPlayer) and the spawner (OneLobbyNetPlayerSpawner) on the in-memory rig: a host and two clients, each with a
## small scene tree of its own (a world node, a spawner, one character per player). No socket: the rig's virtual clock drives the
## layers, and the test calls the nodes' physics and render frames by hand after each rig step, so it is deterministic.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/net_player_node.gd
## Prints "net_player_node: N passed, M failed"; exits 1 on any failure. The "ERROR:" lines of the 2D / 3D mismatch are expected.

const Rig := preload("res://tests/replication_rig.gd")

var _pass := 0
var _fail := 0
var _tests := 0
## What each machine's spawner reported: machine name -> [{peer, is_local}].
var _spawned := {}


func _init() -> void:
	_run.call_deferred()


func _check(ok: bool, what: String) -> void:
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL: ", what)


func _run() -> void:
	for t: Callable in [_test_owner_3d, _test_host_authority, _test_events_and_animation, _test_2d_and_mismatch, _test_leave_and_spectator, _test_teleport_and_corrections, _test_body_and_missing_step]:
		_tests += 1
		t.call()
	print("net_player_node: %d passed, %d failed (%d test cases)" % [_pass, _fail, _tests])
	quit(1 if _fail > 0 else 0)


## A character scene made in code: a root (`Node3D`, `CharacterBody3D` or a 2D kind) with a OneLobbyNetPlayer and an AnimationPlayer
## that has a "walk" and an "idle" animation.
func _character_scene(kind: String) -> PackedScene:
	var root: Node
	match kind:
		"body3d":
			root = CharacterBody3D.new()
		"node2d":
			root = Node2D.new()
		_:
			root = Node3D.new()
	root.name = "Player"
	var np := OneLobbyNetPlayer.new()
	np.name = "NetPlayer"
	np.animation_player = NodePath("../Anim")
	root.add_child(np)
	np.owner = root
	var ap := AnimationPlayer.new()
	ap.name = "Anim"
	var lib := AnimationLibrary.new()
	lib.add_animation("idle", Animation.new())
	lib.add_animation("walk", Animation.new())
	ap.add_animation_library("", lib)
	root.add_child(ap)
	ap.owner = root
	var ps := PackedScene.new()
	ps.pack(root)
	root.free()
	return ps


## A machine: a world node and a spawner on the layer of the rig's peer `name`.
func _machine(rig: Rig, name: String, scene: PackedScene, opts: Dictionary = {}) -> Dictionary:
	var world := Node3D.new()
	world.name = "World_" + name
	root.add_child(world)
	var sp := OneLobbyNetPlayerSpawner.new()
	sp.scene = scene
	sp.pump_layer = false # the rig pumps the layers on its virtual clock
	if opts.has("step"):
		sp.step_function = opts["step"]
	_spawned[name] = []
	sp.player_spawned.connect(func(peer: int, _c: Node, is_local: bool) -> void: _spawned[name].append({"peer": peer, "is_local": is_local}))
	world.add_child(sp)
	sp.use_players(rig.layers[name])
	return {"world": world, "spawner": sp}


## One rig frame, then the frames of every node (physics, then render), like the engine would.
func _frame(rig: Rig, machines: Array) -> void:
	rig.step()
	for m: Dictionary in machines:
		for c: Node in (m["spawner"] as OneLobbyNetPlayerSpawner).characters.values():
			if is_instance_valid(c) and not c.is_queued_for_deletion():
				var np := _np(c)
				np._physics_process(0.016)
				np._process(0.016)


func _np(character: Node) -> OneLobbyNetPlayer:
	return character.get_node("NetPlayer")


func _char(m: Dictionary, peer: int) -> Node:
	return (m["spawner"] as OneLobbyNetPlayerSpawner).character_of(peer)


func _cleanup(machines: Array) -> void:
	for m: Dictionary in machines:
		(m["spawner"] as OneLobbyNetPlayerSpawner).stop()
		(m["world"] as Node).free()


func _walk_step(s: Dictionary, i: Dictionary, dt: float) -> Dictionary:
	var o := s.duplicate()
	o["x"] = float(s["x"]) + float(i["move_x"]) * 6.0 * dt
	o["z"] = float(s["z"]) + float(i["move_y"]) * 6.0 * dt
	o["vx"] = float(i["move_x"]) * 6.0
	o["vz"] = float(i["move_y"]) * 6.0
	o["yaw"] = i["yaw"]
	return o


func _path(ms: float) -> Vector3:
	var t := ms / 1000.0
	return Vector3(12.0 * sin(0.8 * t), 0.0, 12.0 * cos(0.8 * t))


func _test_owner_3d() -> void:
	var rig: Rig = Rig.player_rig({"layer": {"authority": "owner"}})
	rig.host_players()
	rig.join_players("a")
	rig.join_players("b")
	var scene := _character_scene("node3d")
	var h := _machine(rig, "host", scene)
	var a := _machine(rig, "a", scene)
	var b := _machine(rig, "b", scene)
	var ms := [h, a, b]
	var apeer: int = rig.layers["a"].local_peer_id
	var bpeer: int = rig.layers["b"].local_peer_id
	_check((_spawned["a"] as Array).size() == 1 and _spawned["a"][0]["is_local"] and _spawned["a"][0]["peer"] == apeer, "owner 3D: a machine's own character is there at once, marked local")
	# A's game walks its character: it moves the parent, the node does the rest
	var jumps := {"a": 0, "host": 0, "b": 0}
	var worst := 0.0
	var steps := 0
	for i in 400:
		var ac := _char(a, apeer)
		if ac != null:
			(ac as Node3D).position = _path(float(rig.now_ms()))
			(ac as Node3D).rotation_degrees.y = 90.0
		_frame(rig, ms)
		if i == 150:
			for nm: String in ["host", "a", "b"]:
				var c := _char({"host": h, "a": a, "b": b}[nm], apeer)
				if c != null:
					var np := _np(c)
					np.jumped.connect(func() -> void: jumps[nm] += 1)
			_np(_char(a, apeer)).jump()
		if i > 250:
			# B's copy of A's character follows A's path, about 380 ms behind
			var bc := _char(b, apeer) as Node3D
			if bc != null:
				var behind := _path(float(rig.now_ms()) - 392.0)
				worst = maxf(worst, Vector2(bc.position.x - behind.x, bc.position.z - behind.z).length())
				steps += 1
	_check(_spawned["host"].size() == 3 and _spawned["b"].size() == 3 and _spawned["a"].size() == 3, "owner 3D: every machine has three characters (%d %d %d)" % [_spawned["host"].size(), _spawned["a"].size(), _spawned["b"].size()])
	_check(_spawned["b"].filter(func(e: Dictionary) -> bool: return e["is_local"]).size() == 1 and _spawned["b"].filter(func(e: Dictionary) -> bool: return e["is_local"])[0]["peer"] == bpeer, "owner 3D: exactly one local character per machine")
	print("node owner 3D: B's copy of A's character within %.3f m of A's path over %d frames" % [worst, steps])
	_check(steps > 100 and worst < 0.75, "owner 3D: the remote character follows the owner's path at a fixed 392 ms lag within 0.75 m (%.3f)" % worst)
	var bc2 := _char(b, apeer) as Node3D
	_check(bc2.visible, "owner 3D: the remote character is shown once its first state arrived")
	_check(absf(fposmod(bc2.rotation_degrees.y, 360.0) - 90.0) < 0.2, "owner 3D: and faces where the owner faces")
	_check(jumps["a"] == 1 and jumps["host"] == 1 and jumps["b"] == 1, "owner 3D: one jump arrives once on every machine (%s)" % str(jumps))
	var bnode := _np(bc2)
	_check(not bnode.is_local and bnode.peer_id == apeer and bnode.mode in [0, 1, 4, 5], "owner 3D: the remote node exposes the player's values (mode %d)" % bnode.mode)
	_cleanup(ms)


func _name_of(m: Dictionary, all: Array) -> String:
	return ["host", "a", "b"][all.find(m)]


func _test_host_authority() -> void:
	var rig: Rig = Rig.player_rig({"layer": {"authority": "host", "step": Callable(self, "_walk_step")}})
	rig.host_players()
	rig.join_players("a")
	rig.join_players("b")
	var scene := _character_scene("node3d")
	var step := Callable(self, "_walk_step")
	var h := _machine(rig, "host", scene, {"step": step})
	var a := _machine(rig, "a", scene, {"step": step})
	var b := _machine(rig, "b", scene, {"step": step})
	var ms := [h, a, b]
	var apeer: int = rig.layers["a"].local_peer_id
	var worst_owner := 0.0
	var worst := 0.0
	for i in 400:
		var ac := _char(a, apeer)
		if ac != null:
			var t := float(rig.now_ms()) / 1000.0
			_np(ac).set_input({"move_x": sin(0.8 * t), "move_y": cos(0.8 * t), "yaw": 90.0})
		_frame(rig, ms)
		if i > 150:
			var hc := _char(h, apeer) as Node3D
			var bc := _char(b, apeer) as Node3D
			var ac2 := _char(a, apeer) as Node3D
			if hc != null and bc != null and ac2 != null:
				worst_owner = maxf(worst_owner, Vector2(ac2.position.x - hc.position.x, ac2.position.z - hc.position.z).length())
				worst = maxf(worst, Vector2(bc.position.x - hc.position.x, bc.position.z - hc.position.z).length())
	var ac3 := _char(a, apeer) as Node3D
	print("node host authority: A's predicted character is at most %.2f m from the host's copy (the host is behind by the round trip); B's copy at most %.2f m" % [worst_owner, worst])
	_check(ac3.position.length() > 1.0, "host authority: the input moved the character (%.2f m from the origin)" % ac3.position.length())
	_check(worst_owner < 3.5, "host authority: the owner's prediction stays close to the host (%.2f)" % worst_owner)
	_check(worst < 3.5, "host authority: a watcher's copy is close to the host's (%.2f)" % worst)
	# without a step function the node logs one clear error (it does not crash): a layer with no step on a machine
	_cleanup(ms)


func _test_events_and_animation() -> void:
	var rig: Rig = Rig.player_rig({"layer": {"authority": "owner"}})
	rig.host_players()
	rig.join_players("a")
	rig.join_players("b")
	var scene := _character_scene("node3d")
	var h := _machine(rig, "host", scene)
	var a := _machine(rig, "a", scene)
	var b := _machine(rig, "b", scene)
	var ms := [h, a, b]
	var apeer: int = rig.layers["a"].local_peer_id
	for i in 160:
		(_char(a, apeer) as Node3D).position = Vector3(float(i) * 0.05, 0.0, 0.0) # A walks along x: auto_mode derives the mode only with a velocity; set it by hand
		_np(_char(a, apeer)).auto_mode = false
		_np(_char(a, apeer)).mode = 1
		_frame(rig, ms)
	var got := {}
	var nb := _np(_char(b, apeer))
	nb.shot.connect(func(yaw: float, pitch: float, view: int) -> void: got["shot"] = [yaw, pitch, view])
	nb.melee.connect(func(swing: int) -> void: got["melee"] = swing)
	nb.used.connect(func(target: int) -> void: got["used"] = target)
	nb.item_switched.connect(func(slot: int) -> void: got["slot"] = slot)
	nb.thrown.connect(func(yaw: float, pitch: float, power: float) -> void: got["thrown"] = [yaw, pitch, power])
	nb.emoted.connect(func(e: int) -> void: got["emote"] = e)
	nb.reloaded.connect(func() -> void: got["reload"] = true)
	nb.landed.connect(func(impact: float) -> void: got["landed"] = impact)
	nb.hit.connect(func(by: int, damage: int) -> void: got["hit"] = [by, damage])
	nb.died.connect(func(by: int) -> void: got["died"] = by)
	nb.respawned.connect(func() -> void: got["respawned"] = true)
	var na := _np(_char(a, apeer))
	na.shoot(123.4, -12.5)
	na.melee_attack(200)
	na.use(4242)
	na.switch_item(5)
	na.throw_item(10.0, 30.0, 0.5)
	na.emote(17)
	na.reload()
	na.land(12.5)
	# the host raises hit and death for A through A's node on the host
	_np(_char(h, apeer)).hurt(rig.layers["host"].local_peer_id, 25)
	_np(_char(h, apeer)).kill(rig.layers["host"].local_peer_id)
	for i in 120:
		_frame(rig, ms)
	_check(got.has("shot") and absf(float(got["shot"][0]) - 123.4) < 0.2 and absf(float(got["shot"][1]) + 12.5) < 0.2, "events: shot(yaw, pitch, view) arrives with its arguments")
	_check(got.get("melee", -1) == 200 and got.get("used", -1) == 4242 and got.get("slot", -1) == 5 and got.get("emote", -1) == 17, "events: melee, used, item_switched and emoted")
	_check(got.has("thrown") and absf(float(got["thrown"][2]) - 0.5) < 0.02, "events: thrown(yaw, pitch, power)")
	_check(got.has("reload") and absf(float(got.get("landed", 0.0)) - 12.5) < 0.5, "events: reloaded and landed(impact)")
	_check(got.get("hit", []) == [rig.layers["host"].local_peer_id, 25] and got.get("died", -1) == rig.layers["host"].local_peer_id, "events: the host's hit and died reach the watcher")
	_check(_np(_char(b, apeer)).item == 5, "events: the item property follows the owner (switch_item(5))")
	# animation: B's copy of A plays the animation of A's mode; a mode without an animation is skipped silently
	var ap := _char(b, apeer).get_node("Anim") as AnimationPlayer
	_check(ap.current_animation == "walk", "animation: mode 1 plays \"walk\" on the remote (%s)" % ap.current_animation)
	na.mode = 6 # swim: the scene has no such animation
	for i in 80:
		_frame(rig, ms)
	_check(_np(_char(b, apeer)).mode == 6 and ap.current_animation == "walk", "animation: a mode with no animation is skipped silently, the mode still arrives")
	na.mode = 0
	for i in 80:
		_frame(rig, ms)
	_check(ap.current_animation == "idle", "animation: mode 0 plays \"idle\"")
	_cleanup(ms)


func _test_2d_and_mismatch() -> void:
	var rig: Rig = Rig.player_rig({"layer": {"authority": "owner", "space": "2d", "range": 100, "velocity_range": 16}})
	rig.host_players()
	rig.join_players("a")
	var scene := _character_scene("node2d")
	var h := _machine(rig, "host", scene)
	var a := _machine(rig, "a", scene)
	var ms := [h, a]
	var apeer: int = rig.layers["a"].local_peer_id
	for i in 200:
		var ac := _char(a, apeer) as Node2D
		ac.position = Vector2(float(i) * 0.1, 3.0)
		ac.rotation_degrees = 45.0
		_frame(rig, ms)
	var hc := _char(h, apeer) as Node2D
	_check(hc != null and absf(hc.position.y - 3.0) < 0.1 and hc.position.x > 5.0, "2D: the host's copy of A's character follows (%s)" % str(hc.position))
	_check(absf(fposmod(hc.rotation_degrees, 360.0) - 45.0) < 0.2, "2D: and faces where A faces (%.2f)" % hc.rotation_degrees)
	_cleanup(ms)
	# a 3D character under a layer that says 2D: one clear error, and the node stays unbound
	var rig2: Rig = Rig.player_rig({"layer": {"authority": "owner", "space": "2d"}})
	rig2.host_players()
	var layer: OneLobbyNetPlayers = rig2.layers["host"]
	var world := Node3D.new()
	root.add_child(world)
	var scene3 := _character_scene("node3d")
	var inst := scene3.instantiate()
	world.add_child(inst)
	var np := _np(inst)
	np.peer_id = layer.local_peer_id
	np.bind(layer)
	_check(not np.is_bound(), "mismatch: a 3D parent under space \"2d\" is not bound (one error logged)")
	world.free()


func _test_leave_and_spectator() -> void:
	var rig: Rig = Rig.player_rig({"layer": {"authority": "owner"}})
	rig.host_players()
	rig.join_players("a")
	rig.join_players("b")
	rig.join_players("c", true) # a spectator
	var scene := _character_scene("node3d")
	var h := _machine(rig, "host", scene)
	var a := _machine(rig, "a", scene)
	var b := _machine(rig, "b", scene)
	var c := _machine(rig, "c", scene)
	var ms := [h, a, b, c]
	var apeer: int = rig.layers["a"].local_peer_id
	var bpeer: int = rig.layers["b"].local_peer_id
	var cpeer: int = rig.layers["c"].local_peer_id
	for i in 250:
		for who: Array in [[a, apeer, 0.0], [b, bpeer, 5.0]]:
			var ch := _char(who[0], who[1]) as Node3D
			if ch != null:
				ch.position = Vector3(float(who[2]), 0.0, float(i) * 0.02)
		_frame(rig, ms)
	_check(_char(c, cpeer) == null, "spectator: the spectator has no character of its own")
	_check(_char(h, cpeer) == null and _char(a, cpeer) == null, "spectator: and nobody has one for it")
	_check(_char(c, apeer) != null and _char(c, bpeer) != null, "spectator: it sees the players")
	var b_on_host := _char(h, bpeer)
	_check(b_on_host != null and not b_on_host.is_queued_for_deletion(), "leave: B's character exists on the host")
	rig.leave(rig.players[2])
	rig.frozen["b"] = true
	for i in 300:
		_frame(rig, ms)
	_check(_char(h, bpeer) == null and b_on_host.is_queued_for_deletion(), "leave: B's character is freed on the host")
	_check(_char(a, bpeer) == null, "leave: and on A")
	_cleanup(ms)


func _test_teleport_and_corrections() -> void:
	var rig: Rig = Rig.player_rig({"layer": {"authority": "owner", "limits": {"max_speed": 12.0, "max_step": 3.0}}})
	rig.host_players()
	rig.join_players("a")
	rig.join_players("b")
	var scene := _character_scene("node3d")
	var h := _machine(rig, "host", scene)
	var a := _machine(rig, "a", scene)
	var b := _machine(rig, "b", scene)
	var ms := [h, a, b]
	var apeer: int = rig.layers["a"].local_peer_id
	for i in 120:
		(_char(a, apeer) as Node3D).position = Vector3(1.0, 0.0, 1.0)
		_frame(rig, ms)
	# the node's teleport: no sliding on the watcher
	var watched := PackedFloat64Array()
	for i in 120:
		if i == 30:
			_np(_char(a, apeer)).teleport(Vector3(60.0, 0.0, 60.0))
		(_char(a, apeer) as Node3D).position = (_char(a, apeer) as Node3D).position # the game keeps its character where it is
		_frame(rig, ms)
		watched.append((_char(b, apeer) as Node3D).position.x)
	var big := 0
	var slide := 0
	for i in range(1, watched.size()):
		var d := absf(watched[i] - watched[i - 1])
		if d > 40.0:
			big += 1
		elif d > 1.0:
			slide += 1
	print("node teleport: %d frame(s) jumped over 40 m, %d slid" % [big, slide])
	_check(big == 1 and slide == 0, "teleport: one jump on the watcher and no slide")
	# a cheat is put back: the host refuses, the owner's node takes the host's state
	var told := [0]
	rig.layers["a"].corrected.connect(func(_s: Dictionary) -> void: told[0] += 1)
	(_char(a, apeer) as Node3D).position = Vector3(500.0, 0.0, 500.0)
	for i in 120:
		_frame(rig, ms)
	var pos := (_char(a, apeer) as Node3D).position
	_check(told[0] >= 1, "corrections: the owner is told")
	_check(pos.x < 100.0, "corrections: and its node took the host's state back (%s)" % str(pos))
	_cleanup(ms)


func _test_body_and_missing_step() -> void:
	# a CharacterBody3D parent: its velocity travels, and the remote node exposes it
	var rig: Rig = Rig.player_rig({"layer": {"authority": "owner"}})
	rig.host_players()
	rig.join_players("a")
	var scene := _character_scene("body3d")
	var h := _machine(rig, "host", scene)
	var a := _machine(rig, "a", scene)
	var ms := [h, a]
	var apeer: int = rig.layers["a"].local_peer_id
	for i in 150:
		var cb := _char(a, apeer) as CharacterBody3D
		cb.velocity = Vector3(3.0, 0.0, -2.0)
		cb.position += cb.velocity * 0.016
		_frame(rig, ms)
	var hv := _np(_char(h, apeer)).velocity as Vector3
	_check(absf(hv.x - 3.0) < 0.1 and absf(hv.z + 2.0) < 0.1, "CharacterBody3D: the velocity arrives (%s)" % str(hv))
	_check(not _np(_char(a, apeer)).on_ground, "CharacterBody3D: on_ground comes from is_on_floor() (false in the air)")
	_cleanup(ms)
	# host authority without a step function: one clear error, no crash
	var rig2: Rig = Rig.player_rig({"layer": {"authority": "host"}})
	rig2.host_players()
	var layer: OneLobbyNetPlayers = rig2.layers["host"]
	var world := Node3D.new()
	root.add_child(world)
	var inst := _character_scene("node3d").instantiate()
	world.add_child(inst)
	var np := _np(inst)
	np.peer_id = layer.local_peer_id
	np.bind(layer)
	np._physics_process(0.016)
	np._physics_process(0.016)
	_check(np.is_bound() and np._warned, "host authority without a step function: the node reports it once and goes on")
	world.free()
