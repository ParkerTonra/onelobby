class_name OneLobbyReplicationSession
extends RefCounted
## Host-authoritative state replication over a raw-mode lobby (spec/replication.md; the GDScript twin of JS
## `ReplicationSession` and C# `OneLobby.Replication.ReplicationSession`: the same wire, the same behaviour, snake_case names).
##
## Host: `spawn` entities, run one sim step per `clock.try_advance()`, read each client's input with `try_get_input`, then
## `send_snapshot`. Each client gets a delta against the last snapshot it acknowledged, on the fast channel (a full one on the
## reliable channel when it joins and every `keyframe_seconds`).
## Client: `submit_input` once per `clock` tick, render remote entities with `try_sample` at `render_tick` (100 ms behind the
## host), reconcile the local player with `try_get_latest` + `last_processed_input`.
##
## Call `pump()` every frame (after the client pumped the lobby, which it does on its own): it advances render time, raises
## spawn / despawn, keeps acks flowing and expires stream gaps.
##
##     var rep := OneLobbyReplicationSession.new(lobby)             # lobby from a client with sync_mode "raw"
##     rep.entity_spawned.connect(func(info: Dictionary) -> void: make_node(info))   # {id, type_id, owner}
##     func _process(_dt: float) -> void:
##         rep.pump()
##         while rep.clock.try_advance():
##             if rep.is_host:
##                 sim_step()
##                 rep.send_snapshot()
##             else:
##                 rep.submit_input(read_input())
##
## A state schema is any object with `write(w: OneLobbyNetWriter, state)`, `read(r: OneLobbyNetReader) -> state` and
## `interpolate(a, b, t: float) -> state`; a host entity is an object with `write(w)` or a `func(w)` Callable.
##
## Names next to JS: spawn, despawn, set_owner (setOwner), host_entities (hostEntities), clients, is_client_ready
## (isClientReady), acked_tick (ackedTick), bytes_sent_to (bytesSentTo), input_stats_for (inputStatsFor), send_full_snapshot
## (sendFullSnapshot), try_get_input (tryGetInput), rewind_tick (rewindTick), send_snapshot (sendSnapshot), send_event
## (sendEvent), reliable_event_bytes_sent_to, server_tick, render_tick, latest_tick, snapshot_age_ms, last_processed_input,
## entities, is_mine (isMine), submit_input (submitInput), try_sample (trySample), try_sample_at, try_get_latest
## (tryGetLatest), find, rtt_ms (rttMs), peer_rtt_ms (peerRttMs), traffic_rates (trafficRates), describe, is_replication_payload,
## packet_log, stats, dispose. Signals: entity_spawned, entity_despawned, event_received, event_delivered, event_gap,
## other_message (otherMessage), host_lost (hostLost), client_ready (clientReady). For add-on layers (the networked player): register_kind
## (registerKind), send_extension (sendExtension), count_malformed (countMalformed), traffic_with (trafficWith), lobby_handle
## (lobbyHandle), interpolation_delay_ms and jitter_ms; the config keys adaptive_delay (default false) and max_interpolation_delay_ms.

## Client: an entity became visible at `render_tick` (create the game object here). `{id, type_id, owner}`.
signal entity_spawned(info: Dictionary)
## Client: an entity is gone as of `render_tick` (destroy the game object here).
signal entity_despawned(info: Dictionary)
## A reliable or fast event: client: from the host; host: from a client.
signal event_received(from: int, tick: int, payload: PackedByteArray)
## Every event, like `event_received`, with its stream and sequence number: `{from, tick, stream, seq, payload, channel}`.
signal event_delivered(event: Dictionary)
## A numbered stream skipped sequence numbers, raised after the hole stayed open for 1000 ms: `{from, stream, first_missing, next_delivered}`.
signal event_gap(gap: Dictionary)
## Raw-mode payloads that are not replication messages (first byte other than 0x52), for the game's own use.
signal other_message(from: int, bytes: PackedByteArray, channel: int)
## Client: the host left. Host migration is not supported for replicated sessions: end the match.
signal host_lost
## Host: a peer's link is up and it joined `clients()` (spawn its avatar here).
signal client_ready(peer_id: int)

## Defaults (DESIGN s.18: 30 Hz tick and send, 100 ms interpolation, 4x input redundancy). Pass the keys you change.
const DEFAULT_CONFIG := {
	"tick_rate": 30,
	"snapshot_every_ticks": 1,
	"interpolation_delay_ms": 100,
	"input_redundancy": 4,
	"history_ticks": 64,
	"max_input_buffer": 4,
	"max_rewind_ms": 250,
	"snapshot_warn_bytes": 1200,
	## Client, 0 = off: an event newer than the newest snapshot waits for it, or at most this many ticks.
	"hold_events_for_ticks": 0,
	## Host, 0 = off: a reliable full snapshot on join and every this many seconds.
	"keyframe_seconds": 5,
	"packet_log_per_second": 20,
	## Client, false = off: the render delay follows the arrival jitter, `clamp(2 I + 4 J, 2 I, max_interpolation_delay_ms)`
	## (I = snapshot interval, J = smoothed jitter); off keeps the fixed `interpolation_delay_ms`. The player layer turns it on.
	"adaptive_delay": false,
	## Upper bound of the adaptive delay in ms.
	"max_interpolation_delay_ms": 250,
}

const P := preload("res://addons/onelobby/replication_protocol.gd")

## Host: an `input` with `ack` 0 counts as "session started over" only this long after the client's first ack.
const ACK0_GRACE_MS := 500

