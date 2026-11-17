extends SceneTree
## The networked player layer (OneLobbyNetPlayers) on the in-memory rig: a port of the JS tests net-player.test.ts (D1 to D6),
## net-player-host.test.ts (D7 to D9) and net-player-units.test.ts, same scenario (a host and two clients, A moves and B watches,
## 100 ms one way, 20 ms jitter, 3% loss on fast, a fixed seed, 16 ms frames, once for each authority) and the same bounds
## (spec/net-player.md section 11). It opens no socket: time is virtual. The measured numbers are printed like the JS tests do.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/net_player.gd
## Prints "net_player: N passed, M failed"; exits 1 on any failure.

const Rig := preload("res://tests/replication_rig.gd")
const Base := preload("res://tests/replication_rig.gd")
const W := preload("res://addons/onelobby/net_player_wire.gd")
const REL := OneLobbyWire.RELIABLE
const FAST := OneLobbyWire.FAST
const MODES := ["owner", "host"]

# Numbers stated in spec/net-player.md "Tests": the bounds these tests hold the layer to.
# D1: per seed the mean and the 99th percentile of the per-frame error, over all seeds the worst frame. The three clients hold the
# same numbers. Measured (loss 3%, jitter 20 ms, seeds 1 to 8, both authorities): see the printed D1 lines.
const D1_SEEDS := [1, 2, 7, 8]
const D1_MEAN_ERROR_M := 0.15
const D1_P99_ERROR_M := 0.4
const D1_MAX_ERROR_M := 0.45
const D1B_MAX_ERROR_M := 0.25
const CARRY_ON_CAP_MS := 250.0
const D3_ON_TIME_TICKS := 2.0
const D4_HOST_TO_CLIENT := 1500.0
const D4_CLIENT_TO_HOST := 3500.0

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
	var tests := [
		_test_smoother, _test_reconciler, _test_history_ring, _test_adaptive_delay_option, _test_adaptive_delay_behaviour,
		_test_no_layer_no_player, _test_old_session_ignores_kind5, _test_rejected_events, _test_malformed_kind5, _test_2d, _test_omit,
		_test_built_from_session_or_lobby, _test_from_config, _test_host_without_clients, _test_host_without_step,
		_test_host_draws_others, _test_host_authority_spawn, _test_d1, _test_d1b, _test_d1c, _test_d1d, _test_d2, _test_d3, _test_d4, _test_d5, _test_d6, _test_d7_speed, _test_d7_teleport, _test_d7_shots, _test_d8, _test_d8_400,
		_test_d8_clamp, _test_d9, _test_wire_traffic,
	]
	for t: Callable in tests:
		_tests += 1
		t.call()
	print("net_player: %d passed, %d failed (%d test cases)" % [_pass, _fail, _tests])
	quit(1 if _fail > 0 else 0)


# ====================================================================== scenario helpers ================================

## Host mode movement: 6 m/s on X and Z, facing the input's yaw. The same function runs on the host and in the owner's prediction.
func _walk_step(s: Dictionary, i: Dictionary, dt: float) -> Dictionary:
	var o := s.duplicate()
	o["x"] = float(s["x"]) + float(i["move_x"]) * 6.0 * dt
	o["z"] = float(s["z"]) + float(i["move_y"]) * 6.0 * dt
	o["vx"] = float(i["move_x"]) * 6.0
	o["vz"] = float(i["move_y"]) * 6.0
	o["yaw"] = i["yaw"]
	return o


## A smooth path in metres at a time in ms: a lap of a 12 m circle every ~8 s with a bob, so speed is about 9 m/s at most.
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


## Host + two clients (A moves, B watches) at 100 ms latency, 20 ms jitter, 3% loss on `fast` unless said otherwise.
func _scene(mode: String, o: Dictionary = {}) -> Dictionary:
	var opts := {"layer": {"authority": mode, "step": Callable(self, "_walk_step")}}
	opts.merge(o, true)
	var rig: Rig = Rig.player_rig(opts)
	var h := rig.host_players()
	var a := rig.join_players("a")
	var b := rig.join_players("b")
	return {"rig": rig, "host": h["p"], "a": a["p"], "b": b["p"], "hl": h["layer"], "al": a["layer"], "bl": b["layer"]}


## Make A walk its path: its state each tick (owner mode) or its input each tick (host mode).
func _drive(s: Dictionary, phase: float = 0.0) -> void:
	var rig: Rig = s["rig"]
	var al: OneLobbyNetPlayers = s["al"]
	if al.authority == "owner":
		al.tick.connect(func(_n: int) -> void: al.set_local_state(_path_at(rig.now_ms(), phase))) # the teleport counter is the layer's to keep
	else:
		al.tick.connect(func(_n: int) -> void:
			var t := rig.now_ms() / 1000.0
			al.set_local_input({"move_x": sin(0.8 * t + phase), "move_y": cos(0.8 * t + phase), "yaw": 90.0}))


## A path: parallel arrays of time (ms) and position.
class Path:
	var t := PackedFloat64Array()
	var x := PackedFloat64Array()
	var y := PackedFloat64Array()
	var z := PackedFloat64Array()

	func add(time: float, s: Dictionary) -> void:
		t.append(time)
		x.append(float(s["x"]))
		y.append(float(s["y"]))
		z.append(float(s["z"]))

	func size() -> int:
		return t.size()

	func dist(i: int, j: int) -> float:
		return sqrt((x[i] - x[j]) ** 2 + (y[i] - y[j]) ** 2 + (z[i] - z[j]) ** 2)


## The owner's position at time `tt`, interpolated between its frame samples; an empty array when outside the path.
func _at(path: Path, tt: float) -> Array:
	var n := path.size()
	if n == 0 or tt < path.t[0] or tt > path.t[n - 1]:
		return []
	var lo := 0
	var hi := n - 1
	while hi - lo > 1:
		var m := (lo + hi) >> 1
		if path.t[m] <= tt:
			lo = m
		else:
			hi = m
	var k := 0.0 if path.t[hi] == path.t[lo] else (tt - path.t[lo]) / (path.t[hi] - path.t[lo])
	return [path.x[lo] + (path.x[hi] - path.x[lo]) * k, path.y[lo] + (path.y[hi] - path.y[lo]) * k, path.z[lo] + (path.z[hi] - path.z[lo]) * k]


## Two paths that are a render delay apart: find the one constant lag (0 to 600 ms, 8 ms steps) at which the watched path is
## closest to the owner's path on average, then report the mean and worst distance at that lag.
func _compare_paths(owner: Path, watched: Path) -> Dictionary:
	var best := {"lag_ms": 0, "mean": INF, "max": INF, "p99": INF}
	for lag in range(0, 601, 8):
		var sum := 0.0
		var mx := 0.0
		var n := 0
		var errs := PackedFloat64Array()
		for i in watched.size():
			var o := _at(owner, watched.t[i] - float(lag))
			if o.is_empty():
				continue
			var d := sqrt((watched.x[i] - float(o[0])) ** 2 + (watched.y[i] - float(o[1])) ** 2 + (watched.z[i] - float(o[2])) ** 2)
			sum += d
			mx = maxf(mx, d)
			errs.append(d)
			n += 1
		if n > 20 and sum / float(n) < float(best["mean"]):
			errs.sort()
			best = {"lag_ms": lag, "mean": sum / float(n), "max": mx, "p99": errs[mini(n - 1, int(0.99 * float(n)))]}
	return best


## Run `seconds` of frames, recording A's own path and B's view of A each frame.
func _record(s: Dictionary, seconds: float, skip_seconds: float = 0.0) -> Dictionary:
	var rig: Rig = s["rig"]
	var al: OneLobbyNetPlayers = s["al"]
	var bl: OneLobbyNetPlayers = s["bl"]
	var owner := Path.new()
	var watched := Path.new()
	var frames := int(seconds * 1000.0 / float(rig.frame_ms))
	for i in frames:
		rig.step()
		var t := float(rig.now_ms())
		var mine: Variant = al.get_state(al.local_peer_id)
		if mine != null:
			owner.add(t, mine)
		var seen: Variant = bl.get_state(al.local_peer_id)
		if seen != null and float(i * rig.frame_ms) >= skip_seconds * 1000.0:
			watched.add(t, seen)
	return {"owner": owner, "watched": watched}


func _peer(s: Dictionary) -> int:
	return (s["a"] as Base.RepPlayer).peer_id()


func _dist3(a: Dictionary, b: Dictionary) -> float:
	return sqrt((float(a["x"]) - float(b["x"])) ** 2 + (float(a["y"]) - float(b["y"])) ** 2 + (float(a["z"]) - float(b["z"])) ** 2)


