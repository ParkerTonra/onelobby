extends SceneTree
## The drop-in menu's model (OneLobbyMenuModel) driven with no scene, against real GDScript peers on 127.0.0.1 (direct hosts by
## IP, no Nostr, no internet): host, a second player joins by code, roster, ready, start with the countdown, back to lobby, kick
## with a reason, ban and a refused rejoin, unban, wrong password, a bad code, an old host, saved name and last code as
## defaults, chat, join requests, lobby settings, the connection check's lines, and the relay line never being shown.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/menu.gd
## Prints "menu: N passed, M failed"; exits 1 on any failure.

const Screen := OneLobbyMenuModel.Screen
const RELAY := "turn:127.0.0.1:9 samuser sampass77"

var _pass := 0
var _fail := 0
var _next_port := 49100
var _all: Array = [] # every rig made, left at the end
var _copied: Array = []


## One player: a client and the model that drives it.
class Rig:
	var client: OneLobbyClient
	var model: OneLobbyMenuModel
	var started := 0
	var back := 0
	var left := 0


func _init() -> void:
	process_frame.connect(func() -> void:
		if Time.get_ticks_msec() > 240000:
			print("menu FAIL: timed out")
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


func _rig(store: OneLobbyStore = null, host_opts: Dictionary = {}) -> Rig:
	var r := Rig.new()
	var c := OneLobbyClient.new()
	c.game_id = "menu-test"
	c.net_version = "1"
	c.store = store if store != null else OneLobbyStore.memory()
	c.settings_env = {}
	c.log_path = ""
	c.ready_timeout_ms = 20000
	c.lobby_server = "ws://127.0.0.1:1/ws" # nothing listens here: a lobby-code join fails fast
	root.add_child(c)
	r.client = c
	r.model = OneLobbyMenuModel.new(c)
	r.model.route = "direct"
	r.model.clipboard = func(t: String) -> void: _copied.append(t)
	var o := {"name": "menu", "max_players": 4, "tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1",
		"udp_port_range": [_next_port, _next_port + 15], "nostr": false, "room": {"countdown_seconds": 1}}
	_next_port += 20
	o.merge(host_opts, true)
	r.model.host_options = o
	r.model.join_options = {"timeout_ms": 20000}
	r.model.game_started.connect(func(_l: OneLobbyLobby) -> void: r.started += 1)
	r.model.returned_to_lobby.connect(func(_l: OneLobbyLobby) -> void: r.back += 1)
	r.model.left.connect(func() -> void: r.left += 1)
	_all.append(r)
	return r


func _hosting(name: String, host_opts: Dictionary = {}) -> Rig:
	var h := _rig(null, host_opts)
	h.model.set_name(name)
	await h.model.host()
	return h


func _guest(h: Rig, name: String, password: String = "", store: OneLobbyStore = null) -> Rig:
	var g := _rig(store)
	g.model.set_name(name)
	g.model.set_join_text(h.model.lobby.ip_code.to_lower())
	g.model.set_password(password)
	await g.model.join()
	return g


func _in(r: Rig) -> bool:
	return r.model.screen == Screen.LOBBY and r.model.room_active() and not r.model.lobby.room.me().is_empty()


func _names(r: Rig) -> Array:
	return r.model.roster_rows().map(func(row: Dictionary) -> String: return row["name"])


func M_parse(text: String) -> Dictionary:
	return OneLobbyMenuModel.parse_join(text)


func _row(r: Rig, who: String) -> Dictionary:
	for row: Dictionary in r.model.roster_rows():
		if row["name"] == who:
			return row
	return {}


func _run() -> void:
	var only := ""
	for x in OS.get_cmdline_user_args():
		if x.begins_with("--only="):
			only = x.substr(7)
	_pure()
	if only == "" or only == "flow":
		await _flow()
	if only == "" or only == "kick":
		await _kick_ban()
	if only == "" or only == "errors":
		await _errors()
	if only == "" or only == "old":
		await _old_host()
	if only == "" or only == "extras":
		await _extras()
	print("menu: %d passed, %d failed" % [_pass, _fail])
	for r: Rig in _all:
		if r.model.lobby != null and not r.model.lobby.is_closed():
			r.model.lobby.leave()
	await _frames(5)
	quit(1 if _fail > 0 else 0)


# ---- parsing and defaults -----------------------------------------------------------------------------------------------

func _pure() -> void:
	var M := OneLobbyMenuModel
	_check(M.clean_join_text("7hq-4k2 !!") == "7HQ-4K2 ", "a code is upper-cased and stray characters dropped as typed: '%s'" % M.clean_join_text("7hq-4k2 !!"))
	_check(M.clean_join_text("127.0.0.1:47810") == "127.0.0.1:47810", "an address is kept as typed")
	_check(M.clean_join_text("https://g.example/?join=7hq4k2") == "https://g.example/?join=7hq4k2", "a link is kept as typed")
	_check(M.parse_join("7hq 4k2") == {"kind": "lobby", "value": "7HQ4K2"}, "a code")
	_check(M.parse_join("https://g.example/play?join=7HQ-4K2") == {"kind": "lobby", "value": "7HQ4K2"}, "an invite link yields its code")
	_check(M.parse_join("192.168.1.20:47810")["kind"] == "address" and M.parse_join("192.168.1.20")["kind"] == "address", "an ip:port or an ip")
	_check(M.parse_join(OneLobbyJoinCode.encode_ip("10.1.2.3", 47810))["kind"] == "direct", "a direct code")
	_check(M.parse_join("hello")["kind"] == "" and M.parse_join("")["kind"] == "", "garbage and nothing are no code")
	# a pasted invite sentence: the code after its "code" marker, never the game title
	var lobby_code := {"kind": "lobby", "value": "7HQ4K2"}
	_check(M.parse_join("Join my game in Fortress: code 7HQ 4K2") == lobby_code, "a sentence with a code-like title (Fortress): %s" % str(M.parse_join("Join my game in Fortress: code 7HQ 4K2")))
	_check(M.parse_join("Join my game in Castle: code 7HQ-4K2") == lobby_code, "a six-letter title that is itself a valid code (Castle)")
	_check(M.parse_join("Join my game: code 7HQ-4K2") == lobby_code and M.parse_join("Join my game: code 7HQ 4K2.") == lobby_code, "no title; a trailing full stop")
	_check(M.parse_join("\"Join my game in Fortress: code 7HQ-4K2\"") == lobby_code and M.parse_join("code '7HQ-4K2'!") == lobby_code, "quotes and punctuation around the code are dropped")
	_check(M.parse_join("Join my game in Fortress: code 7HQ 4K2 https://g.example/play?join=7HQ-4K2") == lobby_code, "a sentence followed by its link")
	_check(M.parse_join("Come play Fortress 7HQ-4K2") == lobby_code and M.parse_join("Rejoins ma partie Castle : 7HQ 4K2") == lobby_code, "a reworded sentence with no marker: scanned from its end")
	_check(M.parse_join("Join my game: code 192.168.1.20:47810")["kind"] == "address", "an address after the marker")
	var dc := OneLobbyJoinCode.encode_ip("10.1.2.3", 47810)
	_check(M.parse_join("Join my game in Fortress: code " + dc) == {"kind": "direct", "value": dc}, "a direct code after the marker")
	_check(M.parse_join("Join my game in Fortress")["kind"] == "", "a sentence with no code is no code")
	OneLobbyMenuText.override({"invite_sentence_untitled": "Come play: code %s"})
	_check(OneLobbyMenuText.t("invite_sentence_untitled", ["7HQ 4K2"]) == "Come play: code 7HQ 4K2", "the invite sentence can be reworded")
	OneLobbyMenuText.override({})
	# saved name and last code are the defaults
	var store := OneLobbyStore.memory()
	var r := _rig(store)
	r.client.settings.save({"name": "Sam", "last_code": "7HQ4K2"})
	var m := OneLobbyMenuModel.new(r.client)
	_check(m.name_text == "Sam" and m.join_text == "7HQ 4K2", "the saved name and last code are the start screen's defaults: %s / %s" % [m.name_text, m.join_text])
	m.route = "direct"
	_check(not m.can_browse(), "no Browse on a direct route")
	m.route = "auto"
	_check(m.can_browse(), "Browse is offered when a lobby server is set")


# ---- host, join, roster, ready, countdown, start, back to lobby -----------------------------------------------------------

func _flow() -> void:
	var h := await _hosting("Sam")
	_check(h.model.screen == Screen.LOBBY and h.model.is_host(), "hosting lands on the lobby screen")
	_check(await _until(func() -> bool: return _in(h)), "the host is in its room")
	var code := h.model.code_text()
	_check(code != "" and h.model.lobby.ip_code != "", "the lobby has a code to show: %s" % code)
	_check(h.model.copy_code() and _copied.back() == code, "Copy code puts the code on the clipboard")
	_check(h.model.invite_available() and h.model.copy_invite() and _copied.back() == "Join my game: code " + code, "Copy invite copies the sentence with the code (no title): %s" % _copied.back())
	h.model.invite_base = "https://g.example/play"
	_check(h.model.invite_text() == "Join my game: code " + code, "a direct code does not travel in a link, so no link follows the sentence")
	h.model.invite_base = ""
	var titled := OneLobbyClient.from_config({"game": {"id": "menu-test", "title": "Fortress"}})
	h.client.config = titled.config
	_check(h.model.invite_text() == "Join my game in Fortress: code " + code, "with a game title the sentence names the game: %s" % h.model.invite_text())
	_check(M_parse(h.model.invite_text())["kind"] == "direct", "and the Join box reads that back as the code, not the title")
	h.client.config = null
	titled.free()
	_check(M_parse(_copied.back())["value"] == h.model.lobby.code or M_parse(_copied.back())["kind"] == "direct", "the Join box takes the copied sentence back: %s" % str(M_parse(_copied.back())))
	_check(h.client.settings.effective()["name"] == "Sam" and h.client.settings.effective()["last_code"] != "", "the name and the code were saved")
	var g := await _guest(h, "Ann")
	_check(g.model.screen == Screen.LOBBY, "joining by the (lower-case) code lands on the lobby screen")
	_check(await _until(func() -> bool: return _in(g) and _names(g) == ["Sam", "Ann"] and _names(h) == ["Sam", "Ann"]), "both see the roster: %s / %s" % [_names(g), _names(h)])
	_check(_row(h, "Sam")["host"] and not _row(h, "Ann")["host"] and _row(h, "Ann")["can_kick"] and not _row(h, "Sam")["can_kick"], "the host mark; only the host can kick, and not itself")
	_check(not _row(g, "Ann")["can_kick"] and h.model.players_header() == "Players 2/4", "a joiner has no kick; the header counts players: %s" % h.model.players_header())
	g.model.toggle_ready()
	_check(await _until(func() -> bool: return _row(h, "Ann").get("ready", false)), "ready shows in the host's roster")
	_check(h.model.row_marks(_row(h, "Ann")) == "Ready" and h.model.row_marks(_row(h, "Sam")) == "Host", "marks: %s / %s" % [h.model.row_marks(_row(h, "Ann")), h.model.row_marks(_row(h, "Sam"))])
	g.model.chat_lines.clear()
	h.model.send_chat("hi there")
	_check(await _until(func() -> bool: return g.model.chat_lines.size() == 1 and g.model.chat_lines[0]["text"] == "hi there"), "chat reaches the other player")
	# the host's lobby settings
	_check(h.model.lobby_settings()["countdown_seconds"] == 1 and g.model.lobby_settings()["auto_start"] == "off", "lobby settings are read from the room")
	h.model.set_lobby_setting("min_players", 2)
	_check(await _until(func() -> bool: return g.model.lobby_settings().get("min_players") == 2), "the host changes a lobby setting for everyone")
	h.model.set_lobby_setting("min_players", 1)
	# start: a countdown everyone sees, then the game
	g.model.start_game()
	_check(not g.model.counting_down(), "a joiner's Start does nothing")
	h.model.start_game()
	_check(await _until(func() -> bool: return h.model.counting_down() and g.model.counting_down()), "the countdown shows on both")
	_check(h.model.countdown_text().begins_with("Starting in") and g.model.countdown_text() != "", "its text: %s" % h.model.countdown_text())
	_check(await _until(func() -> bool: return h.started == 1 and g.started == 1, 20000), "game_started fires once on both")
	_check(h.model.screen == Screen.PLAYING and g.model.screen == Screen.PLAYING, "the screen is PLAYING")
	h.model.lobby.room.back_to_lobby()
	_check(await _until(func() -> bool: return h.back == 1 and g.back == 1), "returned_to_lobby fires on both")
	_check(h.model.screen == Screen.LOBBY and g.model.screen == Screen.LOBBY and not _row(h, "Ann")["ready"], "back on the lobby screen, ready flags reset")
	# leave
	await g.model.leave()
	_check(g.model.screen == Screen.START and g.left == 1 and g.model.lobby == null, "Leave goes back to the start screen and says so")
	# gap: a direct-mode joiner's leave reaches the host as a lost link, so the seat reads "reconnecting" for the rejoin window
	_check(await _until(func() -> bool: return _names(h) == ["Sam"] or _row(h, "Ann").get("reconnecting", false)), "the host's roster shows the player gone or reconnecting")
	await h.model.leave()


# ---- kick, ban, unban --------------------------------------------------------------------------------------------------------

func _kick_ban() -> void:
	var h := await _hosting("Sam", {"max_players": 5})
	var store := OneLobbyStore.memory()
	var g := await _guest(h, "Ann", "", store)
	await _until(func() -> bool: return _in(g) and _names(h).size() == 2)
	var ann_id: int = _row(h, "Ann")["id"]
	h.model.kick(ann_id, "afk too long")
	_check(await _until(func() -> bool: return g.model.screen == Screen.ERROR), "a kicked player lands on the error screen")
	var e := g.model.error
	_check(e["removed"] and e["message"] == "afk too long" and e["reason"] == "afk too long" and e["ban"] == false, "it shows the host's reason, ban false: %s" % JSON.stringify(e))
	_check(g.model.removal["code"] == "kicked" and e["title"] == OneLobbyMenuText.t("removed_title") and e["code"] == "kicked", "the removal and title")
	g.model.back()
	_check(g.model.screen == Screen.START, "Back leaves the removed screen")
	# a kick without a reason says the default sentence
	var g2 := await _guest(h, "Ann", "", store)
	await _until(func() -> bool: return _in(g2))
	h.model.kick(_row(h, "Ann")["id"])
	_check(await _until(func() -> bool: return g2.model.screen == Screen.ERROR) and g2.model.error["message"] == "The host removed you from the game.", "no reason: the default sentence (%s)" % g2.model.error.get("message"))
	# ban with a reason, then a refused rejoin
	var g3 := await _guest(h, "Ann", "", store)
	await _until(func() -> bool: return _in(g3))
	h.model.ban(_row(h, "Ann")["id"], "no spoilers")
	_check(await _until(func() -> bool: return g3.model.screen == Screen.ERROR), "a banned player lands on the error screen")
	_check(g3.model.error["ban"] == true and g3.model.error["message"] == "no spoilers" and g3.model.error["title"] == OneLobbyMenuText.t("banned_title"), "it reads banned with the reason: %s" % JSON.stringify(g3.model.error))
	_check(h.model.ban_rows().size() == 1 and "no spoilers" in str(h.model.ban_rows()[0]["text"]) and "Ann" in str(h.model.ban_rows()[0]["text"]), "the ban list shows the name and reason: %s" % str(h.model.ban_rows()))
	var g4 := _rig(store)
	g4.model.set_name("Ann")
	g4.model.set_join_text(h.model.lobby.ip_code)
	await g4.model.join()
	await _until(func() -> bool: return g4.model.screen == Screen.ERROR, 20000)
	_check(g4.model.screen == Screen.ERROR and g4.model.error["code"] == "banned", "a banned player's rejoin is refused (%s)" % g4.model.error.get("code"))
	_check(g4.model.error["message"] != "" and g4.model.error["message"] != "banned", "with a sentence: %s" % g4.model.error.get("message"))
	# unban lifts it
	h.model.unban(str(h.model.ban_rows()[0]["key"]))
	_check(h.model.ban_rows().is_empty(), "Unban empties the ban list")
	g4.model.back()
	await g4.model.join()
	_check(await _until(func() -> bool: return _in(g4), 20000), "after Unban the player can join again")
	await h.model.leave()
	# join requests (approveJoins hub): the model keeps them until answered
	var h2 := await _hosting("Sam")
	h2.model.lobby.join_requested.emit({"peer_id": 77, "name": "Bob", "ping_ms": 0, "relayed": false})
	_check(h2.model.requests.size() == 1 and h2.model.requests[0]["name"] == "Bob", "a join request is listed")
	h2.model.approve(77, false)
	_check(h2.model.requests.is_empty(), "answering it removes it")
	await h2.model.leave()


# ---- errors the player reads ---------------------------------------------------------------------------------------------------

func _errors() -> void:
	var h := await _hosting("Sam", {"password": "pw", "max_players": 4})
	var g := await _guest(h, "Ann", "wrong")
	_check(g.model.screen == Screen.ERROR and g.model.error["code"] == "bad_password", "a wrong password: error screen (%s)" % g.model.error.get("code"))
	_check(g.model.error["message"] == "That password isn't right." and g.model.error["hint"] != "", "with the friendly sentence and a next step: %s" % JSON.stringify(g.model.error))
	g.model.back()
	g.model.set_password("pw")
	await g.model.join()
	_check(await _until(func() -> bool: return _in(g)), "the right password joins")
	await g.model.leave()
	await h.model.leave()
	# a bad code
	var b := _rig()
	b.model.set_join_text("hello world")
	await b.model.join()
	_check(b.model.screen == Screen.ERROR and b.model.error["code"] == "bad_code", "a bad code goes to the error screen")
	_check(b.model.error["message"] == OneLobbyFriendly.describe_error("bad_code")["message"] and b.model.error["message"].length() > 20 and b.model.error["hint"] != "", "with a sentence, not only the code: %s" % JSON.stringify(b.model.error))
	_check(b.model.error["code"] == "bad_code", "the code sits underneath")
	b.model.back()
	_check(b.model.screen == Screen.START, "Back returns to start")
	# a good-looking lobby code, but no lobby server answers
	b.model.set_join_text("7HQ 4K2")
	await b.model.join()
	_check(b.model.screen == Screen.ERROR and b.model.error["message"] != "" and not b.model.error["message"].begins_with("connect_failed"), "no lobby server: a plain sentence: %s" % JSON.stringify(b.model.error))
	_check(b.model.error["hint"] != "" or b.model.error["message"].length() > 30, "and what to do")
	# logs: copy and save, addresses masked, a save path in the note
	b.model.copy_logs()
	_check(_copied.back().begins_with("# onelobby netlog") and "addresses masked" in _copied.back() and b.model.log_note == OneLobbyMenuText.t("logs_copied"), "Copy logs copies the masked net log")
	b.model.logs_path = "user://menu-test-log.txt"
	b.model.save_logs()
	_check(FileAccess.file_exists("user://menu-test-log.txt") and "menu-test-log.txt" in b.model.log_note, "Save logs writes the file and names it: %s" % b.model.log_note)
	DirAccess.remove_absolute(ProjectSettings.globalize_path("user://menu-test-log.txt"))
	# cancelling a connect that is still waiting
	var c := _rig()
	c.model.set_join_text("7HQ 4K2")
	c.model.join()
	_check(c.model.screen == Screen.CONNECTING and c.model.connecting_text.contains("7HQ 4K2"), "Connecting names what is being tried: %s" % c.model.connecting_text)
	_check(c.model.back() and c.model.screen == Screen.START, "ui_cancel while connecting cancels")
	await _frames(40)
	_check(c.model.screen == Screen.START, "a failure that arrives after Cancel is not shown")
	# a lobby that was left by the host
	var h3 := await _hosting("Sam")
	var g3 := await _guest(h3, "Ann")
	await _until(func() -> bool: return _in(g3))
	await h3.model.leave()
	_check(await _until(func() -> bool: return g3.model.screen == Screen.ERROR, 20000), "when the host leaves the joiner gets a screen")
	_check(g3.model.error["message"] != "" and g3.model.error["title"] == OneLobbyMenuText.t("ended_title"), "that says so: %s" % JSON.stringify(g3.model.error))


# ---- an old host (no room layer) ------------------------------------------------------------------------------------------------

func _old_host() -> void:
	var h := await _hosting("Sam")
	h.model.lobby.room._closed = true # it never answers the room's join
	var g := await _guest(h, "Ann")
	_check(g.model.screen == Screen.LOBBY, "a joiner of an old host is in the lobby")
	_check(await _until(func() -> bool: return g.model.lobby.room.supported == false, 12000), "it learns the host has no room layer")
	var rows := g.model.roster_rows()
	_check(rows.size() == 2 and rows.all(func(r: Dictionary) -> bool: return not r["ready"] and not r["can_kick"]), "the plain peer list, no ready marks, no kick or ban")
	_check(not g.model.room_active() and g.model.players_header() == "Players 2", "no room features: %s" % g.model.players_header())
	g.model.toggle_ready()
	_check(g.model.lobby_note == "" and not g.model.counting_down() and g.model.lobby_settings().is_empty(), "ready does nothing and there are no lobby settings")
	await g.model.leave()
	await h.model.leave()


# ---- the rest: relay line, connection check, boot, settings screen ----------------------------------------------------------

func _extras() -> void:
	var r := _rig()
	var m := r.model
	m.open_settings()
	_check(m.screen == Screen.SETTINGS, "settings opens from start")
	_check(not m.save_relay("this is not a relay line") and m.relay_note == OneLobbyMenuText.t("relay_bad_input"), "a bad relay line is not saved and the note says so")
	_check(m.save_relay(RELAY) and m.relay_note == OneLobbyMenuText.t("relay_saved"), "a good relay line is saved")
	var shown := [m.relay_status_text(), m.relay_note, m.settings_note, m.check_verdict, JSON.stringify(m.error), r.client.get_net_log().export(), m.server_text]
	for s: String in shown:
		_check(not s.contains("samuser") and not s.contains("sampass77"), "the relay credentials are not in: %s" % s.left(40))
	_check(m.relay_status_text() == "Relay in use: turn:127.0.0.1:9 <hidden> <hidden>", "only the masked line is shown: %s" % m.relay_status_text())
	m.clear_relay()
	_check(m.relay_status_text() == OneLobbyMenuText.t("relay_none"), "Clear removes it")
	_check(not m.save_server("not a server") and m.settings_note == OneLobbyMenuText.t("server_bad_input"), "a bad lobby server address is not saved")
	_check(m.save_server("wss://lobby.mygame.test/ws") and m.server_text == "wss://lobby.mygame.test/ws", "a good one is, and shows")
	m.check_runner = func(_o: Dictionary) -> Dictionary: return {"udp": "ok", "natType": "symmetric", "relay": "none"}
	await m.run_check()
	_check(m.check_verdict == OneLobbyDiagnose.check_verdict({"udp": "ok", "natType": "symmetric", "relay": "none"})["message"], "the check shows the library's one-line verdict: %s" % m.check_verdict)
	_check(m.check_facts.size() == 3 and "gets out" in m.check_facts[0] and "symmetric" in m.check_facts[1] and "none set" in m.check_facts[2], "and the three facts: %s" % str(m.check_facts))
	_check(m.back() and m.screen == Screen.START and not m.back(), "Back leaves settings; there is nothing behind the start screen")
	# the connection check can be hidden by the blueprint
	var cfg := OneLobbyClient.from_config({"game": {"id": "menu-test"}, "diagnostics": {"showConnectionCheck": false, "logSize": 60, "reportToHost": false}, "players": {"identity": "anonymous"}, "chat": {"text": false}})
	cfg.store = OneLobbyStore.memory()
	cfg.settings_env = {}
	root.add_child(cfg)
	var m2 := OneLobbyMenuModel.new(cfg)
	_check(not m2.connection_check_shown() and not m2.names_allowed(), "the blueprint hides the connection check and the name field")
	_check(cfg.report_to_host == false and cfg.log_size == 60, "from_config applied the diagnostics switches")
	var m3 := OneLobbyMenuModel.new(OneLobbyClient.from_config({"game": {"id": "menu-test"}, "players": {"maxNameLength": 5}}))
	_check(m3.set_name("Abcdefghij") == "Abcde", "names are cut at players.maxNameLength")
	# boot flags: --host and --join
	var bh := _rig()
	_check(bh.model.apply_boot_flags(PackedStringArray(["--host", "--name=Sam"])) == "host" and bh.model.name_text == "Sam", "--host starts hosting at once, with the name")
	_check(await _until(func() -> bool: return bh.model.screen == Screen.LOBBY), "the boot host reaches the lobby")
	var bj := _rig()
	_check(bj.model.apply_boot_flags(PackedStringArray(["--join=" + bh.model.lobby.ip_code, "--name=Ann"])) == "join", "--join joins at once")
	_check(await _until(func() -> bool: return bj.model.screen == Screen.LOBBY), "the boot joiner reaches the lobby")
	_check(_rig().model.apply_boot_flags(PackedStringArray(["--something"])) == "", "no flag, nothing started")
	await bj.model.leave()
	await bh.model.leave()
