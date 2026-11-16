extends SceneTree
## The room layer's pure rules against the shared vectors (spec/vectors/room.json): names, per-player data, seats, bans,
## auto start, the countdown time base, admission, reasons, player ids and the exact bytes of room frames; plus the JSON
## writer (JS `JSON.stringify` byte for byte), the key/value stores and the ban list.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/room_vectors.gd
## Prints "room_vectors: N passed, M failed"; exits 1 on any failure.

var _pass := 0
var _fail := 0


func _init() -> void:
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
	var v: Dictionary = _spec("vectors/room.json")
	_names(v)
	_data(v)
	_seats(v)
	_bans(v)
	_auto_start(v)
	_countdown(v)
	_admission(v)
	_reasons(v)
	_player_ids(v)
	_frames(v)
	_json_writer()
	_signaling()
	_stores()
	_ban_list()
	print("room_vectors: %d passed, %d failed" % [_pass, _fail])
	quit(1 if _fail > 0 else 0)


func _names(v: Dictionary) -> void:
	var filters := {}
	for k: String in v["names"]["filters"]:
		var f: Variant = v["names"]["filters"][k]
		if f == null:
			filters[k] = Callable()
		else:
			var from: String = f["replace"][0]
			var to: String = f["replace"][1]
			filters[k] = func(text: String, _kind: String) -> String: return text.replace(from, to)
	for c: Dictionary in v["names"]["cases"]:
		var got := OneLobbyRoomRules.effective_name(c["input"], int(c["peerId"]), c["others"], int(c["max"]), filters[c.get("filter", "none")])
		_check(got == c["expect"], "names %s: got '%s', want '%s'" % [c["name"], got, c["expect"]])
	# a filter that is not a function of text, or returns a non-string, counts as no hook
	var odd := func(_t: String, _k: String) -> Variant: return 5
	_check(OneLobbyRoomRules.effective_name("Sam", 2, [], 24, odd) == "Sam", "names: a non-string filter result counts as no hook")


func _data(v: Dictionary) -> void:
	var spec := OneLobbyRoomRules.merge_data_spec(v["data"]["spec"])
	for c: Dictionary in v["data"]["cases"]:
		var got := OneLobbyRoomRules.apply_data(spec, c["before"], c["set"], bool(c["byHost"]))
		_check(_same(got, c["expect"]), "data %s: got %s, want %s" % [c["name"], JSON.stringify(got), JSON.stringify(c["expect"])])
	for c: Dictionary in v["data"]["defaultsAtAdmission"]:
		var got := OneLobbyRoomRules.data_defaults(spec, c["data"])
		_check(_same(got, c["expect"]), "defaults %s: got %s" % [c["name"], JSON.stringify(got)])
	# the 1024-byte limit counts JSON.stringify bytes of the whole data object (keys sorted does not change the size)
	var big := OneLobbyRoomRules.merge_data_spec({"a": {"type": "string", "maxLength": 64}, "b": {"type": "string", "maxLength": 64}})
	var before := {}
	var ok_count := 0
	for i in 40:
		var key := "k%d" % i
		big[key] = {"type": "string", "maxLength": 64}
		var r := OneLobbyRoomRules.apply_data(big, before, {key: "x".repeat(20)}, false)
		if not r["ok"]:
			_check(r["code"] == "too_large" and not r.has("key"), "data: the limit is too_large without a key")
			break
		before = r["data"]
		ok_count += 1
	var bytes := OneLobbyRoomWire.json_text(before).to_utf8_buffer().size()
	_check(bytes <= 1024 and ok_count > 20 and ok_count < 40, "data: stays within 1024 bytes (%d entries, %d bytes)" % [ok_count, bytes])
	# multi-byte text counts in UTF-8 bytes: 20 x 3-byte characters
	var wide := OneLobbyRoomRules.merge_data_spec({"w": {"type": "string", "maxLength": 64}})
	var r2 := OneLobbyRoomRules.apply_data(wide, {}, {"w": "€".repeat(64)}, false)
	_check(r2["ok"] and OneLobbyRoomWire.json_text(r2["data"]).to_utf8_buffer().size() == 64 * 3 + 8, "data: a non-ASCII value counts its UTF-8 bytes")


