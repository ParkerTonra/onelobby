class_name OneLobbyMenuModel
extends RefCounted
## The drop-in menu's brain: which screen is showing and every decision behind it. No nodes: it takes its OneLobbyClient by
## injection, so a test (or your own UI) drives it without a scene. OneLobbyMenu (menu.gd) only draws this and forwards input.
##
##     var m := OneLobbyMenuModel.new(client)
##     m.set_join_text("7HQ 4K2")
##     await m.join()               # screen: CONNECTING, then LOBBY (or ERROR with a plain sentence)
##     m.toggle_ready()
##
## The client must be in the scene tree (it pumps itself, or the menu does). Calls that can wait are coroutines. The model
## emits `changed` after any state change. Texts come from OneLobbyMenuText.

signal changed
## The lobby's phase went to "in_game" (the host started, or a late join into a running game).
signal game_started(lobby: OneLobbyLobby)
## The phase went back to "lobby" after a game.
signal returned_to_lobby(lobby: OneLobbyLobby)
## The player left the lobby on purpose.
signal left

enum Screen { START, CONNECTING, LOBBY, ERROR, SETTINGS, BROWSE, PLAYING }

const SCREEN_NAMES := ["start", "connecting", "lobby", "error", "settings", "browse", "playing"]
const CHAT_KEEP := 100

var client: OneLobbyClient
var screen := Screen.START
var lobby: OneLobbyLobby = null

## "auto": the blueprint decides when the client has one (a lobby server when hosting.server is true, else a direct lobby);
## without one, a lobby server when `client.lobby_server` is set. "direct": always a direct lobby. "server": the lobby server.
var route := "auto"
## Options passed to client.host() / host_direct() and join() / join_direct() (a test gives loopback addresses here).
var host_options := {}
var join_options := {}
## Base address of an invite link ("https://game.example/play"). Optional: with it (and a lobby-server code) the copied invite
## sentence ends with the link.
var invite_base := ""
## The query key of an invite link.
var invite_param := "join"
## Where Save logs writes.
var logs_path := "user://onelobby-menu-log.txt"
## Called with the text to copy. Default: DisplayServer.clipboard_set.
var clipboard := Callable()
## Runs the connection check: gets `check_options`, returns what client.check_connection returns. Default: the client's own.
var check_runner := Callable()
var check_options := {}

# what the screens show
var name_text := ""
var join_text := ""
var password_text := ""
var start_note := ""
var connecting_text := ""
var error := {} ## {title, message, hint, code, removed, ban, reason}
var lobby_note := ""
var removal := {}
var chat_lines: Array = [] ## [{peer_id, name, text}]
var requests: Array = [] ## [{peer_id, name}]
var browse_items: Array = []
var browse_status := ""
## LAN games (spec/lan-discovery.md). `lan`: the switch for a game with no blueprint (with one, hosting.lan decides). `browse_tab`:
## "online" or "lan", the list the Browse screen opened on last in this run (first time: Online).
var lan := false
var browse_tab := "online"
var lan_password_text := ""
## Makes the finder: Callable(options) -> an object like OneLobbyLanFinder (a test passes a fake). Default: client.lan_finder().
var finder_factory := Callable()
var now_fn := Callable(Time, "get_ticks_msec")
var settings_note := ""
var relay_note := ""
var server_text := ""
var check_verdict := "" ## one line, "" before a check
var check_facts: Array = [] ## three lines
var check_running := false
var log_note := ""

## True when nothing may leave this PC (`--local` after `--`, see `args_say_local`): the menu is local. `apply_local` sets it,
## and with it the direct route and loopback host options; the connection check never runs on its own while it is set.
var local_only := false

var _finder = null
var _lan_empty_since := -1
var _lan_status_shown := ""
var _ticket := 0
var _game_started := false


func _init(p_client: OneLobbyClient = null) -> void:
	client = p_client
	if client != null:
		load_defaults()


## Reads the saved name, the last code and the lobby server into the start and settings screens.
func load_defaults() -> void:
	var s: Dictionary = client.settings.effective()
	name_text = str(s["name"])
	var last := str(s["last_code"])
	join_text = OneLobbyJoinCode.display(last) if last.length() == OneLobbyJoinCode.LENGTH else last
	server_text = client.effective_server()


func screen_name() -> String:
	return SCREEN_NAMES[screen]


# ---- what the blueprint (or its absence) switches -------------------------------------------------------------------

func _cfg() -> OneLobbyConfig:
	return client.config if client != null and client.config != null and client.config.ok else null


## False for a blueprint with players.identity "anonymous": no name field.
func names_allowed() -> bool:
	var c := _cfg()
	return c == null or str(c.players.get("identity", "name")) != "anonymous"


