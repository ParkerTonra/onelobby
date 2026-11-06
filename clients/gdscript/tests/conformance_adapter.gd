extends SceneTree
## conformance/peer adapter, Godot side. conformance-adapter.mjs (next to project.godot) starts this headless with
## `-- --adapter-port=N`; it connects back over TCP and speaks the harness's JSON-lines contract
## (conformance/peer/README.md). The lobby runs for real; only its peer links and signaling are replaced: links go
## through the harness as send/recv, signaling goes nowhere.

var _tcp := StreamPeerTCP.new()
var _buf := PackedByteArray()
var _client: OneLobbyClient
var _lobby: OneLobbyLobby
var _transport: HarnessTransport
var _connected := false


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
			return {"name": "onelobby (gdscript)", "capabilities": ["host", "joiner", "raw"]}
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
		"hash_at":
			return {"hash": null}
		"state":
			return {"tick": 0, "hash": "0"}
		"stop":
			if _lobby != null:
				_lobby.leave()
				_lobby = null
			return {}
	return "unsupported op " + op


func _start(a: Dictionary) -> void:
	_transport = HarnessTransport.new()
	_transport.adapter = self
	_client = OneLobbyClient.new()
	_client.transport = _transport
	_client.display_name = str(a.get("name", "lib"))
	_client.tick_rate = int(a.get("tickRate", 50))
	root.add_child(_client)
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
	_transport.started = true
