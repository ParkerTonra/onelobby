class_name OneLobbyLanAnswerer
extends RefCounted
## The host's answering rules (spec/lan-discovery.md s.3), with no socket: handle() gets a datagram and the address it came
## from, and calls `reply` (bytes, address, port) with the answer when every check passes.

## answered, bad_source, malformed, wrong_game, duplicate, rate_limited
var stats := {"answered": 0, "bad_source": 0, "malformed": 0, "wrong_game": 0, "duplicate": 0, "rate_limited": 0}

var _game_id := ""
var _net_version := ""
## Returns {} when no lobby is open, else {lobby_name, host_name, players, max_players, password, port}.
var _info: Callable
var _reply: Callable
var _now: Callable
var _seen: Array = [] # [key, at]
var _win_start := 0
var _win_total := 0
var _win_by_source := {}


func _init(game_id: String, net_version: String, info: Callable, reply: Callable, now_fn: Callable = Callable()) -> void:
	_game_id = game_id
	_net_version = net_version
	_info = info
	_reply = reply
	_now = now_fn if now_fn.is_valid() else Callable(Time, "get_ticks_msec")


## "answer" when an answer was sent, the drop counter's name when the datagram was dropped, "no_lobby" when none is open.
func handle(bytes: PackedByteArray, address: String, port: int) -> String:
	if OneLobbyLan.source_class(address) == "":
		return _drop("bad_source")
	var q := OneLobbyLan.decode_question(bytes)
	if q.is_empty():
		return _drop("malformed")
	if str(q["game_id"]) != _game_id:
		return _drop("wrong_game")
	var info: Dictionary = _info.call()
	if info.is_empty():
		return "no_lobby"
	var now := int(_now.call())
	var key := "%s/%s" % [address, (q["nonce"] as PackedByteArray).hex_encode()]
	_seen = _seen.filter(func(e: Array) -> bool: return now - int(e[1]) < OneLobbyLan.DUPLICATE_MS)
	for e: Array in _seen:
		if e[0] == key:
			return _drop("duplicate")
	if now - _win_start >= OneLobbyLan.RATE_WINDOW_MS or now < _win_start:
		_win_start = now
		_win_total = 0
		_win_by_source.clear()
	var by_source := int(_win_by_source.get(address, 0))
	if by_source >= OneLobbyLan.RATE_PER_SOURCE or _win_total >= OneLobbyLan.RATE_TOTAL:
		return _drop("rate_limited")
	_win_by_source[address] = by_source + 1
	_win_total += 1
	_seen.append([key, now])
	if _seen.size() > OneLobbyLan.DUPLICATES_KEPT:
		_seen.pop_front()
	var max_players := clampi(int(info["max_players"]), 1, 255)
	var answer := OneLobbyLan.encode_answer({
		"nonce": q["nonce"], "port": int(info["port"]), "players": clampi(int(info["players"]), 0, max_players),
		"max_players": max_players, "password": bool(info["password"]), "game_id": _game_id, "net_version": _net_version,
		"lobby_name": OneLobbyLan.clean_name(str(info["lobby_name"])), "host_name": OneLobbyLan.clean_name(str(info["host_name"])),
	})
	if answer.is_empty():
		return _drop("malformed")
	stats["answered"] += 1
	_reply.call(answer, address, port)
	return "answer"


func _drop(k: String) -> String:
	stats[k] += 1
	return k
