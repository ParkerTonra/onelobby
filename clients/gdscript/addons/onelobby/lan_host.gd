class_name OneLobbyLanHost
extends RefCounted
## The host's answering socket (spec/lan-discovery.md): one UDP socket on a fixed port, only while a direct lobby is open and
## `hosting.lan` is on. start() returns false (and logs one line) when it cannot open, and hosting goes on without it.
## The owner calls poll() every frame (OneLobbyDirectHost does).

var answerer: OneLobbyLanAnswerer
var port := 0
var listening := false

var _game_id := ""
var _net_version := ""
var _port := OneLobbyLan.DEFAULT_PORT
var _bind := "0.0.0.0"
var _log: Callable
var _udp: PacketPeerUDP = null


## `info`: Callable returning {} (no lobby yet) or {lobby_name, host_name, players, max_players, password, port}.
## `options`: port (47840), bind_address ("127.0.0.1" binds the loopback only; anything else every interface), log (Callable(line)), now_fn.
func _init(game_id: String, net_version: String, info: Callable, options: Dictionary = {}) -> void:
	_game_id = game_id
	_net_version = net_version
	_port = int(options.get("port", OneLobbyLan.DEFAULT_PORT))
	_bind = "127.0.0.1" if str(options.get("bind_address", "*")) == "127.0.0.1" else "0.0.0.0"
	_log = options.get("log", Callable())
	answerer = OneLobbyLanAnswerer.new(game_id, net_version, info, _send, options.get("now_fn", Callable()))


func start() -> bool:
	var bad := ""
	if not OneLobbyLan.fits(_game_id, OneLobbyLan.LIMIT_GAME_ID):
		bad = "game id is not 1 to 64 bytes"
	elif not OneLobbyLan.fits(_net_version, OneLobbyLan.LIMIT_NET_VERSION):
		bad = "net version is not 1 to 32 bytes"
	if bad != "":
		_say("LAN discovery is off for this lobby: " + bad)
		return false
	var udp := PacketPeerUDP.new()
	var err := udp.bind(_port, _bind)
	if err != OK:
		udp.close()
		_say("LAN discovery is off for this lobby: UDP port %d %s" % [_port, "is taken" if err == ERR_ALREADY_IN_USE or err == ERR_UNAVAILABLE else "could not be opened (%s)" % error_string(err)])
		return false
	_udp = udp
	port = udp.get_local_port()
	listening = true
	_say("LAN discovery: answering questions for this lobby on UDP %d" % port)
	return true


func poll() -> void:
	if _udp == null:
		return
	while _udp != null and _udp.get_available_packet_count() > 0:
		var pkt := _udp.get_packet()
		if _udp.get_packet_error() != OK:
			continue
		answerer.handle(pkt, _udp.get_packet_ip(), _udp.get_packet_port())


func close() -> void:
	if _udp != null:
		_udp.close()
		_udp = null
	listening = false


func _send(bytes: PackedByteArray, address: String, to_port: int) -> void:
	if _udp == null:
		return
	_udp.set_dest_address(address, to_port)
	_udp.put_packet(bytes)


func _say(line: String) -> void:
	if _log.is_valid():
		_log.call(line)
