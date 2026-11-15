extends SceneTree
## conformance/peer adapter, Godot side. conformance-adapter.mjs (next to project.godot) starts this headless with
## `-- --adapter-port=N`; it connects back over TCP and speaks the harness's JSON-lines contract
## (conformance/peer/README.md). The lobby runs for real; only its peer links and signaling are replaced: links go
## through the harness as send/recv, signaling goes nowhere. The game is gridpaint (tests/gridpaint.gd) on lobby.lockstep.

const Gridpaint := preload("res://tests/gridpaint.gd")

var _tcp := StreamPeerTCP.new()
var _buf := PackedByteArray()
var _client: OneLobbyClient
var _lobby: OneLobbyLobby
var _transport: HarnessTransport
var _connected := false
var _game: Gridpaint
var _hashes := {} # tick -> hash


class HarnessTransport:
	extends OneLobbyTransport
	var adapter: Object
	var links := {} # remote id -> HarnessLink
	var started := false # links created after start are migration dials

	func connect_signaling(_url: String) -> OneLobbyTransport.OLSocket:
		return OneLobbyTransport.OLSocket.new()

	func create_link(opts: Dictionary) -> OneLobbyTransport.OLLink:
		var l := HarnessLink.new()
		l.remote_id = int(opts["remote_id"])
		l.adapter = adapter
		l.transport = self
		links[l.remote_id] = l
		if started:
			adapter.call("emit_event", {"ev": "dial", "peerId": l.remote_id})
		return l


class HarnessLink:
	extends OneLobbyTransport.OLLink
	var remote_id := 0
	var adapter: Object
	var transport: HarnessTransport
	var inbox: Array = []
	var closed := false

	func send(channel: int, bytes: PackedByteArray) -> void:
		if is_open:
			adapter.call("emit_event", {"ev": "send", "to": remote_id, "channel": ["reliable", "fast", "voice"][channel], "hex": bytes.hex_encode()})

	func receive() -> Array:
		var out := inbox
		inbox = []
		return out

	func close() -> void:
		if closed:
			return
		closed = true
		var was := is_open
		is_open = false
		if transport.links.get(remote_id) == self:
			transport.links.erase(remote_id)
		if was:
			adapter.call("emit_event", {"ev": "close", "peerId": remote_id})


func _init() -> void:
	Engine.max_fps = 500
	var port := 0
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--adapter-port="):
			port = a.get_slice("=", 1).to_int()
	if port == 0 or _tcp.connect_to_host("127.0.0.1", port) != OK:
		printerr("conformance_adapter: no --adapter-port")
		quit(2)
		return
	process_frame.connect(_tick)


func _tick() -> void:
	_tcp.poll()
	var st := _tcp.get_status()
	if st == StreamPeerTCP.STATUS_CONNECTED:
		_connected = true
	elif st != StreamPeerTCP.STATUS_CONNECTING:
		quit(0 if _connected else 3)
		return
	if not _connected:
		return
	var n := _tcp.get_available_bytes()
	if n > 0:
		var r: Array = _tcp.get_data(n)
		_buf.append_array(r[1])
	_pump_game()
	while true:
		var nl := _buf.find(10)
		if nl < 0:
			break
		var line := _buf.slice(0, nl).get_string_from_utf8()
		_buf = _buf.slice(nl + 1)
		if line.strip_edges() != "":
			_handle(line)


func emit_event(e: Dictionary) -> void:
	_tcp.put_data((JSON.stringify(e) + "\n").to_utf8_buffer())


func _handle(line: String) -> void:
	var m: Variant = JSON.parse_string(line)
	if not m is Dictionary:
		return
	var id: Variant = m.get("id")
	var res: Variant = _op(str(m.get("op", "")), m)
	if res is String:
		emit_event({"id": id, "ok": false, "error": res})
	else:
		emit_event({"id": id, "ok": true, "result": res})


func _op(op: String, a: Dictionary) -> Variant:
	match op:
		"init":
			return {"name": "onelobby (gdscript)", "capabilities": ["host", "joiner", "lockstep", "raw", "chat", "pause", "migration", "deflate"]}
		"start":
			_start(a)
			return {}
		"link_open":
			var pid := int(a["peerId"])
			var l: HarnessLink = _transport.links.get(pid)
			if l == null:
				# a peer that dialled us (migration): the answering side
				if not _lobby._peers.has(pid):
					_lobby._peers[pid] = OneLobbyLobby._rec(pid, "p%d" % pid)
				_lobby._connect_peer(_lobby._peers[pid], false)
				l = _transport.links[pid]
			l.is_open = true
			_client.pump()
			return {}
		"link_close":
			var l: HarnessLink = _transport.links.get(int(a["peerId"]))
			if l != null:
				l.closed = true
				l.is_open = false
				l.is_failed = true
				_transport.links.erase(l.remote_id)
				_client.pump()
			return {}
		"recv":
			var l: HarnessLink = _transport.links.get(int(a["from"]))
			if l != null and l.is_open:
				l.inbox.append([["reliable", "fast", "voice"].find(str(a["channel"])), (a["hex"] as String).hex_decode()])
				_client.pump()
			return {}
		"begin":
			_lobby.start()
			return {}
		"raw_send":
			var ch := OneLobbyWire.FAST if str(a.get("channel", "reliable")) == "fast" else OneLobbyWire.RELIABLE
			var bytes := (a["hex"] as String).hex_decode()
			if int(a["to"]) == 0:
				_lobby.broadcast(bytes, ch)
			else:
				_lobby.send(int(a["to"]), bytes, ch)
			_client.pump()
			return {}
		"command":
			_lobby.lockstep.submit(Gridpaint.paint_cmd(int(a["x"]), int(a["y"])))
			return {}
		"chat_send":
			_lobby.chat.send(str(a["text"]))
			return {}
		"chat_host_mute":
			_lobby.chat.host_mute(int(a["peerId"]), bool(a["muted"]))
			return {}
		"pause_request":
			_lobby.pause.request(bool(a["paused"]))
			return {}
		"pause_clear":
			_lobby.pause.clear()
			return {}
		"pause_policy":
			var deny: Array[int] = []
			for p: Variant in a.get("denyPeers", []):
				deny.append(int(p))
			_lobby.pause.policy = func(peer: int, _want: bool) -> bool: return not deny.has(peer)
			return {}
		"hash_at":
			_pump_game()
			if _hashes.has(int(a["tick"])):
				return {"hash": OneLobbyWire.u64_to_string(_hashes[int(a["tick"])])}
			return {"hash": OneLobbyWire.u64_to_string(Gridpaint.new("000000").hash_grid()) if int(a["tick"]) == 0 else null}
		"state":
			_pump_game()
			return {"tick": _game.tick, "hash": OneLobbyWire.u64_to_string(_game.hash_grid())}
		"stop":
			if _lobby != null:
				_lobby.leave()
				_lobby = null
			_game = null
			return {}
	return "unsupported op " + op


