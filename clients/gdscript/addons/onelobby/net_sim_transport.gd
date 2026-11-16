class_name OneLobbyNetSimTransport
extends OneLobbyTransport
## Fake bad network for dev builds and tests, shaped like NetSimTransport of the C# client: wraps any OneLobbyTransport and makes
## its peer links worse on purpose (set it as `client.transport`). Only data channel frames are affected (signaling is not).
## Reliable frames are delayed but stay in order and are never lost; fast and voice frames can also be lost, or reordered by jitter.
##
## Like the C# one it acts on this peer's sends AND its receives: each frame gets `latency_ms / 2 + random * jitter_ms` on the way
## out and again on the way in, and a loss roll in each direction. With only one end of a link wrapped `latency_ms` is the added
## round trip; with both ends wrapped with the same settings it is the added one-way time.
##
## Options (the names of C#'s NetSimOptions in snake_case, the same defaults):
##   latency_ms   Added round trip in ms, split evenly between this peer's sends and receives. Default 0.
##   jitter_ms    Up to this much extra random delay per frame, each way. Default 0.
##   loss_percent Chance (0-100) to lose a fast or voice frame, each way. Reliable frames are never lost. Default 0.
##   seed         Random seed, for repeatable runs. Default 1. Only read at construction.
## `options` can change while running. Delayed frames go out on poll() (the client calls it every frame) and arrive on a link's
## receive(). The random stream is Godot's own generator of the seed: a seed repeats a run here, but it is not C#'s or JS's stream.
## One difference from C#: a link made through this wrapper is not an OneLobbyGodotTransport.OLRtcLink, so the lobby's
## "port_range_full" check does not see through it (the stock link still fails itself; only the friendly message is lost).

const DEFAULTS := {"latency_ms": 0.0, "jitter_ms": 0.0, "loss_percent": 0.0, "seed": 1}

## Current settings; assign a new Dictionary (or change a key) to change them on the fly.
var options := DEFAULTS.duplicate()
var inner: OneLobbyTransport
var _links: Array = []
var _rng := RandomNumberGenerator.new()


func _init(inner_transport: OneLobbyTransport, opts: Dictionary = {}) -> void:
	inner = inner_transport
	options = DEFAULTS.duplicate()
	options.merge(opts, true)
	_rng.seed = int(options["seed"])


func now_ms() -> int:
	return inner.now_ms()


func connect_signaling(url: String) -> OneLobbyTransport.OLSocket:
	return inner.connect_signaling(url)


func create_link(opts: Dictionary) -> OneLobbyTransport.OLLink:
	var l := OLSimLink.new(self, inner.create_link(opts))
	_links.append(l)
	return l


func poll() -> void:
	inner.poll()
	_links = _links.filter(func(l: OLSimLink) -> bool: return not l.disposed)
	for l: OLSimLink in _links:
		l.sync_state()
		l.flush()


## Whole ms of delay for one frame (like C#: truncated, never negative).
func _delay() -> int:
	var d := float(options["latency_ms"]) / 2.0
	if float(options["jitter_ms"]) > 0.0:
		d += _rng.randf() * float(options["jitter_ms"])
	return int(maxf(0.0, d))


func _lose(channel: int) -> bool:
	return channel != OneLobbyWire.RELIABLE and float(options["loss_percent"]) > 0.0 and _rng.randf() * 100.0 < float(options["loss_percent"])


class OLSimLink:
	extends OneLobbyTransport.OLLink
	var disposed := false
	var _t: OneLobbyNetSimTransport
	var _inner: OneLobbyTransport.OLLink
	var _out: Array = [] # [at, seq, channel, bytes]
	var _in: Array = []
	var _seq := 0
	var _last_reliable_out := 0
	var _last_reliable_in := 0

	func _init(t: OneLobbyNetSimTransport, inner_link: OneLobbyTransport.OLLink) -> void:
		_t = t
		_inner = inner_link
		sync_state()

	## Copies what the inner link knows (the lobby reads these as plain properties) and hands it the trace callback.
	func sync_state() -> void:
		is_open = _inner.is_open
		is_failed = _inner.is_failed
		relayed = _inner.relayed
		remote_address = _inner.remote_address
		_inner.on_trace = on_trace

	func facts() -> Dictionary:
		return _inner.facts()

	func start_offer() -> void:
		_inner.start_offer()

	func apply_signal(sig: Dictionary) -> void:
		_inner.apply_signal(sig)

	func take_signals() -> Array[Dictionary]:
		return _inner.take_signals()

	## Reliable frames held back by the simulated latency count as still queued.
	func buffered() -> int:
		var n := _inner.buffered()
		for o: Array in _out:
			if int(o[2]) == OneLobbyWire.RELIABLE:
				n += (o[3] as PackedByteArray).size()
		return n

	func send(channel: int, bytes: PackedByteArray) -> void:
		sync_state()
		if disposed or _t._lose(channel):
			return
		var now := _t.now_ms()
		var at := now + _t._delay()
		if channel == OneLobbyWire.RELIABLE:
			at = maxi(at, _last_reliable_out)
			_last_reliable_out = at
		if at <= now and _out.is_empty():
			_inner.send(channel, bytes)
			return
		_seq += 1
		_out.append([at, _seq, channel, bytes.duplicate()])

	func receive() -> Array:
		sync_state()
		var now := _t.now_ms()
		for item: Array in _inner.receive():
			var ch := int(item[0])
			if _t._lose(ch):
				continue
			var at := now + _t._delay()
			if ch == OneLobbyWire.RELIABLE:
				at = maxi(at, _last_reliable_in)
				_last_reliable_in = at
			_seq += 1
			_in.append([at, _seq, ch, item[1]])
		var due: Array = []
		while true:
			var f := _take(_in, now)
			if f.is_empty():
				break
			due.append([f[2], f[3]])
		return due

	func flush() -> void:
		var now := _t.now_ms()
		while true:
			var f := _take(_out, now)
			if f.is_empty():
				break
			_inner.send(int(f[2]), f[3])

	## The earliest due frame (ties keep insertion order, so reliable frames, whose times never go down, stay in order); [] when none is due.
	func _take(q: Array, now: int) -> Array:
		var best := -1
		for i in q.size():
			var a: Array = q[i]
			if int(a[0]) <= now and (best < 0 or int(a[0]) < int(q[best][0]) or (int(a[0]) == int(q[best][0]) and int(a[1]) < int(q[best][1]))):
				best = i
		if best < 0:
			return []
		var r: Array = q[best]
		q.remove_at(best)
		return r

	func close() -> void:
		disposed = true
		_out.clear()
		_in.clear()
		_inner.close()
		is_open = false
