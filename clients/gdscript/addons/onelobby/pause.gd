class_name OneLobbyPause
extends RefCounted
## The shared pause (spec/binary.md "Pause", docs/recipes/pause.md): any player asks the host to pause or resume the match
## for everyone. The host validates (phase, rate, policy), keeps the state and broadcasts it over the reliable channel;
## in a lockstep lobby it also stops emitting frames while paused. OneLobby moves the state; scaling time, menus and
## banners stay in the game. It is outside the sim: never put it in a lockstep command or hash. Reach it as `lobby.pause`;
## the same wire as the JS `lobby.pause` and C# `lobby.Pause`.
##
##     lobby.pause.changed.connect(func(s: Dictionary) -> void: get_tree().paused = s["paused"])
##     lobby.pause.request(true)
##
## The state is {paused, by_peer, pauser_left}: `by_peer` is the peer that paused (or last resumed); `pauser_left` says the
## pauser left and the host now holds the pause (`by_peer` is then the host).

## The state changed (paused, resumed, pauser left, cleared). Fires on every peer.
signal changed(state: Dictionary)
## A request of yours was refused: "not_in_game", "rate_limited" or "not_allowed".
signal refused(code: String)

## The least time between two accepted pause requests from one peer.
const MIN_REQUEST_GAP_MS := 500
const FLAG_PAUSER_LEFT := 1
const REFUSE_NOT_IN_GAME := 1
const REFUSE_RATE_LIMITED := 2
const REFUSE_NOT_ALLOWED := 3

## "anyone" (the default), "host" (only the host pauses or resumes) or "off" (request() raises "pause_disabled"). A
## blueprint sets it from `session.pause`.
var mode := "anyone"
## Host: replaces the default policy: `func(peer_id: int, want_paused: bool) -> bool`, true to allow. Default: anyone
## pauses, the pauser or the host resumes (host only in "host" mode). Phase and rate limit run first.
var policy := Callable()

var _l: OneLobbyLobby
var _state := {"paused": false, "by_peer": 0, "pauser_left": false}
var _last_accepted := {}


func _init(lobby: OneLobbyLobby) -> void:
	_l = lobby


## The current shared state (the same on every peer once the host's broadcast has arrived): {paused, by_peer, pauser_left}.
var state: Dictionary:
	get: return _state.duplicate()


## True when the local peer may resume now under the default policy: the pauser or the host (in "host" mode, the host). A
## custom `policy` lives on the host, so on a joiner this is a hint.
var can_resume: bool:
	get: return _l != null and bool(_state["paused"]) and _default_allows(_l.local_peer_id, false)


## Asks to pause (true) or resume (false) the match for everyone. Works only while the lobby is in game (phase "in_game",
## after start()): before that the host refuses with "not_in_game". The result arrives as `changed` or `refused`; asking
## for the state that already holds does nothing. Returns false, and raises the client error "pause_disabled", when the
## blueprint says `session.pause` is "off".
func request(paused: bool) -> bool:
	if _l == null:
		return false
	if mode == "off":
		_l._c.raise_error("pause_disabled", "pause is off in onelobby.json (session.pause is \"off\"); set session.pause to \"anyone\" or \"host\" to turn it on")
		return false
	if _l.is_host:
		_host_handle(_l.local_peer_id, paused)
	else:
		_l._send_msg_to_host({"type": "pause_request", "paused": 1 if paused else 0})
	return true


## Host only: unpauses at once, skipping the policy and the rate limit. Call it before a restart or game over so the next
## round does not start frozen. Does nothing when not paused.
func clear() -> void:
	if _l == null or not _l._require_host("clear the pause"):
		return
	if not _state["paused"]:
		return
	_apply({"paused": false, "by_peer": _l.local_peer_id, "pauser_left": false}, true)


# ---- internals (called by the lobby) -------------------------------------------------------------------------------

func _detach() -> void:
	_l = null


