extends SceneTree
## The drop-in menu's model (OneLobbyMenuModel) driven with no scene, against real GDScript peers on 127.0.0.1 (direct hosts by
## IP, no Nostr, no internet): host, a second player joins by code, roster, ready, start with the countdown, back to lobby, kick
## with a reason, ban and a refused rejoin, unban, wrong password, a bad code, an old host, saved name and last code as
## defaults, chat, join requests, lobby settings, the connection check's lines (and its once-on-open rule: counted fake runners, never a real network check), and the relay line
## never being shown.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/menu.gd
## Prints "menu: N passed, M failed"; exits 1 on any failure.

const Screen := OneLobbyMenuModel.Screen
const RELAY := "turn:127.0.0.1:9 samuser sampass77"

var _pass := 0
var _fail := 0
var _next_port := 49100
var _all: Array = [] # every rig made, left at the end
var _copied: Array = []


## A finder with no socket: the model's `finder_factory` seam. Counts what the model does to it.
class FakeFinder:
	extends RefCounted
	signal changed(games: Array)
	signal status_changed(status: String, reason: String)
	var status := "idle"
	var games: Array[Dictionary] = []
	var options := {}
	var starts := 0
	var stops := 0
	var asks := 0

	func start() -> String:
		starts += 1
		if status == "idle":
			status = "running"
		return status

	func stop() -> void:
		stops += 1
		status = "idle"
		games = []

	func ask_now() -> void:
		asks += 1

	func put(rows: Array) -> void:
		games.clear()
		for r in rows:
			games.append(r)
		changed.emit(games)


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
	if only == "" or only == "onopen":
		await _on_open()
	if only == "" or only == "lan":
		await _lan()
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
	# --local: a boot flag of the menu itself (direct route, loopback host options, no Nostr, no automatic check)
	var lm := _rig().model
	lm.route = "auto"
	lm.host_options = {"max_players": 2, "nostr": true, "listen_address": "0.0.0.0"}
	_check(lm.apply_boot_flags(PackedStringArray(["--local"])) == "" and lm.local_only and lm.route == "direct", "--local alone starts nothing and makes the menu local, direct route")
	_check(lm.host_options["nostr"] == false and lm.host_options["listen_address"] == "127.0.0.1" and lm.host_options["public_ip"] == "127.0.0.1", "--local: loopback listen address and public IP, Nostr off")
	_check(lm.host_options["max_players"] == 2 and not lm.check_on_open_enabled(), "--local keeps the game's other host options and turns the automatic check off")
	_check(OneLobbyMenuModel.parse_boot_flags(PackedStringArray(["--host", "--local"]))["local"] == true and OneLobbyMenuModel.parse_boot_flags(PackedStringArray(["--host"]))["local"] == false, "parse_boot_flags reads --local")
	var nl := _rig().model
	nl.route = "server"
	nl.host_options = {"nostr": true, "listen_address": "0.0.0.0"}
	nl.apply_boot_flags(PackedStringArray(["--name=Sam"]))
	_check(nl.route == "server" and nl.host_options == {"nostr": true, "listen_address": "0.0.0.0"} and not nl.local_only, "without --local a game's own route and host_options are not touched")
	await bj.model.leave()
	await bh.model.leave()
	# --autostart (tests with no clicks): read next to the other flags; the host starts once a second player is in the room, both copies get game_started
	_check(OneLobbyMenuModel.parse_boot_flags(PackedStringArray(["--autostart"]))["autostart"] == true and OneLobbyMenuModel.parse_boot_flags(PackedStringArray(["--host"]))["autostart"] == false, "parse_boot_flags reads --autostart")
	var ah := _rig()
	_check(ah.model.apply_boot_flags(PackedStringArray(["--host", "--autostart", "--name=Sam"])) == "host" and ah.model.autostart, "--autostart is read beside --host")
	_check(await _until(func() -> bool: return ah.model.screen == Screen.LOBBY), "the autostart host reaches the lobby")
	await _frames(30)
	_check(ah.started == 0, "alone in the room the autostart host starts nothing")
	var aj := _rig()
	aj.model.apply_boot_flags(PackedStringArray(["--join=" + ah.model.lobby.ip_code, "--autostart", "--name=Ann"]))
	_check(await _until(func() -> bool: return ah.started == 1 and aj.started == 1), "a second player joined: both copies got game_started with no Start click")
	await _frames(60)
	_check(ah.started == 1 and aj.started == 1, "the match is started once, not again")
	await aj.model.leave()
	await ah.model.leave()


