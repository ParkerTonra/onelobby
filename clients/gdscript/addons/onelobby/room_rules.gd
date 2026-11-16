class_name OneLobbyRoomRules
extends RefCounted
## Pure rules of the room layer (spec/room.md): names, per-player data, seats, ban matching, auto start, the countdown
## time base and join admission. No I/O, no clock; every function is pinned by spec/vectors/room.json (tests/room_vectors.gd).
## The same rules as clients/js/packages/client/src/room-rules.ts and clients/dotnet/OneLobby.Core/RoomRules.cs.
##
## Settings, data declarations, entries and frames use the wire's own camelCase keys (`maxPlayers`, `hostOnly`, ...), so a
## Dictionary can be sent and compared as it is; the options a game passes to host() use snake_case (see resolve_settings).

const REASON_MAX := 120
const MAX_ONE_WAY_MS := 2000
const DATA_MAX_BYTES := 1024
const NAME_MAX := 24
const FALLBACK_REASON := "You were removed from the game."
const DEFAULT_REASONS := {
	"kicked": "The host removed you from the game.",
	"denied": "The host did not let you in.",
	"disconnected": "The host disconnected you.",
	"banned": "You are banned from this game.",
	"bad_password": "Wrong password.",
	"lobby_full": "The game is full.",
	"spectators_full": "No spectator seats are free.",
	"in_game": "The game has already started.",
}
const BUILTIN_DATA := {
	"color": {"type": "color"},
	"avatar": {"type": "int", "min": 0, "max": 255, "default": "0"},
	"team": {"type": "int", "min": 0, "max": 15, "default": "0"},
}

static var _re_code: RegEx
static var _re_key: RegEx
static var _re_pid: RegEx
static var _re_int: RegEx
static var _re_color: RegEx


static func _rx(pattern: String) -> RegEx:
	return RegEx.create_from_string(pattern)


static func is_code(s: Variant) -> bool:
	if _re_code == null:
		_re_code = _rx("^[a-z][a-z0-9_]{0,31}\\z")
	return typeof(s) == TYPE_STRING and _re_code.search(s) != null


static func is_data_key(s: Variant) -> bool:
	if _re_key == null:
		_re_key = _rx("^[a-z][a-z0-9_]{0,23}\\z")
	return typeof(s) == TYPE_STRING and _re_key.search(s) != null


static func is_player_id(s: Variant) -> bool:
	if _re_pid == null:
		_re_pid = _rx("^[0-9a-f]{32}\\z")
	return typeof(s) == TYPE_STRING and _re_pid.search(s) != null


## A fresh player id: 16 random bytes from the system CSPRNG as 32 lower-case hex characters.
static func new_player_id() -> String:
	return Crypto.new().generate_random_bytes(16).hex_encode()


# ---- names (spec/room.md 4.1) --------------------------------------------------------------------------------------

## Godot strings cannot hold U+0000: its JSON parser turns a NUL into U+FFFD. Step 1 strips NUL, so U+FFFD goes too (the one
## place this port differs from JS and C#, which keep a real U+FFFD).
static func _is_strip(c: int) -> bool:
	return c <= 0x1f or c == 0xfffd or (c >= 0x7f and c <= 0x9f) or (c >= 0x200b and c <= 0x200f) or (c >= 0x2028 and c <= 0x202e) \
		or (c >= 0x2066 and c <= 0x2069) or c == 0xfeff


static func _is_space(c: int) -> bool:
	return c == 0x20 or c == 0xa0 or c == 0x1680 or (c >= 0x2000 and c <= 0x200a) or c == 0x202f or c == 0x205f or c == 0x3000


## Steps 1-2 of the name rules: strip control, bidi and zero-width characters, collapse whitespace runs, trim.
static func clean_text(s: Variant) -> String:
	var text := str(s) if s != null else ""
	var out := PackedStringArray()
	var last_space := true # a leading space is trimmed
	for i in text.length():
		var c := text.unicode_at(i)
		if _is_strip(c):
			continue
		if _is_space(c):
			if not last_space:
				out.append(" ")
			last_space = true
		else:
			out.append(char(c))
			last_space = false
	var res := "".join(out)
	if res.ends_with(" "):
		res = res.substr(0, res.length() - 1)
	return res


## `s` cut to at most `n` code points.
static func clamp_cp(s: String, n: int) -> String:
	return s if s.length() <= n else s.substr(0, maxi(0, n))


