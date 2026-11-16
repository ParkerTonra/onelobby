extends SceneTree
## The room layer (lobby.room) between real GDScript peers, all on 127.0.0.1 (Direct hosts by IP, no Nostr, no internet),
## modelled on the JS and C# room tests: roster and replication, names, per-player data, ready, countdown, start, back to lobby
## and rematch, spectators and capacity, passwords, kick, ban, unban and the removal a player sees, seats, the reconnecting
## state and seat-dropped hook, legacy peers, an older host, rate limits, lost updates, a lockstep rematch. The host-side rules
## that need a peer to disappear are driven with stand-in peers (no link) on one real host.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/room.gd
## Prints "room: N passed, M failed"; exits 1 on any failure.

var _pass := 0
var _fail := 0
var _everyone: Array = []
var _next_port := 48100


## One player: its client, lobby and a log of the room's signals ([name, ...args]).
class P:
	var client: OneLobbyClient
	var lobby: OneLobbyLobby
	var log: Array = []
	var ended: Array = []

	func attach() -> void:
		var r := lobby.room
		r.player_joined.connect(func(e: Dictionary) -> void: log.append(["joined", e["id"]]))
		r.player_left.connect(func(e: Dictionary, why: String) -> void: log.append(["left", e["id"], why]))
		r.player_changed.connect(func(e: Dictionary, keys: Array) -> void: log.append(["changed", e["id"], keys]))
		r.state_changed.connect(func(s: String, _p: String) -> void: log.append(["state", s]))
		r.started.connect(func() -> void: log.append(["started"]))
		r.all_ready_changed.connect(func(b: bool) -> void: log.append(["all_ready", b]))
		r.countdown_changed.connect(func(c: Dictionary) -> void: log.append(["countdown", c["seq"], c["remaining"]]))
		r.countdown_cancelled.connect(func(why: String) -> void: log.append(["cancelled", why]))
		r.returned_to_lobby.connect(func() -> void: log.append(["lobby"]))
		r.seat_dropped.connect(func(i: Dictionary) -> void: log.append(["dropped", i]))
		r.seat_restored.connect(func(i: Dictionary) -> void: log.append(["restored", i]))
		r.requested.connect(func(id: int, what: String) -> void: log.append(["requested", id, what]))
		r.removed.connect(func(i: Dictionary) -> void: log.append(["removed", i]))
		r.rejected.connect(func(code: String, re: String, key: String) -> void: log.append(["rejected", code, re, key]))
		r.became_supported.connect(func() -> void: log.append(["supported"]))
		r.became_unsupported.connect(func() -> void: log.append(["unsupported"]))
		r.bans_changed.connect(func() -> void: log.append(["bans"]))
		r.settings_changed.connect(func(s: Dictionary) -> void: log.append(["settings", s]))
		lobby.session_ended.connect(func(reason: String) -> void: ended.append(reason))

	func count(kind: String) -> int:
		var n := 0
		for l: Array in log:
			if l[0] == kind:
				n += 1
		return n

	func last(kind: String) -> Array:
		for i in range(log.size() - 1, -1, -1):
			if log[i][0] == kind:
				return log[i]
		return []

	func id() -> int:
		return lobby.local_peer_id


func _init() -> void:
	process_frame.connect(func() -> void:
		if Time.get_ticks_msec() > 280000:
			print("room FAIL: timed out")
			quit(1))
	_run.call_deferred()


func _check(ok: bool, what: String) -> void:
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL: ", what)


func _until(cond: Callable, ms: int = 15000) -> bool:
	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < ms:
		await process_frame
		if cond.call():
			return true
	return cond.call()


func _frames(n: int) -> void:
	for _i in n:
		await process_frame


func _client(display: String, store: OneLobbyStore = null, mode: String = "raw") -> OneLobbyClient:
	var c := OneLobbyClient.new()
	c.game_id = "room-test"
	c.net_version = "1"
	c.display_name = display
	c.store = store if store != null else OneLobbyStore.memory()
	c.sync_mode = mode
	c.tick_rate = 20
	c.hash_every_ticks = 10
	c.ready_timeout_ms = 20000
	root.add_child(c)
	return c


func _host(display: String, opts: Dictionary = {}, mode: String = "raw") -> P:
	var p := P.new()
	p.client = _client(display, null, mode)
	var o := {"name": "room", "max_players": 3, "tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1",
		"udp_port_range": [_next_port, _next_port + 15], "nostr": false}
	_next_port += 20
	o.merge(opts, true)
	p.lobby = await p.client.host_direct(o)
	if p.lobby == null:
		_check(false, "host_direct failed: %s" % JSON.stringify(p.client.last_error))
		return null
	p.attach()
	_everyone.append(p)
	return p


func _join(h: P, display: String, opts: Dictionary = {}, store: OneLobbyStore = null) -> P:
	var p := P.new()
	p.client = _client(display, store)
	var o := {"timeout_ms": 20000}
	o.merge(opts, true)
	p.lobby = await p.client.join_direct(h.lobby.ip_code, o)
	if p.lobby == null:
		return p # the caller reads p.client.last_error
	p.attach()
	_everyone.append(p)
	return p


func _in(p: P) -> bool:
	return p.lobby != null and p.lobby.room.supported == true and not p.lobby.room.me().is_empty()


func _find(entries: Array, id: int) -> Dictionary:
	for e: Dictionary in entries:
		if e["id"] == id:
			return e
	return {}


func _names(entries: Array) -> Array:
	return entries.map(func(e: Dictionary) -> String: return e["name"])


func _run() -> void:
	var only := ""
	for x in OS.get_cmdline_user_args():
		if x.begins_with("--only="):
			only = x.substr(7)
	if only == "" or only == "main":
		await _main_flow()
	if only == "" or only == "idle":
		await _idle_lobby_then_start()
	if only == "" or only == "kick":
		await _kick_ban_password()
	if only == "" or only == "stand":
		await _stand_ins()
	if only == "" or only == "old":
		await _old_host_and_old_joiner()
	if only == "" or only == "options":
		await _options_and_blueprint()
	if only == "" or only == "notice":
		await _notice_before_deny()
	print("room: %d passed, %d failed" % [_pass, _fail])
	for p: P in _everyone:
		if p.lobby != null and not p.lobby.is_closed():
			p.lobby.leave()
	await _frames(5)
	quit(1 if _fail > 0 else 0)


# ---- a lockstep lobby that sits idle longer than the 3 s silent-host window, then starts ---------------------------------
# No frames flow in the lobby phase, so the joiners' silent-host clock must start when the game does, not when they joined.

