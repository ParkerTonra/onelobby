class_name OneLobbyRoom
extends RefCounted
## The room layer (spec/room.md): one host-authoritative roster with per-player data, ready, a start countdown, auto start,
## spectators, seats, a reconnecting state, kick and ban with reasons. The host holds the truth and replicates it to every
## peer over the room frame (0x80); a joiner's calls are requests the host validates. Every lobby has one: `lobby.room`.
## The same wire and behaviour as the JS `lobby.room` and C# `lobby.Room`, so GDScript, JS and C# players can share a room.
##
##     lobby.room.set_data({"color": "#ff8800"})
##     lobby.room.set_ready(true)
##     lobby.room.started.connect(func() -> void: print("go"))
##     if lobby.is_host:
##         lobby.room.start()              # a countdown every peer sees, then the lobby phase in_game
##         lobby.room.kick(peer_id, {"reason": "afk"})
##
## A roster row (entry) is {id, name, role: "player"|"spectator", seat (-1 for a spectator), ready, status:
## "connected"|"reconnecting", data: {key: String}, legacy?: true}. `id` is the peer id. Calls that can fail return the
## stable error code ("" when it worked) and also raise it on the client's `error` signal, where JS and C# throw.

## Anything in the room changed (after the matching specific signals).
signal changed
signal player_joined(entry: Dictionary)
## `why`: "left", "kicked", "disconnected" or "timeout". The entry has status "left".
signal player_left(entry: Dictionary, why: String)
## `keys`: "name", "role", "seat", "ready", "status", "legacy" and "data.<key>".
signal player_changed(entry: Dictionary, keys: Array)
signal state_changed(state: String, prev: String)
## The state became "started" (the lobby phase is in_game).
signal started
signal all_ready_changed(all_ready: bool)
## A countdown began, or the host sent its once-a-second tick: {seq, total, deadline, remaining} (see countdown()).
signal countdown_changed(countdown: Dictionary)
## `reason`: "host", "too_few" or "condition".
signal countdown_cancelled(reason: String)
## The room went from started or countdown back to lobby (a rematch comes through here too).
signal returned_to_lobby
signal settings_changed(settings: Dictionary)
## Host only: put a bot in this seat. `info`: {seat, peer_id, name, data, reason, after_window}.
signal seat_dropped(info: Dictionary)
## Host only: a player took a dropped seat back; take the bot out. `info`: {seat, peer_id, name, returning}.
signal seat_restored(info: Dictionary)
## Host only: a joiner asked for "start", "lobby" or "rematch". Nothing changed.
signal requested(peer_id: int, what: String)
## This peer was removed from the lobby: {code, reason, ban}. Fires once, before the lobby's session_ended.
signal removed(info: Dictionary)
## A request of this peer was refused by the host: `re` is "set", "ready", "role", "req" or "join"; `key` is "" or the data key.
signal rejected(code: String, re: String, key: String)
signal bans_changed
## The host speaks the room layer (its first snapshot arrived; a host is supported from the start).
signal became_supported
## The host never answered: it predates the room layer. `entries()` lists the hub roster and calls fail with room_unsupported.
signal became_unsupported

## How long a joiner waits for the host's room reply, and a host for a peer's `join`, before calling the other side old.
const JOIN_WAIT_MS := 3000
const COUNTDOWN_TICK_MS := 1000
const RESYNC_GAP_MS := 1000
const REQUESTS_PER_SECOND := 10

## Host only: filters names (kind "name") and chat lines (kind "chat"): `func(text: String, kind: String) -> String`.
## Nothing is filtered by default; a result that is not a String counts as no hook.
var filter := Callable()
## Host only: the persistent ban list (spec/room.md 5.3).
var bans: OneLobbyBanList
## null until known; true once the host answered (a host itself: always), false when it never did (an older host).
var supported: Variant = null
## "lobby", "countdown" or "started".
var state: String:
	get: return _state
## Every non-legacy player is connected and ready, and there is at least one.
var all_ready: bool:
	get: return _compute_all_ready()
## The replica's revision (spec/room.md 1).
var revision: int:
	get: return _rev

var _l: OneLobbyLobby
var _cfg: Dictionary
var _rev := 0
var _state := "lobby"
var _settings: Dictionary
var _roster := {} # peer id -> entry
var _cd := {} # {seq, total, deadline} or {}
var _closed := false
var _removed_fired := false
# joiner
var _support_deadline := 0
var _last_resync := -1000000
# host
var _pids := {} # peer id -> player id
var _seat_memory := {} # player id -> seat
var _dropped_seats := {}
var _drop_fired := {}
var _reconnect_until := {}
var _legacy_wait := {}
var _requests := {}
var _cd_seq := 0
var _cd_auto := false
## After back to lobby, auto start waits for the next roster or ready change.
var _auto_hold := false
var _next_cd := 0


## `cfg`: {settings, password, pid, bans, join: {role, data, password}}.
func _init(lobby: OneLobbyLobby, cfg: Dictionary) -> void:
	_l = lobby
	_cfg = cfg
	_settings = cfg["settings"]
	bans = cfg["bans"]
	bans.changed.connect(_on_bans_changed)
	if _l.is_host:
		_init_host()


func _on_bans_changed() -> void:
	bans_changed.emit()
	if _l.is_host:
		_l._send_bans(bans.hub_ids())


func _now() -> int:
	return _l.now_ms()


# ---- reading -------------------------------------------------------------------------------------------------------

## A copy of the settings: {maxPlayers, spectators, minPlayers, autoStart, autoStartPlayers, countdownMs, lateJoin,
## seatDropped, rejoinWindowMs, maxNameLength, data}.
func settings() -> Dictionary:
	return _settings.duplicate(true)