# byte-rate buckets: kind + (received ? 3 : 0)
const _SNAPSHOT := 0
const _INPUT := 1
const _EVENT := 2
const _RECEIVED := 3

var config: Dictionary
var is_host := false
## Host: the authoritative sim tick. Client: the local input tick (same rate, its own count).
var clock: OneLobbyNetworkClock
var stats := OneLobbyReplicationStats.new()
## Debug view: true writes one line per replication packet to the lobby's net log (`rep out|in <peer> <channel> <json>`, at
## most `packet_log_per_second` a second); the wire stays binary. `packet_log_sink` (`func(line: String)`) takes the lines instead.
var packet_log := false
var packet_log_sink := Callable()

var local_peer_id: int:
	get:
		return int(_lobby.local_peer_id)
## The host's peer id (same as `lobby.host_peer_id`).
var host_peer_id: int:
	get:
		return int(_lobby.host_peer_id)
## Client: round trip to the host in ms (OneLobby's pings; 0 until the first pong). Host: 0.
var rtt_ms: int:
	get:
		return 0 if is_host else int(_lobby.ping_ms(_lobby.host_peer_id))
## Replication bytes per second sent and received over the last second, per kind (no lobby header).
var traffic_rates: Dictionary:
	get:
		return _rates.get_rates(_now())
## Client: estimated current host tick (fractional).
var server_tick: float:
	get:
		return (float(_now()) + _offset_ms) / clock.tick_ms() if _have_offset else 0.0
## Client: the host tick being rendered: `server_tick` minus the interpolation delay, smoothed.
var render_tick: float:
	get:
		return _render_tick
## Client: newest snapshot tick received.
var latest_tick: int:
	get:
		return _newest_tick
## Client: ms since the newest snapshot arrived; -1 before the first one.
var snapshot_age_ms: int:
	get:
		return -1 if _newest_at_ms < 0 else _now() - _newest_at_ms
## Client: the last of my inputs the host had applied in the newest snapshot (for reconciliation).
var last_processed_input: int:
	get:
		return _last_processed
## Client: the render delay in ms right now (`interpolation_delay_ms` of the config, or the adaptive value when `adaptive_delay` is on).
var interpolation_delay_ms: float:
	get:
		return _delay_ms if bool(config["adaptive_delay"]) else float(config["interpolation_delay_ms"])
## Client: smoothed snapshot arrival jitter in ms (always measured; only `adaptive_delay` acts on it).
var jitter_ms: float:
	get:
		return _jitter
## The lobby this session runs on (for add-on layers).
var lobby_handle: Variant:
	get:
		return _lobby

var _lobby: Variant
var _nw := OneLobbyNetWriter.new()
var _nr := OneLobbyNetReader.new()
var _disposed := false
var _rates := OLRateMeter.new()
var _log_window_start := 0
var _log_count := 0
var _conns: Array = [] # [signal, callable]

var _send_seq := {} # "peer:stream" -> last seq sent
var _event_bytes := {} # peer -> reliable event bytes sent
var _streams: OneLobbyReplicationStreams
var _held: Array = [] # [{ev, at}]
var _traffic := {} # peer -> [sent, received] replication payload bytes
var _extensions := {} # message kind (5 and up) -> Callable(from, payload, channel)

# host
var _host_ents := {} # id -> {type, owner, source, last}
var _client_recs := {} # peer -> OLRepClient
var _joining := {} # peer -> true
var _sent := {} # tick -> world
var _sent_order: Array[int] = []
var _next_id := 1

# client
var _ring := {} # tick -> world
var _ring_keys: Array[int] = []
var _reported := {} # id -> info
var _recent_inputs: Array = [] # newest first: {view256, bytes}
var _ack_tick := 0
var _input_seq := 0
var _last_processed := 0
var _newest_tick := 0
var _offset_ms := 0.0
var _have_offset := false
var _last_sample_ms := 0
var _render_tick := 0.0
var _have_render := false
var _last_pump_ms := 0
var _last_input_send_ms := -1000000000000
var _newest_at_ms := -1
var _delay_ms := 100.0
var _jitter := 0.0
var _last_arrive_ms := -1
var _last_arrive_tick := 0


## Per-client host bookkeeping.
class OLRepClient:
	var peer := 0
	var ack := 0
	var inputs := {} # seq -> {view256, bytes}
	var last_consumed := 0
	var last := {} # the last InputFrame handed out
	var bytes_sent := 0
	var ack_floor := 0 ## `send_full_snapshot`: acks at or below this tick no longer count as a baseline
	var ack_since := -1 ## host tick at which `ack` last went from 0 to a tick (-1 while it is 0): the grace for an `ack` 0 starts here
	var restart_tick := -1000000000000 ## host tick of the last `ack` 0 restart: at most one per `history_ticks`
	var restarted := false ## after an `ack` 0 restart until the first new ack: 0 < ack <= `ack_floor` comes from the old session
	var repeated := 0
	var skipped := 0
	var lost := 0
	var keyframe_due := true
	var next_keyframe_ms := 0


## Bytes per second over the last 1000 ms, per bucket.
class OLRateMeter:
	var _q: Array = [] # [at, bucket, bytes]

	func add(now: int, bucket: int, bytes: int) -> void:
		_q.append([now, bucket, bytes])
		_trim(now)

	func _trim(now: int) -> void:
		var n := 0
		while n < _q.size() and now - int(_q[n][0]) >= 1000:
			n += 1
		if n > 0:
			_q = _q.slice(n)

	func get_rates(now: int) -> Dictionary:
		_trim(now)
		var b := [0, 0, 0, 0, 0, 0]
		for e: Array in _q:
			b[int(e[1])] += int(e[2])
		return {
			"snapshots_sent": b[0], "inputs_sent": b[1], "events_sent": b[2], "total_sent": b[0] + b[1] + b[2],
			"snapshots_received": b[3], "inputs_received": b[4], "events_received": b[5], "total_received": b[3] + b[4] + b[5],
		}


