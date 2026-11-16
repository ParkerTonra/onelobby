extends SceneTree
## GDScript engine peer for tools/engine-smoke (its README has the shared peer protocol and flags). Hosts or joins a raw
## lobby by one route (server | nostr | typed | ipcode | turn), answers/sends a few rounds of game messages on both
## channels and prints "RESULT PASS ..." / "RESULT FAIL ..." (exit 0 / 1).
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/engine_smoke_peer.gd -- \
##       --role=host|join --route=... [--server=ws://..] [--relay=ws://..] [--port=N] [--code=..] [--turn="turn:.. user pass"]
## `--scenario=room` runs the room layer instead of the ping rounds (a joiner with `--wrongpw` must be refused with bad_password);
## the protocol is the one in tools/engine-smoke/js-peer.mjs `roomScenario()`. `--scenario=replication` runs the binary replication
## scenario (js-peer.mjs `replicationScenario()`): it prints the same `REPL ...` line as the JS and C# peers. `--scenario=players [--authority=owner|host]`
## runs the networked player layer over fake lag (js-peer.mjs `playersScenario()`): it prints the same `PLAYERS ...` line.

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
	# --scenario=players: fake lag on every link of this peer (the C# NetSimTransport's twin): --lag (one-way ms, both ends wrapped), --jitter, --loss (percent, fast channel), --seed
	if _a.get("scenario") == "players":
		_client.transport = OneLobbyNetSimTransport.new(_client.transport, {"latency_ms": float(_a.get("lag", "50")), "jitter_ms": float(_a.get("jitter", "10")),
			"loss_percent": float(_a.get("loss", "2")), "seed": int(_a.get("seed", "1"))})
	root.add_child(_client)
	if _a.get("scenario") == "room":
		await _room(ice)
	elif _a.get("scenario") == "replication":
		await _replication(ice)
	elif _a.get("scenario") == "players":
		await _players(ice)
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


# ---- players scenario (--scenario=players): the networked player layer between engines over a lagging link; the same flow in the JS, GDScript and C# peers ----
# THE RULE (README, "The players scenario"; every peer writes it once in its own language):
#   walk (t seconds from the walk start): heading h = 0.75 * t rad, speed 6 m/s: x = 8 (1 - cos h), z = 8 sin h, v = 6 (sin h, cos h), yaw = h in degrees [0, 360);
#   jump at t = 2 s: y = 5 s - 7.5 s^2 for s = t - 2 in [0, 2/3), on the ground otherwise; mode 4 in the air, 1 walking, 0 standing; stand at t >= 6.
#   authority "owner": the joiner gives that state as its own every loop. authority "host": the joiner gives the input moveY 1 (0 from t = 6), yaw = h in
#   degrees, jump pressed for t in [2, 2.1), and both ends run the same step (below). One jump action event at t = 2 in both.

const P_SPEED := 6.0
const P_W := 0.75
const P_JUMP_AT := 2.0
const P_JUMP_V := 5.0
const P_GRAV := 15.0
const P_WALK_S := 6.0
const P_SETTLE_MS := 1500
const P_HOLD_MS := 1000
const P_CHUNK := 20
const P_MSG := 0x54


func _path_state(t: float) -> Dictionary:
	var tt := clampf(t, 0.0, P_WALK_S)
	var h := P_W * tt
	var r := P_SPEED / P_W
	var s := tt - P_JUMP_AT
	var air := s >= 0.0 and s < 2.0 * P_JUMP_V / P_GRAV
	var walking := t >= 0.0 and t < P_WALK_S
	return {
		"x": r * (1.0 - cos(h)), "z": r * sin(h), "y": (P_JUMP_V * s - 0.5 * P_GRAV * s * s) if air else 0.0,
		"vx": P_SPEED * sin(h) if walking else 0.0, "vz": P_SPEED * cos(h) if walking else 0.0, "vy": (P_JUMP_V - P_GRAV * s) if air else 0.0,
		"yaw": fposmod(rad_to_deg(h), 360.0), "on_ground": not air, "mode": 4 if air else (1 if walking else 0),
	}


func _path_input(t: float) -> Dictionary:
	return {
		"move_x": 0.0, "move_y": 1.0 if (t >= 0.0 and t < P_WALK_S) else 0.0,
		"yaw": fposmod(rad_to_deg(P_W * clampf(t, 0.0, P_WALK_S)), 360.0),
		"buttons": {"jump": t >= P_JUMP_AT and t < P_JUMP_AT + 0.1},
	}


