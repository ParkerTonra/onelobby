class_name OneLobbyClient
extends Node
## Entry point: talks to onelobby-server and hands out OneLobbyLobby objects (raw mode). Add it to the scene tree; it
## pumps signaling and peer links every frame in _process, so signals fire on the main thread.
##
##     var lobby := await client.host({"name": "My game"})
##     if lobby == null: print(client.last_error)
##
## host / join / rejoin / list are coroutines: await them. They return null (list: []) on failure, with the reason in
## last_error ({code, message}) and the error signal. Codes: the server's (unknown_code, lobby_full, version_mismatch,
## rate_limited, ...) or local ones (timeout, server_closed, busy, in_lobby, invalid_token).

## A server error, or a local failure such as ice_failed.
signal error(code: String, message: String)
signal _op_done(result: Variant)

const REQUEST_TIMEOUT_MS := 10000
const SERVER_PING_MS := 10000
## A direct join waits for the relays (10 s), the host's answer (15 s) and the lobby reply.
const DIRECT_TIMEOUT_MS := 30000
const RETIRE_MS := 1500

## Your game's id (lobbies are per game).
@export var game_id := ""
## Players must match exactly; bump it when your messages change.
@export var net_version := "1"
## ws:// or wss:// URL of onelobby-server.
@export var lobby_server := "ws://localhost:8080"
@export var display_name := "Player"
@export var tick_rate := 30
## Force TURN relay (hides player IPs from each other; needs a TURN server).
@export var relay_only := false
## A joiner whose link to the host is not open after this long gives up with ice_failed (0 = never).
@export var ready_timeout_ms := 15000
## Peer silence before a peer counts as gone (0 = built-in: host 10 s, joiner 8 s; at least 6000).
@export var peer_timeout_ms := 0
## Pump in _process. Turn off to call pump() yourself (e.g. from _physics_process).
@export var auto_pump := true

## The lobby you are in, or null.
var lobby: OneLobbyLobby
## {code, message} of the last failure.
var last_error := {}
var transport: OneLobbyTransport = OneLobbyGodotTransport.new()
var ice: Array = []

var _socket: OneLobbyTransport.OLSocket
## Direct mode: builds the signaling socket instead of a WebSocket to lobby_server (valid while a direct lobby is open).
var _socket_factory := Callable()
## The join code (display form) of the direct lobby being hosted, joined or rejoined; "" outside Direct mode.
var _direct_code := ""
var _direct_host: OneLobbyDirectHost = null
## A direct joiner's socket after its lobby ended: kept polled until its last message (the leave) is out.
var _retiring: OneLobbyTransport.OLSocket = null
var _retire_deadline := 0
var _welcomed := false
var _hello_sent := false
var _hello_resume := ""
var _op := {} # {request, expect, sent, deadline, finish: Callable}
var _stashed_lobby := {}
var _last_ping_ms := 0
var _ping_n := 0


func _process(_delta: float) -> void:
	if auto_pump:
		pump()


func _exit_tree() -> void:
	if lobby != null:
		lobby.leave()
	if _socket != null:
		_socket.close()
		_socket = null
	if _retiring != null:
		_retiring.close()
		_retiring = null
	if _direct_host != null:
		_direct_host.close()
		_direct_host = null


## Creates a lobby. `options`: name, max_players (4), visibility ("public" | "unlisted" | "private"), late_join (true),
## meta ({} of strings), rate_limit ({messages, per_ms}: host-side cap on raw messages per peer).
func host(options: Dictionary = {}) -> OneLobbyLobby:
	var rl: Dictionary = options.get("rate_limit", {})
	var o := options.duplicate()
	o["relay_only"] = relay_only
	return await _run("", OneLobbySignaling.create(o, "raw", tick_rate), ["lobby"], func(e: Dictionary) -> Variant:
		var l := _enter_lobby(e)
		l.rate_limit = rl
		return l)


## Joins by code ("7HQ 4K2", "7hq-4k2" and look-alike letters are fine).
func join(join_code: String) -> OneLobbyLobby:
	var norm := OneLobbyJoinCode.normalize(join_code)
	if norm == "":
		_fail("unknown_code", "not a valid join code")
		return null
	return await _run("", OneLobbySignaling.join(norm), ["lobby"], _enter_lobby)