## Every entry (players, spectators, reconnecting ones), by peer id. Before the host's snapshot, or on an older host, the hub
## roster (every peer a player, seat -1, not ready).
func entries() -> Array:
	var out: Array = []
	if _l.is_host or supported == true:
		var ids: Array = _roster.keys()
		ids.sort()
		for id: int in ids:
			out.append((_roster[id] as Dictionary).duplicate(true))
		return out
	var pids: Array = _l._peer_ids()
	pids.sort()
	for id: int in pids:
		out.append(_entry(id, _l._peer_name(id), "player", -1, false, "connected", {}))
	return out


## Entries with role player, by seat.
func players() -> Array:
	var out := entries().filter(func(e: Dictionary) -> bool: return e["role"] == "player")
	out.sort_custom(func(a: Dictionary, b: Dictionary) -> bool:
		return a["seat"] < b["seat"] or (a["seat"] == b["seat"] and a["id"] < b["id"]))
	return out


func spectators() -> Array:
	return entries().filter(func(e: Dictionary) -> bool: return e["role"] == "spectator")


## The entry of a peer, or {}.
func player(peer_id: int) -> Dictionary:
	for e: Dictionary in entries():
		if e["id"] == peer_id:
			return e
	return {}


## This peer's own entry, or {}.
func me() -> Dictionary:
	return player(_l.local_peer_id)


## The countdown now running: {seq, total, deadline, remaining} (deadline in this lobby's now_ms() base, remaining in ms
## as of this call), or {} when there is none.
func countdown() -> Dictionary:
	return _view() if not _cd.is_empty() else {}


func _view() -> Dictionary:
	return {"seq": _cd["seq"], "total": _cd["total"], "deadline": _cd["deadline"], "remaining": maxi(0, int(_cd["deadline"]) - _now())}


func _compute_all_ready() -> bool:
	var n := 0
	for e: Dictionary in _roster.values():
		if e["role"] == "player" and not e.get("legacy", false):
			n += 1
			if e["status"] != "connected" or not e["ready"]:
				return false
	return n > 0


# ---- player calls --------------------------------------------------------------------------------------------------

## Your own ready flag. Players only; the result is the next player_changed, or `rejected`.
func set_ready(ready: bool) -> String:
	if not _supported_ok():
		return "room_unsupported"
	if _l.is_host:
		return _host_ready(_l.local_peer_id, ready, true)
	_send_to_host({"t": "ready", "ready": ready})
	return ""


func toggle_ready() -> String:
	return set_ready(not bool(me().get("ready", false)))


## Your own data (colour, avatar index, team, game keys). Atomic; "" unsets a key. A joiner asks the host, which answers
## with player_changed or `rejected`; the host's own call (or set_data_for) returns the error code at once.
func set_data(values: Dictionary) -> String:
	return set_data_for(_l.local_peer_id, values)


## Any player's data; only the host may set another's (hostOnly keys included).
func set_data_for(peer_id: int, values: Dictionary) -> String:
	if not _supported_ok():
		return "room_unsupported"
	if peer_id != _l.local_peer_id and not _l.is_host:
		return _fail("not_allowed", "only the host can set another player's data")
	if _l.is_host:
		var r := _host_set(peer_id, values, true)
		if not r.is_empty():
			return _fail(r["code"], "data refused: %s%s" % [r["code"], " (%s)" % r["key"] if r.get("key", "") != "" else ""])
		return ""
	_send_to_host({"t": "set", "data": values})
	return ""


## Become a spectator or a player (your own role).
func set_role(role: String) -> String:
	if not _supported_ok():
		return "room_unsupported"
	if _l.is_host:
		var r := _host_role(_l.local_peer_id, role)
		return _fail(r, "cannot become a %s: %s" % [role, r]) if r != "" else ""
	_send_to_host({"t": "role", "role": role})
	return ""


## Ask the host to "start", go back to the "lobby" or "rematch". It raises the host's `requested` and changes nothing by itself.
func request(what: String) -> String:
	if not _supported_ok():
		return "room_unsupported"
	if _l.is_host:
		requested.emit(_l.local_peer_id, what)
		return ""
	_send_to_host({"t": "req", "what": what})
	return ""


# ---- host calls ----------------------------------------------------------------------------------------------------

## Host: move a player or spectator to the other role (the capacity rules apply; a failure returns its code).
func move_to(peer_id: int, role: String) -> String:
	if not _require_host("move players"):
		return "not_allowed"
	var r := _host_role(peer_id, role)
	return _fail(r, "cannot move player %d to %s: %s" % [peer_id, role, r]) if r != "" else ""


## Host: start the game, after the countdown when countdownMs is above 0. `wrong_state` or `not_enough_players` when it cannot.
func start() -> String:
	if not _require_host("start the game"):
		return "not_allowed"
	if _state != "lobby":
		return _fail("wrong_state", "the room is %s, not in the lobby" % _state)
	if _eligible() < maxi(1, int(_settings["minPlayers"])):
		return _fail("not_enough_players", "at least %d connected player(s) needed" % int(_settings["minPlayers"]))
	_begin_start(false)
	return ""


## Host: stop a running countdown (a no-op otherwise).
func cancel_countdown() -> void:
	if _require_host("cancel the countdown"):
		_cancel_start("host")


## Host: back to the lobby (ready flags reset, links and roster untouched). A no-op in the lobby.
func back_to_lobby() -> void:
	if not _require_host("go back to the lobby") or _state == "lobby":
		return
	_mutate(func(c: Dictionary) -> void:
		_state = "lobby"
		_cd = {}
		c["cancel"] = "host"
		c["hold"] = true
		for e: Dictionary in _roster.values():
			if e["role"] == "player":
				e["ready"] = false)
	_l._end_game()


## Host: back to the lobby, then start again (the countdown applies). Players keep their seats, data and names.
func rematch() -> String:
	if not _require_host("rematch"):
		return "not_allowed"
	back_to_lobby()
	return start()