## `lobby`: an OneLobbyLobby made with sync mode "raw" (a joiner: after `ready`). `cfg`: any of DEFAULT_CONFIG's keys.
func _init(lobby: Variant, cfg: Dictionary = {}) -> void:
	_lobby = lobby
	if lobby == null:
		push_error("OneLobbyReplicationSession: a lobby is required")
		return
	if str(lobby.mode) != "raw":
		push_error("OneLobbyReplicationSession runs on a raw-mode lobby (sync_mode \"raw\")")
	config = DEFAULT_CONFIG.duplicate()
	config.merge(cfg, true)
	is_host = bool(lobby.is_host)
	clock = OneLobbyNetworkClock.new(int(config["tick_rate"]), Callable(lobby, "now_ms"))
	_streams = OneLobbyReplicationStreams.new(stats)
	_streams.on_deliver = _arrive
	_streams.on_gap = func(g: Dictionary) -> void: event_gap.emit(g)
	_connect(lobby.message_received, _on_message)
	_connect(lobby.host_changed, func(_id: int) -> void:
		if not is_host:
			host_lost.emit())
	_connect(lobby.peer_joined, func(p: Dictionary) -> void:
		var id := int(p["peer_id"])
		if not is_host or id == local_peer_id or _client_recs.has(id):
			return
		_streams.forget(id) # a rejoin under the same id starts its streams again at 1
		_forget_peer(id)
		_joining[id] = true)
	_connect(lobby.peer_ready, func(p: Dictionary) -> void:
		if is_host and int(p["peer_id"]) != local_peer_id:
			_add_client(int(p["peer_id"])))
	_connect(lobby.peer_left, func(p: Dictionary, _reason: String) -> void:
		var id := int(p["peer_id"])
		_client_recs.erase(id)
		_joining.erase(id)
		_streams.forget(id)
		_forget_peer(id))
	if is_host:
		for p: Dictionary in lobby.peers():
			var id := int(p["peer_id"])
			if id == local_peer_id:
				continue
			if lobby.is_peer_ready(id):
				_add_client(id)
			else:
				_joining[id] = true
	_last_pump_ms = _now()
	_delay_ms = float(config["interpolation_delay_ms"])


func _connect(sig: Signal, handler: Callable) -> void:
	sig.connect(handler)
	_conns.append([sig, handler])


func _now() -> int:
	return int(_lobby.now_ms())


## True for payloads this session owns (at least 3 bytes, first byte 0x52). Keep your own raw messages off that first byte.
static func is_replication_payload(payload: PackedByteArray) -> bool:
	return P.is_replication(payload)


## One replication message as a plain JSON-able Dictionary (spec/replication.md "Debug view"). `baseline`: a world or null.
func describe(payload: PackedByteArray, baseline: Variant = null) -> Dictionary:
	return P.describe(payload, baseline)


## Binds a schema to a getter: a host-side entity that writes `getter.call()` through `schema.write`.
static func replicated(schema: Object, getter: Callable) -> Callable:
	return func(w: OneLobbyNetWriter) -> void: schema.write(w, getter.call())


## Advances render time, raises spawn / despawn, keeps acks flowing and expires stream gaps. Call every frame.
func pump() -> void:
	if _disposed:
		return
	var now := _now()
	var elapsed := now - _last_pump_ms
	_last_pump_ms = now
	_streams.expire(now)
	if is_host:
		return
	_release_held(now)
	_update_render_tick(elapsed)
	_report_visibility()
	if _newest_tick > 0 and float(now - _last_input_send_ms) >= clock.tick_ms():
		_send_input_message(0) # ack-only heartbeat


# ==================================================================== host ========================================

## Host: register an entity. `owner` is the controlling peer id, 0 = host-owned (AI, doors). Returns its id (from 1).
func spawn(type_id: int, owner: int, entity: Variant) -> int:
	if not _require_host("spawn"):
		return 0
	if entity == null:
		push_error("OneLobbyReplicationSession.spawn: entity required")
		return 0
	var id := _next_id
	_next_id += 1
	_host_ents[id] = {"type": type_id, "owner": owner, "source": entity, "last": PackedByteArray()}
	return id


## Host: remove an entity; clients see it disappear at the snapshot tick it was last absent from.
func despawn(id: int) -> bool:
	if not _require_host("despawn"):
		return false
	return _host_ents.erase(id)


func set_owner(id: int, owner: int) -> void:
	if _require_host("set_owner") and _host_ents.has(id):
		_host_ents[id]["owner"] = owner


## Host: the entities spawned with `spawn` and not yet despawned, as `{id, type_id, owner}`. Empty on a client.
func host_entities() -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for id: int in _host_ents:
		out.append({"id": id, "type_id": _host_ents[id]["type"], "owner": _host_ents[id]["owner"]})
	return out


## Host: peers receiving snapshots. A peer is added when its link is up; its first snapshot is a reliable full one.
func clients() -> Array[int]:
	var out: Array[int] = []
	for p: int in _client_recs:
		out.append(p)
	return out


func is_client_ready(peer_id: int) -> bool:
	return _client_recs.has(peer_id)


