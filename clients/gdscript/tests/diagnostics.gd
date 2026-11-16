extends SceneTree
## Diagnostics against the shared vectors (spec/vectors/diagnostics.json: causes, stage text, diagnose, host line, explain,
## mask, export and ring, report valid / invalid, check verdicts, NAT classification, STUN bytes), then the connection check
## and the relay probe against fake STUN and TURN servers on 127.0.0.1 (never all interfaces: no firewall prompt).
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/diagnostics.gd
## Prints "diagnostics: N passed, M failed"; exits 1 on any failure.

var _pass := 0
var _fail := 0
var _servers: Array = []


func _check(ok: bool, what: String) -> void:
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL: ", what)


func _init() -> void:
	process_frame.connect(_poll_servers)
	_run.call_deferred()


func _run() -> void:
	var spec := ProjectSettings.globalize_path("res://").path_join("../../spec").simplify_path()
	var v: Variant = JSON.parse_string(FileAccess.get_file_as_string(spec.path_join("vectors/diagnostics.json")))
	if not v is Dictionary:
		print("FAIL: could not read vectors/diagnostics.json")
		quit(1)
		return
	_causes(v)
	_diagnose(v)
	_text(v)
	_mask(v)
	_log(v)
	_report(v)
	_check_vectors(v)
	_stun(v)
	_netlog_extras()
	await _sockets()
	await _names()
	print("diagnostics: %d passed, %d failed" % [_pass, _fail])
	quit(1 if _fail > 0 else 0)


func _causes(v: Dictionary) -> void:
	for c: Dictionary in v["causes"]:
		var e := OneLobbyDiagnose.explain_cause(c["code"], {"mine": "{mine}", "theirs": "{theirs}", "stage": "ice", "elapsedMs": 0})
		var want: String = str(c["message"]).replace("{stage_text}", OneLobbyDiagnose.stage_text("ice")).replace("{elapsed}", OneLobbyDiagnose.elapsed_text(0))
		_check(e["message"] == want and e["hint"] == c["hint"] and e["hostHint"] == c["hostHint"] and e["short"] == c["short"], "cause text " + c["code"])
	for k: String in v["stageText"]:
		_check(OneLobbyDiagnose.stage_text(k) == v["stageText"][k], "stage text " + k)
	for k: String in v["stageOf"]:
		_check(OneLobbyDiagnose.stage_of(k) == v["stageOf"][k], "stage of " + k)


func _diagnose(v: Dictionary) -> void:
	var n := 0
	for c: Dictionary in v["diagnose"]:
		var d := OneLobbyDiagnose.diagnose(c["facts"])
		var x: Dictionary = c["expect"]
		_check(d["cause"] == x["cause"] and d["message"] == x["message"] and d["hint"] == x["hint"] and d["stage"] == x["stage"],
			"diagnose %s: got %s" % [c["name"], JSON.stringify(d)])
		n += 1
	_check(n == 28, "28 diagnose cases (%d)" % n)


func _text(v: Dictionary) -> void:
	for c: Dictionary in v["hostLine"]:
		var i: Dictionary = c["input"]
		_check(OneLobbyDiagnose.host_line(i["name"], i["cause"], i["stage"], i["elapsedMs"]) == c["expect"], "host line " + str(i["name"]))
	for c: Dictionary in v["explain"]:
		var e := OneLobbyDiagnose.explain_cause(c["input"]["cause"], c["input"])
		var x: Dictionary = c["expect"]
		_check(e["message"] == x["message"] and e["hint"] == x["hint"] and e["hostHint"] == x["hostHint"], "explain " + JSON.stringify(c["input"]))


func _mask(v: Dictionary) -> void:
	for c: Dictionary in v["mask"]:
		_check(OneLobbyNetLog.mask(c["input"], false) == c["masked"], "mask %s: got %s" % [c["name"], OneLobbyNetLog.mask(c["input"], false)])
		_check(OneLobbyNetLog.mask(c["input"], true) == c["included"], "mask (addresses included) " + c["name"])


