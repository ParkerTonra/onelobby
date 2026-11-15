extends SceneTree
## describe_error, the ice_failed messages and invite links against the shared vectors (spec/vectors/describe-error.json,
## invite-link.json). No network.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/friendly.gd
## Prints "friendly: N passed, M failed"; exits 1 on any failure.

var _pass := 0
var _fail := 0


func _check(ok: bool, what: String) -> void:
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL: ", what)


func _load(path: String) -> Dictionary:
	var spec := ProjectSettings.globalize_path("res://").path_join("../../spec").simplify_path()
	var d: Variant = JSON.parse_string(FileAccess.get_file_as_string(spec.path_join(path)))
	return d if d is Dictionary else {}


func _init() -> void:
	var de := _load("vectors/describe-error.json")
	var cases: Array = de.get("cases", [])
	_check(cases.size() > 60, "describe-error vectors loaded (%d)" % cases.size())
	for c: Dictionary in cases:
		var got := OneLobbyFriendly.describe_error(c["input"])
		_check(got == c["expect"], "describe_error %s: got %s, want %s" % [c["name"], JSON.stringify(got), JSON.stringify(c["expect"])])
	# what the client itself hands out
	_check(OneLobbyFriendly.describe_error({"code": "lobby_full", "message": "technical"})["message"] == "That lobby is full.", "last_error shape")
	var generic: String = OneLobbyFriendly.describe_error(null)["message"]
	for code: String in ["busy", "in_lobby", "no_relay", "unsupported_code", "no_server", "listing_disabled", "bad_config", "identity_anonymous", "ice_failed", "timeout", "invalid_token", "server_closed", "port_in_use", "bad_address", "bad_password"]:
		_check(OneLobbyFriendly.describe_error(code)["message"] != generic, "%s has friendly text" % code)
	# the ice_failed messages (every error line the client raises names the next step)
	var mine := 0
	for m: Dictionary in de.get("iceFailedMessages", []):
		if m.has("clients") and not (m["clients"] as Array).has("gdscript"):
			continue
		mine += 1
		var got: String
		if m.has("portRange"):
			got = OneLobbyLobby.port_range_full_message(m["portRange"])
		else:
			got = OneLobbyLobby.ice_failed_message(bool(m.get("relayConfigured", false)), bool(m.get("byIp", false)))
		_check(got == m["message"], "ice_failed message %s" % m["name"])
	_check(mine == 5, "five ice_failed messages apply to GDScript (%d)" % mine)

	var inv := _load("vectors/invite-link.json")
	var make: Array = inv.get("make", [])
	var parse: Array = inv.get("parse", [])
	_check(make.size() > 15 and parse.size() > 30, "invite vectors loaded (%d, %d)" % [make.size(), parse.size()])
	for c: Dictionary in make:
		var got := OneLobbyInvite.make(c["code"], c["base"], c.get("param", "join"))
		var want: String = "" if c.has("error") else c["url"]
		_check(got == want, "invite make %s: got %s, want %s" % [c["name"], got, want])
	for c: Dictionary in parse:
		var got := OneLobbyInvite.parse(c["input"], c.get("param", "join"))
		var want: String = "" if c["code"] == null else c["code"]
		_check(got == want, "invite parse %s: got '%s', want '%s'" % [c["name"], got, want])
	print("friendly: %d passed, %d failed" % [_pass, _fail])
	quit(1 if _fail > 0 else 0)
