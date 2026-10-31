class_name OneLobbyLobby
extends RefCounted
## One lobby you host or joined (raw mode). Made by OneLobbyClient.host / join / rejoin; events arrive as signals from
## inside the client's per-frame pump. Peers are Dictionaries {peer_id, name, ping_ms, relayed}.
##
## The host is a star hub: a joiner's send() goes to the host, which delivers it or forwards it with the sender's id.
## When the host goes away the lowest remaining peer id takes over (host migration) and host_changed fires.

## Joiner: the data link to the host is up and welcomed. A host is ready from the start (is_ready) and never fires it.
signal ready
## The server announced a peer (its link is still being set up; reliable sends to it are queued until it opens).
signal peer_joined(peer: Dictionary)
## A peer's data channels are open and its handshake is done. On a joiner this fires once for the host.
signal peer_ready(peer: Dictionary)
## reason: left, timeout, kicked, disconnected, ...
signal peer_left(peer: Dictionary, reason: String)
## Host only: a joiner never got its link open ("timeout" after ready_timeout_ms, or the reason it left with).
signal peer_failed(peer: Dictionary, reason: String)
## Host only: an approval lobby asks whether this peer may join; answer with approve().
signal join_requested(peer: Dictionary)
signal host_changed(host_id: int)
## phase: "lobby" or "in_game".
signal phase_changed(phase: String)
## channel: OneLobbyWire.RELIABLE or OneLobbyWire.FAST.
signal message_received(from: int, bytes: PackedByteArray, channel: int)
## reason: kicked, disconnected, server_closed, ice_failed, host_left. Not fired for your own leave().
signal session_ended(reason: String)

const HOST_TIMEOUT_MS := 8000
const PEER_TIMEOUT_MS := 10000
const MIN_PEER_TIMEOUT_MS := 6000
const PING_EVERY_MS := 1000
const CLAIM_WAIT_MS := 6000
const LEAVE_GRACE_MS := 500
const LEAVE_MAX_MS := 5000
const KICK_LINGER_MS := 3000
const HELD_OFFER_MS := 20000
const MAX_HELD_ICE := 32
const MAX_PENDING := 1024

var code := ""
var local_peer_id := 0
var host_peer_id: int:
	get: return _host_id
var is_host: bool:
	get: return _host_id == local_peer_id
## "lobby" or "in_game".
var phase := "lobby"
var meta := {}
var name := ""
var resume_token := ""
## "raw" (this client) or "lockstep" (a lobby made by another client; its lockstep frames are ignored here).
var mode := "raw"
var tick_rate := 30
var late_join := true
## Host: {messages, per_ms} caps raw frames per peer in a fixed window ({} = no cap).
var rate_limit := {}
var is_ready := false

var _c: OneLobbyClient
var _host_id := 0
var _epoch := 0
var _closed := false
var _awaiting_claim := false
var _await_deadline_ms := 0
var _last_ping_ms := 0
var _ping_n := 0
var _big_id := 0x80000000
var _peer_timeout_ms := PEER_TIMEOUT_MS
var _host_timeout_ms := HOST_TIMEOUT_MS
var _ready_deadline_ms := 0
var _peers := {} # id -> PeerRec
var _held := {} # from -> {at, signals}
var _lingering: Array = [] # [link, until]
var _rate := {} # id -> [start, n]


class PeerRec:
	var id := 0
	var name := ""
	var link: OneLobbyTransport.Link
	var open_handled := false
	var hello := false
	var hi_sent := false
	var ready_raised := false
	var pending: Array = [] # [channel, bytes]
	var last_rx_ms := 0
	var ping_ms := 0
	var chunks := OneLobbyChunker.new()
	var departing := false
	var depart_finish: Callable
	var depart_at_ms := 0
	var depart_cap_ms := 0
	var watching := false
	var watch_deadline_ms := 0


