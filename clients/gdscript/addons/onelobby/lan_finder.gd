class_name OneLobbyLanFinder
extends Node
## Finds LAN hosts (spec/lan-discovery.md s.4). start() opens one UDP socket on a port the system picks and asks now and then;
## stop() closes it, empties the list and drops any late datagram. `games` is the list a menu draws, `changed` fires when a row
## appears, goes or changes. It polls itself every frame while it runs (poll() is public for a test with its own clock).
## Nothing is opened before start(), and nothing at all when `enabled` is false (hosting.lan is off in the blueprint).
##
## A row: {address, port, name, host_name, players, max_players, has_password, same_version, net_version, last_seen_ms}.
## `name`, `players` and `max_players` are the keys the lobby browser's rows use; `same_version` false = another netVersion
## (the row says why it cannot be joined). Join through the existing path: client.join_direct("%s:%d" % [row.address, row.port]).

signal changed(games: Array)
signal status_changed(status: String, reason: String)

## "idle", "running", "off" (hosting.lan false), "browser" (a web export has no UDP sockets) or "socket_failed".
var status := "idle"
var status_reason := ""
## kept, malformed, bad_source, wrong_nonce, wrong_game, full
var stats := {"kept": 0, "malformed": 0, "bad_source": 0, "wrong_nonce": 0, "wrong_game": 0, "full": 0}
var games: Array[Dictionary] = []
## The UDP port the finder's own socket uses (0 while it has none).
var local_port := 0

var game_id := ""
var net_version := "1"
var enabled := true
## Where to ask; empty = OneLobbyLan.broadcast_targets(). A test or a --local game passes ["127.0.0.1"].
var targets := PackedStringArray()
var port := OneLobbyLan.DEFAULT_PORT
var ask_interval_ms := OneLobbyLan.ASK_INTERVAL_MS
var min_gap_ms := OneLobbyLan.MIN_GAP_MS
var row_timeout_ms := OneLobbyLan.ROW_TIMEOUT_MS
var now_fn := Callable(Time, "get_ticks_msec")
var log_fn := Callable()

var _udp: PacketPeerUDP = null
var _nonces: Array[String] = []
var _last_ask := -1000000000
var _ask_held := false


func _init(p_game_id := "", p_net_version := "1", options: Dictionary = {}) -> void:
	game_id = p_game_id
	net_version = p_net_version
	for k: String in options:
		set(k, options[k])
	set_process(false)


func is_running() -> bool:
	return status == "running"


func start() -> String:
	if status == "running":
		return status
	if not enabled:
		_set_status("off", "hosting.lan is off")
		return status
	if OS.has_feature("web"):
		_set_status("browser", "a browser cannot look for LAN games: it has no UDP sockets")
		return status
	var t := _targets()
	var local := not t.is_empty()
	for x in t:
		if not x.begins_with("127."):
			local = false
	var udp := PacketPeerUDP.new()
	if not local:
		udp.set_broadcast_enabled(true)
	var err := udp.bind(0, "127.0.0.1" if local else "0.0.0.0")
	if err != OK:
		udp.close()
		_set_status("socket_failed", error_string(err))
		_say("LAN finder could not open its socket: " + error_string(err))
		return status
	_udp = udp
	local_port = udp.get_local_port()
	_set_status("running")
	_say("LAN finder started (asking %s)" % ", ".join(t))
	_ask()
	set_process(true)
	return status


func stop() -> void:
	set_process(false)
	var was := _udp != null
	if _udp != null:
		_udp.close()
		_udp = null
	local_port = 0
	_nonces.clear()
	_ask_held = false
	if was:
		_set_status("idle")
		_say("LAN finder stopped")
	if not games.is_empty():
		games = []
		changed.emit(games.duplicate(true))


## Asks at once (held until min_gap_ms after the last question when that is sooner).
func ask_now() -> void:
	if _udp == null:
		return
	if int(now_fn.call()) - _last_ask < min_gap_ms:
		_ask_held = true
		return
	_ask()


## Test seam: treat this nonce (16 hex characters) as one this finder sent.
func remember_nonce(hex: String) -> void:
	_nonces.append(hex)
	if _nonces.size() > OneLobbyLan.NONCES_KEPT:
		_nonces.pop_front()


func _process(_delta: float) -> void:
	poll()


## Reads answers, asks on the timer, drops stale rows.
func poll() -> void:
	if _udp == null:
		return
	while _udp != null and _udp.get_available_packet_count() > 0:
		var pkt := _udp.get_packet()
		if _udp.get_packet_error() != OK:
			continue
		receive(pkt, _udp.get_packet_ip(), _udp.get_packet_port())
	if _udp == null:
		return
	var now := int(now_fn.call())
	if (_ask_held or now - _last_ask >= ask_interval_ms) and now - _last_ask >= min_gap_ms:
		_ask()
	var keep: Array[Dictionary] = []
	for r in games:
		if now - int(r["last_seen_ms"]) < row_timeout_ms:
			keep.append(r)
	if keep.size() != games.size():
		games = keep
		changed.emit(games.duplicate(true))


## The finder's rules for one datagram (spec s.4): "ok", "other_version" or the drop reason.
func receive(bytes: PackedByteArray, address: String, from_port: int) -> String:
	var a := OneLobbyLan.decode_answer(bytes)
	if a.is_empty():
		return _drop("malformed")
	if OneLobbyLan.source_class(address) == "":
		return _drop("bad_source")
	if not _nonces.has((a["nonce"] as PackedByteArray).hex_encode()):
		return _drop("wrong_nonce")
	if str(a["game_id"]) != game_id:
		return _drop("wrong_game")
	var same := str(a["net_version"]) == net_version
	var row := {
		"address": address, "port": int(a["port"]), "name": OneLobbyLan.clean_name(str(a["lobby_name"])),
		"host_name": OneLobbyLan.clean_name(str(a["host_name"])), "players": int(a["players"]), "max_players": int(a["max_players"]),
		"has_password": bool(a["password"]), "same_version": same, "net_version": str(a["net_version"]), "last_seen_ms": int(now_fn.call()),
	}
	var idx := -1
	for i in games.size():
		if games[i]["address"] == address and int(games[i]["port"]) == int(a["port"]):
			idx = i
	var did_change := false
	if idx >= 0:
		var o := games[idx]
		for k: String in ["name", "host_name", "players", "max_players", "has_password", "same_version", "net_version"]:
			if o[k] != row[k]:
				did_change = true
		games[idx] = row
	elif games.size() < OneLobbyLan.MAX_ROWS:
		games.append(row)
		did_change = true
	else:
		stats["full"] += 1
		return "ok"
	stats["kept"] += 1
	if did_change:
		changed.emit(games.duplicate(true))
	return "ok" if same else "other_version"


func _targets() -> PackedStringArray:
	return targets if not targets.is_empty() else OneLobbyLan.broadcast_targets()


func _ask() -> void:
	if _udp == null:
		return
	_last_ask = int(now_fn.call())
	_ask_held = false
	var nonce := Crypto.new().generate_random_bytes(8)
	remember_nonce(nonce.hex_encode())
	var q := OneLobbyLan.encode_question(nonce, game_id)
	if q.is_empty():
		return
	for t in _targets():
		_udp.set_dest_address(t, port)
		_udp.put_packet(q)


func _drop(k: String) -> String:
	stats[k] += 1
	return k


func _set_status(s: String, reason := "") -> void:
	status = s
	status_reason = reason
	status_changed.emit(s, reason)


func _say(line: String) -> void:
	if log_fn.is_valid():
		log_fn.call(line)
