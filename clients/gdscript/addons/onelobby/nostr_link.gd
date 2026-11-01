class_name OneLobbyNostrLink
extends RefCounted
## The frame layer of Nostr signaling (spec/nostr-signaling.md s.4): ordered, de-duplicated, acknowledged delivery of
## hub protocol texts between two pubkeys over lossy relays. One link per peer. It knows nothing about relays, keys or
## encryption: the owner stamps and ships the frames it emits (`send`) and calls poll() every frame.
##
## Frames are Dictionaries {type: "open"|"data"|"beat"|"close", seq, ack, msgs?: Array[String], reason?: String}.


var _send: Callable        # (frame: Dictionary)
var _deliver: Callable     # (text: String)
var _on_peer_close: Callable  # (reason: String)
var _on_dead: Callable     # (reason: String)

var _queue: Array[String] = []
var _queue_bytes := 0
var _unacked_bytes := 0
var _next_seq := 1
var _unacked := {}         # seq -> {bytes, frame, last_sent, resends}
var _rcv_next := 1
var _held := {}            # seq -> Array
var _ack_owed := false
var _last_sent := 0
var _last_heard := 0
var _last_tick := 0
var _flush_at := -1
var _done := false


func _init(send: Callable, deliver: Callable, on_peer_close: Callable, on_dead: Callable) -> void:
	_send = send
	_deliver = deliver
	_on_peer_close = on_peer_close
	_on_dead = on_dead
	_last_sent = _now()
	_last_heard = _last_sent
	_last_tick = _last_sent


static func _now() -> int:
	return Time.get_ticks_msec()


func is_closed() -> bool:
	return _done


## Queues a hub text; sent within 30 ms, packed with its neighbours.
func send(text: String) -> void:
	if _done:
		return
	var n := text.to_utf8_buffer().size()
	# relays refuse high publish rates: past the cap the text is dropped, the connection is not
	if _queue.size() + _unacked.size() >= OneLobbyNostrLimits.MAX_OUT_FRAMES or _queue_bytes + _unacked_bytes + n > OneLobbyNostrLimits.MAX_OUT_BYTES:
		return
	_queue.append(text)
	_queue_bytes += n
	if _flush_at < 0:
		_flush_at = _now() + OneLobbyNostrLimits.BATCH_MS


## Bytes and frames still waiting to go out or be acknowledged.
func buffered() -> int:
	return _queue_bytes + _unacked_bytes


## Any frame arrived from the peer (including `open`, which only proves it is alive).
func heard() -> void:
	_last_heard = _now()


## `data`, `beat` and `close` frames from the peer.
func receive(f: Dictionary) -> void:
	if _done:
		return
	heard()
	var type := str(f.get("type", ""))
	if type == "close":
		var reason: String = f["reason"] if f.get("reason") is String else ""
		stop()
		_on_peer_close.call(reason)
		return
	if type != "data" and type != "beat":
		return
	var ack := int(f.get("ack", -1))
	if ack >= 0:
		for s in _unacked.keys():
			if s <= ack:
				_drop_unacked(s)
	if type == "beat":
		return
	var msgs: Array = []
	if f.get("msgs") is Array:
		for m in f["msgs"]:
			if m is String:
				msgs.append(m)
	var seq := int(f.get("seq", 0))
	if seq < 1:
		return
	_ack_owed = true
	if seq == _rcv_next:
		_rcv_next += 1
		for m in msgs:
			_deliver.call(m)
		while not _done and _held.has(_rcv_next):
			var h: Array = _held[_rcv_next]
			_held.erase(_rcv_next)
			_rcv_next += 1
			for m in h:
				_deliver.call(m)
	elif seq > _rcv_next and seq <= _rcv_next + OneLobbyNostrLimits.MAX_HELD:
		_held[seq] = msgs
	# seq < rcv_next: a duplicate; the ack below tells the sender to stop resending
	if _flush_at < 0 and not _done:
		_flush_at = _now() + OneLobbyNostrLimits.BATCH_MS


## Sends what is queued, then `close` (once), and stops.
func close(reason := "") -> void:
	if _done:
		return
	_flush()
	var f := {"type": "close", "seq": 0, "ack": _rcv_next - 1}
	if reason != "":
		f["reason"] = reason
	_send.call(f)
	stop()


## Stops the timers without telling the peer.
func stop() -> void:
	_done = true
	_flush_at = -1
	_unacked.clear()
	_unacked_bytes = 0
	_held.clear()
	_queue.clear()
	_queue_bytes = 0


func poll() -> void:
	if _done:
		return
	var now := _now()
	if _flush_at >= 0 and now >= _flush_at:
		_flush()
	if now - _last_tick >= OneLobbyNostrLimits.TICK_MS:
		_last_tick = now
		_tick(now)


func _flush() -> void:
	if _done:
		return
	_flush_at = -1
	var now := _now()
	if _queue.is_empty():
		if _ack_owed:
			_emit({"type": "beat", "seq": 0, "ack": _rcv_next - 1}, now)
		return
	var batch: Array = []
	var bytes := 0
	var q := _queue
	_queue = []
	_queue_bytes = 0
	for m in q:
		var n: int = m.to_utf8_buffer().size()
		if batch.size() > 0 and bytes + n > OneLobbyNostrLimits.MAX_FRAME_BYTES:
			_ship(batch, bytes, now)
			batch = []
			bytes = 0
		batch.append(m)
		bytes += n
	_ship(batch, bytes, now)


func _ship(batch: Array, bytes: int, now: int) -> void:
	if batch.is_empty():
		return
	var frame := {"type": "data", "seq": _next_seq, "ack": _rcv_next - 1, "msgs": batch}
	_next_seq += 1
	_unacked[frame["seq"]] = {"bytes": bytes, "frame": frame, "last_sent": now, "resends": 0}
	_unacked_bytes += bytes
	_emit(frame, now)


func _drop_unacked(seq: int) -> void:
	var p: Variant = _unacked.get(seq)
	if p == null:
		return
	_unacked_bytes -= int(p["bytes"])
	_unacked.erase(seq)


func _emit(f: Dictionary, now: int) -> void:
	_last_sent = now
	_ack_owed = false
	_send.call(f)


func _tick(now: int) -> void:
	if now - _last_heard >= OneLobbyNostrLimits.SILENCE_MS:
		_die()
		return
	for p: Dictionary in _unacked.values():
		if now - int(p["last_sent"]) < OneLobbyNostrLimits.RESEND_MS:
			continue
		if int(p["resends"]) >= OneLobbyNostrLimits.MAX_RESENDS:
			_die()
			return
		p["resends"] = int(p["resends"]) + 1
		p["last_sent"] = now
		var again: Dictionary = (p["frame"] as Dictionary).duplicate()
		again["ack"] = _rcv_next - 1
		_send.call(again)
		_last_sent = now
	if now - _last_sent >= OneLobbyNostrLimits.BEAT_MS:
		_emit({"type": "beat", "seq": 0, "ack": _rcv_next - 1}, now)


func _die() -> void:
	stop()
	_on_dead.call("timeout")
