class_name OneLobbyConfig
extends RefCounted
## The settings file onelobby.json (spec/blueprint.schema.json, docs/design/blueprint.md): validated, every default
## filled in, read-only. The same fields and defaults as the JS `parseBlueprint` and C# `Blueprint.Load`; the shared
## vectors (spec/vectors/blueprint.json) test all three.
##
##     var cfg := OneLobbyConfig.load_file()           # res://onelobby.json
##     if not cfg.ok: push_error(cfg.error["message"]) # {code: "bad_config", path, rule, message}
##     var client := OneLobbyClient.from_config(cfg, {"display_name": "Sam"})
##     add_child(client)
##     var lobby := await client.host()                # or: await client.join(code)
##
## Loading never throws: a bad file gives a config with `ok == false` and `error` set (the other fields are then
## empty). `OneLobbyClient.from_config` accepts a bad one too and fails its first host / join / list with that error.
## The file must be in the export: add `*.json` (or onelobby.json) to the export preset's "Filters to export non-resource files".
##
## Sections are Dictionaries with snake_case keys (JS: `hosting.lobbyServer`, here `hosting["lobby_server"]`); `data` is
## the same tree with the file's own camelCase keys. Optional keys that are absent in the file are absent (`title`,
## `engine`, `session["rate_limit"]`, `ui["entry"]`); `title` and `engine` read as "" here.
##
## GDScript runs "raw" and "lockstep" (`lobby.lockstep`); it has no replication (C# only): a file whose `sync.mode` is
## "replication" parses fine (other engines read the same file) but `check_gdscript()` and `OneLobbyClient.from_config` fail
## with the stable rule `gdscript_raw_only` (the name is from when lockstep was missing too; kept so games can match it).

const DEFAULT_PATH := "res://onelobby.json"
## `error["code"]` of every failure here (JS and C#: `bad_config`).
const BAD_CONFIG := "bad_config"
## `error["rule"]` of the unsupported sync mode "replication" (see check_gdscript).
const RULE_RAW_ONLY := "gdscript_raw_only"

## Default public Nostr relays: the same list, in the same order, as the JS `DEFAULT_NOSTR_RELAYS` and C# `Blueprint.DefaultNostrRelays`.
const DEFAULT_NOSTR_RELAYS: Array[String] = [
	"wss://nos.lol", "wss://relay.primal.net", "wss://nostr-pub.wellorder.net", "wss://nostr.oxtr.dev",
	"wss://nostr.bitcoiner.social", "wss://relay.nostr.net", "wss://nostr.sathoarder.com",
]

## True when the file was read and is a valid blueprint.
var ok := false
## {code, path, rule, message} when `ok` is false, else {}. `path` is dotted ("" = the file), `rule` a vector rule id
## (type, required, unknown_key, enum, const, range, length, pattern, json, file, or a cross-key rule from the schema).
var error := {}
## The validated file with defaults filled in, keys as in the file (camelCase). Round-trips through parse().
var data := {}

var game_id := ""
var net_version := "1"
var title := ""
## "web", "node-browser", "godot-csharp", "godot-gdscript", "unity", "dotnet", or "" when the file names none.
var engine := ""
var hosting := {}
var lobby := {}
## The room layer's section (spec/room.md 10), snake_case: password_required, auto_start, auto_start_players, min_players,
## countdown_seconds, spectators, late_join, seat_dropped, rejoin_window_seconds and `data` (the declarations as in the file).
var room := {}
var sync := {}
var players := {}
var chat := {}
var session := {}
var platforms := {}
var ui := {}
## The diagnostics switches (spec/diagnostics.md): report_to_host, log_size (50 to 5000), relay_probe, show_connection_check
## (the drop-in menu's Connection check button). `from_config` applies the first three to the client.
var diagnostics := {}

static var _root: Dictionary = {}


## Reads and validates `path` (default res://onelobby.json).
static func load_file(path: String = DEFAULT_PATH) -> OneLobbyConfig:
	if not FileAccess.file_exists(path):
		return _failed("", "file", "cannot read %s (is it in the project, and in the export's non-resource filters?)" % path)
	return parse(FileAccess.get_file_as_string(path))


