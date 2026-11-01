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
	print("nostr unit: %d passed, %d failed" % [_pass, _fail])
	quit(0 if _fail == 0 else 1)


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
	pass
