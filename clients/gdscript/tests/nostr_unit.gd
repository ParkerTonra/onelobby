extends SceneTree
## Unit tests for the Direct / Nostr half: crypto vectors, dc1 join codes, limits, frame wire.
## Run: godot --headless --path clients/gdscript -s res://tests/nostr_unit.gd

var _pass := 0
var _fail := 0


func _check(ok: bool, name: String) -> void:
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL: ", name)


func _spec(rel: String) -> Variant:
	var f := FileAccess.open("res://../../spec/" + rel, FileAccess.READ)
	if f == null:
		push_error("cannot open spec/" + rel)
		return {}
	return JSON.parse_string(f.get_as_text())


func _init() -> void:
	_crypto()
	_join_codes()
	_limits()
	_events()
	_dead_relay()
	_link()
	_hub()
	_inner_class_names()
	print("nostr unit: %d passed, %d failed" % [_pass, _fail])
	quit(0 if _fail == 0 else 1)


# A game's global class_name clashes with an inner class of the same name here, and the whole addon fails to compile.
# So every inner class carries the OL prefix.
func _inner_class_names() -> void:
	var re := RegEx.create_from_string("(?m)^\\s*class (\\w+)")
	var dir := "res://addons/onelobby/"
	var seen := 0
	for f in DirAccess.get_files_at(dir):
		if not f.ends_with(".gd"):
			continue
		for m in re.search_all(FileAccess.get_file_as_string(dir + f)):
			seen += 1
			_check(m.get_string(1).begins_with("OL"), "inner class has the OL prefix: %s in %s" % [m.get_string(1), f])
	_check(seen > 0, "inner class scan found classes")


func _crypto() -> void:
	var vec: Dictionary = _spec("vectors/nostr.json")
	# keys
	var k: Dictionary = vec["keys"]
	var d := OneLobbyNostrCrypto.derive(k["ikm"])
	_check((d["key"] as PackedByteArray).hex_encode() == k["key"], "hkdf key")
	_check(d["topic"] == k["topic"], "hkdf topic")
	for c in _spec("vectors/nostr-cs-check.json")["keys"]:
		var dd := OneLobbyNostrCrypto.derive(c["ikm"])
		_check((dd["key"] as PackedByteArray).hex_encode() == c["key"] and dd["topic"] == c["topic"], "cs-check keys " + c["code"])
	# AES-256-GCM against the spec vector
	var cv: Dictionary = vec["crypto"]
	var key := String(cv["key"]).hex_decode()
	var iv := String(cv["iv"]).hex_decode()
	var sealed := OneLobbyNostrCrypto.gcm_seal(key, iv, String(cv["plaintext"]).to_utf8_buffer())
	var content := Marshalls.raw_to_base64(iv + sealed)
	_check(content == cv["content"], "gcm seal matches the vector")
	var opened: Variant = OneLobbyNostrCrypto.open_content(key, cv["content"])
	_check(opened != null and opened == cv["plaintext"], "gcm open of the vector content")
	var bad := Marshalls.base64_to_raw(cv["content"])
	bad[20] ^= 1
	_check(OneLobbyNostrCrypto.open_content(key, Marshalls.raw_to_base64(bad)) == null, "gcm rejects a flipped bit")
	# NIST test case 2 (zero key, zero block): ct 0388dace..., tag ab6e47d4...
	var z16 := PackedByteArray()
	z16.resize(16)
	var z12 := PackedByteArray()
	z12.resize(12)
	var z32 := PackedByteArray()
	z32.resize(32)
	var nist := OneLobbyNostrCrypto.gcm_seal(z32, z12, z16)
	_check(nist.hex_encode() == "cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919", "NIST AES-256 case 14")
	# round trip across sizes (partial blocks, empty)
	for n in [0, 1, 15, 16, 17, 100, 1000]:
		var pt := Crypto.new().generate_random_bytes(n) if n > 0 else PackedByteArray()
		var rt: Variant = OneLobbyNostrCrypto.gcm_open(key, iv, OneLobbyNostrCrypto.gcm_seal(key, iv, pt))
		_check(rt != null and rt == pt, "gcm round trip %d bytes" % n)
	# BIP340
	var bip: Array = vec["bip340"]
	for v in bip:
		var kp := OneLobbySecp256k1.keypair(String(v["secretKey"]).hex_decode())
		_check(kp != null and kp.pubkey_hex() == String(v["publicKey"]).to_lower(), "bip340 pubkey %d" % v["index"])
		var sig := OneLobbySecp256k1.sign_msg(String(v["message"]).hex_decode(), kp, String(v["auxRand"]).hex_decode())
		_check(sig.hex_encode() == String(v["signature"]).to_lower(), "bip340 signature %d" % v["index"])


