extends SceneTree
## The diagnostics plan's "done when", with real WebRTC in Godot, all on 127.0.0.1 (no Nostr, no internet): a joiner behind a
## simulated strict NAT (every candidate it receives is dropped before it reaches ICE) gets nat_blocked on its own side
## within the ready timeout; the host gets the same sentence and the line "Sam: strict NAT, no relay set, stopped at the
## connection check after N s."; the exported log names the cause and holds no IPv4 address when masked. Then a relay that
## rejects the login (relay_refused) and one that never answers (relay_unreachable), and the two cases that send nothing
## (report_to_host off, a hub without the "diag" feature).
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/diag_loopback.gd
## Exit 0 and "diag loopback ok" on success.

const Fakes := preload("res://tests/diagnostics.gd")

var _fails := 0
var _servers: Array = []


func _check(ok: bool, what: String) -> void:
	if not ok:
		_fails += 1
		print("FAIL: ", what)


## A transport whose links never hear a remote candidate: an ICE that can never find a pair.
class StrictNatTransport:
	extends OneLobbyGodotTransport

	func create_link(opts: Dictionary) -> OneLobbyTransport.OLLink:
		var l := StrictLink.new(opts, _range_links(opts))
		_links.append(l)
		return l


class StrictLink:
	extends OneLobbyGodotTransport.OLRtcLink

	func apply_signal(sig: Dictionary) -> void:
		if not sig.has("sdp"):
			return # a trickled candidate: dropped
		var lines: PackedStringArray = []
		for l in str(sig["sdp"]).split("\n"):
			if not l.begins_with("a=candidate:") and not l.begins_with("a=end-of-candidates"):
				lines.append(l)
		super.apply_signal({"type": sig["type"], "sdp": "\n".join(lines)})


func _init() -> void:
	process_frame.connect(func() -> void:
		for s in _servers:
			s.poll()
		if Time.get_ticks_msec() > 150000:
			print("diag loopback FAIL: timed out")
			quit(1))
	_run.call_deferred()


func _client(name: String) -> OneLobbyClient:
	var c := OneLobbyClient.new()
	c.game_id = "diag-loopback"
	c.display_name = name
	c.log_path = "" # keep tests off the user folder
	root.add_child(c)
	return c


## A host on 127.0.0.1 and a joiner "Sam" behind a strict NAT. `joiner_opts` go to join_direct (ice_servers: a relay).
func _scene(joiner_opts: Dictionary, report := true) -> Dictionary:
	var host := _client("host")
	host.transport = StrictNatTransport.new() # both ends hear no candidate, as in the JS test
	var lh: OneLobbyLobby = await host.host_direct({"nostr": false, "tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1", "max_players": 4})
	var got := []
	if lh != null:
		lh.peer_diagnosis.connect(func(info: Dictionary) -> void: got.append(info))
	var j := _client("Sam")
	j.transport = StrictNatTransport.new()
	j.ready_timeout_ms = 6000
	j.report_to_host = report
	var ended := []
	var port := int(OneLobbyJoinCode.decode_dc1(lh.ip_code).get("port", 0)) if lh != null else 0
	var jl: OneLobbyLobby = await j.join_direct("127.0.0.1:%d" % port, joiner_opts.merged({"timeout_ms": 15000}, true))
	if jl != null:
		jl.session_ended.connect(func(r: String) -> void: ended.append(r))
	return {"host": host, "lobby_host": lh, "joiner": j, "lobby_joiner": jl, "reports": got, "ended": ended}


func _wait(cond: Callable, frames := 3000) -> bool:
	for i in frames:
		if cond.call():
			return true
		await process_frame
	return cond.call()


func _finish(s: Dictionary) -> void:
	if s["lobby_joiner"] != null and not s["lobby_joiner"].is_closed():
		s["lobby_joiner"].leave()
	if s["lobby_host"] != null:
		s["lobby_host"].leave()
	await process_frame
	for k: String in ["host", "joiner"]:
		s[k].queue_free()