func _player_step(s: Dictionary, i: Dictionary, dt: float) -> Dictionary:
	var yaw := deg_to_rad(float(i["yaw"]))
	var vx := P_SPEED * (float(i["move_y"]) * sin(yaw) + float(i["move_x"]) * cos(yaw))
	var vz := P_SPEED * (float(i["move_y"]) * cos(yaw) - float(i["move_x"]) * sin(yaw))
	var y := float(s["y"])
	var vy := float(s["vy"])
	var on_ground: bool = s["on_ground"]
	if on_ground and i["buttons"]["jump"]:
		vy = P_JUMP_V
		on_ground = false
	if not on_ground:
		vy -= P_GRAV * dt
		y += vy * dt
		if y <= 0.0:
			y = 0.0
			vy = 0.0
			on_ground = true
	var o := s.duplicate()
	o["x"] = float(s["x"]) + vx * dt
	o["z"] = float(s["z"]) + vz * dt
	o["y"] = y
	o["vx"] = vx
	o["vz"] = vz
	o["vy"] = vy
	o["yaw"] = i["yaw"]
	o["on_ground"] = on_ground
	o["mode"] = (1 if (float(i["move_x"]) != 0.0 or float(i["move_y"]) != 0.0) else 0) if on_ground else 4
	return o


## The owner's position at time t (ms) by linear interpolation of a trace [[unix ms, x, y, z], ...]; null outside the trace.
func _trace_at(path: Array, t: float) -> Variant:
	var n := path.size()
	if n == 0 or t < float(path[0][0]) or t > float(path[n - 1][0]):
		return null
	var lo := 0
	var hi := n - 1
	while hi - lo > 1:
		var m := (lo + hi) >> 1
		if float(path[m][0]) <= t:
			lo = m
		else:
			hi = m
	var p: Array = path[lo]
	var q: Array = path[hi]
	var k := 0.0 if float(q[0]) == float(p[0]) else (t - float(p[0])) / (float(q[0]) - float(p[0]))
	return [float(p[1]) + (float(q[1]) - float(p[1])) * k, float(p[2]) + (float(q[2]) - float(p[2])) * k, float(p[3]) + (float(q[3]) - float(p[3])) * k]


## The one constant lag (0 to 600 ms, 8 ms steps) at which the watched path is closest to the owner's on average; then the mean and worst distance there.
func _compare_paths(owner: Array, watched: Array) -> Dictionary:
	var best := {"lag": 0, "mean": INF, "max": INF, "n": 0}
	for lag in range(0, 601, 8):
		var sum := 0.0
		var mx := 0.0
		var n := 0
		for w: Array in watched:
			var o: Variant = _trace_at(owner, float(w[0]) - float(lag))
			if o == null:
				continue
			var d := sqrt((float(w[1]) - float(o[0])) ** 2 + (float(w[2]) - float(o[1])) ** 2 + (float(w[3]) - float(o[2])) ** 2)
			sum += d
			mx = maxf(mx, d)
			n += 1
		if n > 20 and sum / float(n) < float(best["mean"]):
			best = {"lag": lag, "mean": sum / float(n), "max": mx, "n": n}
	return best


func _tmsg(text: String) -> PackedByteArray:
	var b := PackedByteArray([P_MSG])
	b.append_array(text.to_utf8_buffer())
	return b


func _unix_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)


