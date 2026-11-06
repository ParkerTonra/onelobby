class_name OneLobbyNostrSocket
extends OneLobbyTransport.OLSocket
## The joiner's signaling socket over Nostr (spec/nostr-signaling.md s.4): carries the hub protocol to the host through
## a OneLobbyNostrRoom. The client cannot tell it from a TCP WebSocket. Polled: OneLobbyClient calls poll() each frame.


var relay_timeout_ms := OneLobbyNostrLimits.JOINER_FIRST_RELAY_MS
var open_timeout_ms := OneLobbyNostrLimits.GIVE_UP_MS
var open_every_ms := OneLobbyNostrLimits.OPEN_EVERY_MS

var _room: OneLobbyNostrRoom
var _link: OneLobbyNostrLink
var _host_pub := ""
var _inbox: Array[String] = []
var _started_at := 0
var _open_started := false
var _next_open := 0
var _relays_seen := 0


func _init(code: String, relays: Array = []) -> void:
	_started_at = Time.get_ticks_msec()
	_room = OneLobbyNostrRoom.open(code, relays)
	if _room == null:
		state = CLOSED
		close_reason = "not a join code"
		return
	_room.on_frame = _on_frame


## Relays connected, for a progress line.
func relays_connected() -> int:
	return _room.relays_connected() if _room != null else 0


func relays_total() -> int:
	return _room.relays_total() if _room != null else 0


func poll() -> void:
	if state == CLOSED or _room == null:
		return
	_room.poll()
	if state == CLOSED:
		return
	var now := Time.get_ticks_msec()
	if state == CONNECTING:
		var up := _room.relays_connected()
		if not _open_started:
			if up > 0:
				_open_started = true
				_relays_seen = up
				_send_open(now)
			elif now - _started_at >= relay_timeout_ms:
				_fail("no Nostr relay reachable")
				return
		else:
			# a relay that comes up after the first `open` gets one at once, not at the next resend
			if up > _relays_seen:
				_send_open(now)
			_relays_seen = up
			if now >= _next_open:
				_send_open(now)
		if state == CONNECTING and now - _started_at >= open_timeout_ms:
			_fail("the host did not answer through the Nostr relays")
	elif _link != null:
		_link.poll()


func _send_open(now: int) -> void:
	_next_open = now + open_every_ms
	_room.send("", {"type": "open", "seq": 0, "ack": 0})


func send_text(text: String) -> void:
	if state != OPEN or _link == null:
		return
	# The keep-alive ping never crosses Nostr: answer it here (spec s.4)
	if text.length() < 64 and text.begins_with('{"t":"ping"'):
		var m: Variant = JSON.parse_string(text)
		if m is Dictionary:
			_inbox.append(JSON.stringify({"t": "pong", "n": m.get("n")}))
			return
	_link.send(text)


func receive() -> Array[String]:
	var out := _inbox
	_inbox = []
	return out


## Anything queued for the host and not yet acknowledged (a flushing leave waits for this to reach 0).
func buffered() -> int:
	return _link.buffered() if _link != null else 0


func close() -> void:
	if state == CLOSED:
		return
	if state == OPEN and _link != null:
		_link.close(close_reason)
	_finish("")


func _on_frame(f: Dictionary) -> void:
	if state == CLOSED or f.get("to") != _room.pub:
		return
	if state == CONNECTING:
		if f.get("type") != "open":
			return
		_host_pub = f["from"]
		_link = OneLobbyNostrLink.new(_link_send, _link_deliver, _finish, _finish)
		state = OPEN
		return
	if f.get("from") != _host_pub:
		return
	if f.get("type") == "open":
		_link.heard()
		return
	_link.receive(f)


func _link_send(out: Dictionary) -> void:
	_room.send(_host_pub, out)


func _link_deliver(text: String) -> void:
	if state == OPEN:
		_inbox.append(text)


func _fail(why: String) -> void:
	if state == CLOSED:
		return
	_finish(why)


func _finish(reason: String) -> void:
	if state == CLOSED:
		return
	state = CLOSED
	close_reason = reason
	if _link != null:
		_link.stop()
	if _room != null:
		_room.close()
