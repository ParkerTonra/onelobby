class_name OneLobbyConnectionCheck
extends RefCounted
## The connection check (spec/diagnostics.md s.8): UDP, NAT type and relay login, measured with raw UDP from one
## PacketPeerUDP socket against the STUN servers the client already uses and the player's own TURN entry, and nothing
## else. Run it from a menu (`await client.check_connection()`); the library never runs it by itself.
##
## `check` and `probe_relay` are coroutines that wait on the scene tree's frames, so they need a running SceneTree.

const SERVER_MS := 1500
const RETRANSMIT_MS := 500
const WHOLE_MS := 8000
const DEFAULT_STUN: Array[String] = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"]
const COOKIE := [0x21, 0x12, 0xa4, 0x42]

static var _url_re: RegEx = null


# ---- STUN / TURN messages --------------------------------------------------------------------------------------------

static func _u16(v: int) -> PackedByteArray:
	return PackedByteArray([(v >> 8) & 0xff, v & 0xff])


static func _header(type: int, body_len: int, tid: PackedByteArray) -> PackedByteArray:
	var h := _u16(type)
	h.append_array(_u16(body_len))
	h.append_array(PackedByteArray(COOKIE))
	h.append_array(tid)
	return h


static func _attr(type: int, value: PackedByteArray) -> PackedByteArray:
	var a := _u16(type)
	a.append_array(_u16(value.size()))
	a.append_array(value)
	while a.size() % 4 != 0:
		a.append(0)
	return a


## An RFC 5389 Binding Request with transaction id `tid` (12 bytes).
static func binding_request(tid: PackedByteArray) -> PackedByteArray:
	return _header(0x0001, 0, tid)


## The attributes of a STUN message for `tid`: {type, attrs: [{type, value}]}; {} when it is not one.
static func _parse(b: PackedByteArray, tid: PackedByteArray) -> Dictionary:
	if b.size() < 20:
		return {}
	if b[4] != COOKIE[0] or b[5] != COOKIE[1] or b[6] != COOKIE[2] or b[7] != COOKIE[3]:
		return {}
	var length := (b[2] << 8) | b[3]
	if 20 + length > b.size():
		return {}
	for i in 12:
		if b[8 + i] != tid[i]:
			return {}
	var attrs: Array = []
	var o := 20
	while o + 4 <= 20 + length:
		var t := (b[o] << 8) | b[o + 1]
		var l := (b[o + 2] << 8) | b[o + 3]
		if o + 4 + l > 20 + length:
			break
		attrs.append({"type": t, "value": b.slice(o + 4, o + 4 + l)})
		o += 4 + ((l + 3) & ~3)
	return {"type": (b[0] << 8) | b[1], "attrs": attrs}


## The mapped address {ip, port} in a Binding success response for `tid` (XOR-MAPPED-ADDRESS, else MAPPED-ADDRESS), or null.
static func parse_binding_response(b: PackedByteArray, tid: PackedByteArray) -> Variant:
	var m := _parse(b, tid)
	if m.is_empty() or int(m["type"]) != 0x0101:
		return null
	for want: int in [0x0020, 0x0001]:
		for a: Dictionary in m["attrs"]:
			if int(a["type"]) != want:
				continue
			var v: PackedByteArray = a["value"]
			if v.size() < 8 or v[1] != 0x01: # IPv4 only
				continue
			var port := (v[2] << 8) | v[3]
			var ip: Array = [v[4], v[5], v[6], v[7]]
			if want == 0x0020:
				port ^= (COOKIE[0] << 8) | COOKIE[1]
				for i in 4:
					ip[i] = int(ip[i]) ^ int(COOKIE[i])
			return {"ip": "%d.%d.%d.%d" % ip, "port": port}
	return null


## A Binding success response carrying XOR-MAPPED-ADDRESS ip:port (what test STUN servers answer).
static func binding_response(tid: PackedByteArray, ip: String, port: int) -> PackedByteArray:
	var v := PackedByteArray([0, 1])
	v.append_array(_u16(port ^ ((COOKIE[0] << 8) | COOKIE[1])))
	var parts := ip.split(".")
	for i in 4:
		v.append(int(parts[i]) ^ int(COOKIE[i]))
	var a := _attr(0x0020, v)
	var out := _header(0x0101, a.size(), tid)
	out.append_array(a)
	return out