func _init(client: OneLobbyClient, msg: Dictionary) -> void:
	_c = client
	code = OneLobbySignaling.s(msg, "code")
	local_peer_id = OneLobbySignaling.i(msg, "you")
	_host_id = OneLobbySignaling.i(msg, "hostId")
	phase = OneLobbySignaling.s(msg, "phase", "lobby")
	mode = OneLobbySignaling.s(msg, "mode", "raw")
	tick_rate = maxi(1, OneLobbySignaling.i(msg, "tickRate", 30))
	late_join = OneLobbySignaling.b(msg, "lateJoin", true)
	meta = OneLobbySignaling.meta_of(msg)
	name = OneLobbySignaling.s(msg, "name")
	resume_token = OneLobbySignaling.s(msg, "resumeToken")
	var list: Variant = msg.get("peers")
	if list is Array:
		for p: Variant in list:
			var id := OneLobbySignaling.i(p, "peerId")
			_peers[id] = _rec(id, OneLobbySignaling.s(p, "name"))
	if not _peers.has(local_peer_id):
		_peers[local_peer_id] = _rec(local_peer_id, client.display_name)
	if not _peers.has(_host_id):
		_peers[_host_id] = _rec(_host_id, "host")
	if client.peer_timeout_ms > 0:
		_peer_timeout_ms = maxi(client.peer_timeout_ms, MIN_PEER_TIMEOUT_MS)
		_host_timeout_ms = _peer_timeout_ms


static func _rec(id: int, peer_name: String) -> PeerRec:
	var r := PeerRec.new()
	r.id = id
	r.name = peer_name
	return r


# ---- public --------------------------------------------------------------------------------------------------------

func now_ms() -> int:
	return _c.transport.now_ms()


## Everyone in the lobby, you included.
func peers() -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for r: PeerRec in _peers.values():
		out.append(_to_peer(r))
	return out


## Round trip in ms from OneLobby's own 1 s pings (host: any peer; joiner: the host); 0 before the first pong.
func ping_ms(peer_id: int) -> int:
	return (_peers[peer_id] as PeerRec).ping_ms if _peers.has(peer_id) else 0


func is_peer_ready(peer_id: int) -> bool:
	if peer_id == local_peer_id:
		return true
	var r: PeerRec = _peers.get(peer_id)
	return r != null and r.ready_raised and r.link != null and r.link.is_open


## Sends bytes to one peer. Reliable is ordered and never lost; fast may drop or reorder (use it for state you resend).
func send(peer_id: int, bytes: PackedByteArray, channel: int = OneLobbyWire.RELIABLE) -> void:
	var ch := OneLobbyWire.FAST if channel == OneLobbyWire.FAST else OneLobbyWire.RELIABLE
	if is_host:
		_send_to_peer(peer_id, ch, OneLobbyWire.build_raw(local_peer_id, bytes))
	else:
		_send_to_host(ch, OneLobbyWire.build_raw(peer_id, bytes))


## Sends bytes to every other peer.
func broadcast(bytes: PackedByteArray, channel: int = OneLobbyWire.RELIABLE) -> void:
	var ch := OneLobbyWire.FAST if channel == OneLobbyWire.FAST else OneLobbyWire.RELIABLE
	if is_host:
		var f := OneLobbyWire.build_raw(local_peer_id, bytes)
		for r: PeerRec in _peers.values():
			if r.id != local_peer_id and r.link != null:
				_send_link(r, ch, f)
	else:
		_send_to_host(ch, OneLobbyWire.build_raw(0, bytes))


## Host: marks the game started (phase "in_game"; the server stops listing it unless late join is on).
func start() -> void:
	if not _require_host("start the game"):
		return
	_set_phase("in_game")
	_c.send_signaling(OneLobbySignaling.phase(true))


## Host: back to the lobby screen.
func end_game() -> void:
	if not _require_host("end the game"):
		return
	_set_phase("lobby")
	_c.send_signaling(OneLobbySignaling.phase(false))


## Host: replaces the lobby's public metadata (string values; shown in list()).
func set_lobby_meta(m: Dictionary) -> void:
	if not _require_host("set metadata"):
		return
	meta = OneLobbySignaling._meta(m)
	_c.send_signaling(OneLobbySignaling.meta(m))


