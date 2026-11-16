class_name OneLobbyWire
extends RefCounted
## Data-channel binary protocol (spec/binary.md): 3-byte header (type:u8, route:u16), little-endian, one message per
## frame, at most 16384 bytes. Table-driven like spec/reference/codec.mjs. Decoded messages are Dictionaries:
## u8/u16/u32/i64 fields are ints, u64 fields are ints holding the same 64 bits (see u64_to_string), bytes fields are
## PackedByteArrays, text fields are Strings.

const MAX_FRAME := 16384
const HEADER := 3
const MAX_CHUNK_BODY := 16373
const DEFAULT_CHUNK := 16000
const MAX_REASSEMBLED := 64 * 1024 * 1024
const PROTO := 1
const MODE_LOCKSTEP := 1
const MODE_RAW := 2

## Data channels (spec/binary.md "Channels").
const RELIABLE := 0
const FAST := 1
const VOICE := 2

const HI := 0x01
const WELCOME_DC := 0x02
const CHUNK := 0x16
const RAW := 0x20
const PING := 0x30
const PONG := 0x31
const HOST_CLAIM := 0x40
const ROOM := 0x80

const TYPES := {
	"hi": 0x01, "welcome_dc": 0x02, "cmd": 0x10, "frame": 0x11, "hash": 0x12, "desync": 0x13, "snapshot_req": 0x14,
	"snapshot": 0x15, "chunk": 0x16, "raw": 0x20, "ping": 0x30, "pong": 0x31, "host_claim": 0x40, "voice": 0x50,
	"chat": 0x60, "chat_history": 0x61, "chat_reject": 0x62, "room": 0x80,
	"pause_request": 0x70, "pause_state": 0x71, "pause_refuse": 0x72,
}

## Field kinds: u8 u16 u32 i64 u64; lbytes = u16 length + bytes; text = u16 length + UTF-8; rest = bytes to the end;
## list16/list8 = u16/u8 count + repeated records (always last in a body).
const LAYOUTS := {
	"hi": [["proto", "u8"], ["peerId", "u16"], ["lastTick", "i64"]],
	"welcome_dc": [["tick", "i64"], ["tickRate", "u8"], ["mode", "u8"], ["hostId", "u16"]],
	"cmd": [["seq", "u32"], ["bytes", "lbytes"]],
	"frame": [["tick", "i64"], ["cmds", "list16", [["peerId", "u16"], ["bytes", "lbytes"]]]],
	"hash": [["tick", "i64"], ["hash", "u64"]],
	"desync": [["tick", "i64"], ["hostHash", "u64"], ["yourHash", "u64"]],
	"snapshot_req": [["sinceTick", "i64"]],
	"snapshot": [["tick", "i64"], ["total", "u32"], ["flags", "u8"]],
	"chunk": [["id", "u32"], ["index", "u16"], ["count", "u16"], ["bytes", "rest"]],
	"raw": [["bytes", "rest"]],
	"ping": [["n", "u32"], ["t", "u32"]],
	"pong": [["n", "u32"], ["t", "u32"]],
	"host_claim": [["epoch", "u16"], ["hostId", "u16"], ["tick", "i64"]],
	"voice": [["seq", "u16"], ["flags", "u8"], ["packets", "list8", [["opus", "lbytes"]]]],
	"chat": [["id", "u32"], ["ts", "i64"], ["text", "text"]],
	"chat_history": [["lines", "list16", [["peerId", "u16"], ["id", "u32"], ["ts", "i64"], ["text", "text"]]]],
	"chat_reject": [["id", "u32"], ["reason", "u8"]],
	"room": [["body", "rest"]],
	"pause_request": [["paused", "u8"]],
	"pause_state": [["paused", "u8"], ["byPeer", "u16"], ["flags", "u8"]],
	"pause_refuse": [["paused", "u8"], ["reason", "u8"]],
}

const SIZES := {"u8": 1, "u16": 2, "u32": 4, "i64": 8, "u64": 8}


static func type_name(type_id: int) -> String:
	for k: String in TYPES:
		if TYPES[k] == type_id:
			return k
	return ""


# ---- encode ------------------------------------------------------------------------------------------------------

