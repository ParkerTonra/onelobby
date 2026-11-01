class_name OneLobbyNostrHost
extends RefCounted
## The host side of Nostr signaling (spec/nostr-signaling.md s.4): each joiner pubkey becomes one hub session, as if it
## had opened a TCP WebSocket. The hub speaks the usual protocol; this only moves its texts over frames. Port of
## clients/js/packages/client/src/nostr/host.ts. The owner calls poll() every frame.

const PING := '{"t":"ping","n":0}'
const CLOSED_MEMORY := 512

class Peer:
	var link: OneLobbyNostrLink = null
	var session: OneLobbyHub.Session = null

var _hub: OneLobbyHub
var _room: OneLobbyNostrRoom
var _peers := {}     # pub -> Peer
var _gone := {}      # pub -> true (insertion ordered)
var _stopped := false
var _burst := 0
var _new_tokens := 0.0
var _new_tokens_at := -1
var _waiting := {}   # pub -> ticks of last open heard, oldest first
var _wait_timer_at := -1


## A lobby sized for more than NEW_SESSION_BURST players gets a burst that fits it (up to MAX_SESSION_BURST).
static func new_session_burst(max_players: int) -> int:
	return maxi(OneLobbyNostrLimits.NEW_SESSION_BURST, mini(OneLobbyNostrLimits.MAX_SESSION_BURST, max_players))


## Starts hosting `code` (a version 1 join code) for `hub`. Null when the code is not valid.
static func start(hub: OneLobbyHub, code: String, relays: Array, max_players: int) -> OneLobbyNostrHost:
	var h := OneLobbyNostrHost.new()
	h._hub = hub
	h._burst = new_session_burst(max_players)
	h._new_tokens = float(h._burst)
	h._room = OneLobbyNostrRoom.open(code, relays)
	if h._room == null:
		return null
	h._room.on_frame = h._on_frame
	return h


func relays_connected() -> int:
	return _room.relays_connected()


func relays_total() -> int:
	return _room.relays_total()


func relays_settled() -> bool:
	return _room.relays_settled()


## Joiners currently attached.
func peer_count() -> int:
	return _peers.size()


func is_stopped() -> bool:
	return _stopped


func poll() -> void:
	if _stopped:
		return
	_room.poll()
	for p: Peer in _peers.values():
		p.link.poll()
	if _wait_timer_at >= 0 and Time.get_ticks_msec() >= _wait_timer_at:
		_wait_timer_at = -1
		_admit_waiting()


func close() -> void:
	if _stopped:
		return
	_stopped = true
	_wait_timer_at = -1
	_waiting.clear()
	for pub in _peers.keys():
		var p: Peer = _peers[pub]
		p.link.close("host left")
		if p.session != null:
			_hub.disconnect_session(p.session)
		_peers.erase(pub)
	_room.close()


func _on_frame(f: Dictionary) -> void:
	if _stopped:
		return
	var from: String = f["from"]
	var known: Peer = _peers.get(from)
	if f["type"] == "open":
		if _gone.has(from):
			return
		if known != null:
			known.link.heard()
			_answer(from)
		elif _waiting.has(from):
			_waiting[from] = Time.get_ticks_msec()  # still trying: keep its place in the queue
			_admit_waiting()
		elif _waiting.is_empty() and _admit_new():
			_accept(from)
		elif _waiting.size() < OneLobbyNostrLimits.WAITING_MAX:
			_waiting[from] = Time.get_ticks_msec()  # over the cap: answered when a token refills
			_schedule_waiting()
		return
	if known == null:
		return
	known.link.receive(f)
	# a joiner's beat is its keep-alive: the hub counts it as activity (its pong is dropped)
	if f["type"] == "beat" and known.session != null:
		_hub.receive(known.session, PING)


func _schedule_waiting() -> void:
	if _wait_timer_at >= 0 or _waiting.is_empty() or _stopped:
		return
	var missing := maxf(0.0, 1.0 - _new_tokens)
	_wait_timer_at = Time.get_ticks_msec() + maxi(1, ceili(missing * OneLobbyNostrLimits.NEW_SESSION_REFILL_MS))


func _admit_waiting() -> void:
	if _stopped:
		return
	var now := Time.get_ticks_msec()
	for pub in _waiting.keys():
		var heard: int = _waiting[pub]
		if now - heard > OneLobbyNostrLimits.WAITING_STALE_MS or _peers.has(pub) or _gone.has(pub):
			_waiting.erase(pub)
			continue
		if not _admit_new():
			break
		_waiting.erase(pub)
		_accept(pub)
	_schedule_waiting()


func _admit_new() -> bool:
	var now := Time.get_ticks_msec()
	if _new_tokens_at >= 0:
		_new_tokens = minf(float(_burst), _new_tokens + float(now - _new_tokens_at) / OneLobbyNostrLimits.NEW_SESSION_REFILL_MS)
	_new_tokens_at = now
	if _new_tokens < 1.0 - 1e-6:
		return false
	_new_tokens = maxf(0.0, _new_tokens - 1.0)
	return true


func _answer(pub: String) -> void:
	_room.send(pub, {"type": "open", "seq": 0, "ack": 0})


func _accept(pub: String) -> void:
	var peer := Peer.new()
	peer.link = OneLobbyNostrLink.new(
		func(out: Dictionary) -> void: _room.send(pub, out),
		func(text: String) -> void:
			if peer.session != null:
				_hub.receive(peer.session, text),
		func(_r: String) -> void: _detach(pub, peer),
		func(_r: String) -> void: _detach(pub, peer))
	_peers[pub] = peer
	_answer(pub)
	var session := _hub.connect_session(
		"nostr:" + pub.substr(0, 16),
		func(text: String) -> void:
			if not text.begins_with('{"t":"pong"'):  # keep-alive pongs never cross Nostr
				peer.link.send(text),
		func(_code: int, _reason: String) -> void:
			# the hub closed this session: say so, keep the pubkey out for the rest of the session
			peer.link.close()
			_forget(pub, peer))
	if peer.link.is_closed():
		return  # full: the hub already had us close it
	if session == null:
		peer.link.close("closed")
		_forget(pub, peer)
		return
	peer.session = session


func _detach(pub: String, peer: Peer) -> void:
	peer.link.stop()
	if peer.session != null:
		_hub.disconnect_session(peer.session)
	peer.session = null
	_forget(pub, peer)


func _forget(pub: String, peer: Peer) -> void:
	if _peers.get(pub) == peer:
		_peers.erase(pub)
	_gone[pub] = true
	if _gone.size() > CLOSED_MEMORY:
		_gone.erase(_gone.keys()[0])