## A TURN Allocate request for UDP (RFC 5766). Without `auth` it is the bare first request; with it {username, realm,
## nonce (PackedByteArray), password}, the long-term credential form (USERNAME, REALM, NONCE, MESSAGE-INTEGRITY).
static func turn_allocate_request(tid: PackedByteArray, auth: Dictionary = {}) -> PackedByteArray:
	var transport := _attr(0x0019, PackedByteArray([17, 0, 0, 0]))
	if auth.is_empty():
		var bare := _header(0x0003, transport.size(), tid)
		bare.append_array(transport)
		return bare
	var body := transport.duplicate()
	body.append_array(_attr(0x0006, str(auth["username"]).to_utf8_buffer()))
	body.append_array(_attr(0x0014, str(auth["realm"]).to_utf8_buffer()))
	body.append_array(_attr(0x0015, auth["nonce"]))
	# MESSAGE-INTEGRITY covers the message up to itself, with the header length counting the 24-byte attribute
	var md5 := HashingContext.new()
	md5.start(HashingContext.HASH_MD5)
	md5.update(("%s:%s:%s" % [auth["username"], auth["realm"], auth["password"]]).to_utf8_buffer())
	var key := md5.finish()
	var pre := _header(0x0003, body.size() + 24, tid)
	pre.append_array(body)
	var h := HMACContext.new()
	h.start(HashingContext.HASH_SHA1, key)
	h.update(pre)
	var out := pre.duplicate()
	out.append_array(_attr(0x0008, h.finish()))
	return out


## What a TURN server answered for `tid`: {ok: true}, or {ok: false, code, realm?, nonce?} for an error; null when it is neither.
static func parse_turn_response(b: PackedByteArray, tid: PackedByteArray) -> Variant:
	var m := _parse(b, tid)
	if m.is_empty():
		return null
	if int(m["type"]) == 0x0103:
		return {"ok": true}
	if int(m["type"]) != 0x0113:
		return null
	var out := {"ok": false, "code": 0}
	for a: Dictionary in m["attrs"]:
		var v: PackedByteArray = a["value"]
		match int(a["type"]):
			0x0009:
				if v.size() >= 4:
					out["code"] = (v[2] & 7) * 100 + v[3]
			0x0014:
				out["realm"] = v.get_string_from_utf8()
			0x0015:
				out["nonce"] = v
	return out


# ---- UDP -------------------------------------------------------------------------------------------------------------

## `host` and `port` of a `stun:` / `turn:` URL as {host, port} (UDP only: `stuns:`, `turns:` and a tcp transport give {}).
static func ice_url_target(url: String) -> Dictionary:
	if _url_re == null:
		_url_re = RegEx.create_from_string("(?i)^(stun|turn):([^:?\\s/]+)(?::([0-9]+))?(\\?\\S*)?\\z")
	var m := _url_re.search(url.strip_edges())
	if m == null:
		return {}
	if m.get_string(4).to_lower().contains("transport=tcp"):
		return {}
	return {"host": m.get_string(2), "port": int(m.get_string(3)) if m.get_string(3) != "" else 3478}


## True when every target is a loopback address (127.0.0.0/8, ::1, localhost): such a check binds 127.0.0.1, not all
## interfaces (spec/diagnostics.md s.8).
static func all_loopback(targets: Array) -> bool:
	if targets.is_empty():
		return false
	for t: Dictionary in targets:
		var h := str(t["host"]).to_lower().lstrip("[").rstrip("]")
		if not (h == "localhost" or h == "::1" or h.begins_with("127.")):
			return false
	return true


static func _turn_target(s: Dictionary) -> Dictionary:
	var urls: Variant = s.get("urls", [])
	for u: Variant in (urls if urls is Array else [urls]):
		if str(u).to_lower().begins_with("turn:"):
			var t := ice_url_target(str(u))
			if not t.is_empty():
				return t
	return {}


static func _has_turn(s: Dictionary) -> bool:
	var urls: Variant = s.get("urls", [])
	for u: Variant in (urls if urls is Array else [urls]):
		var lu := str(u).to_lower()
		if lu.begins_with("turn:") or lu.begins_with("turns:"):
			return true
	return false


## One UDP socket; `exchange` sends a request and waits for an answer `parse` accepts, with one retransmit.
class OLProbe:
	extends RefCounted
	var udp := PacketPeerUDP.new()
	var ok := false
	var local_port := 0

	func _init(bind_address: String) -> void:
		ok = udp.bind(0, bind_address) == OK
		if ok:
			local_port = udp.get_local_port()

	## Returns what `parse(bytes)` made of the first acceptable answer within `ms` (null when nothing valid came back).
	func exchange(tree: SceneTree, target: Dictionary, request: PackedByteArray, parse: Callable, ms: int) -> Variant:
		if not ok:
			return null
		if udp.set_dest_address(str(target["host"]), int(target["port"])) != OK:
			return null # the name does not resolve: nothing can answer
		var t0 := Time.get_ticks_msec()
		var retransmit_at := mini(OneLobbyConnectionCheck.RETRANSMIT_MS, ms / 3)
		udp.put_packet(request)
		var resent := false
		while Time.get_ticks_msec() - t0 < ms:
			while udp.get_available_packet_count() > 0:
				var v: Variant = parse.call(udp.get_packet())
				if v != null:
					return v
			if not resent and Time.get_ticks_msec() - t0 >= retransmit_at:
				resent = true
				udp.put_packet(request)
			await tree.process_frame
		return null

	func close() -> void:
		udp.close()