## Host: removes a player and bans it from this lobby for as long as the lobby lasts.
func kick(peer_id: int) -> void:
	if not _require_host("kick"):
		return
	_c.send_signaling(OneLobbySignaling.kick(peer_id))
	if _peers.has(peer_id):
		_drop_peer(_peers[peer_id], "kicked", true)


## Host: ends one player's connection without a ban (it may join again). close_code: 0, 1000 or 3000-4999.
func disconnect_peer(peer_id: int, close_code: int = 0, close_reason: String = "") -> void:
	if not _require_host("disconnect players"):
		return
	if close_code != 0 and not (close_code == 1000 or (close_code >= 3000 and close_code <= 4999)):
		push_error("OneLobby: close code must be 1000 or 3000-4999")
		return
	_c.send_signaling(OneLobbySignaling.kick(peer_id, false, close_code, close_reason.left(120)))
	if _peers.has(peer_id):
		_drop_peer(_peers[peer_id], "disconnected", true)


## Host: answers a join_requested.
func approve(peer_id: int, ok: bool) -> void:
	if _require_host("approve"):
		_c.send_signaling(OneLobbySignaling.approve(peer_id, ok))


## Leaves the lobby: tells the server and closes every peer link. session_ended does not fire for your own leave.
func leave() -> void:
	if _closed:
		return
	_c.send_signaling(OneLobbySignaling.simple("leave"))
	_close()


## Reliable bytes queued on all links and not yet sent.
func reliable_buffered_bytes() -> int:
	var n := 0
	for r: PeerRec in _peers.values():
		if r.link != null:
			n += r.link.buffered()
	for l: Array in _lingering:
		n += (l[0] as OneLobbyTransport.Link).buffered()
	return n


func is_closed() -> bool:
	return _closed


func _require_host(what: String) -> bool:
	if not is_host:
		push_error("OneLobby: only the host can " + what)
	return is_host


# ---- start and links -----------------------------------------------------------------------------------------------

func _start() -> void:
	if is_host:
		is_ready = true
		for r: PeerRec in _peers.values():
			if r.id != local_peer_id:
				_connect_peer(r, true)
	else:
		if _peers.has(_host_id):
			_connect_peer(_peers[_host_id], false)
		if _c.ready_timeout_ms > 0:
			_ready_deadline_ms = now_ms() + _c.ready_timeout_ms


func _connect_peer(rec: PeerRec, initiator: bool) -> void:
	if rec.link != null:
		rec.link.close()
	rec.open_handled = false
	rec.hello = false
	rec.hi_sent = false
	rec.link = _c.transport.create_link({
		"remote_id": rec.id, "initiator": initiator, "ice_servers": _c.ice, "relay_only": _c.relay_only,
	})
	rec.last_rx_ms = now_ms()
	if initiator:
		rec.link.start_offer()


func _watch_ready(rec: PeerRec) -> void:
	rec.watching = true
	rec.watch_deadline_ms = now_ms() + _c.ready_timeout_ms if _c.ready_timeout_ms > 0 else 0


func _send_to_host(ch: int, data: PackedByteArray) -> void:
	if _peers.has(_host_id):
		_send_link(_peers[_host_id], ch, data)


func _send_to_peer(peer_id: int, ch: int, data: PackedByteArray) -> void:
	if _peers.has(peer_id):
		_send_link(_peers[peer_id], ch, data)


func _send_link(r: PeerRec, ch: int, data: PackedByteArray) -> void:
	if r.link == null or r.link.is_failed:
		return
	if not r.link.is_open:
		# still being set up: keep reliable sends in order and flush them when it opens
		if ch == OneLobbyWire.RELIABLE and r.pending.size() < MAX_PENDING:
			r.pending.append([ch, data])
		return
	if data.size() <= OneLobbyWire.MAX_FRAME:
		r.link.send(ch, data)
		return
	_big_id = (_big_id + 1) & 0xFFFFFFFF
	for chunk in OneLobbyChunker.split(_big_id, data):
		r.link.send(OneLobbyWire.RELIABLE, chunk)


