extends SceneTree
## Unit tests of OneLobbyNetSimTransport (addons/onelobby/net_sim_transport.gd): fake lag, jitter and loss on an in-memory
## transport with a virtual clock, a fixed seed. The GDScript twin of clients/js/packages/client/test/netsim.test.ts. Opens no socket.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/net_sim.gd
## Prints "net_sim: N passed, M failed"; exits 1 on any failure.

var _pass := 0
var _fail := 0


func _init() -> void:
	_run.call_deferred()


func _check(ok: bool, what: String) -> void:
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL: ", what)


## An in-memory transport: its links hand a frame to the other end's inbox at once (the sim does all the delaying).
class MemTransport:
	extends OneLobbyTransport
	var now := 0

	func now_ms() -> int:
		return now

	func create_link(_opts: Dictionary) -> OneLobbyTransport.OLLink:
		return MemLink.new()


class MemLink:
	extends OneLobbyTransport.OLLink
	var other: MemLink
	var inbox: Array = []

	func _init() -> void:
		is_open = true

	func send(channel: int, bytes: PackedByteArray) -> void:
		other.inbox.append([channel, bytes])

	func receive() -> Array:
		var out := inbox
		inbox = []
		return out


## Both ends wrapped with the same options (so latency_ms is the one-way time). Returns [from_link, to_link, from_transport, to_transport, clock holder].
func _pair(opts: Dictionary) -> Array:
	var clock := MemTransport.new()
	var a := MemLink.new()
	var b := MemLink.new()
	a.other = b
	b.other = a
	var ta := OneLobbyNetSimTransport.new(_Fixed.new(clock, a), opts)
	var ob := opts.duplicate()
	ob["seed"] = int(opts.get("seed", 1)) + 1000
	var tb := OneLobbyNetSimTransport.new(_Fixed.new(clock, b), ob)
	return [ta.create_link({}), tb.create_link({}), ta, tb, clock]


## A transport that always makes one given link, and shares one clock.
class _Fixed:
	extends OneLobbyTransport
	var clock: MemTransport
	var link: MemLink

	func _init(c: MemTransport, l: MemLink) -> void:
		clock = c
		link = l

	func now_ms() -> int:
		return clock.now

	func create_link(_opts: Dictionary) -> OneLobbyTransport.OLLink:
		return link


## Sends n frames on a channel, one per virtual ms, and runs the clock until everything due has arrived; returns [{id, delay}] in arrival order.
func _run_case(opts: Dictionary, channel: int, n: int = 1000) -> Array:
	var p := _pair(opts)
	var from: OneLobbyTransport.OLLink = p[0]
	var to: OneLobbyTransport.OLLink = p[1]
	var clock: MemTransport = p[4]
	var got: Array = []
	var sent_at := {}
	for i in n + 1000:
		if i < n:
			sent_at[i] = clock.now
			from.send(channel, PackedByteArray([i & 255, (i >> 8) & 255]))
		p[2].poll()
		p[3].poll()
		for item: Array in to.receive():
			var b: PackedByteArray = item[1]
			var id := int(b[0]) | (int(b[1]) << 8)
			got.append({"id": id, "delay": clock.now - int(sent_at[id])})
		clock.now += 1
	return got


