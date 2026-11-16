class_name OneLobbyLobby
extends RefCounted
## One lobby you host or joined (raw or lockstep mode). Made by OneLobbyClient.host / join / rejoin; events arrive as signals
## from inside the client's per-frame pump. Peers are Dictionaries {peer_id, name, ping_ms, relayed}. `chat`, `pause` and
## (in a lockstep lobby) `lockstep` are the sync helpers on top of the same links.
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
## Host only: a joiner that could not connect told you why (spec/diagnostics.md s.7.3). `info`: {peer, name, cause, stage,
## elapsedMs, relaySet, natType?, candidateTypes, clientVersion, message (the sentence the joiner saw), hint (what you can
## do), line (one line for a host screen: "Sam: strict NAT, no relay set, stopped at the connection check after 15 s.")}.
signal peer_diagnosis(info: Dictionary)
## Host only: a joiner never got its link open ("timeout" after ready_timeout_ms, or the reason it left with).
signal peer_failed(peer: Dictionary, reason: String)
## Host only: an approval lobby asks whether this peer may join; answer with approve().
signal join_requested(peer: Dictionary)
signal host_changed(host_id: int)
## A member (you included) changed its display name mid-session (rename): the peer with its new name, and the old name.
signal peer_renamed(peer: Dictionary, old_name: String)
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
## leave_and_flush keeps the peer links open this long after the leave has gone out, so peers hear the leave before
## the channels close under them.
const LEAVE_LINGER_MS := 300
const HELD_OFFER_MS := 20000
const MAX_HELD_ICE := 32
const MAX_PENDING := 1024

var code := ""
## Direct host with an IP path (udp_port_range / tcp_port / nostr false): the version 0 code of its address and port, else "".
var ip_code := ""
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
## "raw" or "lockstep" (the host's choice; lobby.lockstep runs only in a lockstep lobby).
var mode := "raw"
var tick_rate := 30
var late_join := true
## Host: {messages, per_ms} caps raw frames per peer in a fixed window ({} = no cap).
var rate_limit := {}
var is_ready := false
## Text chat (works in raw and lockstep lobbies).
var chat: OneLobbyChat
## The shared pause.
var pause: OneLobbyPause
## Host-ordered lockstep (frames, commands, hashes, snapshots); idle in a raw lobby.
var lockstep: OneLobbyLockstep
## The room layer: roster with per-player data, ready, countdown and auto start, spectators, seats, kick and ban
## (docs/recipes/room.md, spec/room.md). Every lobby has one.
var room: OneLobbyRoom
## Why this peer was removed from the lobby ({code, reason, ban}), or {} (spec/room.md 5.1). `room.removed` fires with the same.
var removal := {}

var _c: OneLobbyClient
## Direct mode: no server, so no host migration. The host leaving (or the joiner losing its signaling) ends the session.
var _direct := false
var _host_id := 0
var _epoch := 0
## The last tick applied when this peer claimed host: every host_claim of the epoch carries it.
var _claim_tick := 0
var _closed := false
var _awaiting_claim := false
var _await_deadline_ms := 0
var _last_ping_ms := 0
var _ping_n := 0
var _big_id := 0x80000000
var _peer_timeout_ms := PEER_TIMEOUT_MS
var _host_timeout_ms := HOST_TIMEOUT_MS
var _ready_deadline_ms := 0
var _ready_retry_budget_ms := 0 ## > 0: the deadline starts one relay-only retry with this budget instead of giving up
var _peers := {} # id -> PeerRec
var _held := {} # from -> {at, signals}
var _lingering: Array = [] # [link, until]
var _rate := {} # id -> [start, n]
## Host: phases this lobby sent whose echo (a `lobby` message) has not come back yet, oldest first.
var _phase_sent: Array = []
var _addrs := {} # peer id -> remote address of its link, once known
var _last_addr_poll_ms := 0
const ADDR_POLL_MS := 500


class OLPeerRec:
	var id := 0
	var name := ""
	var link: OneLobbyTransport.OLLink
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


func _init(client: OneLobbyClient, msg: Dictionary, room_setup: Dictionary = {}) -> void:
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
		_peers[local_peer_id] = _rec(local_peer_id, client.effective_name())
	if not _peers.has(_host_id):
		_peers[_host_id] = _rec(_host_id, "host")
	if client.peer_timeout_ms > 0:
		_peer_timeout_ms = maxi(client.peer_timeout_ms, MIN_PEER_TIMEOUT_MS)
		_host_timeout_ms = _peer_timeout_ms
	chat = OneLobbyChat.new(self)
	lockstep = OneLobbyLockstep.new(self, client.hash_every_ticks if client.hash_every_ticks > 0 else tick_rate)
	pause = OneLobbyPause.new(self)
	_make_room(msg, room_setup)


## The room layer's inputs: `setup` {options, password, max_players, pid, bans, join {role, data, password}} (all optional).
func _make_room(msg: Dictionary, setup: Dictionary) -> void:
	var j: Dictionary = setup.get("join", {})
	var max_players := int(setup.get("max_players", 0))
	if max_players <= 0:
		max_players = OneLobbySignaling.i(msg, "maxPlayers")
	if max_players <= 0:
		max_players = maxi(2, _peers.size())
	room = OneLobbyRoom.new(self, {
		"settings": OneLobbyRoomRules.resolve_settings(setup.get("options", {}), max_players, late_join),
		"password": str(setup.get("password", "")),
		"pid": str(setup.get("pid", "")),
		"bans": setup["bans"] if setup.get("bans") is OneLobbyBanList else OneLobbyBanList.new(null, _c.game_id),
		"join": {"role": "spectator" if j.get("role") == "spectator" else "player", "data": (j.get("data", {}) as Dictionary).duplicate(), "password": str(j.get("password", ""))},
	})
	chat.host_filter = func(t: String) -> String: return OneLobbyRoomRules.apply_filter(room.filter, t, "chat")
	if is_host and not room.bans.hub_ids().is_empty():
		_send_bans(room.bans.hub_ids())


