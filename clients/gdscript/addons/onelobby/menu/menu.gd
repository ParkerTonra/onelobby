class_name OneLobbyMenu
extends Control
## The drop-in multiplayer menu: add menu.tscn to a scene (or load it and add it from code), connect `game_started`, done. It draws OneLobbyMenuModel (all the
## decisions live there) and forwards input to it; it uses stock controls and the engine's default Theme, so a game restyles it
## by giving the root (or any parent) a Theme. Every string comes from OneLobbyMenuText. It reads `onelobby.json`
## (`config_path`), builds its own OneLobbyClient from it, saves the player's name, relay line and last code through the
## client's settings, and calls client.pump() itself (set `pump` to false when your game pumps).
##
##     $OneLobbyMenu.game_started.connect(func(lobby: OneLobbyLobby) -> void: start_my_game(lobby))
##
## Handing over to a game's own session:
##   - `game_started(lobby)` fires on every copy when the match starts: the host after its Start (and the room's countdown), a joiner when the
##     host's phase changes to in_game (also for a player who joins a match already running). `lobby` is the OneLobbyLobby of this copy; the
##     same object is `client.lobby`. Hand it, the peer ids (`lobby.local_peer_id`, `lobby.host_peer_id`, `lobby.is_host`) and the roster
##     (`lobby.room.players()`) to your session; with `sync.mode` raw you send and receive your own bytes on it (`lobby.send`, `lobby.broadcast`,
##     `lobby.message_received`) and keep pumping it from the client (`client.pump()`; the menu does it unless `pump` is off).
##   - ORDER: `game_started` fires with the menu's screen already PLAYING. Set your own role and "line is live" state BEFORE you attach the lobby to your
##     session or panel (`role = ...` first, then `attach(lobby)`): anything that refreshes on the lobby's roster signals while the menu says PLAYING reads your
##     state at once, and a panel that finds no live line calls `menu.leave()` and hangs up both peers. The host's `game_started` also comes after the room's
##     countdown (3 s by default), `start_on_host` included: your world keeps running solo until then.
##   - Inside your own Container, give the menu a size: `menu.custom_minimum_size = Vector2(520, 460)` and expand flags (a full-rect Control has no minimum of its own).
##   - The menu has a room step your game may not have had: after Host (or Join) the lobby page shows the roster, Ready and the host's Start button.
##     Nothing starts until the host presses Start (or `model.start_game()`, or `--autostart`).
##   - `pump`: on (the default) the menu turns the client's `auto_pump` off and pumps it from its own `_process`, so the pump stops when the menu is freed.
##     Set it to false when the menu lives in a node your game frees or replaces when the match starts: the client then keeps pumping itself
##     (the autoload `Net` adds its client to the tree, so `auto_pump` stays on).
##   - A menu built in code (a runtime CanvasLayer, no scene file): `var m: OneLobbyMenu = load("res://addons/onelobby/menu/menu.tscn").instantiate()`,
##     set `m.client = Net.client` (and the other exports) BEFORE `add_child(m)`, because the menu reads them in its own `_ready`.
##   - `returned_to_lobby(lobby)` (the host went back to the room: end your session) and `left` (this player left: end it and show your title).
##
## Nodes a controller (a C# one, or a script of yours) may touch, all with unique names (`%Name`):
##   Pages
##   start:      StartPage StartTitle StartNote NameLabel NameEdit HostButton JoinLabel JoinEdit JoinButton PasswordEdit
##               BrowseButton SettingsButton StartCheckLine
##   connecting: ConnectingPage ConnectingLabel ConnectingCancel
##   lobby:      LobbyPage CodeCaption CodeLabel CopyCodeButton CopyInviteButton PlayersHeader RosterList RosterNote
##               CountdownLabel ReadyButton StartButton CancelStartButton LeaveButton LobbyNote RequestsHeader RequestsList
##               ReasonEdit BansHeader BansList LobbySettingsToggle LobbySettingsBox AutoStartLabel AutoStartOption
##               MinPlayersLabel MinPlayersSpin CountdownSecondsLabel CountdownSpin LateJoinCheck ChatBox ChatLog ChatEdit
##               ChatSendButton
##   error:      ErrorPage ErrorTitle ErrorMessage ErrorHint ErrorCode CopyLogsButton SaveLogsButton LogNote ErrorBackButton
##   settings:   SettingsPage SettingsTitle RelayLabel RelayStatus RelayEdit RelaySaveButton RelayClearButton RelayNote
##               ServerLabel ServerEdit ServerSaveButton ServerNote ConnectionCheckButton CheckVerdict CheckFacts
##               SettingsCopyLogsButton SettingsBackButton
##   browse:     BrowsePage BrowseTitle BrowseTabs BrowseTabOnlineButton BrowseTabLanButton BrowseStatus BrowseLanPasswordEdit
##               BrowseList BrowseRefreshButton BrowseBackButton
## (The roster, ban, request and browse rows are built at run time inside RosterList, BansList, RequestsList and BrowseList.)