func _hello_peers() -> Array[PeerRec]:
	var out: Array[PeerRec] = []
	for r: PeerRec in _peers.values():
		if r.id != local_peer_id and r.hello and r.link != null and r.link.is_open:
			out.append(r)
	return out


func _set_phase(p: String) -> void:
	if phase == p:
		return
	phase = p
	phase_changed.emit(p)


# ---- the pump ------------------------------------------------------------------------------------------------------

func _pump() -> void:
	if _closed:
		return
	var now := now_ms()
	if not _held.is_empty():
		_release_held_signals(now)
	for i in range(_lingering.size() - 1, -1, -1):
		if now >= int(_lingering[i][1]):
			(_lingering[i][0] as OneLobbyTransport.Link).close()
			_lingering.remove_at(i)
	for rec: PeerRec in _peers.values().duplicate():
		if rec.link == null or _closed:
			continue
		for sig in rec.link.take_signals():
			_c.send_signaling(OneLobbySignaling.signal_to(rec.id, sig))
		if rec.link.is_open and not rec.open_handled:
			rec.open_handled = true
			rec.last_rx_ms = now
			_on_link_open(rec)
		# drain before handling a failure: frames that arrived before the close are still the peer's last words
		if rec.link != null:
			for item: Array in rec.link.receive():
				rec.last_rx_ms = now
				if rec.departing:
					rec.depart_at_ms = mini(now + LEAVE_GRACE_MS, rec.depart_cap_ms)
				_handle_frame(rec, item[0], item[1])
				if _closed or rec.link == null:
					break
		if _closed:
			return
		if rec.link != null and rec.link.is_failed:
			if rec.departing:
				_finish_departure(rec)
			else:
				_link_lost(rec)
			if _closed:
				return
	for rec: PeerRec in _peers.values().duplicate():
		if rec.departing and now >= rec.depart_at_ms:
			_finish_departure(rec)
			if _closed:
				return
	_check_ready_timer(now)
	if _closed:
		return
	_check_peer_watches(now)
	if _closed:
		return
	_timeouts(now)
	if _closed:
		return
	if now - _last_ping_ms >= PING_EVERY_MS:
		_last_ping_ms = now
		_ping_n += 1
		var ping := OneLobbyWire.build_ping(OneLobbyWire.PING, _ping_n, now)
		for r: PeerRec in _peers.values():
			if r.id != local_peer_id and r.link != null and r.link.is_open and (is_host or r.id == _host_id):
				r.link.send(OneLobbyWire.FAST, ping)


func _check_ready_timer(now: int) -> void:
	if _ready_deadline_ms == 0:
		return
	if is_ready or is_host:
		_ready_deadline_ms = 0
		return
	if now < _ready_deadline_ms:
		return
	_ready_deadline_ms = 0
	var msg := "the link to the host did not open in %s s: likely a firewall or strict NAT" % str(_c.ready_timeout_ms / 1000.0)
	_c.raise_error("ice_failed", msg)
	if _closed:
		return
	_c.send_signaling(OneLobbySignaling.simple("leave"))
	_end("ice_failed")


func _check_peer_watches(now: int) -> void:
	if not is_host:
		return
	for rec: PeerRec in _peers.values().duplicate():
		if rec.watching and rec.watch_deadline_ms != 0 and now >= rec.watch_deadline_ms:
			rec.watch_deadline_ms = 0
			rec.watching = false
			peer_failed.emit(_to_peer(rec), "timeout")
			if _closed:
				return


func _timeouts(now: int) -> void:
	if is_host:
		for r: PeerRec in _peers.values().duplicate():
			if r.id != local_peer_id and r.link != null and r.open_handled and now - r.last_rx_ms > _peer_timeout_ms:
				_drop_peer(r, "timeout")
		return
	if _awaiting_claim and now > _await_deadline_ms:
		# the elected host never showed up: it is gone too
		_awaiting_claim = false
		if _peers.has(_host_id):
			_drop_peer(_peers[_host_id], "timeout")
		_elect_host()
		return
	var h: PeerRec = _peers.get(_host_id)
	if not _awaiting_claim and h != null and h.open_handled and now - h.last_rx_ms > _host_timeout_ms:
		_host_lost()