# ---- the connection check when the menu opens (no network: every runner here is a fake) -------------------------------------

## A model whose runner is a counted fake. `cfg` is the diagnostics section of an onelobby.json ({} for the defaults);
## `answer` what the fake finds: "cone" (good), "symmetric" (likely to fail), "blocked", "relay_refused", "relay_works".
## `gate` (when given) holds the runner until gate[0] is true. `state.runs` counts the runs.
func _open_rig(cfg: Dictionary, answer := "cone", gate: Array = []) -> Dictionary:
	var c: OneLobbyClient
	if cfg.is_empty():
		c = OneLobbyClient.from_config({"game": {"id": "menu-test"}})
	else:
		c = OneLobbyClient.from_config({"game": {"id": "menu-test"}, "diagnostics": cfg})
	c.store = OneLobbyStore.memory()
	c.settings_env = {}
	c.log_path = ""
	c.lobby_server = "ws://127.0.0.1:1/ws"
	root.add_child(c)
	var m := OneLobbyMenuModel.new(c)
	m.route = "direct"
	m.host_options = {"name": "menu", "max_players": 4, "tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1",
		"udp_port_range": [_next_port, _next_port + 15], "nostr": false, "room": {"countdown_seconds": 1}}
	_next_port += 20
	var state := {"runs": 0, "done": 0}
	m.check_runner = func(_o: Dictionary) -> Dictionary:
		state["runs"] += 1
		while not gate.is_empty() and not gate[0]:
			await process_frame
		state["done"] += 1
		match answer:
			"symmetric":
				return {"udp": "ok", "natType": "symmetric", "relay": "none"}
			"blocked":
				return {"udp": "blocked", "natType": "unknown", "relay": "none"}
			"relay_refused":
				return {"udp": "ok", "natType": "cone", "relay": "refused"}
			"relay_works":
				return {"udp": "blocked", "natType": "unknown", "relay": "ok"}
		return {"udp": "ok", "natType": "cone", "relay": "none"}
	return {"client": c, "model": m, "state": state}