## Round trip to `peer_id` in ms. Only a client's round trip to the host is measured; any other peer gives 0.
func peer_rtt_ms(peer_id: int) -> int:
	return int(_lobby.ping_ms(_lobby.host_peer_id)) if not is_host and peer_id == host_peer_id else 0


## Host: newest snapshot tick this client acknowledged (0 = none yet: it gets full snapshots).
func acked_tick(peer_id: int) -> int:
	return (_client_recs[peer_id] as OLRepClient).ack if _client_recs.has(peer_id) else 0


## Host: replication bytes sent to one client (payloads, no lobby header).
func bytes_sent_to(peer_id: int) -> int:
	return (_client_recs[peer_id] as OLRepClient).bytes_sent if _client_recs.has(peer_id) else 0


## Host: one client's input counters and how many of its inputs are buffered right now: `{repeated, skipped, lost, buffer_depth}`.
func input_stats_for(peer_id: int) -> Dictionary:
	if not _client_recs.has(peer_id):
		return {"repeated": 0, "skipped": 0, "lost": 0, "buffer_depth": 0}
	var c: OLRepClient = _client_recs[peer_id]
	return {"repeated": c.repeated, "skipped": c.skipped, "lost": c.lost, "buffer_depth": c.inputs.size()}


## Host: the next snapshot this client gets is a full one (no baseline); deltas resume only once it acknowledges a
## snapshot sent after this call.
func send_full_snapshot(peer_id: int) -> void:
	if not _require_host("send_full_snapshot") or not _client_recs.has(peer_id):
		return
	var c: OLRepClient = _client_recs[peer_id]
	c.ack = 0
	c.ack_floor = clock.tick


## An `input` with `ack` 0 from a client that had acked: its session started over (it holds no snapshot). Same effect as
## `send_full_snapshot`, and its input bookkeeping starts over too (its sequence numbers begin at 1 again).
func _restart_client(c: OLRepClient) -> void:
	c.ack = 0
	c.ack_floor = clock.tick
	c.ack_since = -1
	c.restart_tick = clock.tick
	c.restarted = true
	c.inputs.clear()
	c.last_consumed = 0
	c.last = {}


## Host: this tick's input from a client (one call per client per tick): `{seq, view_tick, bytes, repeated}`. The next input
## in sequence; when none has arrived the previous one is repeated (`repeated` true); `{}` only before the first.
func try_get_input(peer_id: int) -> Dictionary:
	if not _require_host("try_get_input") or not _client_recs.has(peer_id):
		return {}
	var c: OLRepClient = _client_recs[peer_id]
	# latency cap: a client that got ahead (a burst after a stall) skips its oldest inputs
	while c.inputs.size() > maxi(1, int(config["max_input_buffer"])):
		var k := _first_key(c.inputs)
		c.inputs.erase(k)
		c.last_consumed = k
		stats.inputs_skipped += 1
		c.skipped += 1
	if c.inputs.size() > 0:
		var k2 := _first_key(c.inputs)
		var v: Dictionary = c.inputs[k2]
		c.inputs.erase(k2)
		if k2 > c.last_consumed + 1:
			stats.inputs_lost += k2 - c.last_consumed - 1
			c.lost += k2 - c.last_consumed - 1
		c.last_consumed = k2
		c.last = {"seq": k2, "view_tick": float(v["view256"]) / 256.0, "bytes": v["bytes"], "repeated": false}
		return c.last.duplicate()
	if c.last.is_empty():
		return {}
	stats.inputs_repeated += 1
	c.repeated += 1
	var again: Dictionary = c.last.duplicate()
	again["repeated"] = true
	return again


## Host: the tick to rewind hit volumes to for a shot in `input` (an InputFrame), clamped to `max_rewind_ms`.
func rewind_tick(input: Dictionary) -> float:
	var now := float(clock.tick)
	var earliest := now - float(config["max_rewind_ms"]) / clock.tick_ms()
	return minf(now, maxf(earliest, float(input["view_tick"])))


## Host: capture every entity's state at `clock.tick` and send each client its delta. Call once at the end of each sim tick;
## ticks not on `snapshot_every_ticks` are skipped.
func send_snapshot() -> void:
	if not _require_host("send_snapshot"):
		return
	var tick := clock.tick
	if tick == 0:
		push_error("OneLobbyReplicationSession: advance the clock (clock.try_advance) before the first snapshot")
		return
	if tick % maxi(1, int(config["snapshot_every_ticks"])) != 0 or _sent.has(tick):
		return
	var list: Array = []
	for id: int in _host_ents:
		var e: Dictionary = _host_ents[id]
		_nw.reset()
		var src: Variant = e["source"]
		if src is Callable:
			(src as Callable).call(_nw)
		else:
			src.write(_nw)
		if _nw.byte_count() > P.MAX_STATE_BYTES:
			push_error("OneLobbyReplicationSession: entity state over %d bytes: %d" % [P.MAX_STATE_BYTES, id])
			return
		var cur := _nw.to_bytes()
		if cur != e["last"]:
			e["last"] = cur # unchanged state keeps the same array
		list.append({"id": id, "type": e["type"], "owner": e["owner"], "state": e["last"]})
	var world := {"tick": tick, "ents": list}
	_sent[tick] = world
	_sent_order.append(tick)
	while _sent_order.size() > 0 and _sent_order[0] + int(config["history_ticks"]) < tick:
		_sent.erase(_sent_order.pop_front())

	var now := _now()
	for peer: int in _client_recs:
		var c: OLRepClient = _client_recs[peer]
		var baseline: Variant = null
		if c.ack != 0:
			baseline = _sent.get(c.ack)
		# keyframe: a full snapshot on the reliable channel instead of this tick's fast one
		var keyframe: bool = float(config["keyframe_seconds"]) > 0.0 and (c.keyframe_due or now >= c.next_keyframe_ms)
		if keyframe:
			baseline = null
			c.keyframe_due = false
			c.next_keyframe_ms = now + floori(float(config["keyframe_seconds"]) * 1000.0)
			stats.keyframes_sent += 1
		var bytes := P.encode_snapshot(world, baseline, c.last_consumed)
		var channel := OneLobbyWire.RELIABLE if keyframe else OneLobbyWire.FAST
		_lobby.send(c.peer, bytes, channel)
		_rates.add(now, _SNAPSHOT, bytes.size())
		_log_packet("out", c.peer, channel, bytes, baseline)
		c.bytes_sent += bytes.size()
		_count(c.peer, true, bytes.size())
		stats.snapshots_sent += 1
		if baseline == null:
			stats.full_snapshots_sent += 1
		stats.snapshot_bytes_sent += bytes.size()
		if bytes.size() > stats.largest_snapshot:
			stats.largest_snapshot = bytes.size()
		if bytes.size() > int(config["snapshot_warn_bytes"]):
			stats.oversize_snapshots += 1


