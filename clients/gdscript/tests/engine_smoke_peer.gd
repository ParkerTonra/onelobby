extends SceneTree
## GDScript engine peer for tools/engine-smoke (its README has the shared peer protocol and flags). Hosts or joins a raw
## lobby by one route (server | nostr | typed | ipcode | turn), answers/sends a few rounds of game messages on both
## channels and prints "RESULT PASS ..." / "RESULT FAIL ..." (exit 0 / 1).
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/engine_smoke_peer.gd -- \
##       --role=host|join --route=... [--server=ws://..] [--relay=ws://..] [--port=N] [--code=..] [--turn="turn:.. user pass"]
## `--scenario=room` runs the room layer instead of the ping rounds (a joiner with `--wrongpw` must be refused with bad_password);
## the protocol is the one in tools/engine-smoke/js-peer.mjs `roomScenario()`. `--scenario=replication` runs the binary replication
## scenario (js-peer.mjs `replicationScenario()`): it prints the same `REPL ...` line as the JS and C# peers.

var _a := {}
var _client: OneLobbyClient
var _name := "gd"


func _init() -> void:
	for x in OS.get_cmdline_user_args():
		if x.begins_with("--"):
			var eq := x.find("=")
			if eq < 0:
				_a[x.substr(2)] = "1"
			else:
				_a[x.substr(2, eq - 2)] = x.substr(eq + 1)
	_name = str(_a.get("name", "gd"))
	var deadline := Time.get_ticks_msec() + int(_a.get("timeout", "60")) * 1000
	process_frame.connect(func() -> void:
		if Time.get_ticks_msec() > deadline:
			_finish(false, "gave up after %s s (%s)" % [_a.get("timeout", "60"), _client.last_error if _client != null else {}]))
	_run.call_deferred()


func _finish(ok: bool, why: String) -> void:
	print(("RESULT PASS " if ok else "RESULT FAIL ") + _name + " " + why)
	quit(0 if ok else 1)


func _txt(s: String) -> PackedByteArray:
	return s.to_utf8_buffer()


func _run() -> void:
	_client = OneLobbyClient.new()
	_client.game_id = "com.onelobby.enginesmoke"
	_client.net_version = "1"
	_client.display_name = _name
	_client.ready_timeout_ms = 40000
	if _a.get("sync") == "lockstep":
		_client.sync_mode = "lockstep"
		_client.tick_rate = 20
		_client.hash_every_ticks = 10
	var ice: Array = []
	if _a.has("turn"):
		# the pasted line goes through the addon's own parser, as a settings field would
		var r := OneLobbyTurn.parse_line(str(_a["turn"]))
		if not r.ok:
			_finish(false, "parse_line: " + str(r.error))
			return
		ice = [r.server]
		_client.relay_only = true
	_client.lobby_server = str(_a.get("server", "ws://localhost:8080"))
	_client.store = OneLobbyStore.memory() # peers on one machine must not share a player id through user://
	root.add_child(_client)
	if _a.get("scenario") == "room":
		await _room(ice)
	elif _a.get("scenario") == "replication":
		await _replication(ice)
	elif _a.get("role") == "host":
		await _host(ice)
	else:
		await _join(ice)


