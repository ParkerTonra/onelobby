class_name OneLobbyIpListener
extends RefCounted
## The host's TCP port for joiners that come by IP (a v0 join code or a typed address): a WebSocket server whose every
## connection becomes one hub session, as the Nostr host does for a joiner's pubkey. Same protocol as the JS and C#
## direct hosts (`ws://host:port/`). The owner calls poll() every frame.

const HANDSHAKE_MS := 5000
const MAX_PENDING := 16
const MAX_MESSAGE := 1 << 20

class OLConn:
	var ws: WebSocketPeer
	var session: OneLobbyHub.OLSession = null
	var since := 0
	var opened := false

var _hub: OneLobbyHub
var _server := TCPServer.new()
var _conns: Array[OLConn] = []
var port := 0
var _closed := false


## Listens on `bind_address` ("*" = every interface, "127.0.0.1" = this machine only). `port` 0 picks a free one (tests).
## Null when the port cannot be taken (the reason is in `last_error`).
static var last_error := ""

static func start(hub: OneLobbyHub, listen_port: int, bind_address: String) -> OneLobbyIpListener:
	var l := OneLobbyIpListener.new()
	l._hub = hub
	var err := l._server.listen(listen_port, bind_address)
	if err != OK:
		last_error = "port %d: %s" % [listen_port, error_string(err)]
		return null
	l.port = l._server.get_local_port()
	return l


func poll() -> void:
	if _closed:
		return
	while _server.is_connection_available() and _conns.size() < MAX_PENDING + _hub_cap():
		var tcp := _server.take_connection()
		var c := OLConn.new()
		c.ws = WebSocketPeer.new()
		c.ws.inbound_buffer_size = MAX_MESSAGE
		c.ws.accept_stream(tcp)
		c.since = Time.get_ticks_msec()
		_conns.append(c)
	for c in _conns.duplicate():
		_poll_conn(c)


func _hub_cap() -> int:
	return _hub.max_peers


func close() -> void:
	if _closed:
		return
	_closed = true
	_server.stop()
	for c in _conns.duplicate():
		_drop(c, 1001, "host left")


func _poll_conn(c: OLConn) -> void:
	c.ws.poll()
	match c.ws.get_ready_state():
		WebSocketPeer.STATE_OPEN:
			if not c.opened:
				c.opened = true
				var ws := c.ws
				c.session = _hub.connect_session(
					"ip:%d" % c.since,
					func(text: String) -> void:
						if ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
							ws.send_text(text),
					func(code: int, reason: String) -> void:
						ws.close(code if code >= 1000 else 1000, reason))
				if c.session == null:
					_drop(c, 1013, "full")
					return
			while c.ws.get_available_packet_count() > 0:
				var pkt := c.ws.get_packet()
				if c.ws.was_string_packet() and c.session != null:
					_hub.receive(c.session, pkt.get_string_from_utf8())
		WebSocketPeer.STATE_CLOSED:
			_drop(c, 0, "")
		_:
			if not c.opened and Time.get_ticks_msec() - c.since > HANDSHAKE_MS:
				_drop(c, 1002, "handshake timeout")


func _drop(c: OLConn, code: int, reason: String) -> void:
	_conns.erase(c)
	if c.session != null:
		_hub.disconnect_session(c.session)
		c.session = null
	if code != 0 and c.ws.get_ready_state() != WebSocketPeer.STATE_CLOSED:
		c.ws.close(code, reason)