func _players(ice: Array) -> void:
	var route := str(_a.get("route"))
	var host_auth := str(_a.get("authority", "owner")) == "host"
	var opts := {"authority": "host" if host_auth else "owner"}
	if host_auth:
		opts["step"] = Callable(self, "_player_step")
	Engine.max_fps = 100
	var limit_ms := int(_a.get("timeout", "60")) * 1000
	var t00 := Time.get_ticks_msec()
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
		var players := OneLobbyNetPlayers.new(lobby, opts)
		if not host_auth:
			players.set_local_state({})
		var st := {"copy_jumps": 0, "remote_jumps": -1, "ended": false}
		var own: Array = []
		var copy: Array = []
		players.on_action("jump", func(e: Dictionary) -> void:
			if int(e["player"]) == joiner[0]:
				st["copy_jumps"] += 1)
		players.session.other_message.connect(func(_from: int, bytes: PackedByteArray, _ch: int) -> void:
			if bytes.size() < 2 or bytes[0] != P_MSG:
				return
			var f := bytes.slice(1).get_string_from_utf8().split("|") # "S|t,x,y,z;t,x,y,z" a part of the trace, "E|<jumps>" the end
			if f[0] == "S":
				for row in f[1].split(";"):
					var c := row.split(",")
					if c.size() == 4:
						own.append([float(c[0]), float(c[1]), float(c[2]), float(c[3])])
			elif f[0] == "E":
				st["remote_jumps"] = int(f[1])
				st["ended"] = true)
		var last_copy := 0
		while not st["ended"]:
			players.pump()
			var now := _unix_ms()
			if now - last_copy >= 20:
				last_copy = now
				var s: Variant = players.get_state(joiner[0])
				if s != null:
					copy.append([float(now), float(s["x"]), float(s["y"]), float(s["z"])])
			if Time.get_ticks_msec() - t00 > limit_ms - 3000:
				_finish(false, "timed out: the joiner's trace (%d samples so far, %d copies)" % [own.size(), copy.size()])
				return
			await process_frame
		var r := _compare_paths(own, copy)
		print("PLAYERS lag=%d mean=%.3f worst=%.3f samples=%d jumps=%d/%d" % [r["lag"], r["mean"], r["max"], r["n"], st["remote_jumps"], st["copy_jumps"]])
		lobby.send(joiner[0], _tmsg("D"), OneLobbyWire.RELIABLE)
		var t1 := Time.get_ticks_msec()
		while Time.get_ticks_msec() - t1 < 600:
			players.pump()
			await process_frame
		await lobby.leave_and_flush()
		var ok: bool = is_finite(float(r["mean"])) and players.session.stats.malformed == 0
		_finish(ok, "players host (%s)" % ("host" if host_auth else "owner") if ok else "players: no comparison or malformed=%d" % players.session.stats.malformed)
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
	var jp := OneLobbyNetPlayers.new(jl, opts)
	var js := {"jumps": 0, "done": false}
	jp.on_action("jump", func(e: Dictionary) -> void:
		if e["local"]:
			js["jumps"] += 1)
	jp.session.other_message.connect(func(_from: int, bytes: PackedByteArray, _ch: int) -> void:
		if bytes.size() == 2 and bytes[0] == P_MSG and bytes[1] == 0x44:
			js["done"] = true)
	_players_drive(jp, host_auth, -1.0)
	var rows: Array = []
	var phase := "wait"
	var mark := 0
	var jumped := false
	var last_tick := -1
	var t_start := _unix_ms()
	while phase != "sent":
		var now := _unix_ms()
		if phase == "wait":
			var ready_world: bool = (not jp.local_state().is_empty()) if host_auth else jp.player_ids().has(jl.local_peer_id)
			if ready_world:
				phase = "settle"
				mark = now
		if phase == "settle" and now - mark >= P_SETTLE_MS:
			phase = "walk"
			mark = now
		var t := float(now - mark) / 1000.0 if (phase == "walk" or phase == "hold") else -1.0
		_players_drive(jp, host_auth, t)
		if t >= P_JUMP_AT and not jumped:
			jumped = true
			jp.send_action("jump")
		jp.pump()
		if phase == "walk" and jp.session.clock.tick != last_tick:
			last_tick = jp.session.clock.tick
			var l := jp.local_state()
			if not l.is_empty():
				rows.append([now, float(l["x"]), float(l["y"]), float(l["z"])])
		if phase == "walk" and t >= P_WALK_S:
			phase = "hold"
		if phase == "hold" and t >= P_WALK_S + float(P_HOLD_MS) / 1000.0:
			var i := 0
			while i < rows.size():
				var part: Array = []
				for s: Array in rows.slice(i, i + P_CHUNK):
					part.append("%d,%.3f,%.3f,%.3f" % [int(s[0]), float(s[1]), float(s[2]), float(s[3])])
				jl.send(jl.host_peer_id, _tmsg("S|" + ";".join(part)), OneLobbyWire.RELIABLE)
				i += P_CHUNK
			jl.send(jl.host_peer_id, _tmsg("E|%d" % js["jumps"]), OneLobbyWire.RELIABLE)
			print("PLAYERS_JOINER samples=%d jumps=%d" % [rows.size(), js["jumps"]])
			phase = "sent"
		if phase == "wait" and now - t_start > 60000:
			_finish(false, "the player never came into the world")
			return
		await process_frame
	var t2 := Time.get_ticks_msec()
	while not js["done"] and Time.get_ticks_msec() - t2 < 20000:
		jp.pump()
		await process_frame
	await jl.leave_and_flush()
	var jok: bool = js["done"] and js["jumps"] == 1 and jp.session.stats.malformed == 0
	_finish(jok, "players joiner (%s)" % ("host" if host_auth else "owner") if jok else "players joiner: done=%s jumps=%d malformed=%d" % [js["done"], js["jumps"], jp.session.stats.malformed])


func _players_drive(players: OneLobbyNetPlayers, host_auth: bool, t: float) -> void:
	if host_auth:
		players.set_local_input(_path_input(t))
	else:
		players.set_local_state(_path_state(t))