func _host(ice: Array) -> void:
	var route := str(_a.get("route"))
	var joiners := int(_a.get("joiners", "2"))
	var rounds := int(_a.get("rounds", "3"))
	var lobby: OneLobbyLobby
	var code := ""
	var typed := ""
	var ipcode := ""
	if route == "server":
		lobby = await _client.host({"name": "smoke", "max_players": 4})
		if lobby != null:
			code = lobby.code
	else:
		var port := int(_a.get("port"))
		var o := {"name": "smoke", "max_players": 4, "tcp_port": port, "listen_address": "127.0.0.1",
			"public_ip": "127.0.0.1", "udp_port_range": [port, port + joiners + 1], "ice_servers": ice,
			"stun": [], "relays": [str(_a.get("relay", ""))] if _a.has("relay") else []}
		if route == "typed" or route == "ipcode":
			o["nostr"] = false
		lobby = await _client.host_direct(o)
		if lobby != null:
			typed = "127.0.0.1:%d" % port
			ipcode = lobby.ip_code
			code = typed if route == "typed" else (ipcode if route == "ipcode" else lobby.code)
	if lobby == null:
		_finish(false, "host failed: %s" % _client.last_error)
		return
	print("HOST_READY code=%s typed=%s ipcode=%s" % [code, typed, ipcode])
	var ready := {}
	var pong := {}
	var fpong := {}
	var byes := {}
	lobby.peer_ready.connect(func(p: Dictionary) -> void:
		ready[int(p["peer_id"])] = true
		print("peer_ready ", p["peer_id"]))
	lobby.message_received.connect(func(from: int, bytes: PackedByteArray, ch: int) -> void:
		var f := bytes.get_string_from_utf8().split("|")
		if f.size() < 2:
			if f[0] == "bye":
				byes[from] = true
			return
		if f[0] == "pong":
			if not pong.has(f[1]):
				pong[f[1]] = {}
			pong[f[1]][from] = true
		elif f[0] == "fpong" and ch == OneLobbyWire.FAST:
			if not fpong.has(f[1]):
				fpong[f[1]] = {}
			fpong[f[1]][from] = true
		elif f[0] == "bye":
			byes[from] = true)
	while ready.size() < joiners:
		await create_timer(0.05).timeout
	if _a.get("sync") == "lockstep":
		if not await _sync_run(lobby, true, joiners + 1):
			return
		for _i in 400:
			if byes.size() >= joiners:
				break
			await create_timer(0.05).timeout
		if byes.size() < joiners:
			_finish(false, "only %d/%d joiners said bye" % [byes.size(), joiners])
			return
		lobby.broadcast(_txt("done"), OneLobbyWire.RELIABLE)
		await create_timer(0.5).timeout
		await lobby.leave_and_flush()
		_finish(true, "host lockstep joiners=%d" % joiners)
		return
	for r in range(1, rounds + 1):
		var k := str(r)
		lobby.broadcast(_txt("ping|" + k), OneLobbyWire.RELIABLE)
		while pong.get(k, {}).size() < joiners or fpong.get(k, {}).size() < joiners:
			lobby.broadcast(_txt("fping|" + k), OneLobbyWire.FAST)
			await create_timer(0.2).timeout
		print("round ", r, " ok")
	lobby.broadcast(_txt("done"), OneLobbyWire.RELIABLE)
	for _i in 100:
		if byes.size() >= joiners:
			break
		await create_timer(0.1).timeout
	if byes.size() < joiners:
		_finish(false, "only %d/%d joiners said bye" % [byes.size(), joiners])
		return
	await create_timer(0.3).timeout
	await lobby.leave_and_flush()
	_finish(true, "host rounds=%d joiners=%d" % [rounds, joiners])


