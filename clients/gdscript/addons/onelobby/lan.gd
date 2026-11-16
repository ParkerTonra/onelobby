class_name OneLobbyLan
extends RefCounted
## LAN discovery wire (spec/lan-discovery.md): the two datagrams, the limits, the source-address rule and the name rule.
## The host side is OneLobbyLanHost (rules in OneLobbyLanAnswerer), the player's side OneLobbyLanFinder.

const DEFAULT_PORT := 47840
const WIRE_VERSION := 1
const MAX_DATAGRAM := 512
const NAME_UNITS := 24
## Finder timers (ms) and limits.
const ASK_INTERVAL_MS := 1000
const MIN_GAP_MS := 400
const ROW_TIMEOUT_MS := 4000
const MAX_ROWS := 64
const NONCES_KEPT := 8
## Host limits: answers per source address and in total per RATE_WINDOW_MS; duplicate memory.
const RATE_PER_SOURCE := 3
const RATE_TOTAL := 50
const RATE_WINDOW_MS := 1000
const DUPLICATE_MS := 5000
const DUPLICATES_KEPT := 32
## [min, max] bytes of each string field.
const LIMIT_GAME_ID := [1, 64]
const LIMIT_NET_VERSION := [1, 32]
const LIMIT_NAME := [0, 72]

const _TYPE_QUESTION := 1
const _TYPE_ANSWER := 2


static func fits(s: String, limit: Array) -> bool:
	var n := s.to_utf8_buffer().size()
	return n >= int(limit[0]) and n <= int(limit[1])


## The question datagram; empty when `nonce` is not 8 bytes or the game id does not fit.
static func encode_question(nonce: PackedByteArray, game_id: String) -> PackedByteArray:
	if nonce.size() != 8:
		return PackedByteArray()
	var b := _header(_TYPE_QUESTION, nonce)
	if not _put_str(b, game_id, LIMIT_GAME_ID):
		return PackedByteArray()
	return b


## The answer datagram from {nonce, port, players, max_players, password, game_id, net_version, lobby_name, host_name};
## empty when a field is out of range or a string does not fit.
static func encode_answer(a: Dictionary) -> PackedByteArray:
	var nonce: PackedByteArray = a["nonce"]
	var port := int(a["port"])
	var players := int(a["players"])
	var max_players := int(a["max_players"])
	if nonce.size() != 8 or port < 1 or port > 65535 or max_players < 1 or max_players > 255 or players < 0 or players > max_players:
		return PackedByteArray()
	var b := _header(_TYPE_ANSWER, nonce)
	b.append(port >> 8)
	b.append(port & 255)
	b.append(players)
	b.append(max_players)
	b.append(1 if bool(a["password"]) else 0)
	if not (_put_str(b, str(a["game_id"]), LIMIT_GAME_ID) and _put_str(b, str(a["net_version"]), LIMIT_NET_VERSION)
			and _put_str(b, str(a["lobby_name"]), LIMIT_NAME) and _put_str(b, str(a["host_name"]), LIMIT_NAME)):
		return PackedByteArray()
	return b


## {nonce, game_id} or {} when the datagram is not a well-formed question.
static func decode_question(b: PackedByteArray) -> Dictionary:
	var nonce := _read_header(b, _TYPE_QUESTION)
	if nonce.is_empty():
		return {}
	var g := _read_str(b, 14, LIMIT_GAME_ID)
	if g.is_empty() or int(g[1]) != b.size():
		return {}
	return {"nonce": nonce, "game_id": g[0]}


## {nonce, port, players, max_players, password, game_id, net_version, lobby_name, host_name} or {} when malformed.
static func decode_answer(b: PackedByteArray) -> Dictionary:
	var nonce := _read_header(b, _TYPE_ANSWER)
	if nonce.is_empty() or b.size() < 19:
		return {}
	var port := (b[14] << 8) | b[15]
	var players := int(b[16])
	var max_players := int(b[17])
	if port < 1 or max_players < 1 or players > max_players:
		return {}
	var at := 19
	var out: Array = []
	for limit: Array in [LIMIT_GAME_ID, LIMIT_NET_VERSION, LIMIT_NAME, LIMIT_NAME]:
		var r := _read_str(b, at, limit)
		if r.is_empty():
			return {}
		out.append(r[0])
		at = int(r[1])
	if at != b.size():
		return {}
	return {"nonce": nonce, "port": port, "players": players, "max_players": max_players, "password": (b[18] & 1) != 0,
		"game_id": out[0], "net_version": out[1], "lobby_name": out[2], "host_name": out[3]}