## Takes your seat back after a dropped connection (lobby.resume_token from before). If the connection to the server is
## still up (a lobby you left, or a seat you want to take over from another socket) it is closed and reopened first, so
## the server sees a fresh hello carrying the token.
func rejoin(token: String) -> OneLobbyLobby:
	return await _run(token, "", ["lobby"], _enter_lobby)


## Direct mode, host: runs the lobby inside this game with no lobby server. Joiners find you through public Nostr
## relays with a short code: `lobby.code` ("D1PB-1X9S-FPV"; show it, or copy it). The lobby, its signals and peers are
## the same as raw mode, and JS and .NET players can join it.
##
##     var lobby := await client.host_direct({"name": "My game", "max_players": 4})
##     print("Join code: ", lobby.code)
##
## `options`: name, max_players (4), password (""), late_join (true), meta, rate_limit as in host(); relays (wss URLs,
## default: seven public ones), stun (default: Google and Cloudflare), upnp_port (0 = off: asks the router to forward
## that UDP port; best effort, see the README). Fails with no_relay when no relay can be reached.
func host_direct(options: Dictionary = {}) -> OneLobbyLobby:
	if not _op.is_empty():
		_fail("busy", "another request is in flight")
		return null
	if lobby != null:
		_fail("in_lobby", "already in a lobby; leave it first")
		return null
	var d := OneLobbyDirectHost.start(options)
	if d == null:
		_fail("bad_code", "could not make a join code")
		return null
	_direct_host = d
	_direct_code = d.code
	# the relays connect while we wait; pump() polls the host meanwhile
	var deadline := transport.now_ms() + OneLobbyNostrLimits.HOST_NOSTR_FIRST_RELAY_MS
	while not d.relays_up() and transport.now_ms() < deadline and is_inside_tree():
		await get_tree().process_frame
	if not d.relays_up():
		_clear_direct()
		_fail("no_relay", "no Nostr relay reachable; check the internet connection")
		return null
	var rest := transport.now_ms() + OneLobbyNostrLimits.RELAY_REST_WAIT_MS
	while not d.nostr.relays_settled() and transport.now_ms() < rest and is_inside_tree():
		await get_tree().process_frame
	_socket_factory = d.connect_local
	var rl: Dictionary = options.get("rate_limit", {})
	var o := options.duplicate()
	o["relay_only"] = relay_only
	o["visibility"] = "unlisted"
	var result: Variant = await _run("", OneLobbySignaling.create(o, "raw", tick_rate), ["lobby"], func(e: Dictionary) -> Variant:
		var l := _enter_lobby(e)
		l.rate_limit = rl
		return l)
	if result == null:
		_clear_direct()
	return result


## Direct mode, joiner: joins the lobby a host_direct() host published. `join_code` is the code the host shows
## ("D1PB-1X9S-FPV"; case, dashes and look-alike letters do not matter). Needs no lobby server. `options`: password,
## relays (wss URLs), timeout_ms (30000).
##
##     var lobby := await client.join_direct("D1PB-1X9S-FPV")
func join_direct(join_code: String, options: Dictionary = {}) -> OneLobbyLobby:
	return await _direct_join(join_code, options, "", OneLobbySignaling.join_direct(str(options.get("password", ""))))


## Direct mode: takes your seat back after the connection dropped (lobby.resume_token and the code from before). Works
## only while the host is still running that lobby (60 s after the drop).
func rejoin_direct(join_code: String, token: String, options: Dictionary = {}) -> OneLobbyLobby:
	return await _direct_join(join_code, options, token, "")


func _direct_join(join_code: String, options: Dictionary, resume: String, request: String) -> OneLobbyLobby:
	var dec := OneLobbyJoinCode.decode_dc1(join_code)
	if dec.has("error") or not dec.has("room"):
		if dec.get("error", "") == "unknown_version" or dec.has("ip"):
			_fail("unsupported_code", "this build joins Nostr codes only (a code of the D1 family, version 1)")
		else:
			_fail("unknown_code", "not a valid join code")
		return null
	if not _op.is_empty():
		_fail("busy", "another request is in flight")
		return null
	if lobby != null:
		_fail("in_lobby", "already in a lobby; leave it first")
		return null
	var norm := OneLobbyJoinCode.normalize_dc1(join_code)
	var relays: Array = options.get("relays", [])
	_direct_code = OneLobbyJoinCode.group(norm)
	_socket_factory = func() -> OneLobbyTransport.OLSocket: return OneLobbyNostrSocket.new(norm, relays)
	var result: Variant = await _run(resume, request, ["lobby"], _enter_lobby, int(options.get("timeout_ms", DIRECT_TIMEOUT_MS)))
	if result == null:
		_clear_direct()
	return result


