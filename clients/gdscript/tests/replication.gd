extends SceneTree
## The replication session (OneLobbyReplicationSession) host and client over a raw lobby: a port of the JS session, stream
## and loopback tests (replication-session.test.ts, replication-streams.test.ts, replication-loopback.test.ts). The session
## tests run on an in-memory network with a virtual clock, latency, jitter, loss, duplication and reordering
## (tests/replication_rig.gd: the GDScript twin of the JS `RepRig`); the last test runs the same flow over real WebRTC data
## channels on 127.0.0.1 through OneLobbyClient.from_config with `sync.mode: replication`.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/replication.gd
## Prints "replication: N passed, M failed"; exits 1 on any failure. Needs the godot_webrtc add-on for the loopback test only.

const Rig := preload("res://tests/replication_rig.gd")
const P := preload("res://addons/onelobby/replication_protocol.gd")
const ALIEN := 7
const PLAYER := 1
const REL := OneLobbyWire.RELIABLE
const FAST := OneLobbyWire.FAST

var _pass := 0
var _fail := 0
var _tests := 0


## A typical creature: position on a 512 m map, height, yaw, animation, health. 64 bits on the wire.
class AlienSchema:
	extends RefCounted

	func write(w: OneLobbyNetWriter, s: Dictionary) -> void:
		w.write_quantized(s["x"], -256.0, 256.0, 16)
		w.write_quantized(s["y"], -32.0, 32.0, 12)
		w.write_quantized(s["z"], -256.0, 256.0, 16)
		w.write_angle(s["yaw"], 9)
		w.write_bits(int(s["anim"]), 4)
		w.write_bits(int(s["hp"]), 7)

	func read(r: OneLobbyNetReader) -> Dictionary:
		return {
			"x": r.read_quantized(-256.0, 256.0, 16), "y": r.read_quantized(-32.0, 32.0, 12), "z": r.read_quantized(-256.0, 256.0, 16),
			"yaw": r.read_angle(9), "anim": r.read_bits(4), "hp": r.read_bits(7),
		}

	func interpolate(a: Dictionary, b: Dictionary, t: float) -> Dictionary:
		return {
			"x": OneLobbyNetMath.lerp_value(a["x"], b["x"], t), "y": OneLobbyNetMath.lerp_value(a["y"], b["y"], t),
			"z": OneLobbyNetMath.lerp_value(a["z"], b["z"], t), "yaw": OneLobbyNetMath.lerp_angle(a["yaw"], b["yaw"], t),
			"anim": a["anim"] if t < 0.5 else b["anim"], "hp": a["hp"] if t < 0.5 else b["hp"],
		}


var schema := AlienSchema.new()


func _init() -> void:
	process_frame.connect(func() -> void:
		if Time.get_ticks_msec() > 300000:
			print("replication FAIL: timed out")
			quit(1))
	_run.call_deferred()


func _check(ok: bool, what: String) -> void:
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL: ", what)


func _near(a: float, b: float, tol: float) -> bool:
	return absf(a - b) <= tol


func _alien(init: Dictionary = {}) -> Dictionary:
	var a := {"x": 0.0, "y": 0.0, "z": 0.0, "yaw": 0.0, "anim": 0, "hp": 100}
	a.merge(init, true)
	return a


func _entity(state: Dictionary) -> Callable:
	return OneLobbyReplicationSession.replicated(schema, func() -> Dictionary: return state)