func _idle_lobby_then_start() -> void:
	var h := await _host("Sam", {"max_players": 3, "room": {"countdown_seconds": 0, "min_players": 2}}, "lockstep")
	if h == null:
		return
	var ann := await _join(h, "Ann")
	_check(ann.lobby != null and await _until(func() -> bool: return _in(ann)), "idle lobby: a joiner is in")
	if ann.lobby == null:
		return
	var hr := h.lobby.room
	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < 3600: # longer than OneLobbyLockstep.HOST_SILENCE_MS, with the lobby doing nothing
		await process_frame
	_check(hr.start() == "", "idle lobby: the host starts after the long wait")
	_check(await _until(func() -> bool: return ann.lobby.phase == "in_game" and ann.lobby.lockstep.is_started), "idle lobby: the joiner is told the game started")
	_check(await _until(func() -> bool: return ann.lobby.lockstep.last_tick > 3), "idle lobby: the joiner's lockstep frames flow (last_tick %d)" % ann.lobby.lockstep.last_tick)
	_check(ann.ended.is_empty() and not ann.lobby.is_closed(), "idle lobby: the joiner did not declare the host lost")
	hr.back_to_lobby()
	await _frames(5)


# ---- roster, data, ready, countdown, start, back to lobby, spectators, lockstep rematch ----------------------------------