## Closes the connection to the lobby server (or, in Direct mode, to the host's signaling) without leaving the lobby,
## the way a dropped network would. The data channels stay up. For tests: rejoin()/rejoin_direct() afterwards.
func disconnect_signaling() -> void:
	if _socket != null:
		_socket.close()


## Waits until what was sent on the signaling socket has left the machine (at most `timeout_ms`). After leave() it
## makes sure the leave message goes out before the game quits:  lobby.leave(); await client.flush_signaling().
func flush_signaling(timeout_ms: int = 1500) -> void:
	var deadline := transport.now_ms() + timeout_ms
	while transport.now_ms() < deadline and is_inside_tree():
		var pending := 0
		if _socket != null and _socket.state == OneLobbyTransport.OLSocket.OPEN:
			pending += _socket.buffered()
		if _retiring != null and _retiring.state == OneLobbyTransport.OLSocket.OPEN:
			pending += _retiring.buffered()
		if pending == 0:
			break
		await get_tree().process_frame


## Public lobbies of this game: Dictionaries {code, name, host_name, players, max_players, phase, meta, region}.
func list(meta_filter: Dictionary = {}) -> Array:
	var r: Variant = await _run("", OneLobbySignaling.list(meta_filter), ["lobbies"], func(e: Dictionary) -> Variant:
		var items: Array = []
		var arr: Variant = e.get("items")
		if arr is Array:
			for it: Variant in arr:
				if it is Dictionary:
					items.append(OneLobbySignaling.summary_of(it))
		return items)
	return r if r is Array else []


## Polls signaling and peer links and fires signals. Called for you every frame unless auto_pump is off.
func pump() -> void:
	transport.poll()
	var now := transport.now_ms()
	if _direct_host != null:
		_direct_host.poll()
	if _retiring != null:
		_retiring.poll()
		if _retiring.state == OneLobbyTransport.OLSocket.CLOSED or _retiring.buffered() == 0 or now > _retire_deadline:
			_retiring.close()
			_retiring = null
	var sock := _socket
	if sock != null:
		sock.poll() # a no-op for WebSockets (the transport polls them); Direct-mode sockets poll themselves
		if sock.state == OneLobbyTransport.OLSocket.OPEN and not _hello_sent and (not _op.is_empty() or lobby != null):
			_hello_sent = true
			sock.send_text(OneLobbySignaling.hello(game_id, net_version, display_name, _hello_resume))
		for text in sock.receive():
			_dispatch(text)
		if sock.state == OneLobbyTransport.OLSocket.CLOSED:
			_fail_op("server_closed", sock.close_reason if sock.close_reason != "" else "closed")
			if lobby != null:
				lobby._on_socket_closed()
		elif sock.state == OneLobbyTransport.OLSocket.OPEN and _welcomed and now - _last_ping_ms >= SERVER_PING_MS:
			_last_ping_ms = now
			_ping_n += 1
			sock.send_text(OneLobbySignaling.ping(_ping_n))
	if not _op.is_empty() and now > int(_op["deadline"]):
		_fail_op("timeout", "no answer from the lobby server")
	if lobby != null:
		lobby._pump()


# ---- internals (the lobby and the conformance adapter use these) ---------------------------------------------------

func send_signaling(json: String) -> void:
	if _socket != null and _socket.state == OneLobbyTransport.OLSocket.OPEN:
		_socket.send_text(json)


func raise_error(code: String, message: String) -> void:
	last_error = {"code": code, "message": message}
	error.emit(code, message)


func _enter_lobby(e: Dictionary) -> OneLobbyLobby:
	var l := OneLobbyLobby.new(self, e)
	if _direct_code != "":
		l._direct = true
		l.code = _direct_code
	lobby = l
	l._start()
	return l


func _lobby_closed(l: OneLobbyLobby) -> void:
	if lobby == l:
		lobby = null
		if _direct_code != "":
			_clear_direct()