func _u32(v: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(4)
	b.encode_u32(0, v)
	return b


func _bytes(arr: Array) -> PackedByteArray:
	return PackedByteArray(arr)


func _seqs(events: Array) -> Array:
	return events.map(func(e: Dictionary) -> int: return int(e["seq"]))


## Every world the client holds equals the host's world of the same tick (when the host still has it); more than 10 compared.
func _worlds_match(host: Variant, client: Variant, what: String) -> void:
	var n := 0
	var ok := true
	for w: Dictionary in client.session.client_worlds():
		var hw: Variant = host.session.host_world(int(w["tick"]))
		if hw == null:
			continue # older than the host's history
		var ents: Array = w["ents"]
		var hents: Array = (hw as Dictionary)["ents"]
		ok = ok and ents.size() == hents.size()
		if ents.size() == hents.size():
			for i in ents.size():
				ok = ok and ents[i]["id"] == hents[i]["id"] and ents[i]["type"] == hents[i]["type"] and ents[i]["owner"] == hents[i]["owner"] and ents[i]["state"] == hents[i]["state"]
		n += 1
	_check(ok, what + ": the client's worlds equal the host's")
	_check(n > 10, what + ": compared ticks (%d)" % n)


func _run() -> void:
	_test_spawn_despawn()
	_test_despawn_at_render_time()
	_test_delta_after_loss()
	_test_late_joiner()
	_test_client_only_when_link_up()
	_test_interpolation()
	_test_redundant_inputs()
	_test_inputs_in_order()
	_test_reliable_events()
	_test_other_messages()
	_test_baseline_not_held()
	_test_unknown_version_and_kind()
	_test_rewind()
	_test_bandwidth_budget()
	_test_helpers()
	_test_keyframe_after_total_loss()
	_test_keyframes_repeat()
	_test_rates()
	_test_packet_log()
	_test_rtt()
	_test_send_full_snapshot()
	_test_input_stats()
	_test_streams_exactly_once()
	_test_stream_gap()
	_test_stream_per_recipient()
	_test_stream_reliable_only()
	_test_hold_events(0)
	_test_hold_events(8)
	_test_misbehaving_holes()
	_test_misbehaving_big_payloads()
	_test_misbehaving_far_jump()
	_test_stream_vectors_on_the_session()
	await _test_loopback()
	print("replication: %d passed, %d failed (%d test cases)" % [_pass, _fail, _tests])
	quit(1 if _fail > 0 else 0)


# ---- session -----------------------------------------------------------------------------------------------------------

func _test_spawn_despawn() -> void:
	_tests += 1
	var rig := Rig.new()
	var host := rig.start_host()
	var a := rig.join("a")
	var alien_id := host.session.spawn(ALIEN, 0, _entity(_alien({"x": 10.0, "z": -4.0})))
	var avatar_id := host.session.spawn(PLAYER, a.peer_id(), _entity(_alien({"x": 1.0})))
	_check(rig.until(func() -> bool: return a.spawned.size() == 2), "spawn: both entities reach the client")
	_check(a.spawned.has({"id": alien_id, "type_id": ALIEN, "owner": 0}) and a.spawned.has({"id": avatar_id, "type_id": PLAYER, "owner": a.peer_id()}), "spawn: type and owner arrive")
	var mine: Dictionary = a.session.entities().filter(func(e: Dictionary) -> bool: return e["id"] == avatar_id)[0]
	_check(a.session.is_mine(mine), "spawn: is_mine for the avatar")
	var s: Variant = a.session.try_sample(alien_id, schema)
	_check(s != null and _near(s["x"], 10.0, 0.005) and _near(s["z"], -4.0, 0.005), "spawn: the sampled state is the host's")
	host.session.despawn(alien_id)
	_check(rig.until(func() -> bool: return a.despawned.size() == 1), "despawn reaches the client")
	_check(a.despawned[0]["id"] == alien_id and a.session.try_sample(alien_id, schema) == null and a.session.entities().size() == 1, "despawn: gone from sampling and entities")


func _test_despawn_at_render_time() -> void:
	_tests += 1
	var rig := Rig.new({}, 20.0)
	var host := rig.start_host()
	var a := rig.join("a")
	var id := host.session.spawn(ALIEN, 0, _entity(_alien()))
	_check(rig.until(func() -> bool: return a.spawned.size() == 1), "despawn timing: spawned")
	rig.run(0.5)
	host.session.despawn(id)
	var despawn_tick := host.session.clock.tick + 1
	_check(rig.until(func() -> bool: return a.session.latest_tick >= despawn_tick), "despawn timing: the snapshot arrived")
	_check(a.despawned.size() == 0, "despawn shows at render time, not on receipt")
	_check(rig.until(func() -> bool: return a.despawned.size() == 1), "despawn timing: shown later")
	_check(a.session.render_tick >= despawn_tick, "despawn timing: render tick has reached it")


func _test_delta_after_loss() -> void:
	_tests += 1
	var rig := Rig.new({}, 40.0, 0.2, 30.0)
	var host := rig.start_host()
	var a := rig.join("a")
	var b := rig.join("b")
	var aliens: Array = []
	for i in 20:
		var al := _alien({"x": float(i)})
		aliens.append({"id": host.session.spawn(ALIEN, 0, _entity(al)), "a": al})
	var r := Rig.Rng.new(7)
	rig.host_tick = func(tick: int) -> void:
		for item: Dictionary in aliens:
			var al: Dictionary = item["a"]
			al["x"] += r.next() - 0.5
			al["z"] += 0.05
			al["yaw"] += 3.0
			if floori(r.next() * 10.0) == 0:
				al["anim"] = floori(r.next() * 16.0)
		if tick % 15 == 0:
			var n := _alien({"x": -5.0})
			aliens.append({"id": host.session.spawn(ALIEN, 0, _entity(n)), "a": n})
		if tick % 20 == 0 and aliens.size() > 5:
			host.session.despawn(int((aliens.pop_front() as Dictionary)["id"]))
	rig.run(6.0)
	_check(a.session.stats.snapshots_received > 100, "delta: the client received snapshots (%d)" % a.session.stats.snapshots_received)
	_check(host.session.stats.full_snapshots_sent < host.session.stats.snapshots_sent / 5, "delta: mostly deltas (%d full of %d)" % [host.session.stats.full_snapshots_sent, host.session.stats.snapshots_sent])
	_worlds_match(host, a, "delta after loss and jitter (a)")
	_worlds_match(host, b, "delta after loss and jitter (b)")
	_check(a.session.stats.malformed == 0, "delta: nothing malformed")


func _test_late_joiner() -> void:
	_tests += 1
	var rig := Rig.new({}, 30.0)
	var host := rig.start_host()
	var early := rig.join("early")
	var ids: Array = []
	for i in 30:
		ids.append(host.session.spawn(ALIEN, 0, _entity(_alien({"x": float(i)}))))
	rig.run(1.0)
	for i in 10:
		host.session.despawn(ids[i])
	rig.run(1.0)
	var full_before := host.session.stats.full_snapshots_sent
	var late := rig.join("late")
	_check(rig.until(func() -> bool: return late.spawned.size() == 20), "late joiner: sees the 20 entities")
	rig.run(1.0)
	var got: Array = late.session.entities().map(func(e: Dictionary) -> int: return e["id"])
	got.sort()
	_check(got == ids.slice(10), "late joiner: exactly the live entities")
	_check(late.despawned.size() == 0, "late joiner: no despawn events")
	_check(host.session.acked_tick(late.peer_id()) > 0, "late joiner: acked")
	var fulls := host.session.stats.full_snapshots_sent - full_before
	_check(fulls >= 1 and fulls <= 12, "late joiner: full snapshots until the first ack, then deltas (%d)" % fulls)
	_worlds_match(host, late, "late joiner")
	_check(early.session.entities().size() == 20, "late joiner: the early client still sees 20")


func _test_client_only_when_link_up() -> void:
	_tests += 1
	var rig := Rig.new({}, 30.0)
	var host := rig.start_host()
	var ready: Array = []
	host.session.client_ready.connect(func(p: int) -> void: ready.append(p))
	host.session.spawn(ALIEN, 0, _entity(_alien({"x": 1.0})))
	rig.net.block_open = true # this joiner's link never opens
	var stuck := rig.join("stuck", false)
	rig.run(2.0)
	_check(host.session.clients().is_empty() and not host.session.is_client_ready(stuck.peer_id()), "link: a peer whose link is down is not a client")
	_check(host.session.stats.snapshots_sent == 0, "link: nothing streamed into a dead link")
	rig.net.block_open = false
	var ok := rig.join("ok")
	_check(rig.until(func() -> bool: return ok.spawned.size() == 1), "link: the joiner with a link gets the world")
	rig.run(1.0)
	_check(host.session.clients() == [ok.peer_id()] and ready == [ok.peer_id()] and host.session.is_client_ready(ok.peer_id()), "link: clients and client_ready")
	_check(host.session.stats.full_snapshots_sent >= 1, "link: its first snapshot was a full one")
	_worlds_match(host, ok, "link")


func _test_interpolation() -> void:
	_tests += 1
	var rig := Rig.new({}, 25.0, 0.0, 10.0)
	var host := rig.start_host()
	var a := rig.join("a")
	var mover := _alien()
	var id := host.session.spawn(ALIEN, 0, _entity(mover))
	rig.host_tick = func(tick: int) -> void: mover["x"] = float(tick) * 0.1 - 100.0 # 3 m/s along X
	rig.run(2.0)
	var samples: Array = []
	var close := true
	var defined := true
	for _i in 120:
		rig.step()
		var s: Variant = a.session.try_sample(id, schema)
		if s == null:
			defined = false
			continue
		samples.append(s["x"])
		# interpolated X matches the host's function at the render tick (quantization step is ~0.8 cm)
		close = close and absf(s["x"] - (a.session.render_tick * 0.1 - 100.0)) <= 0.02
	_check(defined and close, "interpolation: matches the host's function at the render tick")
	var monotonic := true
	for i in range(1, samples.size()):
		monotonic = monotonic and samples[i] >= samples[i - 1] - 1e-3
	_check(monotonic, "interpolation: smooth, never backwards")
	var behind_ms := float(host.session.clock.tick - a.session.render_tick) * 1000.0 / 30.0
	_check(behind_ms >= 100.0 and behind_ms <= 190.0, "interpolation: renders about 100 ms behind (%.0f)" % behind_ms)
	var est := (float(host.session.clock.tick) - a.session.server_tick) * 1000.0 / 30.0
	_check(est >= 0.0 and est <= 70.0, "interpolation: the server tick estimate trails by about the one-way latency (%.0f)" % est)


func _delivered(redundancy: int) -> Dictionary:
	var rig := Rig.new({"input_redundancy": redundancy}, 30.0, 0.3)
	var host := rig.start_host()
	var a := rig.join("a")
	a.make_input = func(t: int) -> PackedByteArray: return _u32(t)
	var got := {}
	var sizes_ok := [true]
	rig.host_tick = func(_t: int) -> void:
		var f := host.session.try_get_input(a.peer_id())
		if not f.is_empty() and not f["repeated"]:
			got[f["seq"]] = true
			sizes_ok[0] = sizes_ok[0] and (f["bytes"] as PackedByteArray).size() == 4
	rig.run(20.0)
	var max_seq := 0
	for s: int in a.submitted_seqs:
		max_seq = maxi(max_seq, s)
	var sent := a.submitted_seqs.filter(func(s: int) -> bool: return s < max_seq - 10).size()
	var applied := 0
	for s: int in got:
		if s < max_seq - 10:
			applied += 1
	return {"received": 1.0 - float(host.session.stats.inputs_lost) / float(a.submitted_seqs.size()), "applied": float(applied) / float(sent), "sizes_ok": sizes_ok[0]}


func _test_redundant_inputs() -> void:
	_tests += 1
	var one := _delivered(1)
	var four := _delivered(4)
	_check(one["received"] > 0.6 and one["received"] < 0.8, "redundancy 1: about 70%% arrive (%.3f)" % one["received"])
	_check(four["received"] >= 0.98, "redundancy 4: arrived (%.3f)" % four["received"])
	_check(four["applied"] >= 0.95, "redundancy 4: applied (%.3f)" % four["applied"])
	_check(one["sizes_ok"] and four["sizes_ok"], "redundancy: every input has its 4 bytes")


func _test_inputs_in_order() -> void:
	_tests += 1
	var rig := Rig.new({}, 30.0)
	var host := rig.start_host()
	var a := rig.join("a")
	host.session.spawn(ALIEN, 0, _entity(_alien()))
	a.make_input = func(t: int) -> PackedByteArray: return _bytes([t & 0xFF])
	var seqs: Array = []
	var views: Array = []
	rig.host_tick = func(tick: int) -> void:
		var f := host.session.try_get_input(a.peer_id())
		if not f.is_empty() and not f["repeated"]:
			seqs.append(f["seq"])
			views.append([f["view_tick"], tick])
	rig.run(3.0)
	_check(seqs.size() > 60, "inputs: arrived (%d)" % seqs.size())
	var ordered := true
	for i in range(1, seqs.size()):
		ordered = ordered and seqs[i] == seqs[i - 1] + 1
	_check(ordered, "inputs: in order, no gaps")
	var last: Array = views[views.size() - 1]
	var lag_ms := (float(last[1]) - float(last[0])) * 1000.0 / 30.0
	_check(lag_ms >= 120.0 and lag_ms <= 260.0, "inputs: the view tick lags about interpolation + latency (%.0f ms)" % lag_ms)
	_check(a.session.last_processed_input > 0, "inputs: last_processed_input")


func _test_reliable_events() -> void:
	_tests += 1
	var rig := Rig.new({}, 30.0, 0.3)
	var host := rig.start_host()
	var a := rig.join("a")
	var b := rig.join("b")
	for i in 20:
		host.session.send_event(_bytes([i]))
	host.session.send_event(_bytes([99]), b.peer_id())
	a.session.send_event(_bytes([42]))
	rig.run(1.0)
	var firsts := func(p: Variant) -> Array: return p.events.map(func(e: Dictionary) -> int: return (e["payload"] as PackedByteArray)[0])
	_check(firsts.call(a) == range(20), "events: reliable events arrive once, in order")
	_check(b.events.size() == 21 and (b.events[20]["payload"] as PackedByteArray)[0] == 99, "events: a targeted event reaches only its peer")
	_check(host.events.size() == 1 and host.events[0]["from"] == a.peer_id() and (host.events[0]["payload"] as PackedByteArray)[0] == 42, "events: client to host")
	_check(a.events.all(func(e: Dictionary) -> bool: return e["from"] == host.peer_id()), "events: from the host")


func _test_other_messages() -> void:
	_tests += 1
	var rig := Rig.new()
	var host := rig.start_host()
	var a := rig.join("a")
	var got: Array = []
	a.session.other_message.connect(func(_f: int, bytes: PackedByteArray, _c: int) -> void: got.append(bytes))
	host.lobby.send(a.peer_id(), _bytes([1, 2, 3]))
	rig.run(0.2)
	_check(got.size() == 1 and got[0] == _bytes([1, 2, 3]), "raw: another payload passes through untouched")
	_check(not OneLobbyReplicationSession.is_replication_payload(got[0]) and OneLobbyReplicationSession.is_replication_payload(_bytes([0x52, 1, 1])) and not OneLobbyReplicationSession.is_replication_payload(_bytes([0x52, 1])), "raw: is_replication_payload")


func _test_baseline_not_held() -> void:
	_tests += 1
	var doc: Dictionary = _spec("vectors/replication.json")
	var v: Dictionary = doc["snapshots"].filter(func(e: Dictionary) -> bool: return e.get("clientHoldsBaseline", true) == false)[0]
	var rig := Rig.new()
	var host := rig.start_host()
	rig.run(1.0) # the host is past tick 5 when the client joins
	var a := rig.join("a")
	rig.run(0.2)
	var before := a.session.stats.snapshots_dropped
	host.lobby.send(a.peer_id(), (v["hex"] as String).hex_decode(), FAST)
	rig.run(0.2)
	_check(a.session.stats.snapshots_dropped == before + 1 and a.session.stats.malformed == 0, "vector: a snapshot against a baseline the client does not hold is dropped quietly")


func _test_unknown_version_and_kind() -> void:
	_tests += 1
	var rig := Rig.new()
	var host := rig.start_host()
	var a := rig.join("a")
	var got: Array = []
	a.session.other_message.connect(func(_f: int, bytes: PackedByteArray, _c: int) -> void: got.append(bytes))
	host.lobby.send(a.peer_id(), _bytes([0x52, 2, 1, 0]))
	host.lobby.send(a.peer_id(), _bytes([0x52, 1, 9, 0]))
	rig.run(0.2)
	_check(got.is_empty() and a.session.stats.malformed == 1, "an unknown version counts as malformed, an unknown kind is ignored, neither reaches the game (%d)" % a.session.stats.malformed)


func _test_rewind() -> void:
	_tests += 1
	var rig := Rig.new({"max_rewind_ms": 200})
	var host := rig.start_host()
	rig.run(1.0)
	var now := float(host.session.clock.tick)
	_check(_near(host.session.rewind_tick({"view_tick": 0.0}), now - 6.0, 1e-6), "rewind: clamped to max_rewind_ms")
	_check(_near(host.session.rewind_tick({"view_tick": now - 2.5}), now - 2.5, 1e-6), "rewind: a recent view is kept")
	_check(_near(host.session.rewind_tick({"view_tick": now + 50.0}), now, 1e-6), "rewind: never in the future")


func _test_bandwidth_budget() -> void:
	_tests += 1
	# Worst case for a 4-player co-op game: host + 3 clients, 50 aliens all moving every tick, 4 avatars, 5% loss, jitter.
	var rig := Rig.new({}, 40.0, 0.05, 15.0)
	var host := rig.start_host()
	var clients := [rig.join("a"), rig.join("b"), rig.join("c")]
	var r := Rig.Rng.new(11)
	var all: Array = []
	for i in 50:
		var al := _alien({"x": float(floori(r.next() * 200.0) - 100), "z": float(floori(r.next() * 200.0) - 100), "yaw": float(floori(r.next() * 360.0))})
		all.append(al)
		host.session.spawn(ALIEN, 0, _entity(al))
	var avatars: Array = []
	for peer: int in [host.peer_id(), clients[0].peer_id(), clients[1].peer_id(), clients[2].peer_id()]:
		var av := _alien()
		avatars.append(av)
		host.session.spawn(PLAYER, peer, _entity(av))
	for c in clients:
		c.make_input = func(t: int) -> PackedByteArray: return _bytes([t & 0xFF, 0x10, 0x20, 0x30, 0x40, 0x50])
	rig.host_tick = func(tick: int) -> void:
		for al: Dictionary in all:
			var rad := deg_to_rad(al["yaw"])
			al["yaw"] += r.next() * 6.0 - 3.0
			al["x"] += cos(rad) * 0.13
			al["z"] += sin(rad) * 0.13
			al["y"] = sin(float(tick) * 0.05 + al["z"]) * 0.2
			if floori(r.next() * 30.0) == 0:
				al["anim"] = floori(r.next() * 16.0)
		for av: Dictionary in avatars:
			av["x"] += 0.2
			av["yaw"] += 1.0
		for c in clients:
			host.session.try_get_input(c.peer_id())
	rig.run(2.0) # warm up: everyone acked, deltas flowing
	var fast_before := rig.sent_bytes(host, FAST)
	var client_fast_before := clients.map(func(c: Variant) -> int: return rig.sent_bytes(c, FAST))
	var before := clients.map(func(c: Variant) -> int: return host.session.bytes_sent_to(c.peer_id()))
	var snaps_before := host.session.stats.snapshots_sent
	var seconds := 10.0
	rig.run(seconds)
	var snaps_per_client := float(host.session.stats.snapshots_sent - snaps_before) / float(clients.size())
	var per_client: Array = []
	for i in clients.size():
		# replication payload + the 3-byte lobby header on every snapshot frame
		per_client.append((float(host.session.bytes_sent_to(clients[i].peer_id()) - before[i]) + 3.0 * snaps_per_client) / seconds)
	var host_fast_up := float(rig.sent_bytes(host, FAST) - fast_before) / seconds
	var client_up := 0.0
	for i in clients.size():
		client_up = maxf(client_up, float(rig.sent_bytes(clients[i], FAST) - client_fast_before[i]) / seconds)
	var avg_snap := float(host.session.stats.snapshot_bytes_sent) / float(host.session.stats.snapshots_sent)
	print("54 entities @30 Hz, 3 clients, 5%% loss: snapshot avg %.0f B, largest %d B; per-client down %.1f kbit/s; host up fast %.1f kbit/s; client up %.1f kbit/s" % [
		avg_snap, host.session.stats.largest_snapshot, per_client.max() * 8.0 / 1000.0, host_fast_up * 8.0 / 1000.0, client_up * 8.0 / 1000.0])
	for c in clients:
		_worlds_match(host, c, "bandwidth (%s)" % c.name)
	# Budget (DESIGN s.18): 128 kbit/s per client down, 3 x 128 host up, 16 kbit/s client up, MTU-safe snapshots.
	for b: float in per_client:
		_check(b * 8.0 <= 128000.0, "budget: client downstream %.0f bit/s" % (b * 8.0))
	_check(host_fast_up * 8.0 <= 3.0 * 128000.0, "budget: host upstream %.0f bit/s" % (host_fast_up * 8.0))
	_check(client_up * 8.0 <= 16000.0, "budget: client upstream %.0f bit/s" % (client_up * 8.0))
	_check(host.session.stats.largest_snapshot <= 1200, "budget: snapshots fit one datagram (%d)" % host.session.stats.largest_snapshot)


func _test_helpers() -> void:
	_tests += 1
	_check(OneLobbyNetMath.lerp_or_snap(0.0, 2.0, 0.5, 2.5) == 1.0 and OneLobbyNetMath.lerp_or_snap(0.0, 10.0, 0.5, 2.0) == 10.0, "helpers: lerp_or_snap jumps past max_distance")
	_check(_near(OneLobbyNetMath.lerp_angle(350.0, 10.0, 0.5), 0.0, 1e-6) or _near(OneLobbyNetMath.lerp_angle(350.0, 10.0, 0.5), 360.0, 1e-6), "helpers: lerp_angle takes the short way round (350 -> 10)")
	_check(_near(OneLobbyNetMath.lerp_angle(10.0, 350.0, 0.5), 0.0, 1e-6) or _near(OneLobbyNetMath.lerp_angle(10.0, 350.0, 0.5), 360.0, 1e-6), "helpers: lerp_angle (10 -> 350)")
	_check(_near(OneLobbyNetMath.lerp_angle(0.0, 90.0, 0.5), 45.0, 1e-6), "helpers: lerp_angle (0 -> 90)")


# ---- keyframes, rates, packet log, diagnostics ---------------------------------------------------------------------------

func _test_keyframe_after_total_loss() -> void:
	_tests += 1
	var rig := Rig.new({}, 30.0, 1.0)
	var host := rig.start_host()
	var id := host.session.spawn(ALIEN, 0, _entity(_alien({"x": 5.0})))
	rig.run(0.5)
	var a := rig.join("a")
	_check(rig.until(func() -> bool: return a.session.latest_tick > 0, 200), "keyframe: a late joiner gets a snapshot even if every fast packet is lost")
	_check(host.session.stats.keyframes_sent == 1, "keyframe: exactly one so far")
	var got := a.session.try_get_latest(id, schema)
	_check(not got.is_empty() and _near(got["state"]["x"], 5.0, 0.005), "keyframe: it holds the entity")


func _test_keyframes_repeat() -> void:
	_tests += 1
	var rig := Rig.new({"keyframe_seconds": 1}, 20.0)
	var host := rig.start_host()
	rig.join("a")
	host.session.spawn(ALIEN, 0, _entity(_alien()))
	rig.run(3.5)
	var k := host.session.stats.keyframes_sent
	_check(k >= 3 and k <= 5 and host.session.stats.full_snapshots_sent >= k, "keyframes repeat every keyframe_seconds (%d)" % k)
	var off := Rig.new({"keyframe_seconds": 0}, 20.0)
	var h2 := off.start_host()
	var b := off.join("b")
	h2.session.spawn(ALIEN, 0, _entity(_alien()))
	off.run(3.0)
	_check(h2.session.stats.keyframes_sent == 0, "keyframes: none at 0")
	_check(off.until(func() -> bool: return b.spawned.size() == 1), "keyframes: full snapshots on fast until the first ack when off")


func _test_rates() -> void:
	_tests += 1
	var rig := Rig.new({}, 20.0)
	var host := rig.start_host()
	var a := rig.join("a")
	host.session.spawn(ALIEN, 0, _entity(_alien()))
	a.make_input = func(t: int) -> PackedByteArray: return _bytes([t & 0xFF, 1, 2])
	rig.run(2.0)
	var before := host.session.bytes_sent_to(a.peer_id())
	rig.run(1.0)
	var per_second := float(host.session.bytes_sent_to(a.peer_id()) - before)
	var hr: Dictionary = host.session.traffic_rates
	_check(hr["snapshots_sent"] > per_second * 0.85 and hr["snapshots_sent"] < per_second * 1.15, "rates: snapshots per second match the bytes sent (%d vs %.0f)" % [hr["snapshots_sent"], per_second])
	_check(hr["total_sent"] == hr["snapshots_sent"] + hr["inputs_sent"] + hr["events_sent"], "rates: total_sent is the sum")
	_check(hr["inputs_received"] > 0 and a.session.traffic_rates["inputs_sent"] > 0, "rates: inputs counted on both sides")
	var ar: Dictionary = a.session.traffic_rates
	_check(ar["snapshots_received"] > hr["snapshots_sent"] * 0.85 and ar["snapshots_received"] < hr["snapshots_sent"] * 1.15, "rates: the client received about what the host sent")
	host.session.send_event(PackedByteArray([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
	rig.run(0.1)
	_check(host.session.traffic_rates["events_sent"] >= 13 and a.session.traffic_rates["events_received"] >= 13, "rates: an event of 10 bytes counts (13 with its header)")
	rig.run(1.2)
	_check(host.session.traffic_rates["events_sent"] == 0, "rates: the window is 1000 ms")


func _test_packet_log() -> void:
	_tests += 1
	var rig := Rig.new({"packet_log_per_second": 5}, 20.0)
	var host := rig.start_host()
	var a := rig.join("a")
	host.session.spawn(ALIEN, 0, _entity(_alien()))
	rig.run(1.0)
	var lines: Array = []
	a.session.packet_log_sink = func(l: String) -> void: lines.append(l)
	a.make_input = func(t: int) -> PackedByteArray: return _bytes([t & 0xFF])
	rig.run(1.0)
	_check(lines.size() >= 5 and lines.size() <= 10, "packet log: capped at 5 a second (%d)" % lines.size())
	var shaped := true
	for l: String in lines:
		var parts := l.split(" ", true, 4)
		var kind: Variant = JSON.parse_string(parts[4])
		shaped = shaped and parts.size() == 5 and parts[0] == "rep" and parts[1] in ["in", "out"] and parts[2].is_valid_int() and parts[3] in ["fast", "reliable"] and kind is Dictionary and kind["kind"] in ["snapshot", "input"]
	_check(shaped, "packet log: lines are `rep <in|out> <peer> <channel> <json>`")
	# true: into the kit's net log
	a.session.packet_log_sink = Callable()
	var entries := a.lobby.get_net_log().entries.size()
	a.session.packet_log = true
	rig.run(0.3)
	_check(a.lobby.get_net_log().entries.size() > entries, "packet log: true writes to the net log")
	a.session.packet_log = false
	var after := a.lobby.get_net_log().entries.size()
	rig.run(0.3)
	_check(a.lobby.get_net_log().entries.size() == after, "packet log: off writes nothing")


func _test_rtt() -> void:
	_tests += 1
	var rig := Rig.new({}, 40.0)
	var host := rig.start_host()
	var a := rig.join("a")
	host.session.spawn(ALIEN, 0, _entity(_alien()))
	rig.run(3.0)
	_check(a.session.host_peer_id == host.peer_id() and host.session.host_peer_id == host.peer_id(), "rtt: host_peer_id")
	_check(a.session.rtt_ms >= 70 and a.session.rtt_ms <= 140 and host.session.rtt_ms == 0, "rtt: rtt_ms (%d)" % a.session.rtt_ms)
	_check(a.session.peer_rtt_ms(host.peer_id()) == a.session.rtt_ms and a.session.peer_rtt_ms(a.peer_id()) == 0, "rtt: peer_rtt_ms on a client")
	_check(host.session.peer_rtt_ms(a.peer_id()) == 0 and host.session.peer_rtt_ms(host.peer_id()) == 0, "rtt: peer_rtt_ms on the host")
	_check(a.session.snapshot_age_ms >= 0 and a.session.snapshot_age_ms <= 60, "rtt: snapshot_age_ms (%d)" % a.session.snapshot_age_ms)


func _test_send_full_snapshot() -> void:
	_tests += 1
	var rig := Rig.new({}, 30.0)
	var host := rig.start_host()
	var a := rig.join("a")
	var b := rig.join("b")
	for i in 10:
		host.session.spawn(ALIEN, 0, _entity(_alien({"x": float(i)})))
	rig.run(2.0)
	var full_before := host.session.stats.full_snapshots_sent
	_check(host.session.acked_tick(a.peer_id()) > 0, "resync: acked before")
	host.session.send_full_snapshot(a.peer_id())
	_check(host.session.acked_tick(a.peer_id()) == 0, "resync: the ack is cleared")
	rig.run(1.0)
	var fulls := host.session.stats.full_snapshots_sent - full_before
	_check(fulls >= 1 and fulls <= 8, "resync: only a, until its next ack (%d)" % fulls)
	_check(host.session.acked_tick(a.peer_id()) > 0, "resync: deltas resume")
	_check(a.session.entities().size() == 10 and a.despawned.size() == 0 and b.session.entities().size() == 10, "resync: nothing flickers")


func _test_input_stats() -> void:
	_tests += 1
	var rig := Rig.new({}, 30.0)
	var host := rig.start_host()
	var a := rig.join("a")
	var b := rig.join("b")
	a.make_input = func(t: int) -> PackedByteArray: return _bytes([t & 0xFF])
	b.make_input = func(t: int) -> Variant: return _bytes([t & 0xFF]) if t % 2 == 0 else null # b sends every other tick: repeats
	rig.host_tick = func(_t: int) -> void:
		host.session.try_get_input(a.peer_id())
		host.session.try_get_input(b.peer_id())
	rig.run(3.0)
	var sa: Dictionary = host.session.input_stats_for(a.peer_id())
	var sb: Dictionary = host.session.input_stats_for(b.peer_id())
	_check(sb["repeated"] > 30, "input stats: b repeats (%d)" % sb["repeated"])
	_check(sa["repeated"] < sb["repeated"] / 4, "input stats: a repeats less (%d)" % sa["repeated"])
	_check(sa["buffer_depth"] <= 4, "input stats: buffer depth")
	_check(sa["repeated"] + sb["repeated"] == host.session.stats.inputs_repeated and sa["skipped"] + sb["skipped"] == host.session.stats.inputs_skipped, "input stats: split per client, summing to the totals")
	_check(host.session.input_stats_for(99) == {"repeated": 0, "skipped": 0, "lost": 0, "buffer_depth": 0}, "input stats: an unknown peer is all zero")


# ---- numbered stream events ----------------------------------------------------------------------------------------------

func _stream_setup(cfg: Dictionary = {}) -> Dictionary:
	var rig := Rig.new(cfg, 30.0)
	var host := rig.start_host()
	var a := rig.join("a")
	rig.run(0.5)
	var got: Array = []
	var gaps: Array = []
	a.session.event_delivered.connect(func(e: Dictionary) -> void: got.append(e))
	a.session.event_gap.connect(func(g: Dictionary) -> void: gaps.append(g))
	return {"rig": rig, "host": host, "a": a, "got": got, "gaps": gaps}


func _test_streams_exactly_once() -> void:
	_tests += 1
	var s := _stream_setup()
	var rig: Variant = s["rig"]
	var host: Variant = s["host"]
	var a: Variant = s["a"]
	var on := [false]
	rig.net.duplicate_reliable = func() -> bool: return on[0] and rig.random.next() < 0.2
	rig.net.reorder_reliable = func() -> bool: return on[0] and rig.random.next() < 0.2
	on[0] = true
	for i in range(1, 201):
		host.session.send_event(_u32(i), a.peer_id(), REL, 3)
		if i % 10 == 0:
			rig.step()
	rig.run(1.0)
	on[0] = false
	var got: Array = s["got"]
	_check(_seqs(got) == range(1, 201), "stream: exactly once and in order even when the transport duplicates and reorders")
	_check(got.all(func(e: Dictionary) -> bool: return (e["payload"] as PackedByteArray).decode_u32(0) == e["seq"] and e["stream"] == 3), "stream: payloads follow their seq")
	_check((s["gaps"] as Array).is_empty() and a.session.stats.events_duplicate > 0 and a.session.stats.events_out_of_order > 0 and a.session.stats.events_gap == 0, "stream: anomalies counted, no gap")


func _test_stream_gap() -> void:
	_tests += 1
	var s := _stream_setup()
	var rig: Variant = s["rig"]
	var host: Variant = s["host"]
	var a: Variant = s["a"]
	var drop := [5, 6, 40]
	var sending := [0]
	rig.net.drop_reliable = func() -> bool: return drop.has(sending[0])
	for i in range(1, 51):
		sending[0] = i
		host.session.send_event(_u32(i), a.peer_id(), REL, 1)
	sending[0] = 0
	rig.run(0.5)
	var got: Array = s["got"]
	_check(got.size() == 4, "gap: 1-4 delivered, 7.. wait for 5 (%d)" % got.size())
	rig.run(2.5)
	_check(got.size() == 47, "gap: the stream goes on after the timeout (%d)" % got.size())
	var gaps: Array = (s["gaps"] as Array).map(func(g: Dictionary) -> Array: return [g["stream"], g["first_missing"], g["next_delivered"]])
	_check(gaps == [[1, 5, 7], [1, 40, 41]], "gap: reported with the missing range (%s)" % [gaps])
	_check(a.session.stats.events_gap == 2, "gap: counted")
	var seqs := _seqs(got)
	var sorted := seqs.duplicate()
	sorted.sort()
	_check(seqs == sorted, "gap: still in order")


func _test_stream_per_recipient() -> void:
	_tests += 1
	var s := _stream_setup()
	var rig: Variant = s["rig"]
	var host: Variant = s["host"]
	var a: Variant = s["a"]
	var b: Variant = rig.join("b")
	var got_b: Array = []
	b.session.event_delivered.connect(func(e: Dictionary) -> void: got_b.append(e))
	host.session.send_event(_u32(1), 0, REL, 1) # both clients: seq 1
	host.session.send_event(_u32(2), a.peer_id(), REL, 1) # a only: seq 2
	host.session.send_event(_u32(3), 0, REL, 2)
	host.session.send_event(_u32(4))
	host.session.send_event(_u32(5), 0, REL, 1) # a: 3, b: 2
	rig.run(0.5)
	var pairs := func(arr: Array) -> Array: return arr.map(func(e: Dictionary) -> Array: return [e["stream"], e["seq"]])
	_check(pairs.call(s["got"]) == [[1, 1], [1, 2], [2, 1], [0, 0], [1, 3]], "per recipient: a's streams are numbered 1,2,3; plain events have no seq")
	_check(pairs.call(got_b) == [[1, 1], [2, 1], [0, 0], [1, 2]], "per recipient: b's numbering is its own")
	_check(host.session.reliable_event_bytes_sent_to(a.peer_id()) > host.session.reliable_event_bytes_sent_to(b.peer_id()), "per recipient: reliable bytes per peer")
	_check(a.events.size() == 5, "per recipient: event_received still fires for every event")
	a.session.send_event(_u32(9), 0, REL, 7) # client to host
	var at_host: Array = []
	host.session.event_delivered.connect(func(e: Dictionary) -> void: at_host.append(e))
	rig.run(0.5)
	_check(at_host.size() == 1 and at_host[0]["stream"] == 7 and at_host[0]["seq"] == 1, "per recipient: client to host streams are numbered too")


func _test_stream_reliable_only() -> void:
	_tests += 1
	var s := _stream_setup()
	var ok: bool = s["host"].session.send_event(_u32(1), s["a"].peer_id(), FAST, 1)
	_check(not ok, "a numbered stream on the fast channel is refused (an error is printed above)")


func _test_hold_events(hold: int) -> void:
	_tests += 1
	var s := _stream_setup({"hold_events_for_ticks": hold})
	var rig: Variant = s["rig"]
	var host: Variant = s["host"]
	var a: Variant = s["a"]
	rig.net.extra_delay_ms = func(ch: int) -> float: return 60.0 if ch == FAST else 0.0 # snapshots come in after the events
	var at_delivery: Array = []
	a.session.event_delivered.connect(func(e: Dictionary) -> void: at_delivery.append([e["tick"], a.session.latest_tick]))
	rig.host_tick = func(t: int) -> void:
		if t % 5 == 0:
			host.session.send_event(_u32(t), 0, REL, 1)
	rig.run(3.0)
	_check(at_delivery.size() > 10, "hold %d: events delivered (%d)" % [hold, at_delivery.size()])
	var early := at_delivery.filter(func(x: Array) -> bool: return x[1] < x[0]).size()
	if hold == 0:
		_check(early > at_delivery.size() / 2, "hold 0: unheld events beat their snapshot (%d of %d)" % [early, at_delivery.size()])
	else:
		_check(early == 0, "hold %d: events line up with their snapshot (%d early)" % [hold, early])
	var seqs := _seqs(s["got"])
	var sorted := seqs.duplicate()
	sorted.sort()
	_check(seqs == sorted, "hold %d: still in order" % hold)


## A joiner that breaks the stream contract on purpose (holes, huge jumps, the fast channel) cannot make the host hold its
## events without bound.
func _forge(from: Variant, to: int, stream: int, seq: int, payload_bytes: int = 4, channel: int = REL) -> void:
	var body := PackedByteArray()
	body.resize(payload_bytes)
	from.lobby.send(to, P.encode_stream_event(1, stream, seq, body), channel)


func _test_misbehaving_holes() -> void:
	_tests += 1
	var s := _stream_setup()
	var rig: Variant = s["rig"]
	var host: Variant = s["host"]
	var a: Variant = s["a"]
	var gaps: Array = []
	host.session.event_gap.connect(func(g: Dictionary) -> void: gaps.append(g))
	for seq in range(2, 2001, 2):
		_forge(a, host.peer_id(), 1, seq)
		if seq % 100 == 0:
			rig.step()
	rig.run(0.3) # well under the 1 s gap timeout
	_check(host.session.buffered_stream_events() <= OneLobbyReplicationStreams.MAX_BUFFERED, "misbehaving: only holes cannot grow the host's buffer (%d)" % host.session.buffered_stream_events())
	_check(gaps.size() > 0, "misbehaving: the cap reports gaps at once")


func _test_misbehaving_big_payloads() -> void:
	_tests += 1
	var s := _stream_setup()
	var rig: Variant = s["rig"]
	var host: Variant = s["host"]
	var a: Variant = s["a"]
	for seq in range(2, 41, 2):
		_forge(a, host.peer_id(), 1, seq, 64 * 1024)
	rig.run(0.3)
	_check(host.session.buffered_stream_events() <= OneLobbyReplicationStreams.MAX_BUFFERED_BYTES / (64 * 1024), "misbehaving: big payloads hit the byte cap before the count cap (%d)" % host.session.buffered_stream_events())


func _test_misbehaving_far_jump() -> void:
	_tests += 1
	var s := _stream_setup()
	var rig: Variant = s["rig"]
	var host: Variant = s["host"]
	var a: Variant = s["a"]
	var got: Array = []
	host.session.event_delivered.connect(func(e: Dictionary) -> void: got.append(e))
	_forge(a, host.peer_id(), 1, OneLobbyReplicationStreams.MAX_AHEAD + 1)
	_forge(a, host.peer_id(), 2, 1, 4, FAST)
	_forge(a, host.peer_id(), 3, 1) # a good one still arrives
	rig.run(0.3)
	_check(host.session.stats.malformed == 2 and host.session.buffered_stream_events() == 0, "misbehaving: a far jump or the fast channel is malformed (%d)" % host.session.stats.malformed)
	_check(got.map(func(e: Dictionary) -> int: return e["stream"]) == [3], "misbehaving: the good event is delivered")


## The streamReceive vectors again, but through a whole session (a receiver on the in-memory network, one millisecond a step),
## as the JS and C# tests do; replication_vectors.gd runs the same cases on the stream buffer alone.
func _test_stream_vectors_on_the_session() -> void:
	_tests += 1
	var doc: Dictionary = _spec("vectors/replication.json")
	var cases: Array = doc["streamReceive"]
	var bad := 0
	for c: Dictionary in cases:
		var rig := Rig.new({}, 0.0)
		var host := rig.start_host()
		var a := rig.join("a")
		rig.run(0.5)
		rig.frame_ms = 1
		var start: int = rig.net.now + 1 # the first step below reads 0
		var events: Array = []
		host.session.event_delivered.connect(func(e: Dictionary) -> void: events.append({"type": "deliver", "at": rig.net.now - start, "stream": e["stream"], "seq": e["seq"]}))
		host.session.event_gap.connect(func(g: Dictionary) -> void: events.append({"type": "gap", "at": rig.net.now - start, "stream": g["stream"], "firstMissing": g["first_missing"], "nextDelivered": g["next_delivered"]}))
		var st := host.session.stats
		var before := [st.events_duplicate, st.events_out_of_order, st.events_gap, st.malformed]
		var arrivals: Array = c["arrivals"]
		var next := 0
		for t in range(0, int(c["endAt"]) + 1):
			while next < arrivals.size() and int(arrivals[next]["at"]) == t:
				var x: Dictionary = arrivals[next]
				next += 1
				_forge(a, host.peer_id(), int(x["stream"]), int(x["seq"]), int(x["bytes"]))
			rig.step()
		var got := {"events": events, "duplicates": st.events_duplicate - before[0], "outOfOrder": st.events_out_of_order - before[1], "gaps": st.events_gap - before[2],
			"malformed": st.malformed - before[3], "buffered": host.session.buffered_stream_events()}
		if JSON.stringify(got, "", false) != JSON.stringify(_numbers(c["expect"]), "", false):
			bad += 1
			print("   stream vector differs: ", c["name"], "\n   got  ", JSON.stringify(got), "\n   want ", JSON.stringify(c["expect"]))
	_check(cases.size() >= 10 and bad == 0, "the streamReceive vectors through the session: %d cases, %d differ" % [cases.size(), bad])


## JSON numbers load as floats; whole ones become ints so the text compares.
func _numbers(v: Variant) -> Variant:
	if v is float and floorf(v) == v:
		return int(v)
	if v is Array:
		return (v as Array).map(func(x: Variant) -> Variant: return _numbers(x))
	if v is Dictionary:
		var d := {}
		for k: Variant in v:
			d[k] = _numbers(v[k])
		return d
	return v


func _spec(path: String) -> Variant:
	var spec := ProjectSettings.globalize_path("res://").path_join("../../spec").simplify_path()
	var j := JSON.new()
	j.parse(FileAccess.get_file_as_string(spec.path_join(path)))
	return j.data


# ---- real links on 127.0.0.1 ---------------------------------------------------------------------------------------------

func _until(cond: Callable, ms: int = 15000) -> bool:
	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < ms:
		if cond.call():
			return true
		await process_frame
	return cond.call()


func _test_loopback() -> void:
	_tests += 1
	var bp := {"game": {"id": "replication-loopback"}, "engine": "godot-gdscript", "hosting": {"nostr": false}, "sync": {"mode": "replication"}}
	var hc := OneLobbyClient.from_config(bp, {"display_name": "Host"})
	root.add_child(hc)
	var hl: OneLobbyLobby = await hc.host({"tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1", "udp_port_range": [47980, 47984]})
	if hl == null:
		_check(false, "loopback: host(): %s" % JSON.stringify(hc.last_error))
		return
	_check(hl.mode == "raw", "loopback: a replication file builds a raw lobby")
	var jc := OneLobbyClient.from_config(bp, {"display_name": "Sam"})
	root.add_child(jc)
	var jl: OneLobbyLobby = await jc.join(hl.ip_code)
	if jl == null:
		_check(false, "loopback: join(): %s" % JSON.stringify(jc.last_error))
		return
	_check(await _until(func() -> bool: return jl.is_ready and hl.is_peer_ready(jl.local_peer_id)), "loopback: the joiner is linked")
	var hs := OneLobbyReplicationSession.new(hl)
	var cs := OneLobbyReplicationSession.new(jl)
	var spawned: Array = []
	cs.entity_spawned.connect(func(e: Dictionary) -> void: spawned.append(e["id"]))
	var host_events: Array = []
	var client_events: Array = []
	hs.event_received.connect(func(_f: int, _t: int, p: PackedByteArray) -> void: host_events.append(p[0]))
	cs.event_received.connect(func(_f: int, _t: int, p: PackedByteArray) -> void: client_events.append(p[0]))
	var alien := _alien({"x": -10.0})
	var id := hs.spawn(7, 0, _entity(alien))
	var inputs: Array = []
	var alive := [true]
	var drive := func() -> void:
		if not alive[0]:
			return
		hs.pump()
		while hs.clock.try_advance():
			alien["x"] += 0.1
			var f := hs.try_get_input(jl.local_peer_id)
			if not f.is_empty() and not f["repeated"]:
				inputs.append((f["bytes"] as PackedByteArray)[0])
			hs.send_snapshot()
		cs.pump()
		while cs.clock.try_advance():
			cs.submit_input(_bytes([cs.clock.tick & 0xFF]))
	process_frame.connect(drive)
	_check(await _until(func() -> bool: return spawned.size() == 1), "loopback: the client sees the entity")
	hs.send_event(_bytes([11]), jl.local_peer_id)
	cs.send_event(_bytes([22]))
	_check(await _until(func() -> bool: return host_events.size() == 1 and client_events.size() == 1 and inputs.size() > 10 and cs.last_processed_input > 0), "loopback: inputs and an event each way")
	_check(await _until(func() -> bool:
		var s: Variant = cs.try_sample(id, schema)
		return s != null and s["x"] > -9.0), "loopback: the entity moved on the client")
	_check(spawned == [id] and host_events == [22] and client_events == [11], "loopback: events and spawn arrive once")
	_check(hs.acked_tick(jl.local_peer_id) > 0 and cs.stats.malformed == 0 and hs.stats.keyframes_sent == 1, "loopback: acked, nothing malformed, one keyframe")
	var latest := cs.try_get_latest(id, schema)
	_check(not latest.is_empty() and latest["state"]["x"] > -10.0, "loopback: try_get_latest")
	alive[0] = false
	process_frame.disconnect(drive)
	hs.dispose()
	cs.dispose()
	jl.leave()
	hl.leave()
	await process_frame
	jc.queue_free()
	hc.queue_free()