func _main_flow() -> void:
	var data_decl := {"nick": {"type": "string", "maxLength": 8}, "vip": {"type": "bool", "hostOnly": true}}
	var h := await _host("Sam", {"max_players": 3, "room": {"spectators": 1, "min_players": 2, "countdown_seconds": 5, "data": data_decl}}, "lockstep")
	if h == null:
		return
	var hr := h.lobby.room
	_check(hr.supported == true and hr.state == "lobby" and hr.revision == 1 and h.lobby.removal.is_empty(), "a host is supported at once, in the lobby, revision 1")
	_check(hr.me()["seat"] == 0 and hr.me()["name"] == "Sam" and hr.me()["data"] == {"avatar": "0", "team": "0"} and hr.entries().size() == 1, "the host is seat 0 with the data defaults")
	var ann := await _join(h, "Ann", {"data": {"color": "#FF8800", "team": "1", "nick": "Annie", "bogus": "x"}})
	_check(ann.lobby != null and await _until(func() -> bool: return _in(ann)), "a joiner gets the room snapshot")
	var ar := ann.lobby.room
	_check(ar.supported == true and ar.me()["seat"] == 1 and ar.me()["name"] == "Ann" and ar.entries().size() == 2 and ar.state == "lobby", "the joiner is seat 1 and sees both players")
	_check(ar.me()["data"] == {"color": "#ff8800", "team": "1", "nick": "Annie", "avatar": "0"}, "its starting data is validated (colour lower-cased, a bad key skipped) and defaults fill in: %s" % JSON.stringify(ar.me()["data"]))
	_check(hr.player(ann.id()).get("data") == ar.me()["data"] and h.count("joined") == 1, "the host sees the same entry and a player_joined")
	var bob := await _join(h, "Ann")
	_check(await _until(func() -> bool: return _in(bob)), "a second joiner is admitted")
	_check(bob.lobby.room.me()["name"] == "Ann 2" and bob.lobby.room.me()["seat"] == 2 and _names(hr.players()) == ["Sam", "Ann", "Ann 2"], "names are made unique and seats follow join order: %s" % str(_names(hr.players())))
	_check(await _until(func() -> bool: return ar.entries().size() == 3 and ann.count("joined") >= 1), "everyone is told about a later joiner")
	# a joiner's entries are replicas: names changed by the hub's rename pass through the host's rules
	var sam := await _join(h, "Spec", {"role": "spectator"})
	_check(await _until(func() -> bool: return _in(sam)) and sam.lobby.room.me()["role"] == "spectator" and sam.lobby.room.me()["seat"] == -1, "a spectator has no seat")
	_check(hr.players().size() == 3 and hr.spectators().size() == 1 and bob.lobby.room.spectators().size() == 1 and hr.entries().size() == 4, "players and spectators are listed apart")
	var late := await _join(h, "Late", {"role": "spectator"})
	_check(late.lobby == null and late.client.last_error.get("code") == "lobby_full", "the hub's capacity is players + spectators: with every slot taken a further join fails at the hub (lobby_full)")

	# ---- per-player data
	ann.log.clear()
	_check(ar.set_data({"nick": "waytoolongname"}) == "" and await _until(func() -> bool: return ann.count("rejected") == 1), "a bad value is refused by the host")
	_check(ann.last("rejected") == ["rejected", "bad_value", "set", "nick"] and ar.me()["data"]["nick"] == "Annie", "with bad_value and the key, and nothing changed")
	ann.lobby.room.set_data({"zzz": "1"})
	ann.lobby.room.set_data({"vip": "true"})
	_check(await _until(func() -> bool: return ann.count("rejected") == 3) and ann.log.filter(func(l: Array) -> bool: return l[0] == "rejected").map(func(l: Array) -> String: return l[1]) == ["bad_value", "unknown_key", "not_allowed"], "unknown keys and hostOnly keys are refused")
	ar.set_data({"nick": "Ann", "color": "#00FF00"})
	_check(await _until(func() -> bool: return hr.player(ann.id()).get("data", {}).get("nick") == "Ann") and hr.player(ann.id())["data"]["color"] == "#00ff00", "a good set replicates to the host")
	_check(await _until(func() -> bool: return bob.lobby.room.player(ann.id()).get("data", {}).get("nick") == "Ann"), "and to the other players")
	_check(ann.last("changed")[2] == ["data.color", "data.nick"] or ann.last("changed")[2] == ["data.nick", "data.color"], "player_changed names the keys (data.<key>)")
	_check(hr.set_data_for(ann.id(), {"vip": "true", "color": ""}) == "" and await _until(func() -> bool: return ar.me()["data"].get("vip") == "true" and not ar.me()["data"].has("color")), "the host sets any key on any player, hostOnly included, and an empty value unsets")
	_check(hr.set_data_for(ann.id(), {"vip": "maybe"}) == "bad_value", "the host's own call returns the error code")
	_check(ar.set_data_for(bob.id(), {"nick": "x"}) == "not_allowed", "only the host sets another player's data")

	# ---- ready, all ready
	hr.set_ready(true)
	ar.set_ready(true)
	_check(await _until(func() -> bool: return hr.player(ann.id())["ready"] and bob.lobby.room.player(ann.id())["ready"]), "ready flags replicate")
	_check(not hr.all_ready and h.count("all_ready") == 0, "not all ready while Ann 2 is not")
	sam.lobby.room.set_ready(true)
	_check(await _until(func() -> bool: return sam.count("rejected") == 1) and sam.last("rejected")[1] == "not_allowed" and not hr.all_ready, "a spectator cannot be ready")
	bob.lobby.room.toggle_ready()
	_check(await _until(func() -> bool: return hr.all_ready and ann.lobby.room.all_ready and sam.lobby.room.all_ready), "everyone ready (spectators not counted) raises all_ready")
	_check(h.last("all_ready") == ["all_ready", true], "all_ready_changed(true) fired")

	# ---- start errors
	hr.configure({"min_players": 5})
	_check(await _until(func() -> bool: return ar.settings()["minPlayers"] == 5) and ann.count("settings") >= 1, "settings changes replicate")
	_check(hr.start() == "not_enough_players" and hr.state == "lobby", "start needs minPlayers connected players")
	hr.configure({"min_players": 2})
	await _until(func() -> bool: return ar.settings()["minPlayers"] == 2)

	# ---- countdown, cancel, start (a 5 s first countdown so the cancel never races the clock)
	ann.log.clear()
	h.log.clear()
	_check(hr.start() == "" and hr.state == "countdown", "start enters the countdown")
	_check(await _until(func() -> bool: return ar.state == "countdown" and ann.count("countdown") >= 1), "every peer sees the countdown")
	var cd := ar.countdown()
	_check(cd.get("total") == 5000 and cd.get("remaining", -1) > 0 and cd.get("remaining", 9999) <= 5000 and hr.start() == "wrong_state", "it counts down 5 s on the joiner's own clock; a second start is wrong_state")
	hr.cancel_countdown()
	_check(await _until(func() -> bool: return ar.state == "lobby" and ann.count("cancelled") == 1) and ann.last("cancelled")[1] == "host" and h.last("cancelled")[1] == "host", "cancel_countdown ends it with the reason host everywhere")
	_check(ar.countdown().is_empty() and hr.all_ready, "no countdown is left and ready flags stay")
	ann.log.clear()
	hr.configure({"countdown_ms": 3000})
	await _until(func() -> bool: return ar.settings()["countdownMs"] == 3000)
	_check(hr.start() == "", "start again")
	_check(await _until(func() -> bool: return ann.count("started") == 1 and bob.lobby.room.state == "started" and sam.lobby.room.state == "started" and hr.state == "started"), "the countdown ends in started on every peer")
	_check(h.lobby.phase == "in_game" and await _until(func() -> bool: return ann.lobby.phase == "in_game" and sam.lobby.phase == "in_game"), "the lobby phase is in_game everywhere")
	_check(h.lobby.lockstep.is_started and await _until(func() -> bool: return h.lobby.lockstep.last_tick > 5 and ann.lobby.lockstep.last_tick > 3), "and the lockstep game runs")
	_check(ann.count("countdown") >= 3, "the host's once-a-second ticks reached the joiner (%d events)" % ann.count("countdown"))

	# ---- late join: allow (the default) gives the role asked for
	var cy := await _join(h, "Cy", {"role": "spectator"})
	_check(cy.lobby == null, "late join still honours the hub's capacity")

	# ---- requests and moves
	ar.request("rematch")
	_check(await _until(func() -> bool: return h.count("requested") == 1) and h.last("requested") == ["requested", ann.id(), "rematch"], "a joiner's request raises the host's requested and changes nothing")
	_check(hr.state == "started", "(the state is untouched)")

	# ---- back to lobby: ready reset, links and roster intact; the lockstep session restarts
	await _until(func() -> bool: return h.lobby.lockstep.frames_buffered > 3)
	h.log.clear()
	ann.log.clear()
	hr.back_to_lobby()
	_check(hr.state == "lobby" and h.lobby.phase == "lobby" and not h.lobby.lockstep.is_started and h.lobby.lockstep.last_tick == 0 and h.lobby.lockstep.frames_buffered == 0, "back to lobby resets the host's lockstep session (idle, tick 0)")
	_check(await _until(func() -> bool: return ar.state == "lobby" and ann.lobby.phase == "lobby" and ann.count("lobby") == 1), "every peer is back in the lobby")
	_check(not hr.player(ann.id())["ready"] and not hr.all_ready and hr.players().size() == 3 and hr.me()["seat"] == 0 and ar.me()["seat"] == 1, "ready flags are reset, roster and seats are kept")
	_check(ann.lobby.lockstep.last_tick == -1 or ann.lobby.lockstep.last_tick == 0, "the joiner's lockstep session is reset too")
	await _frames(40)
	_check(h.lobby.phase == "lobby" and hr.state == "lobby", "the hub's late echo does not undo it")
	# ---- auto start does not fire again at once, then does on the next change
	hr.configure({"auto_start": "all_ready", "countdown_ms": 0})
	await _frames(10)
	_check(hr.state == "lobby", "auto start stays off after back to lobby until a ready flag changes")
	h.log.clear()
	hr.set_ready(true)
	ar.set_ready(true)
	bob.lobby.room.set_ready(true)
	_check(await _until(func() -> bool: return hr.state == "started" and ar.state == "started" and ann.lobby.phase == "in_game"), "all_ready auto start (no countdown) starts the game")
	# ---- rematch: back to lobby, then a countdown and a fresh lockstep match from tick 1
	hr.configure({"auto_start": "off", "countdown_ms": 300})
	await _until(func() -> bool: return ar.settings()["countdownMs"] == 300)
	_check(hr.rematch() == "", "rematch is back to lobby and start")
	_check(hr.state == "countdown" and h.lobby.phase == "lobby", "(in the countdown the lobby phase is lobby)")
	_check(await _until(func() -> bool: return hr.state == "started" and ar.state == "started"), "the rematch's countdown ends in started again")
	_check(await _until(func() -> bool: return h.lobby.lockstep.frames_buffered > 2), "frames flow again")
	_check(h.lobby.lockstep.next_frame().get("tick") == 1, "and the match restarts from tick 1")
	hr.back_to_lobby()
	await _frames(5)

	# ---- names: the filter hook, a rename re-runs the rules
	hr.filter = func(text: String, _kind: String) -> String: return text.replace("darn", "****")
	ann.lobby.rename("darn it")
	_check(await _until(func() -> bool: return hr.player(ann.id())["name"] == "**** it" and ar.me()["name"] == "**** it"), "the host's name filter applies to a rename")
	await create_timer(1.2).timeout # the hub allows one rename per second
	ann.lobby.rename("Sam")
	_check(await _until(func() -> bool: return hr.player(ann.id())["name"] == "Sam 2"), "a rename into a taken name is made unique (case-insensitive)")
	var lines: Array = []
	bob.lobby.chat.message.connect(func(l: Dictionary) -> void: lines.append(l["text"]))
	ann.lobby.chat.send("oh darn")
	_check(await _until(func() -> bool: return lines == ["oh ****"]), "the host's chat filter cleans a line before it is broadcast")
	ann.lobby.chat.send("darn")
	await _until(func() -> bool: return lines.size() == 2)
	hr.filter = func(_t: String, _k: String) -> String: return ""
	ann.lobby.chat.send("dropped")
	await _frames(40)
	_check(lines == ["oh ****", "****"], "an empty result drops the line (got %s)" % str(lines))
	hr.filter = Callable()

	# ---- a lost update: the replica asks for a snapshot and converges
	ar._rev -= 1
	hr.set_data_for(bob.id(), {"nick": "Bobby"})
	_check(await _until(func() -> bool: return ar.player(bob.id()).get("data", {}).get("nick") == "Bobby" and ar.revision == hr.revision), "a replica that misses an update resyncs from a snapshot")
	# ---- the host moves players; capacity rules
	_check(hr.move_to(bob.id(), "spectator") == "spectators_full", "moving into a full spectator list fails with its code")
	_check(sam.lobby.room.set_role("player") == "" and await _until(func() -> bool: return sam.count("rejected") >= 2) and sam.last("rejected")[1] == "lobby_full", "a spectator cannot become a player in a full room")
	_check(hr.set_data_for(99999, {"nick": "x"}) == "not_allowed", "data of someone who is not here is not_allowed")
	# ---- a burst of requests: the excess is rate limited
	ann.log.clear()
	for i in 14:
		ar.set_data({"nick": "n%d" % i})
	_check(await _until(func() -> bool: return ann.log.filter(func(l: Array) -> bool: return l[0] == "rejected" and l[1] == "rate_limited").size() >= 1), "more than 10 requests in a second are answered with rate_limited")
	for p: P in [h, ann, bob, sam]:
		if p.lobby != null and not p.lobby.is_closed():
			p.lobby.leave()
	await _frames(10)