## Host: changes some settings for everyone: autoStart, autoStartPlayers, minPlayers, countdownMs, lateJoin, seatDropped,
## rejoinWindowMs (the snake_case names auto_start, ... countdown_ms, ... work too). Broadcast in an `upd`.
func configure(s: Dictionary) -> void:
	if not _require_host("change the settings"):
		return
	var alias := {"auto_start": "autoStart", "auto_start_players": "autoStartPlayers", "min_players": "minPlayers", "countdown_ms": "countdownMs",
		"late_join": "lateJoin", "seat_dropped": "seatDropped", "rejoin_window_ms": "rejoinWindowMs"}
	var allowed := ["autoStart", "autoStartPlayers", "minPlayers", "countdownMs", "lateJoin", "seatDropped", "rejoinWindowMs"]
	_mutate(func(_c: Dictionary) -> void:
		var n := _settings.duplicate(true)
		for k: Variant in s:
			var key := str(alias.get(str(k), str(k)))
			if allowed.has(key) and s[k] != null:
				n[key] = s[k]
		_settings = n)


## Host: remove a player; it may rejoin. `opts`: code (default "kicked"), reason (shown to the player; default sentence of the code).
func kick(peer_id: int, opts: Dictionary = {}) -> String:
	if not _require_host("kick"):
		return "not_allowed"
	var code := str(opts.get("code", "kicked"))
	if not OneLobbyRoomRules.is_code(code):
		push_error("OneLobby: a removal code is lower-case letters, digits and underscores, starting with a letter, at most 32")
		return "bad_value"
	_l._remove_peer_with(peer_id, false, code, OneLobbyRoomRules.removal_reason(code, opts.get("reason", "")))
	return ""


## Host: remove a player and ban it for good (its player id, and its address when known); see `bans` and unban().
func ban(peer_id: int, opts: Dictionary = {}) -> String:
	if not _require_host("ban"):
		return "not_allowed"
	var code := str(opts.get("code", "banned"))
	if not OneLobbyRoomRules.is_code(code):
		push_error("OneLobby: a removal code is lower-case letters, digits and underscores, starting with a letter, at most 32")
		return "bad_value"
	var reason := OneLobbyRoomRules.removal_reason(code, opts.get("reason", ""))
	var e: Dictionary = _roster.get(peer_id, {})
	var pid := str(_pids.get(peer_id, ""))
	var ip := _l._link_address(peer_id)
	if pid != "" or (ip != "" and not OneLobbyRoomRules.is_loopback_ip(ip)):
		bans.add({"id": pid, "ip": ip, "name": e.get("name", ""), "reason": reason, "code": code})
	# the hub gets ban:false: the persistent list (and `bans` for the hub's id check) is what bans here, so unban can lift it
	_l._remove_peer_with(peer_id, false, code, reason)
	return ""


## Host: lift a ban by player id or address; returns how many entries went.
func unban(id_or_ip: String) -> int:
	return bans.remove(id_or_ip)


func _require_host(what: String) -> bool:
	if not _l.is_host:
		push_error("OneLobby: only the host can " + what)
		return false
	return true


func _supported_ok() -> bool:
	if supported == false:
		_fail("room_unsupported", "the host's version has no room layer (update the host)")
		return false
	return true


func _fail(code: String, message: String) -> String:
	_l._c.raise_error(code, message)
	return code


# ---- called by the lobby -------------------------------------------------------------------------------------------

## A room frame arrived from `from` (the lobby has checked the sender: a joiner's host, a host's peer that said hi).
func _handle_frame(from: int, body: PackedByteArray) -> void:
	var m := OneLobbyRoomWire.parse_body(body)
	if m.is_empty() or _closed:
		return
	if _l.is_host:
		_host_handle(from, m)
	elif from == _l.host_peer_id:
		_joiner_handle(m)


## Joiner: the link to the host is open and `hi` went out: introduce ourselves.
func _on_host_link() -> void:
	if _l.is_host or _closed:
		return
	var j: Dictionary = _cfg["join"]
	var m := {"t": "join", "v": 1}
	if OneLobbyRoomRules.is_player_id(_cfg["pid"]):
		m["pid"] = _cfg["pid"]
	m["role"] = j["role"]
	if str(j["password"]) != "":
		m["password"] = j["password"]
	if not (j["data"] as Dictionary).is_empty():
		m["data"] = j["data"]
	_send_to_host(m)
	if supported == null and _support_deadline == 0:
		_support_deadline = _now() + JOIN_WAIT_MS


## Host: a joiner finished its handshake (`hi`). It has JOIN_WAIT_MS to send `join`.
func _on_peer_hi(peer_id: int) -> void:
	if not _l.is_host or _closed:
		return
	var e: Dictionary = _roster.get(peer_id, {})
	if not e.is_empty() and e["status"] == "connected":
		return
	_legacy_wait[peer_id] = _now() + JOIN_WAIT_MS


## A peer left the roster. `final`: it was removed for good (a kick, a drop), so there is no rejoin window.
func _on_peer_left(peer_id: int, reason: String, final: bool) -> void:
	if not _l.is_host or _closed:
		return
	_legacy_wait.erase(peer_id)
	_requests.erase(peer_id)
	var e: Dictionary = _roster.get(peer_id, {})
	if e.is_empty() or peer_id == _l.local_peer_id:
		return
	if not final and reason == "timeout" and int(_settings["rejoinWindowMs"]) > 0 and not e.get("legacy", false):
		_mutate(func(_c: Dictionary) -> void: e["status"] = "reconnecting")
		_reconnect_until[peer_id] = _now() + int(_settings["rejoinWindowMs"])
		if _settings["seatDropped"] == "immediate":
			_fire_seat_dropped(e, "disconnected", false)
		return
	var why := "timeout"
	if reason == "kicked" or reason == "disconnected" or reason == "left":
		why = reason
	elif final:
		why = "disconnected"
	_remove_entry(peer_id, why)


## Host: the hub renamed a peer.
func _on_renamed(peer_id: int, new_name: String) -> void:
	if not _l.is_host or _closed:
		return
	var e: Dictionary = _roster.get(peer_id, {})
	if e.is_empty():
		return
	var next := _name_for(new_name, peer_id, peer_id)
	if next != e["name"]:
		_mutate(func(_c: Dictionary) -> void: e["name"] = next)