func _on_open() -> void:
	# the default: once, when the start screen is first shown
	var d := _open_rig({})
	var m: OneLobbyMenuModel = d["model"]
	_check(m.check_on_open_enabled(), "check on open is on by default")
	_check(d["state"]["runs"] == 0 and m.check_verdict == "", "nothing runs before the start screen is shown")
	await m.start_shown()
	_check(d["state"]["runs"] == 1 and m.check_verdict_id == "good" and not m.check_running, "the default runs the check once on open")
	_check(m.check_facts.size() == 3 and m.start_check_line() == "", "the settings lines are filled in, the start screen says nothing when all is well")
	# coming back to the start screen (from settings, from a lobby) does not run it again
	m.open_settings()
	_check(m.back(), "settings closes")
	await m.start_shown()
	await m.host()
	await _until(func() -> bool: return m.room_active())
	await m.leave()
	await m.start_shown()
	_check(d["state"]["runs"] == 1, "coming back to the start screen does not run it again (%d runs)" % d["state"]["runs"])
	await m.run_check()
	_check(d["state"]["runs"] == 2, "the button still runs it on demand")
	d["client"].queue_free()

	# the start screen line: the verdict sentence for each warning, nothing for the rest
	for case: Array in [["symmetric", "likely_fail"], ["blocked", "blocked"], ["relay_refused", "relay_refused"], ["cone", "good"], ["relay_works", "relay_works"]]:
		var w := _open_rig({}, case[0])
		await w["model"].start_shown()
		var line: String = w["model"].start_check_line()
		var warn: bool = ["likely_fail", "blocked", "relay_refused"].has(case[1])
		_check(w["model"].check_verdict_id == case[1] and line == (w["model"].check_verdict if warn else ""), "%s: the start line is %s: '%s'" % [case[1], "the verdict sentence" if warn else "empty", line])
		w["client"].queue_free()
	var likely := _open_rig({}, "symmetric")
	await likely["model"].start_shown()
	_check(likely["model"].start_check_line() == "Direct connections: likely to fail. A relay is recommended.", "the start line is the library's own sentence: %s" % likely["model"].start_check_line())
	likely["client"].queue_free()

	# checkOnOpen false: nothing until the button
	var off := _open_rig({"checkOnOpen": false})
	await off["model"].start_shown()
	_check(not off["model"].check_on_open_enabled() and off["state"]["runs"] == 0 and off["model"].connection_check_shown(), "checkOnOpen false: nothing runs on open, the button stays")
	await off["model"].run_check()
	_check(off["state"]["runs"] == 1, "checkOnOpen false: the button runs it")
	off["client"].queue_free()

	# showConnectionCheck false: no button and no automatic run
	var hidden := _open_rig({"showConnectionCheck": false})
	await hidden["model"].start_shown()
	_check(hidden["state"]["runs"] == 0 and not hidden["model"].check_on_open_enabled(), "showConnectionCheck false: nothing runs on open")
	hidden["client"].queue_free()

	# --local (nothing may leave this PC): no automatic run
	var loc := _open_rig({})
	loc["model"].local_only = OneLobbyMenuModel.args_say_local(PackedStringArray(["--host", "--local"]))
	await loc["model"].start_shown()
	_check(loc["state"]["runs"] == 0 and not OneLobbyMenuModel.args_say_local(PackedStringArray(["--host"])), "--local: the check does not run by itself")
	loc["client"].queue_free()

	# not on a screen that is not the start screen; the first time the start screen is shown, it runs
	var late := _open_rig({})
	late["model"].open_settings()
	await late["model"].start_shown()
	_check(late["state"]["runs"] == 0, "start_shown while another screen is up does nothing")
	late["model"].back()
	await late["model"].start_shown()
	_check(late["state"]["runs"] == 1, "the first time the start screen is shown it runs")
	late["client"].queue_free()

	# a run in progress is never started twice (button, then open, then button)
	var gate := [false]
	var busy := _open_rig({}, "cone", gate)
	var bm: OneLobbyMenuModel = busy["model"]
	bm.run_check()
	bm.start_shown()
	bm.run_check()
	await _frames(3)
	_check(busy["state"]["runs"] == 1 and bm.check_running, "a run in progress is not started twice (%d runs)" % busy["state"]["runs"])
	gate[0] = true
	await _until(func() -> bool: return not bm.check_running)
	busy["client"].queue_free()

	# Host pressed while the check is still running: the lobby opens, the late answer only fills the lines
	gate = [false]
	var h := _open_rig({}, "symmetric", gate)
	var hm: OneLobbyMenuModel = h["model"]
	hm.start_shown()
	await _frames(2)
	_check(hm.check_running and hm.start_check_line() == "", "while it runs the start screen says nothing")
	hm.set_name("Sam")
	await hm.host()
	_check(await _until(func() -> bool: return hm.room_active()), "Host works while the check is running")
	_check(hm.check_running, "and the check is still running")
	gate[0] = true
	_check(await _until(func() -> bool: return not hm.check_running), "the check finishes later")
	_check(hm.screen == Screen.LOBBY and hm.lobby != null and hm.check_verdict_id == "likely_fail" and hm.error.is_empty(), "the late answer only filled the lines: screen %d, error %s" % [hm.screen, str(hm.error)])
	await hm.leave()
	_check(hm.start_check_line() == hm.check_verdict, "back on the start screen the late warning shows")
	h["client"].queue_free()
	await _frames(2)


# ---- LAN games: the Browse screen's second list, with a fake finder (no socket) -------------------------------------------------

func _lan_row(address := "192.168.1.20", port := 47810, name := "Sam's game", host := "Sam", players := 2, cap := 4, pw := false, same := true) -> Dictionary:
	return {"address": address, "port": port, "name": name, "host_name": host, "players": players, "max_players": cap, "has_password": pw,
		"same_version": same, "net_version": "1", "last_seen_ms": 0}


