class_name OneLobbyNetLog
extends RefCounted
## The net log (spec/diagnostics.md s.5-6): a ring buffer of connection steps with monotonic timings, a text export with a
## stable line format, and the masking rule. The log stays on the player's machine; nothing here sends anything.
##
## GDScript cannot hook a crash, so the log is saved to `path` (default `user://onelobby-netlog.txt` on a client) when the
## scene tree exits, after every `error` entry, and on demand (`save()`): a crash between two errors can lose the entries
## since the last error, never the ones before it.

const DEFAULT_CAPACITY := 500
const MIN_CAPACITY := 50
const MAX_CAPACITY := 5000
const TEXT_MAX := 200
const HIDDEN := "<hidden>"

var entries: Array[Dictionary] = [] ## {seq, t, kind, text, addr?, code?}, oldest first
var path := "" ## where save() writes when given no path, and where the exit / error flush writes; "" = nowhere
## True: every entry is also appended to `path` as it is added (a killed process still has its log). Set by `ONELOBBY_NETLOG` / `--netlog=`.
var live := false
var _live_open := false

## The log file one run asked for: `--netlog=<file>` after `--` wins, else the environment variable `ONELOBBY_NETLOG`, else "". `env`: null reads the real
## environment, or a Dictionary of variables (tests); `args`: the user args. Give each copy of a game on one PC its own file: the default file is one per game name.
static func requested_path(env: Variant, args: PackedStringArray) -> String:
	for a in args:
		if a.begins_with("--netlog=") and a.length() > 9:
			return a.substr(9)
	var v := str(env.get("ONELOBBY_NETLOG", "")) if env is Dictionary else OS.get_environment("ONELOBBY_NETLOG")
	return v.strip_edges()
var _next_seq := 1
var _cap := DEFAULT_CAPACITY
var _t0 := 0
var _now_fn := Callable()
var _client := "onelobby-gdscript"
var _protocol := "lk1"
var _platform := "godot"

static var _keyed: RegEx = null
static var _keyed_json: RegEx = null
static var _ice_secret: RegEx = null
static var _turn_line: RegEx = null
static var _url_user: RegEx = null
static var _ip6_bracket: RegEx = null
static var _ip6_bare: RegEx = null
static var _mdns: RegEx = null
static var _ip4: RegEx = null
static var _bracket_strip: RegEx = null


## `capacity`: ring size, default 500, clamped to 50..5000 unless `raw` (tests of the ring). `now_fn`: a Callable giving
## monotonic milliseconds (default Time.get_ticks_msec).
func _init(capacity := DEFAULT_CAPACITY, now_fn := Callable(), raw := false) -> void:
	_cap = maxi(1, capacity) if raw else clampi(capacity if capacity > 0 else DEFAULT_CAPACITY, MIN_CAPACITY, MAX_CAPACITY)
	_now_fn = now_fn
	_t0 = _now()


func _now() -> int:
	return int(_now_fn.call()) if _now_fn.is_valid() else Time.get_ticks_msec()


## Sets the header facts: client ("onelobby-gdscript 0.8.0"), protocol ("lk1"), platform.
func set_meta_info(client: String, protocol: String, platform: String) -> void:
	_client = client
	_protocol = protocol
	_platform = platform


## Adds a step. `text` is cut to 200 characters; keep addresses in `addr`, never in `text`. An `error` entry saves the log.
func add(kind: String, text: String, addr := "", code := "") -> void:
	var e := {"seq": _next_seq, "t": maxi(0, _now() - _t0), "kind": kind, "text": text.substr(0, TEXT_MAX)}
	_next_seq += 1
	if addr != "":
		e["addr"] = addr
	if code != "":
		e["code"] = code
	entries.append(e)
	if entries.size() > _cap:
		entries.pop_front()
	if live and path != "":
		_append_live(e)
	elif kind == "error" and path != "":
		flush()


## How many entries the ring dropped.
func dropped() -> int:
	return _next_seq - 1 - entries.size()


func clear() -> void:
	entries.clear()


## The log as text (spec/diagnostics.md s.5): a header, then one line per entry, oldest first. Addresses are masked unless
## `include_addresses`; credentials never print either way.
func export(include_addresses := false) -> String:
	var lines: PackedStringArray = [
		"# onelobby netlog v1",
		"# client %s protocol %s platform %s" % [_client, _protocol, _platform],
		"# entries %d dropped %d" % [entries.size(), dropped()],
		"# addresses included" if include_addresses else "# addresses masked",
	]
	for e: Dictionary in entries:
		var line := mask("#%d +%dms %s %s" % [e["seq"], e["t"], e["kind"], e["text"]], include_addresses)
		if include_addresses and e.has("addr"):
			# the address goes through the credential step too: a URL with ?token= or user:pass@ never prints a secret
			line += " addr=" + mask(str(e["addr"]), true)
		lines.append(line)
	return "\n".join(lines) + "\n"