## Validates `source`: the file's text (String) or an already-parsed Dictionary.
static func parse(source: Variant) -> OneLobbyConfig:
	var json: Variant = source
	if source is String:
		var p := JSON.new()
		if p.parse(source) != OK:
			return _failed("", "json", "not valid JSON: %s (line %d)" % [p.get_error_message(), p.get_error_line()])
		json = p.data
	if _root.is_empty():
		_root = _schema()
	var bad := _check(_root, json, "")
	if not bad.is_empty():
		return _failed(bad["path"], bad["rule"], bad["detail"])
	var cfg := OneLobbyConfig.new()
	var stripped := _strip(json) as Dictionary
	cfg.data = _fill(stripped)
	bad = _cross_rules(cfg.data, stripped)
	if not bad.is_empty():
		return _failed(bad["path"], bad["rule"], bad["detail"])
	cfg._publish()
	return cfg


## {} when this client can run the file, else the failure ({code, path, rule: "gdscript_raw_only", message}): the GDScript
## client speaks "raw" and "lockstep"; "replication" is in the C# client (OneLobby.Replication).
func check_gdscript() -> Dictionary:
	var m := str(sync.get("mode", "raw"))
	if not ok or m == "raw" or m == "lockstep":
		return {}
	return _error("sync.mode", RULE_RAW_ONLY, "the GDScript client supports \"raw\" and \"lockstep\", not \"%s\" (replication is in the C# client)" % m)


## {} when `display_name` is allowed by `players.*`, else the failure: `identity_anonymous` (a name for an anonymous game)
## or `bad_config` at path `displayName` (longer than `players.maxNameLength`).
func check_display_name(display_name: String) -> Dictionary:
	var n := display_name.strip_edges()
	if n.is_empty():
		return {}
	if str(players.get("identity", "name")) == "anonymous":
		return {"code": "identity_anonymous", "path": "", "rule": "identity_anonymous", "message": "this game uses anonymous players: no display names"}
	if n.length() > int(players.get("max_name_length", 24)):
		return _error("displayName", "length", "must be at most %d characters" % int(players.get("max_name_length", 24)))
	return {}


## Options for `OneLobbyClient.host()` that the file implies: name ("<display_name>'s game", else "Game"), max_players,
## visibility (listed: "public", approve_joins: "private", else "unlisted"), late_join, meta, rate_limit.
func host_options(display_name: String = "") -> Dictionary:
	var n := display_name.strip_edges()
	var o := {
		"name": "%s's game" % n if not n.is_empty() else "Game",
		"max_players": lobby["max_players"],
		"visibility": "public" if lobby["listed"] else ("private" if lobby["approve_joins"] else "unlisted"),
		"late_join": lobby["late_join"],
		"meta": (lobby["meta"] as Dictionary).duplicate(),
	}
	if session.has("rate_limit"):
		o["rate_limit"] = (session["rate_limit"] as Dictionary).duplicate()
	return o


## The room layer options the file implies, as OneLobbyClient.host() takes them under `room`: the `room` section plus
## `max_name_length` (players.maxNameLength).
func room_options() -> Dictionary:
	var o := room.duplicate(true)
	o["max_name_length"] = int(players.get("max_name_length", 24))
	return o


## Options for `OneLobbyClient.host_direct()`: host_options() minus visibility, plus tcp_port (hosting.directPort), nostr
## and relays (hosting.nostrRelays; left out when empty, which means the library list).
func direct_options(display_name: String = "") -> Dictionary:
	var o := host_options(display_name)
	o.erase("visibility")
	o["tcp_port"] = hosting["direct_port"]
	o["nostr"] = hosting["nostr"]
	if not (hosting["nostr_relays"] as Array).is_empty():
		o["relays"] = (hosting["nostr_relays"] as Array).duplicate()
	return o


