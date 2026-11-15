class_name OneLobbyInvite
extends RefCounted
## Invite links: a web address that opens the game straight into a lobby, e.g. https://game.example/?join=7HQ-4K2.
## Same format and behaviour as the JS client's `shareUrl` / `codeFromUrl` and C#'s `InviteLink` (spec/vectors/invite-link.json
## is the shared test). Only the lobby code of a server lobby travels in a link; registering the link with the operating
## system (a deep link) is the game's job. Nothing here touches the network.
##
##     var link := OneLobbyInvite.make(lobby.code, "https://game.example/play")   # ...play?join=7HQ-4K2
##     var code := OneLobbyInvite.parse(pasted_text)                              # "7HQ4K2", or "" if there is none
##     if code != "": await client.join(code)

static var _absolute: RegEx = null


## A link that opens the game into lobby `code`: `base_url` (an absolute http or https address) with any existing `param`
## replaced by the code in display form with a hyphen ("7HQ-4K2"), so the link survives chat apps that turn a space into
## "+" or "%20". The fragment is kept. Returns "" (and pushes no error) for a code that is not a lobby code or a base that
## is not absolute http(s); check the result before showing it.
static func make(code: String, base_url: String, param: String = "join") -> String:
	var norm := OneLobbyJoinCode.normalize(code)
	if norm.is_empty():
		return ""
	if _absolute == null:
		_absolute = RegEx.create_from_string("(?is)^(https?)://([^/?#]*)([^?#]*)(?:\\?([^#]*))?(?:#(.*))?\\z")
	var m := _absolute.search(_trim(base_url))
	if m == null:
		return ""
	var pairs := _parse_query(m.get_string(4))
	var kept: Array = []
	for p: Array in pairs:
		if p[0] != param:
			kept.append(p)
	kept.append([param, OneLobbyJoinCode.display(norm).replace(" ", "-")])
	var path := m.get_string(3)
	if path.is_empty():
		path = "/"
	var fragment := "#" + m.get_string(5) if m.get_start(5) >= 0 else ""
	return "%s://%s%s?%s%s" % [m.get_string(1).to_lower(), m.get_string(2).to_lower(), path, _serialize_query(kept), fragment]


## The lobby code (canonical form, "7HQ4K2") carried by a pasted link, or "" when there is none or it is not a code.
## Reads the first `param` entry of the query, else (only when the query has no such key) of the fragment; "+" and "%20"
## are spaces, case and i / l / o look-alikes are forgiven, surrounding whitespace is trimmed. A relative link
## ("?join=...") works too. Nothing else is cleaned: a trailing dot or angle brackets make the code invalid.
static func parse(text: String, param: String = "join") -> String:
	var s := _trim(text)
	if s.is_empty():
		return ""
	var hash := s.find("#")
	var fragment := s.substr(hash + 1) if hash >= 0 else ""
	var before := s.substr(0, hash) if hash >= 0 else s
	var q := before.find("?")
	var query := before.substr(q + 1) if q >= 0 else ""
	var v: Variant = _first(_parse_query(query), param)
	if v == null:
		v = _first(_parse_query(fragment), param)
	if v == null or str(v).is_empty():
		return ""
	return OneLobbyJoinCode.normalize(str(v))


static func _first(pairs: Array, key: String) -> Variant:
	for p: Array in pairs:
		if p[0] == key:
			return p[1]
	return null


## What a URL parser does with its input: drop tabs and line breaks anywhere and control characters and spaces at the ends.
static func _trim(s: String) -> String:
	var t := s.replace("\t", "").replace("\r", "").replace("\n", "")
	var a := 0
	var b := t.length()
	while a < b and t.unicode_at(a) <= 0x20:
		a += 1
	while b > a and t.unicode_at(b - 1) <= 0x20:
		b -= 1
	return t.substr(a, b - a)


# application/x-www-form-urlencoded, as URLSearchParams reads and writes it

static func _parse_query(q: String) -> Array:
	var out: Array = []
	for seg in q.split("&"):
		if seg.is_empty():
			continue
		var eq := seg.find("=")
		out.append([_decode(seg.substr(0, eq) if eq >= 0 else seg), _decode(seg.substr(eq + 1) if eq >= 0 else "")])
	return out


static func _decode(s: String) -> String:
	var src := s.to_utf8_buffer()
	var out := PackedByteArray()
	var i := 0
	while i < src.size():
		var c := src[i]
		if c == 0x2B:
			out.append(0x20)
		elif c == 0x25 and i + 2 < src.size() and _hex(src[i + 1]) >= 0 and _hex(src[i + 2]) >= 0:
			out.append(_hex(src[i + 1]) * 16 + _hex(src[i + 2]))
			i += 2
		else:
			out.append(c)
		i += 1
	return out.get_string_from_utf8()


static func _hex(c: int) -> int:
	if c >= 0x30 and c <= 0x39:
		return c - 0x30
	if c >= 0x61 and c <= 0x66:
		return c - 0x61 + 10
	if c >= 0x41 and c <= 0x46:
		return c - 0x41 + 10
	return -1


static func _serialize_query(pairs: Array) -> String:
	var parts := PackedStringArray()
	for p: Array in pairs:
		parts.append(_encode(p[0]) + "=" + _encode(p[1]))
	return "&".join(parts)


static func _encode(s: String) -> String:
	var out := ""
	for b in s.to_utf8_buffer():
		if b == 0x20:
			out += "+"
		elif (b >= 0x61 and b <= 0x7A) or (b >= 0x41 and b <= 0x5A) or (b >= 0x30 and b <= 0x39) or b == 0x2A or b == 0x2D or b == 0x2E or b == 0x5F:
			out += char(b)
		else:
			out += "%%%02X" % b
	return out