func max_name_length() -> int:
	var c := _cfg()
	return int(c.players.get("max_name_length", 24)) if c != null else 24


## Browse needs a lobby server address (and a blueprint that uses one).
func can_browse() -> bool:
	var c := _cfg()
	if c != null and not bool(c.hosting.get("server", false)):
		return false
	return route != "direct" and not client.effective_server().is_empty()


## True when this game has LAN discovery on (blueprint `hosting.lan`; with no blueprint, the menu's `lan`) and the client can open UDP
## (a web export cannot).
func lan_available() -> bool:
	if OS.has_feature("web"):
		return false
	var c := _cfg()
	return bool(c.hosting.get("lan", false)) if c != null else lan


## The Browse button shows when the lobby server list or the LAN list is available.
func browse_available() -> bool:
	return can_browse() or lan_available()


## True when the Browse screen shows the two-button tab bar (both lists are available).
func browse_tabs_shown() -> bool:
	return can_browse() and lan_available()


## "online" or "lan": the list the Browse screen shows now.
func shown_list() -> String:
	if lan_available() and (not can_browse() or browse_tab == "lan"):
		return "lan"
	return "online"


func connection_check_shown() -> bool:
	var c := _cfg()
	return c == null or bool(c.diagnostics.get("show_connection_check", true))


## True when `--local` is among the command-line arguments (host and join on 127.0.0.1 only, nothing leaves this PC).
static func args_say_local(args: PackedStringArray) -> bool:
	return "--local" in args


func chat_shown() -> bool:
	return lobby != null and lobby.chat.enabled


func approve_joins_on() -> bool:
	var c := _cfg()
	return c != null and bool(c.lobby.get("approve_joins", false))


## Copy invite is always offered while a lobby is open.
func invite_available() -> bool:
	return lobby != null


func lobby_is_direct() -> bool:
	return lobby != null and lobby._direct


## True when the host answered with the room layer (ready, start, kick and ban work). False for an old host or before its answer.
func room_active() -> bool:
	return lobby != null and lobby.room.supported == true


func is_host() -> bool:
	return lobby != null and lobby.is_host


# ---- the start screen -----------------------------------------------------------------------------------------------

## Cleans a name the way the room does and remembers it as typed; returns the cleaned text.
func set_name(text: String) -> String:
	name_text = OneLobbySettings.clean_name(text, max_name_length())
	return name_text


## Keeps what is typed in the join field tidy: a code is upper-cased and stripped of stray characters, an address or a link is kept.
func set_join_text(text: String) -> String:
	join_text = clean_join_text(text)
	return join_text


func set_password(text: String) -> void:
	password_text = text.left(64)


static func clean_join_text(text: String) -> String:
	var t := text.lstrip(" \t\r\n")
	for ch in [":", "/", ".", "?", "#", "=", "@"]:
		if t.contains(ch):
			return t
	var out := ""
	for ch in t.to_upper():
		var c := ch.unicode_at(0)
		if ch == " " or ch == "-" or (c >= 0x30 and c <= 0x39) or (c >= 0x41 and c <= 0x5A):
			out += ch
	return out.left(40)


## What a join field holds: {kind: "lobby" | "direct" | "address" | "", value}. A link yields its lobby code. A pasted invite
## sentence ("Join my game in Fortress: code 7HQ 4K2") yields its code: the words after its "code" marker first, then the whole
## text as one code, then the words scanned from the END (a game title can look like a code, so the title is never tried first).
static func parse_join(text: String) -> Dictionary:
	var t := text.strip_edges()
	if t.is_empty():
		return {"kind": "", "value": ""}
	var words: Array = []
	for w in t.replace("\t", " ").replace("\n", " ").replace("\r", " ").split(" ", false):
		var c := _trim_token(w)
		if c != "":
			words.append(c)
	if words.size() > 1:
		for i in words.size() - 1:
			if str(words[i]).to_lower() == "code":
				var got := _after_marker(words, i + 1)
				if got["kind"] != "":
					return got
				break
	var whole := _parse_one(t)
	if whole["kind"] != "" or words.size() < 2:
		return whole
	var i := words.size() - 1
	while i >= 0:
		if i >= 1 and _is_group_pair(words[i - 1], words[i]):
			var pair := _parse_one(str(words[i - 1]) + " " + str(words[i]))
			if pair["kind"] == "lobby":
				return pair
		var one := _parse_one(str(words[i]))
		if one["kind"] != "":
			return one
		i -= 1
	return whole


