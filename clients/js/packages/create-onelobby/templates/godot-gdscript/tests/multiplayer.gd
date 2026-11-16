extends SceneTree
## Two OneLobby clients in this one process, on 127.0.0.1 only (a direct host with no Nostr and no public server; nothing
## listens beyond this machine): one hosts, the other joins by its code, and each sends the other one message.
## Prints MULTIPLAYER_OK and exits 0, or MULTIPLAYER_FAIL <what> and exits 1.
##   godot --headless --audio-driver Dummy --path . -s res://tests/multiplayer.gd
## Run `godot --headless --import --path .` once first on a fresh clone (it registers the WebRTC extension and the add-on's classes).

var _done := false


func _init() -> void:
	process_frame.connect(func() -> void:
		if Time.get_ticks_msec() > 60000:
			_fail("timed out after 60 s"))
	_run.call_deferred()


func _fail(what: String) -> void:
	if _done:
		return
	_done = true
	print("MULTIPLAYER_FAIL ", what)
	quit(1)


func _client(display_name: String) -> OneLobbyClient:
	var c := OneLobbyClient.from_config("res://onelobby.json", {"display_name": display_name})
	root.add_child(c) # pumps itself every frame
	return c


func _until(cond: Callable, ms: int = 15000) -> bool:
	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < ms:
		await process_frame
		if cond.call():
			return true
	return cond.call()


func _run() -> void:
	var host := _client("Host")
	if not host.config_error.is_empty():
		return _fail("onelobby.json: " + str(host.config_error.get("message", "")))
	var guest := _client("Guest")
	var hl: OneLobbyLobby = await host.host_direct({"nostr": false, "tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1", "max_players": 2})
	if hl == null:
		return _fail("host: " + str(host.last_error))
	var gl: OneLobbyLobby = await guest.join_direct(hl.code, {"timeout_ms": 15000})
	if gl == null:
		return _fail("join: " + str(guest.last_error))
	var at_host := []
	var at_guest := []
	hl.message_received.connect(func(from: int, bytes: PackedByteArray, _ch: int) -> void: at_host.append([from, bytes.get_string_from_utf8()]))
	gl.message_received.connect(func(from: int, bytes: PackedByteArray, _ch: int) -> void: at_guest.append([from, bytes.get_string_from_utf8()]))
	var linked := await _until(func() -> bool: return hl.is_peer_ready(gl.local_peer_id) and gl.is_ready)
	if not linked:
		return _fail("the two peers never linked")
	hl.send(gl.local_peer_id, "hello guest".to_utf8_buffer())
	gl.send(hl.local_peer_id, "hello host".to_utf8_buffer())
	if not await _until(func() -> bool: return not at_host.is_empty() and not at_guest.is_empty()):
		return _fail("messages did not arrive (host got %d, guest got %d)" % [at_host.size(), at_guest.size()])
	if at_host[0] != [gl.local_peer_id, "hello host"] or at_guest[0] != [hl.local_peer_id, "hello guest"]:
		return _fail("wrong message: host got %s, guest got %s" % [at_host[0], at_guest[0]])
	gl.leave()
	hl.leave()
	await process_frame
	_done = true
	print("MULTIPLAYER_OK")
	quit(0)
