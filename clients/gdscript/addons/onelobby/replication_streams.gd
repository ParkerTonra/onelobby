class_name OneLobbyReplicationStreams
extends RefCounted
## The receive side of numbered stream events (spec/replication.md "kind 4"): each (sender, stream) is delivered in `seq`
## order exactly once. A `seq` already delivered or already waiting is a duplicate; one past a missing number waits for
## it; a hole still open after 1000 ms is reported as a gap and skipped (the hole's timer restarts when it moves); and the
## buffer is bounded (64 events, 256 KiB, `seq` at most 4096 ahead) so a misbehaving sender cannot make a receiver hold
## events without bound. Reliable links never trigger any of this, so every case is counted as an anomaly.
## Pure logic over a millisecond clock the caller passes in; OneLobbyReplicationSession feeds it, and the
## `streamReceive` vectors drive it through `run_case`.

## How long a numbered stream waits for a missing sequence number before the gap is skipped.
const GAP_TIMEOUT_MS := 1000
## Most events one numbered stream holds while it waits for a missing one.
const MAX_BUFFERED := 64
## Most payload bytes one numbered stream holds while it waits for a missing one.
const MAX_BUFFERED_BYTES := 256 * 1024
## A sequence number further than this past the last delivered one is malformed and dropped.
const MAX_AHEAD := 4096

## `func(event: Dictionary) -> void`: an event is due, in order. `{from, tick, stream, seq, payload, channel}`.
var on_deliver := Callable()
## `func(gap: Dictionary) -> void`: `{from, stream, first_missing, next_delivered}`.
var on_gap := Callable()

var _stats: OneLobbyReplicationStats
var _recv := {} ## "peer:stream" -> last delivered seq
var _early := {} ## "peer:stream" -> {peer, stream, events: {seq: event}, since}


func _init(stats: OneLobbyReplicationStats = null) -> void:
	_stats = stats if stats != null else OneLobbyReplicationStats.new()


func _key(peer: int, stream: int) -> String:
	return "%d:%d" % [peer, stream]


## One stream event arrived at `now` (ms).
func receive(e: Dictionary, now: int) -> void:
	var key := _key(e["from"], e["stream"])
	var seq: int = e["seq"]
	var last: int = _recv.get(key, 0)
	if seq <= last:
		_stats.events_duplicate += 1
		return
	if seq - last > MAX_AHEAD:
		_stats.malformed += 1
		return
	if seq == last + 1:
		_recv[key] = seq
		_deliver(e)
		_drain(key, now)
		return
	var buf: Dictionary
	if _early.has(key):
		buf = _early[key]
	else:
		buf = {"peer": e["from"], "stream": e["stream"], "events": {}, "since": now}
		_early[key] = buf
	var events: Dictionary = buf["events"]
	if events.has(seq):
		_stats.events_duplicate += 1
		return
	events[seq] = e
	_stats.events_out_of_order += 1
	# a sender cannot make this buffer grow without bound: past the cap the hole is skipped now, not in a second
	var bytes := 0
	for v: Dictionary in events.values():
		bytes += (v["payload"] as PackedByteArray).size()
	if events.size() > MAX_BUFFERED or bytes > MAX_BUFFERED_BYTES:
		_skip_hole(key, now)


## Gaps whose hole stayed open for GAP_TIMEOUT_MS are reported and skipped. Call every pump.
func expire(now: int) -> void:
	if _early.is_empty():
		return
	for key: String in _early.keys():
		if _early.has(key) and now - int(_early[key]["since"]) >= GAP_TIMEOUT_MS:
			_skip_hole(key, now)


## Forget a peer's streams (it left or rejoined: its numbering starts at 1 again).
func forget(peer: int) -> void:
	var prefix := "%d:" % peer
	for key: String in _recv.keys():
		if key.begins_with(prefix):
			_recv.erase(key)
	for key: String in _early.keys():
		if key.begins_with(prefix):
			_early.erase(key)


## Events waiting for a missing number, over every stream.
func buffered_count() -> int:
	var n := 0
	for b: Dictionary in _early.values():
		n += (b["events"] as Dictionary).size()
	return n


func _drain(key: String, now: int) -> void:
	if not _early.has(key):
		return
	var buf: Dictionary = _early[key]
	var events: Dictionary = buf["events"]
	var last: int = _recv.get(key, 0)
	while events.has(last + 1):
		var next: Dictionary = events[last + 1]
		events.erase(last + 1)
		last += 1
		_recv[key] = last
		_deliver(next)
	if events.is_empty():
		_early.erase(key)
	else:
		buf["since"] = now # the hole moved: its timer starts again


func _skip_hole(key: String, now: int) -> void:
	var buf: Dictionary = _early[key]
	var last: int = _recv.get(key, 0)
	var first := 0x7FFFFFFFFFFFFFFF
	for s: int in (buf["events"] as Dictionary).keys():
		first = mini(first, s)
	_stats.events_gap += 1
	if on_gap.is_valid():
		on_gap.call({"from": buf["peer"], "stream": buf["stream"], "first_missing": last + 1, "next_delivered": first})
	_recv[key] = first - 1
	_drain(key, now)


func _deliver(e: Dictionary) -> void:
	if on_deliver.is_valid():
		on_deliver.call(e)


## Replays one `streamReceive` vector case (arrivals of one receiver, one ms at a time) and returns what happened in the
## shape of the case's `expect`: `{events: [...], duplicates, outOfOrder, gaps, malformed, buffered}`.
static func run_case(c: Dictionary) -> Dictionary:
	var stats := OneLobbyReplicationStats.new()
	var streams := OneLobbyReplicationStreams.new(stats)
	var events: Array = []
	var clock := [0]
	streams.on_deliver = func(e: Dictionary) -> void:
		events.append({"type": "deliver", "at": clock[0], "stream": e["stream"], "seq": e["seq"]})
	streams.on_gap = func(g: Dictionary) -> void:
		events.append({"type": "gap", "at": clock[0], "stream": g["stream"], "firstMissing": g["first_missing"], "nextDelivered": g["next_delivered"]})
	var arrivals: Array = c["arrivals"]
	var next := 0
	for t in range(0, int(c["endAt"]) + 1):
		clock[0] = t
		while next < arrivals.size() and int(arrivals[next]["at"]) == t:
			var a: Dictionary = arrivals[next]
			next += 1
			var payload := PackedByteArray()
			payload.resize(int(a["bytes"]))
			streams.receive({"from": 2, "tick": 1, "stream": int(a["stream"]), "seq": int(a["seq"]), "payload": payload, "channel": OneLobbyWire.RELIABLE}, t)
		streams.expire(t)
	return {"events": events, "duplicates": stats.events_duplicate, "outOfOrder": stats.events_out_of_order, "gaps": stats.events_gap,
		"malformed": stats.malformed, "buffered": streams.buffered_count()}