# ====================================================================== units ===========================================

func _test_smoother() -> void:
	var s := OneLobbyPredictionSmoother.new()
	_check(not s.correct(1, 0.2, 0), "smoother: a small correction glides")
	_check(s.offset.x == -1.0 and absf(s.offset.y + 0.2) < 1e-6 and absf(s.offset.z) == 0.0, "smoother: the offset starts at minus the correction")
	s.update(50)
	_check(absf(s.offset.x + 0.5) < 1e-4 and absf(s.offset.y + 0.1) < 1e-4, "smoother: linear decay")
	s.update(60)
	_check(s.offset_remaining() == 0.0 and s.snap_count == 0, "smoother: gone after 100 ms, no snap")
	# a correction mid-decay adds to what is left
	var m := OneLobbyPredictionSmoother.new()
	m.correct(1, 0, 0)
	m.update(50)
	m.correct(0, 0, 1)
	_check(absf(m.offset.x + 0.5) < 1e-4 and absf(m.offset.z + 1.0) < 1e-4, "smoother: a correction mid-decay adds to what is left")
	m.update(100)
	_check(m.offset_remaining() == 0.0, "smoother: and decays to zero")
	# large corrections snap
	var b := OneLobbyPredictionSmoother.new()
	_check(b.correct(1.5, 0, 1.5), "smoother: 2.12 on the plane snaps")
	_check(b.offset_remaining() == 0.0, "smoother: a snap clears the offset")
	_check(b.correct(0, 0.6, 0), "smoother: 0.6 vertically snaps")
	_check(b.snap_count == 2, "smoother: snap count")
	_check(not b.correct(0, 0.4, 1.9), "smoother: under the thresholds glides")
	# a changed sequence snaps whatever the distance
	var q := OneLobbyPredictionSmoother.new()
	_check(not q.correct(0.1, 0, 0, 3) and not q.correct(0.1, 0, 0, 3), "smoother: the same sequence glides")
	_check(q.correct(0.1, 0, 0, 4) and q.offset_remaining() == 0.0 and q.snap_count == 1, "smoother: a changed sequence snaps")
	_check(OneLobbyNetMath.lerp_or_snap(0, 2, 0.5, 2.5) == 1.0 and OneLobbyNetMath.lerp_or_snap(0, 10, 0.5, 2) == 10.0, "lerp_or_snap")


func _test_reconciler() -> void:
	var r := OneLobbyReconciler.new(0, func(x: int, d: int) -> int: return x + d)
	r.equal = func(a: int, b: int) -> bool: return absi(a - b) == 0
	for seq in range(1, 6):
		r.predict(seq, 1)
	_check(r.current == 5, "reconciler: predicted 5")
	_check(r.reconcile(2, 2) == 5, "reconciler: replays 3, 4, 5 over the host's 2")
	_check(r.corrections == 0 and r.pending_count() == 3, "reconciler: no correction, three still pending")
	_check(r.reconcile(10, 5) == 10, "reconciler: the host disagrees")
	_check(r.corrections == 1 and r.pending_count() == 0, "reconciler: one correction, none pending")


func _test_history_ring() -> void:
	var h := OneLobbyHistoryRing.new(30, func(a: float, b: float, t: float) -> float: return OneLobbyNetMath.lerp_value(a, b, t))
	for t in range(1, 41):
		h.record(t, 7, float(t * 2))
	_check(absf(float(h.try_sample(7, 20.5)) - 41.0) < 1e-6, "history ring: interpolates between ticks")
	_check(float(h.try_sample(7, 20)) == 40.0, "history ring: an exact tick")
	_check(h.try_sample(7, 5) == null, "history ring: older than the ring holds")
	_check(h.try_sample(8, 20) == null, "history ring: an unknown id")
	h.forget(7)
	_check(h.try_sample(7, 20) == null, "history ring: forgotten")


func _test_adaptive_delay_option() -> void:
	var rig := Base.new({}, 100.0, 0.03, 40.0)
	var host := rig.start_host()
	var a := rig.join("a")
	host.session.spawn(1, 0, func(_w: OneLobbyNetWriter) -> void: pass)
	rig.run(5.0)
	_check(not bool(a.session.config["adaptive_delay"]), "adaptive delay: off by default")
	_check(a.session.interpolation_delay_ms == 100.0, "adaptive delay: a bare session keeps the fixed 100 ms")
	_check(a.session.jitter_ms > 5.0, "adaptive delay: jitter is measured either way (%.1f ms)" % a.session.jitter_ms)


func _test_adaptive_delay_behaviour() -> void:
	var calm := _scene("owner", {"jitter_ms": 0.0, "loss_rate": 0.0})
	_drive(calm)
	(calm["rig"] as Rig).run(15.0)
	var rough := _scene("owner", {"jitter_ms": 80.0, "loss_rate": 0.03})
	_drive(rough)
	(rough["rig"] as Rig).run(15.0)
	var c: float = (calm["bl"] as OneLobbyNetPlayers).session.interpolation_delay_ms
	var r: float = (rough["bl"] as OneLobbyNetPlayers).session.interpolation_delay_ms
	print("adaptive delay: calm link %.1f ms, 80 ms jitter %.1f ms (bounds 66.7 to 250)" % [c, r])
	_check(c >= 2.0 * (1000.0 / 30.0) - 1e-9, "adaptive delay: not under 2 snapshot intervals")
	_check(c < 110.0, "adaptive delay: a calm link settles near the lower bound")
	_check(r > c + 40.0, "adaptive delay: grows with jitter")
	_check(r <= 250.0, "adaptive delay: at most 250 ms")


func _test_no_layer_no_player() -> void:
	var rig := Base.new()
	var host := rig.start_host()
	var a := rig.join("a")
	host.session.spawn(5, 0, func(_w: OneLobbyNetWriter) -> void: pass)
	rig.run(2.0)
	var players := (a.session.entities() as Array).filter(func(e: Dictionary) -> bool: return int(e["type_id"]) == W.PLAYER_TYPE_ID)
	_check(players.is_empty(), "no layer: a session sees no player entity")


func _test_old_session_ignores_kind5() -> void:
	var rig := Base.new()
	var host := rig.start_host()
	var a := rig.join("a")
	var bytes := W.encode_player_events([{"player": a.peer_id(), "seq": 1, "id": 1, "tick": 1, "args": PackedByteArray()}])
	_check(bytes[2] == W.KIND_PLAYER_EVENTS, "kind 5: the message kind")
	a.lobby.send(host.peer_id(), bytes, FAST)
	rig.run(0.5)
	_check(host.session.stats.malformed == 0, "kind 5: a session without the layer ignores it (additive kind)")


func _test_rejected_events() -> void:
	var s := _scene("owner", {"layer": {"authority": "owner", "omit": ["emote"]}})
	var rig: Rig = s["rig"]
	_drive(s)
	rig.run(3.0)
	var seen: Array = []
	var hl: OneLobbyNetPlayers = s["hl"]
	var al: OneLobbyNetPlayers = s["al"]
	hl.action_played.connect(func(e: Dictionary) -> void: seen.append(e["name"]))
	var a: Base.RepPlayer = s["a"]
	var b: Base.RepPlayer = s["b"]
	var send := func(player: int, id: int, seq: int, args: PackedByteArray = PackedByteArray()) -> void:
		a.lobby.send(1, W.encode_player_events([{"player": player, "seq": seq, "id": id, "tick": 1, "args": args}]), REL)
	send.call(a.peer_id(), 9, 100, PackedByteArray([0, 0, 0])) # "hit": the host raises that one
	send.call(b.peer_id(), 1, 101) # "jump" of someone else
	send.call(a.peer_id(), 12, 102, PackedByteArray([0])) # "emote" is left out of this game
	send.call(a.peer_id(), 1, 103, PackedByteArray([0])) # a jump with arguments it does not have
	rig.run(1.0)
	_check(seen.is_empty(), "rejected events: the host's game sees none")
	_check(hl.stats["actions_rejected"] == 4, "rejected events: four counted (%d)" % hl.stats["actions_rejected"])
	_check(not al.send_action("emote", {"emote": 1}), "rejected events: a left-out event cannot be sent")
	_check(not al.send_action("hit"), "rejected events: a host-only event cannot be sent by a client")


func _test_malformed_kind5() -> void:
	var s := _scene("owner")
	var a: Base.RepPlayer = s["a"]
	var host: Base.RepPlayer = s["host"]
	a.lobby.send(1, PackedByteArray([0x52, 1, 5, 0]), REL)
	(s["rig"] as Rig).run(0.5)
	_check(host.session.stats.malformed == 1, "malformed kind 5: counted, never thrown (%d)" % host.session.stats.malformed)