## Encodes a message Dictionary ({type: name or id, route, ...fields}). Returns an empty array on a bad message. `max_len`
## is the size cap: MAX_FRAME for a frame sent whole, MAX_REASSEMBLED for one the sender sends as chunks.
static func encode(msg: Dictionary, max_len: int = MAX_FRAME) -> PackedByteArray:
	var type_id: int = msg["type"] if msg.get("type") is int else int(TYPES.get(msg.get("type", ""), -1))
	var name := type_name(type_id)
	if name == "":
		push_error("OneLobbyWire: unknown type %s" % str(msg.get("type")))
		return PackedByteArray()
	var out := PackedByteArray()
	out.append(type_id)
	_put(out, "u16", int(msg.get("route", 0)))
	if not _write_fields(out, LAYOUTS[name], msg):
		return PackedByteArray()
	if out.size() > max_len:
		push_error("OneLobbyWire: frame of %d bytes over %d" % [out.size(), max_len])
		return PackedByteArray()
	return out


static func _put(out: PackedByteArray, kind: String, v: int) -> void:
	for i in SIZES[kind]:
		out.append((v >> (8 * i)) & 0xFF)


static func _write_fields(out: PackedByteArray, spec: Array, obj: Dictionary) -> bool:
	for f: Array in spec:
		var fname: String = f[0]
		var kind: String = f[1]
		if not obj.has(fname):
			push_error("OneLobbyWire: missing field %s" % fname)
			return false
		var v: Variant = obj[fname]
		match kind:
			"u8", "u16", "u32", "i64", "u64":
				_put(out, kind, int(v))
			"lbytes", "text":
				var b: PackedByteArray = (v as String).to_utf8_buffer() if kind == "text" else (v as PackedByteArray)
				if b.size() > 65535:
					return false
				_put(out, "u16", b.size())
				out.append_array(b)
			"rest":
				out.append_array(v as PackedByteArray)
			"list16", "list8":
				var items: Array = v
				_put(out, "u16" if kind == "list16" else "u8", items.size())
				for rec: Dictionary in items:
					if not _write_fields(out, f[2], rec):
						return false
	return true


# ---- decode ------------------------------------------------------------------------------------------------------

## Decodes one frame. Returns the message Dictionary ({type, typeId, route, ...fields}), or {error: code} with code
## too_short, trailing, too_long or bad_utf8. Unknown type ids decode as {type: "unknown", typeId, route, body}.
static func decode(b: PackedByteArray, max_len: int = MAX_FRAME) -> Dictionary:
	if b.size() > max_len:
		return {"error": "too_long"}
	if b.size() < HEADER:
		return {"error": "too_short"}
	var type_id := b[0]
	var route := b[1] | (b[2] << 8)
	var name := type_name(type_id)
	if name == "":
		return {"type": "unknown", "typeId": type_id, "route": route, "body": b.slice(HEADER)}
	var r := OLReader.new(b, HEADER)
	var o := {"type": name, "typeId": type_id, "route": route}
	_read_fields(r, LAYOUTS[name], o)
	if r.error != "":
		return {"error": r.error}
	if r.p != b.size():
		return {"error": "trailing"}
	return o


static func _read_fields(r: OLReader, spec: Array, o: Dictionary) -> void:
	for f: Array in spec:
		if r.error != "":
			return
		var fname: String = f[0]
		var kind: String = f[1]
		match kind:
			"u8", "u16", "u32", "i64", "u64":
				o[fname] = r.num(SIZES[kind])
			"lbytes":
				o[fname] = r.take(r.num(2))
			"text":
				var raw := r.take(r.num(2))
				if r.error == "" and not is_valid_utf8(raw):
					r.error = "bad_utf8"
					return
				o[fname] = raw.get_string_from_utf8()
			"rest":
				o[fname] = r.take(r.b.size() - r.p)
			"list16", "list8":
				var n := r.num(2 if kind == "list16" else 1)
				var items: Array = []
				for i in n:
					if r.error != "":
						break
					var rec := {}
					_read_fields(r, f[2], rec)
					items.append(rec)
				o[fname] = items