# ---- the hub's kick notice beats the host's deny frame (forced order) -----------------------------------------------------

func _notice(code: String, extra: Dictionary) -> String:
	var data := {"code": code, "closeReason": OneLobbyRoomRules.removal_reason(code)}
	data.merge(extra, true)
	return JSON.stringify({"t": "error", "code": "kicked", "msg": "kicked", "data": data})


## A joiner the host has not answered yet gets the signaling `error{kicked}` before any `deny`: it was refused (ban false, the
## code of the notice, the client's last_error names it) and the session ends once. A joiner already in the room that gets the
## same notice with ban true still reads ban true.
func _notice_before_deny() -> void:
	var h := await _host("Sam", {"max_players": 5, "room": {"countdown_seconds": 0}})
	if h == null:
		return
	for code: String in ["bad_password", "banned"]:
		var j := await _join(h, "Ann")
		_check(j.lobby != null and await _until(func() -> bool: return _in(j)), "notice first (%s): a joiner is in" % code)
		j.lobby.room.supported = null # the host's answer has not arrived
		j.client._dispatch(_notice(code, {"ban": false}))
		var rem := j.lobby.removal
		_check(rem.get("code") == code and rem.get("reason") == OneLobbyRoomRules.removal_reason(code) and rem.get("ban") == false, "notice first (%s): refused, ban false: %s" % [code, JSON.stringify(rem)])
		_check(j.client.last_error.get("code") == code, "notice first (%s): last_error names the refusal: %s" % [code, JSON.stringify(j.client.last_error)])
		_check(j.ended.size() == 1 and j.count("removed") == 1, "notice first (%s): the session ends once (%d, %d)" % [code, j.ended.size(), j.count("removed")])
	var k := await _join(h, "Cy")
	_check(k.lobby != null and await _until(func() -> bool: return _in(k)), "a joiner is in for the mirror case")
	k.client._dispatch(_notice("banned", {}))
	_check(k.lobby.removal == {"code": "banned", "reason": OneLobbyRoomRules.removal_reason("banned"), "ban": true} and k.ended.size() == 1, "a joiner already in the room, kicked with ban true, still reads ban true: %s" % JSON.stringify(k.lobby.removal))
	h.lobby.leave()
	await _frames(5)


# ---- passwords, kick, ban, unban, removal ----------------------------------------------------------------------------

