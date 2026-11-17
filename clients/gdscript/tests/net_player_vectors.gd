extends SceneTree
## The networked player codec against the shared vectors (spec/vectors/net-player.json), every group and every case, both
## directions: encode to the exact hex, decode the hex to the listed values (floats within 1e-5), position bits, kind 5 events
## and every invalid case with its error name. Port of clients/js/packages/client/test/net-player-vectors.test.ts.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/net_player_vectors.gd
## Prints "net_player_vectors: N passed, M failed"; exits 1 on any failure.

const W := preload("res://addons/onelobby/net_player_wire.gd")
const TOL := 1e-5

var _pass := 0
var _fail := 0
var _groups := {}


func _init() -> void:
	_run.call_deferred()


func _check(ok: bool, what: String, group: String = "") -> void:
	if group != "":
		_groups[group] = int(_groups.get(group, 0)) + (1 if ok else 0)
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL: ", what)


func _vectors() -> Dictionary:
	var spec := ProjectSettings.globalize_path("res://").path_join("../../spec").simplify_path()
	var j := JSON.new()
	j.parse(FileAccess.get_file_as_string(spec.path_join("vectors/net-player.json")))
	return j.data


## camelCase keys of the file become the snake_case keys of the GDScript API, all the way down.
func _snake_keys(v: Variant) -> Variant:
	if v is Dictionary:
		var o := {}
		for k: String in v:
			o[W.snake(k)] = _snake_keys(v[k])
		return o
	return v


## Same keys, numbers within TOL, everything else equal.
func _close(a: Variant, b: Variant) -> bool:
	var an: bool = typeof(a) == TYPE_INT or typeof(a) == TYPE_FLOAT
	var bn: bool = typeof(b) == TYPE_INT or typeof(b) == TYPE_FLOAT
	if an and bn:
		return absf(float(a) - float(b)) <= TOL
	if a is Dictionary and b is Dictionary:
		if a.size() != b.size():
			return false
		for k: Variant in a:
			if not b.has(k) or not _close(a[k], b[k]):
				return false
		return true
	return typeof(a) == typeof(b) and a == b


func _run() -> void:
	var v := _vectors()
	var configs: Dictionary = v["configs"]
	var codecs := {}
	for name: String in configs:
		var c: Dictionary = configs[name]
		codecs[name] = OneLobbyPlayerCodec.new({"space": c["space"], "range": c["range"], "velocity_range": c["velocityRange"], "omit": c["omit"]})

	for p: Dictionary in v["positionBits"]:
		_check(W.position_bits(float(p["range"])) == int(p["bits"]), "position bits of range %s" % str(p["range"]), "positionBits")

	for s: Dictionary in v["states"]:
		var c: OneLobbyPlayerCodec = codecs[s["config"]]
		var state: Dictionary = _snake_keys(s["state"])
		var full := W.default_player_state(state)
		var want_hex: String = s["hex"]
		_check(c.encode_state(full).hex_encode() == want_hex, "state %s: encode" % s["name"], "states")
		_check(c.state_bits() == int(s["bits"]), "state %s: bits" % s["name"], "states")
		var back: Variant = c.decode_state(want_hex.hex_decode())
		_check(back != null and _close(back, _snake_keys(s["decoded"])), "state %s: decode" % s["name"], "states")
		# a quantised state is a fixed point of the wire
		_check(back != null and c.encode_state(c.quantize(full)).hex_encode() == want_hex, "state %s: quantize is stable" % s["name"], "states")

	for i: Dictionary in v["inputs"]:
		var c: OneLobbyPlayerCodec = codecs[i["config"]]
		var input := W.default_player_input(_snake_keys(i["input"]))
		_check(c.encode_input(input).hex_encode() == i["hex"], "input %s: encode" % i["name"], "inputs")
		var back: Variant = c.decode_input(String(i["hex"]).hex_decode())
		_check(back != null and _close(back, _snake_keys(i["decoded"])), "input %s: decode" % i["name"], "inputs")

	for a: Dictionary in v["args"]:
		var c: OneLobbyPlayerCodec = codecs[a["config"]]
		var ev: String = a["event"]
		_check(c.encode_args(ev, a["args"]).hex_encode() == a["hex"], "args %s: encode" % a["name"], "args")
		var back: Variant = c.decode_args(ev, String(a["hex"]).hex_decode())
		_check(back != null and _close(back, a["decoded"]), "args %s: decode" % a["name"], "args")
		var def: Variant = W.action_by_name(ev)
		_check(def != null and int(def["id"]) == int(a["id"]), "args %s: event id" % a["name"], "args")

	for e: Dictionary in v["events"]:
		var recs: Array = []
		for r: Dictionary in e["events"]:
			recs.append({"player": int(r["player"]), "seq": int(r["seq"]), "id": int(r["id"]), "tick": int(r["tick"]), "args": String(r["argsHex"]).hex_decode()})
		_check(W.encode_player_events(recs).hex_encode() == e["hex"], "events %s: encode" % e["name"], "events")
		var d := W.decode_player_events(String(e["hex"]).hex_decode())
		var same := not d.has("error") and (d["events"] as Array).size() == recs.size()
		if same:
			for k in recs.size():
				var got: Dictionary = d["events"][k]
				var want: Dictionary = recs[k]
				for key: String in ["player", "seq", "id", "tick"]:
					same = same and int(got[key]) == int(want[key])
				same = same and (got["args"] as PackedByteArray) == (want["args"] as PackedByteArray)
		_check(same, "events %s: decode" % e["name"], "events")

	var covered := {}
	for inv: Dictionary in v["invalid"]:
		var c: OneLobbyPlayerCodec = codecs[inv["config"]]
		var bytes := String(inv["hex"]).hex_decode()
		var kind: String = inv["kind"]
		var ok := false
		if kind == "state":
			ok = c.decode_state(bytes) == null and inv["error"] == "length"
		elif kind == "input":
			ok = c.decode_input(bytes) == null and inv["error"] == "length"
		elif kind == "args":
			ok = c.decode_args(inv["event"], bytes) == null and inv["error"] == "length"
		else:
			var d := W.decode_player_events(bytes)
			ok = d.get("error", "") == inv["error"]
			covered[inv["error"]] = true
		_check(ok, "invalid %s" % inv["name"], "invalid")
	for name in ["too_short", "trailing", "varint", "range", "count_0", "player_0", "seq_0", "event_id"]:
		_check(covered.has(name), "every kind 5 error is covered: %s" % name, "invalid")

	# the bytes of the preset: 16 / 12 bytes of state, 6 / 5 of input at the default range
	_check(codecs["default3d"].state_bytes() == 16 and codecs["default2d"].state_bytes() == 12, "state sizes 16 and 12")
	_check(codecs["default3d"].input_bytes() == 6 and codecs["default2d"].input_bytes() == 5, "input sizes 6 and 5")
	_check(codecs["default3d"].state_bits() == 128 and codecs["default2d"].state_bits() == 92, "state bits 128 and 92")

	# omit takes the file's spelling and the snake_case one
	var camel := OneLobbyPlayerCodec.new({"omit": ["onGround", "itemSwitch"]})
	var snaky := OneLobbyPlayerCodec.new({"omit": ["on_ground", "item_switch"]})
	_check(camel.omit == snaky.omit and not camel.has("onGround") and not camel.has_event("itemSwitch"), "omit spellings")

	print("groups: ", _groups)
	print("net_player_vectors: %d passed, %d failed" % [_pass, _fail])
	quit(1 if _fail > 0 else 0)
