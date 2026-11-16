class_name OneLobbySettings
extends RefCounted
## The player's own multiplayer settings (spec/settings.md): a name, a relay line, the last join code and a lobby server
## address, kept on the player's machine in the same key/value store as the player id (`client.store`, by default
## user://onelobby.json) under `onelobby.settings.<game_id>`, and applied by `OneLobbyClient` as defaults. Nothing here is
## sent anywhere: a setting leaves the machine only as the value a call already sends (the name in `hello`, the ICE entry).
##
##     client.settings.save({"name": "Sam", "relay": field.text})   # {ok, rejected: ["relay"]} when it is not a relay line
##     field.text = client.settings.masked_relay()                 # turn:relay.example.com:3478 <hidden> <hidden>
##
## Values are Dictionaries {name, relay, last_code, server}; an empty string is "none". The stored JSON calls the third
## field `lastCode`, like JS and C#.

const FIELDS: Array[String] = ["name", "relay", "last_code", "server"]
## The stored (JSON) name of each field.
const STORED := {"name": "name", "relay": "relay", "last_code": "lastCode", "server": "server"}
## The environment variable that overrides each field for one run (spec/settings.md s.3).
const ENV := {"name": "ONELOBBY_NAME", "relay": "ONELOBBY_RELAY", "last_code": "ONELOBBY_LAST_CODE", "server": "ONELOBBY_LOBBY_SERVER"}
## What a masked relay shows in place of the user name and the credential (spec/diagnostics.md s.6).
const HIDDEN := "<hidden>"
## The fixed warning for a saved relay line that does not parse. It never holds the line.
const RELAY_SKIPPED_WARNING := "The saved relay line is not valid, so it is not used."

var store: OneLobbyStore
var game_id := ""
## null: read `OS.get_environment`; a Dictionary: that fixed map of variables (tests; {} reads none).
var env: Variant = null
var _last_written := ""
var _has_written := false


## Settings of `game_id` in `store` (null: memory). `env`: null for the real environment, or a fixed map of variables.
static func create(p_store: OneLobbyStore, p_game_id: String, p_env: Variant = null) -> OneLobbySettings:
	var s := OneLobbySettings.new()
	s.store = p_store if p_store != null else OneLobbyStore.memory()
	s.game_id = p_game_id
	s.env = p_env
	return s


## The store key of a game's settings (same as JS and C#).
static func key(p_game_id: String) -> String:
	return "onelobby.settings." + p_game_id


# ---- cleaning (spec/settings.md s.1): a String, or null when invalid ----------------------------------------------------

## Name rules steps 1-3 (spec/room.md 4.1); exactly `Player` counts as no name.
static func clean_name(input: Variant, max_length: int = 24) -> String:
	if not input is String:
		return ""
	var n := OneLobbyRoomRules.clamp_cp(OneLobbyRoomRules.clean_text(input), maxi(1, mini(24, max_length)))
	return "" if n == "Player" else n


## The relay line trimmed, or null when it is not empty and `OneLobbyTurn.parse_line` rejects it.
static func clean_relay(input: Variant) -> Variant:
	if not input is String:
		return null
	var t := (input as String).strip_edges()
	if t.is_empty():
		return ""
	return t if OneLobbyTurn.parse_line(t)["ok"] else null


## A lobby code (6 characters) or direct join code (11) the way a pasted code is cleaned, or null.
static func clean_last_code(input: Variant) -> Variant:
	if not input is String:
		return null
	var t := (input as String).strip_edges()
	if t.is_empty():
		return ""
	var six := OneLobbyJoinCode.normalize(t)
	if six != "":
		return six
	var eleven := OneLobbyJoinCode.normalize_dc1(t)
	return eleven if eleven != "" else null


## The lobby server address as a ws(s) URL (the `<one-lobby server>` rule plus a port check), "" for none, or null.
static func clean_server(input: Variant) -> Variant:
	if not input is String:
		return null
	var t := (input as String).strip_edges()
	if t.is_empty():
		return ""
	if RegEx.create_from_string("\\s").search(t) != null:
		return null
	if RegEx.create_from_string("(?i)your[-_ ]?(lobby[-_ ]?)?server|replace[-_ ]?me|<|>").search(t) != null:
		return null
	var url := t
	if RegEx.create_from_string("(?i)^https?://").search(url) != null:
		url = "ws" + url.substr(4)
	elif RegEx.create_from_string("(?i)^wss?://").search(url) == null:
		url = "wss://" + url
	var m := RegEx.create_from_string("(?i)^wss?://(?:[^/?#@]*@)?(\\[[^\\]]*\\]|[^/?#:]*)(?::(\\d*))?(?:[/?#]|$)").search(url)
	if m == null:
		return null
	var host := m.get_string(1)
	if RegEx.create_from_string("^(\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9._-]+)$").search(host) == null:
		return null
	var after := m.get_end(1)
	if after < url.length() and url[after] == ":":
		var port := m.get_string(2)
		if port.is_empty() or port.length() > 5 or not port.is_valid_int() or int(port) < 1 or int(port) > 65535:
			return null
	var h := host.to_lower()
	if RegEx.create_from_string("(^|\\.)example\\.(com|net|org)$|\\.example$").search(h) != null or h == "example":
		return null
	if not h.contains(".") and not h.contains(":") and h != "localhost":
		return null
	return url