## Host: event to one client (`to`) or all (0). Client: event to the host (`to` ignored). Reliable by default (ordered, exactly
## once per link); `OneLobbyWire.FAST` for cosmetic one-offs. Stamped with the current tick. `stream` 1-255 (reliable only)
## numbers the event per (stream, recipient) so the receiver sees `seq`, drops duplicates and reports a skipped number with
## `event_gap`; stream 0 (the default) is unnumbered. Returns false (and prints an error) for a bad argument.
func send_event(payload: PackedByteArray, to: int = 0, channel: int = OneLobbyWire.RELIABLE, stream: int = 0) -> bool:
	if stream < 0 or stream > 255:
		push_error("OneLobbyReplicationSession.send_event: stream must be 0..255")
		return false
	if stream != 0 and channel != OneLobbyWire.RELIABLE:
		push_error("OneLobbyReplicationSession.send_event: numbered streams are reliable only")
		return false
	var tick := clock.tick if is_host else maxi(0, floori(server_tick))
	stats.events_sent += 1
	var plain: Variant = P.encode_event(tick, payload) if stream == 0 else null
	if not is_host:
		_send_event_to(host_peer_id, tick, stream, payload, plain, channel)
		return true
	if to != 0:
		_send_event_to(to, tick, stream, payload, plain, channel)
		return true
	for peer: int in _client_recs:
		_send_event_to(peer, tick, stream, payload, plain, channel)
	for peer: int in _joining: # reliable ones are queued until the link opens
		_send_event_to(peer, tick, stream, payload, plain, channel)
	return true


func _send_event_to(peer: int, tick: int, stream: int, body: PackedByteArray, plain: Variant, channel: int) -> void:
	var bytes: PackedByteArray
	if plain != null:
		bytes = plain
	else:
		var key := "%d:%d" % [peer, stream]
		var next: int = int(_send_seq.get(key, 0)) + 1
		_send_seq[key] = next
		bytes = P.encode_stream_event(tick, stream, next, body)
	_lobby.send(peer, bytes, channel)
	_rates.add(_now(), _EVENT, bytes.size())
	_count(peer, true, bytes.size())
	_log_packet("out", peer, channel, bytes, null)
	if channel == OneLobbyWire.RELIABLE:
		_event_bytes[peer] = int(_event_bytes.get(peer, 0)) + bytes.size()


## Reliable event bytes sent to one peer (payloads, no lobby header). Client: to the host.
func reliable_event_bytes_sent_to(peer_id: int) -> int:
	return int(_event_bytes.get(peer_id, 0))


## Replication payload bytes sent to and received from one peer since it was first seen (all kinds, no lobby header):
## `{sent, received}`.
func traffic_with(peer_id: int) -> Dictionary:
	var t: Array = _traffic.get(peer_id, [0, 0])
	return {"sent": t[0], "received": t[1]}


func _count(peer: int, sent: bool, bytes: int) -> void:
	var t: Array
	if _traffic.has(peer):
		t = _traffic[peer]
	else:
		t = [0, 0]
		_traffic[peer] = t
	t[0 if sent else 1] += bytes


## Add-on layers (the player layer): handle every message of replication `kind` (5 and up, additive per spec/replication.md
## "Versioning"). The handler is `Callable(from: int, payload: PackedByteArray, channel: int)`; one that finds the message
## malformed calls `count_malformed()`.
func register_kind(kind: int, handler: Callable) -> void:
	if kind < 5 or kind > 255:
		push_error("OneLobbyReplicationSession.register_kind: kind must be 5..255")
		return
	_extensions[kind] = handler


## Send a payload of an add-on kind to one peer on a channel, counted as event bytes in `traffic_rates`.
func send_extension(peer: int, bytes: PackedByteArray, channel: int) -> void:
	_lobby.send(peer, bytes, channel)
	_rates.add(_now(), _EVENT, bytes.size())
	_count(peer, true, bytes.size())
	_log_packet("out", peer, channel, bytes, null)
	stats.events_sent += 1


## Count one add-on message as malformed.
func count_malformed() -> void:
	stats.malformed += 1