## Host: the lobby phase changed under the room (a game that calls lobby.start() directly, or a hub echo).
func _on_phase(phase: String) -> void:
	if not _l.is_host or _closed:
		return
	if phase == "in_game" and _state != "started":
		_mutate(func(c: Dictionary) -> void:
			_state = "started"
			_cd = {}
			c["cancel"] = "host")
	elif phase == "lobby" and _state != "lobby":
		_mutate(func(c: Dictionary) -> void:
			_state = "lobby"
			_cd = {}
			c["cancel"] = "host"
			c["hold"] = true
			for e: Dictionary in _roster.values():
				if e["role"] == "player":
					e["ready"] = false)


## Host: a joiner's link address became known; a banned address is removed.
func _on_link_address(peer_id: int, ip: String) -> void:
	if not _l.is_host or _closed or peer_id == _l.local_peer_id:
		return
	var hit := bans.match_entry({"id": str(_pids.get(peer_id, "")), "ip": ip})
	if hit.is_empty():
		return
	var code: String = hit["code"] if OneLobbyRoomRules.is_code(hit.get("code")) else "banned"
	_l._remove_peer_with(peer_id, false, code, OneLobbyRoomRules.removal_reason(code, hit.get("reason", "")))


## This peer is the host now (migration): the replica becomes the truth.
func _on_became_host() -> void:
	if _closed:
		return
	_support_deadline = 0
	var had: bool = supported == true
	supported = true
	_pids.clear()
	_legacy_wait.clear()
	_reconnect_until.clear()
	_dropped_seats.clear()
	_drop_fired.clear()
	if had:
		var until := _now() + int(_settings["rejoinWindowMs"])
		for id: int in _roster.keys():
			if id == _l.local_peer_id:
				continue
			if not _l._peer_ids().has(id):
				_roster.erase(id)
			else:
				(_roster[id] as Dictionary)["status"] = "reconnecting"
				_reconnect_until[id] = until
		var mine: Dictionary = _roster.get(_l.local_peer_id, {})
		if not mine.is_empty():
			_pids[mine["id"]] = _cfg["pid"]
			if OneLobbyRoomRules.is_player_id(_cfg["pid"]) and int(mine["seat"]) >= 0:
				_seat_memory[_cfg["pid"]] = int(mine["seat"])
		else:
			_add_host_entry()
		if _state == "countdown":
			_state = "lobby"
			_cd = {}
		_rev += 1
	else:
		_roster.clear()
		_rev = 1
		_state = "started" if _l.phase == "in_game" else "lobby"
		_add_host_entry()
	_l._send_bans(bans.hub_ids())
	became_supported.emit()
	changed.emit()


## This peer lost a host claim: it is a joiner again.
func _on_became_joiner() -> void:
	pass


## The signaling `error{kicked}` (or a room `deny`) reached this peer.
func _on_removed(info: Dictionary) -> void:
	if _removed_fired:
		return
	_removed_fired = true
	_l._set_removal(info)
	removed.emit(info)


func _close() -> void:
	_closed = true
	_support_deadline = 0
	if bans.changed.is_connected(_on_bans_changed):
		bans.changed.disconnect(_on_bans_changed)


## Every pump: the joiner's wait for the host's answer, the host's timers.
func _tick(now: int) -> void:
	if _closed:
		return
	if _l.is_host:
		_host_tick(now)
	elif supported == null and _support_deadline > 0 and now >= _support_deadline:
		_support_deadline = 0
		supported = false
		became_unsupported.emit()


# ---- host: roster --------------------------------------------------------------------------------------------------

func _init_host() -> void:
	supported = true
	_rev = 1
	_add_host_entry()


static func _entry(id: int, entry_name: String, role: String, seat: int, ready: bool, status: String, data: Dictionary) -> Dictionary:
	return {"id": id, "name": entry_name, "role": role, "seat": seat, "ready": ready, "status": status, "data": data}


func _add_host_entry() -> void:
	var id := _l.local_peer_id
	var pid: String = _cfg["pid"]
	_pids[id] = pid
	var seat: int = OneLobbyRoomRules.choose_seat(int(_settings["maxPlayers"]), {}, _seat_memory, pid if OneLobbyRoomRules.is_player_id(pid) else "")["seat"]
	if OneLobbyRoomRules.is_player_id(pid):
		_seat_memory[pid] = seat
	var data := {}
	var jd: Dictionary = (_cfg["join"] as Dictionary)["data"]
	for k: Variant in jd:
		var r := OneLobbyRoomRules.apply_data(_settings["data"], data, {k: jd[k]}, true)
		if r["ok"]:
			data = r["data"]
	_roster[id] = _entry(id, _name_for(_l._peer_name(id), id, id), "player", seat, false, "connected", OneLobbyRoomRules.data_defaults(_settings["data"], data))


func _name_for(input: String, peer_id: int, self_id: int) -> String:
	var others: Array = []
	for e: Dictionary in _roster.values():
		if e["id"] != self_id:
			others.append(e["name"])
	return OneLobbyRoomRules.effective_name(input, peer_id, others, int(_settings["maxNameLength"]), filter)


func _eligible() -> int:
	var n := 0
	for e: Dictionary in _roster.values():
		if OneLobbyRoomRules.is_eligible(e):
			n += 1
	return n


func _send_to_host(m: Dictionary) -> void:
	_l._send_to_host(OneLobbyWire.RELIABLE, OneLobbyRoomWire.encode_frame(m))


func _send_room(peer_id: int, m: Dictionary) -> void:
	_l._send_bytes(peer_id, OneLobbyRoomWire.encode_frame(m))