func _join_codes() -> void:
	var jc: Dictionary = _spec("vectors/joincode.json")
	for v in jc["valid"]:
		_check(OneLobbyJoinCode.encode_ip(v["ip"], int(v["port"])) == v["code"], "encode " + v["code"])
		var r := OneLobbyJoinCode.decode_dc1(v["code"])
		_check(r.get("ip", "") == v["ip"] and r.get("port", 0) == int(v["port"]), "decode " + v["code"])
	for v in jc["aliases"]:
		var r := OneLobbyJoinCode.decode_dc1(v["input"])
		_check(r.get("ip", "") == v["ip"] and r.get("port", 0) == int(v["port"]), "alias " + v["input"])
	for v in jc["invalid"]:
		_check(OneLobbyJoinCode.decode_dc1(v["input"]).get("error", "") == v["error"], "invalid '%s'" % v["input"])
	for v in jc["rooms"]:
		_check(OneLobbyJoinCode.encode_room(v["room"]) == v["code"], "encode room " + v["code"])
		_check(OneLobbyJoinCode.decode_dc1(v["code"]).get("room", "") == v["room"], "decode room " + v["code"])
	for v in jc["roomAliases"]:
		_check(OneLobbyJoinCode.decode_dc1(v["input"]).get("room", "") == v["room"], "room alias " + v["input"])
	var typos: Dictionary = jc["singleTypos"]
	var bad_n := 0
	for s in typos["inputs"]:
		if OneLobbyJoinCode.decode_dc1(s).get("error", "") == typos["error"]:
			bad_n += 1
	_check(bad_n == int(typos["count"]), "all %d single typos fail the check (got %d)" % [typos["count"], bad_n])
	var a := OneLobbyJoinCode.random_room()
	_check(a.length() == 12 and a != OneLobbyJoinCode.random_room(), "random rooms are 12 hex digits and differ")
	_check(OneLobbyJoinCode.decode_dc1(OneLobbyJoinCode.encode_room(a)).get("room", "") == a, "random room round trip")
	# the 6-character lobby codes still behave
	_check(OneLobbyJoinCode.normalize("7hq-4k2") == "7HQ4K2", "lobby code normalize unchanged")


func _limits() -> void:
	var file: Dictionary = _spec("vectors/nostr-limits.json")
	var mine := OneLobbyNostrLimits.groups()
	var keys := file.keys()
	keys.erase("$comment")
	keys.sort()
	var mykeys := mine.keys()
	mykeys.sort()
	_check(keys == mykeys, "limits: same groups as nostr-limits.json")
	for g: String in keys:
		var want: Dictionary = file[g]
		var have: Dictionary = mine.get(g, {})
		var wk := want.keys()
		var hk := have.keys()
		wk.sort()
		hk.sort()
		_check(wk == hk, "limits: same names in " + g)
		for k: String in wk:
			_check(int(want[k]) == int(have.get(k, -1)), "limits: %s.%s = %s" % [g, k, want[k]])
	_check(OneLobbyNostrPool.KIND == 25050, "event kind 25050")


func _events() -> void:
	var ev: Dictionary = _spec("vectors/nostr.json")["event"]
	var id := OneLobbyNostrPool.event_id(ev["pubkey"], int(ev["created_at"]), int(ev["kind"]), ev["tags"][0][1], ev["content"])
	_check(id == ev["id"], "nostr event id matches the vector")
	var kp := OneLobbySecp256k1.random_keypair()
	var made := OneLobbyNostrPool.make_event(kp, "abc", "Zm9v", 1700000000)
	_check(made["id"] == OneLobbyNostrPool.event_id(kp.pubkey_hex(), 1700000000, 25050, "abc", "Zm9v"), "made event has its own id")
	_check(String(made["sig"]).length() == 128 and made["kind"] == 25050 and made["tags"] == [["t", "abc"]], "made event shape")


