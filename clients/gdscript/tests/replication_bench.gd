extends SceneTree
## Timing, not a gate: how long GDScript takes to encode and decode one delta snapshot of 50 entities with 16-byte states
## (the average of 200 runs, the work a host does per client per tick and a client does per snapshot). Prints one line.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/replication_bench.gd

const P := preload("res://addons/onelobby/replication_protocol.gd")
const RUNS := 200


func _init() -> void:
	_run.call_deferred()


func _world(tick: int, shift: int) -> Dictionary:
	var ents: Array = []
	for i in 50:
		var st := PackedByteArray()
		st.resize(16)
		for k in 16:
			st[k] = (i * 7 + k * 3) & 0xFF
		# every entity moves: 5 of its 16 bytes differ from the previous tick
		for k in 5:
			st[k * 3] = (int(st[k * 3]) + shift) & 0xFF
		ents.append({"id": i + 1, "type": 7, "owner": 0, "state": st})
	return {"tick": tick, "ents": ents}


func _run() -> void:
	var base := _world(10, 0)
	var cur := _world(11, 1)
	var bytes := P.encode_snapshot(cur, base, 5)
	var enc_us := 0
	var dec_us := 0
	var ok := true
	for _i in RUNS:
		var t0 := Time.get_ticks_usec()
		var b := P.encode_snapshot(cur, base, 5)
		var t1 := Time.get_ticks_usec()
		var w := P.decode_snapshot(b, base)
		var t2 := Time.get_ticks_usec()
		enc_us += t1 - t0
		dec_us += t2 - t1
		ok = ok and not w.has("error") and w["ents"].size() == 50
	print("replication_bench: delta snapshot of 50 entities x 16-byte states (%d bytes): encode %.0f us, decode %.0f us, both %.0f us (average of %d runs; %s, headless, %s)" % [
		bytes.size(), float(enc_us) / RUNS, float(dec_us) / RUNS, float(enc_us + dec_us) / RUNS, RUNS, "Godot " + Engine.get_version_info()["string"], OS.get_name() + " " + str(OS.get_processor_name()).strip_edges()])
	quit(0 if ok else 1)