func _test_2d() -> void:
	var rig: Rig = Rig.player_rig({"layer": {"authority": "owner", "space": "2d", "range": 100, "velocity_range": 16}})
	var hl: OneLobbyNetPlayers = rig.host_players()["layer"]
	var a := rig.join_players("a")
	var bl: OneLobbyNetPlayers = rig.join_players("b")["layer"]
	var al: OneLobbyNetPlayers = a["layer"]
	al.tick.connect(func(_n: int) -> void:
		var p := _path_at(rig.now_ms())
		al.set_local_state({"x": p["x"], "y": p["z"], "vx": p["vx"], "vy": p["vz"], "yaw": p["yaw"]}))
	rig.run(5.0)
	_check(al.codec.state_bytes() == 12, "2D: 12 bytes of state")
	var v: Dictionary = bl.get_state((a["p"] as Base.RepPlayer).peer_id())
	var truth := _path_at(float(rig.now_ms()) - 400.0)
	var err := sqrt((float(v["x"]) - float(truth["x"])) ** 2 + (float(v["y"]) - float(truth["z"])) ** 2)
	_check(err < 1.5, "2D: the watched player is within 1.5 m of the path (%.2f)" % err)
	_check(float((hl.latest_state((a["p"] as Base.RepPlayer).peer_id()) as Dictionary)["z"]) == 0.0, "2D: z stays 0")


func _test_omit() -> void:
	var full := OneLobbyPlayerCodec.new({"space": "3d"})
	var lean := OneLobbyPlayerCodec.new({"space": "3d", "omit": ["velocity", "pitch", "aiming", "blocking", "team"]})
	_check(full.state_bytes() == 16, "omit: 16 bytes of state")
	_check(lean.state_bytes() < full.state_bytes(), "omit: leaving fields out shortens the state")
	var back: Dictionary = lean.decode_state(lean.encode_state(W.default_player_state({"x": 3.0, "vx": 9.0})))
	_check(float(back["vx"]) == 0.0, "omit: a left-out field reads its default")


func _test_built_from_session_or_lobby() -> void:
	var rig := Base.new()
	var host := rig.start_host()
	var l := OneLobbyNetPlayers.new(host.lobby)
	_check(l.session is OneLobbyReplicationSession and bool(l.session.config["adaptive_delay"]), "from a lobby: a session with the adaptive delay on")
	var rig2 := Base.new()
	var host2 := rig2.start_host()
	var l2 := OneLobbyNetPlayers.new(host2.session)
	_check(l2.session == host2.session and not bool(l2.session.config["adaptive_delay"]), "from a session: that session, untouched")


func _test_from_config() -> void:
	var cfg := OneLobbyConfig.parse({
		"game": {"id": "a"},
		"sync": {"mode": "replication", "tickRate": 60, "player": {"authority": "host", "space": "2d", "range": 100, "limits": {"maxSpeed": 8}, "omit": ["emote"]}},
	})
	_check(cfg.ok, "from_config: the file parses")
	var rig := Base.new()
	var host := rig.start_host()
	var l := OneLobbyNetPlayers.from_config(host.lobby, cfg)
	_check(l.authority == "host", "from_config: authority")
	_check(l.codec.space == "2d" and l.codec.range_value == 100.0 and l.codec.velocity_range == 32.0 and l.codec.omit == ["emote"], "from_config: codec settings")
	_check(l.limits == {"max_speed": 8}, "from_config: limits")
	_check(int(l.session.config["tick_rate"]) == 60, "from_config: the tick rate")
	var plain := OneLobbyConfig.parse({"game": {"id": "a"}})
	var rig2 := Base.new()
	var l2 := OneLobbyNetPlayers.from_config(rig2.start_host().lobby, plain)
	_check(l2.authority == "owner" and l2.codec.space == "3d", "from_config: a file without sync.player gets the defaults")


func _test_host_without_clients() -> void:
	var rig: Rig = Rig.player_rig({"layer": {"authority": "host", "step": Callable(self, "_walk_step")}})
	var l: OneLobbyNetPlayers = rig.host_players()["layer"]
	l.tick.connect(func(_n: int) -> void: l.set_local_input({"move_x": 1.0, "move_y": 0.0, "yaw": 0.0}))
	rig.run(1.0)
	_check(float((l.get_state(l.local_peer_id) as Dictionary)["x"]) > 3.0, "a host with no clients steps its own player")


## Authority "host" with no step function: one push_error (the run's output has exactly one "needs a step function" line), the roster and
## the snapshots go on, players that need the step do not move, and a step set later works (the JS and C# twins throw once instead).
func _test_host_without_step() -> void:
	var rig: Rig = Rig.player_rig({"loss_rate": 0.0, "jitter_ms": 0.0, "layer": func(name: String) -> Dictionary: return {"authority": "host", "step": Callable() if name == "host" else Callable(self, "_walk_step")}})
	var hl: OneLobbyNetPlayers = rig.host_players()["layer"]
	var a: Dictionary = rig.join_players("a")
	var al: OneLobbyNetPlayers = a["layer"]
	hl.tick.connect(func(_n: int) -> void: hl.set_local_input({"move_x": 1.0, "move_y": 0.0, "yaw": 0.0}))
	rig.run(2.5)
	_check(hl._warned_step, "host without a step: reported (once: one push_error in the output)")
	_check(hl.player_ids().has(al.local_peer_id) and al.player_ids().has(hl.local_peer_id), "host without a step: the roster and the snapshots go on")
	_check(absf(float((hl.get_state(hl.local_peer_id) as Dictionary)["x"])) < 0.05, "host without a step: a player that needs the step does not move")
	hl.step = Callable(self, "_walk_step") # set later: no restart
	rig.run(1.5)
	_check(float((hl.get_state(hl.local_peer_id) as Dictionary)["x"]) > 3.0, "host without a step: the host's own player walks once the step is set")


## A host that draws the other players: `get_state(peer)` on the host is its own record one tick behind, interpolated (the JS twin is
## the test "the host draws the other players" in net-player-host.test.ts).
func _test_host_draws_others() -> void:
	var tick_travel := 9.63 / 30.0 # the fastest the path goes, over one 30 Hz tick
	for mode: String in MODES:
		var s := _scene(mode, {"loss_rate": 0.0, "jitter_ms": 0.0})
		var rig: Rig = s["rig"]
		var hl: OneLobbyNetPlayers = s["hl"]
		var al: OneLobbyNetPlayers = s["al"]
		var bl: OneLobbyNetPlayers = s["bl"]
		var apeer := _peer(s)
		var bpeer := (s["b"] as Base.RepPlayer).peer_id()
		_drive(s) # A walks the path, B walks it from another phase
		if mode == "owner":
			bl.tick.connect(func(_n: int) -> void: bl.set_local_state(_path_at(rig.now_ms(), 2.0)))
			hl.tick.connect(func(_n: int) -> void: hl.set_local_state(_path_at(rig.now_ms(), 4.0)))
		else:
			bl.tick.connect(func(_n: int) -> void:
				var t := rig.now_ms() / 1000.0
				bl.set_local_input({"move_x": sin(0.8 * t + 2.0), "move_y": cos(0.8 * t + 2.0), "yaw": 90.0}))
		rig.run(3.0)
		var last := {}
		var frames := 0
		var repeats := 0
		var biggest := 0.0
		var missing := 0
		var own_same := true
		for i in 300:
			rig.step()
			for peer: int in [apeer, bpeer]:
				var v: Variant = hl.get_state(peer)
				if v == null:
					missing += 1
					continue
				var cur: Dictionary = v
				if last.has(peer):
					var d := _dist3(cur, last[peer])
					frames += 1
					if d == 0.0:
						repeats += 1
					biggest = maxf(biggest, d)
				last[peer] = cur
			if hl.get_state(hl.local_peer_id) != hl.local_state():
				own_same = false
		print("host draws others (%s): %d frames of 2 players, %d repeated a position, largest step %.3f m (one tick of travel at most %.3f m)" % [mode, frames, repeats, biggest, tick_travel])
		_check(missing == 0, "host draws others %s: both remote players have a state" % mode)
		_check(repeats == 0, "host draws others %s: no frame repeats a position while the player moves" % mode)
		_check(biggest < tick_travel, "host draws others %s: no step larger than one tick of travel" % mode)
		_check(own_same, "host draws others %s: the host's own player is its own state" % mode)
		# a teleport of A snaps (once, no slide)
		var watched := Path.new()
		for i in 40:
			if i == 30:
				hl.teleport_player(apeer, {"x": 60.0, "z": 60.0})
			rig.step()
			watched.add(float(rig.now_ms()), hl.get_state(apeer))
		var d := _steps(watched)
		var big := d.filter(func(x: float) -> bool: return x > 40.0).size()
		var slide := d.filter(func(x: float) -> bool: return x > 1.0 and x < 40.0).size()
		print("host draws others (%s) teleport: %d frame(s) jumped over 40 m, %d frame(s) slid between 1 and 40 m" % [mode, big, slide])
		_check(big == 1, "host draws others %s: a teleport snaps in one frame" % mode)
		_check(slide == 0, "host draws others %s: and nothing slides" % mode)
	# a player with a single record is held where it is; a player that is not in the world is null
	var rig2: Rig = Rig.player_rig({"loss_rate": 0.0, "jitter_ms": 0.0, "layer": {"authority": "host", "step": Callable(self, "_walk_step"), "spawn": func(peer: int) -> Dictionary: return {"x": 50.0 + float(peer)}}})
	var hl2: OneLobbyNetPlayers = rig2.host_players()["layer"]
	var a2 := rig2.join_players("a")
	var apeer2: int = (a2["p"] as Base.RepPlayer).peer_id()
	_check(hl2.get_state(apeer2) == null, "host draws others: a player that is not in the world yet is null")
	var guard := 0
	while hl2.get_state(apeer2) == null and guard < 400:
		rig2.step() # stop at the first frame the player exists: at most one record
		guard += 1
	_check(hl2.get_state(apeer2) != null and absf(float((hl2.get_state(apeer2) as Dictionary)["x"]) - (50.0 + float(apeer2))) < 0.1, "host draws others: a single record is held at the spawn point")
	_check(hl2.get_state(apeer2 + 100) == null, "host draws others: an unknown peer is null")