func _kick_ban_password() -> void:
	var h := await _host("Sam", {"max_players": 5, "password": "pw", "room": {"countdown_seconds": 0}})
	if h == null:
		return
	var hr := h.lobby.room
	var no_pw := await _join(h, "Nope")
	_check(no_pw.lobby == null and no_pw.client.last_error.get("code") == "bad_password", "a missing password fails join() with bad_password")
	var wrong := await _join(h, "Nope", {"password": "wrong"})
	_check(wrong.lobby == null and wrong.client.last_error.get("code") == "bad_password", "a wrong password fails join() with bad_password")
	# a hub that does not know passwords: the host's room checks it and the joiner is told why
	var hub: OneLobbyHub = h.client._direct_host.hub
	hub.password = ""
	var denied := await _join(h, "Nope", {"password": "wrong"})
	_check(denied.lobby != null and await _until(func() -> bool: return denied.count("removed") == 1), "with the hub's check off, the host's room still refuses a wrong password")
	_check(denied.lobby.removal.get("code") == "bad_password" and denied.lobby.removal.get("reason") == "Wrong password." and not denied.lobby.removal.get("ban"), "the joiner is told bad_password with its sentence")
	_check(await _until(func() -> bool: return denied.ended.size() == 1) and denied.client.last_error.get("code") == "bad_password", "its session ends and the client's error says bad_password (%s)" % JSON.stringify(denied.client.last_error))
	_check(hr.entries().size() == 1 and h.count("joined") == 0, "no entry was made for it")
	hub.password = "pw"
	var json := JSON.stringify(hr.entries()) + JSON.stringify(hr.settings())
	_check(not json.contains("pw\"") and not json.contains("wrong"), "the password never appears in the room state")

	var ann_store := OneLobbyStore.memory()
	var ann := await _join(h, "Ann", {"password": "pw"}, ann_store)
	_check(ann.lobby != null and await _until(func() -> bool: return _in(ann)), "the right password joins")
	var ar := ann.lobby.room
	var ann_seat: int = ar.me()["seat"]
	var ann_pid: String = ann.client.player_id()
	_check(OneLobbyRoomRules.is_player_id(ann_pid) and ann.client.player_id() == ann_pid, "the client has one 32-hex player id")
	_check(not h.client.player_id() == ann_pid, "players have their own ids")

	# ---- kick: code and reason reach the player, it may come back with the same seat
	var bob := await _join(h, "Bob", {"password": "pw"})
	await _until(func() -> bool: return _in(bob))
	_check(hr.kick(ann.id(), {"code": "Bad Code"}) == "bad_value", "a bad kick code is refused")
	_check(hr.kick(ann.id(), {"code": "smoke_kick", "reason": "Smoke test: bye"}) == "", "kick")
	_check(await _until(func() -> bool: return ann.count("removed") == 1 and ann.ended.size() == 1), "the player is removed")
	_check(ann.last("removed")[1] == {"code": "smoke_kick", "reason": "Smoke test: bye", "ban": false} and ann.lobby.removal == ann.last("removed")[1] and ann.ended == ["disconnected"], "it sees its code and reason before session_ended")
	_check(await _until(func() -> bool: return hr.player(ann.id()).is_empty() and h.count("left") == 1) and h.last("left")[2] == "disconnected" and hr.players().size() == 2, "the roster drops it (player_left why disconnected)")
	_check(await _until(func() -> bool: return bob.lobby.room.entries().size() == 2), "and so do the other players")
	var again := await _join(h, "Ann", {"password": "pw"}, ann_store)
	_check(again.lobby != null and await _until(func() -> bool: return _in(again)) and again.lobby.room.me()["seat"] == ann_seat, "a kicked player may rejoin, and gets its seat back")
	_check(hr.kick(again.id(), {}) == "", "a kick without a code is allowed")
	_check(await _until(func() -> bool: return again.count("removed") == 1) and again.lobby.removal["code"] == "kicked" and again.lobby.removal["reason"] == "The host removed you from the game.", "the default code is kicked with its sentence")

	# ---- ban: refused at the next join, by player id; unban lifts it
	var cy_store := OneLobbyStore.memory()
	var cy := await _join(h, "Cy", {"password": "pw"}, cy_store)
	await _until(func() -> bool: return _in(cy))
	var cy_pid: String = cy.client.player_id()
	h.log.clear()
	_check(hr.ban(cy.id(), {"reason": "no spoilers"}) == "", "ban")
	_check(await _until(func() -> bool: return cy.count("removed") == 1), "the player is removed")
	_check(cy.lobby.removal == {"code": "banned", "reason": "no spoilers", "ban": true}, "it sees code banned, the reason and ban true: %s" % JSON.stringify(cy.lobby.removal))
	_check(hr.bans.size() == 1 and hr.bans.list()[0]["id"] == cy_pid and hr.bans.list()[0]["reason"] == "no spoilers" and h.count("bans") == 1, "the ban list holds its player id and reason, and bans_changed fired")
	var cy2 := await _join(h, "Cy", {"password": "pw"}, cy_store)
	_check(cy2.lobby != null and await _until(func() -> bool: return cy2.count("removed") == 1), "joining again with the same install is refused")
	_check(cy2.lobby.removal == {"code": "banned", "reason": "You are banned from this game.", "ban": false} and await _until(func() -> bool: return cy2.ended.size() == 1), "with banned and the default sentence (a refused join is not the ban itself: ban false): %s" % JSON.stringify(cy2.lobby.removal))
	_check(hr.entries().size() == 3 or hr.entries().size() == 2, "(it never got an entry)")
	var other := await _join(h, "Dee", {"password": "pw"})
	_check(other.lobby != null and await _until(func() -> bool: return _in(other)), "another install is not affected")
	_check(hr.unban(cy_pid) == 1 and hr.bans.size() == 0 and h.count("bans") == 2, "unban by player id lifts it")
	var cy3 := await _join(h, "Cy", {"password": "pw"}, cy_store)
	_check(cy3.lobby != null and await _until(func() -> bool: return _in(cy3) or cy3.count("removed") > 0) and cy3.count("removed") == 0 and _in(cy3), "the unbanned player gets in again")
	# the list survives the lobby: a new list on the same store sees it
	hr.ban(cy3.id(), {})
	await _until(func() -> bool: return cy3.count("removed") == 1)
	var ban_copy := OneLobbyBanList.new(h.client.store, h.client.game_id)
	_check(ban_copy.size() == 1 and ban_copy.list()[0]["id"] == cy_pid, "the ban list is read back from the host's store")

	# ---- a ban by address alone catches a link whose address becomes known later
	hr.bans.clear()
	var dee_id: int = other.id()
	hr.bans.add({"ip": "10.9.8.7", "reason": "address ban", "code": "banned"})
	(h.lobby._peers[dee_id] as OneLobbyLobby.OLPeerRec).link.remote_address = "10.9.8.7"
	_check(await _until(func() -> bool: return other.count("removed") == 1), "a link address that matches the list removes the peer")
	_check(other.lobby.removal["code"] == "banned" and other.lobby.removal["reason"] == "address ban", "with the entry's code and reason")
	_check(not hr.bans.match_entry({"id": ann_pid, "ip": "10.9.8.7"}).is_empty(), "(an address-only entry also bans any id behind it)")
	for p: P in [h, ann, bob, again, cy, cy2, cy3, other, denied]:
		if p.lobby != null and not p.lobby.is_closed():
			p.lobby.leave()
	await _frames(10)


# ---- host-side rules with stand-in peers ---------------------------------------------------------------------------------

## Makes a peer the host lobby knows by id but has no link to, and speaks for it.
func _stand_in(h: P, id: int, display: String) -> void:
	h.lobby._peers[id] = OneLobbyLobby._rec(id, display)
	h.lobby.room._on_peer_hi(id)


func _say(h: P, from: int, m: Dictionary) -> void:
	if not h.lobby._peers.has(from):
		h.lobby._peers[from] = OneLobbyLobby._rec(from, "Peer %d" % from) # a peer that resumed has a new record
	h.lobby.room._handle_frame(from, OneLobbyRoomWire.encode_frame(m).slice(OneLobbyWire.HEADER))


func _gone(h: P, id: int, reason: String) -> void:
	if h.lobby._peers.has(id):
		h.lobby._drop_peer(h.lobby._peers[id], reason)