## "loopback", "private" or "link_local" for an IPv4 source address; "" for a public (or non-IPv4) one.
static func source_class(ip: String) -> String:
	var parts := ip.split(".")
	if parts.size() != 4:
		return ""
	var n: Array[int] = []
	for p in parts:
		if p.length() == 0 or p.length() > 3 or not p.is_valid_int() or p.begins_with("-") or p.begins_with("+"):
			return ""
		n.append(int(p))
	for x in n:
		if x > 255:
			return ""
	if n[0] == 127:
		return "loopback"
	if n[0] == 10 or (n[0] == 172 and n[1] >= 16 and n[1] <= 31) or (n[0] == 192 and n[1] == 168):
		return "private"
	if n[0] == 169 and n[1] == 254:
		return "link_local"
	return ""


## The hub's name rule: control characters and bidi overrides out, at most 24 UTF-16 units.
static func clean_name(s: String) -> String:
	return OneLobbyHub.sanitize(s, NAME_UNITS, "")


## Where a finder asks by default: the limited broadcast 255.255.255.255. Godot gives no netmask for a network card, so the
## directed broadcast addresses the JS and C# finders add are not known here.
static func broadcast_targets() -> PackedStringArray:
	return PackedStringArray(["255.255.255.255"])


## True when `b` is valid UTF-8 (no overlong forms, no surrogates, nothing above U+10FFFF).
static func valid_utf8(b: PackedByteArray) -> bool:
	var i := 0
	var n := b.size()
	while i < n:
		var c := int(b[i])
		if c < 0x80:
			i += 1
			continue
		var need := 0
		var cp := 0
		var min_cp := 0
		if c >= 0xC2 and c <= 0xDF:
			need = 1
			cp = c & 0x1F
			min_cp = 0x80
		elif c >= 0xE0 and c <= 0xEF:
			need = 2
			cp = c & 0x0F
			min_cp = 0x800
		elif c >= 0xF0 and c <= 0xF4:
			need = 3
			cp = c & 0x07
			min_cp = 0x10000
		else:
			return false
		if i + need >= n:
			return false
		for k in range(1, need + 1):
			var d := int(b[i + k])
			if (d & 0xC0) != 0x80:
				return false
			cp = (cp << 6) | (d & 0x3F)
		if cp < min_cp or cp > 0x10FFFF or (cp >= 0xD800 and cp <= 0xDFFF):
			return false
		i += need + 1
	return true


static func _header(type: int, nonce: PackedByteArray) -> PackedByteArray:
	var b := PackedByteArray([0x4F, 0x4C, 0x41, 0x4E, WIRE_VERSION, type])
	b.append_array(nonce)
	return b


static func _put_str(b: PackedByteArray, s: String, limit: Array) -> bool:
	var u := s.to_utf8_buffer()
	if u.size() < int(limit[0]) or u.size() > int(limit[1]):
		return false
	b.append(u.size())
	b.append_array(u)
	return true


static func _read_header(b: PackedByteArray, type: int) -> PackedByteArray:
	if b.size() < 14 or b.size() > MAX_DATAGRAM:
		return PackedByteArray()
	if b[0] != 0x4F or b[1] != 0x4C or b[2] != 0x41 or b[3] != 0x4E or b[4] != WIRE_VERSION or b[5] != type:
		return PackedByteArray()
	return b.slice(6, 14)


## [string, next index] or [] when the field is missing, out of its limit, cut short or not UTF-8.
static func _read_str(b: PackedByteArray, at: int, limit: Array) -> Array:
	if at >= b.size():
		return []
	var n := int(b[at])
	if n < int(limit[0]) or n > int(limit[1]) or at + 1 + n > b.size():
		return []
	var raw := b.slice(at + 1, at + 1 + n)
	if not valid_utf8(raw):
		return []
	return [raw.get_string_from_utf8(), at + 1 + n]