func _log(v: Dictionary) -> void:
	var ex: Dictionary = v["export"]
	var now := [0]
	var log := OneLobbyNetLog.new(10, func() -> int: return now[0], true)
	var m: Dictionary = ex["meta"]
	log.set_meta_info(m["client"], m["protocol"], m["platform"])
	for e: Dictionary in ex["entries"]:
		now[0] = int(e["t"])
		log.add(e["kind"], e["text"], e.get("addr", ""), e.get("code", ""))
	_check(log.export() == ex["masked"], "export, masked: " + log.export())
	_check(log.export(true) == ex["included"], "export, with addresses: " + log.export(true))
	var r: Dictionary = v["ring"]
	var ring := OneLobbyNetLog.new(int(r["capacity"]))
	for i in range(1, int(r["add"]["count"]) + 1):
		ring.add(r["add"]["kind"], str(r["add"]["text"]).replace("{i}", str(i)))
	var x: Dictionary = r["expect"]
	_check(ring.entries.size() == int(x["kept"]) and ring.dropped() == int(x["dropped"]), "ring keeps %d drops %d" % [ring.entries.size(), ring.dropped()])
	_check(int(ring.entries[0]["seq"]) == int(x["firstSeq"]) and int(ring.entries[-1]["seq"]) == int(x["lastSeq"]), "ring first and last seq")
	_check(ring.export().split("\n")[2] == x["headerEntries"], "ring header line")


func _report(v: Dictionary) -> void:
	for c: Dictionary in v["report"]["valid"]:
		var got := OneLobbyDiagnose.clean_report(c["input"])
		_check(not got.is_empty() and _same(got, c["output"]), "report valid %s: got %s" % [c["name"], JSON.stringify(got)])
	for c: Dictionary in v["report"]["invalid"]:
		_check(OneLobbyDiagnose.clean_report(c["input"]).is_empty(), "report invalid " + c["name"])


## Deep equality, key order included; numbers compare by value (JSON gives floats, the client makes ints).
func _same(a: Variant, b: Variant) -> bool:
	if a is Dictionary and b is Dictionary:
		if (a as Dictionary).keys() != (b as Dictionary).keys():
			return false
		for k: Variant in a:
			if not _same(a[k], b[k]):
				return false
		return true
	if a is Array and b is Array:
		if (a as Array).size() != (b as Array).size():
			return false
		for i in (a as Array).size():
			if not _same(a[i], b[i]):
				return false
		return true
	return a == b


func _check_vectors(v: Dictionary) -> void:
	for c: Dictionary in v["check"]["verdict"]:
		var r := OneLobbyDiagnose.check_verdict(c["input"])
		_check(r["verdict"] == c["verdict"] and r["message"] == c["message"], "check verdict " + c["name"])
	for c: Dictionary in v["check"]["classify"]:
		var r := OneLobbyDiagnose.classify_nat(int(c["asked"]), c["answers"], c["local"])
		_check(r["udp"] == c["expect"]["udp"] and r["natType"] == c["expect"]["natType"], "classify " + c["name"])


func _stun(v: Dictionary) -> void:
	var st: Dictionary = v["stun"]
	var tid := _hex(st["request"]["transactionId"])
	_check(OneLobbyConnectionCheck.binding_request(tid).hex_encode() == st["request"]["bytes"], "STUN request bytes")
	for r: Dictionary in st["responses"]:
		var got: Variant = OneLobbyConnectionCheck.parse_binding_response(_hex(r["bytes"]), _hex(r["transactionId"]))
		if r["expect"] == null:
			_check(got == null, "STUN response " + r["name"])
		else:
			_check(got != null and got["ip"] == r["expect"]["ip"] and int(got["port"]) == int(r["expect"]["port"]), "STUN response " + r["name"])
	var made := OneLobbyConnectionCheck.binding_response(tid, "192.0.2.1", 32853)
	_check(made.hex_encode() == st["responses"][0]["bytes"], "STUN response builder round trip")