## The value at a dotted path of `data` ("hosting.lobbyServer", camelCase as in the file), or null when absent.
func value_at(path: String) -> Variant:
	var cur: Variant = data
	for part in path.split("."):
		if cur is Dictionary and (cur as Dictionary).has(part):
			cur = (cur as Dictionary)[part]
		elif cur is Array and part.is_valid_int() and int(part) < (cur as Array).size():
			cur = (cur as Array)[int(part)]
		else:
			return null
	return cur


## The validated file with defaults filled in, as text. Round-trips through parse().
func to_json() -> String:
	return JSON.stringify(data, "  ")


# ------------------------------------------------------------------------------------------------ failure and fields

static func _error(path: String, rule: String, detail: String) -> Dictionary:
	return {"code": BAD_CONFIG, "path": path, "rule": rule, "message": "onelobby.json: %s%s" % [path + ": " if not path.is_empty() else "", detail]}


static func _failed(path: String, rule: String, detail: String) -> OneLobbyConfig:
	var c := OneLobbyConfig.new()
	c.error = _error(path, rule, detail)
	return c


func _publish() -> void:
	ok = true
	var g: Dictionary = data["game"]
	game_id = g["id"]
	net_version = g["netVersion"]
	title = str(g.get("title", ""))
	engine = str(data.get("engine", ""))
	hosting = _snake(data["hosting"], [])
	lobby = _snake(data["lobby"], ["meta"])
	room = _snake(data["room"], ["data"])
	sync = _snake(data["sync"], [])
	players = _snake(data["players"], [])
	chat = _snake(data["chat"], [])
	session = _snake(data["session"], [])
	platforms = _snake(data["platforms"], ["epic"])
	ui = _snake(data["ui"], [])
	diagnostics = _snake(data["diagnostics"], [])


## Keys camelCase -> snake_case; the values of `keep` (user data) are copied as they are.
static func _snake(d: Dictionary, keep: Array) -> Dictionary:
	var out := {}
	for k: String in d:
		var v: Variant = d[k]
		if v is Dictionary and not keep.has(k):
			v = _snake(v, [])
		elif v is Array:
			v = (v as Array).duplicate()
		elif v is Dictionary:
			v = (v as Dictionary).duplicate(true)
		out[_snake_key(k)] = v
	return out


static func _snake_key(k: String) -> String:
	var s := ""
	for i in k.length():
		var c := k[i]
		if c != c.to_lower():
			s += "_" + c.to_lower()
		else:
			s += c
	return s


# ------------------------------------------------------------------------------------------------ schema as data
# Same tree and key order as clients/js/packages/client/src/blueprint.ts (= spec/blueprint.schema.json).

static func _obj(props: Dictionary, req: Array = []) -> Dictionary:
	return {"k": "obj", "props": props, "req": req}


static func _str(min_len: int = -1, max_len: int = -1, pattern: String = "") -> Dictionary:
	return {"k": "str", "min": min_len, "max": max_len, "pattern": pattern}


static func _int(min_v: Variant = null, max_v: Variant = null, zero_or: bool = false) -> Dictionary:
	return {"k": "int", "min": min_v, "max": max_v, "zero_or": zero_or}


static func _enum(vals: Array) -> Dictionary:
	return {"k": "enum", "vals": vals}