## The host started the game, or the player joined a game that is already running. Hide the menu (auto_hide_on_start does).
signal game_started(lobby: OneLobbyLobby)
## The game went back to the lobby; the menu shows the lobby again.
signal returned_to_lobby(lobby: OneLobbyLobby)
## The player left the lobby.
signal left

## The blueprint to read when `client` is not set.
@export_file("*.json") var config_path := OneLobbyConfig.DEFAULT_PATH
## The menu calls client.pump() every frame. Turn it off when your game pumps (e.g. from _physics_process).
@export var pump := true
## Hide the menu while a game runs, show it again when the lobby comes back.
@export var auto_hide_on_start := true
## Act on --host, --join=<code>, --name=<name>, --local and --autostart (after `--` on the command line) at once. One switch for all five:
## turn it off when your game reads flags of those names itself (it then sees them and the menu does not), and open the menu from code.
## `--local`: the direct route, host and join on 127.0.0.1 only, no Nostr (a game that sets route or host_options itself keeps them without it).
## `--autostart` (tests only, no clicks): the host starts the match as soon as a second player is in the room, so `game_started` fires on both copies.
## The menu's own `--local` reading (the check on open stays off) is independent of this switch.
## The process command line is read once per process: the first menu that acts on `--host`, `--join=<code>`, `--name=<name>` and `--autostart` consumes
## them, so a game that builds a menu in every world (title, the match, the next) hosts or joins once, with no flag of its own. `--local` is read by
## every menu. `boot_args` (a test, a game) is never consumed: the menu that has it acts on it.
@export var boot_flags := true
## For a game that hosts from its running world (no room step wanted): after Host the menu presses Start itself, once.
@export var start_on_host := false
## Base address of an invite link ("https://game.example/play"); with it the lobby shows Copy invite for a lobby-server code.
@export var invite_base := ""
## Rewording: {text key: new text}, keys as in OneLobbyMenuText.TABLE.
@export var texts := {}
## LAN games list for a game with no onelobby.json (with one, `hosting.lan` decides): the Browse screen shows a "LAN games" list and
## a lobby hosted from the menu answers LAN questions. The menu looks for LAN games only while that list is on screen.
@export var lan := false

## The client the menu drives. Set it before the menu enters the tree to use your own; default: OneLobbyClient.from_config(config_path).
var client: OneLobbyClient
var model: OneLobbyMenuModel
## The command line the boot flags are read from (default: OS.get_cmdline_user_args()).
var boot_args := PackedStringArray()
## True once a menu has read the process flags (`--host`, `--join=`, `--name=`, `--autostart`); later menus act on none of them.
static var _process_flags_spent := false
## A test's stand-in for the process command line (null: OS.get_cmdline_user_args()).
static var process_args_override: Variant = null
## Options for host() / join() and the route ("auto", "direct", "server"); see OneLobbyMenuModel.
var host_options := {}:
	set(v):
		host_options = v
		if model != null:
			model.host_options = v
var join_options := {}:
	set(v):
		join_options = v
		if model != null:
			model.join_options = v
var route := "auto":
	set(v):
		route = v
		if model != null:
			model.route = v
## Makes the LAN finder instead of the client's own (a test passes a fake; see OneLobbyMenuModel.finder_factory).
var finder_factory := Callable():
	set(v):
		finder_factory = v
		if model != null:
			model.finder_factory = v
## Runs the connection check instead of client.check_connection (a test gives a fake; see OneLobbyMenuModel.check_runner).
var check_runner := Callable():
	set(v):
		check_runner = v
		if model != null:
			model.check_runner = v