static func _rec(id: int, peer_name: String) -> OLPeerRec:
	var r := OLPeerRec.new()
	r.id = id
	r.name = peer_name
	return r


# ---- public --------------------------------------------------------------------------------------------------------

func now_ms() -> int:
	return _c.transport.now_ms()


## The client's net log (spec/diagnostics.md): where a replication session writes its packet log.
func get_net_log() -> OneLobbyNetLog:
	return _c.get_net_log()


## Everyone in the lobby, you included.
func peers() -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for r: OLPeerRec in _peers.values():
		out.append(_to_peer(r))
	return out


## Round trip in ms from OneLobby's own 1 s pings (host: any peer; joiner: the host); 0 before the first pong.
func ping_ms(peer_id: int) -> int:
	return (_peers[peer_id] as OLPeerRec).ping_ms if _peers.has(peer_id) else 0


func is_peer_ready(peer_id: int) -> bool:
	if peer_id == local_peer_id:
		return true
	var r: OLPeerRec = _peers.get(peer_id)
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
		for r: OLPeerRec in _peers.values():
			if r.id != local_peer_id and r.link != null:
				_send_link(r, ch, f)
	else:
		_send_to_host(ch, OneLobbyWire.build_raw(0, bytes))


## Host: marks the game started (phase "in_game"; the server stops listing it unless late join is on).
func start() -> void:
	if not _require_host("start the game"):
		return
	_begin_game()


## Host: back to the lobby screen.
func end_game() -> void:
	if not _require_host("end the game"):
		return
	_end_game()


## Host: the phase goes to in_game (the room calls this at the end of its countdown).
func _begin_game() -> void:
	if phase == "in_game":
		return
	_c.send_signaling(OneLobbySignaling.phase(true))
	_sent_phase("in_game")
	_set_phase("in_game")
	if mode == "lockstep":
		lockstep._host_start()


## Host: the phase goes back to lobby without touching any link (back to lobby, rematch).
func _end_game() -> void:
	if phase == "lobby":
		return
	_c.send_signaling(OneLobbySignaling.phase(false))
	_sent_phase("lobby")
	_set_phase("lobby")


func _sent_phase(p: String) -> void:
	_phase_sent.append(p)
	if _phase_sent.size() > 16:
		_phase_sent.pop_front()


## Changes your display name mid-session. The hub sanitises it (as at hello, at most 24 characters) and every member,
## you included, gets peer_renamed. Names need not be unique. At most one rename per second; a refusal (bad_request for
## an empty name, rate_limited) arrives on the client's error signal. Returns false, and emits error "unsupported",
## when the hub is too old to rename.
func rename(new_name: String) -> bool:
	if not _c.features.has("set_name"):
		_c.error.emit("unsupported", "this lobby's hub cannot rename players (update it)")
		return false
	_c.send_signaling(OneLobbySignaling.rename_msg(new_name))
	return true


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


## leave(), then waits until the leave message has really gone out (at most `timeout_ms`), after letting reliable data
## already queued to peers drain first. The peer links stay open for `linger_ms` after that (nothing is sent or
## delivered on them), so peers learn of the leave before the channels close and don't send into closed ones; no
## game-level goodbye message is needed. Await it before quitting: leave() followed at once by get_tree().quit() can
## drop the message, and the server (or the Direct host) then sees a timeout instead of a leave.
##
##     await lobby.leave_and_flush()
##     get_tree().quit()
func leave_and_flush(timeout_ms: int = 1500, linger_ms: int = LEAVE_LINGER_MS) -> void:
	if _closed:
		return
	var client := _c
	var deadline := now_ms() + timeout_ms
	while reliable_buffered_bytes() > 0 and now_ms() < deadline and client.is_inside_tree():
		await client.get_tree().process_frame
	# take the links out first so leave() does not close them
	var links: Array[OneLobbyTransport.OLLink] = []
	for r: OLPeerRec in _peers.values():
		if r.link != null:
			links.append(r.link)
			r.link = null
	for l: Array in _lingering:
		links.append(l[0] as OneLobbyTransport.OLLink)
	_lingering.clear()
	leave()
	await client.flush_signaling(maxi(0, deadline - now_ms()))
	var until := now_ms() + linger_ms
	while now_ms() < until and client.is_inside_tree():
		for link in links:
			link.poll()
			link.receive()
		await client.get_tree().process_frame
	for link in links:
		link.close()


## Drops the connection to the lobby server (Direct mode: to the host's signaling) as a network loss would, without
## leaving. Peer links stay as they are. Meant for testing reconnects: afterwards call client.rejoin(resume_token).
func debug_drop() -> void:
	_c.disconnect_signaling()


## Reliable bytes queued on all links and not yet sent.
func reliable_buffered_bytes() -> int:
	var n := 0
	for r: OLPeerRec in _peers.values():
		if r.link != null:
			n += r.link.buffered()
	for l: Array in _lingering:
		n += (l[0] as OneLobbyTransport.OLLink).buffered()
	return n


func is_closed() -> bool:
	return _closed


func _require_host(what: String) -> bool:
	if not is_host:
		push_error("OneLobby: only the host can " + what)
	return is_host


# ---- start and links -----------------------------------------------------------------------------------------------

