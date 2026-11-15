class_name OneLobbyGodotTransport
extends OneLobbyTransport
## Godot's own networking: WebSocketPeer for signaling, WebRTCPeerConnection for peers. Desktop exports need the
## webrtc-native GDExtension (addons/godot_webrtc, see the README); web exports have WebRTC built in.

const DEFAULT_STUN := "stun:stun.l.google.com:19302"
const LABELS := ["reliable", "fast", "voice"]

var _sockets: Array[OLWsSocket] = []
var _links: Array[OLRtcLink] = []


func connect_signaling(url: String) -> OneLobbyTransport.OLSocket:
	var s := OLWsSocket.new(url)
	_sockets.append(s)
	return s


func create_link(opts: Dictionary) -> OneLobbyTransport.OLLink:
	var l := OLRtcLink.new(opts, _range_links(opts))
	_links.append(l)
	return l


## Links that hold one UDP port of the host's fixed range (each peer connection binds one), not yet closed.
func _range_links(opts: Dictionary) -> int:
	if opts.get("port_range", []).size() != 2:
		return 0
	var n := 0
	for l in _links:
		if l.in_range and not l.closed:
			n += 1
	return n


func poll() -> void:
	for s in _sockets:
		s.poll()
	_sockets = _sockets.filter(func(s: OLWsSocket) -> bool: return s.state != OneLobbyTransport.OLSocket.CLOSED)
	for l in _links:
		l.poll()
	_links = _links.filter(func(l: OLRtcLink) -> bool: return not l.closed)


class OLWsSocket:
	extends OneLobbyTransport.OLSocket
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


class OLRtcLink:
	extends OneLobbyTransport.OLLink
	var closed := false
	var _pc := WebRTCPeerConnection.new()
	var _ch: Array[WebRTCDataChannel] = []
	var _out: Array[Dictionary] = []
	var _initiator := false
	var _was_connected := false
	## True when this link bound a port of the fixed UDP range.
	var in_range := false
	## "port_range_full" when the fixed UDP range has no free port left for this link; "" otherwise.
	var fail_reason := ""
	## The host's address from a v0 IP code: its host candidates are also tried at this address (same UDP port).
	var _remote_ip := ""
	var _seen_remote := {}

	func _init(opts: Dictionary, range_in_use := 0) -> void:
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
		_remote_ip = str(opts.get("remote_ip", ""))
		var range: Array = opts.get("port_range", [])
		if range.size() == 2:
			var size := int(range[1]) - int(range[0]) + 1
			if range_in_use >= size:
				fail_reason = "port_range_full"
				is_failed = true
				return
			# webrtc-native reads libdatachannel's own settings from a nested "libdatachannel" dictionary; a top-level
			# portRangeBegin/End is silently ignored (checked against the 1.2.2 binary, see the README)
			config["libdatachannel"] = {"portRangeBegin": int(range[0]), "portRangeEnd": int(range[1])}
			in_range = true
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
		_out.append({"type": type, "sdp": _relay_sdp(sdp) if relayed else sdp})

	func _on_candidate(media: String, index: int, name: String) -> void:
		if relayed and not _is_relay(name):
			return
		_out.append({"candidate": name, "sdpMid": media, "sdpMLineIndex": index})

	# webrtc-native ignores iceTransportPolicy, so relay-only is enforced here: only relay candidates are sent or taken,
	# and with the TURN servers' permissions that leaves relay-to-relay as the one path that connects.
	static func _is_relay(candidate: String) -> bool:
		return candidate.contains(" typ relay")

	static func _relay_sdp(sdp: String) -> String:
		var keep: PackedStringArray = []
		for line in sdp.split("
"):
			if line.begins_with("a=candidate:") and not _is_relay(line):
				continue
			keep.append(line)
		return "
".join(keep)

	func start_offer() -> void:
		if _initiator and not is_failed:
			if _pc.create_offer() != OK:
				is_failed = true
				if in_range:
					fail_reason = "port_range_full"

	func apply_signal(sig: Dictionary) -> void:
		if closed or is_failed:
			return
		if sig.has("sdp"):
			var sdp := str(sig["sdp"])
			_pc.set_remote_description(str(sig["type"]), _relay_sdp(sdp) if relayed else sdp)
			if _remote_ip != "":
				for line in sdp.split("
"):
					_add_at_remote_ip(line.strip_edges().trim_prefix("a="))
		elif str(sig.get("candidate", "")) != "":
			if relayed and not _is_relay(str(sig["candidate"])):
				return
			_pc.add_ice_candidate(str(sig.get("sdpMid", "0")), int(sig.get("sdpMLineIndex", 0)), str(sig["candidate"]))
			if _remote_ip != "":
				_add_at_remote_ip(str(sig["candidate"]))

	# Join by IP (docs/design/direct-ip.md s.2): the host only knows its own (LAN) addresses, but a forwarded port keeps its
	# number, so each host candidate "ADDR PORT" is also tried as "<code's address> PORT".
	func _add_at_remote_ip(candidate: String) -> void:
		if not candidate.begins_with("candidate:") or not candidate.contains(" typ host") or not candidate.contains(" UDP "):
			return
		var f := candidate.split(" ")
		if f.size() < 8:
			return
		var port := f[5]
		if _seen_remote.has(port):
			return
		_seen_remote[port] = true
		_pc.add_ice_candidate("0", 0, "candidate:1 1 UDP 2122317823 %s %s typ host" % [_remote_ip, port])

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
		# is_open is as of the last poll; a peer that left since then has closed the channel underneath it.
		if not is_open or channel < 0 or channel >= _ch.size():
			return
		if _ch[channel].get_ready_state() != WebRTCDataChannel.STATE_OPEN:
			is_open = false  # the far side is gone: say so now, not at the next poll
			return
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