## `clean_name` / `clean_relay` / `clean_last_code` / `clean_server` by field name; null = invalid.
static func clean(field: String, input: Variant) -> Variant:
	match field:
		"name":
			return clean_name(input)
		"relay":
			return clean_relay(input)
		"last_code":
			return clean_last_code(input)
		"server":
			return clean_server(input)
	return null


## The relay line for showing in a settings field: the URLs stay readable, the user name and the credential are `<hidden>`
## (spec/settings.md s.4). Empty stays empty; a line that does not parse is `<hidden>` whole.
static func mask_relay(line: String) -> String:
	var t := line.strip_edges()
	if t.is_empty():
		return ""
	var r := OneLobbyTurn.parse_line(t)
	if not r["ok"]:
		return HIDDEN
	var e: Dictionary = r["server"]
	var urls: Array = e["urls"]
	var parts: PackedStringArray = [",".join(PackedStringArray(urls))]
	if e.has("username"):
		parts.append(HIDDEN)
	if e.has("credential"):
		parts.append(HIDDEN)
	return " ".join(parts)


## The ICE entry ({urls, username?, credential?}) for a relay line, or {} when it is empty or invalid.
static func relay_entry(line: String) -> Dictionary:
	var t := line.strip_edges()
	if t.is_empty():
		return {}
	var r := OneLobbyTurn.parse_line(t)
	return r["server"] if r["ok"] else {}


## `user:pass@` dropped from an address before it goes in a log.
static func redact_url(url: String) -> String:
	return RegEx.create_from_string("(?i)^([a-z][a-z0-9+.-]*://)[^/?#]*@").sub(url, "$1")


# ---- the store -----------------------------------------------------------------------------------------------------------

func _raw_text() -> String:
	var v: Variant = store.get_item(key(game_id))
	if v is String:
		return v
	return _last_written if _has_written else ""


## The stored object, or {} for nothing, unreadable text or anything that is not an object.
func _raw_object() -> Dictionary:
	var text := _raw_text()
	if text.is_empty():
		return {}
	var j := JSON.new() # parse() reports a corrupt value as an error code, where parse_string() also logs one
	return (j.data as Dictionary).duplicate(true) if j.parse(text) == OK and j.data is Dictionary else {}


## The stored values, cleaned; a missing, corrupt or odd value reads as empty. Never errors.
func load_values() -> Dictionary:
	var o := _raw_object()
	var out := {}
	for f in FIELDS:
		var c: Variant = clean(f, o.get(STORED[f]))
		out[f] = c if c is String else ""
	return out


func _env_value(field: String) -> String:
	var raw := ""
	if env is Dictionary:
		raw = str((env as Dictionary).get(ENV[field], ""))
	else:
		raw = OS.get_environment(ENV[field])
	return "" if raw.strip_edges().is_empty() else raw


## The values this run uses: a clean, non-empty environment variable over the stored value (never written back).
func effective() -> Dictionary:
	var out := load_values()
	for f in FIELDS:
		var e := _env_value(f)
		if e.is_empty():
			continue
		var c: Variant = clean(f, e)
		if c is String and c != "":
			out[f] = c
	return out


## Writes the fields in `patch` ({name?, relay?, last_code?, server?}; an empty value removes one); every unknown field already
## stored is kept. A field that does not clean is not written and is listed in `rejected` (never its text). Never errors; a
## store that cannot write keeps the values for the session. Returns {ok, rejected}.
func save(patch: Dictionary) -> Dictionary:
	var o := _raw_object()
	var rejected: Array = []
	for f in FIELDS:
		if not patch.has(f) or patch[f] == null:
			continue
		var c: Variant = clean(f, patch[f])
		if c == null:
			rejected.append(f)
		elif c == "":
			o.erase(STORED[f])
		else:
			o[STORED[f]] = c
	var v: Variant = o.get("v")
	var has_version: bool = (typeof(v) == TYPE_INT) or (typeof(v) == TYPE_FLOAT and v == floorf(v))
	if not has_version:
		o["v"] = 1
	var text := OneLobbyRoomWire.json_text(o)
	_last_written = text
	_has_written = true
	store.set_item(key(game_id), text)
	return {"ok": rejected.is_empty(), "rejected": rejected}


## Forgets every saved setting (unknown fields too).
func clear() -> void:
	_last_written = ""
	_has_written = false
	store.remove_item(key(game_id))


## The relay line this run uses, masked for a settings field (see `mask_relay`).
func masked_relay() -> String:
	return mask_relay(str(effective()["relay"]))


## {entry, invalid}: the ICE entry of the effective relay line ({} when none), and whether a relay line is set that does not
## parse (stored or environment: skipped, so the caller warns once).
func relay_status() -> Dictionary:
	var stored: Variant = _raw_object().get("relay")
	var e := _env_value("relay")
	var invalid: bool = (stored is String and not (stored as String).strip_edges().is_empty() and clean_relay(stored) == null) \
		or (not e.is_empty() and clean_relay(e) == null)
	return {"entry": relay_entry(str(effective()["relay"])), "invalid": invalid}