func _start() -> void:
	_diag_start()
	if is_host:
		is_ready = true
		if mode == "lockstep":
			if phase == "in_game":
				lockstep._host_start()
			else:
				lockstep._host_idle()
		for r: OLPeerRec in _peers.values():
			if r.id != local_peer_id:
				_connect_peer(r, true)
	else:
		if _peers.has(_host_id):
			_connect_peer(_peers[_host_id], false)
		_arm_ready_timer()


## Joiner connect timeout (same rules as the JS and C# clients): with a TURN entry and no relay_only, half the budget
## goes to the direct attempt and the second half to one relay-only retry.
func _arm_ready_timer() -> void:
	if _c.relay_only and not has_relay(_c.ice):
		# relay-only with no TURN entry can never connect: give up on the next tick, not after the ready timeout
		_ready_retry_budget_ms = 0
		_ready_deadline_ms = maxi(1, now_ms())
		return
	var total: int = _c.ready_timeout_ms
	if total <= 0:
		return
	var can_relay: bool = not _c.relay_only and has_relay(_c.ice)
	var first: int = (total + 1) / 2 if can_relay else total
	_ready_retry_budget_ms = total - first if can_relay else 0
	_ready_deadline_ms = now_ms() + first


## True when an ICE server list holds a TURN entry (turn: or turns:).
static func has_relay(ice: Array) -> bool:
	for s in ice:
		if typeof(s) != TYPE_DICTIONARY:
			continue
		var urls: Variant = (s as Dictionary).get("urls", [])
		var list: Array = urls if urls is Array else [urls]
		for u in list:
			var lu := str(u).to_lower()
			if lu.begins_with("turn:") or lu.begins_with("turns:"):
				return true
	return false


## The ice_failed message: names the next step. Same wording in the JS and C# clients (keep in step).
static func ice_failed_message(relay_configured: bool, by_ip := false) -> String:
	if by_ip:
		return "Could not connect to the host by its IP address. The host must port-forward its UDP port range as well as the TCP port, or the players can use a relay (TURN), see docs/recipes/turn.md."
	if relay_configured:
		return "Could not connect to the host, even through the relay (TURN). Check the relay is reachable (Godot reaches TURN over UDP only); the host can also port-forward."
	return "Could not connect to the host. Strict NATs need a relay (TURN), see docs/recipes/turn.md; the host can also port-forward."


## Host side: every peer connection takes one UDP port of the forwarded range, so a range of N ports serves N players.
static func port_range_full_message(range: Array) -> String:
	return "No free UDP port left in the host's port range %d-%d (one port per player). Widen udp_port_range, port-forward it, or use a relay (TURN), see docs/recipes/turn.md." % [int(range[0]), int(range[1])]


func _connect_peer(rec: OLPeerRec, initiator: bool, relay_only := false) -> void:
	if is_host and _c.relay_only and not has_relay(_c.ice):
		# relay-only with no TURN entry can never connect: report it now instead of at the ready timeout
		_c.raise_error("ice_failed", ice_failed_message(false))
		if rec.watching:
			rec.watching = false
			rec.watch_deadline_ms = 0
			peer_failed.emit(_to_peer(rec), "ice_failed")
		return
	if rec.link != null:
		rec.link.close()
	rec.open_handled = false
	rec.hello = false
	rec.hi_sent = false
	rec.link = _c.transport.create_link({
		"remote_id": rec.id, "initiator": initiator, "ice_servers": _c.ice, "relay_only": relay_only or _c.relay_only,
		"port_range": _c.port_range, "remote_ip": _c.remote_ip,
	})
	_diag_link(rec)
	if rec.link is OneLobbyGodotTransport.OLRtcLink and rec.link.fail_reason == "port_range_full":
		_c.raise_error("ice_failed", port_range_full_message(_c.port_range))
	rec.last_rx_ms = now_ms()
	if initiator:
		rec.link.start_offer()


func _watch_ready(rec: OLPeerRec) -> void:
	rec.watching = true
	rec.watch_deadline_ms = now_ms() + _c.ready_timeout_ms if _c.ready_timeout_ms > 0 else 0


func _send_to_host(ch: int, data: PackedByteArray) -> void:
	if _peers.has(_host_id):
		_send_link(_peers[_host_id], ch, data)


func _send_to_peer(peer_id: int, ch: int, data: PackedByteArray) -> void:
	if _peers.has(peer_id):
		_send_link(_peers[peer_id], ch, data)


func _send_link(r: OLPeerRec, ch: int, data: PackedByteArray) -> void:
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


func _hello_peers() -> Array[OLPeerRec]:
	var out: Array[OLPeerRec] = []
	for r: OLPeerRec in _peers.values():
		if r.id != local_peer_id and r.hello and r.link != null and r.link.is_open:
			out.append(r)
	return out


func _set_phase(p: String) -> void:
	if phase == p:
		return
	phase = p
	if p == "lobby":
		pause._on_lobby_phase()
		lockstep._reset() # back to lobby: the next start is a fresh match
	elif not lockstep.is_started:
		lockstep._mark_started()
	phase_changed.emit(p)
	room._on_phase(p)


# ---- the pump ------------------------------------------------------------------------------------------------------

