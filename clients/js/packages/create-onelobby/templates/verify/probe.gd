extends SceneTree
## Written by `create-onelobby verify` to .onelobby/verify/probe.gd and run headless against the game's own onelobby.json and add-on.
## One route per run; two clients in this one process (a host and a guest), loopback only, nothing leaves this machine:
##   config   load res://onelobby.json through OneLobbyClient.from_config and print the facts verify needs
##   direct   host_direct (no Nostr) and join_direct by its IP code
##   nostr    host_direct with a Nostr code through --relay=ws://127.0.0.1:<port> (a local relay verify started)
##   turn     like nostr (or direct when no --relay) but relay-only through the TURN login in --turn="turn:127.0.0.1:<port> <user> <pass>"
##   server   host() and join(code) on the lobby server --server=ws://127.0.0.1:<port>/ws
## Each ends with one line, VERIFY_PROBE_OK <route> ... (exit 0) or VERIFY_PROBE_FAIL <route> <why> (exit 1): both peers linked and
## sent each other one message. Run: godot --headless --audio-driver Dummy --path <game> -s res://.onelobby/verify/probe.gd -- --route=...

var _a := {}
var _route := ""
var _done := false


func _init() -> void:
	for x in OS.get_cmdline_user_args():
		if x.begins_with("--"):
			var eq := x.find("=")
			if eq < 0:
				_a[x.substr(2)] = "1"
			else:
				_a[x.substr(2, eq - 2)] = x.substr(eq + 1)
	_route = str(_a.get("route", "direct"))
	var limit_ms := int(_a.get("timeout", "60")) * 1000
	process_frame.connect(func() -> void:
		if Time.get_ticks_msec() > limit_ms:
			_finish(false, "timed out after %d s" % (limit_ms / 1000)))
	_run.call_deferred()


func _finish(ok: bool, what: String) -> void:
	if _done:
		return
	_done = true
	print(("VERIFY_PROBE_OK " if ok else "VERIFY_PROBE_FAIL ") + _route + " " + what)
	quit(0 if ok else 1)


func _client(display_name: String) -> OneLobbyClient:
	var overrides := {"display_name": display_name}
	if _route == "server":
		overrides["lobby_server"] = str(_a.get("server", ""))
	var c := OneLobbyClient.from_config("res://onelobby.json", overrides)
	c.store = OneLobbyStore.memory() # two clients in one process must not share a player id, and nothing goes to user://
	root.add_child(c) # pumps itself every frame
	return c


func _until(cond: Callable, ms: int = 20000) -> bool:
	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < ms:
		await process_frame
		if cond.call():
			return true
	return cond.call()


func _run() -> void:
	var host := _client("Host")
	if not host.config_error.is_empty():
		var e: Dictionary = host.config_error
		return _finish(false, "onelobby.json: %s (path %s, rule %s)" % [e.get("message", ""), e.get("path", ""), e.get("rule", "")])
	if _route == "config":
		var h: Dictionary = host.config.hosting
		return _finish(true, "sync=%s direct=%s nostr=%s server=%s relay_only=%s" % [host.config.sync["mode"], h["direct"], h["nostr"], h["server"], h["relay_only"]])
	var guest := _client("Guest")
	var ice: Array = []
	if _route == "turn":
		var r := OneLobbyTurn.parse_line(str(_a.get("turn", "")))
		if not r.ok:
			return _finish(false, "the TURN line did not parse: " + str(r.error))
		ice = [r.server]
		host.relay_only = true
		guest.relay_only = true
	var relay := str(_a.get("relay", ""))
	var hl: OneLobbyLobby
	var gl: OneLobbyLobby
	if _route == "server":
		hl = await host.host({"name": "verify", "max_players": 2})
		if hl == null:
			return _finish(false, "host: " + str(host.last_error))
		gl = await guest.join(hl.code)
	else:
		var o := {"max_players": 2, "tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1", "stun": [], "ice_servers": ice, "nostr": false}
		var jo := {"timeout_ms": 30000, "ice_servers": ice}
		if relay != "":
			o["nostr"] = true
			o["relays"] = [relay]
			jo["relays"] = [relay]
		hl = await host.host_direct(o)
		if hl == null:
			return _finish(false, "host: " + str(host.last_error))
		gl = await guest.join_direct(hl.code, jo)
	if gl == null:
		return _finish(false, "join: " + str(guest.last_error))
	var at_host := []
	var at_guest := []
	hl.message_received.connect(func(from: int, bytes: PackedByteArray, _ch: int) -> void: at_host.append([from, bytes.get_string_from_utf8()]))
	gl.message_received.connect(func(from: int, bytes: PackedByteArray, _ch: int) -> void: at_guest.append([from, bytes.get_string_from_utf8()]))
	if not await _until(func() -> bool: return hl.is_peer_ready(gl.local_peer_id) and gl.is_ready):
		return _finish(false, "the two peers never linked")
	hl.send(gl.local_peer_id, "hello guest".to_utf8_buffer())
	gl.send(hl.local_peer_id, "hello host".to_utf8_buffer())
	if not await _until(func() -> bool: return not at_host.is_empty() and not at_guest.is_empty()):
		return _finish(false, "messages did not arrive (host got %d, guest got %d)" % [at_host.size(), at_guest.size()])
	if at_host[0] != [gl.local_peer_id, "hello host"] or at_guest[0] != [hl.local_peer_id, "hello guest"]:
		return _finish(false, "wrong message: host got %s, guest got %s" % [at_host[0], at_guest[0]])
	gl.leave()
	hl.leave()
	await process_frame
	_finish(true, "code=%s" % hl.code)