## One field's worth of text: a lobby code, a direct code, an address or a link.
static func _parse_one(t: String) -> Dictionary:
	if t.contains("?") or t.contains("://") or t.contains("#"):
		var from_link := OneLobbyInvite.parse(t)
		if from_link != "":
			return {"kind": "lobby", "value": from_link}
	var six := OneLobbyJoinCode.normalize(t)
	if six != "":
		return {"kind": "lobby", "value": six}
	if OneLobbyJoinCode.normalize_dc1(t) != "":
		return {"kind": "direct", "value": t}
	if not OneLobbyJoinCode.parse_address(t).has("error"):
		return {"kind": "address", "value": t}
	return {"kind": "", "value": t}


## Strips quotes, brackets and trailing punctuation around a word of a pasted sentence (a link keeps its inner marks).
static func _trim_token(w: String) -> String:
	var a := 0
	var b := w.length()
	const EDGE := "\"'`()[]{}<>.,;:!“”‘’"
	while a < b and EDGE.contains(w[a]):
		a += 1
	while b > a and EDGE.contains(w[b - 1]):
		b -= 1
	return w.substr(a, b - a)


## Two words shaped like the lobby screen's grouping ("7HQ" "4K2"): three characters each, so ordinary words ("game in") are not taken.
static func _is_group_pair(a: String, b: String) -> bool:
	return a.length() == 3 and b.length() == 3


## The code right after the "code" marker: one word, or two ("7HQ" "4K2", as the lobby screen groups it).
static func _after_marker(words: Array, at: int) -> Dictionary:
	var one := _parse_one(str(words[at]))
	if one["kind"] != "":
		return one
	if at + 1 < words.size() and _is_group_pair(words[at], words[at + 1]):
		var two := _parse_one(str(words[at]) + " " + str(words[at + 1]))
		if two["kind"] == "lobby":
			return two
	return {"kind": "", "value": ""}


## The boot flags the menu acts on at once: --host, --join=<code>, --name=<name> and --local, as {host, join, name, local}.
static func parse_boot_flags(args: PackedStringArray) -> Dictionary:
	var out := {"host": false, "join": "", "name": "", "local": args_say_local(args)}
	for a in args:
		if a == "--host":
			out["host"] = true
		elif a.begins_with("--join="):
			out["join"] = a.substr(7)
		elif a.begins_with("--name="):
			out["name"] = a.substr(7)
	return out


## Saves the name (when this game has names) and gives it to the client.
func commit_name() -> void:
	if not names_allowed():
		return
	client.settings.save({"name": name_text})
	client.display_name = name_text if name_text != "" else "Player"


func note_invited() -> void:
	start_note = OneLobbyMenuText.t("start_invited")
	changed.emit()


func host() -> void:
	if screen != Screen.START:
		return
	commit_name()
	var t := _begin(OneLobbyMenuText.t("connecting_host"))
	var o := host_options.duplicate()
	if password_text != "":
		o["password"] = password_text
	var l: OneLobbyLobby
	var use_direct := route == "direct" or (route == "auto" and client.config == null and client.lobby_server.is_empty())
	if use_direct:
		if client.config == null and lan and not o.has("lan"):
			o["lan"] = true # no blueprint: the menu's own switch (with one, direct_options carries hosting.lan)
		l = await client.host_direct(o)
	else:
		l = await client.host(o)
	_connected(t, l)


func join() -> void:
	if screen != Screen.START:
		return
	var p := parse_join(join_text)
	if p["kind"] == "":
		_show_error(OneLobbyFriendly.describe_error("bad_code"), "bad_code")
		return
	commit_name()
	var shown := OneLobbyJoinCode.display(str(p["value"])) if p["kind"] == "lobby" else str(p["value"])
	var line := OneLobbyMenuText.t("connecting_join_address") if p["kind"] == "address" else OneLobbyMenuText.t("connecting_join", [shown])
	var t := _begin(line)
	var o := join_options.duplicate()
	if password_text != "":
		o["password"] = password_text
	var l: OneLobbyLobby
	if p["kind"] == "lobby":
		l = await client.join(str(p["value"]), o)
	else:
		l = await client.join_direct(str(p["value"]), o)
	_connected(t, l)


func _begin(text: String) -> int:
	_ticket += 1
	connecting_text = text
	error = {}
	start_note = ""
	_set_screen(Screen.CONNECTING)
	return _ticket


func _connected(ticket: int, l: OneLobbyLobby) -> void:
	if ticket != _ticket:
		# the player cancelled while it waited: a lobby that still arrived is left at once
		if l != null:
			l.leave()
		return
	if l == null:
		_show_error(OneLobbyFriendly.describe_error(client.last_error), str(client.last_error.get("code", "")))
		return
	_attach(l)
	_game_started = false
	lobby_note = ""
	_set_screen(Screen.LOBBY)
	if l.phase == "in_game":
		_start_playing()


# ---- the lobby ------------------------------------------------------------------------------------------------------

