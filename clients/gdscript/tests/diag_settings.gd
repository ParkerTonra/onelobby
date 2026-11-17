extends SceneTree
## spec/settings.md s.4 "never logged": with a relay line saved in the settings and a lobby server address holding user:pass@
## and ?token=, after a join attempt the exported net log (masked or with addresses) holds none of the login, the relay user
## or its credential.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/diag_settings.gd

var _fails := 0


func _check(ok: bool, what: String) -> void:
	if not ok:
		_fails += 1
		print("FAIL: ", what)


func _init() -> void:
	_run.call_deferred()


func _run() -> void:
	var c := OneLobbyClient.new()
	c.game_id = "diag-settings"
	c.log_path = ""
	c.store = OneLobbyStore.memory()
	c.settings_env = {}
	c.lobby_server = "ws://alice:pass@127.0.0.1:1/ws?token=abc"
	root.add_child(c)
	var saved := c.settings.save({"relay": "turn:127.0.0.1:3478 alice s3cret"})
	_check((saved.get("rejected", []) as Array).is_empty(), "the relay line saves: %s" % [saved])
	var l: OneLobbyLobby = await c.join("7HQ 4K2")
	_check(l == null, "nobody listens at the server address")
	for text: String in [c.get_net_log().export(), c.get_net_log().export(true)]:
		for secret: String in ["alice", "s3cret", "pass", "abc"]:
			_check(not text.contains(secret), "the net log holds no '%s'" % secret)
	_check(c.get_net_log().export().contains("open route=server"), "the attempt is logged")
	c.queue_free()
	await process_frame
	print("diag settings ", "ok" if _fails == 0 else "FAILED (%d)" % _fails)
	quit(0 if _fails == 0 else 1)
