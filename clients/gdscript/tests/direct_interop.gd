extends SceneTree
## The GDScript side of integration/nostr-interop-gdscript.mjs: the same exchange as integration/nostr-interop-peer.mjs
## (JS) and the .NET smoke peer, so the three clients can be paired in either direction.
##   host: hosts a Direct lobby, prints "join code <code>", echoes every message as "echo:<text>" on the channel it came
##         in on, and finishes when a peer says "bye".
##   join: joins <code>, sends "hello direct" (reliable) and "fast direct" (fast, repeated) and waits for the echoes,
##         then says "bye" and leaves.
## Prints PASS or FAIL and exits 0 or 1.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/direct_interop.gd -- \
##       --role=host|join [--code=CODE] [--relay=ws://127.0.0.1:PORT] [--stun=none]

var _args := {}
var _client: OneLobbyClient
var _deadline := 0


func _init() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--") and a.contains("="):
			_args[a.substr(2, a.find("=") - 2)] = a.get_slice("=", 1)
	_deadline = Time.get_ticks_msec() + int(_args.get("timeout", "60")) * 1000
	process_frame.connect(func() -> void:
		if Time.get_ticks_msec() > _deadline:
			_finish(false, "gave up"))
	_run.call_deferred()


func _opts() -> Dictionary:
	var o := {}
	if _args.has("relay"):
		o["relays"] = [_args["relay"]]
	if _args.get("stun", "") == "none":
		o["stun"] = []
	return o


func _run() -> void:
	_client = OneLobbyClient.new()
	_client.game_id = "com.onelobby.directsmoke"
	_client.net_version = "1"
	_client.display_name = "GD " + str(_args.get("role"))
	root.add_child(_client)
	if _args.get("role") == "host":
		await _host()
	else:
		await _join()


func _host() -> void:
	var o := _opts()
	o["max_players"] = 4
	var lobby := await _client.host_direct(o)
	if lobby == null:
		_finish(false, "host_direct: %s" % _client.last_error)
		return
	print("join code ", lobby.code, " (nostr)")
	var bye := [false]
	lobby.message_received.connect(func(from: int, bytes: PackedByteArray, ch: int) -> void:
		var text := bytes.get_string_from_utf8()
		print("got ", "fast" if ch == OneLobbyWire.FAST else "reliable", " ", from, " ", text)
		if text == "bye":
			bye[0] = true
		else:
			lobby.send(from, ("echo:" + text).to_utf8_buffer(), ch))
	while not bye[0]:
		await create_timer(0.1).timeout
	await create_timer(0.3).timeout
	await lobby.leave_and_flush()
	_finish(true, "host")


func _join() -> void:
	var lobby := await _client.join_direct(str(_args.get("code", "")), _opts())
	if lobby == null:
		_finish(false, "join_direct: %s" % _client.last_error)
		return
	if not lobby.is_ready:
		await lobby.ready
	print("ready, host ", lobby.host_peer_id)
	var got := {"reliable": false, "fast": false}
	lobby.message_received.connect(func(_from: int, bytes: PackedByteArray, ch: int) -> void:
		var text := bytes.get_string_from_utf8()
		print("got ", "fast" if ch == OneLobbyWire.FAST else "reliable", " ", text)
		if text == "echo:hello direct" and ch == OneLobbyWire.RELIABLE:
			got["reliable"] = true
		if text == "echo:fast direct" and ch == OneLobbyWire.FAST:
			got["fast"] = true)
	lobby.send(lobby.host_peer_id, "hello direct".to_utf8_buffer(), OneLobbyWire.RELIABLE)
	for _i in 100:
		if got["reliable"] and got["fast"]:
			break
		if not got["fast"]:
			lobby.send(lobby.host_peer_id, "fast direct".to_utf8_buffer(), OneLobbyWire.FAST)
		await create_timer(0.1).timeout
	lobby.send(lobby.host_peer_id, "bye".to_utf8_buffer(), OneLobbyWire.RELIABLE)
	await create_timer(0.5).timeout
	await lobby.leave_and_flush()
	_finish(got["reliable"] and got["fast"], "reliable=%s fast=%s" % [got["reliable"], got["fast"]])


func _finish(ok: bool, why: String) -> void:
	print("PASS " + why if ok else "FAIL " + why)
	quit(0 if ok else 1)