var _shown := -1
var _roster_sig := ""
var _bans_sig := ""
var _requests_sig := ""
var _browse_sig := ""
var _lan_sig := ""
var _ping_labels := {} # peer id -> Label
var _ping_at := 0
var _syncing := false
## True while the name field holds text the player typed and the model has not taken yet.
var _name_dirty := false
## True when this menu turned the client's auto_pump off (so it turns it back on when it leaves the tree).
var _took_pump := false


func _ready() -> void:
	if not texts.is_empty():
		OneLobbyMenuText.override(texts)
	if client == null:
		client = OneLobbyClient.from_config(config_path)
	if client.get_parent() == null:
		add_child(client)
	if pump:
		_took_pump = client.auto_pump
		client.auto_pump = false
	model = OneLobbyMenuModel.new(client)
	model.host_options = host_options
	model.join_options = join_options
	model.route = route
	model.lan = lan
	model.finder_factory = finder_factory
	model.invite_base = invite_base
	model.check_runner = check_runner
	# `--local` (after `--`): 127.0.0.1 only, nothing leaves this PC, so the check does not run by itself (the button still does).
	# Read here, not from boot_flags: a game that applies the boot flags itself later would be too late for the check on open.
	model.start_on_host = start_on_host
	model.local_only = OneLobbyMenuModel.args_say_local(boot_args if not boot_args.is_empty() else _process_args())
	model.changed.connect(_refresh)
	model.game_started.connect(func(l: OneLobbyLobby) -> void: game_started.emit(l))
	model.returned_to_lobby.connect(func(l: OneLobbyLobby) -> void: returned_to_lobby.emit(l))
	model.left.connect(func() -> void: left.emit())
	_bind()
	_apply_static_text()
	_refresh()
	if boot_flags:
		model.apply_boot_flags(_take_boot_args())


## The process command line after `--` (`process_args_override` in a test).
static func _process_args() -> PackedStringArray:
	if process_args_override != null:
		return process_args_override
	return OS.get_cmdline_user_args()


## The flags this menu acts on: its own `boot_args`, else the process command line the first time; later only `--local` (the one-shot flags are
## gone, so a second menu in the process does not host or join again).
func _take_boot_args() -> PackedStringArray:
	if not boot_args.is_empty():
		return boot_args
	var args := _process_args()
	if not _process_flags_spent:
		_process_flags_spent = true
		return args
	return PackedStringArray(["--local"]) if OneLobbyMenuModel.args_say_local(args) else PackedStringArray()


## Makes the process flags readable again (tests).
static func reset_process_flags() -> void:
	_process_flags_spent = false


func _process(_delta: float) -> void:
	if pump and client != null:
		client.pump()
	if model != null and model.screen == OneLobbyMenuModel.Screen.BROWSE:
		model.tick() # lets "nothing found" appear after its 3 seconds
	if model == null or model.screen != OneLobbyMenuModel.Screen.LOBBY:
		return
	%CountdownLabel.text = model.countdown_text()
	%CountdownLabel.visible = model.counting_down()
	var now := Time.get_ticks_msec()
	if now - _ping_at > 500:
		_ping_at = now
		_update_pings()


## The LAN finder goes with the menu: out of the tree, hidden, or the application closing. (Freeing the menu frees the client and the
## finder with it; this closes the socket first.)
func _enter_tree() -> void:
	if model != null:
		model.resume() # put back in the tree with the LAN list on screen: look again
		if _took_pump and pump and client != null:
			client.auto_pump = false


func _exit_tree() -> void:
	if model != null:
		model.shutdown()
	# a menu that took the pump gives it back: the client (an autoload's, it outlives the menu) pumps itself again, so a game that
	# builds the next menu with `pump = false` still has a pumped client
	if _took_pump and client != null and is_instance_valid(client):
		client.auto_pump = true


func _notification(what: int) -> void:
	if model == null:
		return
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		model.shutdown()
	elif what == NOTIFICATION_VISIBILITY_CHANGED:
		if is_visible_in_tree():
			model.resume()
		else:
			model.shutdown()


## ui_cancel goes back one screen (out of settings, browse, an error, a connect in progress, or the lobby).
func _unhandled_input(event: InputEvent) -> void:
	if model != null and visible and event.is_action_pressed("ui_cancel") and model.back():
		get_viewport().set_input_as_handled()


## Leaves the lobby from code (the same as the Leave button).
func leave() -> void:
	if model != null:
		await model.leave()


# ---- wiring ---------------------------------------------------------------------------------------------------------