func _pump() -> void:
	if _closed:
		return
	var now := now_ms()
	if not _held.is_empty():
		_release_held_signals(now)
	for i in range(_lingering.size() - 1, -1, -1):
		if now >= int(_lingering[i][1]):
			(_lingering[i][0] as OneLobbyTransport.OLLink).close()
			_lingering.remove_at(i)
	for rec: OLPeerRec in _peers.values().duplicate():
		if rec.link == null or _closed:
			continue
		for sig in rec.link.take_signals():
			_diag_note_signal("out", rec.id, sig)
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
	for rec: OLPeerRec in _peers.values().duplicate():
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
	_poll_addresses(now)
	room._tick(now)
	if _closed:
		return
	if mode == "lockstep":
		lockstep._pump(now)
		if _closed:
			return
	if now - _last_ping_ms >= PING_EVERY_MS:
		_last_ping_ms = now
		_ping_n += 1
		var ping := OneLobbyWire.build_ping(OneLobbyWire.PING, _ping_n, now)
		for r: OLPeerRec in _peers.values():
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
	if _ready_retry_budget_ms > 0 and _peers.has(_host_id):
		# the direct attempt stalled: dial the host ourselves through the TURN relay (a host answers an offer)
		_ready_deadline_ms = now + _ready_retry_budget_ms
		_ready_retry_budget_ms = 0
		_diag_retry()
		_connect_peer(_peers[_host_id], true, true)
		return
	_ready_deadline_ms = 0
	_give_up_connecting()


func _check_peer_watches(now: int) -> void:
	if not is_host:
		return
	for rec: OLPeerRec in _peers.values().duplicate():
		if rec.watching and rec.watch_deadline_ms != 0 and now >= rec.watch_deadline_ms:
			rec.watch_deadline_ms = 0
			rec.watching = false
			peer_failed.emit(_to_peer(rec), "timeout")
			if _closed:
				return


func _timeouts(now: int) -> void:
	if is_host:
		for r: OLPeerRec in _peers.values().duplicate():
			if r.id != local_peer_id and r.link != null and r.open_handled and now - r.last_rx_ms > _peer_timeout_ms:
				_drop_peer(r, "timeout")
		return
	if _awaiting_claim and not _direct and now > _await_deadline_ms:
		# the elected host never showed up: it is gone too
		_awaiting_claim = false
		if _peers.has(_host_id):
			_drop_peer(_peers[_host_id], "timeout")
		_elect_host()
		return
	var h: OLPeerRec = _peers.get(_host_id)
	if not _awaiting_claim and mode == "lockstep" and lockstep._host_silent():
		lockstep._touch()
		lockstep._poke_host() # a live-but-stalled host answers with a snapshot; a dead one is replaced below
		_host_lost()
		return
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


func _on_link_open(rec: OLPeerRec) -> void:
	# telemetry (the server counts relayed vs direct): one report per connection
	_diag_log("chan", "link to peer %d open" % rec.id)
	_diag_log("route", "relay" if rec.link.relayed else "direct")
	_c.send_signaling(OneLobbySignaling.path(rec.link.relayed))
	if is_host:
		if _epoch > 0:
			_send_link(rec, OneLobbyWire.RELIABLE, OneLobbyWire.build_host_claim(_epoch, local_peer_id, _claim_tick))
	elif rec.id == _host_id:
		_send_hi(rec)
	var queued := rec.pending
	rec.pending = []
	for q: Array in queued:
		_send_link(rec, q[0], q[1])


func _send_hi(rec: OLPeerRec) -> void:
	rec.hi_sent = true
	lockstep._touch()
	_send_link(rec, OneLobbyWire.RELIABLE, OneLobbyWire.build_hi(local_peer_id, lockstep.hi_tick()))
	if rec.id == _host_id:
		room._on_host_link() # right behind hi, in the same call: the room `join`


func _raise_ready(rec: OLPeerRec) -> void:
	if rec.ready_raised:
		return
	rec.ready_raised = true
	rec.watching = false
	peer_ready.emit(_to_peer(rec))


# ---- inbound frames ------------------------------------------------------------------------------------------------

func _handle_frame(rec: OLPeerRec, ch: int, data: PackedByteArray, reassembled: bool = false) -> void:
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
				if lockstep._snapshot_pending() and rec.id == _host_id:
					lockstep._on_snapshot_payload(all) # the chunk set that follows a snapshot header
				elif all.size() > 0 and all[0] != OneLobbyWire.CHUNK:
					# an oversized frame sent in chunks: the bytes are one complete inner frame
					_handle_frame(rec, ch, all, true)
			return
	if is_host:
		_handle_as_host(rec, ch, m, data)
	else:
		_handle_as_joiner(rec, ch, m)


func _handle_as_host(rec: OLPeerRec, ch: int, m: Dictionary, data: PackedByteArray) -> void:
	if _handle_sync(rec, m):
		return
	match int(m["typeId"]):
		OneLobbyWire.HI:
			if int(m["proto"]) != OneLobbyWire.PROTO:
				return
			rec.hello = true
			_raise_ready(rec)
			# welcome_dc.tick is the tick the snapshot will carry (the game's applied tick): 0 before the game starts and in raw mode
			_send_link(rec, OneLobbyWire.RELIABLE, OneLobbyWire.build_welcome_dc(lockstep.current_tick if mode == "lockstep" else 0, tick_rate,
				OneLobbyWire.MODE_RAW if mode == "raw" else OneLobbyWire.MODE_LOCKSTEP, local_peer_id))
			chat._send_history(rec.id)
			pause._send_state(rec.id)
			room._on_peer_hi(rec.id)
			if mode == "lockstep":
				lockstep._on_peer_hi(rec.id, int(m["lastTick"]))
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
				var dest: OLPeerRec = _peers.get(route)
				if dest != null and dest.hello:
					_send_link(dest, ch, OneLobbyWire.with_route(data, rec.id))