func _start(a: Dictionary) -> void:
	_transport = HarnessTransport.new()
	_transport.adapter = self
	_client = OneLobbyClient.new()
	_client.transport = _transport
	_client.display_name = str(a.get("name", "lib"))
	_client.tick_rate = int(a.get("tickRate", 50))
	_client.hash_every_ticks = int(a.get("hashEvery", 0))
	root.add_child(_client)
	_game = Gridpaint.new(str(a.get("code", "000000")))
	_hashes = {}
	var me := int(a["peerId"])
	var peers: Array = []
	for p: Variant in a.get("peers", []):
		peers.append({"peerId": int(p), "name": str(a.get("name", "lib")) if int(p) == me else "p%d" % int(p)})
	if not peers.any(func(p: Dictionary) -> bool: return p["peerId"] == me):
		peers.append({"peerId": me, "name": str(a.get("name", "lib"))})
	_lobby = _client._enter_lobby({
		"t": "lobby", "code": str(a.get("code", "000000")), "gameId": "gridpaint", "netVersion": "1",
		"hostId": int(a["hostId"]), "you": me, "mode": str(a.get("mode", "raw")), "tickRate": int(a.get("tickRate", 50)),
		"lateJoin": true, "phase": "lobby", "meta": {}, "peers": peers, "resumeToken": "t",
	})
	_lobby.host_changed.connect(func(host_id: int) -> void:
		emit_event({"ev": "host_changed", "hostId": host_id, "epoch": _lobby._epoch}))
	_lobby.message_received.connect(func(from: int, bytes: PackedByteArray, channel: int) -> void:
		emit_event({"ev": "raw", "from": from, "channel": ["reliable", "fast", "voice"][channel], "hex": bytes.hex_encode()}))
	_lobby.peer_left.connect(func(p: Dictionary, reason: String) -> void:
		if reason == "desync":
			emit_event({"ev": "peer_dropped", "peerId": p["peer_id"], "reason": reason}))
	_lobby.chat.message.connect(func(l: Dictionary) -> void:
		emit_event({"ev": "chat", "peerId": l["peer_id"], "id": l["id"], "ts": l["ts"], "text": l["text"]}))
	_lobby.chat.history_received.connect(func(lines: Array) -> void:
		var out: Array = []
		for l: Dictionary in lines:
			out.append({"peerId": l["peer_id"], "id": l["id"], "ts": l["ts"], "text": l["text"]})
		emit_event({"ev": "chat_history", "lines": out}))
	_lobby.chat.rejected.connect(func(id: int, reason: String) -> void:
		emit_event({"ev": "chat_rejected", "id": id, "reason": {"rate": 1, "length": 2, "muted_by_host": 3}.get(reason, 0)}))
	_lobby.pause.changed.connect(func(s: Dictionary) -> void:
		emit_event({"ev": "pause", "paused": s["paused"], "byPeer": s["by_peer"], "pauserLeft": s["pauser_left"]}))
	_lobby.pause.refused.connect(func(code: String) -> void:
		emit_event({"ev": "pause_refused", "reason": code}))
	if _lobby.mode == "lockstep":
		var ls := _lobby.lockstep
		ls.snapshot = func() -> PackedByteArray: return _game.snapshot()
		ls.restore = func(tick: int, bytes: PackedByteArray) -> void:
			_game.restore(tick, bytes)
			_hashes.clear()
			_hashes[tick] = _game.hash_grid()
		ls.restored.connect(func(tick: int) -> void: emit_event({"ev": "snapshot_restored", "tick": tick}))
		ls.desync.connect(func(tick: int, host_hash: int, your_hash: int) -> void:
			emit_event({"ev": "desync", "tick": tick, "hostHash": OneLobbyWire.u64_to_string(host_hash), "yourHash": OneLobbyWire.u64_to_string(your_hash)}))
		if int(a.get("chunkSize", 0)) > 0:
			ls.chunk_size = int(a["chunkSize"])
	_transport.started = true


## Applies the frames the lobby has queued to the game and reports their hashes.
func _pump_game() -> void:
	if _lobby == null or _game == null or _lobby.mode != "lockstep":
		return
	while true:
		var f := _lobby.lockstep.next_frame()
		if f.is_empty():
			break
		var h := _game.step(int(f["tick"]), f["commands"])
		_hashes[int(f["tick"])] = h
		if _hashes.size() > 1200:
			_hashes.erase(int(f["tick"]) - 1000)
		_lobby.lockstep.report_hash(int(f["tick"]), h)