func _allow_raw(from: int) -> bool:
	var msgs := int(rate_limit.get("messages", 0))
	var per := int(rate_limit.get("per_ms", 0))
	if msgs <= 0 or per <= 0:
		return true
	var now := now_ms()
	var w: Array = _rate.get(from, [now, 0])
	if now - int(w[0]) >= per:
		w = [now, 0]
	w[1] = int(w[1]) + 1
	_rate[from] = w
	return int(w[1]) <= msgs


func _on_link_open(rec: PeerRec) -> void:
	# telemetry (the server counts relayed vs direct): one report per connection
	_c.send_signaling(OneLobbySignaling.path(rec.link.relayed))
	if is_host:
		if _epoch > 0:
			_send_link(rec, OneLobbyWire.RELIABLE, OneLobbyWire.build_host_claim(_epoch, local_peer_id, 0))
	elif rec.id == _host_id:
		_send_hi(rec)
	var queued := rec.pending
	rec.pending = []
	for q: Array in queued:
		_send_link(rec, q[0], q[1])


func _send_hi(rec: PeerRec) -> void:
	rec.hi_sent = true
	_send_link(rec, OneLobbyWire.RELIABLE, OneLobbyWire.build_hi(local_peer_id, -1))


func _raise_ready(rec: PeerRec) -> void:
	if rec.ready_raised:
		return
	rec.ready_raised = true
	rec.watching = false
	peer_ready.emit(_to_peer(rec))


# ---- inbound frames ------------------------------------------------------------------------------------------------

func _handle_frame(rec: PeerRec, ch: int, data: PackedByteArray, reassembled: bool = false) -> void:
	var m := OneLobbyWire.decode(data, OneLobbyWire.MAX_REASSEMBLED if reassembled else OneLobbyWire.MAX_FRAME)
	if m.has("error"):
		return # malformed frame: drop
	match int(m["typeId"]):
		OneLobbyWire.PING:
			_send_link(rec, ch, OneLobbyWire.build_ping(OneLobbyWire.PONG, m["n"], m["t"]))
			return
		OneLobbyWire.PONG:
			rec.ping_ms = maxi(0, (now_ms() - int(m["t"])) & 0xFFFFFFFF)
			return
		OneLobbyWire.CHUNK:
			var res := rec.chunks.add(data.slice(OneLobbyWire.HEADER))
			if res.get("done", false):
				var all: PackedByteArray = res["bytes"]
				# an oversized frame sent in chunks: the bytes are one complete inner frame
				if all.size() > 0 and all[0] != OneLobbyWire.CHUNK:
					_handle_frame(rec, ch, all, true)
			return
	if is_host:
		_handle_as_host(rec, ch, m, data)
	else:
		_handle_as_joiner(rec, ch, m)


func _handle_as_host(rec: PeerRec, ch: int, m: Dictionary, data: PackedByteArray) -> void:
	match int(m["typeId"]):
		OneLobbyWire.HI:
			if int(m["proto"]) != OneLobbyWire.PROTO:
				return
			rec.hello = true
			_raise_ready(rec)
			_send_link(rec, OneLobbyWire.RELIABLE, OneLobbyWire.build_welcome_dc(0, tick_rate,
				OneLobbyWire.MODE_RAW if mode == "raw" else OneLobbyWire.MODE_LOCKSTEP, local_peer_id))
			_send_link(rec, OneLobbyWire.RELIABLE, OneLobbyWire.build_chat_history_empty())
		OneLobbyWire.HOST_CLAIM:
			var hid := int(m["hostId"])
			var ep := int(m["epoch"])
			if hid != rec.id:
				return # a claim is the claimant's own
			if ep > _epoch or (ep == _epoch and hid < local_peer_id):
				_demote(hid, ep)
		OneLobbyWire.RAW:
			if not _allow_raw(rec.id):
				return
			var route := int(m["route"])
			if route == 0 or route == local_peer_id:
				message_received.emit(rec.id, m["bytes"], ch)
			if route == 0:
				var f := OneLobbyWire.with_route(data, rec.id)
				for r2 in _hello_peers():
					if r2.id != rec.id:
						_send_link(r2, ch, f)
			elif route != local_peer_id:
				var dest: PeerRec = _peers.get(route)
				if dest != null and dest.hello:
					_send_link(dest, ch, OneLobbyWire.with_route(data, rec.id))