static func _schema() -> Dictionary:
	var b := {"k": "bool"}
	return _obj({
		"version": {"k": "const", "val": 1},
		"game": _obj({"id": _str(-1, -1, "^[A-Za-z0-9._-]{1,64}\\z"), "netVersion": _str(1, 32), "title": _str(-1, 64)}, ["id"]),
		"engine": _enum(["web", "node-browser", "godot-csharp", "godot-gdscript", "unity", "dotnet"]),
		"hosting": _obj({
			"direct": b, "server": b, "lobbyServer": _str(), "directPort": _int(1024, 65535), "openPort": b, "nostr": b,
			"nostrRelays": {"k": "strarr"}, "relayOnly": b, "allowedOrigins": {"k": "strarr"},
		}),
		"lobby": _obj({
			"maxPlayers": _int(2, 64), "listed": b, "approveJoins": b, "password": b, "lateJoin": b, "rejoin": b, "joinLink": b,
			"meta": {"k": "meta"},
		}),
		"room": _obj({
			"passwordRequired": b, "autoStart": _enum(["off", "all_ready", "players"]), "autoStartPlayers": _int(2, 64),
			"minPlayers": _int(1, 64), "countdownSeconds": _int(0, 60), "spectators": _int(0, 64),
			"lateJoin": _enum(["allow", "spectate", "refuse"]), "seatDropped": _enum(["window", "immediate"]),
			"rejoinWindowSeconds": _int(0, 600), "data": {"k": "roomdata"},
		}),
		"sync": _obj({"mode": _enum(["raw", "lockstep", "replication"]), "tickRate": _int(1, 120), "hashEveryTicks": _int(1, 100000)}),
		"players": _obj({"identity": _enum(["name", "anonymous", "platform"]), "maxNameLength": _int(1, 24)}),
		"chat": _obj({"text": b, "voice": b, "voiceMode": _enum(["pushToTalk", "voiceActivity"])}),
		"session": _obj({
			"hostLeaves": _enum(["end", "migrate"]), "pause": _enum(["off", "host", "anyone"]),
			"readyTimeoutMs": _int(0, 600000), "peerTimeoutMs": _int(6000, 600000, true),
			"rateLimit": {"k": "rate"}, "runInBackground": b,
		}),
		"platforms": _obj({"steam": {"k": "steam"}, "epic": {"k": "epic"}, "discord": b}),
		"ui": _obj({"kind": _enum(["drop-in", "generated", "none"]), "entry": _str(), "theme": _enum(["light", "dark", "auto"])}),
		"diagnostics": _obj({"reportToHost": b, "logSize": _int(50, 5000), "relayProbe": b, "showConnectionCheck": b}),
	}, ["game"])


## `room.data`: at most 16 declarations, each {type, min?, max?, maxLength?, values?, default?, hostOnly?} (spec/room.md 4.2).
static func _check_room_data(v: Variant, path: String) -> Dictionary:
	if not v is Dictionary:
		return _fail(path, "type", "must be an object of data declarations")
	var d: Dictionary = v
	var keys: Array = d.keys().filter(func(k: Variant) -> bool: return str(k) != "$schema" and str(k) != "$comment")
	if keys.size() > 16:
		return _fail(path, "length", "at most 16 keys")
	var decl := _obj({
		"type": _enum(["string", "int", "enum", "bool", "color"]), "min": _int(-2147483647, 2147483647), "max": _int(-2147483647, 2147483647),
		"maxLength": _int(1, 64), "values": {"k": "strarr"}, "default": _str(), "hostOnly": {"k": "bool"},
	}, ["type"])
	for k: Variant in keys:
		var kp := _join(path, k)
		if not OneLobbyRoomRules.is_data_key(str(k)):
			return _fail(kp, "pattern", "key must match ^[a-z][a-z0-9_]{0,23}$")
		var bad := _check(decl, d[k], kp)
		if not bad.is_empty():
			return bad
		var o: Dictionary = d[k]
		if o["type"] == "enum":
			var vals: Variant = o.get("values")
			if not vals is Array or (vals as Array).is_empty():
				return _fail(_join(kp, "values"), "required", "an enum needs values")
			if (vals as Array).size() > 16:
				return _fail(_join(kp, "values"), "length", "at most 16 values")
			for i in (vals as Array).size():
				var n := str(vals[i]).length()
				if n < 1 or n > 32:
					return _fail(_join(_join(kp, "values"), i), "length", "1 to 32 characters")
		if _is_num(o.get("min")) and _is_num(o.get("max")) and o["min"] > o["max"]:
			return _fail(kp, "min_gt_max", "min is more than max")
		if o.get("default") is String and o["default"] != "":
			var d2 := o.duplicate()
			d2["min"] = o["min"] if _is_num(o.get("min")) else 0
			d2["max"] = o["max"] if _is_num(o.get("max")) else 255
			if OneLobbyRoomRules.check_data_value(d2, o["default"]) == null:
				return _fail(_join(kp, "default"), "bad_default", "default fails its own type")
	return {}


