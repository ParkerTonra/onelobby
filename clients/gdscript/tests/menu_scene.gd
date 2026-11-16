extends SceneTree
## The menu scene (menu.tscn) and the demo, headless, on 127.0.0.1: at 1280x720 and 640x360 every screen is walked and checked
## (the nodes named in menu.gd's header exist, nothing has zero size, no text is clipped, focus lands on a visible control,
## ui_cancel goes back, the relay line is in no label); then two menus in one process (the demo scene) started with the boot flags
## --host and --join=<code> both reach game_started.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/menu_scene.gd
## Prints "menu_scene: N passed, M failed"; exits 1 on any failure.

const Screen := OneLobbyMenuModel.Screen
const RELAY := "turn:127.0.0.1:9 samuser sampass77"

var _pass := 0
var _fail := 0
var _port := 49500


## A finder with no socket, for the layout checks of the LAN list (the model's `finder_factory` seam).
class FakeFinder:
	extends RefCounted
	signal changed(games: Array)
	signal status_changed(status: String, reason: String)
	var status := "idle"
	var games: Array[Dictionary] = []

	func start() -> String:
		status = "running"
		return status

	func stop() -> void:
		status = "idle"
		games = []

	func ask_now() -> void:
		pass


func _init() -> void:
	process_frame.connect(func() -> void:
		if Time.get_ticks_msec() > 200000:
			print("menu_scene FAIL: timed out")
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


func _client(display: String) -> OneLobbyClient:
	# no check on open here (checkOnOpen false): these tests never touch the network; _on_open_scene covers the check with a fake
	var c := OneLobbyClient.from_config({"game": {"id": "menu-scene"}, "engine": "godot-gdscript", "diagnostics": {"checkOnOpen": false}})
	c.display_name = display
	c.store = OneLobbyStore.memory()
	c.settings_env = {}
	c.log_path = ""
	c.lobby_server = "ws://127.0.0.1:1/ws"
	return c


func _host_opts() -> Dictionary:
	var o := {"name": "scene", "max_players": 4, "tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1",
		"udp_port_range": [_port, _port + 15], "nostr": false, "room": {"countdown_seconds": 1}}
	_port += 20
	return o


## The node names in menu.gd's header comment.
func _header_names() -> PackedStringArray:
	var text := FileAccess.get_file_as_string("res://addons/onelobby/menu/menu.gd")
	var out := PackedStringArray()
	var on := false
	for line in text.split("\n"):
		if line.begins_with("## Nodes a controller"):
			on = true
			continue
		if on and line.begins_with("## (The roster"):
			break
		if on and line.begins_with("##"):
			var body := line.substr(2).strip_edges()
			var colon := body.find(":")
			if colon > 0 and colon < 12:
				body = body.substr(colon + 1)
			for w in body.split(" ", false):
				out.append(w)
	return out


func _visible_controls(n: Node, out: Array) -> void:
	for c in n.get_children():
		if c is Control and c.visible:
			out.append(c)
			_visible_controls(c, out)


func _audit(menu: OneLobbyMenu, label: String, viewport: Vector2) -> void:
	await _frames(3)
	var all: Array = []
	_visible_controls(menu, all)
	var bad_zero := 0
	var bad_clip := []
	var relay_seen := false
	for c: Control in all:
		if not c.is_visible_in_tree():
			continue
		if c.size.x <= 0 or c.size.y <= 0:
			bad_zero += 1
			print("  zero size: ", menu.get_path_to(c), " ", c.size)
		if c is Label or c is Button:
			var mn := c.get_combined_minimum_size()
			if c.size.x + 0.5 < mn.x or c.size.y + 0.5 < mn.y:
				bad_clip.append("%s size %s min %s" % [menu.get_path_to(c), c.size, mn])
		if (c is Label and (c.text.contains("samuser") or c.text.contains("sampass77"))) or (c is LineEdit and c.text.contains("sampass77")):
			relay_seen = true
	_check(bad_zero == 0, "%s: nothing has zero size" % label)
	_check(bad_clip.is_empty(), "%s: no text is clipped %s" % [label, str(bad_clip.slice(0, 3))])
	_check(not relay_seen, "%s: the relay line is in no label" % label)
	var pages: Control = menu.get_node("%Pages")
	_check(pages.get_combined_minimum_size().x <= viewport.x, "%s: the page fits the width (%s of %s)" % [label, pages.get_combined_minimum_size().x, viewport.x])
	var f := root.gui_get_focus_owner()
	_check(f != null and f.is_visible_in_tree() and menu.is_ancestor_of(f), "%s: focus is on a visible control (%s)" % [label, f.name if f != null else "none"])


func _cancel() -> void:
	var ev := InputEventAction.new()
	ev.action = "ui_cancel"
	ev.pressed = true
	Input.parse_input_event(ev)


func _run() -> void:
	OneLobbyMenuModel.headless_default = false # the check on open is counted below with a fake runner; the headless rule is tested in menu.gd
	await _layouts()
	await _smoke()
	await _one_shot_flags()
	await _on_open_scene()
	await _lan_scene()
	await _lan_layouts()
	print("menu_scene: %d passed, %d failed" % [_pass, _fail])
	await _frames(5)
	quit(1 if _fail > 0 else 0)


func _layouts() -> void:
	var packed: PackedScene = load("res://addons/onelobby/menu/menu.tscn")
	for size in [Vector2i(1280, 720), Vector2i(640, 360)]:
		root.size = size
		var tag := "%dx%d" % [size.x, size.y]
		var menu: OneLobbyMenu = packed.instantiate()
		menu.client = _client("Sam")
		menu.boot_flags = false
		menu.route = "direct"
		menu.host_options = _host_opts()
		root.add_child(menu)
		await _frames(2)
		for n in _header_names():
			_check(menu.get_node_or_null("%" + n) != null, "%s: node %%%s exists" % [tag, n])
		var m := menu.model
		# start
		await _audit(menu, tag + " start", Vector2(size))
		# settings (with a relay saved: it is only ever shown masked)
		m.open_settings()
		m.save_relay(RELAY)
		await _audit(menu, tag + " settings", Vector2(size))
		m.check_runner = func(_o: Dictionary) -> Dictionary: return {"udp": "ok", "natType": "cone", "relay": "ok"}
		await m.run_check()
		await _audit(menu, tag + " settings after a check", Vector2(size))
		_cancel()
		await _frames(2)
		_check(m.screen == Screen.START, "%s: ui_cancel leaves settings" % tag)
		# connecting
		m._begin("Joining 7HQ 4K2...")
		_check(m.screen == Screen.CONNECTING, "%s: connecting" % tag)
		await _audit(menu, tag + " connecting", Vector2(size))
		_cancel()
		await _frames(2)
		_check(m.screen == Screen.START, "%s: ui_cancel cancels connecting" % tag)
		# error
		m.set_join_text("nonsense")
		await m.join()
		_check(m.screen == Screen.ERROR, "%s: error screen" % tag)
		await _audit(menu, tag + " error", Vector2(size))
		_cancel()
		await _frames(2)
		_check(m.screen == Screen.START, "%s: ui_cancel leaves the error" % tag)
		# browse
		m.route = "auto"
		m.open_browse()
		m.browse_items = [{"code": "7HQ4K2", "name": "A game with a rather long name", "host_name": "Sam", "players": 1, "max_players": 4}]
		m.browse_status = ""
		m.changed.emit()
		await _audit(menu, tag + " browse", Vector2(size))
		_cancel()
		await _frames(2)
		_check(m.screen == Screen.START, "%s: ui_cancel leaves browse" % tag)
		m.route = "direct"
		# lobby: host with a second player, chat, a request, a ban
		await m.host()
		_check(await _until(func() -> bool: return m.room_active()), "%s: hosting" % tag)
		var g := _client("Ann")
		root.add_child(g)
		var gl := await g.join_direct(m.lobby.ip_code)
		_check(gl != null and await _until(func() -> bool: return m.roster_rows().size() == 2), "%s: a second player" % tag)
		m.lobby.chat.send("hello from the host")
		m.requests.append({"peer_id": 9, "name": "Bob the long named requester"})
		m.changed.emit()
		await _audit(menu, tag + " lobby (host)", Vector2(size))
		(menu.get_node("%LobbySettingsToggle") as Button).button_pressed = true
		await _audit(menu, tag + " lobby with settings", Vector2(size))
		m.requests.clear()
		m.ban(m.roster_rows()[1]["id"], "just a test")
		await _until(func() -> bool: return m.ban_rows().size() == 1)
		await _audit(menu, tag + " lobby with a ban", Vector2(size))
		_check(menu.get_node("%CopyInviteButton").visible, "%s: Copy invite is always offered in a lobby" % tag)
		_cancel()
		await m.left
		_check(m.screen == Screen.START, "%s: ui_cancel in the lobby leaves it" % tag)
		g.queue_free()
		menu.queue_free()
		await _frames(3)


## Two menus (the demo scene) in one process: a host from --host, a joiner from --join=<code>, both reach game_started.
func _smoke() -> void:
	root.size = Vector2i(1280, 720)
	var packed: PackedScene = load("res://examples/menu_demo/main.tscn")
	var a: Control = packed.instantiate()
	var am: OneLobbyMenu = a.get_node("Menu")
	am.client = _client("Sam")
	am.boot_args = PackedStringArray(["--host", "--name=Sam"])
	am.route = "direct"
	am.host_options = _host_opts()
	root.add_child(a)
	_check(await _until(func() -> bool: return am.model.screen == Screen.LOBBY and am.model.lobby.ip_code != ""), "smoke: --host reaches the lobby")
	var b: Control = packed.instantiate()
	var bm: OneLobbyMenu = b.get_node("Menu")
	bm.client = _client("Player")
	bm.boot_args = PackedStringArray(["--join=" + am.model.lobby.ip_code, "--name=Ann"])
	root.add_child(b)
	_check(await _until(func() -> bool: return bm.model.screen == Screen.LOBBY and am.model.roster_rows().size() == 2), "smoke: --join reaches the lobby")
	_check(bm.model.name_text == "Ann", "smoke: --name sets the joiner's name")
	am.model.start_game()
	var ok := await _until(func() -> bool: return am.model.screen == Screen.PLAYING and bm.model.screen == Screen.PLAYING, 20000)
	_check(ok, "smoke: both sides reach game_started")
	_check(a.get_node("InGame").visible and b.get_node("InGame").visible and not am.visible and not bm.visible, "smoke: the demo shows the in game label and the menu hides itself")
	_check(String(a.get_node("InGame").text).begins_with("in game"), "smoke: the label text: %s" % a.get_node("InGame").text)
	am.model.lobby.room.back_to_lobby()
	_check(await _until(func() -> bool: return am.visible and bm.visible and not a.get_node("InGame").visible), "smoke: back to the lobby shows the menu again")
	a.queue_free()
	b.queue_free()


## Process flags are one-shot: two menus in one process with `--host --local`, only the first hosts (the second is still local); boot_args is never consumed.
func _one_shot_flags() -> void:
	var packed: PackedScene = load("res://addons/onelobby/menu/menu.tscn")
	OneLobbyMenu.process_args_override = PackedStringArray(["--host", "--local", "--name=Sam"])
	OneLobbyMenu.reset_process_flags()
	var make := func(boot: PackedStringArray) -> OneLobbyMenu:
		var menu: OneLobbyMenu = packed.instantiate()
		var c := OneLobbyClient.from_config({"game": {"id": "menu-scene"}, "engine": "godot-gdscript", "diagnostics": {"checkOnOpen": false}})
		c.store = OneLobbyStore.memory()
		c.settings_env = {}
		c.log_path = ""
		c.lobby_server = "ws://127.0.0.1:1/ws"
		menu.client = c
		menu.boot_args = boot
		menu.host_options = _host_opts()
		root.add_child(menu)
		return menu
	var first: OneLobbyMenu = make.call(PackedStringArray())
	_check(await _until(func() -> bool: return first.model.screen == Screen.LOBBY and first.model.lobby != null and first.model.lobby.is_host), "one-shot: the first menu hosted from the process flags")
	var second: OneLobbyMenu = make.call(PackedStringArray())
	await _frames(30)
	_check(second.model.screen == Screen.START and second.model.lobby == null, "one-shot: the second menu did not host again (screen %d)" % second.model.screen)
	_check(second.model.local_only and second.model.route == "direct", "one-shot: the second menu still reads --local")
	_check(second.model.name_text != "Sam", "one-shot: the second menu did not take --name again")
	# negative control: after reset the flags are readable again
	OneLobbyMenu.reset_process_flags()
	var third: OneLobbyMenu = make.call(PackedStringArray())
	_check(await _until(func() -> bool: return third.model.screen == Screen.LOBBY), "one-shot control: after reset_process_flags a new menu hosts")
	# boot_args is never consumed: two menus with the same boot_args both act on it
	var args_a: OneLobbyMenu = make.call(PackedStringArray(["--name=Ann"]))
	var args_b: OneLobbyMenu = make.call(PackedStringArray(["--name=Ann"]))
	await _frames(3)
	_check(args_a.model.name_text == "Ann" and args_b.model.name_text == "Ann", "boot_args is acted on by every menu that has it")
	OneLobbyMenu.process_args_override = null
	OneLobbyMenu.reset_process_flags()
	for n: OneLobbyMenu in [first, second, third, args_a, args_b]:
		if n.model.lobby != null and not n.model.lobby.is_closed():
			n.model.lobby.leave()
		n.client.queue_free()
		n.queue_free()
	await _frames(3)


## The check on open, in the real scene (menu.tscn), with a counted fake runner: once on open and the start-screen line; never with
## --local or when a boot flag hosts; and a menu freed while the check runs leaves nothing behind that is called later.
func _on_open_scene() -> void:
	var packed: PackedScene = load("res://addons/onelobby/menu/menu.tscn")
	var state := {"runs": 0, "gate": false}
	var runner := func(_o: Dictionary) -> Dictionary:
		state["runs"] += 1
		while not state["gate"]:
			await process_frame
		return {"udp": "ok", "natType": "symmetric", "relay": "none"}
	var cfg := {"game": {"id": "menu-scene"}, "engine": "godot-gdscript"}
	var open := func(boot: PackedStringArray, blueprint: Dictionary) -> OneLobbyMenu:
		var menu: OneLobbyMenu = packed.instantiate()
		var c := OneLobbyClient.from_config(blueprint)
		c.display_name = "Sam"
		c.store = OneLobbyStore.memory()
		c.settings_env = {}
		c.log_path = ""
		c.lobby_server = "ws://127.0.0.1:1/ws"
		menu.client = c
		menu.boot_flags = not boot.is_empty()
		menu.boot_args = boot
		menu.route = "direct"
		menu.host_options = _host_opts()
		menu.check_runner = runner
		root.add_child(menu)
		return menu
	# the default: runs once, shows nothing while it runs, shows the verdict on the start screen after, Settings is filled in
	var menu: OneLobbyMenu = open.call(PackedStringArray(), cfg)
	await _frames(3)
	var line: Label = menu.get_node("%StartCheckLine")
	_check(state["runs"] == 1 and menu.model.check_running and not line.visible, "on open: the check runs once and the start screen shows nothing while it runs")
	state["gate"] = true
	await _frames(3)
	_check(not menu.model.check_running and line.visible and line.text == "Direct connections: likely to fail. A relay is recommended.", "on open: the start screen shows the warning sentence: '%s'" % line.text)
	menu.model.open_settings()
	await _frames(2)
	var verdict: Label = menu.get_node("%CheckVerdict")
	_check(verdict.visible and verdict.text == line.text and (menu.get_node("%CheckFacts") as Label).text.count("\n") == 2, "on open: Settings shows the verdict and three facts already filled in")
	menu.model.back()
	await _frames(2)
	_check(state["runs"] == 1, "on open: coming back from Settings does not run it again")
	menu.queue_free()
	await _frames(2)
	# --local: never by itself
	state["runs"] = 0
	menu = open.call(PackedStringArray(["--local"]), cfg)
	await _frames(4)
	_check(state["runs"] == 0, "--local: the check does not run by itself")
	menu.queue_free()
	await _frames(2)
	# --name with no --host or --join (--local keeps the check on open out of this): the name field shows it, and leaving the field keeps it
	menu = open.call(PackedStringArray(["--name=Zoe", "--local"]), cfg)
	await _frames(3)
	var flag_name := menu.get_node("%NameEdit") as LineEdit
	_check(menu.model.screen == Screen.START and flag_name.text == "Zoe", "--name alone: the name field shows the name (field '%s', model '%s')" % [flag_name.text, menu.model.name_text])
	flag_name.focus_exited.emit()
	_check(menu.model.name_text == "Zoe", "--name alone: leaving the name field keeps the name ('%s')" % menu.model.name_text)
	flag_name.text = "Kim"
	flag_name.text_changed.emit("Kim") # what typing does
	menu.model.changed.emit()
	_check(flag_name.text == "Kim" and menu.model.name_text == "Zoe", "a name being typed survives a redraw (field '%s')" % flag_name.text)
	flag_name.focus_exited.emit()
	_check(menu.model.name_text == "Kim", "the typed name is taken when the field is left ('%s')" % menu.model.name_text)
	menu.model.set_name("Lee")
	menu.model.changed.emit()
	_check(flag_name.text == "Lee", "after that the field follows the model again ('%s')" % flag_name.text)
	menu.queue_free()
	await _frames(2)
	# a boot flag that hosts: the start screen is not what the player sees, so nothing runs
	menu = open.call(PackedStringArray(["--host", "--name=Sam"]), cfg)
	_check(await _until(func() -> bool: return menu.model.screen == Screen.LOBBY), "boot --host reaches the lobby with a default blueprint")
	await _frames(3)
	_check(state["runs"] == 0, "a boot --host never ran the check (%d runs)" % state["runs"])
	menu.queue_free()
	await _frames(3)
	# checkOnOpen false, showConnectionCheck false: nothing; the button still works for the first
	menu = open.call(PackedStringArray(), cfg.merged({"diagnostics": {"checkOnOpen": false}}))
	await _frames(4)
	_check(state["runs"] == 0, "checkOnOpen false: nothing runs on open")
	(menu.get_node("%ConnectionCheckButton") as Button).pressed.emit()
	await _frames(2)
	_check(state["runs"] == 1, "checkOnOpen false: the button runs it")
	state["gate"] = true
	menu.queue_free()
	await _frames(3)
	state["runs"] = 0
	menu = open.call(PackedStringArray(), cfg.merged({"diagnostics": {"showConnectionCheck": false}}))
	await _frames(4)
	_check(state["runs"] == 0, "showConnectionCheck false: nothing runs on open")
	menu.queue_free()
	await _frames(3)
	# the menu freed while the check runs: the answer comes back to a dead node and nothing is called on it
	state["runs"] = 0
	state["gate"] = false
	menu = open.call(PackedStringArray(), cfg)
	await _frames(3)
	_check(state["runs"] == 1 and menu.model.check_running, "freed mid-check: the check is running")
	var model := menu.model
	menu.queue_free()
	await _frames(3)
	state["gate"] = true
	await _frames(5)
	_check(not is_instance_valid(menu) and not model.check_running, "freed mid-check: the late answer ended quietly (the model is done, the menu is gone)")


# ---- LAN games in the real scene: real sockets on 127.0.0.1 only, every menu opened with --local ----------------------------------

func _lan_config(server: bool) -> Dictionary:
	return {"game": {"id": "menu-scene-lan"}, "engine": "godot-gdscript", "diagnostics": {"checkOnOpen": false},
		"hosting": {"direct": true, "server": server, "lan": true, "nostr": false, "openPort": false, "lobbyServer": "ws://127.0.0.1:1/ws"}}


func _lan_menu(display: String, boot: PackedStringArray, cfg: Dictionary) -> OneLobbyMenu:
	var packed: PackedScene = load("res://addons/onelobby/menu/menu.tscn")
	var menu: OneLobbyMenu = packed.instantiate()
	var c := OneLobbyClient.from_config(cfg)
	c.display_name = display
	c.store = OneLobbyStore.memory()
	c.settings_env = {}
	c.log_path = ""
	menu.client = c
	menu.boot_args = boot
	menu.boot_flags = true
	menu.host_options = _host_opts()
	root.add_child(menu)
	return menu


## Every OneLobbyLanFinder under `n`.
func _finders(n: Node, out: Array = []) -> Array:
	for c in n.get_children():
		if c is OneLobbyLanFinder:
			out.append(c)
		_finders(c, out)
	return out


## True when nothing holds this UDP port on 127.0.0.1 (a probe socket binds it).
func _port_free(port: int) -> bool:
	var probe := PacketPeerUDP.new()
	var ok := probe.bind(port, "127.0.0.1") == OK
	probe.close()
	return ok


## `netstat -ano` rows of this process (printed with --netstat after `--`, for the report's socket list).
func _netstat(tag: String) -> void:
	if not OS.get_cmdline_user_args().has("--netstat"):
		return
	var out := []
	OS.execute("netstat", ["-ano"], out)
	var pid := str(OS.get_process_id())
	for line: String in str(out[0]).split("\n"):
		var cols := line.strip_edges().split(" ", false)
		if cols.size() >= 4 and cols[cols.size() - 1] == pid:
			print("NETSTAT %s: %s" % [tag, " ".join(cols)])


func _lan_scene() -> void:
	root.size = Vector2i(1280, 720)
	# the host: --local, hosting.lan true, hosted from the menu
	var hm := _lan_menu("Hosty", PackedStringArray(["--local", "--host", "--name=Hosty"]), _lan_config(false))
	_check(await _until(func() -> bool: return hm.model.screen == Screen.LOBBY and hm.model.lobby.ip_code != ""), "lan: the host menu reaches its lobby")
	# the joiner: --local, nothing is looked for yet
	var jm := _lan_menu("Joey", PackedStringArray(["--local", "--name=Joey"]), _lan_config(false))
	await _frames(3)
	_check(jm.model.local_only and jm.model.route == "direct", "lan: the joiner menu is local (--local)")
	_check(_finders(jm).is_empty() and jm.client._lan_finder == null, "lan: before Browse there is no finder object (%d)" % _finders(jm).size())
	_check((jm.get_node("%BrowseButton") as Button).visible, "lan: the start screen's Browse button shows with only the LAN list")
	_netstat("before the list opens")
	(jm.get_node("%BrowseButton") as Button).pressed.emit()
	_check((jm.get_node("%BrowseStatus") as Label).text.begins_with("Looking for games"), "lan: the looking sentence shows at once")
	await _frames(2)
	_check(jm.model.screen == Screen.BROWSE and not (jm.get_node("%BrowseTabs") as Control).visible, "lan: Browse opens the LAN list, with no tab bar")
	_check((jm.get_node("%BrowseTitle") as Label).text == "LAN games", "lan: the title says LAN games")
	var fs := _finders(jm)
	_check(fs.size() == 1 and fs[0].is_running() and fs[0].local_port > 0, "lan: one finder is running with its own port while the list is open")
	var fport: int = fs[0].local_port if fs.size() == 1 else 0
	_check(not _port_free(fport), "lan: the finder's port %d is taken while the list is open" % fport)
	_netstat("list open")
	_check(await _until(func() -> bool: return jm.model.lan_rows().size() == 1, 3000), "lan: the host shows in the LAN list within 3 seconds")
	await _frames(2)
	var row: Dictionary = jm.model.lan_rows()[0] if jm.model.lan_rows().size() == 1 else {}
	_check(row.get("address") == "127.0.0.1" and int(row.get("port", 0)) > 0, "lan: the row's address and port (%s:%s)" % [row.get("address"), row.get("port")])
	_check(row.get("name") == "scene" and row.get("host_name") == "Hosty" and row.get("players") == 1 and row.get("max_players") == 4 and not row.get("has_password", true),
		"lan: the row's four fields: %s" % str(row))
	var list: Control = jm.get_node("%BrowseList")
	var labels := list.find_children("*", "Label", true, false)
	_check(list.get_child_count() == 1 and labels.size() >= 1 and (labels[0] as Label).text == "scene (Hosty) 1/4", "lan: the scene draws the row: '%s'" % ((labels[0] as Label).text if not labels.is_empty() else ""))
	_check(not (jm.get_node("%BrowseStatus") as Label).visible, "lan: no status line with a row")
	# the row goes after the host leaves (the finder drops a row 4 seconds after its last answer)
	await hm.model.leave()
	_check(await _until(func() -> bool: return jm.model.lan_rows().is_empty(), 9000), "lan: the row goes after the host leaves")
	_check(await _until(func() -> bool: return list.get_child_count() == 0, 2000), "lan: and the scene's list is empty again")
	# Back closes the finder: no node, the port is free again
	_cancel()
	await _frames(3)
	_check(jm.model.screen == Screen.START and _finders(jm).is_empty() and jm.client._lan_finder == null, "lan: Back leaves no finder object")
	_check(_port_free(fport), "lan: the finder's port is free again after Back")
	_netstat("after Back")
	# a host again; a click on the row joins by address:port and closes the finder
	var host2 := _lan_menu("Hosty2", PackedStringArray(["--local", "--host", "--name=Hosty2"]), _lan_config(false))
	_check(await _until(func() -> bool: return host2.model.screen == Screen.LOBBY and host2.model.lobby.ip_code != ""), "lan: a second host menu reaches its lobby")
	(jm.get_node("%BrowseButton") as Button).pressed.emit()
	_check(await _until(func() -> bool: return jm.model.lan_rows().size() == 1, 4000), "lan: it is found again on the second opening")
	fport = _finders(jm)[0].local_port
	await _frames(2)
	var join_button := (jm.get_node("%BrowseList") as Control).find_children("*", "Button", true, false)
	_check(join_button.size() == 1 and not (join_button[0] as Button).disabled, "lan: the row has a Join button")
	var want := "%s:%d" % [row.get("address"), int(jm.model.lan_rows()[0]["port"])]
	(join_button[0] as Button).pressed.emit() # the join starts at once: its first await comes after the screen changes
	_check(jm.model.screen == Screen.CONNECTING and _finders(jm).is_empty() and _port_free(fport), "lan: a click on the row joins and the finder's socket is closed (screen %s)" % jm.model.screen_name())
	_check(jm.model.join_text == want, "lan: the join got '%s'" % jm.model.join_text)
	jm.model.cancel_connecting()
	await _frames(3)
	# a menu freed while the LAN list is open leaves no socket
	(jm.get_node("%BrowseButton") as Button).pressed.emit()
	await _frames(3)
	var held: int = _finders(jm)[0].local_port
	_check(held > 0 and not _port_free(held), "lan: the list is open again (port %d)" % held)
	jm.queue_free()
	await _frames(4)
	_check(_port_free(held), "lan: a menu freed while the LAN list is open leaves no socket (port %d free)" % held)
	# hidden while the list is open: no finder; shown again: it looks again
	var vm := _lan_menu("Vera", PackedStringArray(["--local", "--name=Vera"]), _lan_config(false))
	await _frames(2)
	vm.model.open_browse()
	await _frames(2)
	held = _finders(vm)[0].local_port
	vm.visible = false
	await _frames(2)
	_check(_finders(vm).is_empty() and _port_free(held), "lan: hiding the menu closes the finder")
	vm.visible = true
	await _frames(2)
	_check(_finders(vm).size() == 1, "lan: showing it again looks again")
	# a game starting hides the menu and closes the finder
	vm.model._set_screen(Screen.PLAYING)
	await _frames(2)
	_check(_finders(vm).is_empty() and not vm.visible, "lan: a game starting closes the finder")
	vm.queue_free()
	# both lists: a tab bar; the tabs start and stop the finder
	var bm := _lan_menu("Bea", PackedStringArray(["--local", "--name=Bea"]), _lan_config(true))
	await _frames(2)
	bm.model.route = "auto" # --local forces the direct route; the lobby server list needs the server route to count as available
	bm.model.open_browse()
	await _frames(2)
	_check((bm.get_node("%BrowseTabs") as Control).visible and (bm.get_node("%BrowseTitle") as Label).text == "Games to join", "lan: with both lists the tab bar shows")
	_check(bm.model.shown_list() == "online" and _finders(bm).is_empty(), "lan: it opens on Online, with no finder")
	(bm.get_node("%BrowseTabLanButton") as Button).pressed.emit()
	await _frames(2)
	_check(bm.model.shown_list() == "lan" and _finders(bm).size() == 1, "lan: the LAN tab starts a finder")
	held = _finders(bm)[0].local_port
	(bm.get_node("%BrowseTabOnlineButton") as Button).pressed.emit()
	await _frames(2)
	_check(_finders(bm).is_empty() and _port_free(held), "lan: the Online tab closes it")
	(bm.get_node("%BrowseTabLanButton") as Button).pressed.emit()
	await _frames(2)
	bm.model.back()
	await _frames(2)
	_check(_finders(bm).is_empty(), "lan: Back from the LAN tab closes it")
	bm.model.open_browse()
	await _frames(2)
	_check(bm.model.shown_list() == "lan" and _finders(bm).size() == 1, "lan: Browse opens on the tab used last")
	bm.queue_free()
	await _frames(3)
	# the host that was joined, left
	host2.queue_free()
	hm.queue_free()
	await _frames(3)


## The LAN list at both sizes: rows (a long name, a password, another version), the empty state and the tab bar, audited like every screen.
func _lan_layouts() -> void:
	var packed: PackedScene = load("res://addons/onelobby/menu/menu.tscn")
	for size in [Vector2i(1280, 720), Vector2i(640, 360)]:
		root.size = size
		var tag := "%dx%d" % [size.x, size.y]
		var menu: OneLobbyMenu = packed.instantiate()
		var c := OneLobbyClient.from_config(_lan_config(true))
		c.display_name = "Sam"
		c.store = OneLobbyStore.memory()
		c.settings_env = {}
		c.log_path = ""
		menu.client = c
		menu.boot_flags = false
		var fake := FakeFinder.new()
		menu.finder_factory = func(_o: Dictionary) -> FakeFinder: return fake
		root.add_child(menu)
		await _frames(2)
		var m := menu.model
		m.open_browse()
		m.set_browse_tab("lan")
		await _audit(menu, tag + " LAN list, looking", Vector2(size))
		var long_name := "A lobby with a rather long name indeed"
		fake.games = [
			{"address": "192.168.1.20", "port": 47810, "name": long_name, "host_name": "Sam", "players": 2, "max_players": 4, "has_password": false, "same_version": true, "net_version": "1", "last_seen_ms": 0},
			{"address": "192.168.1.21", "port": 47810, "name": "Locked", "host_name": "Ann", "players": 1, "max_players": 8, "has_password": true, "same_version": true, "net_version": "1", "last_seen_ms": 0},
			{"address": "192.168.1.22", "port": 47810, "name": "<b>Old</b>", "host_name": "Bob", "players": 1, "max_players": 4, "has_password": false, "same_version": false, "net_version": "0", "last_seen_ms": 0}]
		fake.changed.emit(fake.games)
		await _audit(menu, tag + " LAN list, three rows", Vector2(size))
		var texts := PackedStringArray()
		for l in (menu.get_node("%BrowseList") as Control).find_children("*", "Label", true, false):
			texts.append((l as Label).text)
		_check("<b>Old</b> (Bob) 1/4" in texts and "Needs a password" in texts and "You and the host are running different versions of the game." in texts, "%s: the rows draw as text, with the password mark and the reason: %s" % [tag, str(texts)])
		var buttons := (menu.get_node("%BrowseList") as Control).find_children("*", "Button", true, false)
		_check(buttons.size() == 3 and not (buttons[0] as Button).disabled and (buttons[2] as Button).disabled, "%s: the other-version row's Join is disabled" % tag)
		_check((menu.get_node("%BrowseLanPasswordEdit") as Control).visible, "%s: the password field shows above the LAN rows" % tag)
		fake.games = []
		fake.changed.emit(fake.games)
		await _audit(menu, tag + " LAN list, empty", Vector2(size))
		_cancel()
		await _frames(2)
		menu.queue_free()
		await _frames(2)