func _run() -> void:
	var FAST := OneLobbyWire.FAST
	var RELIABLE := OneLobbyWire.RELIABLE

	# defaults pass frames straight through
	var g := _run_case({}, FAST, 100)
	var all_zero := true
	for x: Dictionary in g:
		all_zero = all_zero and int(x["delay"]) == 0
	_check(g.size() == 100 and all_zero, "default options: 100 of 100 frames, no delay (got %d)" % g.size())

	# the delay is applied: mean within 10% of latency + jitter (both ends wrapped), 1000 fast frames, no loss
	g = _run_case({"latency_ms": 100, "jitter_ms": 20, "seed": 7}, FAST)
	var sum := 0.0
	var mn := 1 << 30
	var mx := 0
	for x: Dictionary in g:
		sum += float(x["delay"])
		mn = mini(mn, int(x["delay"]))
		mx = maxi(mx, int(x["delay"]))
	var mean := sum / float(maxi(1, g.size()))
	print("net_sim gd: mean delay %.2f ms over %d frames (latency 100, jitter 20, two hops); range %d..%d" % [mean, g.size(), mn, mx])
	_check(g.size() == 1000, "all 1000 frames arrive without loss (got %d)" % g.size())
	_check(mean > 120.0 * 0.9 and mean < 120.0 * 1.1, "mean delay %.2f is within 10%% of 120" % mean)
	# jitter stays in range: latency .. latency + 2 x jitter (two truncations to whole ms)
	_check(mn >= 98 and mx <= 140 and mx - mn > 20, "delay range %d..%d inside 98..140 and wider than 20" % [mn, mx])

	# loss: 20% each way, fast frames; survive both hops p = 0.64, sd 15.2, four sd either side
	g = _run_case({"latency_ms": 20, "loss_percent": 20, "seed": 5}, FAST)
	print("net_sim gd: %d of 1000 fast frames arrived (expected 640, sd 15.2)" % g.size())
	_check(g.size() > 640 - 61 and g.size() < 640 + 61, "loss: %d of 1000 arrived, expected 640 +- 61" % g.size())

	# reliable frames: delayed, never dropped, in order, with jitter and 50% loss on
	g = _run_case({"latency_ms": 60, "jitter_ms": 40, "loss_percent": 50, "seed": 9}, RELIABLE)
	var in_order := g.size() == 1000
	var min_delay := 1 << 30
	for i in g.size():
		in_order = in_order and int(g[i]["id"]) == i
		min_delay = mini(min_delay, int(g[i]["delay"]))
	_check(in_order, "reliable: all 1000 arrive, in order (got %d)" % g.size())
	_check(min_delay >= 58, "reliable: every frame delayed by at least 58 ms (min %d)" % min_delay)

	# fast frames may overtake each other with jitter
	g = _run_case({"latency_ms": 20, "jitter_ms": 60, "seed": 11}, FAST)
	var overtaken := false
	for i in range(1, g.size()):
		overtaken = overtaken or int(g[i]["id"]) < int(g[i - 1]["id"])
	_check(overtaken, "fast frames reorder with jitter")

	# a seed repeats the run; another seed does not
	var o := {"latency_ms": 80, "jitter_ms": 30, "loss_percent": 10}
	var a1 := _run_case(o.merged({"seed": 42}), FAST)
	var a2 := _run_case(o.merged({"seed": 42}), FAST)
	var a3 := _run_case(o.merged({"seed": 43}), FAST)
	_check(a1 == a2, "the same seed gives the same run twice")
	_check(a1 != a3, "another seed gives another run")

	# options change while running
	var p := _pair({"latency_ms": 100})
	var link: OneLobbyTransport.OLLink = p[0]
	var peer: OneLobbyTransport.OLLink = p[1]
	var clock: MemTransport = p[4]
	link.send(RELIABLE, PackedByteArray([1]))
	var seen := 0
	for _i in 49:
		clock.now += 1
		p[2].poll()
		seen += peer.receive().size()
	_check(seen == 0, "latency 100, both ends wrapped: nothing after 49 ms (got %d)" % seen)
	clock.now += 1
	p[2].poll()
	p[3].poll()
	seen += peer.receive().size()
	clock.now += 50
	p[2].poll()
	p[3].poll()
	seen += peer.receive().size()
	_check(seen == 1, "latency 100 with both ends wrapped: arrives by 100 ms (got %d)" % seen)
	p[2].options = OneLobbyNetSimTransport.DEFAULTS.duplicate()
	p[3].options = OneLobbyNetSimTransport.DEFAULTS.duplicate()
	link.send(RELIABLE, PackedByteArray([2]))
	seen += peer.receive().size()
	_check(seen == 2, "options switched off at run time: the next frame goes straight through")

	print("net_sim: %d passed, %d failed" % [_pass, _fail])
	quit(1 if _fail > 0 else 0)