func _stand_ins() -> void:
	var h := await _host("Sam", {"max_players": 3, "room": {"countdown_seconds": 0, "rejoin_window_seconds": 1, "spectators": 1}})
	if h == null:
		return
	var hr := h.lobby.room
	var pid_a := "a".repeat(32)
	var pid_b := "b".repeat(32)
	var pid_c := "c".repeat(32)
	# seats are remembered per player id, also under a new peer id
	_stand_in(h, 20, "A")
	_say(h, 20, {"t": "join", "v": 1, "pid": pid_a})
	_stand_in(h, 21, "B")
	_say(h, 21, {"t": "join", "v": 1, "pid": pid_b})
	_check(hr.player(20)["seat"] == 1 and hr.player(21)["seat"] == 2 and hr.player(20)["status"] == "connected", "stand-ins are admitted by their join, with seats 1 and 2")
	_gone(h, 20, "left")
	_check(hr.player(20).is_empty() and h.last("left") == ["left", 20, "left"], "a leaver is removed at once (why left)")
	_check(h.count("dropped") == 1 and h.last("dropped")[1]["seat"] == 1 and h.last("dropped")[1]["peer_id"] == 20 and h.last("dropped")[1]["after_window"] == false and h.last("dropped")[1]["reason"] == "left", "seat_dropped fires for a removed player")
	_stand_in(h, 22, "C")
	_say(h, 22, {"t": "join", "v": 1, "pid": pid_c})
	_check(hr.player(22)["seat"] == 1 and h.count("restored") == 1 and h.last("restored")[1]["returning"] == false, "with no seat free the next player takes the dropped one over (seat_restored, not returning)")
	_gone(h, 22, "left")
	_stand_in(h, 23, "A")
	_say(h, 23, {"t": "join", "v": 1, "pid": pid_a})
	_check(hr.player(23)["seat"] == 1, "a seat remembered by someone who is gone is taken over: the lowest seat nobody holds")
	# reconnecting: the link drops inside the rejoin window
	h.log.clear()
	hr.player(23)
	_say(h, 23, {"t": "ready", "ready": true})
	_check(hr.player(23)["ready"] and hr.all_ready == false, "ready on a stand-in")
	_gone(h, 23, "timeout")
	_check(hr.player(23)["status"] == "reconnecting" and hr.player(23)["seat"] == 1 and hr.player(23)["ready"] and h.count("dropped") == 0, "a timeout inside the window makes it reconnecting and keeps seat, data and ready")
	_check(not hr.all_ready, "a reconnecting player stops all_ready")
	# the same player id under a new peer id replaces the reconnecting entry; the new entry starts fresh
	_stand_in(h, 24, "A")
	_say(h, 24, {"t": "join", "v": 1, "pid": pid_a, "data": {"team": "3"}})
	_check(hr.player(23).is_empty() and hr.player(24)["status"] == "connected" and hr.player(24)["seat"] == 1 and not hr.player(24)["ready"] and hr.player(24)["data"]["team"] == "3", "a new peer id with the same player id replaces it; the new entry is fresh (not ready, its own data)")
	_check(h.count("dropped") == 0 and h.last("left")[2] == "left", "the replaced entry is gone without a seat_dropped")
	# past the rejoin window: removed, seat_dropped once
	_gone(h, 24, "timeout")
	_check(hr.player(24)["status"] == "reconnecting", "reconnecting again")
	_check(await _until(func() -> bool: return hr.player(24).is_empty(), 4000), "the window ends: the entry is removed")
	_check(h.last("left")[2] == "timeout" and h.count("dropped") == 1 and h.last("dropped")[1]["after_window"] == true and h.last("dropped")[1]["reason"] == "timeout", "gone why timeout, and seat_dropped once with after_window")
	# a rebind by the same peer id: join again after a reconnecting state
	_say(h, 21, {"t": "ready", "ready": true})
	_gone(h, 21, "timeout")
	_check(hr.player(21)["status"] == "reconnecting", "B drops")
	_say(h, 21, {"t": "join", "v": 1, "pid": pid_b})
	_check(hr.player(21)["status"] == "connected" and hr.player(21)["ready"] and hr.player(21)["seat"] == 2, "its own peer id again with the same player id rebinds the entry (ready kept)")
	# seat_dropped immediate and rejoin_window 0
	hr.configure({"seat_dropped": "immediate"})
	h.log.clear()
	_gone(h, 21, "timeout")
	_check(h.count("dropped") == 1 and h.last("dropped")[1]["after_window"] == false and h.last("dropped")[1]["reason"] == "disconnected" and hr.player(21)["status"] == "reconnecting", "policy immediate raises seat_dropped when the entry becomes reconnecting")
	_say(h, 21, {"t": "join", "v": 1, "pid": pid_b})
	_check(h.count("restored") == 1 and h.last("restored")[1]["returning"] == true, "and seat_restored when it comes back")
	h.log.clear()
	_gone(h, 21, "left")
	_check(h.count("dropped") == 1 and h.last("dropped")[1]["reason"] == "left" and hr.player(21).is_empty(), "a player who leaves later raises it again (why left)")
	_stand_in(h, 21, "B")
	_say(h, 21, {"t": "join", "v": 1, "pid": pid_b})
	h.log.clear()
	_gone(h, 21, "timeout")
	hr._remove_entry(21, "timeout")
	_check(h.count("dropped") == 1 and h.last("dropped")[1]["after_window"] == false, "immediate raises it once: not again when the window would end")
	hr.configure({"seat_dropped": "window", "rejoin_window_ms": 0})
	_stand_in(h, 25, "D")
	_say(h, 25, {"t": "join", "v": 1, "pid": pid_c})
	_gone(h, 25, "timeout")
	_check(hr.player(25).is_empty() and h.last("left")[2] == "timeout", "a rejoin window of 0 removes at once")
	hr.configure({"rejoin_window_ms": 60000})
	# admission: capacity, spectators, role requests from a stand-in
	_stand_in(h, 30, "P1")
	_say(h, 30, {"t": "join", "v": 1})
	_stand_in(h, 31, "P2")
	_say(h, 31, {"t": "join", "v": 1})
	_check(hr.players().size() == 3 and hr.player(30)["seat"] == 1 and hr.player(31)["seat"] == 2, "players fill the seats (a peer without a player id is not remembered)")
	_stand_in(h, 32, "Spec")
	_say(h, 32, {"t": "join", "v": 1, "role": "spectator"})
	_check(hr.player(32)["role"] == "spectator" and hr.player(32)["seat"] == -1, "a spectator joins")
	_say(h, 32, {"t": "role", "role": "player"})
	_check(hr.player(32)["role"] == "spectator", "a spectator cannot take a seat in a full room")
	_gone(h, 31, "left")
	_say(h, 32, {"t": "role", "role": "player"})
	_check(hr.player(32)["role"] == "player" and hr.player(32)["seat"] == 2 and not hr.player(32)["ready"], "with a seat free it becomes a player in it")
	_say(h, 32, {"t": "role", "role": "spectator"})
	_check(hr.player(32)["role"] == "spectator" and hr.player(32)["seat"] == -1, "and back to a spectator")
	_say(h, 32, {"t": "role", "role": "wizard"})
	_say(h, 32, {"t": "req", "what": "nonsense"})
	_say(h, 32, {"t": "ready", "ready": true})
	_check(not hr.player(32)["ready"], "bad role, request and a spectator's ready change nothing")
	# state and countdown rules around start, the late join policy
	hr.configure({"late_join": "spectate"})
	_say(h, 30, {"t": "ready", "ready": true})
	hr.set_ready(true)
	hr.start()
	_check(hr.state == "started" and h.lobby.phase == "in_game", "start with no countdown goes straight to started")
	_gone(h, 32, "left")
	_stand_in(h, 33, "Late")
	_say(h, 33, {"t": "join", "v": 1, "role": "player"})
	_check(hr.player(33).get("role") == "spectator" and hr.player(33)["seat"] == -1, "late join policy spectate: a player joining a started game can only spectate")
	_stand_in(h, 35, "Late3")
	_say(h, 35, {"t": "join", "v": 1, "role": "player"})
	_check(hr.player(35).is_empty(), "(and the spectator cap still counts)")
	hr.configure({"late_join": "refuse"})
	_stand_in(h, 34, "Late2")
	var before := hr.entries().size()
	_say(h, 34, {"t": "join", "v": 1, "role": "player"})
	_check(hr.entries().size() == before and hr.player(34).is_empty(), "late join policy refuse: no entry")
	hr.back_to_lobby()
	_check(hr.state == "lobby" and not hr.player(30)["ready"], "back to lobby")
	# legacy peers: no join inside 3 s
	_stand_in(h, 40, "OldClient")
	_check(hr.player(40).is_empty(), "a peer that said hi but sent no join is not in the room at first")
	h.lobby.room._legacy_wait[40] = h.lobby.now_ms() - 1
	await _frames(3)
	_check(hr.player(40).get("legacy") == true and hr.player(40)["status"] == "connected" and not hr.player(40)["ready"], "after the wait it is admitted as a legacy player, never ready")
	_say(h, 40, {"t": "ready", "ready": true})
	_check(not hr.player(40)["ready"], "a legacy peer's room frames are ignored")
	# name rules on a rename
	h.lobby.room._on_renamed(30, "  Sam  ")
	_check(hr.player(30)["name"] == "Sam 2", "a rename: trimmed, then made unique against the host's Sam")
	h.lobby.room._on_renamed(30, "")
	_check(hr.player(30)["name"] == "Player 30", "an empty name becomes Player N")
	# a frame from a peer that has not joined is ignored, resync answers, junk frames are dropped
	_say(h, 55, {"t": "set", "data": {"color": "#ffffff"}})
	hr._handle_frame(30, PackedByteArray([0xff, 0xfe]))
	hr._handle_frame(30, "[1]".to_utf8_buffer())
	hr._handle_frame(30, "{\"t\":\"upd\",\"rev\":1}".to_utf8_buffer())
	_check(hr.player(55).is_empty() and hr.revision > 1, "frames from strangers and junk are ignored")
	# the ban list and the link address
	hr.bans.add({"id": pid_c, "reason": "x"})
	_stand_in(h, 41, "C again")
	_say(h, 41, {"t": "join", "v": 1, "pid": pid_c})
	_check(hr.player(41).is_empty(), "a banned player id is refused at join (no entry)")
	hr.bans.clear()
	# auto start: players mode, then a leaver cancels the countdown
	_gone(h, 40, "left")
	hr.configure({"auto_start": "players", "auto_start_players": 3, "countdown_ms": 5000, "late_join": "allow"})
	hr.set_ready(false)
	await _frames(3)
	var members: Array = hr.players().filter(func(e: Dictionary) -> bool: return not e.get("legacy", false))
	_check(members.size() >= 2, "(two connected players)")
	_stand_in(h, 42, "Third")
	_say(h, 42, {"t": "join", "v": 1})
	_check(await _until(func() -> bool: return hr.state == "countdown"), "players mode starts a countdown when enough players are connected (%d)" % hr.players().size())
	_check(h.last("countdown") != [] and h.last("countdown")[2] <= 5000, "countdown_changed carries the remaining time")
	_gone(h, 42, "left")
	_check(hr.state == "lobby" and h.last("cancelled")[1] == "condition", "a leaver breaks the condition: countdown cancelled (condition)")
	hr.configure({"auto_start": "off"})
	# the host with a countdown cancel for too few players
	for id in [30, 32, 40]:
		_gone(h, id, "left")
	await _frames(3)
	_check(hr.players().size() == 1, "(back to the host alone)")
	hr.configure({"min_players": 2, "countdown_ms": 5000})
	_stand_in(h, 43, "X")
	_say(h, 43, {"t": "join", "v": 1})
	_check(hr.start() == "" and hr.state == "countdown", "a countdown with two players")
	_gone(h, 43, "left")
	_check(hr.state == "lobby" and h.last("cancelled")[1] == "too_few", "too few connected players cancels it (too_few)")
	hr.configure({"min_players": 1})
	# migration: a replica that becomes the host rebuilds the room
	await _migration()
	h.lobby.leave()
	await _frames(5)