func _handle_as_joiner(rec: OLPeerRec, ch: int, m: Dictionary) -> void:
	var t := int(m["typeId"])
	if t == OneLobbyWire.HOST_CLAIM:
		if int(m["hostId"]) == rec.id:
			_accept_claim(rec, int(m["epoch"]), int(m["hostId"]))
		return
	if rec.id != _host_id:
		return # joiners only listen to the host
	if _handle_sync(rec, m):
		return
	match t:
		OneLobbyWire.WELCOME_DC:
			if int(m["hostId"]) != _host_id:
				return
			if int(m["tick"]) > 0:
				_set_phase("in_game")
			lockstep._touch()
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
			if _peers.has(id) and (_peers[id] as OLPeerRec).departing:
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
			var rec: OLPeerRec = _peers.get(id)
			if rec == null or rec.departing:
				return
			if not is_host and id == _host_id:
				_depart(rec, func() -> void:
					_drop_peer(rec, reason)
					if _direct:
						_end("host_left")
					else:
						_host_lost(true))
			else:
				_depart(rec, func() -> void: _drop_peer(rec, reason))
		"host_changed":
			var id := OneLobbySignaling.i(e, "hostId")
			var ep := OneLobbySignaling.i(e, "epoch")
			if _direct and not is_host:
				# a Direct lobby does not migrate: a new host means the real one is gone
				if id != _host_id:
					_end("host_left")
				return
			if id != _host_id and id != 0:
				_switch_host(id)
			if ep > _epoch and id == _host_id:
				_epoch = ep
		"join_request":
			var p: Variant = e.get("peer")
			if p is Dictionary:
				join_requested.emit({"peer_id": OneLobbySignaling.i(p, "peerId"), "name": OneLobbySignaling.s(p, "name"), "ping_ms": 0, "relayed": false})
		"diag":
			_diag_on_report(e)
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
			# the host is the source of the phase: while phase changes it sent are still echoing back, a late echo must not undo them
			var echoed := OneLobbySignaling.s(e, "phase", "lobby")
			if not is_host:
				_set_phase(echoed)
			elif not _phase_sent.is_empty():
				if echoed == _phase_sent[0]:
					_phase_sent.pop_front()
			else:
				_set_phase(echoed)
			var list: Variant = e.get("peers")
			if list is Array:
				for p: Variant in list:
					var id := OneLobbySignaling.i(p, "peerId")
					if _peers.has(id):
						var known: OLPeerRec = _peers[id]
						var new_name := OneLobbySignaling.s(p, "name")
						if known.name != new_name:
							var old_name := known.name
							known.name = new_name
							peer_renamed.emit(_to_peer(known), old_name)
							room._on_renamed(id, new_name)
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


func _deliver_signal(rec: OLPeerRec, sig: Dictionary) -> void:
	_diag_note_signal("in", rec.id, sig)
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
	if _direct:
		return false
	var h: OLPeerRec = _peers.get(_host_id)
	var alive := not _awaiting_claim and h != null and h.link != null and h.link.is_open and not h.link.is_failed
	return not alive


func _on_server_error(error_code: String, disconnected: bool, data: Dictionary = {}) -> void:
	if error_code != "kicked":
		return
	# a room `deny` the host sent over the data channel just before the kick carries the precise code (an old hub drops the
	# kick's code): read what the host link already holds before the session ends
	if not is_host and _peers.has(_host_id):
		var host: OLPeerRec = _peers[_host_id]
		if host.link != null:
			for item: Array in host.link.receive():
				_handle_frame(host, item[0], item[1])
				if _closed or host.link == null:
					break
		if _closed:
			return
	var raw_code := OneLobbySignaling.s(data, "code")
	var denied := OneLobbySignaling.s(data, "reason") == "denied"
	var rc := raw_code if OneLobbyRoomRules.is_code(raw_code) else ("denied" if denied else ("disconnected" if disconnected else "kicked"))
	if removal.is_empty():
		# a joiner the host has not answered yet was refused, never banned (spec/room.md 4.8): the host's `deny` frame says so
		# (ban false), but it races this signaling notice, so a notice that wins must not read as the ban itself
		var refused := not is_host and room.supported == null
		removal = {"code": rc, "reason": OneLobbyRoomRules.removal_reason(rc, OneLobbySignaling.s(data, "closeReason")),
			"ban": (not disconnected or rc == "banned") and not denied and not refused}
		if refused and raw_code == rc:
			_c.raise_error(rc, removal["reason"]) # what the `deny` frame would have said: the client's last_error names the refusal
	room._on_removed(removal)
	_end("disconnected" if disconnected else "kicked")


func _on_socket_closed() -> void:
	if _closed:
		return
	if _direct and not is_host:
		_end("host_left") # the signaling path to the host is the host's presence: no server to migrate to
		return
	# data channels keep the running game alive; only a joiner without a host link is stranded
	if not is_host and not is_ready and not _awaiting_claim:
		_end("server_closed")


# ---- departures ----------------------------------------------------------------------------------------------------

func _to_peer(r: OLPeerRec) -> Dictionary:
	return {"peer_id": r.id, "name": r.name, "ping_ms": r.ping_ms, "relayed": r.link != null and r.link.relayed}


func _drop_peer(rec: OLPeerRec, reason: String, linger: bool = false, final: bool = false) -> void:
	if not _peers.has(rec.id):
		return
	_peers.erase(rec.id)
	_addrs.erase(rec.id)
	lockstep._on_peer_left(rec.id)
	chat._on_peer_left(rec.id)
	pause._on_peer_left(rec.id)
	if linger and rec.link != null:
		_lingering.append([rec.link, now_ms() + KICK_LINGER_MS])
	elif rec.link != null:
		rec.link.close()
	rec.link = null
	room._on_peer_left(rec.id, reason, linger or final)
	if rec.watching:
		rec.watching = false
		if reason != "kicked" and reason != "disconnected":
			peer_failed.emit(_to_peer(rec), reason)
	peer_left.emit(_to_peer(rec), reason)