func _handle_as_joiner(rec: PeerRec, ch: int, m: Dictionary) -> void:
	var t := int(m["typeId"])
	if t == OneLobbyWire.HOST_CLAIM:
		if int(m["hostId"]) == rec.id:
			_accept_claim(rec, int(m["epoch"]), int(m["hostId"]))
		return
	if rec.id != _host_id:
		return # joiners only listen to the host
	match t:
		OneLobbyWire.WELCOME_DC:
			if int(m["hostId"]) != _host_id:
				return
			if int(m["tick"]) > 0:
				_set_phase("in_game")
			if not is_ready:
				is_ready = true
				ready.emit()
			_raise_ready(rec)
		OneLobbyWire.RAW:
			message_received.emit(int(m["route"]), m["bytes"], ch)


# ---- server messages -----------------------------------------------------------------------------------------------

func _on_signaling(t: String, e: Dictionary) -> void:
	if _closed:
		return
	match t:
		"peer_joined":
			var p: Variant = e.get("peer")
			if not p is Dictionary:
				return
			var id := OneLobbySignaling.i(p, "peerId")
			# a resume that beat the departure grace: the old seat goes now, the new one connects fresh
			if _peers.has(id) and (_peers[id] as PeerRec).departing:
				_finish_departure(_peers[id])
			if _closed or id == local_peer_id or _peers.has(id):
				return
			var rec := _rec(id, OneLobbySignaling.s(p, "name"))
			_peers[id] = rec
			if is_host:
				_watch_ready(rec)
				_connect_peer(rec, true)
			peer_joined.emit(_to_peer(rec))
		"peer_left":
			var id := OneLobbySignaling.i(e, "peerId")
			var reason := OneLobbySignaling.s(e, "reason", "left")
			if id == local_peer_id:
				_end(reason if reason == "kicked" or reason == "disconnected" else "server_closed")
				return
			var rec: PeerRec = _peers.get(id)
			if rec == null or rec.departing:
				return
			if not is_host and id == _host_id:
				_depart(rec, func() -> void:
					_drop_peer(rec, reason)
					_host_lost(true))
			else:
				_depart(rec, func() -> void: _drop_peer(rec, reason))
		"host_changed":
			var id := OneLobbySignaling.i(e, "hostId")
			var ep := OneLobbySignaling.i(e, "epoch")
			if id != _host_id and id != 0:
				_switch_host(id)
			if ep > _epoch and id == _host_id:
				_epoch = ep
		"join_request":
			var p: Variant = e.get("peer")
			if p is Dictionary:
				join_requested.emit({"peer_id": OneLobbySignaling.i(p, "peerId"), "name": OneLobbySignaling.s(p, "name"), "ping_ms": 0, "relayed": false})
		"signal":
			var from := OneLobbySignaling.i(e, "from")
			var sig := OneLobbySignaling.signal_of(e)
			if sig.is_empty() or not _peers.has(from):
				return
			if not is_host and not _accepts_signal_from(from):
				# only the host dials a joiner; keep a roster member's offer for the moment the host is declared lost
				_hold_signal(from, sig)
				return
			_deliver_signal(_peers[from], sig)
		"lobby":
			meta = OneLobbySignaling.meta_of(e)
			if OneLobbySignaling.s(e, "name") != "":
				name = OneLobbySignaling.s(e, "name")
			if OneLobbySignaling.s(e, "resumeToken") != "":
				resume_token = OneLobbySignaling.s(e, "resumeToken")
			_set_phase(OneLobbySignaling.s(e, "phase", "lobby"))
			var list: Variant = e.get("peers")
			if list is Array:
				for p: Variant in list:
					var id := OneLobbySignaling.i(p, "peerId")
					if _peers.has(id):
						continue
					var rec := _rec(id, OneLobbySignaling.s(p, "name"))
					_peers[id] = rec
					if is_host and id != local_peer_id:
						_watch_ready(rec)
						_connect_peer(rec, true)
					peer_joined.emit(_to_peer(rec))
			var hid := OneLobbySignaling.i(e, "hostId", _host_id)
			if hid != _host_id:
				_switch_host(hid)