class OLReader:
	var b: PackedByteArray
	var p: int
	var error := ""

	func _init(bytes: PackedByteArray, offset: int) -> void:
		b = bytes
		p = offset

	func num(size: int) -> int:
		if error != "" or p + size > b.size():
			error = "too_short" if error == "" else error
			return 0
		var v := 0
		for i in size:
			v |= b[p + i] << (8 * i)
		p += size
		return v

	func take(n: int) -> PackedByteArray:
		if error != "" or p + n > b.size():
			error = "too_short" if error == "" else error
			return PackedByteArray()
		var s := b.slice(p, p + n)
		p += n
		return s


## Strict UTF-8 (what TextDecoder fatal accepts): no overlong forms, no surrogates, nothing above U+10FFFF.
static func is_valid_utf8(b: PackedByteArray) -> bool:
	var i := 0
	var n := b.size()
	while i < n:
		var c := b[i]
		if c < 0x80:
			i += 1
			continue
		var need := 0
		var lo := 0x80
		var hi := 0xBF
		if c >= 0xC2 and c <= 0xDF:
			need = 1
		elif c == 0xE0:
			need = 2; lo = 0xA0
		elif (c >= 0xE1 and c <= 0xEC) or c == 0xEE or c == 0xEF:
			need = 2
		elif c == 0xED:
			need = 2; hi = 0x9F
		elif c == 0xF0:
			need = 3; lo = 0x90
		elif c >= 0xF1 and c <= 0xF3:
			need = 3
		elif c == 0xF4:
			need = 3; hi = 0x8F
		else:
			return false
		if i + need > n - 1:
			return false
		for k in need:
			var x := b[i + 1 + k]
			if k == 0:
				if x < lo or x > hi:
					return false
			elif x < 0x80 or x > 0xBF:
				return false
		i += need + 1
	return true


# ---- frame builders the lobby uses -------------------------------------------------------------------------------

static func header(type_id: int, route: int) -> PackedByteArray:
	return PackedByteArray([type_id, route & 0xFF, (route >> 8) & 0xFF])


static func build_raw(route: int, payload: PackedByteArray) -> PackedByteArray:
	var out := header(RAW, route)
	out.append_array(payload)
	return out


static func build_hi(peer_id: int, last_tick: int) -> PackedByteArray:
	return encode({"type": "hi", "route": 0, "proto": PROTO, "peerId": peer_id, "lastTick": last_tick})


static func build_welcome_dc(tick: int, tick_rate: int, mode: int, host_id: int) -> PackedByteArray:
	return encode({"type": "welcome_dc", "route": 0, "tick": tick, "tickRate": tick_rate, "mode": mode, "hostId": host_id})


static func build_chat_history_empty() -> PackedByteArray:
	return encode({"type": "chat_history", "route": 0, "lines": []})


static func build_ping(type_id: int, n: int, t: int) -> PackedByteArray:
	var out := header(type_id, 0)
	_put(out, "u32", n & 0xFFFFFFFF)
	_put(out, "u32", t & 0xFFFFFFFF)
	return out


static func build_host_claim(epoch: int, host_id: int, tick: int) -> PackedByteArray:
	return encode({"type": "host_claim", "route": 0, "epoch": epoch & 0xFFFF, "hostId": host_id, "tick": tick})


## A copy of the frame with its route field replaced.
static func with_route(frame: PackedByteArray, route: int) -> PackedByteArray:
	var out := frame.duplicate()
	out[1] = route & 0xFF
	out[2] = (route >> 8) & 0xFF
	return out


# ---- u64 as decimal ----------------------------------------------------------------------------------------------

## The unsigned decimal form of a u64 held in a (signed) int.
static func u64_to_string(v: int) -> String:
	if v >= 0:
		return str(v)
	var q := ((v >> 1) & 0x7FFFFFFFFFFFFFFF) / 5 # = v / 10, unsigned
	var r := v - q * 10
	return str(q) + str(r)


## Parses an unsigned decimal up to 18446744073709551615 into the int with the same 64 bits.
static func u64_from_string(s: String) -> int:
	var v := 0
	for ch in s:
		v = v * 10 + (ch.unicode_at(0) - 48)
	return v