## Two links wired through arrays: ordering, duplicates, reordering, acks and close.
## spec s.6: a relay that never connected is skipped after DEAD_RELAY_DIALS failed dials, but only while another relay is up.
func _dead_relay() -> void:
	var pool := OneLobbyNostrPool.new(["wss://up.test", "wss://down.test"], "tt", func(_ev: Dictionary) -> void: pass)
	var up: OneLobbyNostrPool.OLRelay = pool._relays[0]
	var down: OneLobbyNostrPool.OLRelay = pool._relays[1]
	for _i in OneLobbyNostrLimits.DEAD_RELAY_DIALS + 2:
		down.retry_at = 0
		pool._retry_later(down)
	_check(not down.skipped, "a dead relay keeps being retried while no relay is up")
	up.open = true
	up.attempted = true
	up.ever_open = true
	down.retry_at = 0
	pool._retry_later(down)
	_check(down.skipped and pool.settled(), "a dead relay is skipped once another relay is up")
	var pool2 := OneLobbyNostrPool.new(["wss://up.test", "wss://flaky.test"], "tt", func(_ev: Dictionary) -> void: pass)
	pool2._relays[0].open = true
	var flaky: OneLobbyNostrPool.OLRelay = pool2._relays[1]
	flaky.ever_open = true
	for _i in OneLobbyNostrLimits.DEAD_RELAY_DIALS + 2:
		flaky.retry_at = 0
		pool2._retry_later(flaky)
	_check(not flaky.skipped, "a relay that connected once is never skipped for failing dials")


func _link() -> void:
	var a_out: Array = []
	var b_out: Array = []
	var a_got: Array = []
	var b_got: Array = []
	var a_closed := [""]
	# the links run on a clock the test moves (their `now_fn`), so a batching window is passed by moving it, not by waiting
	var now := [0]
	var clock := func() -> int: return now[0]
	var a := OneLobbyNostrLink.new(func(f: Dictionary) -> void: a_out.append(f), func(t: String) -> void: a_got.append(t), func(r: String) -> void: a_closed[0] = "peer:" + r, func(_r: String) -> void: a_closed[0] = "dead", clock)
	var b := OneLobbyNostrLink.new(func(f: Dictionary) -> void: b_out.append(f), func(t: String) -> void: b_got.append(t), func(_r: String) -> void: pass, func(_r: String) -> void: pass, clock)
	a.send("one")
	a.send("two")
	now[0] += 40
	a.poll()
	_check(a_out.size() == 1 and a_out[0]["type"] == "data" and a_out[0]["msgs"] == ["one", "two"], "link batches two texts into one frame")
	_check(a.buffered() == 6, "link counts unacked bytes")
	a.send("three")
	now[0] += 40
	a.poll()
	_check(a_out.size() == 2 and a_out[1]["seq"] == 2, "link second frame has seq 2")
	# frame 2 arrives first (held), then frame 1, then a duplicate of frame 1
	b.receive(a_out[1])
	_check(b_got.is_empty(), "link holds an out-of-order frame")
	b.receive(a_out[0])
	_check(b_got == ["one", "two", "three"], "link delivers in order once the gap fills")
	b.receive(a_out[0])
	_check(b_got.size() == 3, "link drops a duplicate")
	now[0] += 40
	b.poll()
	_check(b_out.size() == 1 and b_out[0]["type"] == "beat" and b_out[0]["ack"] == 2, "link answers with an ack beat")
	a.receive(b_out[0])
	_check(a.buffered() == 0, "ack frees the sent frames")
	b.close("bye")
	_check(b_out.back()["type"] == "close" and b_out.back()["reason"] == "bye", "close frame carries the reason")
	a.receive(b_out.back())
	_check(a_closed[0] == "peer:bye" and a.is_closed(), "peer close reaches the owner")