## Authority "host": the owner starts where the host spawned it (JS twin: "host authority: the owner starts where the host spawned it").
func _test_host_authority_spawn() -> void:
	var spawn_x := 50.0
	var rig: Rig = Rig.player_rig({"layer": {"authority": "host", "step": Callable(self, "_walk_step"), "spawn": func(_peer: int) -> Dictionary: return {"x": spawn_x, "y": 1.0}}})
	var hl: OneLobbyNetPlayers = rig.host_players()["layer"]
	var a := rig.join_players("a")
	var al: OneLobbyNetPlayers = a["layer"]
	var corrected := [0]
	al.corrected.connect(func(_s: Dictionary) -> void: corrected[0] += 1)
	# the owner holds "walk right" from its very first tick, including the ticks before the host's first state arrives
	al.tick.connect(func(_n: int) -> void: al.set_local_input({"move_x": 1.0, "move_y": 0.0, "yaw": 90.0}))
	var first_x := -1.0
	var min_x := INF
	var frames := 0
	var without_state := 0
	var inputs_before := -1
	for i in 300:
		rig.step()
		var l := al.local_state()
		if l.is_empty():
			without_state += 1
			inputs_before = int(al.session.stats.inputs_sent)
			_check(al.get_state(al.local_peer_id) == null, "host authority spawn: get_state of the local player is null before its first state")
			continue
		frames += 1
		if first_x < 0.0:
			first_x = float(l["x"])
		min_x = minf(min_x, float(l["x"]))
	print("host authority spawn x=%d: %d frames without a local state, first local x %.3f, lowest local x %.3f, snaps %d, corrections %d, corrected events %d, inputs sent before the first state %d" % [int(spawn_x), without_state, first_x, min_x, al.smoother.snap_count, al.stats["corrections"], corrected[0], inputs_before])
	_check(frames > 200, "host authority spawn: the owner gets a local state (%d frames)" % frames)
	_check(without_state > 0, "host authority spawn: and has none before the host's first state")
	_check(min_x > spawn_x - 1.0, "host authority spawn: the owner never reads a local position near the origin (%.3f)" % min_x)
	_check(absf(first_x - spawn_x) < 6.0 / 30.0 + 0.01, "host authority spawn: the first local state is within one tick's travel of the spawn point (%.3f)" % first_x)
	_check(al.smoother.snap_count == 0, "host authority spawn: no snap")
	_check(int(al.stats["corrections"]) == 0 and corrected[0] == 0, "host authority spawn: no correction")
	_check(inputs_before == 0, "host authority spawn: no input is sent before the first state")
	_check(float((hl.latest_state(al.local_peer_id) as Dictionary)["x"]) > spawn_x, "host authority spawn: the host stepped the player from the spawn point")


# ====================================================================== D1 to D9 ========================================

func _test_d1() -> void:
	for mode: String in MODES:
		var worst := 0.0
		for seed_value: int in D1_SEEDS:
			var s := _scene(mode, {"seed": seed_value})
			_drive(s)
			var rig: Rig = s["rig"]
			rig.run(3.0)
			var rec := _record(s, 20.0)
			var r := _compare_paths(rec["owner"], rec["watched"])
			var bl: OneLobbyNetPlayers = s["bl"]
			print("D1 %s seed %d: lag %d ms, mean %.3f m, p99 %.3f m, worst %.3f m, delay %.1f ms jitter %.1f ms" % [mode, seed_value, r["lag_ms"], r["mean"], r["p99"], r["max"], bl.session.interpolation_delay_ms, bl.session.jitter_ms])
			_check((rec["watched"] as Path).size() > 1000, "D1 %s seed %d: watched frames" % [mode, seed_value])
			_check(float(r["mean"]) < D1_MEAN_ERROR_M, "D1 %s seed %d: mean error under %.2f m" % [mode, seed_value, D1_MEAN_ERROR_M])
			_check(float(r["p99"]) < D1_P99_ERROR_M, "D1 %s seed %d: 99th percentile under %.2f m" % [mode, seed_value, D1_P99_ERROR_M])
			worst = maxf(worst, float(r["max"]))
		print("D1 %s: worst frame over all seeds %.3f m" % [mode, worst])
		_check(worst < D1_MAX_ERROR_M, "D1 %s: worst frame over all seeds under %.2f m" % [mode, D1_MAX_ERROR_M])


## A lost or late input leaves a tick on which the host has nothing new from the owner. Owner mode must not keep that tick as
## extra delay for the rest of the run (loss 3%, no jitter, these seeds).
func _test_d1b() -> void:
	for seed_value: int in [4, 10, 13]:
		var s := _scene("owner", {"seed": seed_value, "jitter_ms": 0.0})
		_drive(s)
		var rig: Rig = s["rig"]
		rig.run(3.0)
		var rec := _record(s, 20.0)
		var r := _compare_paths(rec["owner"], rec["watched"])
		print("D1b seed %d: lag %d ms, mean %.3f m, worst %.3f m" % [seed_value, r["lag_ms"], r["mean"], r["max"]])
		_check(float(r["max"]) < D1B_MAX_ERROR_M, "D1b seed %d: a stalled tick does not stay as delay, worst error under %.2f m" % [seed_value, D1B_MAX_ERROR_M])


