extends SceneTree
## BIP340 signing vectors from spec/vectors/nostr.json plus a timing measurement.
## Run: godot --headless --path clients/gdscript -s res://tests/sign_bench.gd

func _init() -> void:
	var f := FileAccess.open("res://../../spec/vectors/nostr.json", FileAccess.READ)
	var data: Dictionary = JSON.parse_string(f.get_as_text())
	var pass_n := 0
	var fail_n := 0
	for v in data["bip340"]:
		var kp := OneLobbySecp256k1.keypair(String(v["secretKey"]).hex_decode())
		var pk_ok := kp != null and kp.pubkey_hex() == String(v["publicKey"]).to_lower()
		var sig := OneLobbySecp256k1.sign_msg(String(v["message"]).hex_decode(), kp, String(v["auxRand"]).hex_decode())
		var sig_ok := sig.hex_encode() == String(v["signature"]).to_lower()
		if pk_ok and sig_ok:
			pass_n += 1
		else:
			fail_n += 1
			print("FAIL vector ", v["index"], " pk=", pk_ok, " sig=", sig_ok)
	print("bip340: ", pass_n, " passed, ", fail_n, " failed")
	var a := OneLobbySecp256k1.fe_from_bytes(("0123456789abcdef" + "fedcba9876543210" + "0123456789abcdef" + "fedcba9876543210").hex_decode())
	var inv := OneLobbySecp256k1.fe_inv(a)
	print("inv ok: ", OneLobbySecp256k1.fe_to_bytes(OneLobbySecp256k1.fe_mul(a, inv)).hex_encode())
	var kp2 := OneLobbySecp256k1.random_keypair()
	var msg := PackedByteArray()
	msg.resize(32)
	OneLobbySecp256k1.sign_random(msg, kp2)
	var n := 20
	var t0 := Time.get_ticks_usec()
	for i in n:
		OneLobbySecp256k1.sign_random(msg, kp2)
	var dt := float(Time.get_ticks_usec() - t0) / 1000.0
	print("sign: ", dt / n, " ms per signature (", n, " runs)")
	var t1 := Time.get_ticks_usec()
	OneLobbySecp256k1.random_keypair()
	print("keypair: ", float(Time.get_ticks_usec() - t1) / 1000.0, " ms")
	quit(0 if fail_n == 0 else 1)