func _seats(v: Dictionary) -> void:
	for c: Dictionary in v["seats"]:
		var memory := {}
		var held := {} # pid -> seat of the players now in the room
		var got: Array = []
		var seat_of := func(pid: String, role: String) -> int:
			if role == "spectator":
				return -1
			var seats := {}
			for s: Variant in held.values():
				seats[int(s)] = true
			var r := OneLobbyRoomRules.choose_seat(int(c["maxPlayers"]), seats, memory, pid)
			if r["take_over"] != "":
				memory.erase(r["take_over"])
			if int(r["seat"]) >= 0:
				held[pid] = int(r["seat"])
				if pid != "":
					memory[pid] = int(r["seat"])
			return int(r["seat"])
		for op: Array in c["ops"]:
			if op[0] == "join":
				got.append(seat_of.call(op[1], op[2]))
			elif op[0] == "drop":
				held.erase(op[1])
				got.append(null)
			else:
				held.erase(op[1]) # a role change: the entry keeps its memory
				got.append(seat_of.call(op[1], op[2]))
		_check(_same(got, c["expect"]), "seats %s: got %s, want %s" % [c["name"], JSON.stringify(got), JSON.stringify(c["expect"])])


func _bans(v: Dictionary) -> void:
	for c: Dictionary in v["bans"]["cases"]:
		_check(OneLobbyRoomRules.ban_matches(c["entry"], c["candidate"]) == bool(c["expect"]), "bans %s" % c["name"])


func _auto_start(v: Dictionary) -> void:
	for c: Dictionary in v["autoStart"]["cases"]:
		var players: Array = []
		for tok: String in c["players"]:
			players.append({"role": "spectator" if tok[0] == "s" else "player", "status": "reconnecting" if tok[1] == "x" else "connected",
				"ready": tok[1] == "r", "legacy": tok[1] == "l"})
		_check(OneLobbyRoomRules.auto_start_holds(c["rule"], players) == bool(c["expect"]), "autostart %s" % c["name"])


func _countdown(v: Dictionary) -> void:
	for c: Dictionary in v["countdown"]["cases"]:
		var got := OneLobbyRoomRules.countdown_remaining(int(c["left"]), c["rtt"])
		_check(got == int(c["expect"]), "countdown %s: got %d, want %d" % [c["name"], got, int(c["expect"])])


func _admission(v: Dictionary) -> void:
	for c: Dictionary in v["admission"]["cases"]:
		var input: Dictionary = (v["admission"]["base"] as Dictionary).duplicate()
		input.merge(c["with"], true)
		var got := OneLobbyRoomRules.admit(input)
		_check(_same(got, c["expect"]), "admission %s: got %s" % [c["name"], JSON.stringify(got)])


func _reasons(v: Dictionary) -> void:
	for code: String in v["defaultReasons"]:
		_check(OneLobbyRoomRules.removal_reason(code, "") == v["defaultReasons"][code], "default reason of %s" % code)
	for i in (v["reasonRules"]["cases"] as Array).size():
		var c: Dictionary = v["reasonRules"]["cases"][i]
		_check(OneLobbyRoomRules.removal_reason(c["code"], c["text"]) == c["expect"], "reason rule %d" % i)


func _player_ids(v: Dictionary) -> void:
	for s: String in v["playerId"]["valid"]:
		_check(OneLobbyRoomRules.is_player_id(s), "valid player id " + s)
	for s: String in v["playerId"]["invalid"]:
		_check(not OneLobbyRoomRules.is_player_id(s), "invalid player id '%s'" % s)
	var a := OneLobbyRoomRules.new_player_id()
	_check(OneLobbyRoomRules.is_player_id(a) and OneLobbyRoomRules.new_player_id() != a, "new_player_id makes distinct valid ids")
	_check(not OneLobbyRoomRules.is_player_id(null) and not OneLobbyRoomRules.is_player_id(5) and not OneLobbyRoomRules.is_player_id("0123456789abcdef0123456789abcdef\n"), "player id: only a clean 32-hex string")


