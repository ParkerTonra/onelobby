extends SceneTree
## One side of the two-instance test (headless-test.sh runs both): the host makes a lobby and writes its code to
## --code-file; the joiner waits for the file, finds it in list(), joins by code and sends "hello"; the host answers "hi back". Each side
## prints "e2e ok" and exits 0 once it has the other's message, or exits 1 after --timeout seconds (default 30).
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/e2e.gd -- \
##       --role=host|join --server=ws://127.0.0.1:8080/ws --code-file=/tmp/code.txt

var _args := {}
var _client: OneLobbyClient
var _deadline := 0


func _init() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--") and a.contains("="):
			_args[a.substr(2, a.find("=") - 2)] = a.get_slice("=", 1)
	_deadline = Time.get_ticks_msec() + int(_args.get("timeout", "30")) * 1000
	process_frame.connect(_watchdog)
	_run.call_deferred()


func _watchdog() -> void:
	if Time.get_ticks_msec() > _deadline:
		print("e2e FAIL: timed out (", _client.last_error if _client != null else {}, ")")
		quit(1)


func _run() -> void:
	_client = OneLobbyClient.new()
	_client.game_id = "e2e-gdscript"
	_client.lobby_server = _args.get("server", "ws://127.0.0.1:8080/ws")
	_client.display_name = _args.get("role", "host")
	root.add_child(_client)
	var code_file: String = _args.get("code-file", "")
	if _args.get("role", "host") == "host":
		var lobby := await _client.host({"name": "e2e", "visibility": "public"})
		if lobby == null:
			_done(false, "host failed: %s" % _client.last_error)
			return
		print("hosting ", OneLobbyJoinCode.display(lobby.code))
		var f := FileAccess.open(code_file, FileAccess.WRITE)
		f.store_string(lobby.code)
		f.close()
		lobby.message_received.connect(func(from: int, bytes: PackedByteArray, _ch: int) -> void:
			print("host got '", bytes.get_string_from_utf8(), "' from ", from)
			lobby.send(from, "hi back".to_utf8_buffer())
			# give the reliable channel a moment to flush before quitting
			create_timer(1.0).timeout.connect(func() -> void: _done(true, "")))
	else:
		while not FileAccess.file_exists(code_file) or FileAccess.get_file_as_string(code_file).strip_edges() == "":
			await create_timer(0.1).timeout
		var code := FileAccess.get_file_as_string(code_file).strip_edges()
		var listed := await _client.list()
		if not listed.any(func(s: Dictionary) -> bool: return s["code"] == code):
			_done(false, "lobby %s not in list() %s" % [code, listed])
			return
		print("joiner listed ", listed.size(), " lobby(s)")
		# join by the short display form, as a player would type it
		var lobby := await _client.join(OneLobbyJoinCode.display(code).to_lower())
		if lobby == null:
			_done(false, "join failed: %s" % _client.last_error)
			return
		lobby.message_received.connect(func(from: int, bytes: PackedByteArray, _ch: int) -> void:
			print("joiner got '", bytes.get_string_from_utf8(), "' from ", from)
			_done(bytes.get_string_from_utf8() == "hi back", "unexpected reply"))
		if not lobby.is_ready:
			await lobby.ready
		lobby.send(lobby.host_peer_id, "hello".to_utf8_buffer())


func _done(ok: bool, why: String) -> void:
	print("e2e ok" if ok else "e2e FAIL: " + why)
	_client.queue_free()
	quit(0 if ok else 1)