## One runner hitch: a process that stalls for 4, 5 or 7 ticks mid-walk, then runs on. The owner's stall, or the host's, must not leave
## the host's record of the walker a tick or more ahead for the rest of the run. As in the engine-smoke players run, the path judged is
## the host's own record of the walker against the walker's own path (not a third peer's interpolated view). Samples are not taken while
## the hitched process is stopped (a stopped process samples nothing) nor for two seconds after it (the stall itself is lost time and the
## path takes a moment to settle; it is the lag that is left that counts). The whole of the rest is judged with the D1 bounds, one
## constant lag fitted over the run, and the lag fitted after the hitch must be the lag fitted before it, give or take half a tick.
## No loss (jitter 20 ms as in D1): a lost command is a step a host-mode host never takes whatever the hitch, which would bury the hitch in noise.
func _test_d1c() -> void:
	for mode: String in MODES:
		for who: String in ["a", "host"]:
			for ticks: int in [4, 5, 7]:
				var worst := 0.0
				var worst_mean := 0.0
				var max_shift := 0
				for seed_value: int in D1_SEEDS:
					var s := _scene(mode, {"seed": seed_value, "loss_rate": 0.0})
					_drive(s)
					var rig: Rig = s["rig"]
					rig.run(6.0) # past the start-up of the clocks and the buffers
					var al: OneLobbyNetPlayers = s["al"]
					var hl: OneLobbyNetPlayers = s["hl"]
					var frozen_frames := ceili(float(ticks) * 1000.0 / 30.0 / float(rig.frame_ms))
					var hitch_at := int(10000.0 / float(rig.frame_ms))
					var settle := int(2000.0 / float(rig.frame_ms))
					var frames := int(20000.0 / float(rig.frame_ms))
					var owner := Path.new()
					var before := Path.new()
					var after := Path.new()
					var all := Path.new()
					for i in frames:
						if i == hitch_at:
							rig.frozen[who] = true
						if i == hitch_at + frozen_frames:
							rig.frozen.erase(who)
						rig.step()
						var stopped := i >= hitch_at and i < hitch_at + frozen_frames
						var t := float(rig.now_ms())
						var mine: Variant = al.get_state(al.local_peer_id)
						if mine != null and not (stopped and who == "a"):
							owner.add(t, mine)
						var seen: Variant = hl.get_state(al.local_peer_id)
						if seen == null:
							continue
						if i < hitch_at:
							before.add(t, seen)
							all.add(t, seen)
						elif i >= hitch_at + frozen_frames + settle:
							after.add(t, seen)
							all.add(t, seen)
					var r := _compare_paths(owner, all)
					var rb := _compare_paths(owner, before)
					var ra := _compare_paths(owner, after)
					print("D1c %s %s %d ticks seed %d: lag %d ms, mean %.3f m, worst %.3f m; lag before %d ms, after %d ms" % [mode, who, ticks, seed_value, r["lag_ms"], r["mean"], r["max"], rb["lag_ms"], ra["lag_ms"]])
					_check(all.size() > 600, "D1c %s %s %d: watched frames" % [mode, who, ticks])
					worst = maxf(worst, float(r["max"]))
					worst_mean = maxf(worst_mean, float(r["mean"]))
					max_shift = maxi(max_shift, absi(int(ra["lag_ms"]) - int(rb["lag_ms"])))
				_check(worst_mean < D1_MEAN_ERROR_M, "D1c %s, %s stalls %d ticks: mean error under %.2f m (%.3f)" % [mode, who, ticks, D1_MEAN_ERROR_M, worst_mean])
				_check(worst < D1_MAX_ERROR_M, "D1c %s, %s stalls %d ticks: worst frame under %.2f m (%.3f)" % [mode, who, ticks, D1_MAX_ERROR_M, worst])
				_check(max_shift <= 16, "D1c %s, %s stalls %d ticks: the lag moved by %d ms across the hitch" % [mode, who, ticks, max_shift])


## A run of lost inputs: at 10, 13 and 16 s every fast frame is dropped for exactly 3 ticks (no random loss, jitter 20 ms as in D1), and
## the inputs come back by redundancy, so the host loses none (stats.inputs_lost stays 0) but sees 3 stalled ticks each time. A host-authority
## host steps nothing on a stalled tick; its record of the walker must not show that as a plateau and a double step. The record of the
## walker (6 s to 20 s) is judged against the walker's own path with the D1 bounds.
func _test_d1d() -> void:
	var worst := 0.0
	var worst_mean := 0.0
	var drop_from := [10000, 13000, 16000]
	var drop_ms := 100 # 3 ticks of 33.3 ms
	for seed_value: int in D1_SEEDS:
		var s := _scene("host", {"seed": seed_value, "loss_rate": 0.0})
		_drive(s)
		var rig: Rig = s["rig"]
		rig.run(6.0) # past the start-up of the clocks and the buffers
		var al: OneLobbyNetPlayers = s["al"]
		var hl: OneLobbyNetPlayers = s["hl"]
		var frames := int(14000.0 / float(rig.frame_ms))
		var owner := Path.new()
		var seen := Path.new()
		for i in frames:
			var t0 := rig.now_ms()
			var dropping := false
			for d: int in drop_from:
				if t0 >= d and t0 < d + drop_ms:
					dropping = true
			if dropping:
				rig.net.drop_fast = func() -> bool: return true
			else:
				rig.net.drop_fast = Callable()
			rig.step()
			var t := float(rig.now_ms())
			var mine: Variant = al.get_state(al.local_peer_id)
			if mine != null:
				owner.add(t, mine)
			var h: Variant = hl.get_state(al.local_peer_id)
			if h != null:
				seen.add(t, h)
		var r := _compare_paths(owner, seen)
		var lost := int(hl.session.stats.inputs_lost)
		print("D1d host seed %d: lag %d ms, mean %.3f m, worst %.3f m, n %d, inputs lost %d" % [seed_value, r["lag_ms"], r["mean"], r["max"], seen.size(), lost])
		_check(lost == 0, "D1d seed %d: the host lost no input (%d)" % [seed_value, lost])
		_check(seen.size() > 600, "D1d seed %d: watched frames" % seed_value)
		worst = maxf(worst, float(r["max"]))
		worst_mean = maxf(worst_mean, float(r["mean"]))
	_check(worst_mean < D1_MEAN_ERROR_M, "D1d: mean error under %.2f m (%.3f)" % [D1_MEAN_ERROR_M, worst_mean])
	_check(worst < D1_MAX_ERROR_M, "D1d: worst frame under %.2f m (%.3f)" % [D1_MAX_ERROR_M, worst])


func _test_d2() -> void:
	for mode: String in MODES:
		var s := _scene(mode)
		_drive(s)
		var rig: Rig = s["rig"]
		rig.run(3.0)
		var rec := _record(s, 20.0)
		var watched: Path = rec["watched"]
		var still := 0.0
		var longest := 0.0
		for i in range(1, watched.size()):
			still = still + float(rig.frame_ms) if watched.dist(i, i - 1) < 1e-4 else 0.0
			longest = maxf(longest, still)
		print("D2 %s: longest stand-still %d ms over %d frames" % [mode, longest, watched.size()])
		_check(longest <= CARRY_ON_CAP_MS, "D2 %s: never still longer than 250 ms" % mode)
		# the host stops sending: B's view of A carries on by its velocity for at most the cap, then holds
		rig.frozen["host"] = true
		rig.run(0.8)
		var bl: OneLobbyNetPlayers = s["bl"]
		var peer := _peer(s)
		var newest: Dictionary = bl.latest_state(peer)
		var p1: Dictionary = bl.get_state(peer)
		rig.run(1.5)
		var p2: Dictionary = bl.get_state(peer)
		var carried := _dist3(p1, newest)
		var speed := sqrt(float(newest["vx"]) ** 2 + float(newest["vy"]) ** 2 + float(newest["vz"]) ** 2)
		print("D2 %s: after the stop it held %.3f m past the newest snapshot (speed %.2f m/s, the cap allows %.3f m)" % [mode, carried, speed, speed * 0.25])
		_check(_dist3(p2, p1) < 1e-6, "D2 %s: then it holds" % mode)
		_check(carried <= speed * (CARRY_ON_CAP_MS / 1000.0) + 0.05, "D2 %s: carried on by at most the cap" % mode)


## Played events of one run: {name, seq, tick, late, render_tick}.
func _event_run(mode: String, loss: float) -> Dictionary:
	var s := _scene(mode, {"loss_rate": loss})
	_drive(s)
	var rig: Rig = s["rig"]
	rig.run(3.0)
	var at_b: Array = []
	var at_host: Array = []
	var peer := _peer(s)
	var bl: OneLobbyNetPlayers = s["bl"]
	var hl: OneLobbyNetPlayers = s["hl"]
	var al: OneLobbyNetPlayers = s["al"]
	for name: String in ["jump", "shoot", "melee"]:
		bl.on_action(name, func(e: Dictionary) -> void:
			if e["player"] == peer:
				at_b.append({"name": name, "seq": e["seq"], "tick": e["tick"], "late": e["late"], "render_tick": bl.session.render_tick}))
		hl.on_action(name, func(e: Dictionary) -> void:
			if e["player"] == peer:
				at_host.append({"name": name, "seq": e["seq"], "tick": e["tick"], "late": e["late"], "render_tick": 0.0}))
	var sent := {"jump": 0, "shoot": 0, "melee": 0}
	var names := ["jump", "shoot", "melee"]
	var frames := int(30.0 * 1000.0 / float(rig.frame_ms))
	var every := roundi(120.0 / float(rig.frame_ms))
	for i in frames:
		rig.step()
		if i % every == 0:
			var name: String = names[(i / every) % 3]
			al.send_action(name, {"swing": int(sent["melee"]) % 256} if name == "melee" else {})
			sent[name] += 1
	rig.run(3.0) # let the last ones arrive
	return {"sent": sent, "at_b": at_b, "at_host": at_host}