func _attach(l: OneLobbyLobby) -> void:
	lobby = l
	removal = {}
	chat_lines = []
	requests = []
	var r := l.room
	var same := func() -> bool: return lobby == l
	r.changed.connect(func() -> void: if same.call(): changed.emit())
	r.bans_changed.connect(func() -> void: if same.call(): changed.emit())
	r.became_unsupported.connect(func() -> void: if same.call(): changed.emit())
	r.became_supported.connect(func() -> void: if same.call(): changed.emit())
	r.removed.connect(func(info: Dictionary) -> void: if same.call(): _on_removed(info))
	l.phase_changed.connect(func(p: String) -> void: if same.call(): _on_phase(p))
	l.session_ended.connect(func(reason: String) -> void: if same.call(): _on_ended(reason))
	l.join_requested.connect(func(peer: Dictionary) -> void:
		if same.call():
			requests.append({"peer_id": int(peer["peer_id"]), "name": str(peer["name"])})
			changed.emit())
	l.peer_joined.connect(func(_p: Dictionary) -> void: if same.call(): changed.emit())
	l.peer_left.connect(func(_p: Dictionary, _why: String) -> void: if same.call(): changed.emit())
	l.peer_ready.connect(func(_p: Dictionary) -> void: if same.call(): changed.emit())
	l.host_changed.connect(func(_id: int) -> void: if same.call(): changed.emit())
	l.peer_renamed.connect(func(_p: Dictionary, _old: String) -> void: if same.call(): changed.emit())
	l.chat.message.connect(func(line: Dictionary) -> void:
		if same.call():
			chat_lines.append({"peer_id": int(line.get("peer_id", 0)), "name": str(line.get("name", "")), "text": str(line.get("text", ""))})
			if chat_lines.size() > CHAT_KEEP:
				chat_lines = chat_lines.slice(chat_lines.size() - CHAT_KEEP)
			changed.emit())


func _on_phase(p: String) -> void:
	if p == "in_game":
		_start_playing()
	elif p == "lobby" and screen == Screen.PLAYING:
		_game_started = false
		_set_screen(Screen.LOBBY)
		returned_to_lobby.emit(lobby)


func _start_playing() -> void:
	if _game_started:
		return
	_game_started = true
	_set_screen(Screen.PLAYING)
	game_started.emit(lobby)


## The host removed this player: the host's reason, or the default sentence of the code.
func _on_removed(info: Dictionary) -> void:
	removal = info
	var code := str(info.get("code", "kicked"))
	var banned := bool(info.get("ban", false)) or code == "banned"
	var d := OneLobbyFriendly.describe_error(code)
	var reason := str(info.get("reason", ""))
	_show_error({"message": reason if reason != "" else d["message"], "hint": d.get("hint", "")}, code, true)
	error["ban"] = bool(info.get("ban", false))
	error["reason"] = reason
	error["title"] = OneLobbyMenuText.t("banned_title") if banned else OneLobbyMenuText.t("removed_title")
	changed.emit()


func _on_ended(reason: String) -> void:
	if not removal.is_empty():
		return # the removal screen already says why
	var d: Dictionary
	match reason:
		"host_left":
			d = {"message": OneLobbyMenuText.t("host_left"), "hint": OneLobbyMenuText.t("host_left_hint")}
		"ice_failed":
			d = OneLobbyFriendly.describe_error(client.last_error if str(client.last_error.get("code", "")) == "ice_failed" else "ice_failed")
		_:
			d = OneLobbyFriendly.describe_error(reason)
	_show_error(d, reason)
	error["title"] = OneLobbyMenuText.t("ended_title")


## Roster rows: {id, name, me, host, ready, spectator, reconnecting, ping_ms, can_kick}.
func roster_rows() -> Array:
	var rows: Array = []
	if lobby == null:
		return rows
	var active := room_active()
	for e: Dictionary in lobby.room.entries():
		var id := int(e["id"])
		var me := id == lobby.local_peer_id
		rows.append({
			"id": id, "name": str(e["name"]), "me": me, "host": id == lobby.host_peer_id,
			"ready": active and bool(e.get("ready", false)) and e["role"] == "player",
			"spectator": e["role"] == "spectator",
			"reconnecting": str(e.get("status", "connected")) == "reconnecting",
			"ping_ms": 0 if me else lobby.ping_ms(id),
			"can_kick": active and lobby.is_host and not me,
		})
	return rows


func players_header() -> String:
	if lobby == null:
		return ""
	if not room_active():
		return OneLobbyMenuText.t("players_header_plain", [lobby.room.entries().size()])
	var cap := int(lobby.room.settings().get("maxPlayers", 0))
	var n := lobby.room.players().size()
	return OneLobbyMenuText.t("players_header", [n, cap]) if cap > 0 else OneLobbyMenuText.t("players_header_plain", [n])