func _join(ice: Array) -> void:
	var route := str(_a.get("route"))
	var code := str(_a.get("code", ""))
	var lobby: OneLobbyLobby
	if route == "server":
		lobby = await _client.join(code)
	else:
		var o := {"ice_servers": ice, "timeout_ms": 40000, "relays": [str(_a.get("relay", ""))] if _a.has("relay") else []}
		lobby = await _client.join_direct(code, o)
	if lobby == null:
		_finish(false, "join failed: %s" % _client.last_error)
		return
	var seen := {}
	var fseen := {}
	var done := [false]
	lobby.message_received.connect(func(from: int, bytes: PackedByteArray, ch: int) -> void:
		var f := bytes.get_string_from_utf8().split("|")
		if f[0] == "ping":
			seen[f[1]] = true
			lobby.send(from, _txt("pong|%s|%s" % [f[1], _name]), OneLobbyWire.RELIABLE)
		elif f[0] == "fping" and ch == OneLobbyWire.FAST:
			fseen[f[1]] = true
			lobby.send(from, _txt("fpong|%s|%s" % [f[1], _name]), OneLobbyWire.FAST)
		elif f[0] == "done":
			done[0] = true
			lobby.send(from, _txt("bye|" + _name), OneLobbyWire.RELIABLE))
	var rounds := int(_a.get("rounds", "3"))
	if not lobby.is_ready:
		await lobby.ready
	print("ready, host ", lobby.host_peer_id)
	if _a.get("sync") == "lockstep":
		if not await _sync_run(lobby, false, int(_a.get("peers", "3"))):
			return
		lobby.send(lobby.host_peer_id, _txt("bye|" + _name), OneLobbyWire.RELIABLE)
		while not done[0]:
			await create_timer(0.05).timeout
		await create_timer(0.3).timeout
		await lobby.leave_and_flush()
		_finish(true, "joiner lockstep")
		return
	while not done[0]:
		await create_timer(0.05).timeout
	await create_timer(0.5).timeout
	await lobby.leave_and_flush()
	var ok: bool = seen.size() == rounds and fseen.size() == rounds
	_finish(ok, "joiner rounds=%d (reliable %d fast %d)" % [rounds, seen.size(), fseen.size()])


# ---- the room scenario (--scenario=room): the host has a password and a 1 s countdown; the good joiner joins with the password and
# data, says ready; the host checks the data, starts, the countdown and start reach the joiner, then the host kicks it with a code
# and a reason the joiner must read back. The wrong-password joiner (--wrongpw) must be refused with bad_password.

const ROOM_PW := "smoke-pw"


func _until(cond: Callable, what: String, secs: float = 30.0) -> bool:
	var t0 := Time.get_ticks_msec()
	while not cond.call():
		if Time.get_ticks_msec() - t0 > int(secs * 1000.0):
			_finish(false, "timed out: " + what)
			return false
		await process_frame
	return true


