extends SceneTree
## GDScript engine peer for tools/engine-smoke (its README has the shared peer protocol and flags). Hosts or joins a raw
## lobby by one route (server | nostr | typed | ipcode | turn), answers/sends a few rounds of game messages on both
## channels and prints "RESULT PASS ..." / "RESULT FAIL ..." (exit 0 / 1).
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/engine_smoke_peer.gd -- \
##       --role=host|join --route=... [--server=ws://..] [--relay=ws://..] [--port=N] [--code=..] [--turn="turn:.. user pass"]

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
	root.add_child(_client)
	if _a.get("role") == "host":
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
	while not done[0]:
		await create_timer(0.05).timeout
	await create_timer(0.5).timeout
	await lobby.leave_and_flush()
	var ok: bool = seen.size() == rounds and fseen.size() == rounds
	_finish(ok, "joiner rounds=%d (reliable %d fast %d)" % [rounds, seen.size(), fseen.size()])