func _forget_peer(peer: int) -> void:
	_event_bytes.erase(peer)
	var prefix := "%d:" % peer
	for k: String in _send_seq.keys():
		if k.begins_with(prefix):
			_send_seq.erase(k)


func _add_client(peer: int) -> void:
	_joining.erase(peer)
	if _client_recs.has(peer):
		return
	# ack 0: the first snapshot it gets is a full one, on the reliable channel (keyframe)
	var c := OLRepClient.new()
	c.peer = peer
	_client_recs[peer] = c
	client_ready.emit(peer)


func _host_receive_input(from: int, payload: PackedByteArray) -> void:
	if not _client_recs.has(from):
		return
	var c: OLRepClient = _client_recs[from]
	var d := P.decode_input(payload)
	if d.has("error"):
		stats.malformed += 1
		return
	var ack: int = d["ack"]
	var now_tick: int = clock.tick
	if ack == 0:
		# a client that had acked and now says 0 holds no baseline: its session started over. Not a late packet of the old one
		# (sent before its first snapshot arrived): those can only follow the first ack within the grace; and at most one
		# restart per history length, so a client alternating 0 and real acks cannot make a tap of full snapshots.
		var grace_ticks := ceili(ACK0_GRACE_MS / clock.tick_ms())
		if c.ack > 0 and now_tick - c.ack_since >= grace_ticks and now_tick - c.restart_tick >= int(config["history_ticks"]):
			_restart_client(c)
	elif c.restarted and ack <= c.ack_floor:
		return # a packet of the old session, still in flight after the restart: its sequence numbers are not the new session's
	elif ack <= now_tick and ack > c.ack and ack > c.ack_floor and _sent.has(ack):
		if c.ack == 0:
			c.ack_since = now_tick
		c.ack = ack
		c.restarted = false
	for inp: Dictionary in d["inputs"]:
		var seq: int = inp["seq"]
		if seq == 0 or seq <= c.last_consumed or c.inputs.has(seq):
			continue
		c.inputs[seq] = {"view256": inp["view256"], "bytes": inp["bytes"]}
		stats.inputs_received += 1


# ==================================================================== client ======================================

## Client: entities visible at `render_tick`, as `{id, type_id, owner}`.
func entities() -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for info: Dictionary in _reported.values():
		out.append(info)
	return out


func is_mine(info: Dictionary) -> bool:
	return int(info["owner"]) == local_peer_id


## Client: queue one input for the host and send it with the previous `input_redundancy - 1` inputs on the fast channel. Call
## once per `clock` tick. Returns the input's sequence number (0 on a host or an input over 1024 bytes).
func submit_input(input: PackedByteArray) -> int:
	if is_host:
		push_error("OneLobbyReplicationSession: the host applies its own input directly")
		return 0
	if input.size() > 1024:
		push_error("OneLobbyReplicationSession.submit_input: input over 1024 bytes")
		return 0
	_input_seq += 1
	_recent_inputs.push_front({"view256": maxi(0, roundi(_render_tick * 256.0)), "bytes": input})
	var keep := maxi(1, mini(255, int(config["input_redundancy"])))
	if _recent_inputs.size() > keep:
		_recent_inputs.resize(keep)
	_send_input_message(_recent_inputs.size())
	return _input_seq


func _send_input_message(count: int) -> void:
	# keep the datagram small: drop redundant copies past ~1000 bytes
	var size := 0
	var n := 0
	while n < count:
		size += (_recent_inputs[n]["bytes"] as PackedByteArray).size() + 6
		if n > 0 and size > 1000:
			break
		n += 1
	var bytes := P.encode_input(_ack_tick, _input_seq, _recent_inputs, n)
	_lobby.send(host_peer_id, bytes, OneLobbyWire.FAST)
	var now := _now()
	_rates.add(now, _INPUT, bytes.size())
	_count(host_peer_id, true, bytes.size())
	_log_packet("out", host_peer_id, OneLobbyWire.FAST, bytes, null)
	_last_input_send_ms = now
	if n > 0:
		stats.inputs_sent += 1
	stats.input_bytes_sent += bytes.size()


## Client: an entity's state interpolated at `render_tick`; null if it is not visible then.
func try_sample(id: int, schema: Object) -> Variant:
	return try_sample_at(id, _render_tick, schema)


## Client: an entity's state interpolated at any tick still in the snapshot buffer; null when it is not there.
func try_sample_at(id: int, tick: float, schema: Object) -> Variant:
	if _ring_keys.is_empty():
		return null
	var ai := _floor_index(tick)
	if ai < 0:
		return null
	var a: Dictionary = _ring[_ring_keys[ai]]
	var ia := P.index_of(a, id)
	if ia < 0:
		return null
	var ea: Dictionary = a["ents"][ia]
	var sa: Variant = _decode_state(ea["state"], schema)
	if ai + 1 < _ring_keys.size() and tick > float(_ring_keys[ai]):
		var b: Dictionary = _ring[_ring_keys[ai + 1]]
		var ib := P.index_of(b, id)
		if ib >= 0 and int(b["ents"][ib]["type"]) == int(ea["type"]):
			var sb: Variant = _decode_state(b["ents"][ib]["state"], schema)
			var t := (tick - float(_ring_keys[ai])) / float(_ring_keys[ai + 1] - _ring_keys[ai])
			return schema.interpolate(sa, sb, t)
	return sa # newest known (or despawning next): hold, never extrapolate