func _deliver_signal(rec: PeerRec, sig: Dictionary) -> void:
	var is_offer := str(sig.get("type", "")) == "offer"
	if rec.link == null:
		if not is_offer or is_host:
			return
		_connect_peer(rec, false) # a peer is dialing us (a new host, or a rival claimant): its claim decides
	elif is_host and is_offer and _epoch == 0 and not rec.hello and not rec.link.is_open:
		_connect_peer(rec, false) # a joiner whose link never opened dials us itself
	rec.link.apply_signal(sig)


func _hold_signal(from: int, sig: Dictionary) -> void:
	if str(sig.get("type", "")) == "offer":
		_held[from] = {"at": now_ms(), "signals": [sig]}
	elif _held.has(from) and (_held[from]["signals"] as Array).size() < MAX_HELD_ICE:
		(_held[from]["signals"] as Array).append(sig)


func _release_held_signals(now: int) -> void:
	for from: int in _held.keys():
		var h: Dictionary = _held[from]
		if now - int(h["at"]) > HELD_OFFER_MS or not _peers.has(from):
			_held.erase(from)
			continue
		if not _accepts_signal_from(from):
			continue
		_held.erase(from)
		for sig: Dictionary in h["signals"]:
			_deliver_signal(_peers[from], sig)


## A joiner takes offers only from its host, or from a roster member while the host link is not open (migration).
func _accepts_signal_from(from: int) -> bool:
	if from == _host_id:
		return true
	var h: PeerRec = _peers.get(_host_id)
	var alive := not _awaiting_claim and h != null and h.link != null and h.link.is_open and not h.link.is_failed
	return not alive


func _on_server_error(error_code: String, disconnected: bool) -> void:
	if error_code == "kicked":
		_end("disconnected" if disconnected else "kicked")


func _on_socket_closed() -> void:
	if _closed:
		return
	# data channels keep the running game alive; only a joiner without a host link is stranded
	if not is_host and not is_ready and not _awaiting_claim:
		_end("server_closed")


# ---- departures ----------------------------------------------------------------------------------------------------

func _to_peer(r: PeerRec) -> Dictionary:
	return {"peer_id": r.id, "name": r.name, "ping_ms": r.ping_ms, "relayed": r.link != null and r.link.relayed}


func _drop_peer(rec: PeerRec, reason: String, linger: bool = false) -> void:
	if not _peers.has(rec.id):
		return
	_peers.erase(rec.id)
	if linger and rec.link != null:
		_lingering.append([rec.link, now_ms() + KICK_LINGER_MS])
	elif rec.link != null:
		rec.link.close()
	rec.link = null
	if rec.watching:
		rec.watching = false
		if reason != "kicked" and reason != "disconnected":
			peer_failed.emit(_to_peer(rec), reason)
	peer_left.emit(_to_peer(rec), reason)


## Runs `finish` now, or once the open link to `rec` closes (at most LEAVE_MAX_MS).
func _depart(rec: PeerRec, finish: Callable) -> void:
	if rec.departing:
		return
	if rec.link == null:
		finish.call()
		return
	rec.departing = true
	rec.depart_finish = finish
	rec.depart_at_ms = now_ms() + LEAVE_GRACE_MS
	rec.depart_cap_ms = now_ms() + LEAVE_MAX_MS
	if not rec.link.is_open:
		_finish_departure(rec)


