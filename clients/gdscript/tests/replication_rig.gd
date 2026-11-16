extends RefCounted
## Test rig for the replication session: raw-mode lobbies on an in-memory network with a virtual clock, latency, jitter, loss,
## duplication and reordering (the GDScript twin of the JS `RepRig` over `InMemoryNetwork`). The session only needs the small
## lobby surface FakeLobby offers (mode, peer ids, now_ms, send, peers, is_peer_ready, ping_ms, get_net_log, the signals), so the
## timing-sensitive tests run in virtual time and are exact. The real OneLobbyLobby is covered by the loopback test in
## replication.gd and by engine-smoke.

## Deterministic random numbers (mulberry32, the same sequence as the JS tests), so a failing run can be repeated.
class Rng:
	var a := 0

	func _init(seed_value: int) -> void:
		a = seed_value & 0xFFFFFFFF

	func next() -> float:
		a = (a + 0x6D2B79F5) & 0xFFFFFFFF
		var t := a
		t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
		t = (t ^ ((t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF)) & 0xFFFFFFFF
		return float((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0


## The lobby surface a session uses.
class FakeLobby:
	extends RefCounted
	signal message_received(from: int, bytes: PackedByteArray, channel: int)
	signal peer_joined(peer: Dictionary)
	signal peer_ready(peer: Dictionary)
	signal peer_left(peer: Dictionary, reason: String)
	signal host_changed(host_id: int)

	var mode := "raw"
	var local_peer_id := 0
	var host_peer_id := 1
	var is_host := false
	var net: Net
	var name := ""
	var ready_peers := {} # peer id -> true: links that are open
	var all_peers := {}
	var _log := OneLobbyNetLog.new(500, Callable())

	func now_ms() -> int:
		return net.now

	func send(peer: int, bytes: PackedByteArray, channel: int = OneLobbyWire.RELIABLE) -> void:
		net.deliver(local_peer_id, peer, bytes, channel)

	func peers() -> Array[Dictionary]:
		var out: Array[Dictionary] = []
		for id: int in all_peers:
			out.append({"peer_id": id, "name": "p%d" % id, "ping_ms": 0, "relayed": false})
		return out

	func is_peer_ready(peer: int) -> bool:
		return peer == local_peer_id or ready_peers.has(peer)

	func ping_ms(_peer: int) -> int:
		return int(net.latency_ms * 2.0)

	func get_net_log() -> OneLobbyNetLog:
		return _log


## The in-memory network and its clock.
class Net:
	extends RefCounted
	var now := 0
	var latency_ms := 30.0
	var lobbies := {} # peer id -> FakeLobby
	## Test knobs, all off by default. Each is a Callable: `drop_fast()` / `drop_reliable()` / `duplicate_reliable()` /
	## `reorder_reliable()` -> bool, `extra_delay_ms(channel)` -> float.
	var drop_fast := Callable()
	var drop_reliable := Callable()
	var duplicate_reliable := Callable()
	var reorder_reliable := Callable()
	var extra_delay_ms := Callable()
	var block_open := false ## a joiner whose link never opens
	var queue: Array = [] # [at, to, from, channel, bytes]
	var sent := {} # "owner:channel" -> bytes the owner handed to the network
	var _last_reliable := {}

	func deliver(from: int, to: int, bytes: PackedByteArray, channel: int) -> void:
		var lobby: FakeLobby = lobbies.get(from)
		if lobby == null or not lobbies.has(to) or not lobby.ready_peers.has(to):
			return
		var key := "%s:%d" % [lobby.name, channel]
		sent[key] = int(sent.get(key, 0)) + bytes.size()
		if channel == OneLobbyWire.FAST and drop_fast.is_valid() and drop_fast.call():
			return
		if channel == OneLobbyWire.RELIABLE and drop_reliable.is_valid() and drop_reliable.call():
			return
		var at := float(now) + latency_ms + (maxf(0.0, float(extra_delay_ms.call(channel))) if extra_delay_ms.is_valid() else 0.0)
		if channel == OneLobbyWire.RELIABLE:
			var link := "%d>%d" % [from, to]
			if reorder_reliable.is_valid() and reorder_reliable.call():
				at += maxf(50.0, latency_ms) # later frames overtake this one
			else:
				at = maxf(at, float(_last_reliable.get(link, 0.0))) # an ordered channel: jitter delays, never reorders
				_last_reliable[link] = at
		queue.append([at, to, from, channel, bytes])
		if channel == OneLobbyWire.RELIABLE and duplicate_reliable.is_valid() and duplicate_reliable.call():
			queue.append([at + 1.0, to, from, channel, bytes])

	## Moves the clock and delivers everything due, in the order sent.
	func advance(ms: int) -> void:
		now += ms
		var i := 0
		while i < queue.size():
			var q: Array = queue[i]
			if float(q[0]) <= float(now):
				queue.remove_at(i)
				var to: FakeLobby = lobbies.get(int(q[1]))
				if to != null:
					to.message_received.emit(int(q[2]), q[4], int(q[3]))
				i = 0 # a handler may have queued more
			else:
				i += 1

	func sent_bytes(owner: String, channel: int) -> int:
		return int(sent.get("%s:%d" % [owner, channel], 0))


class RepPlayer:
	extends RefCounted
	var name := ""
	var lobby: FakeLobby
	var session: OneLobbyReplicationSession
	var spawned: Array = []
	var despawned: Array = []
	var events: Array = [] # {from, tick, payload}
	## Client: called once per local input tick with the tick; returns the input bytes (null = send nothing).
	var make_input := Callable()
	var submitted_seqs: Array = []

	func peer_id() -> int:
		return lobby.local_peer_id

	func attach(config: Dictionary) -> void:
		session = OneLobbyReplicationSession.new(lobby, config)
		session.entity_spawned.connect(func(e: Dictionary) -> void: spawned.append(e))
		session.entity_despawned.connect(func(e: Dictionary) -> void: despawned.append(e))
		session.event_received.connect(func(from: int, tick: int, payload: PackedByteArray) -> void: events.append({"from": from, "tick": tick, "payload": payload}))


var net := Net.new()
var players: Array[RepPlayer] = []
var random := Rng.new(1234)
var host: RepPlayer
## Host sim step, run once per host tick before the snapshot: `func(tick: int)`.
var host_tick := Callable()
var frame_ms := 16
var config: Dictionary
var _next_peer := 2


## `loss_rate` drops that share of fast frames; `jitter_ms` adds up to that much random delay to every frame.
func _init(cfg: Dictionary = {}, latency_ms: float = 30.0, loss_rate: float = 0.0, jitter_ms: float = 0.0) -> void:
	config = cfg
	net.latency_ms = latency_ms
	if loss_rate > 0.0:
		net.drop_fast = func() -> bool: return random.next() < loss_rate
	if jitter_ms > 0.0:
		net.extra_delay_ms = func(_ch: int) -> float: return random.next() * jitter_ms


func _make(name: String, id: int, as_host: bool) -> RepPlayer:
	var p := RepPlayer.new()
	p.name = name
	p.lobby = FakeLobby.new()
	p.lobby.net = net
	p.lobby.name = name
	p.lobby.local_peer_id = id
	p.lobby.is_host = as_host
	p.lobby.all_peers[id] = true
	net.lobbies[id] = p.lobby
	players.append(p)
	return p


func start_host() -> RepPlayer:
	host = _make("host", 1, true)
	host.attach(config)
	return host


## A joiner; with `net.block_open` its link never opens. Returns the player without a session when `attach` is false.
func join(name: String, attach: bool = true) -> RepPlayer:
	var id := _next_peer
	_next_peer += 1
	var p := _make(name, id, false)
	p.lobby.all_peers[1] = true
	host.lobby.all_peers[id] = true
	host.lobby.peer_joined.emit({"peer_id": id, "name": name, "ping_ms": 0, "relayed": false})
	if not net.block_open:
		p.lobby.ready_peers[1] = true
		host.lobby.ready_peers[id] = true
		host.lobby.peer_ready.emit({"peer_id": id, "name": name, "ping_ms": 0, "relayed": false})
	if attach:
		p.attach(config)
	return p


## One render frame on every peer: advance time, pump, run due ticks (host: sim + snapshot; client: inputs).
func step() -> void:
	net.advance(frame_ms)
	for p in players.duplicate():
		if p.session == null:
			continue
		p.session.pump()
		if p.session.is_host:
			while p.session.clock.try_advance():
				if host_tick.is_valid():
					host_tick.call(p.session.clock.tick)
				p.session.send_snapshot()
		else:
			while p.session.clock.try_advance():
				if p.make_input.is_valid():
					var input: Variant = p.make_input.call(p.session.clock.tick)
					if input != null:
						p.submitted_seqs.append(p.session.submit_input(input))


func run(seconds: float) -> void:
	var n := int(seconds * 1000.0 / float(frame_ms))
	for _i in n:
		step()


func until(cond: Callable, max_steps: int = 1200) -> bool:
	for _i in max_steps:
		if cond.call():
			return true
		step()
	return cond.call()


## Bytes a player handed to the network on a channel (lobby frames included).
func sent_bytes(p: RepPlayer, channel: int) -> int:
	return net.sent_bytes(p.name, channel)