## A model with a blueprint (hosting.server / hosting.lan as given) and a fake finder; `made` collects every finder the model asked for.
func _lan_model(server: bool, lan: bool, made: Array, clock: Array) -> OneLobbyMenuModel:
	var cfg := {"game": {"id": "menu-test"}, "engine": "godot-gdscript", "diagnostics": {"checkOnOpen": false},
		"hosting": {"direct": true, "server": server, "lan": lan, "lobbyServer": "ws://127.0.0.1:1/ws"}}
	var c := OneLobbyClient.from_config(cfg)
	c.store = OneLobbyStore.memory()
	c.settings_env = {}
	c.log_path = ""
	c.lobby_server = "ws://127.0.0.1:1/ws"
	root.add_child(c)
	var m := OneLobbyMenuModel.new(c)
	m.finder_factory = func(o: Dictionary) -> FakeFinder:
		var f := FakeFinder.new()
		f.options = o
		made.append(f)
		return f
	m.now_fn = func() -> int: return clock[0]
	return m


func _lan() -> void:
	# availability: all four combinations of (lobby server, LAN)
	var made: Array = []
	var clock := [0]
	var cases := [[false, false, false, false, "online"], [true, false, true, false, "online"], [false, true, false, true, "lan"], [true, true, true, true, "online"]]
	for k in cases:
		var m := _lan_model(k[0], k[1], made, clock)
		_check(m.can_browse() == k[2] and m.lan_available() == k[3] and m.browse_available() == (k[2] or k[3]), "lan: server %s, lan %s -> online %s, lan %s, Browse %s" % [k[0], k[1], m.can_browse(), m.lan_available(), m.browse_available()])
		_check(m.browse_tabs_shown() == (k[2] and k[3]), "lan: the tab bar shows only with both lists (%s)" % m.browse_tabs_shown())
		_check(m.shown_list() == k[4] or not m.browse_available(), "lan: the first list shown is %s (got %s)" % [k[4], m.shown_list()])
		m.client.queue_free()
	_check(made.is_empty(), "lan: no finder was made by any of that (%d)" % made.size())
	# a game with no blueprint: the menu's own switch, default off
	var plain := OneLobbyMenuModel.new(OneLobbyClient.new())
	root.add_child(plain.client)
	_check(not plain.lan and not plain.lan_available(), "lan: with no blueprint LAN is off by default")
	plain.lan = true
	plain.route = "direct"
	_check(plain.lan_available() and plain.browse_available() and not plain.browse_tabs_shown() and plain.shown_list() == "lan", "lan: with no blueprint `lan` turns the LAN list on (a direct route has no lobby server list, so no tab bar)")
	plain.client.queue_free()

	# only LAN available: Browse opens the finder, the title says which list, Back closes it, once each
	made.clear()
	var m := _lan_model(false, true, made, clock)
	m.apply_local()
	_check(m.browse_title() == "LAN games" and m.shown_list() == "lan", "lan only: the title says LAN games")
	_check(not m.finder_running() and made.is_empty(), "lan only: before Browse there is no finder")
	await m.open_browse()
	_check(m.screen == Screen.BROWSE and made.size() == 1 and made[0].starts == 1 and m.finder_running(), "lan only: Browse starts one finder")
	_check(made[0].options.get("targets", PackedStringArray()) == PackedStringArray(["127.0.0.1"]), "--local: the finder's targets are [127.0.0.1] (%s)" % str(made[0].options))
	_check(m.lan_status_text() == "Looking for games on your network...", "the looking sentence shows at once")
	clock[0] = 2900
	m.tick()
	_check(m.lan_status_text() == "Looking for games on your network...", "still looking before 3 seconds")
	clock[0] = 3000
	_check(m.lan_status_text().begins_with("No games found on your network.") and "address" in m.lan_status_text(), "after 3 seconds: nothing found, and the host can read out the address")
	var f: FakeFinder = made[0]
	f.put([_lan_row(), _lan_row("192.168.1.31", 47811, "<b>Bold</b> game", "Ann", 4, 4, true, false)])
	var rows := m.lan_rows()
	_check(rows.size() == 2 and rows[0]["text"] == "Sam's game (Sam) 2/4" and rows[0]["lock"] == "" and rows[0]["can_join"] and rows[0]["note"] == "", "a row: lobby name, host name, players: %s" % str(rows[0]))
	_check(rows[1]["text"] == "<b>Bold</b> game (Ann) 4/4" and rows[1]["lock"] == "Needs a password", "the second row, password mark, name kept as text: %s" % rows[1]["text"])
	_check(not rows[1]["can_join"] and rows[1]["note"] == "You and the host are running different versions of the game.", "the other-version row cannot be joined and says why: %s" % rows[1]["note"])
	_check(m.lan_status_text() == "", "no status line while there are rows")
	f.put([_lan_row("192.168.1.31", 47811), _lan_row()])
	_check(m.lan_rows()[0]["address"] == "192.168.1.31", "rows keep the finder's order (it is not re-sorted)")
	m.refresh_browse()
	_check(f.asks == 1 and made.size() == 1, "Refresh asks the LAN now (and makes no second finder)")
	m.back()
	_check(m.screen == Screen.START and f.stops == 1 and not m.finder_running() and m.lan_rows().is_empty(), "Back stops the finder, once")
	await m.open_browse()
	_check(made.size() == 2 and made[1].starts == 1, "opening Browse again makes a new finder (%d made)" % made.size())
	m.back()
	_check(made[1].stops == 1, "and Back stops that one too")

	# the finder's own states
	made.clear()
	m.shutdown()
	await m.open_browse()
	f = made[0]
	f.status = "socket_failed"
	f.changed.emit(f.games)
	_check(m.lan_status_text() == "Couldn't look for games on your network. Ask the host for their address and type it in the join box.", "socket_failed has its sentence")
	f.status = "off"
	_check(m.lan_status_text() == "LAN games are switched off in this game.", "off has its sentence")
	m.back()

	# a join from a row: the join path gets address:port, the finder stops, a password is passed on
	made.clear()
	await m.open_browse()
	f = made[0]
	f.put([_lan_row("127.0.0.1", 49999, "Sam's game", "Sam", 1, 4, true), _lan_row("127.0.0.1", 49998, "Old", "Bob", 1, 4, false, false)])
	m.set_lan_password("pw1")
	m.join_lan(1)
	_check(m.screen == Screen.BROWSE and m.finder_running(), "a row of another version cannot be joined: nothing happens")
	m.join_lan(0)
	_check(m.screen == Screen.CONNECTING and f.stops == 1 and not m.finder_running(), "a join stops the finder at once (screen %s, stops %d)" % [m.screen_name(), f.stops])
	_check(m.join_text == "127.0.0.1:49999" and m.password_text == "pw1", "the join path got '%s' and the typed password" % m.join_text)
	m.cancel_connecting()
	m.client.queue_free()

	# both lists: the tab bar; the screen opens on the tab used last in this run; each switch starts or stops the finder once
	made.clear()
	var both := _lan_model(true, true, made, clock)
	_check(both.browse_title() == "Games to join", "both lists: the title is the plain one")
	await both.open_browse()
	_check(both.shown_list() == "online" and made.is_empty(), "both: the first time it opens on Online, with no finder")
	await both.set_browse_tab("lan")
	_check(both.shown_list() == "lan" and made.size() == 1 and made[0].starts == 1, "the LAN tab starts one finder")
	await both.set_browse_tab("lan")
	_check(made.size() == 1 and made[0].starts == 1, "picking the same tab again does nothing")
	await both.set_browse_tab("online")
	_check(made[0].stops == 1 and not both.finder_running(), "the Online tab stops it, once")
	await both.set_browse_tab("lan")
	both.back()
	_check(made.size() == 2 and made[1].stops == 1 and both.screen == Screen.START, "Back from the LAN tab stops the finder")
	await both.open_browse()
	_check(both.shown_list() == "lan" and made.size() == 3 and made[2].starts == 1, "Browse opens on the tab used last (LAN)")
	both.shutdown()
	_check(made[2].stops == 1 and not both.finder_running() and both.screen == Screen.BROWSE, "shutdown (the menu left the tree) stops it; the screen stays")
	both.shutdown()
	_check(made[2].stops == 1, "a second shutdown stops nothing again")
	both.resume()
	_check(both.finder_running() and made.size() == 4, "resume (the menu shown again) looks again")
	both._set_screen(Screen.PLAYING)
	_check(made[3].stops == 1 and not both.finder_running(), "a game starting (the screen changes) stops it")
	both.client.queue_free()

	# the host side, no blueprint: the menu's switch reaches host_direct's options
	var hh := _lan_model(false, true, made, clock)
	_check(bool(hh.client.config.direct_options("Sam")["lan"]), "with a blueprint hosting.lan reaches the direct host's options")
	hh.client.queue_free()
