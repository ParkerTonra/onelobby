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