static func _random_tid() -> PackedByteArray:
	return Crypto.new().generate_random_bytes(12)


static func _probe_stun(tree: SceneTree, p: OLProbe, t: Dictionary, ms: int) -> Variant:
	var tid := _random_tid()
	return await p.exchange(tree, t, binding_request(tid), func(b: PackedByteArray) -> Variant: return parse_binding_response(b, tid), ms)


## The TURN login round trip (RFC 5766 long-term credentials): "ok", "refused", "unreachable" or "unknown" (a turns: URL or tcp transport).
static func _probe_turn(tree: SceneTree, p: OLProbe, s: Dictionary, ms: int) -> String:
	var t := _turn_target(s)
	if t.is_empty():
		return "unknown"
	var tid1 := _random_tid()
	var r1: Variant = await p.exchange(tree, t, turn_allocate_request(tid1), func(b: PackedByteArray) -> Variant: return parse_turn_response(b, tid1), ms)
	if r1 == null:
		return "unreachable"
	if r1["ok"]:
		return "ok" # an open relay
	if int(r1["code"]) != 401 or not r1.has("realm") or not r1.has("nonce"):
		return "refused"
	if str(s.get("username", "")).is_empty() or str(s.get("credential", "")).is_empty():
		return "refused"
	var tid2 := _random_tid()
	var auth := {"username": s["username"], "realm": r1["realm"], "nonce": r1["nonce"], "password": s["credential"]}
	var r2: Variant = await p.exchange(tree, t, turn_allocate_request(tid2, auth), func(b: PackedByteArray) -> Variant: return parse_turn_response(b, tid2), ms)
	if r2 == null:
		return "unreachable"
	return "ok" if r2["ok"] else "refused"


## Probes a relay entry on its own (a fresh UDP socket): "ok", "refused" (the server answered and turned the login down),
## "unreachable" (no answer) or "unknown" (a turns: URL, a tcp transport, no socket). A lobby uses it to tell relay_refused
## from relay_unreachable after a failed connect.
static func probe_relay(tree: SceneTree, server: Dictionary, ms := SERVER_MS) -> String:
	var t := _turn_target(server)
	if t.is_empty():
		return "unknown"
	var p := OLProbe.new("127.0.0.1" if all_loopback([t]) else "*")
	var r := "unknown"
	if p.ok:
		r = await _probe_turn(tree, p, server, ms)
	p.close()
	return r


## Checks what this network allows. `options`: stun (Array of URLs, default Google and Cloudflare), ice_servers (the
## player's TURN entry: the first turn: one is tested), timeout_ms (8000 for the whole check), server_timeout_ms (1500 per
## server, one retransmit at a third), bind_address. Returns {udp, natType, relay, verdict, message}.
static func check(tree: SceneTree, options: Dictionary = {}) -> Dictionary:
	var stun: Array = options.get("stun", DEFAULT_STUN)
	var turn: Dictionary = {}
	for s: Variant in options.get("ice_servers", []):
		if s is Dictionary and _has_turn(s):
			turn = s
			break
	var per_server := int(options.get("server_timeout_ms", SERVER_MS))
	var deadline := Time.get_ticks_msec() + int(options.get("timeout_ms", WHOLE_MS))
	var targets: Array = []
	for u: Variant in stun:
		var t := ice_url_target(str(u))
		if not t.is_empty():
			targets.append(t)
	var all := targets.duplicate()
	if not turn.is_empty() and not _turn_target(turn).is_empty():
		all.append(_turn_target(turn))
	var bind := str(options.get("bind_address", ""))
	if bind == "":
		bind = "127.0.0.1" if all_loopback(all) else "*"
	var findings := {"udp": "unknown", "natType": "unknown", "relay": "unknown" if not turn.is_empty() else "none"}
	var p := OLProbe.new(bind)
	if p.ok:
		# one after the other from the same socket: a NAT that maps by destination shows two ports
		var answers: Array = []
		for t: Dictionary in targets:
			var left := deadline - Time.get_ticks_msec()
			if left <= 0:
				break
			var a: Variant = await _probe_stun(tree, p, t, mini(per_server, left))
			if a != null:
				answers.append(a)
		var mine: Dictionary = {"ip": "", "port": p.local_port}
		if not answers.is_empty() and IP.get_local_addresses().has(str(answers[0]["ip"])):
			mine["ip"] = answers[0]["ip"]
		var nat := OneLobbyDiagnose.classify_nat(targets.size(), answers, mine)
		findings["udp"] = nat["udp"]
		findings["natType"] = nat["natType"]
		if turn.is_empty():
			findings["relay"] = "none"
		else:
			var left2 := deadline - Time.get_ticks_msec()
			findings["relay"] = await _probe_turn(tree, p, turn, mini(per_server, maxi(left2, 1))) if left2 > 0 else "unknown"
	p.close()
	var v := OneLobbyDiagnose.check_verdict(findings)
	findings["verdict"] = v["verdict"]
	findings["message"] = v["message"]
	return findings
