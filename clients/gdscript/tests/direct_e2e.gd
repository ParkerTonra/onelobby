extends SceneTree
## One side of the Direct-mode two-instance test (direct-test.sh runs both). No lobby server: the host publishes a dc1
## join code through a Nostr relay (a local test relay, or the public ones with --relay=public), the joiner joins by that
## code. Both sides exchange one reliable and one fast message each way; then the host leaves and the joiner must see
## session_ended("host_left"). Each side prints "direct e2e ok" and exits 0, or exits 1 after --timeout seconds.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/direct_e2e.gd -- \
##       --role=host|join --relay=ws://127.0.0.1:PORT|public --code-file=/tmp/code.txt
## --code-file can point at a code made by another client (the JS interop peer) instead.
## TURN (opt-in, needs internet): --turn-url=turn:host:port --turn-secret=S mints a coturn-style login (OneLobbyTurn) and
## passes it as ice_servers on --turn-side=host (default: joiners get it in welcome.ice) or join; --relay-only=1 makes
## both sides use relay candidates only, so the link must go through that TURN server.

var _args := {}
var _client: OneLobbyClient
var _deadline := 0


func _init() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--") and a.contains("="):
			_args[a.substr(2, a.find("=") - 2)] = a.get_slice("=", 1)
	_deadline = Time.get_ticks_msec() + int(_args.get("timeout", "40")) * 1000
	process_frame.connect(_watchdog)
	_run.call_deferred()


func _watchdog() -> void:
	if Time.get_ticks_msec() > _deadline:
		print("direct e2e FAIL: timed out (", _client.last_error if _client != null else {}, ")")
		quit(1)


## The TURN entry for this side's ice_servers, or [] (no --turn-url, or the other side passes it).
func _turn(side: String) -> Array:
	var url: String = _args.get("turn-url", "")
	if url == "" or _args.get("turn-side", "host") != side:
		return []
	var l := OneLobbyTurn.login(_args.get("turn-secret", ""), side, 3600)
	return [{"urls": [url], "username": l.username, "credential": l.credential}]


func _relays() -> Array:
	var r: String = _args.get("relay", "")
	return [] if r == "public" or r == "" else [r]


func _run() -> void:
	_client = OneLobbyClient.new()
	_client.game_id = _args.get("game", "direct-e2e")
	_client.display_name = _args.get("role", "host")
	_client.relay_only = _args.get("relay-only", "") == "1"
	root.add_child(_client)
	var code_file: String = _args.get("code-file", "")
	if _args.get("role", "host") == "host":
		await _host(code_file)
	else:
		await _join(code_file)


func _host(code_file: String) -> void:
	var opts := {"name": "direct", "max_players": 4, "relays": _relays()}
	if _args.get("relay", "") != "public":
		opts["stun"] = []
	opts["ice_servers"] = _turn("host")
	var lobby := await _client.host_direct(opts)
	if lobby == null:
		_done(false, "host_direct failed: %s" % _client.last_error)
		return
	print("hosting ", lobby.code, " relays=", _args.get("relay", "public"))
	var f := FileAccess.open(code_file, FileAccess.WRITE)
	f.store_string(lobby.code)
	f.close()
	var got := {"reliable": false, "fast": false}
	lobby.message_received.connect(func(from: int, bytes: PackedByteArray, ch: int) -> void:
		var text := bytes.get_string_from_utf8()
		print("host got '", text, "' from ", from, " on ", ch)
		if text == "hello-reliable":
			lobby.send(from, "hi-reliable".to_utf8_buffer(), OneLobbyWire.RELIABLE)
			got["reliable"] = true
		elif text == "hello-fast":
			lobby.send(from, "hi-fast".to_utf8_buffer(), OneLobbyWire.FAST)
			got["fast"] = true)
	lobby.peer_joined.connect(func(p: Dictionary) -> void: print("host sees join ", p["name"]))
	var renamed := [""]
	lobby.peer_renamed.connect(func(p: Dictionary, old: String) -> void:
		print("host sees rename ", old, " -> ", p["name"])
		renamed[0] = p["name"])
	while not (got["reliable"] and got["fast"] and renamed[0] == "Renamed"):
		await create_timer(0.1).timeout
	# let the replies leave, then go: the joiner must learn that the host left
	await create_timer(1.5).timeout
	await lobby.leave_and_flush()
	_done(true, "")


func _join(code_file: String) -> void:
	while not FileAccess.file_exists(code_file) or FileAccess.get_file_as_string(code_file).strip_edges() == "":
		await create_timer(0.1).timeout
	var code := FileAccess.get_file_as_string(code_file).strip_edges()
	var opts := {"relays": _relays(), "ice_servers": _turn("join")}
	var lobby := await _client.join_direct(code.to_lower(), opts)
	if lobby == null:
		_done(false, "join_direct failed: %s" % _client.last_error)
		return
	print("joined ", lobby.code, " as ", lobby.local_peer_id, " host ", lobby.host_peer_id)
	var got := {"reliable": false, "fast": false}
	lobby.message_received.connect(func(from: int, bytes: PackedByteArray, ch: int) -> void:
		var text := bytes.get_string_from_utf8()
		print("joiner got '", text, "' from ", from, " on ", ch)
		if text == "hi-reliable":
			got["reliable"] = true
		elif text == "hi-fast":
			got["fast"] = true)
	var ended := [""]
	lobby.session_ended.connect(func(reason: String) -> void: ended[0] = reason)
	if not lobby.is_ready:
		await lobby.ready
	var self_renamed := [""]
	lobby.peer_renamed.connect(func(p: Dictionary, _old: String) -> void:
		if int(p["peer_id"]) == lobby.local_peer_id:
			self_renamed[0] = p["name"])
	if not lobby.rename("Re\u202Enamed"):
		_done(false, "rename refused: no set_name feature")
		return
	lobby.send(lobby.host_peer_id, "hello-reliable".to_utf8_buffer(), OneLobbyWire.RELIABLE)
	# fast may drop: repeat until the reply is in
	while not (got["reliable"] and got["fast"]):
		lobby.send(lobby.host_peer_id, "hello-fast".to_utf8_buffer(), OneLobbyWire.FAST)
		await create_timer(0.2).timeout
	while self_renamed[0] == "":
		await create_timer(0.1).timeout
	if self_renamed[0] != "Renamed":
		_done(false, "joiner saw its own name as '%s'" % self_renamed[0])
		return
	print("joiner has both replies and its new name, waiting for the host to leave")
	while ended[0] == "":
		await create_timer(0.1).timeout
	_done(ended[0] == "host_left", "session_ended reason was '%s'" % ended[0])


func _done(ok: bool, why: String) -> void:
	print("direct e2e ok" if ok else "direct e2e FAIL: " + why)
	_client.queue_free()
	quit(0 if ok else 1)