## A joiner that becomes the host (host migration) keeps the roster, marks the others reconnecting and rebuilds seat memory.
func _migration() -> void:
	var h := await _host("Host", {"max_players": 3, "room": {"countdown_seconds": 0}})
	if h == null:
		return
	var ann := await _join(h, "Ann")
	await _until(func() -> bool: return _in(ann))
	var bob := await _join(h, "Bob")
	await _until(func() -> bool: return _in(bob) and ann.lobby.room.entries().size() == 3)
	var r := ann.lobby.room
	var rev := r.revision
	# Ann's lobby is told it is the host (what _become_host does, without the links): its room becomes the truth
	ann.lobby._host_id = ann.id()
	r._on_became_host()
	_check(r.supported == true and r.revision == rev + 1 and r.entries().size() == 3, "migration: the new host's room keeps the roster and bumps the revision")
	_check(r.player(ann.id())["status"] == "connected" and r.player(bob.id())["status"] == "reconnecting" and r.player(h.id())["status"] == "reconnecting", "the other entries become reconnecting")
	_check(r.me()["seat"] == 1, "the new host keeps its seat")
	ann.lobby._host_id = h.id()
	h.lobby.leave()
	ann.lobby.leave()
	bob.lobby.leave()
	await _frames(5)


# ---- an older host and an older joiner ------------------------------------------------------------------------------------