func _room(ice: Array) -> void:
	var route := str(_a.get("route"))
	if _a.get("role") == "host":
		var room := {"countdown_seconds": 1, "min_players": 2}
		var lobby: OneLobbyLobby
		var typed := ""
		if route == "server":
			lobby = await _client.host({"name": "smoke", "max_players": 4, "password": ROOM_PW, "room": room})
		else:
			var port := int(_a.get("port"))
			lobby = await _client.host_direct({"name": "smoke", "max_players": 4, "password": ROOM_PW, "room": room, "tcp_port": port,
				"listen_address": "127.0.0.1", "public_ip": "127.0.0.1", "udp_port_range": [port, port + 3], "ice_servers": ice, "stun": [], "nostr": false})
			typed = "127.0.0.1:%d" % port
		if lobby == null:
			_finish(false, "host failed: %s" % _client.last_error)
			return
		print("HOST_READY code=%s typed=%s ipcode=" % [lobby.code if route == "server" else typed, typed])
		var r := lobby.room
		if not await _until(func() -> bool: return r.players().size() == 2 and r.players().all(func(p: Dictionary) -> bool: return p["id"] == lobby.local_peer_id or p["ready"]), "a ready joiner"):
			return
		var j: Dictionary = r.players().filter(func(p: Dictionary) -> bool: return p["id"] != lobby.local_peer_id)[0]
		if j["data"].get("color") != "#ff8800" or j["data"].get("team") != "1":
			_finish(false, "joiner data was %s" % JSON.stringify(j["data"]))
			return
		var started := [false]
		r.started.connect(func() -> void: started[0] = true)
		var err := r.start()
		if err != "":
			_finish(false, "start: " + err)
			return
		if not await _until(func() -> bool: return started[0], "start"):
			return
		print("started")
		r.kick(int(j["id"]), {"code": "smoke_kick", "reason": "Smoke test: bye"})
		if not await _until(func() -> bool: return r.players().size() == 1, "the kick to remove the joiner"):
			return
		await create_timer(0.3).timeout
		await lobby.leave_and_flush()
		_finish(true, "room host")
		return
	var code := str(_a.get("code", ""))
	var jo := {"password": ROOM_PW, "data": {"color": "#ff8800", "team": "1"}}
	if _a.has("wrongpw"):
		jo["password"] = "wrong-pw"
	if route != "server":
		jo.merge({"ice_servers": ice, "timeout_ms": 40000, "relays": [str(_a.get("relay", ""))] if _a.has("relay") else []})
	var lobby: OneLobbyLobby = await _client.join(code, jo) if route == "server" else await _client.join_direct(code, jo)
	if _a.has("wrongpw"):
		if lobby == null and str(_client.last_error.get("code")) == "bad_password":
			_finish(true, "refused with bad_password")
		else:
			_finish(false, "a wrong password gave %s" % ("a lobby" if lobby != null else str(_client.last_error)))
		return
	if lobby == null:
		_finish(false, "join failed: %s" % _client.last_error)
		return
	var removed: Array = []
	var started := [false]
	var counted := [false]
	lobby.room.removed.connect(func(info: Dictionary) -> void: removed.append(info))
	lobby.room.started.connect(func() -> void: started[0] = true)
	lobby.room.countdown_changed.connect(func(_c: Dictionary) -> void: counted[0] = true)
	if not await _until(func() -> bool: return lobby.room.supported == true and not lobby.room.me().is_empty(), "the room snapshot"):
		return
	lobby.room.set_ready(true)
	if not await _until(func() -> bool: return started[0], "start"):
		return
	if not counted[0]:
		_finish(false, "no countdown reached the joiner")
		return
	if not await _until(func() -> bool: return not removed.is_empty(), "the kick"):
		return
	var info: Dictionary = removed[0]
	var ok: bool = info.get("code") == "smoke_kick" and info.get("reason") == "Smoke test: bye"
	_finish(ok, "room joiner" if ok else "removal was %s" % JSON.stringify(info))


# ---- the lockstep exchange (--sync=lockstep): chat, a shared pause and 60 ticks of a tiny sim; the same flow in all three
# engine peers. The sim is FNV-1a 32 over every frame (tick, then peer id, length and bytes of each command), so equal
# hashes mean equal frames. Returns false after _finish(false, ...).

const SYNC_TICKS := 60
const CMDS_EACH := 5

var _h := 0x811c9dc5
var _cmds := 0
var _tick := 0


func _fnv(b: int) -> void:
	_h = ((_h ^ (b & 255)) * 16777619) & 0xFFFFFFFF


