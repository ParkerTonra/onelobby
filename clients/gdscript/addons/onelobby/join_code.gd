class_name OneLobbyJoinCode
extends RefCounted
## Lobby join codes (spec/codes.json): 6 Crockford base-32 characters, shown as "7HQ 4K2".

const ALPHABET := "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const LENGTH := 6


## The canonical code, or "" if the input cannot be a code. Removes spaces and hyphens, uppercases ASCII letters only,
## reads I and L as 1 and O as 0; U and every other character is invalid.
static func normalize(input: String) -> String:
	var s := ""
	for ch in input:
		var c := ch.unicode_at(0)
		if c == 0x20 or c == 0x2D:
			continue
		if c >= 0x61 and c <= 0x7A:
			c -= 32
		if c == 0x49 or c == 0x4C: # I, L
			c = 0x31
		elif c == 0x4F: # O
			c = 0x30
		if c > 0x7F or ALPHABET.find(char(c)) < 0:
			return ""
		s += char(c)
	return s if s.length() == LENGTH else ""


## "7HQ4K2" -> "7HQ 4K2".
static func display(code: String) -> String:
	return code.substr(0, 3) + " " + code.substr(3)


# ---------------------------------------------------------------- dc1 direct codes (spec/reference/joincode.mjs)
# 11 characters, 55 bits: version:2 | payload:48 | crc5:5. Version 0 is an IPv4 address and port, version 1 a random
# Nostr room (spec/nostr-signaling.md s.1). They are shown 4-4-3 with hyphens: "D1PB-1X9S-FPV".

const DC1_LENGTH := 11
const VERSION_IPV4 := 0
const VERSION_ROOM := 1


## CRC-5 (polynomial 0x05, init 0, MSB first) over the low `bits` bits of `value`.
static func crc5(value: int, bits: int) -> int:
	var crc := 0
	for i in range(bits - 1, -1, -1):
		var bit := (value >> i) & 1
		var top := (crc >> 4) & 1
		crc = (crc << 1) & 0x1F
		if (top ^ bit) == 1:
			crc ^= 0x05
	return crc


## Like normalize() but for the 11-character direct codes; "" when the input cannot be one.
static func normalize_dc1(input: String) -> String:
	var s := ""
	for ch in input:
		var c := ch.unicode_at(0)
		if c == 0x20 or c == 0x2D:
			continue
		if c >= 0x61 and c <= 0x7A:
			c -= 32
		if c == 0x49 or c == 0x4C:
			c = 0x31
		elif c == 0x4F:
			c = 0x30
		if c > 0x7F or ALPHABET.find(char(c)) < 0:
			return ""
		s += char(c)
	return s if s.length() == DC1_LENGTH else ""


static func _dc1_from_data(data: int) -> String:
	var v := (data << 5) | crc5(data, 50)
	var s := ""
	for _i in DC1_LENGTH:
		s = ALPHABET[v & 31] + s
		v >>= 5
	return s


## "A1B2C3D4E5F6" (12 hex digits) -> the canonical 11 characters, or "" for a bad room.
static func encode_room_raw(room_hex: String) -> String:
	if room_hex.length() != 12 or not room_hex.is_valid_hex_number(false):
		return ""
	return _dc1_from_data((VERSION_ROOM << 48) | room_hex.hex_to_int())


static func group(raw: String) -> String:
	return raw.substr(0, 4) + "-" + raw.substr(4, 4) + "-" + raw.substr(8)


## Display form of a room code: "D1PB-1X9S-FPV".
static func encode_room(room_hex: String) -> String:
	var raw := encode_room_raw(room_hex)
	return "" if raw == "" else group(raw)


## A fresh random room (12 lower-case hex digits) from the CSPRNG.
static func random_room() -> String:
	return Crypto.new().generate_random_bytes(6).hex_encode()


## {room: "a1b2c3d4e5f6"} for a version 1 code, {ip: "1.2.3.4", port: 47810} for version 0, {error: "bad_code"} or
## {error: "unknown_version"} otherwise.
static func decode_dc1(input: String) -> Dictionary:
	var s := normalize_dc1(input)
	if s == "":
		return {"error": "bad_code"}
	var v := 0
	for ch in s:
		v = (v << 5) | ALPHABET.find(ch)
	var data := v >> 5
	if crc5(data, 50) != (v & 31):
		return {"error": "bad_code"}
	var version := data >> 48
	if version == VERSION_ROOM:
		return {"room": ("%012x" % (data & 0xFFFFFFFFFFFF))}
	if version != VERSION_IPV4:
		return {"error": "unknown_version"}
	var port := data & 0xFFFF
	if port == 0:
		return {"error": "bad_code"}
	var ip := (data >> 16) & 0xFFFFFFFF
	return {"ip": "%d.%d.%d.%d" % [ip >> 24, (ip >> 16) & 255, (ip >> 8) & 255, ip & 255], "port": port}


## {ip, port} for a typed IPv4 address "1.2.3.4" or "1.2.3.4:47810" (port default 47810), {error: "bad_address"} otherwise.
static func parse_address(input: String) -> Dictionary:
	var s := input.strip_edges()
	var port := 47810
	if s.contains(":"):
		var halves := s.split(":")
		if halves.size() != 2 or not halves[1].is_valid_int():
			return {"error": "bad_address"}
		s = halves[0]
		port = int(halves[1])
	if encode_ip(s, port) == "":
		return {"error": "bad_address"}
	return {"ip": s, "port": port}


static func encode_ip(ip: String, port: int) -> String:
	var parts := ip.split(".")
	if parts.size() != 4 or port < 1 or port > 65535:
		return ""
	var n := 0
	for p in parts:
		if not p.is_valid_int() or int(p) < 0 or int(p) > 255:
			return ""
		n = (n << 8) | int(p)
	return group(_dc1_from_data((VERSION_IPV4 << 48) | (n << 16) | port))