## The host's filter hook (`func(text: String, kind: String) -> String`); anything but a String result counts as no hook.
static func apply_filter(filter: Callable, text: String, kind: String) -> String:
	if not filter.is_valid():
		return text
	var out: Variant = filter.call(text, kind)
	return out if typeof(out) == TYPE_STRING else text


## Steps 1-5 (no dedupe). `peer_id` makes the default `Player N`.
static func base_name(input: String, peer_id: int, max_length: int = NAME_MAX, filter: Callable = Callable()) -> String:
	var mx := clampi(max_length, 1, NAME_MAX)
	var n := clamp_cp(clean_text(input), mx)
	if filter.is_valid():
		n = clamp_cp(clean_text(apply_filter(filter, n, "name")), mx)
	if n == "" or n == "Player":
		n = "Player %d" % peer_id
	return n


## Step 6: `name` made unique among `others` (case-insensitive): "Name 2", "Name 3", ... within `max_length`.
static func dedupe_name(name: String, others: Array, max_length: int = NAME_MAX) -> String:
	var mx := clampi(max_length, 1, NAME_MAX)
	var taken := {}
	for o: Variant in others:
		taken[str(o).to_lower()] = true
	if not taken.has(name.to_lower()):
		return name
	var i := 2
	while true:
		var suffix := " %d" % i
		var base := clamp_cp(name, maxi(1, mx - suffix.length())).rstrip(" ")
		var cand := base + suffix
		if not taken.has(cand.to_lower()):
			return cand
		i += 1
	return name


## The whole name pipeline.
static func effective_name(input: String, peer_id: int, others: Array, max_length: int = NAME_MAX, filter: Callable = Callable()) -> String:
	return dedupe_name(base_name(input, peer_id, max_length, filter), others, max_length)


# ---- reasons (5.1) -------------------------------------------------------------------------------------------------

## The plain sentence for a removal: the host's text when it has one, else the default of the code.
static func removal_reason(code: String, text: Variant = "") -> String:
	var t := clamp_cp(clean_text(text), REASON_MAX)
	if t != "":
		return t
	return str(DEFAULT_REASONS.get(code, FALLBACK_REASON))


# ---- addresses and bans (5.3) --------------------------------------------------------------------------------------

## Lower-case; an IPv4-mapped IPv6 address becomes its IPv4 form.
static func normalize_ip(ip: Variant) -> String:
	var s := str(ip).strip_edges().to_lower() if ip != null else ""
	if s.begins_with("::ffff:"):
		var rest := s.substr(7)
		var parts := rest.split(".")
		if parts.size() == 4:
			var ok := true
			for p in parts:
				if p == "" or not p.is_valid_int() or p.begins_with("-") or p.begins_with("+"):
					ok = false
			if ok:
				return rest
	return s


static func is_loopback_ip(ip: Variant) -> bool:
	var s := normalize_ip(ip)
	return s == "::1" or s.begins_with("127.") or s == "localhost"


## Whether ban `entry` ({id?, ip?}) bans candidate `c` ({id?, ip?}): equal ids, or equal addresses when a side has no id.
static func ban_matches(entry: Dictionary, c: Dictionary) -> bool:
	var eid := str(entry.get("id", ""))
	var cid := str(c.get("id", ""))
	if eid != "" and cid != "":
		return eid == cid
	var eip := str(entry.get("ip", ""))
	var cip := str(c.get("ip", ""))
	if eip != "" and cip != "" and (eid == "" or cid == ""):
		return normalize_ip(eip) == normalize_ip(cip)
	return false


# ---- per-player data (4.2) -----------------------------------------------------------------------------------------

## The built-ins with the game's declarations on top (a declaration of the same key replaces it).
static func merge_data_spec(custom: Variant = null) -> Dictionary:
	var out := BUILTIN_DATA.duplicate(true)
	if custom is Dictionary:
		for k: Variant in custom:
			out[str(k)] = (custom[k] as Dictionary).duplicate(true) if custom[k] is Dictionary else {}
	return out


static func _num(v: Variant, dflt: int) -> int:
	return int(v) if typeof(v) == TYPE_INT or typeof(v) == TYPE_FLOAT else dflt