## The marks of a row as one line ("Host, Ready").
func row_marks(row: Dictionary) -> String:
	var marks: PackedStringArray = []
	if row["host"]:
		marks.append(OneLobbyMenuText.t("mark_host"))
	if row["spectator"]:
		marks.append(OneLobbyMenuText.t("mark_spectator"))
	if row["ready"]:
		marks.append(OneLobbyMenuText.t("mark_ready"))
	if row["reconnecting"]:
		marks.append(OneLobbyMenuText.t("mark_reconnecting"))
	return ", ".join(marks)


func code_text() -> String:
	if lobby == null:
		return ""
	var c := lobby.code
	return OneLobbyJoinCode.display(c) if c.length() == OneLobbyJoinCode.LENGTH else c


## The invite sentence: "Join my game in <title>: code 7HQ 4K2" (no title: "Join my game: code 7HQ 4K2"), then a space and the
## invite link when `invite_base` is set and the code is a lobby-server code. The code is written as the lobby screen shows it.
func invite_text() -> String:
	if lobby == null:
		return ""
	var title := client.config.title if client.config != null and client.config.ok else ""
	var text := OneLobbyMenuText.t("invite_sentence", [title, code_text()]) if title != "" else OneLobbyMenuText.t("invite_sentence_untitled", [code_text()])
	if invite_base != "" and not lobby_is_direct():
		var link := OneLobbyInvite.make(lobby.code, invite_base, invite_param)
		if link != "":
			text += " " + link
	return text


func countdown_text() -> String:
	if lobby == null:
		return ""
	var cd := lobby.room.countdown()
	if cd.is_empty():
		return ""
	return OneLobbyMenuText.t("countdown", [ceili(float(cd["remaining"]) / 1000.0)])


func counting_down() -> bool:
	return lobby != null and not lobby.room.countdown().is_empty()


func me_ready() -> bool:
	return lobby != null and bool(lobby.room.me().get("ready", false))


func me_is_player() -> bool:
	return lobby != null and str(lobby.room.me().get("role", "player")) == "player"


func copy_code() -> bool:
	return _copy(code_text())


func copy_invite() -> bool:
	var text := invite_text()
	return text != "" and _copy(text)


func _copy(text: String) -> bool:
	if clipboard.is_valid():
		clipboard.call(text)
	else:
		DisplayServer.clipboard_set(text)
	return true


func toggle_ready() -> void:
	if room_active():
		_note_code(lobby.room.toggle_ready())


## Host: start. With the room layer: the countdown, then everyone's phase changes. An old host (no room layer) starts at once.
func start_game() -> void:
	if lobby == null or not lobby.is_host:
		return
	if room_active():
		_note_code(lobby.room.start())
	else:
		lobby.start()


func cancel_countdown() -> void:
	if room_active() and lobby.is_host:
		lobby.room.cancel_countdown()


func kick(peer_id: int, reason: String = "") -> void:
	if room_active() and lobby.is_host:
		_note_code(lobby.room.kick(peer_id, {"reason": reason} if reason.strip_edges() != "" else {}))


func ban(peer_id: int, reason: String = "") -> void:
	if room_active() and lobby.is_host:
		_note_code(lobby.room.ban(peer_id, {"reason": reason} if reason.strip_edges() != "" else {}))


func unban(key: String) -> void:
	if lobby != null and lobby.is_host:
		lobby.room.unban(key)
		changed.emit()


## The ban list: [{key, text}] (the key is what unban() takes).
func ban_rows() -> Array:
	var rows: Array = []
	if lobby == null or not lobby.is_host:
		return rows
	for e: Dictionary in lobby.room.bans.list():
		var who := str(e.get("name", ""))
		if who == "":
			who = OneLobbyMenuText.t("ban_unknown")
		var reason := str(e.get("reason", ""))
		rows.append({"key": str(e.get("id", e.get("ip", ""))),
			"text": OneLobbyMenuText.t("ban_row_reason", [who, reason]) if reason != "" else who})
	return rows


## Host: the settings the room layer lets the host change: {auto_start, min_players, countdown_seconds, late_join}.
func lobby_settings() -> Dictionary:
	if not room_active():
		return {}
	var s := lobby.room.settings()
	return {"auto_start": str(s["autoStart"]), "min_players": int(s["minPlayers"]), "countdown_seconds": int(s["countdownMs"]) / 1000,
		"late_join": str(s["lateJoin"]) != "refuse"}