func _handle(from: int, m: Dictionary) -> void:
	match str(m["type"]):
		"pause_request":
			if _l.is_host and _l._hello_ids().has(from):
				_host_handle(from, int(m["paused"]) != 0)
		"pause_state":
			if not _l.is_host and from == _l.host_peer_id:
				_apply({"paused": int(m["paused"]) != 0, "by_peer": int(m["byPeer"]), "pauser_left": (int(m["flags"]) & FLAG_PAUSER_LEFT) != 0}, false)
		"pause_refuse":
			if not _l.is_host and from == _l.host_peer_id:
				refused.emit(_refusal_name(int(m["reason"])))


## Host: a peer's link just said hi; it gets the state when there is one to tell.
func _send_state(peer_id: int) -> void:
	if _state["paused"]:
		_l._send_msg(peer_id, _state_message())


## A peer is gone: the host takes over the pause its leaver held.
func _on_peer_left(peer_id: int) -> void:
	_last_accepted.erase(peer_id)
	var s := _state
	if _l.is_host and s["paused"] and not s["pauser_left"] and s["by_peer"] == peer_id:
		_apply({"paused": true, "by_peer": _l.local_peer_id, "pauser_left": true}, true)


## This peer just became the host (migration): it keeps the state as is, and takes over a pause whose holder is gone.
func _on_became_host() -> void:
	_l.lockstep.hold(_state["paused"])
	var s := _state
	if s["paused"] and not s["pauser_left"] and not _l._peers.has(int(s["by_peer"])):
		_apply({"paused": true, "by_peer": _l.local_peer_id, "pauser_left": true}, true)


## The lobby went back to the lobby phase: nothing stays paused.
func _on_lobby_phase() -> void:
	if not _state["paused"]:
		return
	_apply({"paused": false, "by_peer": _l.host_peer_id, "pauser_left": false}, _l.is_host)


static func _refusal_name(code: int) -> String:
	return "not_in_game" if code == REFUSE_NOT_IN_GAME else ("rate_limited" if code == REFUSE_RATE_LIMITED else ("not_allowed" if code == REFUSE_NOT_ALLOWED else "unknown"))


# ---- host path -----------------------------------------------------------------------------------------------------

func _default_allows(peer: int, want_paused: bool) -> bool:
	if mode == "host":
		return peer == _l.host_peer_id
	return want_paused or peer == int(_state["by_peer"]) or peer == _l.host_peer_id


func _host_handle(from: int, want: bool) -> void:
	if mode == "off":
		_refuse(from, want, REFUSE_NOT_ALLOWED)
		return
	if _l.phase != "in_game":
		_refuse(from, want, REFUSE_NOT_IN_GAME)
		return
	if want == bool(_state["paused"]):
		return
	var now := _l.now_ms()
	if _last_accepted.has(from) and now - int(_last_accepted[from]) < MIN_REQUEST_GAP_MS:
		_refuse(from, want, REFUSE_RATE_LIMITED)
		return
	var ok: bool = bool(policy.call(from, want)) if policy.is_valid() else _default_allows(from, want)
	if not ok:
		_refuse(from, want, REFUSE_NOT_ALLOWED)
		return
	_last_accepted[from] = now
	_apply({"paused": want, "by_peer": from, "pauser_left": false}, true)


func _refuse(to: int, want: bool, reason: int) -> void:
	if to == _l.local_peer_id:
		refused.emit(_refusal_name(reason))
	else:
		_l._send_msg(to, {"type": "pause_refuse", "paused": 1 if want else 0, "reason": reason})


func _state_message() -> Dictionary:
	return {"type": "pause_state", "paused": 1 if _state["paused"] else 0, "byPeer": _state["by_peer"], "flags": FLAG_PAUSER_LEFT if _state["pauser_left"] else 0}


func _apply(next: Dictionary, broadcast: bool) -> void:
	var prev := _state
	_state = next
	if _l == null:
		return
	_l.lockstep.hold(bool(next["paused"]))
	if broadcast:
		var msg := _state_message()
		for p: int in _l._hello_ids():
			_l._send_msg(p, msg)
	if prev["paused"] != next["paused"] or prev["by_peer"] != next["by_peer"] or prev["pauser_left"] != next["pauser_left"]:
		changed.emit(next.duplicate())