## Peers that can read room frames and have a link now (the host's own entry excluded).
func _audience(except: int = -1) -> Array:
	var open: Array = _l._hello_ids()
	var out: Array = []
	for e: Dictionary in _roster.values():
		if not e.get("legacy", false) and e["id"] != _l.local_peer_id and e["id"] != except and open.has(e["id"]):
			out.append(e["id"])
	return out


func _snapshot() -> Dictionary:
	var entries_json := {}
	var objs := {}
	for id: int in _roster:
		entries_json[id] = OneLobbyRoomWire.json_text(_roster[id], true)
		objs[id] = (_roster[id] as Dictionary).duplicate(true)
	return {"entries": entries_json, "objs": objs, "state": _state, "cd_seq": int(_cd.get("seq", 0)),
		"settings": OneLobbyRoomWire.json_text(_settings, true), "all_ready": _compute_all_ready()}


## Host: run `fn(ctx)` (which edits the roster, state, countdown or settings), then replicate one `upd` to everyone and raise
## the local events. `except` is a peer that gets a `snap` instead (a fresh joiner). ctx: {gone: [{id, why}], cancel, hold}.
func _mutate(fn: Callable, except: int = -1) -> void:
	var before := _snapshot()
	var ctx := {"gone": [], "cancel": "", "hold": false}
	fn.call(ctx)
	var changed_entries: Array = []
	for e: Dictionary in _roster.values():
		if before["entries"].get(e["id"], "") != OneLobbyRoomWire.json_text(e, true):
			changed_entries.append(e)
	var gone: Array = ctx["gone"]
	if ctx["hold"]:
		_auto_hold = true
	elif not changed_entries.is_empty() or not gone.is_empty():
		_auto_hold = false
	var settings_changed_now: bool = OneLobbyRoomWire.json_text(_settings, true) != before["settings"]
	var state_changed_now: bool = _state != before["state"]
	var cd_changed: bool = int(_cd.get("seq", 0)) != int(before["cd_seq"])
	if not changed_entries.is_empty() or not gone.is_empty() or settings_changed_now or state_changed_now or cd_changed:
		_rev += 1
		var upd := {"t": "upd", "rev": _rev}
		if not changed_entries.is_empty():
			upd["players"] = changed_entries.duplicate(true)
		if not gone.is_empty():
			upd["gone"] = gone
		if state_changed_now:
			upd["state"] = _state
		if cd_changed or state_changed_now:
			upd["countdown"] = _cd_info()
		if settings_changed_now:
			upd["settings"] = _settings.duplicate(true)
		if ctx["cancel"] != "" and (state_changed_now or cd_changed) and _cd.is_empty():
			upd["cancel"] = ctx["cancel"]
		var frame := OneLobbyRoomWire.encode_frame(upd)
		for p: int in _audience(except):
			_l._send_bytes(p, frame)
		_emit_changes(before, gone, ctx["cancel"])
	_evaluate()


## The countdown as sent on the wire ({seq, total, left}), or null.
func _cd_info() -> Variant:
	if _cd.is_empty():
		return null
	return {"seq": _cd["seq"], "total": _cd["total"], "left": maxi(0, int(_cd["deadline"]) - _now())}


func _snap_msg() -> Dictionary:
	var list: Array = []
	for e: Dictionary in _roster.values():
		list.append(e.duplicate(true))
	return {"t": "snap", "v": 1, "rev": _rev, "state": _state, "countdown": _cd_info(), "settings": _settings.duplicate(true), "players": list}


# ---- host: requests ------------------------------------------------------------------------------------------------

func _allow_request(from: int) -> bool:
	var now := _now()
	var w: Array = _requests.get(from, [now, 0])
	if now - int(w[0]) >= 1000 or not _requests.has(from):
		w = [now, 0]
	w[1] = int(w[1]) + 1
	_requests[from] = w
	return int(w[1]) <= REQUESTS_PER_SECOND


func _host_handle(from: int, m: Dictionary) -> void:
	if from == _l.local_peer_id:
		return
	var t: String = m["t"]
	match t:
		"join", "set", "ready", "role", "req":
			if not _allow_request(from):
				if t != "join":
					_send_room(from, {"t": "nack", "re": t, "code": "rate_limited"})
				return
		"resync":
			var e: Dictionary = _roster.get(from, {})
			if not e.is_empty() and not e.get("legacy", false):
				_send_room(from, _snap_msg())
			return
		_:
			return
	if t == "join":
		_host_join(from, m)
		return
	var entry: Dictionary = _roster.get(from, {})
	if entry.is_empty() or entry.get("legacy", false):
		return
	if t == "set":
		var r := _host_set(from, m["data"] if m.get("data") is Dictionary else {}, false)
		if not r.is_empty():
			var nack := {"t": "nack", "re": "set", "code": r["code"]}
			if r.get("key", "") != "":
				nack["key"] = r["key"]
			_send_room(from, nack)
	elif t == "ready":
		_host_ready(from, m.get("ready") == true, false)
	elif t == "role":
		var role: Variant = m.get("role")
		var code := _host_role(from, role) if role == "player" or role == "spectator" else "bad_value"
		if code != "":
			_send_room(from, {"t": "nack", "re": "role", "code": code})
	elif t == "req":
		var what: Variant = m.get("what")
		if what == "start" or what == "lobby" or what == "rematch":
			requested.emit(from, what)
		else:
			_send_room(from, {"t": "nack", "re": "req", "code": "bad_value"})


## Returns {} when the data was applied, else {code, key?}.
func _host_set(id: int, values: Dictionary, by_host: bool) -> Dictionary:
	var e: Dictionary = _roster.get(id, {})
	if e.is_empty():
		return {"code": "not_allowed"}
	var r := OneLobbyRoomRules.apply_data(_settings["data"], e["data"], values, by_host)
	if not r["ok"]:
		return {"code": r["code"], "key": r.get("key", "")}
	_mutate(func(_c: Dictionary) -> void: e["data"] = r["data"])
	return {}


