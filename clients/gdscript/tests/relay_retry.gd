extends SceneTree
## Unit test (no network): a joiner whose host link stalls retries once relay-only when a TURN entry exists, and
## ice_failed names the next step. Run: godot --headless --path clients/gdscript -s res://tests/relay_retry.gd

const MSG_NO_RELAY := "Could not connect to the host. Strict NATs need a relay (TURN), see docs/recipes/turn.md; the host can also port-forward."
const MSG_RELAY := "Could not connect to the host, even through the relay (TURN). Check the relay is reachable (Godot reaches TURN over UDP only); the host can also port-forward."

var _fail := 0


class FakeTransport:
	extends OneLobbyTransport
	var now := 1000
	var created: Array[Dictionary] = []

	func now_ms() -> int:
		return now

	func create_link(opts: Dictionary) -> OneLobbyTransport.OLLink:
		created.append(opts)
		return OneLobbyTransport.OLLink.new() # never opens


func _check(ok: bool, name: String) -> void:
	if not ok:
		_fail += 1
		print("FAIL: ", name)


func _initialize() -> void:
	_has_relay()
	_run_case("no TURN: gives up at the full timeout, no retry", [], false, 10000, false)
	_run_case("TURN: one relay-only retry at half, then gives up", [{"urls": ["stun:s.example:3478"]}, {"urls": ["turn:t.example:3478"], "username": "u", "credential": "p"}], false, 10000, true)
	_run_case("relay_only config: no retry (already relay-only)", [{"urls": "turn:t.example:3478"}], true, 10000, false)
	print("relay retry: passed" if _fail == 0 else "relay retry: FAILED (%d)" % _fail)
	quit(0 if _fail == 0 else 1)


func _has_relay() -> void:
	_check(OneLobbyLobby.has_relay([{"urls": ["turns:t.example:443"]}]), "turns: counts")
	_check(OneLobbyLobby.has_relay([{"urls": "TURN:t.example"}]), "string url, any case")
	_check(not OneLobbyLobby.has_relay([{"urls": ["stun:s.example"]}]), "stun alone is not a relay")
	_check(not OneLobbyLobby.has_relay([]), "empty list")


func _run_case(name: String, ice: Array, relay_only: bool, timeout: int, expect_retry: bool) -> void:
	var t := FakeTransport.new()
	var c := OneLobbyClient.new()
	c.transport = t
	c.ice = ice
	c.relay_only = relay_only
	c.ready_timeout_ms = timeout
	var errors: Array[Array] = []
	c.error.connect(func(code: String, msg: String) -> void: errors.append([code, msg]))
	var l := OneLobbyLobby.new(c, {"you": 2, "hostId": 1, "peers": [{"peerId": 1, "name": "h"}, {"peerId": 2, "name": "j"}]})
	l._start()
	_check(t.created.size() == 1 and bool(t.created[0]["relay_only"]) == relay_only, name + ": first link")
	l._check_ready_timer(t.now + timeout / 2 - 1)
	_check(t.created.size() == 1 and errors.is_empty(), name + ": quiet before half")
	l._check_ready_timer(t.now + timeout / 2)
	if expect_retry:
		_check(t.created.size() == 2 and bool(t.created[1]["relay_only"]) and bool(t.created[1]["initiator"]), name + ": relay-only dial")
		_check(errors.is_empty(), name + ": still connecting after half")
		l._check_ready_timer(t.now + timeout - 1)
		_check(errors.is_empty() and t.created.size() == 2, name + ": quiet until the full budget")
		l._check_ready_timer(t.now + timeout)
		_check(errors.size() == 1 and errors[0][0] == "ice_failed" and errors[0][1] == MSG_RELAY, name + ": relay message")
	else:
		_check(t.created.size() == 1, name + ": no second link")
		if relay_only:
			_check(errors.is_empty(), name + ": relay_only waits for the full timeout")
			l._check_ready_timer(t.now + timeout)
			_check(errors.size() == 1 and errors[0][1] == MSG_RELAY, name + ": relay_only+TURN message")
		else:
			_check(errors.is_empty(), name + ": no give-up at half")
			l._check_ready_timer(t.now + timeout)
			_check(errors.size() == 1 and errors[0][0] == "ice_failed" and errors[0][1] == MSG_NO_RELAY, name + ": no-relay message")
	c.free()
