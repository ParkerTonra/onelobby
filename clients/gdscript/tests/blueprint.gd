extends SceneTree
## The onelobby.json loader (OneLobbyConfig) against the shared vectors (spec/vectors/blueprint.json), then the client
## wiring: OneLobbyClient.from_config, one-call host and join on 127.0.0.1 (no Nostr, no internet), the stable failures.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/blueprint.gd
## Prints "blueprint: N passed, M failed"; exits 1 on any failure.

var _pass := 0
var _fail := 0


func _init() -> void:
	process_frame.connect(func() -> void:
		if Time.get_ticks_msec() > 90000:
			print("blueprint FAIL: timed out")
			quit(1))
	_run.call_deferred()


func _check(ok: bool, what: String) -> void:
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL: ", what)


func _load(path: String) -> Dictionary:
	var spec := ProjectSettings.globalize_path("res://").path_join("../../spec").simplify_path()
	var d: Variant = JSON.parse_string(FileAccess.get_file_as_string(spec.path_join(path)))
	return d if d is Dictionary else {}


## Numbers compare by value (JSON gives floats), everything else deeply.
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


func _run() -> void:
	var doc := _load("vectors/blueprint.json")
	var valid: Array = doc.get("valid", [])
	var invalid: Array = doc.get("invalid", [])
	var room_valid: Array = doc.get("roomValid", [])
	var room_invalid: Array = doc.get("roomInvalid", [])
	_check(valid.size() >= 12 and invalid.size() >= 36, "vectors loaded (%d valid, %d invalid)" % [valid.size(), invalid.size()])
	_check(room_valid.size() >= 5 and room_invalid.size() >= 17, "room vectors loaded (%d valid, %d invalid)" % [room_valid.size(), room_invalid.size()])
	valid.append_array(room_valid)
	invalid.append_array(room_invalid)
	for v: Dictionary in valid:
		var cfg := OneLobbyConfig.parse(v["input"])
		_check(cfg.ok, "valid %s accepted: %s" % [v["name"], cfg.error.get("message", "")])
		if not cfg.ok:
			continue
		for path: String in v["expect"]:
			var want: Variant = v["expect"][path]
			_check(_same(cfg.value_at(path), want), "valid %s: %s is %s, want %s" % [v["name"], path, JSON.stringify(cfg.value_at(path)), JSON.stringify(want)])
		# the file with defaults filled in is itself a valid file with the same content
		var again := OneLobbyConfig.parse(cfg.to_json())
		_check(again.ok and _same(again.data, cfg.data), "valid %s round-trips through to_json" % v["name"])
	for v: Dictionary in invalid:
		var cfg := OneLobbyConfig.parse(v["input"])
		var want: Dictionary = v["error"]
		_check(not cfg.ok and cfg.error.get("path") == want["path"] and cfg.error.get("rule") == want["rule"] and cfg.error.get("code") == "bad_config",
			"invalid %s rejected with %s %s, got %s" % [v["name"], want["path"], want["rule"], JSON.stringify(cfg.error)])
	_extras()
	await _wiring()
	print("blueprint: %d passed, %d failed" % [_pass, _fail])
	quit(1 if _fail > 0 else 0)


func _room_section() -> void:
	var cfg := OneLobbyConfig.parse({"game": {"id": "a"}, "engine": "godot-gdscript", "lobby": {"maxPlayers": 6}, "players": {"maxNameLength": 12},
		"room": {"autoStart": "all_ready", "spectators": 2, "countdownSeconds": 0, "lateJoin": "spectate", "data": {"role": {"type": "enum", "values": ["tank", "healer"], "default": "tank"}}}})
	_check(cfg.ok and cfg.room["auto_start"] == "all_ready" and cfg.room["spectators"] == 2 and cfg.room["countdown_seconds"] == 0 and cfg.room["late_join"] == "spectate", "room section is snake_case in cfg.room")
	_check(cfg.room["data"]["role"]["values"] == ["tank", "healer"] and cfg.room["rejoin_window_seconds"] == 60 and cfg.room["seat_dropped"] == "window", "room data declarations keep the file's keys; defaults fill in")
	var o := cfg.room_options()
	_check(o["max_name_length"] == 12 and o["auto_start"] == "all_ready" and o.has("data"), "room_options carries the players.maxNameLength")
	var s := OneLobbyRoomRules.resolve_settings(o, 6, true)
	_check(s["spectators"] == 2 and s["countdownMs"] == 0 and s["lateJoin"] == "spectate" and s["maxNameLength"] == 12 and s["data"].has("role") and s["data"].has("color"), "the room settings a host starts with come out of the file")
	var plain := OneLobbyConfig.parse({"game": {"id": "a"}, "lobby": {"lateJoin": false}})
	_check(plain.room["late_join"] == "refuse" and plain.lobby["late_join"] == false, "lobby.lateJoin false makes room.lateJoin refuse")