func _hex(s: String) -> PackedByteArray:
	return s.hex_decode()


func _netlog_extras() -> void:
	var log := OneLobbyNetLog.new()
	log.add("sig", "open", "wss://sam:hunter2@198.51.100.2:8080/ws?token=abc123")
	var text := log.export(true)
	_check(not text.contains("hunter2") and not text.contains("abc123") and text.contains("198.51.100.2:8080"), "an included addr never shows a credential")
	var small := OneLobbyNetLog.new(5)
	for i in 60:
		small.add("info", "x")
	_check(small.entries.size() == 50, "capacity is clamped up to 50")
	small.add("info", "x".repeat(300))
	_check(str(small.entries[-1]["text"]).length() == 200, "entry text is cut at 200")
	var path := "user://diag-test/log.txt"
	var saved := OneLobbyNetLog.new()
	saved.path = path
	saved.add("info", "hello")
	saved.add("error", "ice_failed", "", "ice_failed") # an error entry saves the log
	_check(FileAccess.file_exists(path) and FileAccess.get_file_as_string(path).contains("error ice_failed"), "an error entry saves the log")
	DirAccess.remove_absolute(path)
	# one file per copy, written as it goes: the requested path wins, then the environment; none asked means none
	_check(OneLobbyNetLog.requested_path({}, PackedStringArray()) == "", "no --netlog and no variable asks for nothing (negative control)")
	_check(OneLobbyNetLog.requested_path({"ONELOBBY_NETLOG": "user://env.txt"}, PackedStringArray()) == "user://env.txt", "ONELOBBY_NETLOG names the file")
	_check(OneLobbyNetLog.requested_path({"ONELOBBY_NETLOG": "user://env.txt"}, PackedStringArray(["--netlog=user://arg.txt"])) == "user://arg.txt", "--netlog= beats the variable")
	_check(OneLobbyNetLog.requested_path({}, PackedStringArray(["--netlog="])) == "", "an empty --netlog= asks for nothing")
	var live_path := "user://diag-test/live.txt"
	var lv := OneLobbyNetLog.new()
	lv.path = live_path
	lv.live = true
	lv.add("info", "first")
	lv.add("info", "second") # no error entry, no save(), no exit: the file already has both
	var live_text := FileAccess.get_file_as_string(live_path)
	_check(live_text.begins_with("# onelobby netlog v1") and live_text.contains("info first") and live_text.contains("info second"), "a live log is on disk after each entry, with no exit")
	var quiet := OneLobbyNetLog.new()
	var quiet_path := "user://diag-test/quiet.txt"
	quiet.path = quiet_path
	quiet.add("info", "only in memory")
	_check(not FileAccess.file_exists(quiet_path), "without live, an info entry writes nothing until exit or error (negative control)")
	DirAccess.remove_absolute(live_path)
	_check(OneLobbyConnectionCheck.all_loopback([{"host": "127.0.0.1"}, {"host": "localhost"}]), "loopback targets")
	_check(not OneLobbyConnectionCheck.all_loopback([{"host": "127.0.0.1"}, {"host": "203.0.113.9"}]), "a public target is not loopback")


# ---- fake servers on 127.0.0.1 -------------------------------------------------------------------------------------

