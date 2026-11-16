extends SceneTree
## A second networked-player layer (OneLobbyNetPlayers) on a lobby that is already playing: the GDScript twin of the JS test
## net-player-late-layer.test.ts. A session made again on the same lobby holds no snapshot and sends `ack` 0; the host then sends
## it a full snapshot at once (spec/replication.md "Resync"). It opens no socket: time is virtual.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/net_player_late_layer.gd
## Prints "net_player_late_layer: N passed, M failed"; exits 1 on any failure.

const Rig := preload("res://tests/replication_rig.gd")

var _pass := 0
var _fail := 0
var _tests := 0


func _init() -> void:
	_run.call_deferred()


func _check(ok: bool, what: String) -> void:
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL: ", what)


func _run() -> void:
	for mode: String in ["owner", "host"]:
		_tests += 1
		_test_late_layer(mode)
	print("net_player_late_layer: %d passed, %d failed (%d test cases)" % [_pass, _fail, _tests])
	quit(1 if _fail > 0 else 0)


func _walk_step(s: Dictionary, i: Dictionary, dt: float) -> Dictionary:
	var o := s.duplicate()
	o["x"] = float(s["x"]) + float(i["move_x"]) * 6.0 * dt
	o["z"] = float(s["z"]) + float(i["move_y"]) * 6.0 * dt
	o["vx"] = float(i["move_x"]) * 6.0
	o["vz"] = float(i["move_y"]) * 6.0
	o["yaw"] = i["yaw"]
	return o


## A smooth path in metres at a time in ms (the one of tests/net_player.gd, trimmed).
func _path_at(ms: float, phase: float = 0.0) -> Dictionary:
	var t := ms / 1000.0
	var w := 0.8
	var vx := 12.0 * w * cos(w * t + phase)
	var vz := -12.0 * w * sin(w * t + phase)
	var yaw := fposmod(rad_to_deg(atan2(vx, vz)) + 360.0, 360.0)
	return {
		"x": 12.0 * sin(w * t + phase), "y": 0.5 * sin(2.0 * t), "z": 12.0 * cos(w * t + phase), "vx": vx, "vy": cos(2.0 * t), "vz": vz,
		"yaw": yaw, "pitch": 0.0, "on_ground": true, "mode": 2, "item": 0, "aiming": false, "blocking": false, "health": 100, "alive": true, "team": 0,
	}


func _test_late_layer(mode: String) -> void:
	var rig: Rig = Rig.player_rig({"layer": {"authority": mode, "step": Callable(self, "_walk_step")}})
	var h := rig.host_players()
	var a := rig.join_players("a")
	var b := rig.join_players("b")
	var host: Rig.RepPlayer = h["p"]
	var pa: Rig.RepPlayer = a["p"]
	var pb: Rig.RepPlayer = b["p"]
	var al: OneLobbyNetPlayers = a["layer"]
	var bl: OneLobbyNetPlayers = b["layer"]
	# A walks its path
	if mode == "owner":
		al.tick.connect(func(_n: int) -> void: al.set_local_state(_path_at(rig.now_ms())))
	else:
		al.tick.connect(func(_n: int) -> void:
			var t := rig.now_ms() / 1000.0
			al.set_local_input({"move_x": sin(0.8 * t), "move_y": cos(0.8 * t), "yaw": 90.0}))
	rig.run(4.0) # the lobby is playing: B holds snapshots, the host has B's ack
	_check(bl.get_state(pa.peer_id()) != null, "late layer %s: the first layer of B sees A" % mode)
	_check(host.session.acked_tick(pb.peer_id()) > 0, "late layer %s: the host holds B's ack" % mode)

	# B's layer and session are made again (a scene reload): a new session on the same lobby holds no snapshot
	bl.dispose()
	pb.session.dispose()
	pb.attach(rig.config)
	var layer := OneLobbyNetPlayers.new(pb.session, {"authority": mode, "step": Callable(self, "_walk_step")})
	rig.layers["b"] = layer
	_check(layer.get_state(pa.peer_id()) == null, "late layer %s: the new layer starts empty" % mode)
	# B plays on in its new layer (a layer with nothing to send is silent until its first snapshot: see spec/net-player.md section 13)
	if mode == "owner":
		layer.tick.connect(func(_n: int) -> void: layer.set_local_state(_path_at(rig.now_ms(), 1.0)))
	else:
		layer.tick.connect(func(_n: int) -> void: layer.set_local_input({"move_x": 0.5, "move_y": 0.5, "yaw": 90.0}))
	var t0 := rig.now_ms()
	var seen := -1
	for _i in 400:
		rig.step()
		if layer.get_state(pa.peer_id()) != null:
			seen = rig.now_ms() - t0
			break
	var ticks := float(seen) / float(host.session.clock.tick_ms())
	print("late layer (%s): sees the other players after %d ms (%.1f ticks)" % [mode, seen, ticks])
	if mode == "owner":
		_check(seen >= 0 and ticks <= 24.0, "late layer owner: the second layer sees A within 24 ticks, render delay included (%.1f)" % ticks)
	else:
		# the host authority layer sends no input before its first snapshot, so the ack 0 rule cannot help it (documented limit)
		_check(seen >= 0 and seen < 6000, "late layer host: it still gets there (%d ms)" % seen)