static func _fail(path: String, rule: String, detail: String) -> Dictionary:
	return {"path": path, "rule": rule, "detail": detail}


static func _join(p: String, k: Variant) -> String:
	return "%s.%s" % [p, k] if not p.is_empty() else str(k)


static func _is_int(v: Variant) -> bool:
	return typeof(v) == TYPE_INT or (typeof(v) == TYPE_FLOAT and is_finite(v) and v == floorf(v))


static func _is_num(v: Variant) -> bool:
	return typeof(v) == TYPE_INT or typeof(v) == TYPE_FLOAT


## {} when `v` fits node `n`, else the first problem {path, rule, detail}.
static func _check(n: Dictionary, v: Variant, path: String) -> Dictionary:
	match n["k"]:
		"obj":
			if not v is Dictionary:
				return _fail(path, "type", "must be an object")
			var d: Dictionary = v
			for r: String in n["req"]:
				if not d.has(r):
					return _fail(_join(path, r), "required", "is required")
			for k: Variant in d:
				if str(k) != "$schema" and str(k) != "$comment" and not (n["props"] as Dictionary).has(k):
					return _fail(_join(path, k), "unknown_key", "unknown key")
			for k: String in n["props"]:
				if d.has(k):
					var bad := _check(n["props"][k], d[k], _join(path, k))
					if not bad.is_empty():
						return bad
		"str":
			if typeof(v) != TYPE_STRING:
				return _fail(path, "type", "must be a string")
			var s: String = v
			if (int(n["min"]) >= 0 and s.length() < int(n["min"])) or (int(n["max"]) >= 0 and s.length() > int(n["max"])):
				return _fail(path, "length", "must be %d to %s characters" % [maxi(int(n["min"]), 0), str(n["max"]) if int(n["max"]) >= 0 else "any"])
			if not str(n["pattern"]).is_empty():
				var re := RegEx.create_from_string(str(n["pattern"]))
				if re.search(s) == null:
					return _fail(path, "pattern", "must match " + str(n["pattern"]))
		"int":
			if not _is_int(v):
				return _fail(path, "type", "must be an integer")
			if n["zero_or"] and v == 0:
				return {}
			if (n["min"] != null and v < n["min"]) or (n["max"] != null and v > n["max"]):
				return _fail(path, "range", "must be %s%s to %s" % ["0 or " if n["zero_or"] else "", str(n["min"]) if n["min"] != null else "any", str(n["max"]) if n["max"] != null else "any"])
		"bool":
			if typeof(v) != TYPE_BOOL:
				return _fail(path, "type", "must be true or false")
		"enum":
			if typeof(v) != TYPE_STRING or not (n["vals"] as Array).has(v):
				return _fail(path, "enum", "must be one of " + ", ".join(n["vals"]))
		"const":
			if not _is_num(v) or v != n["val"]:
				return _fail(path, "const", "must be %s" % str(n["val"]))
		"strarr":
			if not v is Array:
				return _fail(path, "type", "must be an array of strings")
			for i in (v as Array).size():
				if typeof(v[i]) != TYPE_STRING:
					return _fail(_join(path, i), "type", "must be a string")
		"meta":
			if not v is Dictionary:
				return _fail(path, "type", "must be an object of strings")
			var m: Dictionary = v
			if m.size() > 16:
				return _fail(path, "length", "at most 16 keys")
			for k: Variant in m:
				if str(k).length() > 64:
					return _fail(_join(path, k), "length", "key is longer than 64 characters")
				if typeof(m[k]) != TYPE_STRING:
					return _fail(_join(path, k), "type", "must be a string")
				if (m[k] as String).length() > 64:
					return _fail(_join(path, k), "length", "value is longer than 64 characters")
		"rate":
			return _check(_obj({"messages": _int(1), "perMs": _int(1)}, ["messages", "perMs"]), v, path)
		"roomdata":
			return _check_room_data(v, path)
		"steam":
			if typeof(v) == TYPE_BOOL:
				return {}
			if not v is Dictionary:
				return _fail(path, "type", "must be true, false or { appId }")
			return _check(_obj({"appId": _int(1)}), v, path)
		"epic":
			if typeof(v) == TYPE_BOOL:
				return {}
			if not v is Dictionary:
				return _fail(path, "type", "must be true, false or { productId }")
			for k: Variant in v:
				if str(k) != "$schema" and str(k) != "$comment" and typeof(v[k]) != TYPE_STRING:
					return _fail(_join(path, k), "type", "must be a string")
	return {}


