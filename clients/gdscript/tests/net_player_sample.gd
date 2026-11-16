extends SceneTree
## The sample (examples/net_player_demo) without a socket: its scenes load, its game builds the world and spawns the capsules on the
## in-memory rig (a host and a client), the colour and name travel, and the trace comparison of the two-process check finds the lag
## between two paths. The real two-process run is clients/gdscript/net-player-test.sh (CI only: it needs the WebRTC natives).
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/net_player_sample.gd
## Prints "net_player_sample: N passed, M failed"; exits 1 on any failure.

const Rig := preload("res://tests/replication_rig.gd")
const Game := preload("res://examples/net_player_demo/game.gd")
const Autotest := preload("res://examples/net_player_demo/autotest.gd")

var _pass := 0
var _fail := 0


func _init() -> void:
	_run.call_deferred()


func _check(ok: bool, what: String) -> void:
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL: ", what)


func _run() -> void:
	_check(load("res://examples/net_player_demo/main.tscn") is PackedScene, "main.tscn loads")
	var cfg := OneLobbyConfig.load_file("res://examples/net_player_demo/onelobby.json")
	_check(cfg.ok, "onelobby.json passes the blueprint checks (%s)" % str(cfg.errors if "errors" in cfg else ""))
	_check(cfg.ok and cfg.sync["mode"] == "replication" and cfg.sync["player"]["authority"] == "owner", "the sample asks for replication and the default player")

	# the comparison of the two-process check: a path and the same path 120 ms later
	var owner: Array = []
	var watched: Array = []
	for i in 300:
		var t := 1000.0 + float(i) * 20.0
		owner.append([t, sin(t / 1000.0) * 5.0, 0.0, cos(t / 1000.0) * 5.0])
		watched.append([t + 120.0, sin(t / 1000.0) * 5.0, 0.0, cos(t / 1000.0) * 5.0])
	var r := Autotest.compare_paths(owner, watched)
	_check(absi(int(r["lag_ms"]) - 120) <= 8 and float(r["mean"]) < 0.05 and int(r["n"]) > 200, "compare_paths finds a 120 ms lag (%s)" % str(r))
	var off: Array = watched.map(func(w: Array) -> Array: return [w[0], float(w[1]) + 1.0, w[2], w[3]])
	_check(float(Autotest.compare_paths(owner, off)["max"]) > 0.5, "compare_paths sees a path that is a metre off")

	# the game on the rig: a host and a client, one capsule each on both machines
	var rig: Rig = Rig.player_rig({"layer": {"authority": "owner"}})
	rig.host_players()
	rig.join_players("a")
	var hw := Game.new()
	var aw := Game.new()
	root.add_child(hw)
	root.add_child(aw)
	hw.start_with_layer(rig.layers["host"].session.lobby_handle, rig.layers["host"])
	aw.start_with_layer(rig.layers["a"].session.lobby_handle, rig.layers["a"])
	var apeer: int = rig.layers["a"].local_peer_id
	var hpeer: int = rig.layers["host"].local_peer_id
	for i in 200:
		var ac := aw.spawner.character_of(apeer) as Node3D
		if ac != null:
			ac.position = Vector3(float(i) * 0.03, 1.0, 2.0)
		rig.step()
		for g: Node in [hw, aw]:
			for c: Node in g.spawner.characters.values():
				(c.get_node("NetPlayer") as OneLobbyNetPlayer)._physics_process(0.016)
				(c.get_node("NetPlayer") as OneLobbyNetPlayer)._process(0.016)
				c._process(0.016)
	_check(hw.spawner.characters.size() == 2 and aw.spawner.characters.size() == 2, "the game spawns a capsule per player on both machines")
	var copy := hw.spawner.character_of(apeer) as Node3D
	_check(copy != null and copy.visible and absf(copy.position.z - 2.0) < 0.05 and copy.position.x > 2.0, "the host's copy of the client's capsule follows (%s)" % str(copy.position if copy != null else null))
	_check(hw.local_character == hw.spawner.character_of(hpeer) and aw.local_character == aw.spawner.character_of(apeer), "each game knows its own capsule (the camera follows it)")
	_check(aw.spawner.character_of(hpeer).get_node("NetPlayer").is_local == false and aw.spawner.character_of(apeer).get_node("NetPlayer").is_local, "marked local on the right capsule")
	hw.queue_free()
	aw.queue_free()
	print("net_player_sample: %d passed, %d failed" % [_pass, _fail])
	quit(1 if _fail > 0 else 0)
