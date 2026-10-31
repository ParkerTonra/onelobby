extends SceneTree
## Runs the shared spec vectors (spec/vectors/frames.json, invalid.json, chunking.json, spec/codes.json) against the
## addon. Headless:  godot --headless --audio-driver Dummy --path clients/gdscript -s tests/vectors.gd
## Prints one line per failure and "vectors: N passed, M failed"; exits 1 on any failure.

var _pass := 0
var _fail := 0


func _init() -> void:
	var spec := ProjectSettings.globalize_path("res://").path_join("../../spec").simplify_path()
	_frames(_load(spec.path_join("vectors/frames.json")))
	_invalid(_load(spec.path_join("vectors/invalid.json")))
	_chunking(_load(spec.path_join("vectors/chunking.json")))
	_codes(_load(spec.path_join("codes.json")))
	_u64()
	print("vectors: %d passed, %d failed" % [_pass, _fail])
	quit(1 if _fail > 0 else 0)


func _load(path: String) -> Dictionary:
	var text := FileAccess.get_file_as_string(path)
	var d: Variant = JSON.parse_string(text)
	if not d is Dictionary:
		_check(false, "could not read " + path)
		return {}
	return d


func _check(ok: bool, what: String) -> void:
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL ", what)


# ---- frames --------------------------------------------------------------------------------------------------------

func _frames(doc: Dictionary) -> void:
	for v: Dictionary in doc.get("vectors", []):
		var n: String = v["name"]
		var want: PackedByteArray = (v["hex"] as String).hex_decode()
		var got := OneLobbyWire.decode(want)
		_check(not got.has("error"), n + " decodes (" + str(got.get("error", "")) + ")")
		if got.has("error"):
			continue
		var json := _to_json(got)
		var expect: Variant = _ints(v["msg"])
		_check(json == expect, n + " decodes as " + JSON.stringify(expect) + ", got " + JSON.stringify(json))
		var enc := OneLobbyWire.encode(_from_json(v["msg"]))
		_check(enc == want, n + " encodes to " + v["hex"] + ", got " + enc.hex_encode())


## Decoded message -> the vectors' JSON form (i64/u64 decimal strings, bytes hex).
func _to_json(m: Dictionary) -> Dictionary:
	var out := {"type": m["type"], "route": m["route"]}
	_fields_to_json(OneLobbyWire.LAYOUTS[m["type"]], m, out)
	return out


func _fields_to_json(spec: Array, m: Dictionary, out: Dictionary) -> void:
	for f: Array in spec:
		var v: Variant = m[f[0]]
		match f[1]:
			"i64":
				out[f[0]] = str(v)
			"u64":
				out[f[0]] = OneLobbyWire.u64_to_string(v)
			"lbytes", "rest":
				out[f[0]] = (v as PackedByteArray).hex_encode()
			"list16", "list8":
				var items: Array = []
				for rec: Dictionary in v:
					var o := {}
					_fields_to_json(f[2], rec, o)
					items.append(o)
				out[f[0]] = items
			_:
				out[f[0]] = v


## The vectors' JSON form -> what OneLobbyWire.encode takes.
func _from_json(msg: Dictionary) -> Dictionary:
	var out := {"type": msg["type"], "route": int(msg["route"])}
	_fields_from_json(OneLobbyWire.LAYOUTS[msg["type"]], msg, out)
	return out


func _fields_from_json(spec: Array, msg: Dictionary, out: Dictionary) -> void:
	for f: Array in spec:
		var v: Variant = msg[f[0]]
		match f[1]:
			"i64":
				out[f[0]] = (v as String).to_int()
			"u64":
				out[f[0]] = OneLobbyWire.u64_from_string(v)
			"lbytes", "rest":
				out[f[0]] = (v as String).hex_decode()
			"text":
				out[f[0]] = v
			"list16", "list8":
				var items: Array = []
				for rec: Dictionary in v:
					var o := {}
					_fields_from_json(f[2], rec, o)
					items.append(o)
				out[f[0]] = items
			_:
				out[f[0]] = int(v)


## JSON numbers arrive as floats: make the whole ones ints so == compares like with like.
func _ints(v: Variant) -> Variant:
	if v is float and v == floorf(v):
		return int(v)
	if v is Dictionary:
		var d := {}
		for k: Variant in v:
			d[k] = _ints(v[k])
		return d
	if v is Array:
		var a: Array = []
		for x: Variant in v:
			a.append(_ints(x))
		return a
	return v


# ---- invalid -------------------------------------------------------------------------------------------------------