# ------------------------------------------------------------------------------------------------ defaults and rules

## A copy without "$comment" / "$schema" keys, whole numbers as int.
static func _strip(o: Variant) -> Variant:
	if o is Array:
		var a := []
		for x: Variant in o:
			a.append(_strip(x))
		return a
	if o is Dictionary:
		var out := {}
		for k: Variant in o:
			if str(k) != "$comment" and str(k) != "$schema":
				out[k] = _strip(o[k])
		return out
	if typeof(o) == TYPE_FLOAT and is_finite(o) and o == floorf(o):
		return int(o)
	return o


static func _sect(x: Variant) -> Dictionary:
	return x if x is Dictionary else {}


static func _fill(input: Dictionary) -> Dictionary:
	var game := _sect(input.get("game"))
	var engine_v: Variant = input.get("engine")
	var hosting_in := _sect(input.get("hosting"))
	var lobby_in := _sect(input.get("lobby"))
	var room_in := _sect(input.get("room"))
	var sync_in := _sect(input.get("sync"))
	var players_in := _sect(input.get("players"))
	var chat_in := _sect(input.get("chat"))
	var session_in := _sect(input.get("session"))
	var platforms_in := _sect(input.get("platforms"))
	var ui_in := _sect(input.get("ui"))
	var diag_in := _sect(input.get("diagnostics"))
	var tick_rate: int = sync_in.get("tickRate", 20)
	var web: bool = engine_v == "web"
	var out := {
		"version": 1,
		"game": {"id": game["id"], "netVersion": game.get("netVersion", "1")},
	}
	if game.has("title"):
		out["game"]["title"] = game["title"]
	if engine_v != null:
		out["engine"] = engine_v
	out["hosting"] = {
		"direct": hosting_in.get("direct", not web),
		"server": hosting_in.get("server", web),
		"lobbyServer": hosting_in.get("lobbyServer", ""),
		"directPort": hosting_in.get("directPort", 47810),
		"openPort": hosting_in.get("openPort", true),
		"nostr": hosting_in.get("nostr", true),
		"nostrRelays": hosting_in.get("nostrRelays", DEFAULT_NOSTR_RELAYS.duplicate()),
		"relayOnly": hosting_in.get("relayOnly", false),
		"allowedOrigins": hosting_in.get("allowedOrigins", []),
	}
	out["lobby"] = {
		"maxPlayers": lobby_in.get("maxPlayers", 4),
		"listed": lobby_in.get("listed", false),
		"approveJoins": lobby_in.get("approveJoins", false),
		"password": lobby_in.get("password", false),
		"lateJoin": lobby_in.get("lateJoin", true if not room_in.has("lateJoin") else room_in["lateJoin"] != "refuse"),
		"rejoin": lobby_in.get("rejoin", true),
		"joinLink": lobby_in.get("joinLink", web or engine_v == "node-browser"),
		"meta": lobby_in.get("meta", {}),
	}
	out["room"] = {
		"passwordRequired": room_in.get("passwordRequired", false),
		"autoStart": room_in.get("autoStart", "off"),
		"autoStartPlayers": room_in.get("autoStartPlayers", 2),
		"minPlayers": room_in.get("minPlayers", 1),
		"countdownSeconds": room_in.get("countdownSeconds", 3),
		"spectators": room_in.get("spectators", 0),
		"lateJoin": room_in.get("lateJoin", "allow" if lobby_in.get("lateJoin", true) else "refuse"),
		"seatDropped": room_in.get("seatDropped", "window"),
		"rejoinWindowSeconds": room_in.get("rejoinWindowSeconds", 60),
		"data": room_in.get("data", {}),
	}
	out["sync"] = {"mode": sync_in.get("mode", "raw"), "tickRate": tick_rate, "hashEveryTicks": sync_in.get("hashEveryTicks", tick_rate)}
	out["players"] = {"identity": players_in.get("identity", "name"), "maxNameLength": players_in.get("maxNameLength", 24)}
	out["chat"] = {"text": chat_in.get("text", true), "voice": chat_in.get("voice", false), "voiceMode": chat_in.get("voiceMode", "pushToTalk")}
	out["session"] = {
		"hostLeaves": session_in.get("hostLeaves", "end"),
		"pause": session_in.get("pause", "off"),
		"readyTimeoutMs": session_in.get("readyTimeoutMs", 15000),
		"peerTimeoutMs": session_in.get("peerTimeoutMs", 0),
		"runInBackground": session_in.get("runInBackground", true),
	}
	if session_in.has("rateLimit"):
		out["session"]["rateLimit"] = session_in["rateLimit"]
	out["platforms"] = {"steam": platforms_in.get("steam", false), "epic": platforms_in.get("epic", false), "discord": platforms_in.get("discord", false)}
	out["ui"] = {"kind": ui_in.get("kind", "drop-in" if (web or engine_v == "godot-gdscript") else "generated"), "theme": ui_in.get("theme", "auto")}
	if ui_in.has("entry"):
		out["ui"]["entry"] = ui_in["entry"]
	out["diagnostics"] = {
		"reportToHost": diag_in.get("reportToHost", true),
		"logSize": diag_in.get("logSize", 500),
		"relayProbe": diag_in.get("relayProbe", true),
		"showConnectionCheck": diag_in.get("showConnectionCheck", true),
	}
	return out


