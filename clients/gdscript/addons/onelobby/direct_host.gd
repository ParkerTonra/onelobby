class_name OneLobbyDirectHost
extends RefCounted
## What a Direct-mode host runs inside the game process: the signaling hub, the Nostr bridge that carries joiners'
## hub traffic over public relays, and the host's own in-memory hub socket. OneLobbyClient.host_direct() creates it,
## polls it every pump and closes it when the lobby ends. No server is involved.

const TICK_MS := 1000

var hub: OneLobbyHub
var nostr: OneLobbyNostrHost
## The join code to hand out (display form, "D1PB-1X9S-FPV").
var code := ""
## Result of the optional UPnP request: {mapped: bool, detail: String, external_ip: String}; empty until it finishes.
var upnp_result := {}

var _last_tick := 0
var _upnp_thread: Thread = null
var _upnp_port := 0
var _upnp_mapped := false
var _closed := false


## Starts the hub and the relay connections. `options`: max_players, password, relays (Array of wss URLs), stun (Array),
## ice_servers (Array of {urls, username?, credential?}: handed to joiners in welcome.ice).
## Null when the join code could not be made.
static func start(options: Dictionary) -> OneLobbyDirectHost:
	var d := OneLobbyDirectHost.new()
	var max_players := int(options.get("max_players", 4))
	var stun: Array = options.get("stun", OneLobbyNostrPool.DEFAULT_STUN)
	d.hub = OneLobbyHub.direct(max_players, str(options.get("password", "")), stun, options.get("ice_servers", []))
	var room := OneLobbyJoinCode.random_room()
	d.code = OneLobbyJoinCode.encode_room(room)
	var relays: Array = options.get("relays", [])
	d.nostr = OneLobbyNostrHost.start(d.hub, d.code, relays if not relays.is_empty() else OneLobbyNostrPool.DEFAULT_RELAYS, max_players)
	if d.nostr == null:
		return null
	d._last_tick = Time.get_ticks_msec()
	var port := int(options.get("upnp_port", 0))
	if port > 0:
		d._start_upnp(port)
	return d


## The host's own signaling socket: wired straight into the hub.
func connect_local() -> OneLobbyTransport.OLSocket:
	return OLLocalSocket.new(hub)


func poll() -> void:
	if _closed:
		return
	nostr.poll()
	var now := Time.get_ticks_msec()
	if now - _last_tick >= TICK_MS:
		_last_tick = now
		hub.tick()
	if _upnp_thread != null and not _upnp_thread.is_alive():
		upnp_result = _upnp_thread.wait_to_finish()
		_upnp_thread = null
		_upnp_mapped = bool(upnp_result.get("mapped", false))


## True once at least one relay is connected.
func relays_up() -> bool:
	return nostr.relays_connected() > 0


func is_closed() -> bool:
	return _closed


## Disconnects every joiner (they get a close frame saying the host left), closes the relays and removes the router mapping.
func close() -> void:
	if _closed:
		return
	_closed = true
	nostr.close()
	if _upnp_thread != null:
		upnp_result = _upnp_thread.wait_to_finish()
		_upnp_thread = null
		_upnp_mapped = bool(upnp_result.get("mapped", false))
	if _upnp_mapped:
		var u := UPNP.new()
		if u.discover(1000) == UPNP.UPNP_RESULT_SUCCESS and u.get_gateway() != null:
			u.delete_port_mapping(_upnp_port, "UDP")
		_upnp_mapped = false


# Optional router port mapping. Godot's WebRTC cannot pin the UDP port a peer connection uses, so this only helps hosts
# that run a patched or fixed-port setup; it is opt-in (upnp_port > 0) and best effort.
func _start_upnp(port: int) -> void:
	_upnp_port = port
	_upnp_thread = Thread.new()
	_upnp_thread.start(func() -> Dictionary:
		var u := UPNP.new()
		var r := u.discover(2000)
		if r != UPNP.UPNP_RESULT_SUCCESS or u.get_gateway() == null or not u.get_gateway().is_valid_gateway():
			return {"mapped": false, "detail": "no UPnP gateway (code %d)" % r, "external_ip": ""}
		var m := u.add_port_mapping(port, port, "OneLobby", "UDP", 7200)
		if m != UPNP.UPNP_RESULT_SUCCESS:
			return {"mapped": false, "detail": "router refused the mapping (code %d)" % m, "external_ip": ""}
		return {"mapped": true, "detail": "UPnP UDP %d" % port, "external_ip": u.query_external_address()})


## The host's end of the hub, as a signaling socket: always open, no network.
class OLLocalSocket:
	extends OneLobbyTransport.OLSocket
	var _hub: OneLobbyHub
	var _session: OneLobbyHub.OLSession
	var _inbox: Array[String] = []

	func _init(hub: OneLobbyHub) -> void:
		_hub = hub
		_session = hub.connect_session("local", func(text: String) -> void: _inbox.append(text), func(_code: int, _reason: String) -> void: _finish("closed by the hub"))
		if _session == null:
			state = CLOSED
			close_reason = "hub full"
		else:
			state = OPEN

	func send_text(text: String) -> void:
		if state == OPEN and _session != null:
			_hub.receive(_session, text)

	func receive() -> Array[String]:
		var out := _inbox
		_inbox = []
		return out

	func close() -> void:
		if state == CLOSED:
			return
		var s := _session
		_finish("")
		if s != null:
			_hub.disconnect_session(s)

	func _finish(reason: String) -> void:
		if state != CLOSED:
			state = CLOSED
			close_reason = reason