func _extras() -> void:
	_room_section()
	# text and files
	var bad := OneLobbyConfig.parse("{ not json")
	_check(not bad.ok and bad.error["rule"] == "json" and bad.error["code"] == "bad_config", "invalid JSON text: json rule")
	bad = OneLobbyConfig.parse("[]")
	_check(not bad.ok and bad.error["path"] == "" and bad.error["rule"] == "type", "a JSON array is not a blueprint")
	bad = OneLobbyConfig.load_file("user://does-not-exist.json")
	_check(not bad.ok and bad.error["rule"] == "file", "missing file: file rule")
	var path := "user://blueprint_test.json"
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.store_string(JSON.stringify({
		"$schema": "x", "$comment": "ignored",
		"game": {"id": "com.example.sam", "netVersion": "7", "title": "Sam's ants"},
		"engine": "godot-gdscript", "lobby": {"maxPlayers": 6, "meta": {"map": "Dunes"}},
	}))
	f.close()
	var cfg := OneLobbyConfig.load_file(path)
	_check(cfg.ok and cfg.game_id == "com.example.sam" and cfg.net_version == "7" and cfg.title == "Sam's ants" and cfg.engine == "godot-gdscript", "load_file reads the file")
	_check(cfg.lobby["max_players"] == 6 and cfg.lobby["meta"] == {"map": "Dunes"} and cfg.lobby["late_join"] == true, "sections are snake_case with defaults")
	_check(cfg.hosting["direct"] == true and cfg.hosting["server"] == false and cfg.hosting["nostr_relays"] == OneLobbyConfig.DEFAULT_NOSTR_RELAYS, "godot-gdscript hosts direct by default")
	_check(cfg.sync["tick_rate"] == 20 and cfg.sync["hash_every_ticks"] == 20 and cfg.session["ready_timeout_ms"] == 15000 and not cfg.session.has("rate_limit"), "sync and session defaults")
	_check(not cfg.data["game"].has("$comment") and not cfg.data.has("$schema"), "$comment and $schema are dropped")
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	# host options
	var o := cfg.host_options("Sam")
	_check(o["name"] == "Sam's game" and o["max_players"] == 6 and o["visibility"] == "unlisted" and o["late_join"] == true and o["meta"] == {"map": "Dunes"} and not o.has("rate_limit"), "host_options")
	_check(cfg.host_options()["name"] == "Game", "host_options without a name")
	var p := OneLobbyConfig.parse({"game": {"id": "a"}, "engine": "godot-gdscript", "lobby": {"listed": true}, "session": {"rateLimit": {"messages": 60, "perMs": 1000}}})
	_check(p.host_options()["visibility"] == "public" and p.host_options()["rate_limit"] == {"messages": 60, "per_ms": 1000}, "listed is public, rate_limit maps")
	p = OneLobbyConfig.parse({"game": {"id": "a"}, "lobby": {"approveJoins": true}})
	_check(p.host_options()["visibility"] == "private", "approveJoins is private")
	var d := cfg.direct_options("Sam")
	_check(d["tcp_port"] == 47810 and d["nostr"] == true and not d.has("visibility") and d["relays"] == OneLobbyConfig.DEFAULT_NOSTR_RELAYS, "direct_options")
	# names
	var named := OneLobbyConfig.parse({"game": {"id": "a"}, "players": {"maxNameLength": 5}})
	_check(named.check_display_name("Sam").is_empty() and named.check_display_name("").is_empty(), "short name is fine")
	var e := named.check_display_name("Samantha")
	_check(e.get("code") == "bad_config" and e.get("path") == "displayName" and e.get("rule") == "length", "name too long: bad_config displayName length")
	var anon := OneLobbyConfig.parse({"game": {"id": "a"}, "players": {"identity": "anonymous"}})
	_check(anon.check_display_name("Sam").get("code") == "identity_anonymous" and anon.check_display_name("").is_empty(), "anonymous game takes no name")
	# raw and lockstep run; replication is the mode GDScript lacks
	_check(cfg.check_gdscript().is_empty(), "raw is supported")
	var ls := OneLobbyConfig.parse({"game": {"id": "a"}, "engine": "godot-gdscript", "sync": {"mode": "lockstep", "tickRate": 25}})
	_check(ls.ok and ls.check_gdscript().is_empty() and ls.sync["mode"] == "lockstep" and ls.sync["tick_rate"] == 25 and ls.sync["hash_every_ticks"] == 25, "lockstep is supported (hashEveryTicks defaults to the tick rate)")
	var m := OneLobbyConfig.parse({"game": {"id": "a"}, "engine": "dotnet", "sync": {"mode": "replication"}})
	_check(m.ok, "replication parses (other engines read the same file)")
	var ge := m.check_gdscript()
	_check(ge.get("code") == "bad_config" and ge.get("rule") == "gdscript_raw_only" and ge.get("path") == "sync.mode" and str(ge.get("message")).contains("replication"), "replication: stable gdscript_raw_only failure")
	# every engine value of the schema loads
	for eng: String in ["web", "node-browser", "godot-csharp", "godot-gdscript", "unity", "dotnet"]:
		var ok_cfg := OneLobbyConfig.parse({"game": {"id": "a"}, "engine": eng, "hosting": {"direct": eng != "web", "server": true}})
		_check(ok_cfg.ok and ok_cfg.engine == eng, "engine %s" % eng)