## The hub over text, the way the host's sessions talk to it.
func _hub() -> void:
	var hub := OneLobbyHub.direct(3, "pw", ["stun:example.org:3478"])
	var host_in: Array = []
	var j_in: Array = []
	var hs := hub.connect_session("local", func(t: String) -> void: host_in.append(JSON.parse_string(t)), func(_c: int, _r: String) -> void: pass)
	var js := hub.connect_session("nostr:abcd", func(t: String) -> void: j_in.append(JSON.parse_string(t)), func(_c: int, _r: String) -> void: pass)
	hub.receive(hs, '{"t":"create","name":"L","maxPlayers":3,"mode":"raw"}')
	_check(host_in.size() == 1 and host_in[0]["code"] == "bad_request", "create before hello is refused")
	host_in.clear()
	hub.receive(hs, '{"t":"hello","proto":"lk1","gameId":"g","netVersion":"1","name":"Host"}')
	_check(host_in[0]["t"] == "welcome" and host_in[0]["ice"][0]["urls"][0] == "stun:example.org:3478", "welcome carries the STUN list")
	_check(int(host_in[0]["limits"]["maxPlayers"]) == 3, "welcome limits.maxPlayers")
	hub.receive(hs, '{"t":"create","name":"L","maxPlayers":3,"mode":"raw","visibility":"unlisted"}')
	var lobby: Dictionary = host_in[1]
	_check(lobby["t"] == "lobby" and lobby["code"] == "" and int(lobby["you"]) == 1 and int(lobby["hostId"]) == 1, "create answers a lobby with no code")
	hub.receive(js, '{"t":"hello","proto":"lk1","gameId":"g","netVersion":"1","name":"Jo"}')
	hub.receive(js, '{"t":"join"}')
	_check(j_in.back()["t"] == "error" and j_in.back()["code"] == "bad_password", "join without the password is refused")
	hub.receive(js, '{"t":"join","password":"pw"}')
	var jl: Dictionary = j_in.back()
	_check(jl["t"] == "lobby" and int(jl["you"]) == 2 and (jl["peers"] as Array).size() == 2, "join without a code enters the one lobby")
	_check(host_in.back()["t"] == "peer_joined" and int(host_in.back()["peer"]["peerId"]) == 2, "host hears peer_joined")
	hub.receive(js, '{"t":"signal","to":1,"sdp":{"type":"answer","sdp":"x"}}')
	_check(host_in.back()["t"] == "signal" and int(host_in.back()["from"]) == 2, "signal joiner to host is relayed")
	hub.receive(hs, '{"t":"signal","to":2,"ice":{"candidate":"c"}}')
	_check(j_in.back()["t"] == "signal" and int(j_in.back()["from"]) == 1, "signal host to joiner is relayed")
	hub.receive(js, '{"t":"ping","n":7}')
	_check(j_in.back()["t"] == "pong" and int(j_in.back()["n"]) == 7, "ping answers pong")
	hub.receive(js, '{"t":"phase","phase":"in_game"}')
	_check(j_in.back()["code"] == "not_host", "joiner cannot change the phase")
	hub.receive(hs, '{"t":"phase","phase":"in_game"}')
	_check(host_in.back()["t"] == "lobby" and host_in.back()["phase"] == "in_game", "host phase is broadcast as a lobby message")
	hub.receive(hs, '{"t":"kick","peerId":2}')
	_check(j_in.back()["t"] == "error" and j_in.back()["code"] == "kicked", "kicked joiner gets the kicked error")
	_check(host_in.back()["t"] == "peer_left" and host_in.back()["reason"] == "kicked", "host hears peer_left kicked")
	var j2_in: Array = []
	var j2 := hub.connect_session("nostr:abcd", func(t: String) -> void: j2_in.append(JSON.parse_string(t)), func(_c: int, _r: String) -> void: pass)
	hub.receive(j2, '{"t":"hello","proto":"lk1","gameId":"g","netVersion":"1","name":"Jo"}')
	hub.receive(j2, '{"t":"join","password":"pw"}')
	_check(j2_in.back()["code"] == "kicked", "a kicked address cannot rejoin")
	hub.receive(j2, '{"t":"hello","proto":"lk1"}')
	_check(j2_in.back()["code"] == "bad_request", "hello twice is refused")
	_check(OneLobbyHub.sanitize("a\u0001b" + char(0x202E) + "c", 24) == "abc", "sanitize drops control and bidi characters")
	_check(OneLobbyHub.sanitize("", 24, "Player") == "Player", "sanitize falls back")