## Runs `finish` now, or once the open link to `rec` closes (at most LEAVE_MAX_MS).
func _depart(rec: OLPeerRec, finish: Callable) -> void:
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


func _finish_departure(rec: OLPeerRec) -> void:
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


func _link_lost(rec: OLPeerRec) -> void:
	if is_host:
		if rec.id != local_peer_id:
			_drop_peer(rec, "timeout")
		return
	if _direct and rec.id == _host_id:
		_peers.erase(rec.id)
		rec.link.close()
		rec.link = null
		peer_left.emit(_to_peer(rec), "timeout")
		_end("host_left")
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
	if _direct:
		_end("host_left")
		return
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
	var rec: OLPeerRec = _peers[id]
	if rec.link == null or rec.link.is_failed:
		_connect_peer(rec, false)


## A claim wins on a higher epoch, or an equal epoch with a lower host id than the current one.
func _accept_claim(rec: OLPeerRec, epoch: int, hid: int) -> void:
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
	# before lockstep starts emitting: a link that opens a frame later must still carry the claim's own tick
	_claim_tick = lockstep.last_tick
	if mode == "lockstep":
		lockstep._become_host()
	pause._on_became_host()
	room._on_became_host()
	_phase_sent.clear()
	for r: OLPeerRec in _peers.values():
		if r.id != local_peer_id:
			_connect_peer(r, true)
	_c.send_signaling(OneLobbySignaling.host_changed(local_peer_id, _epoch))
	host_changed.emit(local_peer_id)


func _demote(new_host: int, epoch: int) -> void:
	_epoch = epoch
	_host_id = new_host
	lockstep._become_joiner()
	room._on_became_joiner()
	for r: OLPeerRec in _peers.values():
		if r.id != new_host and r.link != null:
			r.link.close()
			r.link = null
			r.hello = false
	_awaiting_claim = false
	is_ready = true
	var h: OLPeerRec = _peers.get(new_host)
	if h != null and h.link == null:
		_connect_peer(h, false)
	host_changed.emit(new_host)


# ---- room plumbing (OneLobbyRoom uses these) -----------------------------------------------------------------------

func _peer_ids() -> Array:
	return _peers.keys()


func _peer_name(peer_id: int) -> String:
	return (_peers[peer_id] as OLPeerRec).name if _peers.has(peer_id) else ""


## The remote address of a peer's link, "" until the transport knows it.
func _link_address(peer_id: int) -> String:
	if _addrs.has(peer_id):
		return _addrs[peer_id]
	var r: OLPeerRec = _peers.get(peer_id)
	return r.link.remote_address if r != null and r.link != null else ""


func _set_removal(info: Dictionary) -> void:
	if removal.is_empty():
		removal = info


## Host: tells the hub the banned player ids, when the hub understands `bans`.
func _send_bans(ids: Array) -> void:
	if _c.features.has("room"):
		_c.send_signaling(OneLobbySignaling.bans(ids))


## The one place that sends `kick` with a code and a reason and removes the peer locally (the room's kick, ban and deny).
func _remove_peer_with(peer_id: int, ban: bool, code: String, reason: String) -> void:
	var text := reason
	while text.to_utf16_buffer().size() / 2 > 120:
		text = text.substr(0, text.length() - 1)
	_c.send_signaling(OneLobbySignaling.kick(peer_id, ban, 0, text, code))
	if _peers.has(peer_id):
		_drop_peer(_peers[peer_id], "kicked" if ban else "disconnected", true)


## Host: reads each link's remote address once it is known (a banned address is removed at once).
func _poll_addresses(now: int) -> void:
	if not is_host or now - _last_addr_poll_ms < ADDR_POLL_MS:
		return
	_last_addr_poll_ms = now
	for r: OLPeerRec in _peers.values().duplicate():
		if r.id == local_peer_id or _addrs.has(r.id) or r.link == null or r.link.remote_address == "":
			continue
		_addrs[r.id] = r.link.remote_address
		room._on_link_address(r.id, r.link.remote_address)
		if _closed:
			return


# ---- sync helpers (chat, pause and lockstep use these) -------------------------------------------------------------

## Chat, pause and lockstep traffic from `rec` (already known to be the host, or us hosting). True when `m` was one of them.
func _handle_sync(rec: OLPeerRec, m: Dictionary) -> bool:
	match str(m["type"]):
		"cmd", "hash", "snapshot_req", "frame", "desync", "snapshot":
			if mode == "lockstep":
				lockstep._handle(rec.id, m)
		"chat", "chat_history", "chat_reject":
			chat._handle(rec.id, int(m["route"]), m)
		"pause_request", "pause_state", "pause_refuse":
			pause._handle(rec.id, m)
		"room":
			if not is_host or rec.hello: # a host ignores a room frame from a peer that has not said hi
				room._handle_frame(rec.id, m["body"])
		_:
			return false
	return true


## Encodes `msg` (route stamps the frame's route field) and sends it to one peer on the reliable channel.
func _send_msg(peer_id: int, msg: Dictionary, route: int = 0) -> void:
	msg["route"] = route
	var bytes := OneLobbyWire.encode(msg, OneLobbyWire.MAX_REASSEMBLED)
	if not bytes.is_empty():
		_send_to_peer(peer_id, OneLobbyWire.RELIABLE, bytes)


