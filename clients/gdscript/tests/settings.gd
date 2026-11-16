extends SceneTree
## The player settings (spec/settings.md) against spec/vectors/settings.json, then applied by the client between real GDScript
## peers on 127.0.0.1 (Direct hosts by IP, no Nostr, no internet): the joiner's name, relay entry and server come from saved
## settings, an explicit value beats the saved one, a default switches off, the environment wins for a run and is never written,
## an invalid saved relay line is skipped with one warning that does not print it. Every store is memory; every environment a
## fixed map, so nothing on this machine changes a run.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/settings.gd
## Prints "settings: N passed, M failed"; exits 1 on any failure.

const GAME := "com.you.game"
const RELAY := "turn:127.0.0.1:9 samuser sampass77"
const SECRETS := ["samuser", "sampass77", "pwserver9", "tok12345"]

var _pass := 0
var _fail := 0
var _clients: Array = []
var _next_port := 48500


func _init() -> void:
	process_frame.connect(func() -> void:
		if Time.get_ticks_msec() > 200000:
			print("settings FAIL: timed out")
			quit(1))
	_run.call_deferred()


func _check(ok: bool, what: String) -> void:
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL: ", what)


func _spec(path: String) -> Variant:
	var spec := ProjectSettings.globalize_path("res://").path_join("../../spec").simplify_path()
	var j := JSON.new()
	j.parse(FileAccess.get_file_as_string(spec.path_join(path)))
	return j.data


## The vector field names are the stored ones (lastCode); the GDScript API says last_code.
static func _snake(f: String) -> String:
	return "last_code" if f == "lastCode" else f


static func _values(v: Dictionary) -> Dictionary:
	var out := {}
	for k: String in v:
		out[_snake(k)] = v[k]
	return out


func _same(a: Variant, b: Variant) -> bool:
	if (typeof(a) == TYPE_INT or typeof(a) == TYPE_FLOAT) and (typeof(b) == TYPE_INT or typeof(b) == TYPE_FLOAT):
		return float(a) == float(b)
	if a is Array and b is Array:
		if a.size() != b.size():
			return false
		for i in a.size():
			if not _same(a[i], b[i]):
				return false
		return true
	if a is Dictionary and b is Dictionary:
		if a.size() != b.size():
			return false
		for k: Variant in a:
			if not b.has(k) or not _same(a[k], b[k]):
				return false
		return true
	return typeof(a) == typeof(b) and a == b


func _store_with(text: Variant, game: String = GAME) -> OneLobbyStore:
	var s := OneLobbyStore.memory()
	if text != null:
		s.set_item(OneLobbySettings.key(game), text if text is String else JSON.stringify(text))
	return s


func _run() -> void:
	var v: Dictionary = _spec("vectors/settings.json")
	_vectors(v)
	await _behavior()
	print("settings: %d passed, %d failed" % [_pass, _fail])
	for c: OneLobbyClient in _clients:
		if c.lobby != null and not c.lobby.is_closed():
			c.lobby.leave()
	for _i in 5:
		await process_frame
	quit(1 if _fail > 0 else 0)


# ---- the shared vectors ----------------------------------------------------------------------------------------------------

func _vectors(v: Dictionary) -> void:
	for k: Dictionary in v["key"]:
		_check(OneLobbySettings.key(k["gameId"]) == k["key"], "key %s" % k["gameId"])
	var names := {}
	for f: String in v["envNames"]:
		names[_snake(f)] = v["envNames"][f]
	_check(_same(OneLobbySettings.ENV, names), "the variable names")
	_check(OneLobbySettings.HIDDEN == v["hidden"], "the hidden marker")

	for field: String in ["name", "relay", "lastCode", "server"]:
		var cases: Array = v["clean"][field]
		_check(cases.size() > 4, "clean %s has cases" % field)
		for c: Dictionary in cases:
			var got: Variant = OneLobbySettings.clean(_snake(field), c["input"])
			if c.has("invalid"):
				_check(got == null, "clean %s %s is invalid (got %s)" % [field, JSON.stringify(c["input"]), str(got)])
			else:
				_check(got is String and got == c["ok"], "clean %s %s -> %s (got %s)" % [field, JSON.stringify(c["input"]), JSON.stringify(c["ok"]), str(got)])

	for c: Dictionary in v["mask"]:
		_check(OneLobbySettings.mask_relay(c["relay"]) == c["masked"], "mask %s" % JSON.stringify(c["relay"]))

	for c: Dictionary in v["load"]:
		var s := OneLobbySettings.create(_store_with(c["stored"]), GAME, {})
		_check(_same(s.load_values(), _values(c["values"])), "load: %s -> %s" % [c["name"], JSON.stringify(s.load_values())])

	for c: Dictionary in v["save"]:
		var store := _store_with(c["stored"])
		var s := OneLobbySettings.create(store, GAME, {})
		var patch := _values(c["patch"])
		var r := s.save(patch)
		var rejected: Array = (c["rejected"] as Array).map(func(x: String) -> String: return _snake(x))
		_check(_same(r["rejected"], rejected) and r["ok"] == rejected.is_empty(), "save rejected: %s" % c["name"])
		var back: Variant = JSON.parse_string(str(store.get_item(OneLobbySettings.key(GAME))))
		_check(_same(back, c["result"]), "save result: %s -> %s" % [c["name"], str(store.get_item(OneLobbySettings.key(GAME)))])

	for c: Dictionary in v["env"]:
		var store := _store_with(c["stored"])
		var before: Variant = store.get_item(OneLobbySettings.key(GAME))
		var s := OneLobbySettings.create(store, GAME, c["env"])
		_check(_same(s.effective(), _values(c["effective"])), "env: %s -> %s" % [c["name"], JSON.stringify(s.effective())])
		_check(store.get_item(OneLobbySettings.key(GAME)) == before, "env never written: %s" % c["name"])
		s.save({"last_code": "7HQ4K2"})
		_check(not str(store.get_item(OneLobbySettings.key(GAME))).contains("Ann"), "env still not written after a save: %s" % c["name"])

	# a store that fails to save keeps the values for the session
	var broken := OneLobbySettings.create(OneLobbyStore.new(), GAME, {}) # the base store keeps nothing
	_check(broken.save({"name": "Sam"})["ok"] and broken.load_values()["name"] == "Sam", "a store that cannot save keeps the settings for the session")
	var masked := OneLobbySettings.create(_store_with({"relay": "turn:relay.example.com:3478 alice s3cret"}), GAME, {})
	_check(masked.masked_relay() == "turn:relay.example.com:3478 <hidden> <hidden>", "masked_relay")