func _sync_run(lobby: OneLobbyLobby, is_host: bool, total: int) -> bool:
	var ls := lobby.lockstep
	ls.snapshot = func() -> PackedByteArray:
		var o := PackedByteArray()
		o.resize(8)
		o.encode_u32(0, _h)
		o.encode_u32(4, _cmds)
		return o
	ls.restore = func(t: int, b: PackedByteArray) -> void:
		_h = b.decode_u32(0)
		_cmds = b.decode_u32(4)
		_tick = t
	# chat: the host speaks first; everyone answers; everyone must see one line from each of the `total` peers
	var lines := {}
	lobby.chat.message.connect(func(l: Dictionary) -> void:
		lines[int(l["peer_id"])] = l["text"]
		if not is_host and int(l["peer_id"]) == lobby.host_peer_id and not lines.has(lobby.local_peer_id):
			lobby.chat.send("hi from " + _name))
	if is_host:
		await create_timer(0.5).timeout # a joiner may still be between ready and its handler
		lobby.chat.send("hi from " + _name)
	for _i in 400:
		if lines.size() >= total:
			break
		await create_timer(0.05).timeout
	if lines.size() < total:
		_finish(false, "chat: lines from %d/%d peers" % [lines.size(), total])
		return false
	print("chat ok lines=", lines.size())
	# pause: join1 pauses once at tick 20 and resumes 700 ms later; every peer sees both changes and no ticks in between
	var pause := {"at": -1, "gap": -1}
	lobby.pause.changed.connect(func(s: Dictionary) -> void:
		if s["paused"] and pause["at"] < 0:
			pause["at"] = ls.last_tick
		elif not s["paused"] and pause["at"] >= 0 and pause["gap"] < 0:
			pause["gap"] = ls.last_tick - int(pause["at"]))
	if is_host:
		lobby.start()
	var sent := 0
	var asked := false
	var final_hash := -1
	var final_cmds := 0
	var t0 := Time.get_ticks_msec()
	while final_hash < 0:
		while true:
			var f := ls.next_frame()
			if f.is_empty():
				break
			var tk := int(f["tick"])
			for i in 4:
				_fnv(tk >> (8 * i))
			for c: Dictionary in f["commands"]:
				var cb: PackedByteArray = c["bytes"]
				_fnv(int(c["peer_id"]))
				_fnv(int(c["peer_id"]) >> 8)
				_fnv(cb.size())
				for x in cb:
					_fnv(x)
				_cmds += 1
			_tick = tk
			ls.report_hash(tk, _h)
			if tk % 3 == 0 and tk <= CMDS_EACH * 3 and sent < CMDS_EACH:
				sent += 1
				ls.submit(PackedByteArray([lobby.local_peer_id, sent]))
			if tk == SYNC_TICKS:
				final_hash = _h
				final_cmds = _cmds
		if not asked and _name.begins_with("join1") and _tick >= 20:
			asked = true
			lobby.pause.request(true)
			get_root().get_tree().create_timer(0.7).timeout.connect(func() -> void: lobby.pause.request(false))
		if Time.get_ticks_msec() - t0 > 40000:
			_finish(false, "lockstep stalled at tick %d" % _tick)
			return false
		await process_frame
	# keep applying frames until the pause has come and gone
	for _i in 300:
		if pause["gap"] >= 0:
			break
		while not ls.next_frame().is_empty():
			pass
		await create_timer(0.02).timeout
	if pause["gap"] < 0 or pause["gap"] > 4:
		_finish(false, "pause: %s" % ("never resumed" if pause["gap"] < 0 else "%d frames arrived while paused" % pause["gap"]))
		return false
	print("LOCKSTEP tick=%d hash=%d cmds=%d pausegap=%d" % [SYNC_TICKS, final_hash, final_cmds, pause["gap"]])
	return true


# ---- replication scenario (--scenario=replication): the flow of tools/engine-smoke/js-peer.mjs `replicationScenario()` -----------------
# The host spawns two entities (e1 host-owned, e2 owned by the joiner) and steps them as a pure function of the host tick (frozen after tick
# 60), despawns e2 at tick 40, sends one stream event to the joiner at tick 10. The joiner submits one input byte per tick, sends one event to
# the host when it first sees an entity, and the raw message "bye" once it holds a snapshot of tick >= 66. Both print
# REPL spawned=2 despawned=1 entities=1 events=1 hash=<FNV-1a 32 of e1's id, type, owner and state bytes>; run.mjs requires the lines equal.

func _write_repl(w: OneLobbyNetWriter, s: Dictionary) -> void:
	w.write_quantized(s["x"], -256.0, 256.0, 16)
	w.write_quantized(s["z"], -256.0, 256.0, 16)
	w.write_angle(s["yaw"], 9)
	w.write_bits(int(s["hp"]), 7)


func _e1_at(t: int) -> Dictionary:
	var tt := mini(t, 60)
	return {"x": -100.0 + 1.5 * float(tt), "z": 20.0, "yaw": float((tt * 7) % 360), "hp": 100 - (tt % 10)}


