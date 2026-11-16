extends SceneTree
## The replication codec against the shared vectors (spec/vectors/replication.json), every group and every case: snapshots,
## inputs, events, stream events, state bits, quantize, invalid (every error name of the spec at least once), describe,
## and the receive side of numbered stream events (streamReceive, run on OneLobbyReplicationSession's stream buffer).
## Plus a few properties (a delta round-trips random worlds, garbage never crashes a decoder).
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/replication_vectors.gd
## Prints "replication_vectors: N passed, M failed"; exits 1 on any failure.

const P := preload("res://addons/onelobby/replication_protocol.gd")

var _pass := 0
var _fail := 0
var _groups := {}


func _init() -> void:
	_run.call_deferred()


func _check(ok: bool, what: String) -> void:
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL: ", what)


func _spec(path: String) -> Variant:
	var spec := ProjectSettings.globalize_path("res://").path_join("../../spec").simplify_path()
	var j := JSON.new()
	j.parse(FileAccess.get_file_as_string(spec.path_join(path)))
	return j.data


## Numbers compare by value (JSON gives floats), everything else deeply.
func _same(a: Variant, b: Variant) -> bool:
	if (typeof(a) == TYPE_INT or typeof(a) == TYPE_FLOAT) and (typeof(b) == TYPE_INT or typeof(b) == TYPE_FLOAT):
		return float(a) == float(b)
	if a is Array and b is Array:
		if a.size() != b.size():
			return false
		for i in a.size():
			if not _same(a[i], b[i]):
				return false
		return true
	if a is Dictionary and b is Dictionary:
		if a.size() != b.size():
			return false
		for k: Variant in a:
			if not b.has(k) or not _same(a[k], b[k]):
				return false
		return true
	return typeof(a) == typeof(b) and a == b


## Dictionaries list their keys in the same order, all the way down.
func _same_order(a: Variant, b: Variant) -> bool:
	if a is Dictionary and b is Dictionary:
		if a.keys() != b.keys():
			return false
		for k: Variant in a:
			if not _same_order(a[k], b[k]):
				return false
		return true
	if a is Array and b is Array:
		for i in mini(a.size(), b.size()):
			if not _same_order(a[i], b[i]):
				return false
	return true


func _count(group: String) -> void:
	_groups[group] = int(_groups.get(group, 0)) + 1


func _run() -> void:
	var v: Dictionary = _spec("vectors/replication.json")
	_snapshots(v)
	_inputs_events(v)
	_invalid(v)
	_state_bits(v)
	_quantize(v)
	_describe(v)
	_stream_receive(v)
	_properties()
	print("groups: ", _groups)
	print("replication_vectors: %d passed, %d failed" % [_pass, _fail])
	quit(1 if _fail > 0 else 0)


func _world(tick: int, arr: Array) -> Dictionary:
	var ents: Array = []
	for e: Array in arr:
		ents.append({"id": int(e[0]), "type": int(e[1]), "owner": int(e[2]), "state": (e[3] as String).hex_decode()})
	return {"tick": tick, "ents": ents}


func _baseline(b: Variant) -> Variant:
	return null if b == null else _world(int(b["tick"]), b["world"])


func _world_hex(w: Dictionary) -> Array:
	var out: Array = []
	for e: Dictionary in w["ents"]:
		out.append([e["id"], e["type"], e["owner"], (e["state"] as PackedByteArray).hex_encode()])
	return [w["tick"], out]


func _num(x: Variant) -> float:
	if x is String:
		return NAN if x == "NaN" else (INF if x == "Infinity" else -INF)
	return float(x)


func _f32(x: float) -> float:
	return OneLobbyQuantize.f32(x)


# ---- snapshots, inputs, events -------------------------------------------------------------------------------------

