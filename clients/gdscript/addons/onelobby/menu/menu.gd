class_name OneLobbyMenu
extends Control
## The drop-in multiplayer menu: add menu.tscn to a scene, connect `game_started`, done. It draws OneLobbyMenuModel (all the
## decisions live there) and forwards input to it; it uses stock controls and the engine's default Theme, so a game restyles it
## by giving the root (or any parent) a Theme. Every string comes from OneLobbyMenuText. It reads `onelobby.json`
## (`config_path`), builds its own OneLobbyClient from it, saves the player's name, relay line and last code through the
## client's settings, and calls client.pump() itself (set `pump` to false when your game pumps).
##
##     $OneLobbyMenu.game_started.connect(func(lobby: OneLobbyLobby) -> void: start_my_game(lobby))
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
##   browse:     BrowsePage BrowseTitle BrowseStatus BrowseList BrowseRefreshButton BrowseBackButton
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
## Act on --host, --join=<code> and --name=<name> (after `--` on the command line) at once. One switch for all three.
@export var boot_flags := true
## Base address of an invite link ("https://game.example/play"); with it the lobby shows Copy invite for a lobby-server code.
@export var invite_base := ""
## Rewording: {text key: new text}, keys as in OneLobbyMenuText.TABLE.
@export var texts := {}

## The client the menu drives. Set it before the menu enters the tree to use your own; default: OneLobbyClient.from_config(config_path).
var client: OneLobbyClient
var model: OneLobbyMenuModel
## The command line the boot flags are read from (default: OS.get_cmdline_user_args()).
var boot_args := PackedStringArray()
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
var _ping_labels := {} # peer id -> Label
var _ping_at := 0
var _syncing := false


func _ready() -> void:
	if not texts.is_empty():
		OneLobbyMenuText.override(texts)
	if client == null:
		client = OneLobbyClient.from_config(config_path)
	if client.get_parent() == null:
		add_child(client)
	if pump:
		client.auto_pump = false
	model = OneLobbyMenuModel.new(client)
	model.host_options = host_options
	model.join_options = join_options
	model.route = route
	model.invite_base = invite_base
	model.check_runner = check_runner
	# `--local` (after `--`): 127.0.0.1 only, nothing leaves this PC, so the check does not run by itself (the button still does).
	# Read here, not from boot_flags: a game that applies the boot flags itself later would be too late for the check on open.
	model.local_only = OneLobbyMenuModel.args_say_local(boot_args if not boot_args.is_empty() else OS.get_cmdline_user_args())
	model.changed.connect(_refresh)
	model.game_started.connect(func(l: OneLobbyLobby) -> void: game_started.emit(l))
	model.returned_to_lobby.connect(func(l: OneLobbyLobby) -> void: returned_to_lobby.emit(l))
	model.left.connect(func() -> void: left.emit())
	_bind()
	_apply_static_text()
	_refresh()
	if boot_flags:
		var args := boot_args if not boot_args.is_empty() else OS.get_cmdline_user_args()
		model.apply_boot_flags(args)


func _process(_delta: float) -> void:
	if pump and client != null:
		client.pump()
	if model == null or model.screen != OneLobbyMenuModel.Screen.LOBBY:
		return
	%CountdownLabel.text = model.countdown_text()
	%CountdownLabel.visible = model.counting_down()
	var now := Time.get_ticks_msec()
	if now - _ping_at > 500:
		_ping_at = now
		_update_pings()


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
	%BrowseBackButton.pressed.connect(func() -> void: model.back())
	var auto: OptionButton = %AutoStartOption
	auto.clear()
	for key in ["auto_start_off", "auto_start_all_ready", "auto_start_players"]:
		auto.add_item(OneLobbyMenuText.t(key))


func _commit_name() -> void:
	if model == null or _syncing:
		return
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
	%BrowseTitle.text = T.t("browse_title")
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
	%BrowseButton.visible = model.can_browse()
	%StartNote.text = model.start_note
	%StartNote.visible = model.start_note != ""
	%StartCheckLine.text = model.start_check_line()
	%StartCheckLine.visible = model.start_check_line() != ""
	if entering:
		model.start_shown.call_deferred() # not before a boot flag has had its say; the model runs the check once
	if entering:
		_set_text(%NameEdit, model.name_text)
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
	%BrowseStatus.text = model.browse_status
	%BrowseStatus.visible = model.browse_status != ""
	var sig := JSON.stringify(model.browse_items)
	if sig == _browse_sig:
		return
	_browse_sig = sig
	_clear(%BrowseList)
	for it: Dictionary in model.browse_items:
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
