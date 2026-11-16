class_name OneLobbyRoomWire
extends RefCounted
## Room frames (spec/room.md 2-3): data-channel type 0x80, route 0, then one UTF-8 JSON object. The JSON text is written
## here, not by Godot's JSON.stringify, so it matches JS `JSON.stringify` byte for byte (compact, whole numbers without a
## ".0", the same string escapes): the vectors pin the frame bytes and the 1024-byte data limit counts these bytes.


## JS `JSON.stringify` of `v`. Whole floats print as integers (Godot parses every JSON number as a float). With
## `sort_keys` the keys of every object are in code point order (used to compare entries, never on the wire).
static func json_text(v: Variant, sort_keys: bool = false) -> String:
	match typeof(v):
		TYPE_NIL:
			return "null"
		TYPE_BOOL:
			return "true" if v else "false"
		TYPE_INT:
			return str(v)
		TYPE_FLOAT:
			var f: float = v
			if not is_finite(f):
				return "null"
			if f == floorf(f) and absf(f) < 9007199254740992.0:
				return str(int(f))
			return str(f)
		TYPE_STRING, TYPE_STRING_NAME:
			return _quote(str(v))
		TYPE_ARRAY:
			var parts := PackedStringArray()
			for x: Variant in v:
				parts.append(json_text(x, sort_keys))
			return "[" + ",".join(parts) + "]"
		TYPE_DICTIONARY:
			var d: Dictionary = v
			var keys: Array = d.keys()
			if sort_keys:
				keys.sort_custom(func(a: Variant, b: Variant) -> bool: return str(a) < str(b))
			var parts := PackedStringArray()
			for k: Variant in keys:
				parts.append(_quote(str(k)) + ":" + json_text(d[k], sort_keys))
			return "{" + ",".join(parts) + "}"
	return "null"


static func _quote(s: String) -> String:
	var out := PackedStringArray()
	out.append("\"")
	var start := 0
	for i in s.length():
		var c := s.unicode_at(i)
		var esc := ""
		if c == 0x22:
			esc = "\\\""
		elif c == 0x5c:
			esc = "\\\\"
		elif c < 0x20:
			match c:
				8: esc = "\\b"
				9: esc = "\\t"
				10: esc = "\\n"
				12: esc = "\\f"
				13: esc = "\\r"
				_: esc = "\\u%04x" % c
		if esc != "":
			if i > start:
				out.append(s.substr(start, i - start))
			out.append(esc)
			start = i + 1
	if s.length() > start:
		out.append(s.substr(start))
	out.append("\"")
	return "".join(out)


## The `room` frame bytes for message `m` (a Dictionary with a string `t`). Frames over 16384 bytes are chunked by the
## lobby's send path.
static func encode_frame(m: Dictionary) -> PackedByteArray:
	return OneLobbyWire.encode({"type": "room", "route": 0, "body": json_text(m).to_utf8_buffer()}, OneLobbyWire.MAX_REASSEMBLED)


## The JSON object of a room `body`, or {} when it is not UTF-8, not an object, or has no string `t`.
static func parse_body(body: PackedByteArray) -> Dictionary:
	if not OneLobbyWire.is_valid_utf8(body):
		return {}
	var j := JSON.new()
	if j.parse(body.get_string_from_utf8()) != OK:
		return {}
	var v: Variant = j.data
	if not v is Dictionary or not (v as Dictionary).get("t") is String:
		return {}
	return v


## Decodes a whole frame (header included) to its room message; {} for anything else or a bad body.
static func decode_frame(frame: PackedByteArray) -> Dictionary:
	var m := OneLobbyWire.decode(frame, OneLobbyWire.MAX_REASSEMBLED)
	if m.has("error") or str(m.get("type")) != "room":
		return {}
	return parse_body(m["body"])