func _frames(v: Dictionary) -> void:
	for f: Dictionary in v["frames"]:
		var bytes := OneLobbyRoomWire.encode_frame(f["json"])
		_check(bytes.hex_encode() == f["hex"], "frame %s encodes to the vector bytes (got %s)" % [f["name"], bytes.hex_encode()])
		var back := OneLobbyRoomWire.decode_frame(String(f["hex"]).hex_decode())
		_check(_same(back, f["json"]), "frame %s decodes to its JSON" % f["name"])
	_check(OneLobbyRoomWire.decode_frame(PackedByteArray([0x80, 0, 0, 0xff, 0xfe])).is_empty(), "a body that is not UTF-8 is dropped")
	_check(OneLobbyRoomWire.decode_frame(PackedByteArray([0x80, 0, 0]) + "[1]".to_utf8_buffer()).is_empty(), "a body that is not an object is dropped")
	_check(OneLobbyRoomWire.decode_frame(PackedByteArray([0x80, 0, 0]) + "{\"x\":1}".to_utf8_buffer()).is_empty(), "a body without a string t is dropped")
	_check(OneLobbyRoomWire.decode_frame(PackedByteArray([0x80, 0, 0]) + "{".to_utf8_buffer()).is_empty(), "broken JSON is dropped")
	_check(OneLobbyRoomWire.decode_frame(OneLobbyWire.build_ping(OneLobbyWire.PING, 1, 2)).is_empty(), "another frame type is not a room frame")
	# the frame validator takes the rest of the frame as the body, and a frame over 16384 bytes still encodes (chunked on send)
	var m := OneLobbyWire.decode(PackedByteArray([0x80, 7, 0, 0x7b, 0x7d]))
	_check(str(m.get("type")) == "room" and m["route"] == 7 and m["body"] == PackedByteArray([0x7b, 0x7d]), "wire.decode reads type 0x80 as room with the rest as body")
	var big := OneLobbyRoomWire.encode_frame({"t": "snap", "pad": "x".repeat(20000)})
	_check(big.size() > OneLobbyWire.MAX_FRAME and not OneLobbyRoomWire.decode_frame(big).is_empty(), "a roster frame over 16384 bytes encodes for chunking")


func _json_writer() -> void:
	var w := OneLobbyRoomWire
	_check(w.json_text({"a": 1.0, "b": [1, 2.0, true, null], "c": "x"}) == "{\"a\":1,\"b\":[1,2,true,null],\"c\":\"x\"}", "json: whole floats print as integers, compact")
	_check(w.json_text("a\"b\\c\n\t\u0001\u007f/") == "\"a\\\"b\\\\c\\n\\t\\u0001\u007f/\"", "json: JS string escapes (control as \\u00xx lower case, DEL and slash raw)")
	_check(w.json_text("é€😀") == "\"é€😀\"", "json: non-ASCII stays raw")
	_check(w.json_text({"b": 1, "a": {"d": 1, "c": 2}}, true) == "{\"a\":{\"c\":2,\"d\":1},\"b\":1}" and w.json_text({"b": 1, "a": 2}) == "{\"b\":1,\"a\":2}", "json: sorted keys only on request")
	_check(w.json_text(-0.0) == "0" and w.json_text(2147483647) == "2147483647" and w.json_text({}) == "{}" and w.json_text([]) == "[]", "json: small cases")


func _signaling() -> void:
	var pid := "0123456789abcdef0123456789abcdef"
	var hello: Dictionary = JSON.parse_string(OneLobbySignaling.hello("g", "1", "Sam", "", pid))
	_check(hello["playerId"] == pid and not (JSON.parse_string(OneLobbySignaling.hello("g", "1", "Sam")) as Dictionary).has("playerId"), "hello carries playerId only when there is one")
	var create: Dictionary = JSON.parse_string(OneLobbySignaling.create({"max_players": 4}, "raw", 30, "pw", 2))
	_check(create["password"] == "pw" and create["spectators"] == 2 and create["maxPlayers"] == 4, "create carries password and spectators for a hub with the room feature")
	var plain: Dictionary = JSON.parse_string(OneLobbySignaling.create({"max_players": 4}, "raw", 30))
	_check(not plain.has("password") and not plain.has("spectators"), "and neither without")
	var jp: Dictionary = JSON.parse_string(OneLobbySignaling.join("ABC", "pw"))
	_check(jp == {"t": "join", "code": "ABC", "password": "pw"} and (JSON.parse_string(OneLobbySignaling.join("ABC")) as Dictionary).size() == 2, "join carries the password when given")
	var kick: Dictionary = JSON.parse_string(OneLobbySignaling.kick(3, false, 0, "bye", "smoke_kick"))
	_check(kick["t"] == "kick" and int(kick["peerId"]) == 3 and kick["ban"] == false and kick["closeReason"] == "bye" and kick["code"] == "smoke_kick" and kick.size() == 5, "kick carries the removal code (%s)" % JSON.stringify(kick))
	_check((JSON.parse_string(OneLobbySignaling.bans([pid])) as Dictionary)["ids"] == [pid], "bans lists player ids")