func _finish_departure(rec: PeerRec) -> void:
	if not rec.departing:
		return
	rec.departing = false
	if rec.link != null:
		for item: Array in rec.link.receive():
			_handle_frame(rec, item[0], item[1])
			if _closed or rec.link == null:
				break
	if not _closed and rec.depart_finish.is_valid():
		rec.depart_finish.call()


func _link_lost(rec: PeerRec) -> void:
	if is_host:
		if rec.id != local_peer_id:
			_drop_peer(rec, "timeout")
		return
	if rec.id == _host_id:
		if _awaiting_claim:
			return # the timeout check elects the next one
		_peers.erase(rec.id)
		rec.link.close()
		rec.link = null
		peer_left.emit(_to_peer(rec), "timeout")
		_host_lost(true)


# ---- host migration ------------------------------------------------------------------------------------------------

func _host_lost(already_removed: bool = false) -> void:
	if not already_removed and _peers.has(_host_id):
		_drop_peer(_peers[_host_id], "timeout")
	is_ready = false
	_elect_host()


func _elect_host() -> void:
	if _closed:
		return
	var next := local_peer_id
	for id: int in _peers.keys():
		next = mini(next, id)
	if next == local_peer_id:
		_become_host()
	else:
		_await_host(next)


func _switch_host(id: int) -> void:
	if id == _host_id:
		return
	if not is_host and _peers.has(_host_id) and id != _host_id and _peers.has(id):
		_drop_peer(_peers[_host_id], "timeout")
	is_ready = false
	if id == local_peer_id:
		_become_host()
	else:
		_await_host(id)


func _await_host(id: int) -> void:
	_host_id = id
	_awaiting_claim = true
	_await_deadline_ms = now_ms() + CLAIM_WAIT_MS
	if not _peers.has(id):
		_peers[id] = _rec(id, "?")
	var rec: PeerRec = _peers[id]
	if rec.link == null or rec.link.is_failed:
		_connect_peer(rec, false)


## A claim wins on a higher epoch, or an equal epoch with a lower host id than the current one.
func _accept_claim(rec: PeerRec, epoch: int, hid: int) -> void:
	if not (epoch > _epoch or (epoch == _epoch and hid < _host_id)):
		return
	_epoch = epoch
	var changed := hid != _host_id or _awaiting_claim
	_host_id = hid
	_awaiting_claim = false
	is_ready = true
	if rec.link != null and rec.link.is_open and not rec.hi_sent:
		_send_hi(rec)
	if changed:
		host_changed.emit(hid)


func _become_host() -> void:
	_epoch += 1
	_host_id = local_peer_id
	_awaiting_claim = false
	is_ready = true
	for r: PeerRec in _peers.values():
		if r.id != local_peer_id:
			_connect_peer(r, true)
	_c.send_signaling(OneLobbySignaling.host_changed(local_peer_id, _epoch))
	host_changed.emit(local_peer_id)


func _demote(new_host: int, epoch: int) -> void:
	_epoch = epoch
	_host_id = new_host
	for r: PeerRec in _peers.values():
		if r.id != new_host and r.link != null:
			r.link.close()
			r.link = null
			r.hello = false
	_awaiting_claim = false
	is_ready = true
	var h: PeerRec = _peers.get(new_host)
	if h != null and h.link == null:
		_connect_peer(h, false)
	host_changed.emit(new_host)


# ---- teardown ------------------------------------------------------------------------------------------------------

func _end(reason: String) -> void:
	if _closed:
		return
	_close()
	session_ended.emit(reason)


func _close() -> void:
	_closed = true
	for r: PeerRec in _peers.values():
		if r.link != null:
			r.link.close()
		r.link = null
	for l: Array in _lingering:
		(l[0] as OneLobbyTransport.Link).close()
	_lingering.clear()
	_c._lobby_closed(self)