## A joiner's message to the host (does nothing on the host itself).
func _send_msg_to_host(msg: Dictionary) -> void:
	if is_host:
		return
	msg["route"] = 0
	var bytes := OneLobbyWire.encode(msg, OneLobbyWire.MAX_REASSEMBLED)
	if not bytes.is_empty():
		_send_to_host(OneLobbyWire.RELIABLE, bytes)


## An already encoded frame to one peer on the reliable channel (a frame over 16384 bytes goes out as chunks).
func _send_bytes(peer_id: int, bytes: PackedByteArray) -> void:
	if not bytes.is_empty():
		_send_to_peer(peer_id, OneLobbyWire.RELIABLE, bytes)


## Peers whose link is open and that said hi: who the host sends game data to.
func _hello_ids() -> Array[int]:
	var out: Array[int] = []
	for r in _hello_peers():
		out.append(r.id)
	return out


func _next_chunk_id() -> int:
	_big_id = (_big_id + 1) & 0xFFFFFFFF
	return _big_id


## Lockstep drops a stalled or desynced peer: removed without a ban, so it can come back (a rejoin resyncs).
func _drop_for_lockstep(peer_id: int, reason: String) -> void:
	_c.send_signaling(OneLobbySignaling.kick(peer_id, false, 0, reason))
	if _peers.has(peer_id):
		_drop_peer(_peers[peer_id], reason, false, true) # the host closes that connection at once


# ---- teardown ------------------------------------------------------------------------------------------------------

func _end(reason: String) -> void:
	if _closed:
		return
	_close()
	session_ended.emit(reason)


func _close() -> void:
	_closed = true
	room._close()
	lockstep._stop()
	chat._detach()
	pause._detach()
	for r: OLPeerRec in _peers.values():
		if r.link != null:
			r.link.close()
		r.link = null
	for l: Array in _lingering:
		(l[0] as OneLobbyTransport.OLLink).close()
	_lingering.clear()
	_c._lobby_closed(self)


# ---- diagnostics (spec/diagnostics.md): facts from the signaling traffic and the link, the report, the host's event -----

var _diag_started_ms := 0
var _diag_seen := {"local": [], "remote": []}
var _diag_negotiated := false
var _diag_gave_up := false
var _diag_retried := false
var _diag_probe := "" ## "", "running", or the probe's answer ("ok", "refused", "unreachable", "unknown")
var _diag_at := {} # host: peer id -> when its last report was accepted
var _diag_cand_re: RegEx = null


func _diag_log(kind: String, text: String, addr := "", code := "") -> void:
	_c.get_net_log().add(kind, text, addr, code)


func _diag_start() -> void:
	_diag_started_ms = now_ms()
	_diag_log("lobby", "%s as peer %d, host is peer %d, %d in the roster" % ["hosting" if is_host else "joined", local_peer_id, _host_id, _peers.size()])


func _diag_link(rec: OLPeerRec) -> void:
	if rec.link != null:
		rec.link.on_trace = _diag_log


func _diag_retry() -> void:
	_diag_start_probe()
	_diag_retried = true
	_diag_log("retry", "direct attempt stalled: dialing the host again through the relay only")


## Counts the candidate types in a signal that crosses the host link (the facts `diagnose` takes) and logs the step.
func _diag_note_signal(dir: String, peer_id: int, sig: Dictionary) -> void:
	var lines: PackedStringArray = []
	if sig.has("sdp"):
		_diag_negotiated = true
		_diag_log("sdp", "%s %s" % [dir, str(sig.get("type", ""))])
		for l in str(sig["sdp"]).split("\n"):
			var t := l.strip_edges()
			if t.begins_with("a=candidate:"):
				lines.append(t.substr(2))
	elif sig.has("candidate"):
		lines.append(str(sig["candidate"]))
	if _diag_cand_re == null:
		_diag_cand_re = RegEx.create_from_string("^(?:a=)?candidate:\\S+ [0-9]+ \\S+ [0-9]+ (\\S+) ([0-9]+) typ (host|srflx|prflx|relay)\\b")
	for line in lines:
		var m := _diag_cand_re.search(line)
		if m == null:
			continue
		var type := "srflx" if m.get_string(3) == "prflx" else m.get_string(3)
		if peer_id == _host_id and not is_host:
			var list: Array = _diag_seen["local" if dir == "out" else "remote"]
			if not list.has(type):
				list.append(type)
		_diag_log("cand", "%s %s" % [dir, type], "%s:%s" % [m.get_string(1), m.get_string(2)])


func _diag_host_facts() -> Dictionary:
	if _peers.has(_host_id) and _peers[_host_id].link != null:
		return _peers[_host_id].link.facts()
	return {}


func _diag_reached() -> String:
	if _peers.has(_host_id) and _peers[_host_id].link != null:
		var l: OneLobbyTransport.OLLink = _peers[_host_id].link
		if l.is_open:
			return "channels"
		if bool(l.facts().get("iceConnected", false)):
			return "ice"
	return "offer" if _diag_negotiated else "joined"


func _diag_relay() -> String:
	if not has_relay(_c.ice):
		return "none"
	var seen: Array = _diag_seen["local"]
	if seen.has("relay"):
		return "ok"
	if _diag_probe == "refused" or _diag_probe == "unreachable":
		return _diag_probe
	return str(_diag_host_facts().get("relay", "pending"))


static func _diag_sorted(types: Array) -> Array:
	var out: Array = []
	for t: String in ["host", "srflx", "relay"]:
		if types.has(t):
			out.append(t)
	return out