func _bind() -> void:
	%NameEdit.text_changed.connect(func(_t: String) -> void: _name_dirty = true)
	%NameEdit.text_submitted.connect(func(_t: String) -> void: _commit_name())
	%NameEdit.focus_exited.connect(_commit_name)
	%HostButton.pressed.connect(func() -> void:
		_commit_name()
		model.set_password(%PasswordEdit.text)
		model.host())
	%JoinEdit.text_changed.connect(_on_join_text)
	%JoinEdit.text_submitted.connect(func(_t: String) -> void: _join())
	%JoinButton.pressed.connect(_join)
	%BrowseButton.pressed.connect(func() -> void: model.open_browse())
	%SettingsButton.pressed.connect(func() -> void: model.open_settings())
	%ConnectingCancel.pressed.connect(func() -> void: model.cancel_connecting())
	%CopyCodeButton.pressed.connect(func() -> void: _copied(%CopyCodeButton, "copy_code", model.copy_code()))
	%CopyInviteButton.pressed.connect(func() -> void: _copied(%CopyInviteButton, "copy_invite", model.copy_invite()))
	%ReadyButton.pressed.connect(func() -> void: model.toggle_ready())
	%StartButton.pressed.connect(func() -> void: model.start_game())
	%CancelStartButton.pressed.connect(func() -> void: model.cancel_countdown())
	%LeaveButton.pressed.connect(func() -> void: model.leave())
	%LobbySettingsToggle.toggled.connect(func(_on: bool) -> void: _refresh())
	%AutoStartOption.item_selected.connect(func(i: int) -> void:
		if not _syncing:
			model.set_lobby_setting("auto_start", ["off", "all_ready", "players"][i]))
	%MinPlayersSpin.value_changed.connect(func(v: float) -> void:
		if not _syncing:
			model.set_lobby_setting("min_players", int(v)))
	%CountdownSpin.value_changed.connect(func(v: float) -> void:
		if not _syncing:
			model.set_lobby_setting("countdown_seconds", int(v)))
	%LateJoinCheck.toggled.connect(func(on: bool) -> void:
		if not _syncing:
			model.set_lobby_setting("late_join", on))
	%ChatEdit.text_submitted.connect(func(_t: String) -> void: _send_chat())
	%ChatSendButton.pressed.connect(_send_chat)
	%CopyLogsButton.pressed.connect(func() -> void: model.copy_logs())
	%SaveLogsButton.pressed.connect(func() -> void: model.save_logs())
	%ErrorBackButton.pressed.connect(func() -> void: model.back())
	%RelaySaveButton.pressed.connect(func() -> void:
		if model.save_relay(%RelayEdit.text):
			%RelayEdit.text = "")
	%RelayClearButton.pressed.connect(func() -> void:
		%RelayEdit.text = ""
		model.clear_relay())
	%ServerSaveButton.pressed.connect(func() -> void: model.save_server(%ServerEdit.text))
	%ConnectionCheckButton.pressed.connect(func() -> void: model.run_check())
	%SettingsCopyLogsButton.pressed.connect(func() -> void: model.copy_logs())
	%SettingsBackButton.pressed.connect(func() -> void: model.back())
	%BrowseRefreshButton.pressed.connect(func() -> void: model.refresh_browse())
	%BrowseTabOnlineButton.pressed.connect(func() -> void: model.set_browse_tab("online"))
	%BrowseTabLanButton.pressed.connect(func() -> void: model.set_browse_tab("lan"))
	%BrowseLanPasswordEdit.text_changed.connect(func(t: String) -> void: model.set_lan_password(t))
	%BrowseBackButton.pressed.connect(func() -> void: model.back())
	var auto: OptionButton = %AutoStartOption
	auto.clear()
	for key in ["auto_start_off", "auto_start_all_ready", "auto_start_players"]:
		auto.add_item(OneLobbyMenuText.t(key))


func _commit_name() -> void:
	if model == null or _syncing:
		return
	_name_dirty = false
	var cleaned := model.set_name(%NameEdit.text)
	if cleaned != %NameEdit.text:
		%NameEdit.text = cleaned


func _on_join_text(text: String) -> void:
	if _syncing:
		return
	var cleaned := model.set_join_text(text)
	if cleaned != text:
		_syncing = true
		var col: int = %JoinEdit.caret_column
		%JoinEdit.text = cleaned
		%JoinEdit.caret_column = mini(col, cleaned.length())
		_syncing = false