## Ends Direct mode: the host's hub and relays close, a joiner's socket drains what it still has to say, then closes.
func _clear_direct() -> void:
	_direct_code = ""
	_socket_factory = Callable()
	if _direct_host != null:
		_direct_host.close()
		_direct_host = null
	if _socket != null and not (_socket is OneLobbyDirectHost.OLLocalSocket):
		if _socket.state == OneLobbyTransport.OLSocket.OPEN and _socket.buffered() > 0:
			if _retiring != null:
				_retiring.close()
			_retiring = _socket
			_retire_deadline = transport.now_ms() + RETIRE_MS
		else:
			_socket.close()
	elif _socket != null:
		_socket.close()
	_socket = null
	_welcomed = false
	_hello_sent = false
	_stashed_lobby = {}


func _run(resume: String, request: String, expect: Array, finish: Callable, timeout_ms: int = REQUEST_TIMEOUT_MS) -> Variant:
	if not _op.is_empty():
		_fail("busy", "another request is in flight")
		return null
	if lobby != null and expect[0] == "lobby":
		_fail("in_lobby", "already in a lobby; leave it first")
		return null
	_op = {"request": request, "expect": expect, "sent": false, "deadline": transport.now_ms() + timeout_ms, "finish": finish}
	# A resume needs a fresh hello: if this connection already said hello, drop it and start a new one.
	if _socket != null and resume != "" and _welcomed:
		_socket.close()
	if _socket == null or _socket.state == OneLobbyTransport.OLSocket.CLOSED:
		_socket = _socket_factory.call() if _socket_factory.is_valid() else transport.connect_signaling(lobby_server)
		_welcomed = false
		_hello_sent = false
	_hello_resume = resume
	if _welcomed:
		_send_op()
	var result: Variant = await _op_done
	return result


func _send_op() -> void:
	_op["sent"] = true
	if _op["request"] != "":
		_socket.send_text(_op["request"])
	elif not _stashed_lobby.is_empty():
		var s := _stashed_lobby
		_stashed_lobby = {}
		_finish_op(s)


func _finish_op(e: Dictionary) -> void:
	var finish: Callable = _op["finish"]
	_op = {}
	# deferred: the awaiting coroutine resumes after this pump, with its signal handlers free to connect first
	_emit_done.call_deferred(finish.call(e))


func _fail_op(code: String, message: String) -> void:
	if _op.is_empty():
		return
	_op = {}
	_fail(code, message)
	_emit_done.call_deferred(null)


func _fail(code: String, message: String) -> void:
	last_error = {"code": code, "message": message}
	error.emit(code, message)


func _emit_done(result: Variant) -> void:
	_op_done.emit(result)


func _dispatch(text: String) -> void:
	var e: Variant = JSON.parse_string(text)
	if not e is Dictionary:
		return
	var t := OneLobbySignaling.s(e, "t")
	match t:
		"welcome":
			ice = OneLobbySignaling.ice_of(e)
			_welcomed = true
			# a resume answered without a seat: the token is unknown or expired
			if not _op.is_empty() and not _op["sent"] and _op["request"] == "" and _hello_resume != "" and not e.has("peerId"):
				_hello_resume = ""
				_fail_op("invalid_token", "resume token unknown or expired")
				return
			if not _op.is_empty() and not _op["sent"]:
				_send_op()
			return
		"ping":
			send_signaling(OneLobbySignaling.pong(OneLobbySignaling.i(e, "n")))
			return
		"pong":
			return
		"error":
			var code := OneLobbySignaling.s(e, "code")
			var msg := OneLobbySignaling.s(e, "msg")
			var data: Variant = e.get("data")
			var disconnected: bool = data is Dictionary and data.get("ban") is bool and data["ban"] == false
			if not _op.is_empty():
				_fail_op(code, msg)
			else:
				raise_error(code, msg)
			if lobby != null:
				lobby._on_server_error(code, disconnected)
			return
	if not _op.is_empty() and _op["sent"] and (_op["expect"] as Array).has(t):
		_finish_op(e)
		return
	if t == "lobby" and lobby == null:
		_stashed_lobby = e # a resume reply that beat the request
		return
	if lobby != null:
		lobby._on_signaling(t, e)