func _diag_joiner_facts(error: String) -> Dictionary:
	var stun := false
	for s: Variant in _c.ice:
		if s is Dictionary:
			var urls: Variant = (s as Dictionary).get("urls", [])
			for u: Variant in (urls if urls is Array else [urls]):
				if str(u).to_lower().begins_with("stun:") or str(u).to_lower().begins_with("stuns:"):
					stun = true
	return {
		"side": "joiner", "route": _c.diag_route(), "error": error, "reached": _diag_reached(),
		"elapsedMs": maxi(0, now_ms() - _diag_started_ms), "versions": null, "relaysUp": null, "stun": stun,
		"relay": _diag_relay(), "local": _diag_sorted(_diag_seen["local"]), "remote": _diag_sorted(_diag_seen["remote"]),
		"retried": _diag_retried, "nat": OneLobbyDiagnose.nat_fact(_c.last_check), "heard": null,
	}


## The stall with a relay set and no relay candidate: ask the TURN server itself why (a refused login or silence), where
## the link cannot tell. A coroutine; `_diag_probe` holds "running" and then the answer.
func _diag_start_probe() -> void:
	if _diag_probe != "" or is_host or not _c.relay_probe:
		return
	var f := _diag_host_facts()
	var relay := str(f.get("relay", ""))
	if relay != "failed" and relay != "pending":
		return # links without facts (or with a relay candidate) are not probed
	var turn: Dictionary = {}
	for s: Variant in _c.ice:
		if s is Dictionary and OneLobbyLobby.has_relay([s]):
			turn = s
			break
	if turn.is_empty() or _c.get_tree() == null:
		return
	_diag_probe = "running"
	_diag_run_probe(turn)


func _diag_run_probe(turn: Dictionary) -> void:
	var r: String = await OneLobbyConnectionCheck.probe_relay(_c.get_tree(), turn)
	_diag_probe = r
	_diag_log("diag", "relay probe " + r)


## The ready timer ran out: wait for the relay probe (at most a moment) so a refused login is told from a silent relay,
## then report why.
func _give_up_connecting() -> void:
	_diag_start_probe()
	if _diag_probe == "running" and not _closed:
		var t0 := Time.get_ticks_msec()
		while _diag_probe == "running" and Time.get_ticks_msec() - t0 < 2500 and not _closed and _c.is_inside_tree():
			await _c.get_tree().process_frame
	_finish_giving_up()


func _finish_giving_up() -> void:
	if _diag_gave_up or _closed or is_ready:
		return
	_diag_gave_up = true
	var msg := ice_failed_message(has_relay(_c.ice), _c.remote_ip != "")
	var facts := _diag_joiner_facts("ice_failed")
	var d := OneLobbyDiagnose.diagnose(facts)
	_diag_log("diag", "cause %s stage %s after %d ms" % [d["cause"], d["stage"], int(facts["elapsedMs"])])
	_diag_log("error", "ice_failed", "", "ice_failed")
	if _diag_send_report(d, facts) and _c.is_inside_tree():
		# the report must be on the wire, and read by the host's hub, before the leave closes the socket
		await _c.flush_signaling(500)
		for _i in 10:
			await _c.get_tree().process_frame
	if _closed:
		return
	_c.raise_error("ice_failed", msg, {"diagnosis": d})
	if _closed:
		return
	_c.send_signaling(OneLobbySignaling.simple("leave"))
	_end("ice_failed")


## Joiner: tell the host the cause over the signaling path (hubs that list the `diag` feature only), once.
func _diag_send_report(d: Dictionary, facts: Dictionary) -> bool:
	if not _c.report_to_host or is_host or not _c.features.has("diag"):
		return false
	var nat: Dictionary = _c.last_check
	var report := {"cause": d["cause"], "stage": d["stage"], "elapsedMs": int(facts["elapsedMs"]), "relaySet": str(facts["relay"]) != "none"}
	if not nat.is_empty():
		if str(nat.get("udp", "")) == "blocked":
			report["natType"] = "blocked"
		elif str(nat.get("natType", "unknown")) != "unknown":
			report["natType"] = nat["natType"]
	report["candidateTypes"] = {"local": facts["local"], "remote": facts["remote"]}
	report["clientVersion"] = OneLobbyClient.LIB_VERSION
	var clean := OneLobbyDiagnose.clean_report(report)
	if clean.is_empty():
		return false
	_c.send_signaling(JSON.stringify({"t": "diag", "report": clean}))
	_diag_log("diag", "report sent " + str(d["cause"]))
	return true


## Host: a joiner diagnosis came through the hub (`diag{from, report}`).
func _diag_on_report(e: Dictionary) -> void:
	if not is_host:
		return
	var from := OneLobbySignaling.i(e, "from")
	if from == local_peer_id or not _peers.has(from):
		return
	var report := OneLobbyDiagnose.clean_report(e.get("report"))
	if report.is_empty():
		return
	var now := now_ms()
	if _diag_at.has(from) and now - int(_diag_at[from]) < OneLobbyDiagnose.REPORT_HOST_GAP_MS:
		return
	_diag_at[from] = now
	var x := OneLobbyDiagnose.explain_cause(report["cause"], {"stage": report["stage"], "elapsedMs": report["elapsedMs"]})
	var peer_name: String = (_peers[from] as OLPeerRec).name
	_diag_log("diag", "report from peer %d: %s at %s" % [from, x["cause"], report["stage"]])
	var info := report.duplicate(true)
	info["peer"] = _to_peer(_peers[from])
	info["name"] = peer_name
	info["message"] = x["message"]
	info["hint"] = x["hostHint"]
	info["line"] = OneLobbyDiagnose.host_line(peer_name, report["cause"], report["stage"], report["elapsedMs"])
	peer_diagnosis.emit(info)
