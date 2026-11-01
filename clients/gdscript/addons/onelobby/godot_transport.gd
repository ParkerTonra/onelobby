class_name OneLobbyGodotTransport
extends OneLobbyTransport
## Godot's own networking: WebSocketPeer for signaling, WebRTCPeerConnection for peers. Desktop exports need the
## webrtc-native GDExtension (addons/godot_webrtc, see the README); web exports have WebRTC built in.

const DEFAULT_STUN := "stun:stun.l.google.com:19302"
const LABELS := ["reliable", "fast", "voice"]

var _sockets: Array[WsSocket] = []
var _links: Array[RtcLink] = []


func connect_signaling(url: String) -> OneLobbyTransport.Socket:
	var s := WsSocket.new(url)
	_sockets.append(s)
	return s


func create_link(opts: Dictionary) -> OneLobbyTransport.Link:
	var l := RtcLink.new(opts)
	_links.append(l)
	return l


func poll() -> void:
	for s in _sockets:
		s.poll()
	_sockets = _sockets.filter(func(s: WsSocket) -> bool: return s.state != OneLobbyTransport.Socket.CLOSED)
	for l in _links:
		l.poll()
	_links = _links.filter(func(l: RtcLink) -> bool: return not l.closed)


class WsSocket:
	extends OneLobbyTransport.Socket
	var _ws := WebSocketPeer.new()
	var _inbox: Array[String] = []
	var _ever_open := false

	func _init(url: String) -> void:
		_ws.inbound_buffer_size = 1 << 20
		var err := _ws.connect_to_url(url)
		if err != OK:
			state = CLOSED
			close_reason = "connect failed: %s" % error_string(err)

	func poll() -> void:
		if state == CLOSED:
			return
		_ws.poll()
		match _ws.get_ready_state():
			WebSocketPeer.STATE_OPEN:
				state = OPEN
				_ever_open = true
				while _ws.get_available_packet_count() > 0:
					var pkt := _ws.get_packet()
					if _ws.was_string_packet():
						_inbox.append(pkt.get_string_from_utf8())
			WebSocketPeer.STATE_CLOSED:
				state = CLOSED
				close_reason = ("closed %d %s" % [_ws.get_close_code(), _ws.get_close_reason()]) if _ever_open else "could not connect"

	func send_text(text: String) -> void:
		if state == OPEN:
			_ws.send_text(text)

	func receive() -> Array[String]:
		var out := _inbox
		_inbox = []
		return out

	func buffered() -> int:
		return _ws.get_current_outbound_buffered_amount() if state == OPEN else 0

	func close() -> void:
		if state != CLOSED:
			_ws.close()
		state = CLOSED


class RtcLink:
	extends OneLobbyTransport.Link
	var closed := false
	var _pc := WebRTCPeerConnection.new()
	var _ch: Array[WebRTCDataChannel] = []
	var _out: Array[Dictionary] = []
	var _initiator := false
	var _was_connected := false

	func _init(opts: Dictionary) -> void:
		_initiator = bool(opts.get("initiator", false))
		# Godot does not expose the selected candidate pair, so a link counts as relayed only when the lobby is
		# relay-only (the server's path telemetry then counts it as relayed).
		relayed = bool(opts.get("relay_only", false))
		var ice: Array = opts.get("ice_servers", [])
		if ice.is_empty():
			ice = [{"urls": [DEFAULT_STUN]}]
		var config := {"iceServers": ice}
		if relayed:
			config["iceTransportPolicy"] = "relay"
		if _pc.initialize(config) != OK:
			is_failed = true
			return
		_pc.session_description_created.connect(_on_description)
		_pc.ice_candidate_created.connect(_on_candidate)
		for id in 3:
			var o := {"negotiated": true, "id": id, "ordered": id == OneLobbyWire.RELIABLE}
			if id != OneLobbyWire.RELIABLE:
				o["maxRetransmits"] = 0
			var ch := _pc.create_data_channel(LABELS[id], o)
			if ch == null:
				is_failed = true
				return
			ch.write_mode = WebRTCDataChannel.WRITE_MODE_BINARY
			_ch.append(ch)

	func _on_description(type: String, sdp: String) -> void:
		_pc.set_local_description(type, sdp)
		_out.append({"type": type, "sdp": sdp})

	func _on_candidate(media: String, index: int, name: String) -> void:
		_out.append({"candidate": name, "sdpMid": media, "sdpMLineIndex": index})

	func start_offer() -> void:
		if _initiator and not is_failed:
			_pc.create_offer()

	func apply_signal(sig: Dictionary) -> void:
		if closed or is_failed:
			return
		if sig.has("sdp"):
			_pc.set_remote_description(str(sig["type"]), str(sig["sdp"]))
		elif str(sig.get("candidate", "")) != "":
			_pc.add_ice_candidate(str(sig.get("sdpMid", "0")), int(sig.get("sdpMLineIndex", 0)), str(sig["candidate"]))

	func take_signals() -> Array[Dictionary]:
		var out := _out
		_out = []
		return out

	func poll() -> void:
		if closed or is_failed:
			return
		_pc.poll()
		var st := _pc.get_connection_state()
		if st == WebRTCPeerConnection.STATE_CONNECTED:
			_was_connected = true
		if st == WebRTCPeerConnection.STATE_FAILED or st == WebRTCPeerConnection.STATE_CLOSED \
				or (_was_connected and st == WebRTCPeerConnection.STATE_DISCONNECTED):
			is_failed = true
			is_open = false
			return
		var all_open := true
		for ch in _ch:
			if ch.get_ready_state() != WebRTCDataChannel.STATE_OPEN:
				all_open = false
		is_open = all_open

	func send(channel: int, bytes: PackedByteArray) -> void:
		if is_open and channel >= 0 and channel < _ch.size():
			_ch[channel].put_packet(bytes)

	func receive() -> Array:
		var out: Array = []
		if closed:
			return out
		for id in _ch.size():
			var ch := _ch[id]
			while ch.get_available_packet_count() > 0:
				out.append([id, ch.get_packet()])
		return out

	func buffered() -> int:
		return 0 if closed or is_failed or _ch.is_empty() else _ch[0].get_buffered_amount()

	func close() -> void:
		if closed:
			return
		closed = true
		is_open = false
		for ch in _ch:
			ch.close()
		_pc.close()