func _old_host_and_old_joiner() -> void:
	var h := await _host("Sam", {"max_players": 3})
	if h == null:
		return
	# an old host never answers: its room is switched off
	h.lobby.room._closed = true
	var j := await _join(h, "New")
	if j.lobby == null:
		_check(false, "join an old host: %s" % JSON.stringify(j.client.last_error))
		return
	var jr := j.lobby.room
	_check(jr.supported == null and not jr.entries().is_empty(), "before any answer supported is unknown and entries is the hub roster")
	_check(await _until(func() -> bool: return jr.supported == false, 12000) and j.count("unsupported") == 1, "3 s after the link opened it becomes unsupported")
	var errs: Array = []
	j.client.error.connect(func(code: String, _m: String) -> void: errs.append(code))
	_check(jr.set_ready(true) == "room_unsupported" and jr.set_data({"color": "#ffffff"}) == "room_unsupported" and jr.request("start") == "room_unsupported" and errs == ["room_unsupported", "room_unsupported", "room_unsupported"], "calls fail with room_unsupported")
	var ents := jr.entries()
	_check(ents.size() == 2 and ents[0]["role"] == "player" and ents[0]["seat"] == -1 and not ents[0]["ready"] and not ents[0].has("legacy") and _names(ents) == ["Sam", "New"], "entries lists the hub roster: players, seat -1, not ready")
	j.lobby.leave()
	h.lobby.leave()
	await _frames(5)
	# an old joiner: sends no join; the host admits it as a legacy player after 3 s
	var h2 := await _host("Sam", {"max_players": 3, "room": {"auto_start": "all_ready", "countdown_seconds": 0}})
	if h2 == null:
		return
	var o := P.new()
	o.client = _client("Old")
	o.lobby = await o.client.join_direct(h2.lobby.ip_code, {"timeout_ms": 20000})
	if o.lobby == null:
		_check(false, "old joiner: %s" % JSON.stringify(o.client.last_error))
		return
	o.attach()
	_everyone.append(o)
	o.lobby.room._closed = true # it predates the room layer: it says hi and never join
	var r2 := h2.lobby.room
	_check(await _until(func() -> bool: return r2.player(o.id()).get("legacy") == true, 10000), "a joiner that sends no join becomes a legacy player after the wait")
	var e := r2.player(o.id())
	_check(e["name"] == "Old" and e["seat"] == 1 and not e["ready"] and e["role"] == "player", "with the default name rules, the lowest seat, not ready")
	r2.set_ready(true)
	await _frames(20)
	_check(r2.state == "lobby" or r2.state == "started", "(auto start ignores legacy players: the host alone starts)")
	_check(o.lobby.room.entries().size() == 2 and o.log.filter(func(l: Array) -> bool: return l[0] != "unsupported").is_empty(), "it is sent no room frames")
	o.lobby.leave()
	h2.lobby.leave()
	await _frames(5)


# ---- host and join options, the blueprint's room section --------------------------------------------------------------------

func _options_and_blueprint() -> void:
	# password_required and the password length are checked before anything starts
	var c := OneLobbyClient.from_config({"game": {"id": "room-test"}, "engine": "godot-gdscript", "hosting": {"nostr": false}, "room": {"passwordRequired": true}})
	c.store = OneLobbyStore.memory()
	root.add_child(c)
	var l: OneLobbyLobby = await c.host_direct({"tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1"})
	_check(l == null and c.last_error.get("code") == "password_required", "room.passwordRequired: host fails with password_required without a password")
	l = await c.host_direct({"password": "x".repeat(65), "tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1"})
	_check(l == null and c.last_error.get("code") == "bad_request", "a password over 64 characters is refused")
	c.queue_free()
	# the file's room section fills the host's settings; explicit options win and their data declarations merge
	var bp := {"game": {"id": "room-test"}, "engine": "godot-gdscript", "hosting": {"nostr": false}, "lobby": {"maxPlayers": 4}, "players": {"maxNameLength": 10},
		"room": {"autoStart": "players", "autoStartPlayers": 3, "minPlayers": 2, "countdownSeconds": 5, "spectators": 1, "seatDropped": "immediate",
			"rejoinWindowSeconds": 30, "data": {"mood": {"type": "enum", "values": ["happy", "sad"], "default": "happy"}}}}
	var host := OneLobbyClient.from_config(bp, {"display_name": "Sam"})
	host.store = OneLobbyStore.memory()
	root.add_child(host)
	var hl: OneLobbyLobby = await host.host_direct({"tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1", "udp_port_range": [_next_port, _next_port + 9],
		"room": {"countdown_seconds": 2, "data": {"rank": {"type": "int", "min": 1, "max": 9, "default": "1"}}}, "data": {"mood": "sad"}})
	_next_port += 20
	if hl == null:
		_check(false, "host from a file with a room section: %s" % JSON.stringify(host.last_error))
		return
	var s := hl.room.settings()
	_check(s["autoStart"] == "players" and s["autoStartPlayers"] == 3 and s["minPlayers"] == 2 and s["countdownMs"] == 2000 and s["spectators"] == 1, "the file's settings reach the room; an explicit option wins (countdown 2 s over the file's 5 s)")
	_check(s["seatDropped"] == "immediate" and s["rejoinWindowMs"] == 30000 and s["maxNameLength"] == 10 and s["maxPlayers"] == 4 and s["lateJoin"] == "allow", "seat policy, rejoin window, players.maxNameLength, max players and late join come from the file")
	_check(s["data"].has("mood") and s["data"].has("rank") and s["data"].has("color") and s["data"]["rank"]["default"] == "1", "data declarations merge: the file's, the call's and the built-ins")
	_check(hl.room.me()["data"] == {"mood": "sad", "rank": "1", "avatar": "0", "team": "0"}, "the host's own data and the declared defaults: %s" % JSON.stringify(hl.room.me()["data"]))
	# a joiner takes everything from the host's snapshot
	var j := P.new()
	j.client = _client("Ann")
	j.lobby = await j.client.join_direct(hl.ip_code, {"timeout_ms": 20000, "data": {"mood": "angry", "rank": "4"}})
	if j.lobby == null:
		_check(false, "join: %s" % JSON.stringify(j.client.last_error))
		return
	j.attach()
	_everyone.append(j)
	_check(await _until(func() -> bool: return _in(j)) and j.lobby.room.settings()["countdownMs"] == 2000 and j.lobby.room.me()["data"] == {"mood": "happy", "rank": "4", "avatar": "0", "team": "0"}, "the joiner's settings are the host's; its bad data value is skipped and the default applies")
	# players mode, three needed: two are not enough
	await _frames(20)
	_check(hl.room.state == "lobby", "auto start waits for three players")
	hl.leave()
	j.lobby.leave()
	host.queue_free()
	await _frames(5)