func _run() -> void:
	var ipv4 := RegEx.create_from_string("\\b[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\b")

	# ---- strict NAT, no relay: nat_blocked on both sides
	var s := await _scene({})
	if s["lobby_host"] == null or s["lobby_joiner"] == null:
		print("diag loopback FAIL: could not set up the scene: ", s["host"].last_error, s["joiner"].last_error)
		quit(1)
		return
	await _wait(func() -> bool: return not s["ended"].is_empty() and not s["reports"].is_empty())
	var err: Dictionary = s["joiner"].last_error
	_check(err.get("code", "") == "ice_failed", "the joiner's error code is still ice_failed: %s" % [err])
	var dx: Dictionary = err.get("diagnosis", {})
	_check(dx.get("cause", "") == "nat_blocked" and dx.get("stage", "") == "ice", "the joiner sees nat_blocked at the connection check: %s" % [dx])
	var friendly := OneLobbyFriendly.describe_error(err)
	_check(friendly.get("cause", "") == "nat_blocked" and friendly.get("stage", "") == "ice" and friendly["message"] == dx.get("message", "x"), "describe_error returns cause and stage")
	_check(s["reports"].size() == 1, "the host got one report (%d)" % s["reports"].size())
	if s["reports"].size() == 1:
		var r: Dictionary = s["reports"][0]
		_check(r["name"] == "Sam" and r["cause"] == "nat_blocked" and r["message"] == dx.get("message", "x"), "the host gets the same sentence: %s" % [r])
		var re := RegEx.create_from_string("^Sam: strict NAT, no relay set, stopped at the connection check after [0-9]+ s\\.$")
		_check(re.search(str(r["line"])) != null, "the host line: " + str(r["line"]))
	var log: String = s["joiner"].get_net_log().export()
	_check(log.contains("nat_blocked") and ipv4.search(log) == null, "the masked log names the cause and holds no IPv4 address")
	_check(ipv4.search(s["joiner"].get_net_log().export(true)) != null, "the log with addresses does have them")
	await _finish(s)

	# ---- report_to_host off: the joiner still sees why, the host hears nothing
	s = await _scene({}, false)
	await _wait(func() -> bool: return not s["ended"].is_empty())
	await _wait(func() -> bool: return false, 90)
	_check(s["joiner"].last_error.get("diagnosis", {}).get("cause", "") == "nat_blocked", "report_to_host off: the joiner still sees why")
	_check(s["reports"].is_empty() and not s["joiner"].get_net_log().export().contains("report sent"), "report_to_host off sends nothing")
	await _finish(s)

	# ---- a hub without the "diag" feature: nothing is sent either
	s = await _scene({})
	s["joiner"].features = []
	await _wait(func() -> bool: return not s["ended"].is_empty())
	await _wait(func() -> bool: return false, 90)
	_check(s["reports"].is_empty() and not s["joiner"].get_net_log().export().contains("report sent"), "a hub without diag gets no report")
	await _finish(s)

	# ---- relays: a rejected login and silence
	var bad: Variant = Fakes.OLFake.new("turn_refuse")
	var mute: Variant = Fakes.OLFake.new("silent")
	_servers.append(bad)
	_servers.append(mute)
	for case: Array in [[bad, "relay_refused", "Sam: the relay rejected the login, stopped at the connection check after "], [mute, "relay_unreachable", "Sam: the relay did not answer, stopped at the connection check after "]]:
		var turn := {"urls": ["turn:127.0.0.1:%d" % case[0].port], "username": "sam", "credential": "secret"}
		s = await _scene({"ice_servers": [turn]})
		await _wait(func() -> bool: return not s["ended"].is_empty() and not s["reports"].is_empty())
		var dxr: Dictionary = s["joiner"].last_error.get("diagnosis", {})
		_check(dxr.get("cause", "") == case[1], "%s: the joiner sees it: %s" % [case[1], s["joiner"].last_error])
		_check(s["reports"].size() == 1 and str(s["reports"][0]["line"]).begins_with(case[2]) and s["reports"][0]["relaySet"] == true, "%s: the host's line: %s" % [case[1], s["reports"]])
		_check(not s["joiner"].get_net_log().export(true).contains("secret"), "the relay password is never in the log")
		await _finish(s)

	print("diag loopback ", "ok" if _fails == 0 else "FAILED (%d)" % _fails)
	quit(0 if _fails == 0 else 1)