class OLFake:
	extends RefCounted
	var udp := PacketPeerUDP.new()
	var port := 0
	var mode := ""
	var ip := ""
	var map_port := 0

	func _init(m: String, mapped_ip := "", mapped_port := 0) -> void:
		mode = m
		ip = mapped_ip
		map_port = mapped_port
		udp.bind(0, "127.0.0.1")
		port = udp.get_local_port()

	func poll() -> void:
		while udp.get_available_packet_count() > 0:
			var b := udp.get_packet()
			var from_ip := udp.get_packet_ip()
			var from_port := udp.get_packet_port()
			var reply := _answer(b, from_ip, from_port)
			if reply.size() > 0:
				udp.set_dest_address(from_ip, from_port)
				udp.put_packet(reply)

	func _answer(b: PackedByteArray, from_ip: String, from_port: int) -> PackedByteArray:
		var tid := b.slice(8, 20)
		var type := (b[0] << 8) | b[1]
		match mode:
			"stun":
				if type == 0x0001:
					return OneLobbyConnectionCheck.binding_response(tid, ip if ip != "" else from_ip, map_port if map_port != 0 else from_port)
			"turn_ok", "turn_refuse":
				if type == 0x0003:
					var authed := b.hex_encode().contains("test.realm".to_utf8_buffer().hex_encode())
					if not authed or mode == "turn_refuse":
						return _error(tid, 401)
					var ok := PackedByteArray([0x01, 0x03, 0, 0, 0x21, 0x12, 0xa4, 0x42])
					ok.append_array(tid)
					return ok
		return PackedByteArray() # "silent", or a message it does not know

	func _error(tid: PackedByteArray, code: int) -> PackedByteArray:
		var body := PackedByteArray([0x00, 0x09, 0x00, 0x08, 0, 0, code / 100, code % 100, 120, 120, 120, 120])
		var realm := "test.realm".to_utf8_buffer()
		body.append_array(PackedByteArray([0x00, 0x14, 0x00, realm.size()]))
		body.append_array(realm)
		while body.size() % 4 != 0:
			body.append(0)
		var nonce := "nonce-1234567890".to_utf8_buffer()
		body.append_array(PackedByteArray([0x00, 0x15, 0x00, nonce.size()]))
		body.append_array(nonce)
		while body.size() % 4 != 0:
			body.append(0)
		var out := PackedByteArray([0x01, 0x13, (body.size() >> 8) & 0xff, body.size() & 0xff, 0x21, 0x12, 0xa4, 0x42])
		out.append_array(tid)
		out.append_array(body)
		return out


func _fake(mode: String, ip := "", port := 0) -> OLFake:
	var f := OLFake.new(mode, ip, port)
	_servers.append(f)
	return f


func _poll_servers() -> void:
	for s: OLFake in _servers:
		s.poll()


func _stun_opts(servers: Array, turn: Dictionary = {}) -> Dictionary:
	var urls: Array = []
	for s: OLFake in servers:
		urls.append("stun:127.0.0.1:%d" % s.port)
	var o := {"stun": urls, "server_timeout_ms": 450, "timeout_ms": 4000}
	if not turn.is_empty():
		o["ice_servers"] = [turn]
	return o


func _turn_entry(f: OLFake) -> Dictionary:
	return {"urls": ["turn:127.0.0.1:%d" % f.port], "username": "sam", "credential": "secret"}