func _join() -> void:
	_commit_name()
	model.set_join_text(%JoinEdit.text)
	model.set_password(%PasswordEdit.text)
	model.join()


func _send_chat() -> void:
	model.send_chat(%ChatEdit.text)
	%ChatEdit.text = ""


func _copied(button: Button, key: String, ok: bool) -> void:
	button.text = OneLobbyMenuText.t("copied" if ok else "copy_failed")
	get_tree().create_timer(1.5).timeout.connect(func() -> void:
		if is_instance_valid(button):
			button.text = OneLobbyMenuText.t(key))


# ---- text -----------------------------------------------------------------------------------------------------------

func _apply_static_text() -> void:
	var T := OneLobbyMenuText
	%StartTitle.text = T.t("title")
	%NameLabel.text = T.t("name_label")
	%NameEdit.placeholder_text = T.t("name_placeholder")
	%HostButton.text = T.t("host")
	%JoinLabel.text = T.t("join_label")
	%JoinEdit.placeholder_text = T.t("join_placeholder")
	%JoinButton.text = T.t("join")
	%PasswordEdit.placeholder_text = T.t("password_placeholder")
	%BrowseButton.text = T.t("browse")
	%SettingsButton.text = T.t("settings")
	%ConnectingCancel.text = T.t("cancel")
	%CodeCaption.text = T.t("code_caption")
	%CopyCodeButton.text = T.t("copy_code")
	%CopyInviteButton.text = T.t("copy_invite")
	%CancelStartButton.text = T.t("cancel_countdown")
	%LeaveButton.text = T.t("leave")
	%StartButton.text = T.t("start")
	%ReasonEdit.placeholder_text = T.t("reason_placeholder")
	%RequestsHeader.text = T.t("requests_header")
	%BansHeader.text = T.t("bans_header")
	%LobbySettingsToggle.text = T.t("lobby_settings")
	%AutoStartLabel.text = T.t("setting_auto_start")
	%MinPlayersLabel.text = T.t("setting_min_players")
	%CountdownSecondsLabel.text = T.t("setting_countdown")
	%LateJoinCheck.text = T.t("setting_late_join")
	%ChatEdit.placeholder_text = T.t("chat_placeholder")
	%ChatSendButton.text = T.t("chat_send")
	%CopyLogsButton.text = T.t("copy_logs")
	%SaveLogsButton.text = T.t("save_logs")
	%ErrorBackButton.text = T.t("back")
	%SettingsTitle.text = T.t("settings_title")
	%RelayLabel.text = T.t("relay_label")
	%RelayEdit.placeholder_text = T.t("relay_placeholder")
	%RelaySaveButton.text = T.t("relay_save")
	%RelayClearButton.text = T.t("relay_clear")
	%ServerLabel.text = T.t("server_label")
	%ServerEdit.placeholder_text = T.t("server_placeholder")
	%ServerSaveButton.text = T.t("server_save")
	%ConnectionCheckButton.text = T.t("check")
	%SettingsCopyLogsButton.text = T.t("copy_logs")
	%SettingsBackButton.text = T.t("back")
	%BrowseTabOnlineButton.text = T.t("browse_tab_online")
	%BrowseTabLanButton.text = T.t("browse_tab_lan")
	%BrowseLanPasswordEdit.placeholder_text = T.t("password_placeholder")
	%BrowseRefreshButton.text = T.t("browse_refresh")
	%BrowseBackButton.text = T.t("back")
	var auto: OptionButton = %AutoStartOption
	for i in 3:
		auto.set_item_text(i, T.t(["auto_start_off", "auto_start_all_ready", "auto_start_players"][i]))


# ---- drawing --------------------------------------------------------------------------------------------------------

func _page_for(s: int) -> Control:
	match s:
		OneLobbyMenuModel.Screen.START:
			return %StartPage
		OneLobbyMenuModel.Screen.CONNECTING:
			return %ConnectingPage
		OneLobbyMenuModel.Screen.LOBBY:
			return %LobbyPage
		OneLobbyMenuModel.Screen.ERROR:
			return %ErrorPage
		OneLobbyMenuModel.Screen.SETTINGS:
			return %SettingsPage
		OneLobbyMenuModel.Screen.BROWSE:
			return %BrowsePage
	return null