func _snapshots(v: Dictionary) -> void:
	for c: Dictionary in v["snapshots"]:
		_count("snapshots")
		var cur := _world(int(c["tick"]), c["world"])
		var base: Variant = _baseline(c["baseline"])
		var bytes := P.encode_snapshot(cur, base, int(c["lastInputSeq"]))
		var name: String = c["name"]
		_check(bytes.hex_encode() == c["hex"], "snapshot encodes: " + name)
		var h := P.peek_snapshot(bytes)
		var want_base := 0 if base == null else int((base as Dictionary)["tick"])
		_check(not h.has("error") and h["tick"] == int(c["tick"]) and h["baseline_tick"] == want_base and h["last_input"] == int(c["lastInputSeq"]), "snapshot peek: " + name)
		var d := P.decode_snapshot((c["hex"] as String).hex_decode(), base)
		_check(not d.has("error") and _world_hex(d) == _world_hex(cur), "snapshot decodes: " + name)


func _inputs_events(v: Dictionary) -> void:
	for c: Dictionary in v["inputs"]:
		_count("inputs")
		var entries: Array = []
		for e: Array in c["inputs"]:
			entries.append({"view256": int(e[0]), "bytes": (e[1] as String).hex_decode()})
		var bytes := P.encode_input(int(c["ack"]), int(c["newestSeq"]), entries)
		var name: String = c["name"]
		_check(bytes.hex_encode() == c["hex"], "input encodes: " + name)
		var d := P.decode_input(bytes)
		var ok: bool = not d.has("error") and d["ack"] == int(c["ack"]) and d["newest_seq"] == int(c["newestSeq"]) and d["inputs"].size() == entries.size()
		if ok:
			for i in entries.size():
				var got: Dictionary = d["inputs"][i]
				ok = ok and got["seq"] == int(c["newestSeq"]) - i and got["view256"] == entries[i]["view256"] and got["bytes"] == entries[i]["bytes"]
		_check(ok, "input decodes: " + name)
	for c: Dictionary in v["events"]:
		_count("events")
		var bytes := P.encode_event(int(c["tick"]), (c["payloadHex"] as String).hex_decode())
		var name: String = c["name"]
		_check(bytes.hex_encode() == c["hex"], "event encodes: " + name)
		var d := P.decode_event(bytes)
		_check(not d.has("error") and d["tick"] == int(c["tick"]) and (d["payload"] as PackedByteArray).hex_encode() == c["payloadHex"], "event decodes: " + name)
	for c: Dictionary in v["streamEvents"]:
		_count("streamEvents")
		var bytes := P.encode_stream_event(int(c["tick"]), int(c["stream"]), int(c["seq"]), (c["payloadHex"] as String).hex_decode())
		var name: String = c["name"]
		_check(bytes.hex_encode() == c["hex"], "stream event encodes: " + name)
		var d := P.decode_stream_event(bytes)
		_check(not d.has("error") and d["tick"] == int(c["tick"]) and d["stream"] == int(c["stream"]) and d["seq"] == int(c["seq"]) and (d["payload"] as PackedByteArray).hex_encode() == c["payloadHex"], "stream event decodes: " + name)


# ---- invalid -------------------------------------------------------------------------------------------------------

func _invalid(v: Dictionary) -> void:
	var seen := {}
	for c: Dictionary in v["invalid"]:
		_count("invalid")
		var bytes := (c["hex"] as String).hex_decode()
		var kind: String = c.get("kind", "snapshot")
		var d: Dictionary
		match kind:
			"input":
				d = P.decode_input(bytes)
			"event":
				d = P.decode_event(bytes)
			"streamEvent":
				d = P.decode_stream_event(bytes)
			_:
				d = P.decode_snapshot(bytes, _baseline(c["baseline"]))
		_check(d.get("error", "") == c["error"], "invalid: %s -> %s (got %s)" % [c["name"], c["error"], d.get("error", "ok")])
		seen[c["error"]] = true
	for name in P.ERRORS:
		_check(seen.has(name), "the invalid group produces the error " + name)
	_check(seen.size() == P.ERRORS.size(), "the invalid group names only errors of the spec")


# ---- state bits ----------------------------------------------------------------------------------------------------