func _sockets() -> void:
	var cone_a := _fake("stun", "203.0.113.9", 40000)
	var cone_b := _fake("stun", "203.0.113.9", 40000)
	var sym_b := _fake("stun", "203.0.113.9", 40001)
	var open_a := _fake("stun")
	var open_b := _fake("stun")
	var mute := _fake("silent")
	var mute2 := _fake("silent")
	var turn_ok := _fake("turn_ok")
	var turn_bad := _fake("turn_refuse")
	var r: Dictionary = await OneLobbyConnectionCheck.check(self, _stun_opts([cone_a, cone_b]))
	_check(r["udp"] == "ok" and r["natType"] == "cone" and r["relay"] == "none" and r["verdict"] == "good", "check: same mapping is cone, " + JSON.stringify(r))
	r = await OneLobbyConnectionCheck.check(self, _stun_opts([cone_a, sym_b]))
	_check(r["natType"] == "symmetric" and r["verdict"] == "likely_fail", "check: different ports are symmetric, " + JSON.stringify(r))
	r = await OneLobbyConnectionCheck.check(self, _stun_opts([open_a, open_b]))
	_check(r["udp"] == "ok" and r["natType"] == "open", "check: an address equal to the socket's own is open, " + JSON.stringify(r))
	r = await OneLobbyConnectionCheck.check(self, _stun_opts([cone_a, mute]))
	_check(r["udp"] == "ok" and r["natType"] == "unknown" and r["verdict"] == "unknown", "check: one answer says UDP works only, " + JSON.stringify(r))
	r = await OneLobbyConnectionCheck.check(self, _stun_opts([mute, mute2]))
	_check(r["udp"] == "blocked" and r["verdict"] == "blocked", "check: no answer is UDP blocked, " + JSON.stringify(r))
	r = await OneLobbyConnectionCheck.check(self, _stun_opts([cone_a, cone_b], _turn_entry(turn_ok)))
	_check(r["relay"] == "ok", "check: relay login ok, " + JSON.stringify(r))
	r = await OneLobbyConnectionCheck.check(self, _stun_opts([cone_a, cone_b], _turn_entry(turn_bad)))
	_check(r["relay"] == "refused" and r["verdict"] == "relay_refused", "check: relay login refused, " + JSON.stringify(r))
	r = await OneLobbyConnectionCheck.check(self, _stun_opts([cone_a, cone_b], _turn_entry(mute)))
	_check(r["relay"] == "unreachable" and r["verdict"] == "relay_unreachable", "check: relay silent, " + JSON.stringify(r))
	_check(await OneLobbyConnectionCheck.probe_relay(self, _turn_entry(turn_bad), 400) == "refused", "probe: refused")
	_check(await OneLobbyConnectionCheck.probe_relay(self, _turn_entry(mute2), 400) == "unreachable", "probe: unreachable")
	_check(await OneLobbyConnectionCheck.probe_relay(self, _turn_entry(turn_ok), 400) == "ok", "probe: ok")
	_check(await OneLobbyConnectionCheck.probe_relay(self, {"urls": ["turns:127.0.0.1:5349"], "username": "a", "credential": "b"}, 400) == "unknown", "probe: turns: is unknown")


## A resolver the test controls: a name table (addresses in the order the system would give them), an optional delay,
## or "never" (a lookup that stays pending). Counts what it was asked.
class FakeResolver:
	extends OneLobbyConnectionCheck.OLResolver
	var table := {}
	var delay_ms := 0
	var never := false
	var begun: Array = []
	var cancelled := 0
	var _started := {}

	func begin(host: String) -> int:
		begun.append(host)
		_started[begun.size()] = [host, Time.get_ticks_msec()]
		return begun.size()

	func poll(ticket: int) -> Variant:
		if never or Time.get_ticks_msec() - int(_started[ticket][1]) < delay_ms:
			return null
		return PackedStringArray(table.get(_started[ticket][0], []))

	func cancel(_ticket: int) -> void:
		cancelled += 1


