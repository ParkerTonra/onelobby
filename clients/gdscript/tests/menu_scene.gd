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
	await _layouts()
	await _smoke()
	await _on_open_scene()
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