func set_lobby_setting(key: String, value: Variant) -> void:
	if not room_active() or not lobby.is_host:
		return
	match key:
		"auto_start":
			lobby.room.configure({"autoStart": str(value)})
		"min_players":
			lobby.room.configure({"minPlayers": int(value)})
		"countdown_seconds":
			lobby.room.configure({"countdownMs": int(value) * 1000})
		"late_join":
			lobby.room.configure({"lateJoin": "allow" if bool(value) else "refuse"})


func approve(peer_id: int, ok: bool) -> void:
	if lobby != null and lobby.is_host:
		lobby.approve(peer_id, ok)
	requests = requests.filter(func(r: Dictionary) -> bool: return r["peer_id"] != peer_id)
	changed.emit()


func send_chat(text: String) -> void:
	if lobby != null and lobby.chat.enabled and text.strip_edges() != "":
		lobby.chat.send(text)


func _note_code(code: String) -> void:
	lobby_note = ""
	if code != "":
		var d := OneLobbyFriendly.describe_error(code)
		lobby_note = str(d["message"]) + (" " + str(d["hint"]) if d.has("hint") else "")
	changed.emit()


## Leaves the lobby (the leave message goes out first) and shows the start screen.
func leave() -> void:
	if lobby != null:
		var l := lobby
		lobby = null
		_set_screen(Screen.START)
		await l.leave_and_flush()
	_set_screen(Screen.START)
	left.emit()


## ui_cancel and the Back buttons. Returns false when there was nothing to go back from (the start screen, a game running).
func back() -> bool:
	match screen:
		Screen.SETTINGS, Screen.BROWSE:
			_set_screen(Screen.START)
		Screen.ERROR:
			lobby = null
			_set_screen(Screen.START)
		Screen.CONNECTING:
			cancel_connecting()
		Screen.LOBBY:
			leave()
		_:
			return false
	return true


## Gives up waiting for host() / join(). A lobby that still arrives is left; a failure is not shown.
func cancel_connecting() -> void:
	if screen != Screen.CONNECTING:
		return
	_ticket += 1
	_set_screen(Screen.START)


# ---- error screen ---------------------------------------------------------------------------------------------------

func _show_error(d: Dictionary, code: String, removed: bool = false) -> void:
	error = {
		"title": OneLobbyMenuText.t("error_title"),
		"message": str(d.get("message", "")),
		"hint": str(d.get("hint", "")),
		"code": code if code != "" else str(d.get("code", "")),
		"removed": removed, "ban": false, "reason": "",
	}
	if str(d.get("cause", "")) != "":
		# a connect failure that knows why: the diagnosis' own sentence and next step
		var x := OneLobbyDiagnose.explain_cause(str(d["cause"]), {"stage": str(d.get("stage", "ice"))})
		error["message"] = x["message"]
		error["hint"] = x["hint"]
	log_note = ""
	_set_screen(Screen.ERROR)


func copy_logs() -> void:
	_copy(client.get_net_log().export())
	log_note = OneLobbyMenuText.t("logs_copied")
	changed.emit()


func save_logs() -> void:
	var path := client.get_net_log().save(logs_path)
	log_note = OneLobbyMenuText.t("logs_saved", [path]) if path != "" else OneLobbyMenuText.t("logs_not_saved")
	changed.emit()


# ---- settings -------------------------------------------------------------------------------------------------------

func open_settings() -> void:
	if screen != Screen.START:
		return
	settings_note = ""
	relay_note = ""
	server_text = client.effective_server()
	_set_screen(Screen.SETTINGS)


## "Relay in use: turn:host:3478 <hidden> <hidden>", or the plain sentence when there is none or it does not parse.
func relay_status_text() -> String:
	var st: Dictionary = client.settings.relay_status()
	if bool(st["invalid"]):
		return OneLobbyMenuText.t("relay_invalid")
	var masked := client.settings.masked_relay()
	return OneLobbyMenuText.t("relay_set", [masked]) if masked != "" else OneLobbyMenuText.t("relay_none")


## Saves a pasted relay line. The line is never shown again, only its masked form.
func save_relay(line: String) -> bool:
	if line.strip_edges() == "":
		return false
	var r: Dictionary = client.settings.save({"relay": line})
	relay_note = OneLobbyMenuText.t("relay_saved") if r["ok"] else OneLobbyMenuText.t("relay_bad_input")
	changed.emit()
	return bool(r["ok"])


func clear_relay() -> void:
	client.settings.save({"relay": ""})
	relay_note = OneLobbyMenuText.t("relay_cleared")
	changed.emit()


func save_server(text: String) -> bool:
	var r: Dictionary = client.settings.save({"server": text})
	if r["ok"]:
		var saved := str(client.settings.effective()["server"])
		if client.config == null or str(client.config.hosting.get("lobby_server", "")) == "":
			client.lobby_server = saved
		server_text = client.effective_server()
	settings_note = OneLobbyMenuText.t("server_saved") if r["ok"] else OneLobbyMenuText.t("server_bad_input")
	changed.emit()
	return bool(r["ok"])


