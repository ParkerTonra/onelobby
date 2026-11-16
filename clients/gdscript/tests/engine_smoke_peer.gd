extends SceneTree
## GDScript engine peer for tools/engine-smoke (its README has the shared peer protocol and flags). Hosts or joins a raw
## lobby by one route (server | nostr | typed | ipcode | turn), answers/sends a few rounds of game messages on both
## channels and prints "RESULT PASS ..." / "RESULT FAIL ..." (exit 0 / 1).
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/engine_smoke_peer.gd -- \
##       --role=host|join --route=... [--server=ws://..] [--relay=ws://..] [--port=N] [--code=..] [--turn="turn:.. user pass"]
## `--scenario=room` runs the room layer instead of the ping rounds (a joiner with `--wrongpw` must be refused with bad_password);
## the protocol is the one in tools/engine-smoke/js-peer.mjs `roomScenario()`.

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