func _refresh() -> void:
	if model == null:
		return
	var s := int(model.screen)
	var page := _page_for(s)
	for p: Control in [%StartPage, %ConnectingPage, %LobbyPage, %ErrorPage, %SettingsPage, %BrowsePage]:
		p.visible = p == page
	visible = not (s == OneLobbyMenuModel.Screen.PLAYING and auto_hide_on_start)
	var entering := s != _shown
	_shown = s
	match s:
		OneLobbyMenuModel.Screen.START:
			_draw_start(entering)
		OneLobbyMenuModel.Screen.CONNECTING:
			%ConnectingLabel.text = model.connecting_text
		OneLobbyMenuModel.Screen.LOBBY:
			_draw_lobby(entering)
		OneLobbyMenuModel.Screen.ERROR:
			_draw_error()
		OneLobbyMenuModel.Screen.SETTINGS:
			_draw_settings(entering)
		OneLobbyMenuModel.Screen.BROWSE:
			_draw_browse()
	if entering and page != null:
		_focus_first.call_deferred(s)


func _set_text(edit: LineEdit, text: String) -> void:
	if edit.text != text:
		_syncing = true
		edit.text = text
		_syncing = false


func _draw_start(entering: bool) -> void:
	%NameLabel.visible = model.names_allowed()
	%NameEdit.visible = model.names_allowed()
	%BrowseButton.visible = model.browse_available()
	%StartNote.text = model.start_note
	%StartNote.visible = model.start_note != ""
	%StartCheckLine.text = model.start_check_line()
	%StartCheckLine.visible = model.start_check_line() != ""
	if entering:
		model.start_shown.call_deferred() # not before a boot flag has had its say; the model runs the check once
	# The name field follows the model (a `--name=` boot flag sets it after the first draw) unless the player is typing in it.
	if entering or not _name_dirty:
		_name_dirty = false
		_set_text(%NameEdit, model.name_text)
	if entering:
		_set_text(%JoinEdit, model.join_text)
		_set_text(%PasswordEdit, "")


func _draw_lobby(entering: bool) -> void:
	var T := OneLobbyMenuText
	if model.lobby == null:
		return
	var host := model.is_host()
	var active := model.room_active()
	%CodeLabel.text = model.code_text()
	%CopyInviteButton.visible = model.invite_available()
	%PlayersHeader.text = model.players_header()
	%RosterNote.text = T.t("plain_list_note")
	%RosterNote.visible = model.lobby.room.supported == false
	%ReadyButton.visible = active and model.me_is_player()
	%ReadyButton.set_pressed_no_signal(model.me_ready())
	%ReadyButton.text = T.t("not_ready" if model.me_ready() else "ready")
	%StartButton.visible = host
	%StartButton.disabled = model.counting_down()
	%CancelStartButton.visible = host and model.counting_down()
	var note := model.lobby_note
	if note == "" and not host and not model.counting_down():
		note = T.t("start_wait")
	%LobbyNote.text = note
	%LobbyNote.visible = note != ""
	%CountdownLabel.text = model.countdown_text()
	%CountdownLabel.visible = model.counting_down()
	%ReasonEdit.visible = host and active
	_draw_roster()
	_draw_requests(host)
	_draw_bans()
	%LobbySettingsToggle.visible = host and active
	%LobbySettingsBox.visible = host and active and %LobbySettingsToggle.button_pressed
	if %LobbySettingsBox.visible:
		var st := model.lobby_settings()
		_syncing = true
		%AutoStartOption.select(["off", "all_ready", "players"].find(st["auto_start"]))
		%MinPlayersSpin.value = st["min_players"]
		%CountdownSpin.value = st["countdown_seconds"]
		%LateJoinCheck.button_pressed = st["late_join"]
		_syncing = false
	%ChatBox.visible = model.chat_shown()
	if %ChatBox.visible:
		var lines := PackedStringArray()
		for l: Dictionary in model.chat_lines:
			lines.append(T.t("chat_line", [l["name"], l["text"]]))
		%ChatLog.text = "\n".join(lines)
	if entering:
		%ChatEdit.text = ""
		%ReasonEdit.text = ""


func _clear(box: Control) -> void:
	for c in box.get_children():
		box.remove_child(c)
		c.queue_free()