func _count_named(list: Array, name: String) -> int:
	return list.filter(func(e: Dictionary) -> bool: return e["name"] == name).size()


func _test_d3() -> void:
	for mode: String in MODES:
		for loss: float in [0.03, 0.3]:
			var r := _event_run(mode, loss)
			var sent: Dictionary = r["sent"]
			var at_b: Array = r["at_b"]
			var at_host: Array = r["at_host"]
			var total: int = sent["jump"] + sent["shoot"] + sent["melee"]
			var label := "D3 %s, %d%% loss" % [mode, roundi(loss * 100.0)]
			_check(total >= 200, "%s: at least 200 events sent (%d)" % [label, total])
			for name: String in ["jump", "shoot", "melee"]:
				_check(_count_named(at_b, name) == int(sent[name]), "%s: %s at B exactly once (%d of %d)" % [label, name, _count_named(at_b, name), sent[name]])
				_check(_count_named(at_host, name) == int(sent[name]), "%s: %s at the host exactly once (%d of %d)" % [label, name, _count_named(at_host, name), sent[name]])
			var seqs := {}
			for e: Dictionary in at_b:
				seqs[e["seq"]] = true
			_check(seqs.size() == total, "%s: every sequence number once" % label)
			var late := at_b.filter(func(e: Dictionary) -> bool: return e["late"]).size()
			var worst := -INF
			var best := INF
			for e: Dictionary in at_b:
				if not e["late"]:
					var d: float = float(e["render_tick"]) - float(e["tick"])
					worst = maxf(worst, d)
					best = minf(best, d)
			print("%s: sent %d, at B %d, at host %d, lost %d, doubled %d, late %d, on-time ones played at most %.2f ticks after their tick" % [label, total, at_b.size(), at_host.size(), total - seqs.size(), at_b.size() - seqs.size(), late, worst])
			if loss <= 0.03:
				_check(late <= ceili(float(total) * 0.02), "%s: late at most 2%%" % label)
				_check(worst <= D3_ON_TIME_TICKS, "%s: on-time ones within 2 ticks" % label)
				_check(best >= 0.0, "%s: never played before their tick" % label)


func _test_d4() -> void:
	for mode: String in MODES:
		var s := _scene(mode)
		_drive(s)
		var rig: Rig = s["rig"]
		var al: OneLobbyNetPlayers = s["al"]
		var hl: OneLobbyNetPlayers = s["hl"]
		# a busy second: a jump every 400 ms, a shot every 700 ms
		var n := [0]
		al.tick.connect(func(_t: int) -> void:
			n[0] += 1
			if n[0] % 12 == 0:
				al.send_action("jump")
			if n[0] % 21 == 0:
				al.send_action("shoot", {"yaw": 10.0, "pitch": 0.0}))
		rig.run(8.0)
		var to_client := 0.0
		var to_host := 0.0
		var k := 0
		for i in 300:
			rig.step()
			if i % 6 == 0:
				to_client += float(hl.bytes_per_second(_peer(s))["sent"])
				to_host += float(al.bytes_per_second(al.session.host_peer_id)["sent"])
				k += 1
		to_client /= float(k)
		to_host /= float(k)
		print("D4 %s: host to client A %.0f B/s, client A to host %.0f B/s (3 players, state %d B, input %d B, jump every 400 ms and shot every 700 ms)" % [mode, to_client, to_host, al.codec.state_bytes(), al.codec.input_bytes()])
		_check(to_client < D4_HOST_TO_CLIENT, "D4 %s: host to client under 1500 B/s" % mode)
		_check(to_host < D4_CLIENT_TO_HOST, "D4 %s: client to host under 3500 B/s" % mode)
		_check(to_client > 100.0, "D4 %s: the measurement sees traffic" % mode)


func _test_d5() -> void:
	var glitch := [0.0]
	var host_step := func(st: Dictionary, i: Dictionary, dt: float) -> Dictionary:
		var r := _walk_step(st, i, dt)
		if float(glitch[0]) != 0.0 and float(i["yaw"]) > 89.0 and float(i["yaw"]) < 91.0:
			r["x"] = float(r["x"]) + float(glitch[0])
			glitch[0] = 0.0
		return r
	var rig: Rig = Rig.player_rig({"latency_ms": 50.0, "loss_rate": 0.1, "jitter_ms": 10.0, "layer": func(name: String) -> Dictionary:
		return {"authority": "host", "step": host_step if name == "host" else Callable(self, "_walk_step")}})
	var hl: OneLobbyNetPlayers = rig.host_players()["layer"]
	var a := rig.join_players("a")
	var al: OneLobbyNetPlayers = a["layer"]
	var apeer: int = (a["p"] as Base.RepPlayer).peer_id()
	var moving := [true]
	al.tick.connect(func(_n: int) -> void:
		var t := rig.now_ms() / 1000.0
		al.set_local_input({"move_x": sin(0.8 * t), "move_y": cos(0.8 * t), "yaw": 90.0} if moving[0] else {"move_x": 0.0, "move_y": 0.0, "yaw": 90.0}))
	rig.run(3.0)
	var max_err := 0.0
	for i in 400:
		rig.step()
		var host: Variant = hl.latest_state(apeer)
		if host != null and i > 100:
			var l := al.local_state()
			max_err = maxf(max_err, sqrt((float(l["x"]) - float(host["x"])) ** 2 + (float(l["z"]) - float(host["z"])) ** 2))
	moving[0] = false
	rig.run(1.5)
	var host_s: Dictionary = hl.latest_state(apeer)
	var err := _dist3(al.local_state(), host_s)
	print("D5: max |predicted - host| while moving %.2f m (the host is behind by the round trip); at rest %.4f m" % [max_err, err])
	_check(err < 0.05, "D5: at rest the owner's predicted state equals the host's (%.4f m)" % err)

	# a small disagreement of the host: blended over 100 ms, no snap
	moving[0] = true
	rig.run(1.0)
	var before := al.smoother.snap_count
	glitch[0] = 0.5
	var peak := 0.0
	for i in 40:
		rig.step()
		peak = maxf(peak, al.smoother.offset_remaining())
	rig.run(0.3)
	print("D5: a 0.5 m disagreement of the host: offset peaked at %.2f m, %.3f m left after 0.3 s, snaps %d" % [peak, al.smoother.offset_remaining(), al.smoother.snap_count - before])
	_check(peak > 0.3, "D5: a 0.5 m correction shows as an offset")
	_check(al.smoother.snap_count == before, "D5: and does not snap")
	_check(al.smoother.offset_remaining() < 0.05, "D5: and decays")

	# a large one snaps
	rig.run(0.5)
	var before2 := al.smoother.snap_count
	glitch[0] = 6.0
	rig.run(1.0)
	print("D5: a 6 m disagreement of the host: snaps %d" % (al.smoother.snap_count - before2))
	_check(al.smoother.snap_count == before2 + 1, "D5: a 6 m disagreement snaps once")


func _steps(positions: Path) -> Array[float]:
	var out: Array[float] = []
	for i in range(1, positions.size()):
		out.append(positions.dist(i, i - 1))
	return out


func _test_d6() -> void:
	for mode: String in MODES:
		var s := _scene(mode)
		var rig: Rig = s["rig"]
		var al: OneLobbyNetPlayers = s["al"]
		var bl: OneLobbyNetPlayers = s["bl"]
		var hl: OneLobbyNetPlayers = s["hl"]
		var peer := _peer(s)
		# A's game keeps walking its path from wherever it was put: the path plus a shift that a teleport changes
		var shift := {"x": 0.0, "z": 0.0}
		if mode == "owner":
			al.tick.connect(func(_n: int) -> void:
				var p := _path_at(rig.now_ms())
				p["x"] = float(p["x"]) + float(shift["x"])
				p["z"] = float(p["z"]) + float(shift["z"])
				al.set_local_state(p))
		else:
			_drive(s)
		rig.run(4.0)
		var seen_respawn: Array = []
		bl.on_action("respawn", func(e: Dictionary) -> void: seen_respawn.append(e["player"]))
		for kind: String in ["teleport", "respawn"]:
			var watched := Path.new()
			var to := {"x": 60.0, "z": 60.0} if kind == "teleport" else {"x": -70.0, "z": -70.0}
			for i in 120:
				if i == 30:
					if mode == "owner":
						var p := _path_at(rig.now_ms())
						shift["x"] = float(to["x"]) - float(p["x"])
						shift["z"] = float(to["z"]) - float(p["z"])
						if kind == "teleport":
							al.teleport(to)
						else:
							al.respawn(to)
					elif kind == "teleport":
						hl.teleport_player(peer, to)
					else:
						hl.respawn_player(peer, to)
				rig.step()
				watched.add(float(rig.now_ms()), bl.get_state(peer))
			var d := _steps(watched)
			var big := d.filter(func(x: float) -> bool: return x > 40.0).size()
			var slide := d.filter(func(x: float) -> bool: return x > 1.0 and x < 40.0).size()
			var ordinary := d.filter(func(x: float) -> bool: return x <= 1.0)
			print("D6 %s %s: %d frame(s) jumped over 40 m, %d frame(s) slid between 1 and 40 m; largest ordinary step %.2f m" % [mode, kind, big, slide, (ordinary.max() as float)])
			_check(big == 1, "D6 %s %s: exactly one frame jumps" % [mode, kind])
			_check(slide == 0, "D6 %s %s: nothing slides" % [mode, kind])
			if mode == "host":
				rig.run(1.0)
		_check(seen_respawn == [peer], "D6 %s: the respawn event arrives once" % mode)