## Runs the connection check and keeps its one-line verdict and three facts.
func run_check() -> void:
	if check_running:
		return
	check_running = true
	check_verdict = OneLobbyMenuText.t("check_running")
	check_facts = []
	changed.emit()
	var r: Dictionary
	if check_runner.is_valid():
		r = await check_runner.call(check_options)
	else:
		r = await client.check_connection(check_options)
	check_running = false
	check_verdict = str(OneLobbyDiagnose.check_verdict(r)["message"])
	var udp := str(r.get("udp", "unknown"))
	var nat := str(r.get("natType", "unknown"))
	var relay := str(r.get("relay", "none"))
	check_facts = [
		OneLobbyMenuText.t("check_udp", [_fact("udp_", udp, "udp_unknown")]),
		OneLobbyMenuText.t("check_nat", [_fact("nat_", nat, "nat_unknown")]),
		OneLobbyMenuText.t("check_relay", [_fact("relay_", relay, "relay_none_fact") if relay != "none" else OneLobbyMenuText.t("relay_none_fact")]),
	]
	changed.emit()


func _fact(prefix: String, value: String, fallback: String) -> String:
	return OneLobbyMenuText.t(prefix + value) if OneLobbyMenuText.TABLE.has(prefix + value) else OneLobbyMenuText.t(fallback)


# ---- browse ---------------------------------------------------------------------------------------------------------

func open_browse() -> void:
	if screen != Screen.START or not browse_available():
		return
	_set_screen(Screen.BROWSE)
	await _show_list()


## Starts what the shown list needs: the LAN finder for the LAN list (and only then), the lobby server query for the other.
func _show_list() -> void:
	if shown_list() == "lan":
		_start_lan()
	else:
		_stop_lan()
		await refresh_browse()


## Picks a tab ("online" or "lan") on the Browse screen. Leaving the LAN tab closes the finder; opening it starts one.
func set_browse_tab(tab: String) -> void:
	if screen != Screen.BROWSE or not browse_tabs_shown() or not ["online", "lan"].has(tab) or tab == browse_tab:
		return
	browse_tab = tab
	await _show_list()


## Refresh: asks the server again, or asks the LAN now.
func refresh_browse() -> void:
	if shown_list() == "lan":
		if _finder != null:
			_finder.ask_now()
		return
	browse_status = OneLobbyMenuText.t("browse_loading")
	browse_items = []
	changed.emit()
	var items: Array = await client.list()
	if screen != Screen.BROWSE or shown_list() != "online":
		return
	if items.is_empty() and not client.last_error.is_empty():
		browse_status = str(OneLobbyFriendly.describe_error(client.last_error)["message"])
	else:
		browse_status = "" if not items.is_empty() else OneLobbyMenuText.t("browse_empty")
	browse_items = items
	changed.emit()


## Joins a listed lobby.
func join_listed(code: String) -> void:
	if screen != Screen.BROWSE:
		return
	_set_screen(Screen.START)
	set_join_text(code)
	await join()


# ---- LAN games ------------------------------------------------------------------------------------------------------

## How long the LAN list says "looking" before it says nothing was found.
const LAN_EMPTY_AFTER_MS := 3000


func set_lan_password(text: String) -> void:
	lan_password_text = text.left(64)


## True while a finder exists (the LAN list is the shown list). A test counts this.
func finder_running() -> bool:
	return _finder != null


func _start_lan() -> void:
	if _finder != null:
		return
	var o := {}
	if local_only:
		o["targets"] = PackedStringArray(["127.0.0.1"]) # --local: nothing is broadcast
	_finder = finder_factory.call(o) if finder_factory.is_valid() else client.lan_finder(o)
	_finder.changed.connect(_on_lan_changed)
	_lan_empty_since = int(now_fn.call())
	_lan_status_shown = ""
	_finder.start()
	changed.emit()


## Closes the finder's socket and frees it. Safe to call when there is none.
func _stop_lan() -> void:
	if _finder == null:
		return
	var f = _finder
	_finder = null
	if is_instance_valid(f):
		if f.changed.is_connected(_on_lan_changed):
			f.changed.disconnect(_on_lan_changed)
		f.stop()
	if not finder_factory.is_valid() and is_instance_valid(client):
		client.drop_lan_finder()


## For the view: the menu left the tree, the application is quitting, or the menu was hidden. The finder goes; the screen stays.
func shutdown() -> void:
	_stop_lan()


## For the view: the menu became visible again; a LAN list that is on screen looks again.
func resume() -> void:
	if screen == Screen.BROWSE and shown_list() == "lan":
		_start_lan()