func _stores() -> void:
	var m := OneLobbyStore.memory()
	_check(m.get_item("k") == null, "memory store: missing key is null")
	m.set_item("k", "v")
	_check(m.get_item("k") == "v", "memory store keeps a value")
	m.remove_item("k")
	_check(m.get_item("k") == null, "memory store removes a value")
	var path := "user://room_vectors_store.json"
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	var f := OneLobbyStore.file(path)
	f.set_item("a", "1")
	f.set_item("b", "two")
	var g := OneLobbyStore.file(path)
	_check(g.get_item("a") == "1" and g.get_item("b") == "two", "file store survives a reload")
	g.remove_item("a")
	_check(OneLobbyStore.file(path).get_item("a") == null and OneLobbyStore.file(path).get_item("b") == "two", "file store removal is saved")
	var bad := FileAccess.open(path, FileAccess.WRITE)
	bad.store_string("{ not json")
	bad.close()
	_check(OneLobbyStore.file(path).get_item("b") == null, "a corrupt store file reads as empty")
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	# the player id: made once, kept, replaced when the stored one is not 32 hex
	var s := OneLobbyStore.memory()
	var id := OneLobbyStore.load_player_id(s, "game-a")
	_check(OneLobbyRoomRules.is_player_id(id) and OneLobbyStore.load_player_id(s, "game-a") == id, "player id is made once per store")
	_check(OneLobbyStore.load_player_id(s, "game-b") != id, "player id is per game")
	s.set_item(OneLobbyStore.player_id_key("game-a"), "nope")
	var fresh := OneLobbyStore.load_player_id(s, "game-a")
	_check(OneLobbyRoomRules.is_player_id(fresh) and fresh != "nope" and s.get_item(OneLobbyStore.player_id_key("game-a")) == fresh, "a bad stored id is replaced")
	_check(OneLobbyRoomRules.is_player_id(OneLobbyStore.load_player_id(null, "x")), "no store: still an id, for this session")


func _ban_list() -> void:
	var s := OneLobbyStore.memory()
	var a := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	var b := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	var list := OneLobbyBanList.new(s, "g")
	var n := [0]
	list.changed.connect(func() -> void: n[0] += 1)
	_check(list.size() == 0 and list.add({}).is_empty() and list.add({"ip": "127.0.0.1"}).is_empty() and n[0] == 0, "a ban needs a player id or a non-loopback address")
	list.add({"id": a, "ip": "10.0.0.1", "name": "Sam", "reason": "rude", "code": "banned", "at": 5})
	list.add({"ip": "::FFFF:10.0.0.2"})
	_check(list.size() == 2 and n[0] == 2 and list.list()[1]["ip"] == "10.0.0.2", "ids and addresses are stored; mapped IPv6 is normalised")
	_check(not list.match_entry({"id": a}).is_empty() and not list.match_entry({"ip": "10.0.0.1"}).is_empty() and list.match_entry({"id": b, "ip": "10.0.0.1"}).is_empty(), "match: id, address fallback, two ids behind one address")
	_check(not list.match_entry({"id": b, "ip": "10.0.0.2"}).is_empty(), "match: an address-only ban catches any id")
	list.add({"id": a, "reason": "again"})
	_check(list.size() == 2 and list.list().back()["reason"] == "again", "one entry per player id: a new ban replaces the old")
	_check(list.hub_ids() == [a], "hub_ids lists the banned player ids")
	var reloaded := OneLobbyBanList.new(s, "g")
	_check(reloaded.size() == 2 and not reloaded.match_entry({"id": a}).is_empty(), "the list survives in the store")
	_check(OneLobbyBanList.new(s, "other").size() == 0, "the list is per game id")
	_check(list.remove(a) == 1 and list.remove("10.0.0.2") == 1 and list.size() == 0, "unban by player id and by address")
	_check(OneLobbyBanList.new(s, "g").size() == 0, "unban is saved")
	s.set_item(OneLobbyStore.bans_key("g"), "{ broken")
	var broken := OneLobbyBanList.new(s, "g")
	_check(broken.size() == 0 and s.get_item(OneLobbyStore.bans_key("g")) == "{ broken", "a corrupt list loads as empty and is not overwritten until a change")
	for i in 1005:
		broken.add({"id": "%032x" % i})
	_check(broken.size() == OneLobbyBanList.MAX_BANS and broken.hub_ids().size() == OneLobbyBanList.HUB_BAN_IDS, "at most 1000 entries (the oldest go) and 256 ids for the hub")
	broken.clear()
	_check(broken.size() == 0, "clear")