## Names, no network: a fake STUN on 127.0.0.1 and a resolver that says "IPv6 first, IPv4 second" for every name.
func _names() -> void:
	var stun_a := _fake("stun", "203.0.113.9", 40000)
	var stun_b := _fake("stun", "203.0.113.9", 40000)
	var opts := {"stun": ["stun:one.test:%d" % stun_a.port, "stun:two.test:%d" % stun_b.port], "server_timeout_ms": 450, "timeout_ms": 4000, "bind_address": "127.0.0.1"}
	var v6_first := ["2001:db8::53", "127.0.0.1"] # a documentation IPv6 address nothing answers on, then the IPv4 one that does
	_check(OneLobbyConnectionCheck.pick_address(PackedStringArray(v6_first)) == "127.0.0.1", "pick_address: IPv4 before IPv6")
	_check(OneLobbyConnectionCheck.pick_address(PackedStringArray(["2001:db8::53"])) == "2001:db8::53", "pick_address: IPv6 only falls back to IPv6")
	_check(OneLobbyConnectionCheck.pick_address(PackedStringArray()) == "", "pick_address: nothing")

	# a name that answers IPv6 first and IPv4 second: asked over IPv4, so the answer comes
	var res := FakeResolver.new()
	res.table = {"one.test": v6_first, "two.test": v6_first}
	var o := opts.duplicate()
	o["resolver"] = res
	var t0 := Time.get_ticks_msec()
	var r: Dictionary = await OneLobbyConnectionCheck.check(self, o)
	_check(r["udp"] == "ok" and r["natType"] == "cone" and r["verdict"] == "good", "names: IPv6 first, IPv4 second still gets the answer, " + JSON.stringify(r))
	_check(Time.get_ticks_msec() - t0 < 900, "names: the answer comes at once, not after the per-server limit")
	_check(res.begun == ["one.test", "two.test"] and res.cancelled == 2, "names: each name looked up once, tickets released, " + str(res.begun))

	# a name with no IPv4 address is asked over IPv6 (nothing answers on this fake address): no answer, no hang
	res = FakeResolver.new()
	res.table = {"one.test": ["2001:db8::53"], "two.test": ["2001:db8::54"]}
	o["resolver"] = res
	t0 = Time.get_ticks_msec()
	r = await OneLobbyConnectionCheck.check(self, o)
	_check(r["udp"] == "blocked" and Time.get_ticks_msec() - t0 < 1500, "names: IPv6-only names fall back to IPv6 and end in no answer within the limits, " + JSON.stringify(r))

	# a slow lookup is polled, not waited on: frames keep coming, and the answer still arrives
	res = FakeResolver.new()
	res.table = {"one.test": v6_first, "two.test": v6_first}
	res.delay_ms = 200
	o["resolver"] = res
	var frames := [0]
	var count := func() -> void: frames[0] += 1
	process_frame.connect(count)
	t0 = Time.get_ticks_msec()
	r = await OneLobbyConnectionCheck.check(self, o)
	process_frame.disconnect(count)
	_check(r["udp"] == "ok", "names: a slow lookup still gets the answer, " + JSON.stringify(r))
	_check(frames[0] >= 5, "names: frames kept coming during the lookups (%d)" % frames[0])

	# a name that never resolves: no answer inside the per-server limits, no hang
	res = FakeResolver.new()
	res.never = true
	o["resolver"] = res
	frames[0] = 0
	process_frame.connect(count)
	t0 = Time.get_ticks_msec()
	r = await OneLobbyConnectionCheck.check(self, o)
	var took := Time.get_ticks_msec() - t0
	process_frame.disconnect(count)
	_check(r["udp"] == "blocked" and r["natType"] == "unknown", "names: a name that never resolves is no answer, " + JSON.stringify(r))
	_check(took >= 800 and took < 1500, "names: it ends inside the per-server limits (2 x 450 ms), took %d ms" % took)
	_check(frames[0] >= 20, "names: no frame blocked while it waited (%d frames)" % frames[0])
	_check(res.cancelled == 2, "names: the pending lookups are released")

	# a relay named by a name that never resolves: unreachable (no answer), in time
	t0 = Time.get_ticks_msec()
	var rp: String = await OneLobbyConnectionCheck.probe_relay(self, {"urls": ["turn:relay.test:3478"], "username": "a", "credential": "b"}, 400, res)
	_check(rp == "unreachable" and Time.get_ticks_msec() - t0 < 900, "names: a relay name that never resolves is unreachable in time: " + rp)

	# a literal address goes to the socket as it is: the resolver is never asked
	res = FakeResolver.new()
	o = _stun_opts([stun_a, stun_b])
	o["resolver"] = res
	r = await OneLobbyConnectionCheck.check(self, o)
	_check(r["udp"] == "ok" and res.begun.is_empty(), "names: a literal address is not looked up, " + JSON.stringify(res.begun))