func _on_lan_changed(_games: Array) -> void:
	if _finder == null:
		return
	if (_finder.games as Array).is_empty():
		if _lan_empty_since < 0:
			_lan_empty_since = int(now_fn.call())
	else:
		_lan_empty_since = -1
	changed.emit()


## For the view, every frame while the Browse screen is up: lets the "nothing found" sentence appear after its 3 seconds.
func tick() -> void:
	if _finder == null:
		return
	var t := lan_status_text()
	if t != _lan_status_shown:
		_lan_status_shown = t
		changed.emit()


## The LAN list's rows: {address, port, name, host_name, players, max_players, has_password, same_version, text, lock, can_join, note}.
## `text` is plain text (names are never markup). `lock` is the password mark ("" when none). `note` says why a row cannot be joined.
func lan_rows() -> Array:
	var rows: Array = []
	if _finder == null:
		return rows
	for g: Dictionary in _finder.games:
		var same := bool(g.get("same_version", true))
		rows.append({
			"address": str(g["address"]), "port": int(g["port"]), "name": str(g["name"]), "host_name": str(g["host_name"]),
			"players": int(g["players"]), "max_players": int(g["max_players"]), "has_password": bool(g["has_password"]), "same_version": same,
			"text": OneLobbyMenuText.t("lan_row", [str(g["name"]), str(g["host_name"]), int(g["players"]), int(g["max_players"])]),
			"lock": OneLobbyMenuText.t("lan_locked") if bool(g["has_password"]) else "",
			"can_join": same,
			"note": "" if same else str(OneLobbyFriendly.describe_error("version_mismatch")["message"]),
		})
	return rows


## The sentence under the LAN list's title: still looking, nothing found (after 3 seconds), the socket failed, or LAN switched off. "" with rows.
func lan_status_text() -> String:
	if _finder == null:
		return ""
	match str(_finder.status):
		"socket_failed":
			return OneLobbyMenuText.t("lan_socket_failed")
		"off", "browser":
			return OneLobbyMenuText.t("lan_off")
	if not (_finder.games as Array).is_empty():
		return ""
	var waited := int(now_fn.call()) - _lan_empty_since
	return OneLobbyMenuText.t("lan_empty") if _lan_empty_since >= 0 and waited >= LAN_EMPTY_AFTER_MS else OneLobbyMenuText.t("lan_looking")


## The status line of the shown list.
func list_status() -> String:
	return lan_status_text() if shown_list() == "lan" else browse_status


## The title of the Browse screen: it says which list when only one is available.
func browse_title() -> String:
	if browse_tabs_shown():
		return OneLobbyMenuText.t("browse_title")
	return OneLobbyMenuText.t("browse_title_lan" if shown_list() == "lan" else "browse_title_online")


## Joins row `index` of the LAN list through the join path, as if its "address:port" had been typed. The finder stops with the screen.
func join_lan(index: int) -> void:
	if screen != Screen.BROWSE or shown_list() != "lan":
		return
	var rows := lan_rows()
	if index < 0 or index >= rows.size() or not bool(rows[index]["can_join"]):
		return
	var r: Dictionary = rows[index]
	var pw := lan_password_text
	_set_screen(Screen.START)
	set_join_text("%s:%d" % [r["address"], r["port"]])
	set_password(pw)
	await join()


# ---- boot -----------------------------------------------------------------------------------------------------------

## What `--local` puts over the host options: loopback only, no Nostr relays, no public address.
const LOCAL_HOST_OPTIONS := {"nostr": false, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1"}


## Makes this menu local (what `--local` means): hosts and joins by the direct route, the host listens on 127.0.0.1 only with
## Nostr off (these keys win over host_options the game set; its other keys stay), and the connection check does not run on its own.
func apply_local() -> void:
	local_only = true
	route = "direct"
	var o := host_options.duplicate()
	o.merge(LOCAL_HOST_OPTIONS, true)
	host_options = o


## Acts on --local, --host, --join=<code> and --name=<name> (see parse_boot_flags). --local is applied first: the host and the
## join that follow in the same call use it. Returns what it started: "host", "join" or "".
func apply_boot_flags(args: PackedStringArray) -> String:
	var f := parse_boot_flags(args)
	if bool(f["local"]):
		apply_local()
	if str(f["name"]) != "":
		set_name(str(f["name"]))
		changed.emit() # the start screen's name field follows the model
	if str(f["join"]) != "":
		set_join_text(str(f["join"]))
		join()
		return "join"
	if bool(f["host"]):
		host()
		return "host"
	return ""


func _set_screen(s: Screen) -> void:
	screen = s
	if s != Screen.BROWSE:
		_stop_lan() # the finder lives only while the LAN list is on screen
	changed.emit()