func _write(w: OneLobbyNetWriter, o: Dictionary) -> bool:
	match o["op"]:
		"bits":
			w.write_bits(int(o["v"]), int(o["n"]))
		"bool":
			w.write_bool(o["v"])
		"byte":
			w.write_byte(int(o["v"]))
		"u16":
			w.write_uint16(int(o["v"]))
		"u32":
			w.write_uint32(int(o["v"]))
		"i32":
			w.write_int32(int(o["v"]))
		"float":
			w.write_float(float(o["v"]))
		"q":
			w.write_quantized(float(o["v"]), float(o["min"]), float(o["max"]), int(o["bits"]))
		"angle":
			w.write_angle(float(o["v"]), int(o["bits"]))
		"quat":
			var q: Array = o["v"]
			w.write_quaternion(float(q[0]), float(q[1]), float(q[2]), float(q[3]), int(o.get("bits", 9)))
		_:
			return false
	return true


func _read(r: OneLobbyNetReader, o: Dictionary) -> Variant:
	match o["op"]:
		"bits":
			return r.read_bits(int(o["n"]))
		"bool":
			return r.read_bool()
		"byte":
			return r.read_byte()
		"u16":
			return r.read_uint16()
		"u32":
			return r.read_uint32()
		"i32":
			return r.read_int32()
		"float":
			return r.read_float()
		"q":
			return r.read_quantized(float(o["min"]), float(o["max"]), int(o["bits"]))
		"angle":
			return r.read_angle(int(o["bits"]))
		"quat":
			return r.read_quaternion(int(o.get("bits", 9)))
	return null


func _state_bits(v: Dictionary) -> void:
	for c: Dictionary in v["stateBits"]:
		_count("stateBits")
		var name: String = c["name"]
		if c.has("ops"):
			var w := OneLobbyNetWriter.new()
			var wrote := true
			for o: Dictionary in c["ops"]:
				for _i in int(o.get("repeat", 1)):
					wrote = _write(w, o) and wrote
			_check(wrote and w.to_bytes().hex_encode() == c["hex"], "state bits write: " + name)
			_check(w.bit_count() == int(c["bits"]) and w.byte_count() <= 255, "state bits count: " + name)
		var r := OneLobbyNetReader.new((c["hex"] as String).hex_decode())
		var ok := true
		for o: Dictionary in c["reads"]:
			for _i in int(o.get("repeat", 1)):
				var got: Variant = _read(r, o)
				match o["op"]:
					"float", "q", "angle":
						ok = ok and float(got) == _f32(float(o["read"]))
					"quat":
						var want: Array = o["read"]
						for k in 4:
							ok = ok and float((got as Array)[k]) == _f32(float(want[k]))
					"bool":
						ok = ok and got == o["read"]
					_:
						ok = ok and int(got) == int(o["read"])
		_check(ok, "state bits read: " + name)
		_check(r.overrun == c["overrun"], "state bits overrun flag: " + name)


# ---- quantize ------------------------------------------------------------------------------------------------------

func _quantize(v: Dictionary) -> void:
	for c: Dictionary in v["quantize"]:
		_count("quantize")
		var name: String = c["name"]
		var bits := int(c["bits"])
		match c["fn"]:
			"float":
				var q := OneLobbyQuantize.float_q(_num(c["value"]), float(c["min"]), float(c["max"]), bits)
				_check(q == int(c["q"]), "quantize float q: " + name)
				_check(OneLobbyQuantize.dequantize(q, float(c["min"]), float(c["max"]), bits) == _f32(float(c["back"])), "quantize float back: " + name)
			"angle":
				var q := OneLobbyQuantize.angle(_num(c["value"]), bits)
				_check(q == int(c["q"]), "quantize angle q: " + name)
				_check(OneLobbyQuantize.angle_from(q, bits) == _f32(float(c["back"])), "quantize angle back: " + name)
			_:
				var val: Array = c["value"]
				var q := OneLobbyQuantize.smallest_three(float(val[0]), float(val[1]), float(val[2]), float(val[3]), bits)
				_check(q["largest"] == int(c["largest"]), "quantize quat largest: " + name)
				_check([q["a"], q["b"], q["c"]] == (c["q"] as Array).map(func(x: Variant) -> int: return int(x)), "quantize quat q: " + name)
				var b := OneLobbyQuantize.from_smallest_three(q["largest"], q["a"], q["b"], q["c"], bits)
				var ok := true
				for k in 4:
					ok = ok and b[k] == _f32(float((c["back"] as Array)[k]))
				_check(ok, "quantize quat back: " + name)