func _e2_at(t: int) -> Dictionary:
	var tt := mini(t, 60)
	return {"x": 50.0 - 0.5 * float(tt), "z": -20.0, "yaw": float((tt * 3) % 360), "hp": 90}


func _repl_hash(owner: int, s: Dictionary) -> int:
	var w := OneLobbyNetWriter.new()
	_write_repl(w, s)
	var h := 0x811C9DC5
	var bytes := PackedByteArray([1, 1, owner])
	bytes.append_array(w.to_bytes())
	for b in bytes:
		h = ((h ^ int(b)) * 16777619) & 0xFFFFFFFF
	return h


## The state schema the joiner reads with (the game's own, a small quantised state).
class ReplSchema:
	extends RefCounted

	func read(r: OneLobbyNetReader) -> Dictionary:
		return {"x": r.read_quantized(-256.0, 256.0, 16), "z": r.read_quantized(-256.0, 256.0, 16), "yaw": r.read_angle(9), "hp": r.read_bits(7)}

	func interpolate(p: Dictionary, q: Dictionary, t: float) -> Dictionary:
		return p if t < 0.5 else q


func _replication(ice: Array) -> void:
	var route := str(_a.get("route"))
	if _a.get("role") == "host":
		var lobby: OneLobbyLobby
		var typed := ""
		if route == "server":
			lobby = await _client.host({"name": "smoke", "max_players": 4})
		else:
			var port := int(_a.get("port"))
			var o := {"name": "smoke", "max_players": 4, "tcp_port": port, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1",
				"udp_port_range": [port, port + 3], "ice_servers": ice, "stun": [], "nostr": false, "relays": [str(_a.get("relay", ""))] if _a.has("relay") else []}
			lobby = await _client.host_direct(o)
			typed = "127.0.0.1:%d" % port
		if lobby == null:
			_finish(false, "host failed: %s" % _client.last_error)
			return
		print("HOST_READY code=%s typed=%s ipcode=" % [lobby.code if route == "server" else typed, typed])
		var joiner := [0]
		lobby.peer_ready.connect(func(p: Dictionary) -> void: joiner[0] = int(p["peer_id"]))
		if not await _until(func() -> bool: return joiner[0] != 0, "a linked joiner", 40.0):
			return
		var rep := OneLobbyReplicationSession.new(lobby)
		var cur := [0] # the host tick the entity states are a function of
		var counts := {"spawned": 0, "despawned": 0, "events": 0}
		var bye := [false]
		var bad := [""]
		rep.spawn(1, 0, func(w: OneLobbyNetWriter) -> void: _write_repl(w, _e1_at(cur[0])))
		counts["spawned"] += 1
		var id2 := rep.spawn(2, joiner[0], func(w: OneLobbyNetWriter) -> void: _write_repl(w, _e2_at(cur[0])))
		counts["spawned"] += 1
		rep.event_received.connect(func(_f: int, _t: int, p: PackedByteArray) -> void:
			if p.get_string_from_utf8() == "hello-host":
				counts["events"] += 1
			else:
				bad[0] = "event " + p.get_string_from_utf8())
		rep.other_message.connect(func(_f: int, p: PackedByteArray, _c: int) -> void:
			if p.get_string_from_utf8() == "bye":
				bye[0] = true)
		var seqs: Array = []
		var t0 := Time.get_ticks_msec()
		while not (bye[0] and rep.clock.tick >= 75 and counts["events"] == 1):
			rep.pump()
			while rep.clock.try_advance():
				var t := rep.clock.tick
				cur[0] = t
				if t == 10:
					rep.send_event(_txt("hello-client"), joiner[0], OneLobbyWire.RELIABLE, 1)
				if t == 40:
					rep.despawn(id2)
					counts["despawned"] += 1
				var f := rep.try_get_input(joiner[0])
				if not f.is_empty() and not f["repeated"]:
					seqs.append(f["seq"])
					var fb: PackedByteArray = f["bytes"]
					if fb.size() != 1 or fb[0] != (int(f["seq"]) & 255):
						bad[0] = "input bytes of seq %d" % f["seq"]
				rep.send_snapshot()
			if Time.get_ticks_msec() - t0 > 40000:
				_finish(false, "host stalled: bye %s tick %d events %d" % [bye[0], rep.clock.tick, counts["events"]])
				return
			await process_frame
		var contiguous := seqs.size() >= 20
		for i in range(1, seqs.size()):
			contiguous = contiguous and seqs[i] == seqs[i - 1] + 1
		print("REPL spawned=%d despawned=%d entities=%d events=%d hash=%d" % [counts["spawned"], counts["despawned"], rep.host_entities().size(), counts["events"], _repl_hash(0, _e1_at(cur[0]))])
		await create_timer(0.3).timeout
		await lobby.leave_and_flush()
		var ok: bool = contiguous and bad[0] == "" and rep.stats.malformed == 0
		_finish(ok, "replication host" if ok else "inputs %d contiguous=%s %s malformed=%d" % [seqs.size(), contiguous, bad[0], rep.stats.malformed])
		return
	var code := str(_a.get("code", ""))
	var jl: OneLobbyLobby
	if route == "server":
		jl = await _client.join(code)
	else:
		jl = await _client.join_direct(code, {"ice_servers": ice, "timeout_ms": 40000, "relays": [str(_a.get("relay", ""))] if _a.has("relay") else []})
	if jl == null:
		_finish(false, "join failed: %s" % _client.last_error)
		return
	if not jl.is_ready:
		await jl.ready
	var jrep := OneLobbyReplicationSession.new(jl)
	var jc := {"spawned": 0, "despawned": 0, "events": 0}
	var said := [false]
	jrep.entity_spawned.connect(func(_e: Dictionary) -> void:
		jc["spawned"] += 1
		if not said[0]:
			said[0] = true
			jrep.send_event(_txt("hello-host")))
	jrep.entity_despawned.connect(func(_e: Dictionary) -> void: jc["despawned"] += 1)
	jrep.event_delivered.connect(func(e: Dictionary) -> void:
		if (e["payload"] as PackedByteArray).get_string_from_utf8() == "hello-client" and e["stream"] == 1 and e["seq"] == 1:
			jc["events"] += 1)
	var t1 := Time.get_ticks_msec()
	while not (jc["spawned"] == 2 and jc["despawned"] == 1 and jc["events"] == 1 and jrep.latest_tick >= 66 and jrep.last_processed_input > 0):
		jrep.pump()
		while jrep.clock.try_advance():
			jrep.submit_input(PackedByteArray([jrep.clock.tick & 255]))
		if Time.get_ticks_msec() - t1 > 40000:
			_finish(false, "stalled: spawned %d despawned %d events %d latest %d" % [jc["spawned"], jc["despawned"], jc["events"], jrep.latest_tick])
			return
		await process_frame
	var schema := ReplSchema.new()
	var latest := jrep.try_get_latest(1, schema)
	if latest.is_empty():
		_finish(false, "entity 1 is not in the newest snapshot")
		return
	print("REPL spawned=%d despawned=%d entities=%d events=%d hash=%d" % [jc["spawned"], jc["despawned"], jrep.entities().size(), jc["events"], _repl_hash(0, latest["state"])])
	jl.send(jl.host_peer_id, _txt("bye"), OneLobbyWire.RELIABLE)
	await create_timer(0.5).timeout
	await jl.leave_and_flush()
	var jok: bool = jrep.stats.malformed == 0 and jrep.entities().size() == 1 and absf(float(latest["state"]["x"]) - float(_e1_at(60)["x"])) < 0.01
	_finish(jok, "replication joiner" if jok else "malformed=%d entities=%d x=%s" % [jrep.stats.malformed, jrep.entities().size(), latest["state"]["x"]])
