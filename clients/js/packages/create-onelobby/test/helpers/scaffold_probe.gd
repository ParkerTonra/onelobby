extends Node
## Test-only. clients/gdscript/scaffold-test.sh copies this into a scratch project and registers it as an autoload, then
## starts the game exactly as AGENTS.md and the .olc entry say (two processes, `-- --host --local ...` and `-- --join=... --local ...`).
## It watches the drop-in menu and prints one verdict line:
##   PROBE_HOST_LISTENING code=<code>   the host's menu reached the lobby
##   PROBE_OK <role> players=<n>        the menu is in the lobby with two players (the joiner quits a moment later; the host waits to be stopped)
##   PROBE_FAIL <role> <the menu's own error text, or what it was still showing>
## Nothing here is part of the template.

const NEED_PLAYERS := 2
const GIVE_UP_MS := 45000
const HOST_LINGER_MS := 40000 # the host waits to be stopped by the test
const JOINER_LINGER_MS := 3000 # the joiner stays a moment so the host sees it too

var _role := "host"
var _t0 := 0
var _listening := false
var _ok_at := -1


func _ready() -> void:
	_t0 = Time.get_ticks_msec()
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--join="):
			_role = "joiner"


func _screen_name(model: Object) -> String:
	return str(OneLobbyMenuModel.Screen.keys()[int(model.get("screen"))])


func _end(ok: bool, what: String) -> void:
	print(("PROBE_OK " if ok else "PROBE_FAIL ") + _role + " " + what)
	if ok:
		_ok_at = Time.get_ticks_msec()
		return
	get_tree().quit(0 if ok else 1)


func _process(_delta: float) -> void:
	var now := Time.get_ticks_msec()
	if _ok_at >= 0:
		if now - _ok_at > (HOST_LINGER_MS if _role == "host" else JOINER_LINGER_MS):
			get_tree().quit(0)
		return
	var scene := get_tree().current_scene
	var menu: Node = scene.get_node_or_null("Menu") if scene != null else null
	var model: Object = menu.get("model") if menu != null else null
	if model == null:
		if now - _t0 > 10000:
			_end(false, "the main scene has no Menu node with a model after 10 s")
		return
	var screen := int(model.get("screen"))
	if screen == OneLobbyMenuModel.Screen.ERROR:
		var e: Dictionary = model.get("error")
		_end(false, "menu error: %s %s" % [str(e.get("title", "")), str(e.get("message", ""))])
		return
	var lobby: OneLobbyLobby = model.get("lobby")
	if screen == OneLobbyMenuModel.Screen.LOBBY and lobby != null:
		if _role == "host" and not _listening:
			_listening = true
			print("PROBE_HOST_LISTENING code=", lobby.code)
		var n := lobby.room.players().size()
		if n >= NEED_PLAYERS:
			_end(true, "players=%d" % n)
			return
	if now - _t0 > GIVE_UP_MS:
		_end(false, "gave up after %d s: the menu is still on screen %s%s" % [GIVE_UP_MS / 1000, _screen_name(model), "" if lobby == null else " with %d player(s)" % lobby.room.players().size()])