## One value against its declaration: the stored text, or null when invalid. "" (unset) is always valid.
static func check_data_value(decl: Dictionary, value: Variant) -> Variant:
	if typeof(value) != TYPE_STRING:
		return null
	var v: String = value
	if v == "":
		return ""
	match str(decl.get("type", "")):
		"string":
			var cleaned := clean_text(v)
			return cleaned if cleaned.length() <= mini(64, _num(decl.get("maxLength"), 32)) else null
		"int":
			if _re_int == null:
				_re_int = _rx("^(0|-?[1-9][0-9]*)\\z")
			if _re_int.search(v) == null or v.length() > 11:
				return null
			var n := v.to_int()
			if absi(n) > 2147483647:
				return null
			return v if n >= _num(decl.get("min"), 0) and n <= _num(decl.get("max"), 255) else null
		"enum":
			var vals: Variant = decl.get("values")
			return v if vals is Array and (vals as Array).has(v) else null
		"bool":
			return v if v == "true" or v == "false" else null
		"color":
			if _re_color == null:
				_re_color = _rx("^#[0-9a-fA-F]{6}\\z")
			return v.to_lower() if _re_color.search(v) != null else null
	return null


## Applies `values` to `before` under `spec`, atomically. `by_host` lets hostOnly keys through. "" removes a key.
## Returns {ok: true, data} or {ok: false, code, key?}.
static func apply_data(spec: Dictionary, before: Dictionary, values: Dictionary, by_host: bool) -> Dictionary:
	var next := before.duplicate()
	for key: Variant in values:
		var k := str(key)
		var decl: Variant = spec.get(k) if is_data_key(k) else null
		if not decl is Dictionary:
			return {"ok": false, "code": "unknown_key", "key": k}
		if bool(decl.get("hostOnly", false)) and not by_host:
			return {"ok": false, "code": "not_allowed", "key": k}
		var v: Variant = check_data_value(decl, values[key])
		if v == null:
			return {"ok": false, "code": "bad_value", "key": k}
		if v == "":
			next.erase(k)
		else:
			next[k] = v
	if OneLobbyRoomWire.json_text(next).to_utf8_buffer().size() > DATA_MAX_BYTES:
		return {"ok": false, "code": "too_large"}
	return {"ok": true, "data": next}


## The declared defaults, applied at admission to the keys a player did not set.
static func data_defaults(spec: Dictionary, data: Dictionary) -> Dictionary:
	var out := data.duplicate()
	for k: Variant in spec:
		var d: Dictionary = spec[k]
		if d.has("default") and str(d["default"]) != "" and not out.has(k):
			out[k] = str(d["default"])
	return out


# ---- seats (4.3) ---------------------------------------------------------------------------------------------------

## The seat for a player entering. `held`: {seat: true} of connected or reconnecting players. `memory`: pid -> seat of
## everyone the host remembers (the caller erases the entry named by `take_over`). Seat -1 when every seat is held.
static func choose_seat(max_players: int, held: Dictionary, memory: Dictionary, pid: String) -> Dictionary:
	if pid != "" and memory.has(pid):
		var mine := int(memory[pid])
		if mine >= 0 and mine < max_players and not held.has(mine):
			return {"seat": mine, "returning": true, "take_over": ""}
	var others := {} # seat -> pid
	for p: Variant in memory:
		if str(p) != pid:
			others[int(memory[p])] = str(p)
	for s in max_players:
		if not held.has(s) and not others.has(s):
			return {"seat": s, "returning": false, "take_over": ""}
	for s in max_players:
		if not held.has(s):
			return {"seat": s, "returning": false, "take_over": str(others.get(s, ""))}
	return {"seat": -1, "returning": false, "take_over": ""}


# ---- auto start (4.5) ----------------------------------------------------------------------------------------------

## Players that count for starting: role player, connected, not legacy.
static func is_eligible(p: Dictionary) -> bool:
	return str(p.get("role", "player")) == "player" and str(p.get("status", "connected")) == "connected" and not bool(p.get("legacy", false))


## True when the auto-start condition holds now (the caller checks the state is "lobby"). `rule`: {mode, autoStartPlayers,
## minPlayers}.
static func auto_start_holds(rule: Dictionary, players: Array) -> bool:
	var mode := str(rule.get("mode", "off"))
	if mode == "off":
		return false
	var eligible: Array = players.filter(is_eligible)
	var min_p := int(rule.get("minPlayers", 1))
	if mode == "players":
		return eligible.size() >= maxi(maxi(int(rule.get("autoStartPlayers", 2)), min_p), 1)
	for p: Dictionary in players:
		if str(p.get("role", "")) == "player" and str(p.get("status", "")) == "reconnecting" and not bool(p.get("legacy", false)):
			return false
	if eligible.size() < maxi(min_p, 1):
		return false
	for p: Dictionary in eligible:
		if not bool(p.get("ready", false)):
			return false
	return true