func _wiring() -> void:
	# from_config: fields, no network
	var c := OneLobbyClient.from_config({"game": {"id": "com.example.ants", "netVersion": "3"}, "engine": "godot-gdscript", "sync": {"tickRate": 40}, "hosting": {"relayOnly": true, "lobbyServer": "ws://127.0.0.1:1/ws"}, "session": {"readyTimeoutMs": 9000, "peerTimeoutMs": 8000}}, {"display_name": "Sam"})
	_check(c.config_error.is_empty() and c.game_id == "com.example.ants" and c.net_version == "3" and c.display_name == "Sam" and c.tick_rate == 40 and c.relay_only and c.ready_timeout_ms == 9000 and c.peer_timeout_ms == 8000, "from_config sets the client fields")
	_check(c.lobby_server == "ws://127.0.0.1:1/ws", "lobby_server from the file")
	c.free()
	c = OneLobbyClient.from_config({"game": {"id": "a"}, "hosting": {"lobbyServer": "ws://a/ws"}}, {"lobby_server": "ws://b/ws"})
	_check(c.lobby_server == "ws://b/ws", "lobby_server override wins over the file")
	c.free()

	# a lockstep file configures the client: mode, tick rate, hash interval
	c = OneLobbyClient.from_config({"game": {"id": "a"}, "sync": {"mode": "lockstep", "tickRate": 25, "hashEveryTicks": 50}})
	_check(c.config_error.is_empty() and c.sync_mode == "lockstep" and c.tick_rate == 25 and c.hash_every_ticks == 50, "lockstep file: sync_mode, tick_rate and hash_every_ticks from the file")
	c.free()
	c = OneLobbyClient.from_config({"game": {"id": "a"}})
	_check(c.sync_mode == "raw" and c.hash_every_ticks == 20, "raw file: sync_mode raw, hash interval defaults to the tick rate")
	c.free()

	# failures are stable and come out of the usual last_error (replication is the one mode GDScript lacks)
	c = OneLobbyClient.from_config({"game": {"id": "a"}, "engine": "dotnet", "sync": {"mode": "replication"}})
	root.add_child(c)
	var errs: Array = []
	c.error.connect(func(code: String, _msg: String) -> void: errs.append(code))
	_check(c.config_error.get("rule") == "gdscript_raw_only", "replication file: config_error")
	var l: OneLobbyLobby = await c.host()
	_check(l == null and c.last_error.get("code") == "bad_config" and str(c.last_error.get("message")).contains("replication"), "replication file: host() fails with bad_config")
	l = await c.join("7HQ 4K2")
	_check(l == null and c.last_error.get("code") == "bad_config" and errs == ["bad_config", "bad_config"], "replication file: join() fails too and the error signal fires")
	_check((await c.list()).is_empty() and c.last_error.get("code") == "bad_config", "replication file: list() fails")
	c.queue_free()
	c = OneLobbyClient.from_config({"game": {"id": "a", "extra": 1}})
	root.add_child(c)
	l = await c.host()
	_check(l == null and c.last_error.get("code") == "bad_config" and c.config_error.get("path") == "game.extra" and c.config_error.get("rule") == "unknown_key", "invalid file: host() fails with the path and rule")
	c.queue_free()
	c = OneLobbyClient.from_config("user://missing-onelobby.json")
	_check(c.config_error.get("rule") == "file", "missing file: config_error")
	c.free()
	c = OneLobbyClient.from_config({"game": {"id": "a"}, "players": {"identity": "anonymous"}}, {"display_name": "Sam"})
	root.add_child(c)
	l = await c.host()
	_check(l == null and c.last_error.get("code") == "identity_anonymous", "anonymous game refuses a name")
	c.queue_free()

	# a direct-only game: no lobby server for list(), a lobby code has nowhere to go
	c = OneLobbyClient.from_config({"game": {"id": "a"}, "engine": "godot-gdscript"})
	root.add_child(c)
	_check((await c.list()).is_empty() and c.last_error.get("code") == "listing_disabled", "list() without hosting.server: listing_disabled")
	l = await c.join("7HQ 4K2")
	_check(l == null and c.last_error.get("code") == "no_server", "a lobby code without hosting.server: no_server")
	c.queue_free()
	# a server game with no address
	c = OneLobbyClient.from_config({"game": {"id": "a"}, "hosting": {"server": true}})
	root.add_child(c)
	l = await c.host()
	_check(l == null and c.last_error.get("code") == "no_server", "hosting.server without an address: no_server")
	c.queue_free()

	# one call from the file to a hosted lobby and a joined one, all on 127.0.0.1 (no relays: nostr is off in the file)
	var bp := {"game": {"id": "bp-loopback", "netVersion": "2"}, "engine": "godot-gdscript", "hosting": {"nostr": false}, "lobby": {"maxPlayers": 3, "meta": {"map": "Dunes"}}}
	var host := OneLobbyClient.from_config(bp, {"display_name": "Sam"})
	root.add_child(host)
	var lh: OneLobbyLobby = await host.host({"tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1", "udp_port_range": [47960, 47962]})
	if lh == null:
		_check(false, "host() from a direct-only file: %s" % JSON.stringify(host.last_error))
		return
	_check(lh.ip_code != "" and lh.meta == {"map": "Dunes"} and lh.late_join and lh.mode == "raw", "host() from the file: direct lobby with the file's settings (%s)" % lh.ip_code)
	var join := OneLobbyClient.from_config(bp, {"display_name": "Ann"})
	root.add_child(join)
	var lj: OneLobbyLobby = await join.join(lh.ip_code)
	if lj == null:
		_check(false, "join() of a direct code from the file: %s" % JSON.stringify(join.last_error))
		return
	var got: Array = []
	lj.ready.connect(func() -> void: got.append("ready"))
	for _i in 300:
		await process_frame
		if lh.is_peer_ready(lj.local_peer_id) and got.has("ready"):
			break
	_check(lj.peers().size() == 2 and got.has("ready"), "joiner is in the lobby and linked to the host")
	var inbox: Array = []
	lh.message_received.connect(func(from: int, bytes: PackedByteArray, _ch: int) -> void: inbox.append([from, bytes.get_string_from_utf8()]))
	lj.broadcast("hi".to_utf8_buffer())
	for _i in 120:
		await process_frame
		if not inbox.is_empty():
			break
	_check(inbox == [[lj.local_peer_id, "hi"]], "a raw message crosses the link")
	lj.leave()
	lh.leave()
	await process_frame
	host.queue_free()
	join.queue_free()