func _draw_roster() -> void:
	var rows := model.roster_rows()
	var sig := JSON.stringify(rows.map(func(r: Dictionary) -> Dictionary:
		var c: Dictionary = r.duplicate()
		c.erase("ping_ms")
		return c))
	if sig == _roster_sig:
		return
	_roster_sig = sig
	var T := OneLobbyMenuText
	_clear(%RosterList)
	_ping_labels = {}
	for r: Dictionary in rows:
		var row := HFlowContainer.new()
		row.add_theme_constant_override("h_separation", 12)
		var who := Label.new()
		who.text = str(r["name"]) + (" " + T.t("you") if r["me"] else "")
		row.add_child(who)
		var marks := model.row_marks(r)
		if marks != "":
			var m := Label.new()
			m.text = marks
			row.add_child(m)
		var ping := Label.new()
		row.add_child(ping)
		_ping_labels[int(r["id"])] = ping
		if r["can_kick"]:
			var kick := Button.new()
			kick.text = T.t("kick")
			kick.pressed.connect(func() -> void:
				model.kick(int(r["id"]), %ReasonEdit.text)
				%ReasonEdit.text = "")
			row.add_child(kick)
			var ban := Button.new()
			ban.text = T.t("ban")
			ban.pressed.connect(func() -> void:
				model.ban(int(r["id"]), %ReasonEdit.text)
				%ReasonEdit.text = "")
			row.add_child(ban)
		%RosterList.add_child(row)
	_update_pings()


func _update_pings() -> void:
	if model == null or model.lobby == null:
		return
	for id: int in _ping_labels:
		var l: Label = _ping_labels[id]
		var ms := model.lobby.ping_ms(id) if id != model.lobby.local_peer_id else 0
		l.text = OneLobbyMenuText.t("ping", [ms]) if ms > 0 else ""


func _draw_requests(host: bool) -> void:
	var items: Array = model.requests if host else []
	%RequestsHeader.visible = not items.is_empty()
	%RequestsList.visible = not items.is_empty()
	var sig := JSON.stringify(items)
	if sig == _requests_sig:
		return
	_requests_sig = sig
	_clear(%RequestsList)
	for r: Dictionary in items:
		var row := HFlowContainer.new()
		var who := Label.new()
		who.text = str(r["name"])
		row.add_child(who)
		var yes := Button.new()
		yes.text = OneLobbyMenuText.t("let_in")
		yes.pressed.connect(func() -> void: model.approve(int(r["peer_id"]), true))
		row.add_child(yes)
		var no := Button.new()
		no.text = OneLobbyMenuText.t("refuse")
		no.pressed.connect(func() -> void: model.approve(int(r["peer_id"]), false))
		row.add_child(no)
		%RequestsList.add_child(row)


func _draw_bans() -> void:
	var rows := model.ban_rows()
	%BansHeader.visible = not rows.is_empty()
	%BansList.visible = not rows.is_empty()
	var sig := JSON.stringify(rows)
	if sig == _bans_sig:
		return
	_bans_sig = sig
	_clear(%BansList)
	for b: Dictionary in rows:
		var row := HFlowContainer.new()
		var who := Label.new()
		who.text = str(b["text"])
		row.add_child(who)
		var undo := Button.new()
		undo.text = OneLobbyMenuText.t("unban")
		undo.pressed.connect(func() -> void: model.unban(str(b["key"])))
		row.add_child(undo)
		%BansList.add_child(row)


func _draw_error() -> void:
	var e := model.error
	%ErrorTitle.text = str(e.get("title", ""))
	%ErrorMessage.text = str(e.get("message", ""))
	%ErrorHint.text = str(e.get("hint", ""))
	%ErrorHint.visible = %ErrorHint.text != ""
	var code := str(e.get("code", ""))
	%ErrorCode.text = OneLobbyMenuText.t("error_code", [code])
	%ErrorCode.visible = code != ""
	%LogNote.text = model.log_note
	%LogNote.visible = model.log_note != ""


func _draw_settings(entering: bool) -> void:
	%RelayStatus.text = model.relay_status_text()
	%RelayNote.text = model.relay_note
	%RelayNote.visible = model.relay_note != ""
	%ServerNote.text = model.settings_note
	%ServerNote.visible = model.settings_note != ""
	if entering:
		_set_text(%RelayEdit, "")
		_set_text(%ServerEdit, model.server_text)
	%ConnectionCheckButton.visible = model.connection_check_shown()
	%ConnectionCheckButton.disabled = model.check_running
	%CheckVerdict.text = model.check_verdict
	%CheckVerdict.visible = model.check_verdict != ""
	%CheckFacts.text = "\n".join(PackedStringArray(model.check_facts))
	%CheckFacts.visible = not model.check_facts.is_empty()