func _test_d7_speed() -> void:
	var s := _scene("owner", {"layer": {"authority": "owner", "limits": {"max_speed": 12.0}}})
	var rig: Rig = s["rig"]
	var al: OneLobbyNetPlayers = s["al"]
	var hl: OneLobbyNetPlayers = s["hl"]
	var bl: OneLobbyNetPlayers = s["bl"]
	var peer := _peer(s)
	var cheat := [0.0]
	al.tick.connect(func(_n: int) -> void:
		var p := _path_at(rig.now_ms())
		p["x"] = float(p["x"]) + float(cheat[0])
		cheat[0] = 0.0
		al.set_local_state(p))
	var corrected: Array = []
	al.corrected.connect(func(_st: Dictionary) -> void: corrected.append(rig.now_ms()))
	rig.run(6.0)
	_check(hl.stats["limit_violations"] == 0, "D7 speed: an honest path at 9.6 m/s under a 12 m/s limit is never refused")
	cheat[0] = 30.0 # one update claims a move of 30 m in one tick
	var worst_host := 0.0
	var worst_watched := 0.0
	for i in 120:
		rig.step()
		var now := _path_at(rig.now_ms())
		var h: Dictionary = hl.latest_state(peer)
		worst_host = maxf(worst_host, sqrt((float(h["x"]) - float(now["x"])) ** 2 + (float(h["z"]) - float(now["z"])) ** 2))
		var seen: Dictionary = bl.get_state(peer)
		var then := _path_at(float(rig.now_ms()) - 400.0)
		worst_watched = maxf(worst_watched, sqrt((float(seen["x"]) - float(then["x"])) ** 2 + (float(seen["z"]) - float(then["z"])) ** 2))
	print("D7 speed: violations %d, owner told %dx, worst host distance from the true path %.2f m, worst distance the watcher saw %.2f m" % [hl.stats["limit_violations"], corrected.size(), worst_host, worst_watched])
	_check(hl.stats["limit_violations"] >= 1, "D7 speed: the cheat is refused")
	_check(corrected.size() >= 1, "D7 speed: the owner is told")
	_check(worst_host < 10.0, "D7 speed: the host is never at the claimed +30 m")
	_check(worst_watched < 10.0, "D7 speed: the watcher never sees it")
	var before: int = hl.stats["limit_violations"]
	rig.run(3.0)
	_check(hl.stats["limit_violations"] == before, "D7 speed: and it goes on without further refusals")
	var h2: Dictionary = hl.latest_state(peer)
	var now2 := _path_at(rig.now_ms())
	_check(sqrt((float(h2["x"]) - float(now2["x"])) ** 2 + (float(h2["z"]) - float(now2["z"])) ** 2) < 3.0, "D7 speed: the owner is accepted again, back on its path")


func _test_d7_teleport() -> void:
	var s := _scene("owner", {"layer": {"authority": "owner", "limits": {"max_speed": 12.0, "max_step": 3.0}}})
	var rig: Rig = s["rig"]
	var al: OneLobbyNetPlayers = s["al"]
	var hl: OneLobbyNetPlayers = s["hl"]
	var peer := _peer(s)
	var shift := {"x": 0.0, "z": 0.0}
	al.tick.connect(func(_n: int) -> void:
		var p := _path_at(rig.now_ms())
		p["x"] = float(p["x"]) + float(shift["x"])
		p["z"] = float(p["z"]) + float(shift["z"])
		al.set_local_state(p))
	# a game that is put back takes the host's state as its own
	al.corrected.connect(func(st: Dictionary) -> void:
		var p := _path_at(rig.now_ms())
		shift["x"] = float(st["x"]) - float(p["x"])
		shift["z"] = float(st["z"]) - float(p["z"]))
	rig.run(3.0)
	var jump := func(to: Dictionary) -> void:
		var p := _path_at(rig.now_ms())
		shift["x"] = float(to["x"]) - float(p["x"])
		shift["z"] = float(to["z"]) - float(p["z"])
		al.teleport(to)
	jump.call({"x": 80.0, "z": 80.0})
	rig.run(1.5)
	_check(hl.stats["limit_violations"] == 0, "D7 teleport: the first teleport passes")
	var h: Dictionary = hl.latest_state(peer)
	_check(sqrt((float(h["x"]) - 80.0) ** 2 + (float(h["z"]) - 80.0) ** 2) < 14.0, "D7 teleport: the host has the player at the new centre")
	jump.call({"x": -80.0, "z": -80.0})
	rig.run(0.3)
	jump.call({"x": 80.0, "z": -80.0}) # a second teleport inside the second
	rig.run(2.0)
	print("D7 teleport: violations %d" % hl.stats["limit_violations"])
	_check(hl.stats["limit_violations"] == 1, "D7 teleport: the one inside the second is refused (%d)" % hl.stats["limit_violations"])


func _test_d7_shots() -> void:
	var s := _scene("owner", {"layer": {"authority": "owner", "limits": {"min_shot_interval_ms": 250.0}}})
	var rig: Rig = s["rig"]
	_drive(s)
	var al: OneLobbyNetPlayers = s["al"]
	var hl: OneLobbyNetPlayers = s["hl"]
	var bl: OneLobbyNetPlayers = s["bl"]
	var peer := _peer(s)
	var at_host: Array = []
	var at_b: Array = []
	hl.on_action("shoot", func(e: Dictionary) -> void:
		if e["player"] == peer:
			at_host.append(e["seq"]))
	bl.on_action("shoot", func(e: Dictionary) -> void:
		if e["player"] == peer:
			at_b.append(e["seq"]))
	rig.run(3.0)
	# honest: one shot every 300 ms
	for i in 10:
		al.send_action("shoot", {"yaw": 5.0})
		rig.run(0.3)
	rig.run(1.0)
	_check(hl.stats["actions_rate_limited"] == 0, "D7 shots: an honest 300 ms cadence is never limited")
	_check(at_host.size() == 10, "D7 shots: ten arrive at the host (%d)" % at_host.size())
	# fast: one shot every 100 ms for 3 s
	for i in 30:
		al.send_action("shoot", {"yaw": 5.0})
		rig.run(0.1)
	rig.run(2.0)
	print("D7 shots: 40 sent, %d accepted at the host, %d dropped and counted, %d seen by the other client" % [at_host.size(), hl.stats["actions_rate_limited"], at_b.size()])
	_check(hl.stats["actions_rate_limited"] > 10, "D7 shots: the fast ones are dropped and counted")
	_check(at_host.size() + int(hl.stats["actions_rate_limited"]) == 40, "D7 shots: accepted plus dropped is everything")
	_check(at_b.size() == at_host.size(), "D7 shots: the other client sees exactly the accepted ones")