func _host_ready(id: int, ready: bool, local: bool) -> String:
	var e: Dictionary = _roster.get(id, {})
	var code := ""
	if e.is_empty() or e["role"] != "player" or e.get("legacy", false) or e["status"] != "connected":
		code = "not_allowed"
	if code != "":
		if local:
			return _fail(code, "cannot change ready: " + code)
		_send_room(id, {"t": "nack", "re": "ready", "code": code})
		return code
	if e["ready"] == ready:
		return ""
	_mutate(func(_c: Dictionary) -> void: e["ready"] = ready)
	return ""


## Returns an error code, or "" when the move happened.
func _host_role(id: int, role: String) -> String:
	var e: Dictionary = _roster.get(id, {})
	if e.is_empty() or e.get("legacy", false):
		return "not_allowed"
	if e["role"] == role:
		return ""
	var n_spec := 0
	var n_play := 0
	for x: Dictionary in _roster.values():
		if x["role"] == "spectator":
			n_spec += 1
		elif x["role"] == "player":
			n_play += 1
	if role == "spectator":
		if n_spec >= int(_settings["spectators"]):
			return "spectators_full"
	else:
		if n_play >= int(_settings["maxPlayers"]):
			return "lobby_full"
		if _state == "started" and _settings["lateJoin"] != "allow":
			return "in_game" if _settings["lateJoin"] == "refuse" else "not_allowed"
	_mutate(func(_c: Dictionary) -> void:
		e["role"] = role
		e["ready"] = false
		if role == "spectator":
			e["seat"] = -1
		else:
			_give_seat(e, str(_pids.get(id, ""))))
	return ""


## Gives a player entry its seat (4.3); raises seat_restored when it was a dropped one.
func _give_seat(e: Dictionary, pid: String) -> void:
	var held := {}
	for x: Dictionary in _roster.values():
		if x["id"] != e["id"] and x["role"] == "player" and int(x["seat"]) >= 0:
			held[int(x["seat"])] = true
	var key := pid if OneLobbyRoomRules.is_player_id(pid) else ""
	var r := OneLobbyRoomRules.choose_seat(int(_settings["maxPlayers"]), held, _seat_memory, key)
	e["seat"] = r["seat"]
	if r["take_over"] != "":
		_seat_memory.erase(r["take_over"])
	if int(r["seat"]) >= 0 and key != "":
		_seat_memory[key] = r["seat"]
	if int(r["seat"]) >= 0 and _dropped_seats.erase(int(r["seat"])):
		seat_restored.emit({"seat": r["seat"], "peer_id": e["id"], "name": e["name"], "returning": r["returning"]})


# ---- host: admission -----------------------------------------------------------------------------------------------

func _host_join(from: int, m: Dictionary) -> void:
	_legacy_wait.erase(from)
	var pid: String = m["pid"] if OneLobbyRoomRules.is_player_id(m.get("pid")) else ""
	var existing: Dictionary = _roster.get(from, {})
	if not existing.is_empty() and not existing.get("legacy", false) and (str(_pids.get(from, "")) == "" or str(_pids.get(from, "")) == pid):
		# rebind: the same peer again (a new link after a drop, or a new host after migration)
		if pid != "":
			_pids[from] = pid
		var was: String = existing["status"]
		var rebind := func(_c: Dictionary) -> void: existing["status"] = "connected"
		_mutate(rebind, from)
		_reconnect_until.erase(from)
		if was == "reconnecting" and _drop_fired.erase(from) and _dropped_seats.erase(int(existing["seat"])):
			seat_restored.emit({"seat": existing["seat"], "peer_id": from, "name": existing["name"], "returning": true})
		_send_room(from, _snap_msg())
		return
	_admit_peer(from, {
		"pid": pid, "role": "spectator" if m.get("role") == "spectator" else "player",
		"password": str(m["password"]) if m.get("password") is String else "",
		"data": m["data"] if m.get("data") is Dictionary else {}}, false)


func _admit_peer(from: int, j: Dictionary, legacy: bool) -> void:
	var ip := _l._link_address(from)
	# a reconnecting entry of the same player id under another peer id: this peer takes its place
	var dup: Dictionary = {}
	if j["pid"] != "":
		for e: Dictionary in _roster.values():
			if e["id"] != from and str(_pids.get(e["id"], "")) == j["pid"] and e["status"] == "reconnecting":
				dup = e
				break
	var n_play := 0
	var n_spec := 0
	for e: Dictionary in _roster.values():
		if e["id"] == from or (not dup.is_empty() and e["id"] == dup["id"]):
			continue
		if e["role"] == "player":
			n_play += 1
		elif e["role"] == "spectator":
			n_spec += 1
	var has_pw: bool = str(_cfg["password"]) != ""
	var a := OneLobbyRoomRules.admit({
		"banned": not bans.match_entry({"id": j["pid"], "ip": ip}).is_empty(),
		"hasPassword": has_pw,
		"passwordOk": not has_pw or OneLobbyRoomRules.safe_equal(j["password"], _cfg["password"]),
		"state": _state, "lateJoin": _settings["lateJoin"], "role": j["role"],
		"players": n_play, "maxPlayers": _settings["maxPlayers"], "spectators": n_spec, "spectatorCap": _settings["spectators"]})
	if not a["ok"]:
		var reason := OneLobbyRoomRules.removal_reason(a["code"])
		if not legacy:
			_send_room(from, {"t": "deny", "code": a["code"], "reason": reason})
		_l._remove_peer_with(from, false, a["code"], reason)
		return
	var apply := func(c: Dictionary) -> void:
		if not dup.is_empty():
			_roster.erase(dup["id"])
			_reconnect_until.erase(dup["id"])
			_drop_fired.erase(dup["id"])
			_pids.erase(dup["id"])
			c["gone"].append({"id": dup["id"], "why": "left"})
		var e := _entry(from, _name_for(_l._peer_name(from), from, from), a["role"], -1, false, "connected", {})
		if legacy:
			e["legacy"] = true
		var data := {}
		var jd: Dictionary = j["data"]
		for k: Variant in jd:
			var r := OneLobbyRoomRules.apply_data(_settings["data"], data, {k: jd[k]}, false)
			if r["ok"]:
				data = r["data"]
		e["data"] = OneLobbyRoomRules.data_defaults(_settings["data"], data)
		_roster[from] = e
		if j["pid"] != "":
			_pids[from] = j["pid"]
		if a["role"] == "player":
			_give_seat(e, j["pid"])
	_mutate(apply, from)
	if not legacy:
		_send_room(from, _snap_msg())