func _draw_browse() -> void:
	var lan_shown := model.shown_list() == "lan"
	%BrowseTitle.text = model.browse_title()
	%BrowseTabs.visible = model.browse_tabs_shown()
	%BrowseTabOnlineButton.set_pressed_no_signal(not lan_shown)
	%BrowseTabLanButton.set_pressed_no_signal(lan_shown)
	%BrowseLanPasswordEdit.visible = lan_shown
	%BrowseList.visible = %BrowseList.get_child_count() > 0 or not lan_shown
	%BrowseStatus.text = model.list_status()
	%BrowseStatus.visible = %BrowseStatus.text != ""
	var items: Array = model.lan_rows() if lan_shown else model.browse_items
	var sig := ("lan" if lan_shown else "online") + JSON.stringify(items)
	if sig == _browse_sig:
		return
	_browse_sig = sig
	_clear(%BrowseList)
	if lan_shown:
		_draw_lan_rows(items)
		%BrowseList.visible = %BrowseList.get_child_count() > 0
		return
	for it: Dictionary in items:
		var row := HFlowContainer.new()
		var l := Label.new()
		l.text = OneLobbyMenuText.t("browse_row", [str(it.get("name", "")), str(it.get("host_name", "")), int(it.get("players", 0)), int(it.get("max_players", 0))])
		row.add_child(l)
		var j := Button.new()
		j.text = OneLobbyMenuText.t("browse_join")
		j.pressed.connect(func() -> void: model.join_listed(str(it.get("code", ""))))
		row.add_child(j)
		%BrowseList.add_child(row)
	if _shown == OneLobbyMenuModel.Screen.BROWSE and %BrowseList.get_child_count() > 0:
		_focus_first(OneLobbyMenuModel.Screen.BROWSE)


## One row per LAN game: the line, a password mark, why it cannot be joined (greyed), and a Join button. Text only, never markup.
func _draw_lan_rows(rows: Array) -> void:
	for i in rows.size():
		var r: Dictionary = rows[i]
		var row := HFlowContainer.new()
		row.add_theme_constant_override("h_separation", 12)
		var l := Label.new()
		l.text = str(r["text"])
		row.add_child(l)
		if str(r["lock"]) != "":
			var lock := Label.new()
			lock.text = str(r["lock"])
			row.add_child(lock)
		if not bool(r["can_join"]):
			l.modulate = Color(1, 1, 1, 0.5)
			var why := Label.new()
			why.text = str(r["note"])
			why.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
			why.custom_minimum_size.x = 200
			why.modulate = Color(1, 1, 1, 0.5)
			row.add_child(why)
		var j := Button.new()
		j.text = OneLobbyMenuText.t("browse_join")
		j.disabled = not bool(r["can_join"])
		j.pressed.connect(func() -> void: model.join_lan(i))
		row.add_child(j)
		%BrowseList.add_child(row)
	# keep a player's focus (the password field) unless it was on a row that is gone
	var f := get_viewport().gui_get_focus_owner()
	if _shown == OneLobbyMenuModel.Screen.BROWSE and (f == null or not f.is_visible_in_tree() or not is_ancestor_of(f)):
		_focus_first(OneLobbyMenuModel.Screen.BROWSE)


# ---- focus ----------------------------------------------------------------------------------------------------------

## A sensible first control on every screen, so keyboard and gamepad work without a mouse click.
func _focus_first(s: int) -> void:
	if model == null or s != int(model.screen):
		return
	var target: Control = null
	match s:
		OneLobbyMenuModel.Screen.START:
			target = %HostButton
		OneLobbyMenuModel.Screen.CONNECTING:
			target = %ConnectingCancel
		OneLobbyMenuModel.Screen.LOBBY:
			target = %ReadyButton if %ReadyButton.visible else (%StartButton if %StartButton.visible else %LeaveButton)
		OneLobbyMenuModel.Screen.ERROR:
			target = %ErrorBackButton
		OneLobbyMenuModel.Screen.SETTINGS:
			target = %RelayEdit
		OneLobbyMenuModel.Screen.BROWSE:
			target = %BrowseBackButton
			if %BrowseList.get_child_count() > 0:
				var first := %BrowseList.get_child(0)
				var buttons := first.find_children("*", "Button", true, false)
				if not buttons.is_empty():
					target = buttons[0]
	if target != null and target.is_visible_in_tree():
		target.grab_focus()