## Cross-key rules (x-rules in the schema), in the schema's order.
static func _cross_rules(d: Dictionary, input: Dictionary) -> Dictionary:
	var h: Dictionary = d["hosting"]
	var l: Dictionary = d["lobby"]
	var r: Dictionary = d["room"]
	var s: Dictionary = d["sync"]
	var ses: Dictionary = d["session"]
	var eng: Variant = d.get("engine")
	if not h["direct"] and not h["server"]:
		return _fail("hosting", "hosting_none", "at least one of direct, server must be true")
	if l["listed"] and l["approveJoins"]:
		return _fail("lobby", "listed_and_approve", "listed and approveJoins cannot both be true")
	if eng == "web" and h["direct"]:
		return _fail("hosting.direct", "direct_needs_listener", "engine web cannot host direct (a browser cannot listen on a port)")
	if s["mode"] == "replication" and (eng == null or eng == "godot-gdscript"):
		return _fail("sync.mode", "replication_not_gdscript", "replication needs an explicit engine other than godot-gdscript (GDScript speaks raw and lockstep)")
	if s["mode"] == "replication" and ses["hostLeaves"] == "migrate":
		return _fail("session.hostLeaves", "migrate_with_replication", "replication has no host migration; use end")
	var late_given := _sect(input.get("lobby")).has("lateJoin")
	var room_late: Variant = _sect(input.get("room")).get("lateJoin")
	if room_late != null and late_given and ((room_late == "refuse") if l["lateJoin"] else (room_late != "refuse")):
		return _fail("room.lateJoin", "late_join_conflict", "lobby.lateJoin and room.lateJoin disagree")
	if int(r["minPlayers"]) > int(l["maxPlayers"]):
		return _fail("room.minPlayers", "min_exceeds_max", "more than lobby.maxPlayers")
	if r["autoStart"] == "players" and int(r["autoStartPlayers"]) > int(l["maxPlayers"]):
		return _fail("room.autoStartPlayers", "autostart_exceeds_players", "more than lobby.maxPlayers")
	if ses["hostLeaves"] == "migrate" and not h["server"]:
		return _fail("session.hostLeaves", "migrate_needs_server", "migrate needs hosting.server (direct lobbies always end)")
	return {}