# ---- applied by the client -------------------------------------------------------------------------------------------------

func _client(display: String, store: OneLobbyStore, env: Dictionary = {}) -> OneLobbyClient:
	var c := OneLobbyClient.new()
	c.game_id = GAME
	c.net_version = "1"
	c.display_name = display
	c.lobby_server = ""
	c.store = store
	c.settings_env = env
	c.sync_mode = "raw"
	c.ready_timeout_ms = 20000
	root.add_child(c)
	_clients.append(c)
	return c


func _until(cond: Callable, ms: int = 15000) -> bool:
	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < ms:
		await process_frame
		if cond.call():
			return true
	return cond.call()


func _host() -> OneLobbyClient:
	var c := _client("Host", OneLobbyStore.memory())
	c.settings_use = {"name": false, "relay": false, "server": false, "last_code": false}
	var o := {"name": "t", "max_players": 8, "tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1",
		"udp_port_range": [_next_port, _next_port + 15], "nostr": false}
	_next_port += 20
	var l := await c.host_direct(o)
	if l == null:
		_check(false, "host_direct failed: %s" % JSON.stringify(c.last_error))
	return c


func _names(host: OneLobbyClient) -> Array:
	return host.lobby.room.entries().map(func(e: Dictionary) -> String: return e["name"])