## Client: the entity's state in the newest snapshot (not interpolated): `{state, tick}`, or `{}`.
func try_get_latest(id: int, schema: Object) -> Dictionary:
	if _ring_keys.is_empty():
		return {}
	var w: Dictionary = _ring[_ring_keys[_ring_keys.size() - 1]]
	var i := P.index_of(w, id)
	if i < 0:
		return {}
	return {"state": _decode_state(w["ents"][i]["state"], schema), "tick": w["tick"]}


## Client: info for an entity in the newest snapshot (owner, type), even before it is visible: `{id, type_id, owner}` or `{}`.
func find(id: int) -> Dictionary:
	if _ring_keys.is_empty():
		return {}
	var w: Dictionary = _ring[_ring_keys[_ring_keys.size() - 1]]
	var i := P.index_of(w, id)
	if i < 0:
		return {}
	return {"id": id, "type_id": w["ents"][i]["type"], "owner": w["ents"][i]["owner"]}


func _decode_state(bytes: PackedByteArray, schema: Object) -> Variant:
	_nr.reset(bytes)
	return schema.read(_nr)


func _floor_index(tick: float) -> int:
	var lo := 0
	var hi := _ring_keys.size() - 1
	var best := -1
	while lo <= hi:
		var mid := (lo + hi) >> 1
		if float(_ring_keys[mid]) <= tick:
			best = mid
			lo = mid + 1
		else:
			hi = mid - 1
	return best


func _client_receive_snapshot(payload: PackedByteArray) -> void:
	var h := P.peek_snapshot(payload)
	if h.has("error"):
		stats.malformed += 1
		return
	var hist := int(config["history_ticks"])
	var tick: int = h["tick"]
	if _ring.has(tick) or (_newest_tick > hist and tick < _newest_tick - hist):
		return
	var baseline: Variant = null
	if int(h["baseline_tick"]) != 0:
		baseline = _ring.get(int(h["baseline_tick"]))
		if baseline == null:
			stats.snapshots_dropped += 1
			return
	var world := P.decode_snapshot(payload, baseline)
	if world.has("error"):
		stats.malformed += 1
		return
	_ring[tick] = world
	var at := _ring_keys.size()
	while at > 0 and _ring_keys[at - 1] > tick:
		at -= 1
	_ring_keys.insert(at, tick)
	stats.snapshots_received += 1
	var now := _now()
	if tick > _newest_tick:
		_measure_jitter(tick, now)
		_newest_tick = tick
		_newest_at_ms = now
		_ack_tick = tick
		_last_processed = h["last_input"]
	while _ring_keys.size() > 0 and _ring_keys[0] + hist < _newest_tick:
		_ring.erase(_ring_keys.pop_front())
	# clock: the least-delayed packet shows the host's clock best; let the estimate decay slowly towards later ones
	var sample := float(tick) * clock.tick_ms() - float(now)
	if not _have_offset or sample > _offset_ms:
		_offset_ms = sample
	else:
		_offset_ms = maxf(sample, _offset_ms - float(now - _last_sample_ms) * 0.05)
	_have_offset = true
	_last_sample_ms = now


# Jitter: how far a snapshot's spacing in time is from its spacing in ticks (RFC 3550 style, grows fast, shrinks slowly).
func _measure_jitter(tick: int, now: int) -> void:
	if _last_arrive_ms >= 0:
		var d := absf(float(now - _last_arrive_ms) - float(tick - _last_arrive_tick) * clock.tick_ms())
		_jitter += (d - _jitter) * (0.25 if d > _jitter else 1.0 / 32.0)
	_last_arrive_ms = now
	_last_arrive_tick = tick


func _adapt_delay(elapsed_ms: int) -> void:
	var interval := clock.tick_ms() * float(maxi(1, int(config["snapshot_every_ticks"])))
	var lo := 2.0 * interval
	var hi := maxf(lo, float(config["max_interpolation_delay_ms"]))
	var target := minf(hi, maxf(lo, 2.0 * interval + 4.0 * _jitter))
	if target > _delay_ms:
		_delay_ms += (target - _delay_ms) * minf(1.0, float(elapsed_ms) / 100.0) # grows within ~100 ms
	else:
		_delay_ms = maxf(target, _delay_ms - float(elapsed_ms) * 0.02) # shrinks at most 20 ms per second
	_delay_ms = minf(hi, maxf(lo, _delay_ms))


func _update_render_tick(elapsed_ms: int) -> void:
	if not _have_offset:
		return
	var tick_ms := clock.tick_ms()
	if bool(config["adaptive_delay"]):
		_adapt_delay(elapsed_ms)
	var target := server_tick - interpolation_delay_ms / tick_ms
	if not _have_render or absf(target - _render_tick) > 10.0:
		_render_tick = target
		_have_render = true
		return
	# advance with the local clock and close 10% of the error per pump; never run backwards
	var nxt := _render_tick + float(elapsed_ms) / tick_ms
	nxt += (target - nxt) * 0.1
	if nxt > _render_tick:
		_render_tick = nxt


func _report_visibility() -> void:
	var ai := _floor_index(_render_tick)
	if ai < 0:
		return
	var w: Dictionary = _ring[_ring_keys[ai]]
	var gone: Array = []
	for id: int in _reported:
		var info: Dictionary = _reported[id]
		var i := P.index_of(w, id)
		if i < 0 or int(w["ents"][i]["type"]) != int(info["type_id"]):
			gone.append(info)
	for g: Dictionary in gone:
		_reported.erase(g["id"])
		entity_despawned.emit(g)
	for e: Dictionary in w["ents"]:
		var id: int = e["id"]
		if _reported.has(id):
			var info: Dictionary = _reported[id]
			if int(info["owner"]) != int(e["owner"]):
				_reported[id] = {"id": id, "type_id": info["type_id"], "owner": e["owner"]}
			continue
		var ni := {"id": id, "type_id": e["type"], "owner": e["owner"]}
		_reported[id] = ni
		entity_spawned.emit(ni)