func _invalid(doc: Dictionary) -> void:
	for v: Dictionary in doc.get("vectors", []):
		var got := OneLobbyWire.decode((v["hex"] as String).hex_decode())
		_check(got.get("error", "") == v["error"], "%s rejects as %s, got %s" % [v["name"], v["error"], JSON.stringify(_to_json_safe(got))])
	for v: Dictionary in doc.get("unknown_type_ok", []):
		var got := OneLobbyWire.decode((v["hex"] as String).hex_decode())
		var d: Dictionary = v["decodesAs"]
		_check(got.get("type") == "unknown" and got.get("typeId") == int(d["typeId"]) and got.get("route") == int(d["route"])
			and (got.get("body", PackedByteArray()) as PackedByteArray).hex_encode() == d["body"], v["name"] + " decodes as unknown")


func _to_json_safe(m: Dictionary) -> Variant:
	return m if m.has("error") or m.get("type") == "unknown" else _to_json(m)


# ---- chunking ------------------------------------------------------------------------------------------------------

func _chunking(doc: Dictionary) -> void:
	for v: Dictionary in doc.get("vectors", []):
		var n: String = v["name"]
		match n:
			"forty_kb_default":
				var p := PackedByteArray()
				p.resize(int(v["payload_len"]))
				for i in p.size():
					p[i] = (i * 7 + 3) & 0xFF
				_check(OneLobbyWire.u64_to_string(_fnv1a64(p)) == v["payload_fnv1a64"], n + " payload fnv1a64")
				var chunks := OneLobbyChunker.split(int(v["id"]), p, int(v["chunkSize"]))
				var lens: Array = []
				for c in chunks:
					lens.append(c.size())
				_check(lens == _ints(v["chunk_lengths"]), n + " chunk lengths " + str(lens))
				for i in chunks.size():
					_check(chunks[i].slice(0, 16).hex_encode() == v["chunk_hex_prefix_16"][i], n + " chunk %d prefix" % i)
				_reassemble(n, chunks, p, true)
			"oversized_inner_frame":
				var p := PackedByteArray()
				p.resize(int(v["payload_len"]))
				_check(OneLobbyChunker.split(int(v["id"]), p, int(v["chunkSize"])).size() == int(v["chunk_count"]), n + " chunk count")
			"snapshot_deflate":
				var snap := OneLobbyWire.decode((v["snapshot_header_hex"] as String).hex_decode())
				var payload := (v["payload"] as String).hex_decode()
				_check(snap.get("flags") == 1 and snap.get("total") == payload.size(), n + " snapshot header")
				var inflated := payload.decompress(int(v["inflated_len"]), FileAccess.COMPRESSION_DEFLATE)
				_check(inflated.size() == int(v["inflated_len"]), n + " inflates to %d bytes, got %d" % [v["inflated_len"], inflated.size()])
				_explicit(n, v, payload)
			_:
				_explicit(n, v, (v["payload"] as String).hex_decode())


func _explicit(n: String, v: Dictionary, payload: PackedByteArray) -> void:
	var want: Array = v["chunks"]
	var got := OneLobbyChunker.split(int(v["id"]), payload, int(v.get("chunkSize", 40)))
	var hexes: Array = []
	for c in got:
		hexes.append(c.hex_encode())
	_check(hexes == want, n + " chunks " + str(hexes))
	var frames: Array[PackedByteArray] = []
	for h: String in want:
		frames.append(h.hex_decode())
	_reassemble(n, frames, payload, true)


func _reassemble(n: String, chunks: Array[PackedByteArray], payload: PackedByteArray, shuffled: bool) -> void:
	var order := range(chunks.size())
	if shuffled:
		order.reverse()
	var asm := OneLobbyChunker.new()
	var out := {}
	for i: int in order:
		var body := chunks[i].slice(OneLobbyWire.HEADER)
		var r := asm.add(body)
		if r.get("done", false):
			out = r
		asm.add(body) # duplicates are ignored
	_check(out.get("done", false) and out["bytes"] == payload, n + " reassembles (reverse order, duplicates)")


func _fnv1a64(b: PackedByteArray) -> int:
	var h := -3750763034362895579 # 0xcbf29ce484222325
	for x in b:
		h = (h ^ x) * 0x100000001b3
	return h


# ---- join codes ----------------------------------------------------------------------------------------------------

func _codes(doc: Dictionary) -> void:
	for v: Dictionary in doc.get("valid", []):
		_check(OneLobbyJoinCode.normalize(v["input"]) == v["canonical"], "code %s -> %s, got %s" % [v["input"], v["canonical"], OneLobbyJoinCode.normalize(v["input"])])
	for v: Dictionary in doc.get("invalid", []):
		_check(OneLobbyJoinCode.normalize(v["input"]) == "", "code %s invalid (%s)" % [v["input"], v.get("why", "")])
	_check(OneLobbyJoinCode.display("7HQ4K2") == "7HQ 4K2", "display 7HQ 4K2")


func _u64() -> void:
	for s in ["0", "1", "9223372036854775807", "9223372036854775808", "18446744073709551615", "15206158565288813733"]:
		_check(OneLobbyWire.u64_to_string(OneLobbyWire.u64_from_string(s)) == s, "u64 round trip " + s)