func _behavior() -> void:
	var saved := {"v": 1, "name": "Sam", "relay": RELAY, "server": "wss://lobby.mygame.net/ws"}

	# 1. a joiner's name, relay entry and lobby server come from the saved settings
	var h := await _host()
	if h.lobby == null:
		return
	var code: String = h.lobby.ip_code
	var warnings: Array = []
	var j := _client("", _store_with(saved))
	j.warning.connect(func(m: String) -> void: warnings.append(m))
	_check(j.effective_name() == "Sam" and j.effective_server() == "wss://lobby.mygame.net/ws", "the saved name and server fill in what the game left empty")
	var jl := await j.join_direct(code, {"timeout_ms": 20000})
	_check(jl != null, "the joiner joined: %s" % JSON.stringify(j.last_error))
	if jl == null:
		return
	_check(await _until(func() -> bool: return _names(h).has("Sam")), "the host sees the saved name: %s" % str(_names(h)))
	var mine := {"urls": ["turn:127.0.0.1:9"], "username": "samuser", "credential": "sampass77"}
	var host_ice := h.ice.size()
	_check(j.ice.size() == host_ice + 1 and _same(j.ice[j.ice.size() - 1], mine), "the hub's list first, then this player's relay entry: %s" % JSON.stringify(j.ice))
	_check(j.settings.load_values()["last_code"] == OneLobbyJoinCode.normalize_dc1(code), "the code was saved after the join")
	_check(h.settings.load_values()["last_code"] == "", "a client with last_code switched off saves nothing")
	_check(warnings.is_empty(), "no warning for a valid line")
	j.lobby.leave()
	await _until(func() -> bool: return j.lobby == null, 3000)

	# 2. an explicit name and server beat the saved ones
	var z := _client("Zed", _store_with(saved))
	z.lobby_server = "ws://explicit.example.net:8080"
	_check(z.effective_name() == "Zed" and z.effective_server() == "ws://explicit.example.net:8080", "explicit values win over saved ones")
	var zl := await z.join_direct(code, {"timeout_ms": 20000})
	_check(zl != null and await _until(func() -> bool: return _names(h).has("Zed")), "the host sees the explicit name")
	_check(z.ice.size() == host_ice + 1, "the explicit name did not switch the relay default off")
	z.lobby.leave()
	await _until(func() -> bool: return z.lobby == null, 3000)

	# 3. a default switched off
	var o := _client("", _store_with(saved))
	o.settings_use = {"name": false, "relay": false, "server": true, "last_code": true}
	var ol := await o.join_direct(code, {"timeout_ms": 20000})
	_check(ol != null and o.effective_name() == "" and o.ice.size() == host_ice, "name and relay off: no saved name, no saved relay entry")
	_check(o.settings.load_values()["last_code"] != "", "last_code was left on")
	_check(o.effective_server() == "wss://lobby.mygame.net/ws", "server left on")
	o.lobby.leave()
	await _until(func() -> bool: return o.lobby == null, 3000)

	# 4. the environment wins for the run and is never written, "Player" counts as no name
	var e_store := _store_with({"v": 1, "name": "Sam", "theme": "dark"})
	var e := _client("Player", e_store, {"ONELOBBY_NAME": "Ann", "ONELOBBY_LOBBY_SERVER": "lobby.env.net"})
	_check(e.effective_name() == "Ann" and e.effective_server() == "wss://lobby.env.net", "the environment beats the stored value")
	var el := await e.join_direct(code, {"timeout_ms": 20000})
	_check(el != null, "the environment client joined: %s" % JSON.stringify(e.last_error))
	_check(await _until(func() -> bool: return _names(h).has("Ann")), "the host sees the environment name: %s" % str(_names(h)))
	var stored := str(e_store.get_item(OneLobbySettings.key(GAME)))
	_check(stored.contains("\"theme\":\"dark\"") and stored.contains("lastCode") and not stored.contains("Ann") and not stored.contains("lobby.env.net"), "unknown fields kept, the environment not written: %s" % stored)
	e.lobby.leave()
	await _until(func() -> bool: return e.lobby == null, 3000)

	# 5. an invalid saved relay line is skipped with one plain warning that does not print it
	var w_warnings: Array = []
	var w := _client("Wil", _store_with({"v": 1, "relay": "samuser sampass77"}))
	w.warning.connect(func(m: String) -> void: w_warnings.append(m))
	var errors: Array = []
	w.error.connect(func(c: String, m: String) -> void: errors.append(c + " " + m))
	var wl := await w.join_direct(code, {"timeout_ms": 20000})
	_check(wl != null and w.ice.size() == host_ice, "the invalid saved relay is not used")
	_check(w_warnings == [OneLobbySettings.RELAY_SKIPPED_WARNING], "one plain warning: %s" % str(w_warnings))
	w.lobby.leave()
	await _until(func() -> bool: return w.lobby == null, 3000)

	# 6. no_server only when the call, the file and the settings all give none
	var n := _client("N", _store_with(null))
	var nl := await n.host({})
	_check(nl == null and n.last_error.get("code") == "no_server", "no server anywhere: no_server (%s)" % JSON.stringify(n.last_error))
	var ns := _client("N", _store_with({"server": "lobby.mygame.net"}))
	_check(ns.effective_server() == "wss://lobby.mygame.net", "a saved server fills an empty lobby_server")

	# 7. a blueprint: no saved name for anonymous games, maxNameLength clamps
	var st := _store_with({"v": 1, "name": "Samantha the Long"})
	var anon := OneLobbyClient.from_config({"game": {"id": GAME}, "players": {"identity": "anonymous"}}, {})
	anon.store = st
	anon.settings_env = {}
	_check(anon.effective_name() == "", "anonymous: no saved name")
	var clamp := OneLobbyClient.from_config({"game": {"id": GAME}, "players": {"maxNameLength": 5}}, {})
	clamp.store = st
	clamp.settings_env = {}
	_check(clamp.effective_name() == "Saman", "maxNameLength clamps the saved name (%s)" % clamp.effective_name())
	var plain := OneLobbyClient.from_config({"game": {"id": GAME}}, {})
	plain.store = st
	plain.settings_env = {}
	_check(plain.effective_name() == "Samantha the Long", "a blueprint client uses the saved name")
	for c: OneLobbyClient in [anon, clamp, plain]:
		c.free()

	# 8. never logged: no error, warning or message the client raised holds the relay line
	var all := "\n".join(PackedStringArray(errors)) + "\n" + "\n".join(PackedStringArray(w_warnings)) + "\n" + JSON.stringify(j.last_error) + JSON.stringify(w.last_error)
	var bad := _client("B", _store_with({"v": 1, "relay": RELAY, "server": "wss://sam:pwserver9@lobby.mygame.net/ws?token=tok12345"}))
	var bad_errors: Array = []
	bad.error.connect(func(c: String, m: String) -> void: bad_errors.append(c + " " + m))
	await bad.join_direct("not a code")
	await bad.join("ZZZZZZ".substr(0, 3))
	all += "\n" + "\n".join(PackedStringArray(bad_errors)) + JSON.stringify(bad.last_error)
	for secret: String in SECRETS:
		_check(not all.contains(secret), "no error or warning holds %s" % "the secret")
	_check(not OneLobbySettings.redact_url("wss://sam:pwserver9@lobby.mygame.net/ws").contains("pwserver9"), "redact_url drops user:pass@")