# ---- describe ------------------------------------------------------------------------------------------------------

func _describe(v: Dictionary) -> void:
	for c: Dictionary in v["describe"]:
		_count("describe")
		var got := P.describe((c["hex"] as String).hex_decode(), _baseline(c["baseline"]))
		_check(_same(got, c["json"]), "describe: %s" % c["name"])
		# the key order is part of the shape
		_check(_same_order(got, c["json"]), "describe key order: %s" % c["name"])


# ---- stream receive (the receive side of numbered stream events) ----------------------------------------------------

func _stream_receive(v: Dictionary) -> void:
	if not v.has("streamReceive"):
		_check(false, "the vector file has a streamReceive group")
		return
	for c: Dictionary in v["streamReceive"]:
		_count("streamReceive")
		var got := OneLobbyReplicationStreams.run_case(c)
		_check(_same(got, c["expect"]), "stream receive: %s\n   got  %s\n   want %s" % [c["name"], JSON.stringify(got), JSON.stringify(c["expect"])])


# ---- properties ----------------------------------------------------------------------------------------------------

func _properties() -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = 5
	# a delta round-trips random worlds
	var base := {"tick": 1, "ents": []}
	for round in 200:
		var ents: Array = []
		var id := 0
		for _i in rng.randi_range(0, 12):
			id += rng.randi_range(1, 40)
			var st := PackedByteArray()
			for _k in rng.randi_range(0, 20):
				st.append(rng.randi_range(0, 255))
			ents.append({"id": id, "type": rng.randi_range(0, 3), "owner": rng.randi_range(0, 2), "state": st})
		if round > 0 and rng.randf() < 0.7 and base["ents"].size() > 0:
			ents = (base["ents"] as Array).duplicate(true)
			for e: Dictionary in ents:
				var st: PackedByteArray = e["state"]
				if st.size() > 0 and rng.randf() < 0.5:
					st[rng.randi_range(0, st.size() - 1)] = rng.randi_range(0, 255)
					e["state"] = st
		var cur := {"tick": int(base["tick"]) + 1 + rng.randi_range(0, 3), "ents": ents}
		var use_base: Variant = base if round % 5 != 0 else null
		var bytes := P.encode_snapshot(cur, use_base, round)
		var d := P.decode_snapshot(bytes, use_base)
		_check(not d.has("error") and _world_hex(d) == _world_hex(cur), "random delta round %d" % round)
		base = cur
	# quantize round trip is within half a step
	for _i in 500:
		var x := rng.randf_range(-256.0, 256.0)
		var q := OneLobbyQuantize.float_q(x, -256.0, 256.0, 16)
		_check(absf(OneLobbyQuantize.dequantize(q, -256.0, 256.0, 16) - x) <= 512.0 / 65535.0 / 2.0 + 1e-4, "float round trip")
	# garbage never crashes a decoder or describe
	for _i in 400:
		var b := PackedByteArray([0x52, 1, 1 + rng.randi_range(0, 3)])
		for _k in rng.randi_range(0, 30):
			b.append(rng.randi_range(0, 255))
		P.describe(b)
		P.describe(b, base)
		P.decode_snapshot(b, null)
		P.decode_snapshot(b, base)
		P.decode_input(b)
		P.decode_event(b)
		P.decode_stream_event(b)
		P.peek_snapshot(b)
	_check(true, "garbage decodes without a crash")