func _remove_entry(id: int, why: String) -> void:
	var e: Dictionary = _roster.get(id, {})
	if e.is_empty():
		return
	_reconnect_until.erase(id)
	_mutate(func(c: Dictionary) -> void:
		_roster.erase(id)
		c["gone"].append({"id": id, "why": why}))
	if not _drop_fired.erase(id):
		_fire_seat_dropped(e, why, why == "timeout")
	_pids.erase(id)


func _fire_seat_dropped(e: Dictionary, reason: String, after_window: bool) -> void:
	if e["role"] != "player" or int(e["seat"]) < 0 or e.get("legacy", false):
		return
	_dropped_seats[int(e["seat"])] = true
	_drop_fired[e["id"]] = true
	seat_dropped.emit({"seat": e["seat"], "peer_id": e["id"], "name": e["name"], "data": (e["data"] as Dictionary).duplicate(), "reason": reason, "after_window": after_window})


# ---- host: start, countdown, timers --------------------------------------------------------------------------------

func _begin_start(auto: bool) -> void:
	if int(_settings["countdownMs"]) <= 0:
		_start_now()
		return
	_cd_seq += 1
	_cd_auto = auto
	_next_cd = _now() + COUNTDOWN_TICK_MS
	_mutate(func(_c: Dictionary) -> void:
		_state = "countdown"
		_cd = {"seq": _cd_seq, "total": int(_settings["countdownMs"]), "deadline": _now() + int(_settings["countdownMs"])})


func _start_now() -> void:
	_mutate(func(_c: Dictionary) -> void:
		_state = "started"
		_cd = {})
	_l._begin_game()


func _cancel_start(reason: String) -> void:
	if _state != "countdown":
		return
	_mutate(func(c: Dictionary) -> void:
		_state = "lobby"
		_cd = {}
		c["cancel"] = reason)


func _rule() -> Dictionary:
	return {"mode": _settings["autoStart"], "autoStartPlayers": _settings["autoStartPlayers"], "minPlayers": _settings["minPlayers"]}


## After every change: auto start, and countdown conditions.
func _evaluate() -> void:
	if not _l.is_host or _closed:
		return
	var all: Array = _roster.values()
	if _state == "lobby":
		if not _auto_hold and OneLobbyRoomRules.auto_start_holds(_rule(), all):
			_begin_start(true)
	elif _state == "countdown":
		if _eligible() < maxi(1, int(_settings["minPlayers"])):
			_cancel_start("too_few")
		elif _cd_auto and not OneLobbyRoomRules.auto_start_holds(_rule(), all):
			_cancel_start("condition")


func _host_tick(now: int) -> void:
	for id: int in _reconnect_until.keys():
		if now >= int(_reconnect_until[id]):
			_reconnect_until.erase(id)
			var e: Dictionary = _roster.get(id, {})
			if not e.is_empty() and e["status"] == "reconnecting":
				_remove_entry(id, "timeout")
	for id: int in _legacy_wait.keys():
		if now < int(_legacy_wait[id]):
			continue
		_legacy_wait.erase(id)
		var e: Dictionary = _roster.get(id, {})
		if not e.is_empty():
			# a legacy peer that dropped and resumed
			if e.get("legacy", false) and e["status"] != "connected":
				_mutate(func(_c: Dictionary) -> void: e["status"] = "connected")
		elif _l._peer_ids().has(id):
			_admit_peer(id, {"pid": "", "role": "player", "password": "", "data": {}}, true)
	if _state == "countdown" and not _cd.is_empty():
		var left: int = int(_cd["deadline"]) - now
		if left <= 0:
			_start_now()
		elif now >= _next_cd:
			_next_cd += COUNTDOWN_TICK_MS
			var frame := OneLobbyRoomWire.encode_frame({"t": "cd", "seq": _cd["seq"], "left": left})
			for p: int in _audience():
				_l._send_bytes(p, frame)
			countdown_changed.emit(_view())


# ---- joiner: replica -----------------------------------------------------------------------------------------------

func _joiner_handle(m: Dictionary) -> void:
	match str(m["t"]):
		"snap":
			_apply_snap(m)
		"upd":
			_apply_upd(m)
		"cd":
			if supported != true or not _is_num(m.get("seq")) or not _is_num(m.get("left")):
				return
			var rtt := _l.ping_ms(_l.host_peer_id)
			var deadline := _now() + OneLobbyRoomRules.countdown_remaining(int(m["left"]), rtt if rtt > 0 else null)
			if not _cd.is_empty() and int(_cd["seq"]) == int(m["seq"]):
				_cd["deadline"] = deadline
			else:
				_cd = {"seq": int(m["seq"]), "total": int(m["left"]), "deadline": deadline}
			countdown_changed.emit(_view())
		"deny":
			var code: String = m["code"] if OneLobbyRoomRules.is_code(m.get("code")) else "kicked"
			var reason := OneLobbyRoomRules.removal_reason(code, m["reason"] if m.get("reason") is String else "")
			_on_removed({"code": code, "reason": reason, "ban": false})
			_l._c.raise_error(code, reason)
		"nack":
			if m.get("code") is String:
				rejected.emit(m["code"], str(m.get("re", "")), str(m.get("key", "")))


static func _is_num(v: Variant) -> bool:
	return typeof(v) == TYPE_INT or typeof(v) == TYPE_FLOAT