## Writes the export to a file and returns the path (`to`, else `path`); "" when there is none or it cannot be written.
func save(to := "", include_addresses := false) -> String:
	var target := to if to != "" else path
	if target == "":
		return ""
	if target.get_base_dir() != "" and not target.get_base_dir().ends_with("://"):
		DirAccess.make_dir_recursive_absolute(target.get_base_dir())
	var f := FileAccess.open(target, FileAccess.WRITE)
	if f == null:
		return ""
	f.store_string(export(include_addresses))
	f.close()
	return target


## Live mode: the first entry writes the whole log (header and what is in the ring), later ones append one masked line each.
func _append_live(e: Dictionary) -> void:
	if not _live_open:
		_live_open = true
		save()
		return
	var f := FileAccess.open(path, FileAccess.READ_WRITE)
	if f == null:
		return
	f.seek_end()
	f.store_string(mask("#%d +%dms %s %s" % [e["seq"], e["t"], e["kind"], e["text"]], false) + "\n")
	f.close()


## Writes the masked log to `path` now (the exit and error flush); never fails loudly: the log is a courtesy.
func flush() -> void:
	if path != "":
		save()


# ---- masking (spec/diagnostics.md s.6) -------------------------------------------------------------------------------

static func _init_regex() -> void:
	if _keyed != null:
		return
	_keyed = RegEx.create_from_string("\\b(username|credential|password|pwd|token|secret)=([^\\s,\"]*)")
	_keyed_json = RegEx.create_from_string("(\"(?:username|credential|password|pwd|token|secret)\"\\s*:\\s*\")([^\"]*)(\")")
	_ice_secret = RegEx.create_from_string("(a=ice-(?:ufrag|pwd):)(\\S+)")
	_turn_line = RegEx.create_from_string("\\b(turns?:[^\\s?]+(?:\\?\\S*)?)\\s+\\S+\\s+\\S+")
	_url_user = RegEx.create_from_string("(\\b[A-Za-z][A-Za-z0-9+.-]*://)[^\\s/@]*:[^\\s/@]*@")
	_ip6_bracket = RegEx.create_from_string("\\[[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*\\](?::[0-9]{1,5})?")
	_ip6_bare = RegEx.create_from_string("(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:])")
	_mdns = RegEx.create_from_string("\\b[0-9A-Fa-f-]{8,}\\.local\\b")
	var octet := "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])"
	_ip4 = RegEx.create_from_string("\\b" + octet + "(?:\\." + octet + "){3}(?::[0-9]{1,5})?\\b")
	_bracket_strip = RegEx.create_from_string("^\\[|\\](?::[0-9]+)?$")


## Replaces every match of `re` in `text` with what `fn(RegExMatch) -> String` returns.
static func _sub(re: RegEx, text: String, fn: Callable) -> String:
	var out := ""
	var at := 0
	for m: RegExMatch in re.search_all(text):
		out += text.substr(at, m.get_start() - at) + str(fn.call(m))
		at = m.get_end()
	return out + text.substr(at)


static func _looks_like_ipv6(s: String) -> bool:
	var colons := s.count(":")
	return colons >= 2 and (s.contains("::") or (colons == 7 and not s.begins_with(":") and not s.ends_with(":")))


## Masks one line of log text. Credentials and ICE secrets are always hidden; IPv4, IPv6 and mDNS names are replaced by
## `<ip4>`, `<ip6>` and `<mdns>` unless `include_addresses` (spec/diagnostics.md s.6).
static func mask(text: String, include_addresses := false) -> String:
	_init_regex()
	var s := _sub(_keyed, text, func(m: RegExMatch) -> String: return m.get_string(1) + "=" + HIDDEN)
	s = _sub(_keyed_json, s, func(m: RegExMatch) -> String: return m.get_string(1) + HIDDEN + m.get_string(3))
	s = _sub(_ice_secret, s, func(m: RegExMatch) -> String: return m.get_string(1) + HIDDEN)
	s = _sub(_turn_line, s, func(m: RegExMatch) -> String: return m.get_string(1) + " " + HIDDEN + " " + HIDDEN)
	s = _sub(_url_user, s, func(m: RegExMatch) -> String: return m.get_string(1) + HIDDEN + "@")
	if include_addresses:
		return s
	s = _sub(_ip6_bracket, s, func(m: RegExMatch) -> String:
		return "<ip6>" if _looks_like_ipv6(_sub(_bracket_strip, m.get_string(), func(_x: RegExMatch) -> String: return "")) else m.get_string())
	s = _sub(_ip6_bare, s, func(m: RegExMatch) -> String: return "<ip6>" if _looks_like_ipv6(m.get_string()) else m.get_string())
	s = _sub(_mdns, s, func(_m: RegExMatch) -> String: return "<mdns>")
	return _sub(_ip4, s, func(_m: RegExMatch) -> String: return "<ip4>")