# ==================================================================== shared ======================================

func _on_message(from: int, payload: PackedByteArray, channel: int) -> void:
	if _disposed:
		return
	if not P.is_replication(payload):
		other_message.emit(from, payload, channel)
		return
	if payload[1] != P.VERSION:
		stats.malformed += 1
		return
	var kind: int = payload[2]
	if kind >= 1:
		_count(from, false, payload.size())
	if kind >= 5 and _extensions.has(kind):
		_rates.add(_now(), _RECEIVED + _EVENT, payload.size())
		if packet_log or packet_log_sink.is_valid():
			_log_packet("in", from, channel, payload, null)
		(_extensions[kind] as Callable).call(from, payload, channel)
		return
	if kind >= 1 and kind <= 4:
		var bucket := _SNAPSHOT if kind == P.KIND_SNAPSHOT else (_INPUT if kind == P.KIND_INPUT else _EVENT)
		_rates.add(_now(), _RECEIVED + bucket, payload.size())
		if packet_log or packet_log_sink.is_valid():
			_log_packet("in", from, channel, payload, _incoming_baseline(payload))
	match kind:
		P.KIND_SNAPSHOT:
			if not is_host and from == host_peer_id:
				_client_receive_snapshot(payload)
		P.KIND_INPUT:
			if is_host:
				_host_receive_input(from, payload)
		P.KIND_EVENT:
			if not is_host and from != host_peer_id:
				return
			var d := P.decode_event(payload)
			if d.has("error"):
				stats.malformed += 1
				return
			_arrive({"from": from, "tick": d["tick"], "stream": 0, "seq": 0, "payload": d["payload"], "channel": channel})
		P.KIND_STREAM_EVENT:
			if not is_host and from != host_peer_id:
				return
			if channel != OneLobbyWire.RELIABLE:
				stats.malformed += 1 # spec: reliable only
				return
			var d2 := P.decode_stream_event(payload)
			if d2.has("error"):
				stats.malformed += 1
				return
			_streams.receive({"from": from, "tick": d2["tick"], "stream": d2["stream"], "seq": d2["seq"], "payload": d2["payload"], "channel": channel}, _now())


func _arrive(e: Dictionary) -> void:
	# hold_events_for_ticks: keep arrival order; an event waits until its tick's snapshot is in, or the cap runs out
	if not is_host and int(config["hold_events_for_ticks"]) > 0 and (_held.size() > 0 or int(e["tick"]) > _newest_tick):
		_held.append({"ev": e, "at": _now()})
		return
	_deliver(e)


func _release_held(now: int) -> void:
	var cap_ms := float(config["hold_events_for_ticks"]) * clock.tick_ms()
	while _held.size() > 0:
		var h: Dictionary = _held[0]
		if int(h["ev"]["tick"]) > _newest_tick and float(now - int(h["at"])) < cap_ms:
			return
		_held.pop_front()
		_deliver(h["ev"])


func _deliver(e: Dictionary) -> void:
	stats.events_received += 1
	event_received.emit(e["from"], e["tick"], e["payload"])
	event_delivered.emit(e)


func _log_packet(dir: String, peer: int, channel: int, bytes: PackedByteArray, baseline: Variant) -> void:
	if not packet_log and not packet_log_sink.is_valid():
		return
	var now := _now()
	if now - _log_window_start >= 1000:
		_log_window_start = now
		_log_count = 0
	_log_count += 1
	if _log_count > maxi(1, int(config["packet_log_per_second"])):
		return
	var line := "rep %s %d %s %s" % [dir, peer, "fast" if channel == OneLobbyWire.FAST else "reliable", JSON.stringify(P.describe(bytes, baseline), "", false)]
	if packet_log_sink.is_valid():
		packet_log_sink.call(line)
	elif _lobby.has_method("get_net_log"):
		var log: Variant = _lobby.get_net_log()
		if log != null:
			log.add("info", line)


func _incoming_baseline(payload: PackedByteArray) -> Variant:
	if payload[2] != P.KIND_SNAPSHOT or is_host:
		return null
	var h := P.peek_snapshot(payload)
	if h.has("error") or int(h["baseline_tick"]) == 0:
		return null
	return _ring.get(int(h["baseline_tick"]))


# test seams
## The world the host sent at `tick`, or null (older than its history).
func host_world(tick: int) -> Variant:
	return _sent.get(tick)


## The worlds the client holds, oldest first.
func client_worlds() -> Array:
	var out: Array = []
	for k in _ring_keys:
		out.append(_ring[k])
	return out


## Stream events waiting for a missing number.
func buffered_stream_events() -> int:
	return _streams.buffered_count()


func _require_host(what: String) -> bool:
	if not is_host:
		push_error("OneLobbyReplicationSession.%s: host only" % what)
		return false
	return true


func _first_key(m: Dictionary) -> int:
	var lo := 0x7FFFFFFFFFFFFFFF
	for k: int in m:
		lo = mini(lo, k)
	return lo


## Stop listening to the lobby.
func dispose() -> void:
	if _disposed:
		return
	_disposed = true
	for c: Array in _conns:
		if (c[0] as Signal).is_connected(c[1]):
			(c[0] as Signal).disconnect(c[1])
	_conns.clear()