## B shoots 30 times at A (strafing) on a 60 ms one-way link and the host judges each shot with `rewound`. Returns `errors` (every
## shot), `inside` (the shots whose view was within the rewind limit when the shot reached the host), `plain` (without rewind), `past`
## (how many were past the limit) and `limit_ms`.
func _shoot_at_strafer(mode: String, max_rewind_ms: float) -> Dictionary:
	var o := {"latency_ms": 60.0}
	if max_rewind_ms > 0.0:
		o["session"] = {"max_rewind_ms": max_rewind_ms}
	var s := _scene(mode, o)
	_drive(s) # A is the target, strafing
	var rig: Rig = s["rig"]
	var hl: OneLobbyNetPlayers = s["hl"]
	var bl: OneLobbyNetPlayers = s["bl"]
	var apeer := _peer(s)
	var bpeer := (s["b"] as Base.RepPlayer).peer_id()
	rig.run(4.0)
	# B shoots at what it renders this frame
	var seen := [null]
	var errors: Array[float] = []
	var plain: Array[float] = []
	var inside: Array[float] = []
	var past := [0]
	hl.on_action("shoot", func(e: Dictionary) -> void:
		if e["player"] != bpeer or seen[0] == null:
			return
		var then: Dictionary = hl.rewound(apeer, int(e["args"]["view"]))
		var now: Dictionary = hl.latest_state(apeer)
		var sx: float = seen[0][0]
		var sz: float = seen[0][1]
		var err := sqrt((float(then["x"]) - sx) ** 2 + (float(then["z"]) - sz) ** 2)
		errors.append(err)
		var age_ms := (float(hl.session.clock.tick) - float(e["args"]["view"]) / 256.0) * hl.session.clock.tick_ms()
		if age_ms <= float(hl.session.config["max_rewind_ms"]):
			inside.append(err)
		else:
			past[0] += 1
		plain.append(sqrt((float(now["x"]) - sx) ** 2 + (float(now["z"]) - sz) ** 2))
		seen[0] = null)
	for i in 30:
		rig.run(0.7)
		var v: Dictionary = bl.get_state(apeer)
		seen[0] = [float(v["x"]), float(v["z"])]
		bl.send_action("shoot", {"yaw": 0.0, "pitch": 0.0}) # `view` is the tick B is rendering
		rig.run(0.5)
	return {"errors": errors, "inside": inside, "plain": plain, "past": past[0], "limit_ms": float(hl.session.config["max_rewind_ms"])}


func _test_d8() -> void:
	for mode: String in MODES:
		# 60 ms one way: the default rewind of 250 ms covers a shooter's view age plus its shot's flight only up to about that, with almost
		# no room (spec/net-player.md section 8), so some shots are past the limit and are judged at the oldest allowed state
		var r := _shoot_at_strafer(mode, 0.0)
		var errors: Array[float] = r["errors"]
		var inside: Array[float] = r["inside"]
		var plain: Array[float] = r["plain"]
		var worst: float = errors.max()
		var worst_inside: float = (inside.max() as float) if inside.size() > 0 else 0.0
		print("D8 %s: %d shots, error with rewind at most %.3f m, without rewind %.2f to %.2f m" % [mode, errors.size(), worst, plain.min(), plain.max()])
		print("D8 %s: %d of the shots were older than the %d ms rewind limit (the clamp cuts in); the others are off by at most %.3f m" % [mode, int(r["past"]), int(r["limit_ms"]), worst_inside])
		_check(errors.size() == 30, "D8 %s: thirty shots reach the host (%d)" % [mode, errors.size()])
		_check(inside.size() >= 15 and worst_inside < 0.1, "D8 %s: with rewind the host finds the target where the shooter saw it (shots inside the rewind limit)" % mode)
		_check(worst < 0.3, "D8 %s: and even the clamped ones are off by under 0.3 m" % mode)
		_check(plain.max() > 1.0, "D8 %s: without rewind it would miss" % mode)


## The claim "raise maxRewindMs for slower links": the same link with a limit of 400 ms, where every shot must be found.
func _test_d8_400() -> void:
	for mode: String in MODES:
		var r := _shoot_at_strafer(mode, 400.0)
		var errors: Array[float] = r["errors"]
		var worst: float = errors.max()
		print("D8 %s max_rewind_ms %d: %d shots, %d past the limit, error at most %.3f m" % [mode, int(r["limit_ms"]), errors.size(), int(r["past"]), worst])
		_check(errors.size() == 30, "D8 400 %s: thirty shots reach the host (%d)" % [mode, errors.size()])
		_check(int(r["past"]) == 0, "D8 400 %s: no shot is past the limit" % mode)
		_check(worst < 0.1, "D8 400 %s: every shot is found where the shooter saw it (%.3f m)" % [mode, worst])


func _test_d8_clamp() -> void:
	var rig: Rig = Rig.player_rig({"session": {"max_rewind_ms": 200}, "layer": {"authority": "owner"}})
	var l: OneLobbyNetPlayers = rig.host_players()["layer"]
	rig.run(1.0)
	var now := l.session.clock.tick
	_check(absf(l.rewind_tick(0) - float(now - 6)) < 1e-6, "D8 clamp: a very old view is clamped to 200 ms back")
	_check(absf(l.rewind_tick(int((float(now) - 2.5) * 256.0)) - (float(now) - 2.5)) < 1e-6, "D8 clamp: a recent view is kept")
	_check(absf(l.rewind_tick(int(float(now + 50) * 256.0)) - float(now)) < 1e-6, "D8 clamp: a view from the future is now")


func _test_d9() -> void:
	var rig: Rig = Rig.player_rig({"layer": {"authority": "owner"}})
	var h := rig.host_players()
	var a := rig.join_players("a")
	var b := rig.join_players("b")
	var hl: OneLobbyNetPlayers = h["layer"]
	var al: OneLobbyNetPlayers = a["layer"]
	var bl: OneLobbyNetPlayers = b["layer"]
	var host: Base.RepPlayer = h["p"]
	var pa: Base.RepPlayer = a["p"]
	var pb: Base.RepPlayer = b["p"]
	var walk := func(l: OneLobbyNetPlayers, phase: float) -> void:
		l.tick.connect(func(_n: int) -> void: l.set_local_state(_path_at(rig.now_ms(), phase)))
	walk.call(hl, 0.0)
	walk.call(al, 1.0)
	walk.call(bl, 2.0)
	var joined: Array = []
	var left: Array = []
	hl.player_joined.connect(func(p: int) -> void: joined.append(p))
	hl.player_left.connect(func(p: int) -> void: left.append(p))
	rig.run(4.0)
	var all: Array = [host.peer_id(), pa.peer_id(), pb.peer_id()]
	all.sort()
	_check(_sorted(hl.player_ids()) == all and _sorted(al.player_ids()) == all and _sorted(bl.player_ids()) == all, "D9: everyone sees the three players")

	# a late joiner
	var c := rig.join_players("c")
	var cl: OneLobbyNetPlayers = c["layer"]
	walk.call(cl, 3.0)
	rig.run(4.0)
	var pc: Base.RepPlayer = c["p"]
	var with_c: Array = [host.peer_id(), pa.peer_id(), pb.peer_id(), pc.peer_id()]
	with_c.sort()
	_check(_sorted(cl.player_ids()) == with_c, "D9: the late joiner sees everyone")
	_check(_sorted(al.player_ids()) == with_c, "D9: and everyone sees the late joiner")
	_check(cl.get_state(pa.peer_id()) != null, "D9: the late joiner can draw A")

	# a spectator has no player, and sees the others
	var d := rig.join_players("d", true)
	var dl: OneLobbyNetPlayers = d["layer"]
	var pd: Base.RepPlayer = d["p"]
	rig.run(4.0)
	_check(not hl.player_ids().has(pd.peer_id()) and not al.player_ids().has(pd.peer_id()), "D9: a spectator has no player")
	_check(_sorted(dl.player_ids()) == with_c, "D9: and sees the others")

	# a leaver's player disappears
	rig.leave(pb)
	rig.run(5.0)
	_check(not hl.player_ids().has(pb.peer_id()) and not al.player_ids().has(pb.peer_id()) and not cl.player_ids().has(pb.peer_id()), "D9: the leaver's player is gone everywhere")
	_check(left.has(pb.peer_id()), "D9: the host was told")
	_check(hl.get_state(pb.peer_id()) == null, "D9: and cannot draw it")
	print("D9: host saw joined %d, left %d; late joiner saw %d players; spectator saw %d; host has %d after the leaver" % [joined.size(), left.size(), cl.player_ids().size(), dl.player_ids().size(), hl.player_ids().size()])


func _sorted(a: Array) -> Array:
	var o := a.duplicate()
	o.sort()
	return o


## Per-peer counters of the session: what the layer sent shows in `traffic_with`, the same on both ends.
func _test_wire_traffic() -> void:
	var s := _scene("owner")
	_drive(s)
	(s["rig"] as Rig).run(3.0)
	var hl: OneLobbyNetPlayers = s["hl"]
	var al: OneLobbyNetPlayers = s["al"]
	var to_a := hl.session.traffic_with(_peer(s))
	var from_host := al.session.traffic_with(1)
	_check(int(to_a["sent"]) > 1000 and int(from_host["received"]) > 1000, "traffic: bytes are counted both ways (%d, %d)" % [to_a["sent"], from_host["received"]])
	_check(int(from_host["received"]) <= int(to_a["sent"]), "traffic: a client never receives more than the host sent")