# ---- countdown time base (4.5) -------------------------------------------------------------------------------------

## Milliseconds from now until the countdown ends, for a receiver that got `left` and last measured `rtt` (null or 0: none).
static func countdown_remaining(left: int, rtt: Variant = null) -> int:
	var r := float(rtt) if rtt != null else 0.0
	var one_way := minf(float(MAX_ONE_WAY_MS), maxf(0.0, r / 2.0))
	return maxi(0, roundi(float(left) - one_way))


# ---- admission (4.8) -----------------------------------------------------------------------------------------------

## The order of checks on a `join`: banned, password, late join, capacity. `i`: {banned, hasPassword, passwordOk, state,
## lateJoin, role, players, maxPlayers, spectators, spectatorCap}. Returns {ok: true, role} or {ok: false, code}.
static func admit(i: Dictionary) -> Dictionary:
	if bool(i.get("banned", false)):
		return {"ok": false, "code": "banned"}
	if bool(i.get("hasPassword", false)) and not bool(i.get("passwordOk", false)):
		return {"ok": false, "code": "bad_password"}
	var role := str(i.get("role", "player"))
	if str(i.get("state", "lobby")) == "started":
		var late := str(i.get("lateJoin", "allow"))
		if late == "refuse":
			return {"ok": false, "code": "in_game"}
		if late == "spectate":
			role = "spectator"
	if role == "player" and int(i.get("players", 0)) >= int(i.get("maxPlayers", 0)):
		return {"ok": false, "code": "lobby_full"}
	if role == "spectator" and int(i.get("spectators", 0)) >= int(i.get("spectatorCap", 0)):
		return {"ok": false, "code": "spectators_full"}
	return {"ok": true, "role": role}


## Constant-time string comparison (length is not hidden; passwords are at most 64 characters).
static func safe_equal(a: String, b: String) -> bool:
	var x := a.to_utf8_buffer()
	var y := b.to_utf8_buffer()
	var d := x.size() ^ y.size()
	for i in maxi(x.size(), y.size()):
		d |= (x[i] if i < x.size() else 0) ^ (y[i] if i < y.size() else 0)
	return d == 0


# ---- settings ------------------------------------------------------------------------------------------------------

static func _clamp_opt(v: Variant, dflt: int, lo: int, hi: int) -> int:
	return clampi(int(v) if typeof(v) == TYPE_INT or typeof(v) == TYPE_FLOAT else dflt, lo, hi)


static func _pick(v: Variant, allowed: Array, dflt: String) -> String:
	return str(v) if typeof(v) == TYPE_STRING and allowed.has(v) else dflt


## The settings a room starts with. `o` is what a host gives (all keys optional, snake_case): auto_start ("off",
## "all_ready", "players"), auto_start_players, min_players, countdown_seconds, spectators, late_join ("allow", "spectate",
## "refuse"), seat_dropped ("window", "immediate"), rejoin_window_seconds, data (declarations), max_name_length.
## `late_join_flag` is the lobby's own late_join, which sets the default policy.
static func resolve_settings(o: Dictionary, max_players: int, late_join_flag: bool) -> Dictionary:
	return {
		"maxPlayers": max_players,
		"spectators": _clamp_opt(o.get("spectators"), 0, 0, 64),
		"minPlayers": _clamp_opt(o.get("min_players"), 1, 1, maxi(1, max_players)),
		"autoStart": _pick(o.get("auto_start"), ["off", "all_ready", "players"], "off"),
		"autoStartPlayers": _clamp_opt(o.get("auto_start_players"), 2, 2, 64),
		"countdownMs": _clamp_opt(o.get("countdown_seconds"), 3, 0, 60) * 1000,
		"lateJoin": _pick(o.get("late_join"), ["allow", "spectate", "refuse"], "allow" if late_join_flag else "refuse"),
		"seatDropped": _pick(o.get("seat_dropped"), ["window", "immediate"], "window"),
		"rejoinWindowMs": _clamp_opt(o.get("rejoin_window_seconds"), 60, 0, 600) * 1000,
		"maxNameLength": _clamp_opt(o.get("max_name_length"), 24, 1, 24),
		"data": merge_data_spec(o.get("data")),
	}