## An entry from the wire made safe: proper types, nothing but the known fields. {} when it has no peer id.
static func _clean_entry(raw: Variant) -> Dictionary:
	if not raw is Dictionary or not _is_num((raw as Dictionary).get("id")):
		return {}
	var r: Dictionary = raw
	var data := {}
	if r.get("data") is Dictionary:
		for k: Variant in r["data"]:
			if r["data"][k] is String:
				data[str(k)] = r["data"][k]
	var role: String = r["role"] if r.get("role") == "spectator" else "player"
	var e := _entry(int(r["id"]), str(r["name"]) if r.get("name") is String else "", role, int(r["seat"]) if _is_num(r.get("seat")) else -1,
		r.get("ready") == true, "reconnecting" if r.get("status") == "reconnecting" else "connected", data)
	if r.get("legacy") == true:
		e["legacy"] = true
	return e


static func _clean_cd(raw: Variant) -> Dictionary:
	if not raw is Dictionary or not _is_num((raw as Dictionary).get("seq")) or not _is_num((raw as Dictionary).get("left")):
		return {}
	return {"seq": int(raw["seq"]), "total": int(raw["total"]) if _is_num(raw.get("total")) else int(raw["left"]), "left": int(raw["left"])}


func _apply_snap(m: Dictionary) -> void:
	if not m.get("players") is Array or not _is_num(m.get("rev")) or not m.get("settings") is Dictionary:
		return
	var before := _snapshot()
	var first: bool = supported != true
	_support_deadline = 0
	supported = true
	_roster = {}
	for raw: Variant in m["players"]:
		var e := _clean_entry(raw)
		if not e.is_empty():
			_roster[e["id"]] = e
	_state = str(m["state"]) if m.get("state") in ["lobby", "countdown", "started"] else "lobby"
	_settings = (m["settings"] as Dictionary).duplicate(true)
	_set_cd(_clean_cd(m.get("countdown")))
	_rev = int(m["rev"])
	if first:
		became_supported.emit()
	_emit_changes(before, [], "", first)


func _apply_upd(m: Dictionary) -> void:
	if supported != true or not _is_num(m.get("rev")):
		return
	var rev := int(m["rev"])
	if rev <= _rev:
		return
	if rev != _rev + 1:
		_resync()
		return
	var before := _snapshot()
	if m.get("players") is Array:
		for raw: Variant in m["players"]:
			var e := _clean_entry(raw)
			if not e.is_empty():
				_roster[e["id"]] = e
	var gone: Array = []
	if m.get("gone") is Array:
		for g: Variant in m["gone"]:
			if g is Dictionary and _is_num(g.get("id")):
				gone.append({"id": int(g["id"]), "why": str(g.get("why", "left"))})
	for g: Dictionary in gone:
		_roster.erase(g["id"])
	if m.get("state") in ["lobby", "countdown", "started"]:
		_state = m["state"]
	if m.get("settings") is Dictionary:
		_settings = (m["settings"] as Dictionary).duplicate(true)
	if m.has("countdown"):
		_set_cd(_clean_cd(m["countdown"]))
	_rev = rev
	_emit_changes(before, gone, str(m["cancel"]) if m.get("cancel") is String else "")


func _set_cd(c: Dictionary) -> void:
	if c.is_empty():
		_cd = {}
		return
	var rtt := _l.ping_ms(_l.host_peer_id)
	_cd = {"seq": c["seq"], "total": c["total"], "deadline": _now() + OneLobbyRoomRules.countdown_remaining(int(c["left"]), rtt if rtt > 0 else null)}


func _resync() -> void:
	var now := _now()
	if now - _last_resync < RESYNC_GAP_MS:
		return
	_last_resync = now
	_send_to_host({"t": "resync"})


# ---- events from a diff --------------------------------------------------------------------------------------------

static func _entry_keys(a: Dictionary, b: Dictionary) -> Array:
	if a.is_empty():
		return ["name", "role", "seat", "ready", "status"]
	var keys: Array = []
	for k in ["name", "role", "seat", "ready", "status", "legacy"]:
		if a.get(k) != b.get(k):
			keys.append(k)
	var seen := {}
	for k: Variant in (a["data"] as Dictionary).keys() + (b["data"] as Dictionary).keys():
		if seen.has(k):
			continue
		seen[k] = true
		if a["data"].get(k) != b["data"].get(k):
			keys.append("data." + str(k))
	return keys


func _emit_changes(before: Dictionary, gone: Array, cancel: String, quiet: bool = false) -> void:
	var after := _snapshot()
	var whys := {}
	for g: Dictionary in gone:
		whys[g["id"]] = g["why"]
	var any := false
	for id: int in after["objs"]:
		var e: Dictionary = after["objs"][id]
		if not before["objs"].has(id):
			any = true
			player_joined.emit(e.duplicate(true))
		elif before["entries"][id] != after["entries"][id]:
			any = true
			player_changed.emit(e.duplicate(true), _entry_keys(before["objs"][id], e))
	for id: int in before["objs"]:
		if after["objs"].has(id):
			continue
		any = true
		var old: Dictionary = (before["objs"][id] as Dictionary).duplicate(true)
		old["status"] = "left"
		player_left.emit(old, str(whys.get(id, "left")))
	if after["settings"] != before["settings"]:
		any = true
		settings_changed.emit(settings())
	if after["state"] != before["state"]:
		any = true
		state_changed.emit(after["state"], before["state"])
		if after["state"] == "started":
			started.emit()
		if after["state"] == "lobby":
			returned_to_lobby.emit()
	if after["cd_seq"] != before["cd_seq"]:
		any = true
		if not _cd.is_empty():
			countdown_changed.emit(_view())
		elif before["cd_seq"] != 0 and after["state"] != "started":
			countdown_cancelled.emit(cancel if cancel != "" else "host")
	if after["all_ready"] != before["all_ready"]:
		any = true
		all_ready_changed.emit(after["all_ready"])
	if any or quiet:
		changed.emit()
