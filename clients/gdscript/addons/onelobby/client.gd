class_name OneLobbyClient
extends Node
## Entry point: talks to onelobby-server and hands out OneLobbyLobby objects (raw or lockstep mode). Add it to the scene tree; it
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
## A plain sentence for the player: a saved relay line was skipped because it is not valid. Fires once, never holds the line.
signal warning(message: String)
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
## "raw" (you send bytes) or "lockstep" (the host orders commands per tick: `lobby.lockstep`). Used when you host; a joiner
## takes the host's mode. Chat and pause work in both.
@export_enum("raw", "lockstep") var sync_mode := "raw"
## Lockstep: send a state hash every this many ticks (0 = tick_rate, once a second).
@export var hash_every_ticks := 0
## Force TURN relay (hides player IPs from each other; needs a TURN server).
@export var relay_only := false
## A joiner whose link to the host is not open after this long gives up with ice_failed (0 = never).
@export var ready_timeout_ms := 15000
## Peer silence before a peer counts as gone (0 = built-in: host 10 s, joiner 8 s; at least 6000).
@export var peer_timeout_ms := 0
## Pump in _process. Turn off to call pump() yourself (e.g. from _physics_process).
@export var auto_pump := true
## A joiner that gives up tells the host why (cause and step only: no address, name or free text) over the signaling path
## it already uses, once, when the hub lists the "diag" feature (spec/diagnostics.md s.7).
@export var report_to_host := true
## Where the connection log (`net_log`) is saved: when the scene tree exits, after every error entry and on net_log.save(). The default is one file per game name,
## so two copies of a game on one PC (and `verify`) overwrite each other: start each copy with `-- --netlog=<file>` (or `ONELOBBY_NETLOG=<file>`) and its log goes to that
## file, line by line, so a killed copy still has it.
## "" keeps it in memory only. GDScript cannot hook a crash, so a crash loses only what came after the last error entry.
@export_file var log_path := "user://onelobby-netlog.txt"
## Net log ring size: 500 by default, clamped to 50..5000.
@export var log_size := 500
## After a failed connect with a relay set, ask the TURN server with a raw UDP probe whether it refused the login or never
## answered (spec/diagnostics.md s.10).
@export var relay_probe := true

## The library version the report carries.
const LIB_VERSION := "0.8.0"
## The last check_connection() result ({udp, natType, relay, verdict, message}); {} before the first one. Its NAT reading
## joins a later failure's diagnosis and the report to the host.
var last_check := {}
var _net_log: OneLobbyNetLog = null
## How this client reaches lobbies: "server" (code), "ip" (typed address) or "nostr".
var _route := "server"

## The lobby you are in, or null.
var lobby: OneLobbyLobby
## {code, message} of the last failure.
var last_error := {}
var transport: OneLobbyTransport = OneLobbyGodotTransport.new()
var ice: Array = []
# a Direct joiner's own ice_servers, added to the ones the host's welcome offers
var _extra_ice: Array = []
## Optional messages the hub handles (`welcome.features`, e.g. "set_name"); empty for an older hub.
var features: Array = []
## The onelobby.json this client runs from (`from_config`), or null. With one, host / host_direct / join / join_direct / list
## take their defaults from the file (explicit options win) and enforce its switches.
var config: OneLobbyConfig = null
## {code, path, rule, message} when `config` cannot be used (an invalid file, a name the file refuses, a sync mode GDScript
## lacks); host / join / list then fail with that code and message. {} otherwise.
var config_error := {}
## Where the per-install player id and the host's ban list are kept. Default: the file user://onelobby.json. Set another
## OneLobbyStore (OneLobbyStore.memory(), or your own subclass) before host() / join().
var store: OneLobbyStore = null

var _pid := ""
## Which saved settings are applied as defaults (spec/settings.md s.5): name, relay, server, last_code. All on; set one to false to switch it off.
var settings_use := {"name": true, "relay": true, "server": true, "last_code": true}
## null: read the environment (`OS.get_environment`) for the overriding variables; a Dictionary: that fixed map ({} reads none).
var settings_env: Variant = null
var _settings: OneLobbySettings = null
var _settings_store: OneLobbyStore = null
var _relay_warned := false
var _bans: OneLobbyBanList = null
var _socket: OneLobbyTransport.OLSocket
## Direct mode: builds the signaling socket instead of a WebSocket to lobby_server (valid while a direct lobby is open).
var _socket_factory := Callable()
## The join code (display form) of the direct lobby being hosted, joined or rejoined; "" outside Direct mode.
var _direct_code := ""
var _direct_host: OneLobbyDirectHost = null
var _lan_finder: OneLobbyLanFinder = null
## Direct mode: the host's fixed UDP port range [begin, end] (set by host_direct's udp_port_range), applied to every
## peer connection this client makes.
var port_range: Array = []
## Direct mode, joiner by IP: the host's address from a v0 code; its host candidates are also tried there.
var remote_ip := ""
## Direct mode, loopback only (a host that listens on 127.0.0.1 only, or a joiner of a 127.x address): no ICE servers at all, not even
## the default STUN, so nothing leaves this PC.
var no_default_stun := false
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


func _ready() -> void:
	# a copy that asked for its own log file (`--netlog=` / ONELOBBY_NETLOG) has the file from the start, not only once something is logged
	if OneLobbyNetLog.requested_path(settings_env, OS.get_cmdline_user_args()) != "":
		get_net_log()


func _process(_delta: float) -> void:
	if auto_pump:
		pump()


## The net log (spec/diagnostics.md s.5): a ring buffer of connection steps with timings. `get_net_log().export()` is the
## text a player copies; addresses are masked unless asked for, credentials never print. It stays on this machine.
func get_net_log() -> OneLobbyNetLog:
	if _net_log == null:
		_net_log = OneLobbyNetLog.new(log_size, transport.now_ms)
		_net_log.path = log_path
		var asked := OneLobbyNetLog.requested_path(settings_env, OS.get_cmdline_user_args())
		if asked != "":
			_net_log.path = asked
			_net_log.live = true # one file per copy, written line by line
		_net_log.set_meta_info("onelobby-gdscript " + LIB_VERSION, "lk1", "godot " + OS.get_name().to_lower())
		_net_log.add("info", "client onelobby-gdscript %s protocol lk1 game version %s" % [LIB_VERSION, net_version])
	return _net_log


func diag_route() -> String:
	return _route


## Checks what this network allows (spec/diagnostics.md s.8): whether UDP gets out, the NAT type (two STUN servers from
## one socket) and whether a relay takes its login. Contacts only the STUN servers in options.stun (default: the ones the
## client connects with) and the TURN entry in options.ice_servers (default: the ICE servers of the last lobby server
## welcome). A menu runs it when it opens (once, unless the game's onelobby.json says `diagnostics.checkOnOpen: false`) and on its button; the library never does. Returns {udp, natType, relay, verdict, message}; the
## message is one plain line ("Direct connections: likely to fail. A relay is recommended."). Remembered as `last_check`.
##
##     var r: Dictionary = await client.check_connection()
func check_connection(options: Dictionary = {}) -> Dictionary:
	var o := options.duplicate()
	if not o.has("ice_servers"):
		o["ice_servers"] = ice
	var r: Dictionary = await OneLobbyConnectionCheck.check(get_tree(), o)
	last_check = r
	get_net_log().add("info", "connection check udp=%s nat=%s relay=%s verdict=%s" % [r["udp"], r["natType"], r["relay"], r["verdict"]])
	return r


func _notification(what: int) -> void:
	# the window closing or the tree quitting: save the log (a crash cannot be hooked, see log_path)
	if what == NOTIFICATION_WM_CLOSE_REQUEST or what == NOTIFICATION_PREDELETE:
		if _net_log != null:
			_net_log.flush()


func _exit_tree() -> void:
	if _net_log != null:
		_net_log.flush()
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


## A client that runs from onelobby.json (docs/design/blueprint.md; the GDScript twin of JS `OneLobby.fromConfig` and C#
## `LobbyClient.FromBlueprint`). `source` is an OneLobbyConfig, a path to the file (default res://onelobby.json) or a
## parsed Dictionary. `overrides`: `display_name` (checked against `players.*`), `lobby_server` (wins over
## `hosting.lobbyServer`; the file is the bottom layer, so a settings screen or an environment variable goes here).
## Always returns a client: when the file is invalid (`check_gdscript` finds nothing to refuse today),
## `config_error` is set and its first host / join / list fails with it. `sync.mode`, `sync.tickRate` and
## `sync.hashEveryTicks` set `sync_mode`, `tick_rate` and `hash_every_ticks`; `diagnostics.reportToHost`, `logSize` and `relayProbe` set `report_to_host`,
## `log_size` and `relay_probe`; `chat.text` and `session.pause` switch the
## lobby's chat and pause helpers (`lobby.chat.send` raises "chat_disabled", `lobby.pause.request` "pause_disabled").
##
##     var client := OneLobbyClient.from_config("res://onelobby.json", {"display_name": "Sam"})
##     add_child(client)
##     var lobby := await client.host()    # a lobby server when hosting.server is true, else a direct lobby with a Nostr code
##     var lobby := await client.join(code) # a lobby code goes to the server, a direct code or an address to host_direct
static func from_config(source: Variant = OneLobbyConfig.DEFAULT_PATH, overrides: Dictionary = {}) -> OneLobbyClient:
	var cfg: OneLobbyConfig
	if source is OneLobbyConfig:
		cfg = source
	elif source is Dictionary:
		cfg = OneLobbyConfig.parse(source)
	else:
		cfg = OneLobbyConfig.load_file(str(source))
	var c := OneLobbyClient.new()
	c.config = cfg
	if not cfg.ok:
		c.config_error = cfg.error
		return c
	var who := str(overrides.get("display_name", "")).strip_edges()
	c.config_error = cfg.check_display_name(who)
	if c.config_error.is_empty():
		c.config_error = cfg.check_gdscript()
	c.game_id = cfg.game_id
	c.net_version = cfg.net_version
	c.lobby_server = str(overrides.get("lobby_server", cfg.hosting["lobby_server"]))
	c.display_name = who
	c.tick_rate = cfg.sync["tick_rate"]
	c.sync_mode = "raw" if cfg.sync["mode"] == "replication" else cfg.sync["mode"] # replication runs on a raw lobby (the game adds the session)
	c.hash_every_ticks = cfg.sync["hash_every_ticks"]
	c.relay_only = cfg.hosting["relay_only"]
	c.ready_timeout_ms = cfg.session["ready_timeout_ms"]
	c.peer_timeout_ms = cfg.session["peer_timeout_ms"]
	c.report_to_host = cfg.diagnostics["report_to_host"]
	c.log_size = cfg.diagnostics["log_size"]
	c.relay_probe = cfg.diagnostics["relay_probe"]
	return c


## Creates a lobby. `options`: name, max_players (4), visibility ("public" | "unlisted" | "private"), late_join (true),
## meta ({} of strings), rate_limit ({messages, per_ms}: host-side cap on raw messages per peer), password (joiners must give
## it, at most 64 characters; `bad_password` otherwise), data (your own starting player data), room (the room layer's
## settings, see room_options below). A blueprint's `room` section supplies the defaults.
##
## `room`: auto_start ("off" | "all_ready" | "players"), auto_start_players (2), min_players (1), countdown_seconds (3),
## spectators (0: the spectator cap, on top of max_players), late_join ("allow" | "spectate" | "refuse"), seat_dropped
## ("window" | "immediate"), rejoin_window_seconds (60), data ({key: {type, min?, max?, maxLength?, values?, default?,
## hostOnly?}} declarations beyond color, avatar and team), password_required (host() fails with `password_required`
## unless a password is given), max_name_length (24).
func host(options: Dictionary = {}) -> OneLobbyLobby:
	if config != null:
		# with a config: the file's lobby settings are the defaults; no lobby server in the file (the GDScript default) hosts direct
		if not _config_usable():
			return null
		if not config.hosting["server"]:
			return await host_direct(options)
		if effective_server().is_empty():
			_fail("no_server", "hosting.server is true but there is no lobby server address (hosting.lobbyServer in onelobby.json, or the lobby_server override)")
			return null
		options = _with_defaults(config.host_options(effective_name()), options)
	var rl: Dictionary = options.get("rate_limit", {})
	var room_opts := _room_options(options.get("room", {}))
	var pw := str(options.get("password", ""))
	if not _room_host_ok(room_opts, pw):
		return null
	var o := options.duplicate()
	o["relay_only"] = relay_only
	var players := int(o.get("max_players", 4))
	var spectators := int(OneLobbyRoomRules.resolve_settings(room_opts, players, true)["spectators"])
	var setup := _host_setup(options, room_opts, pw, players)
	# built once the hub's `welcome` is in: a hub without the "room" feature has no spectator slots or password
	var build := func() -> String:
		var room_hub := features.has("room")
		var co := o.duplicate()
		co["max_players"] = players if room_hub else players + spectators
		if room_opts.has("late_join"):
			co["late_join"] = room_opts["late_join"] != "refuse"
		return OneLobbySignaling.create(co, sync_mode, tick_rate, pw if room_hub else "", spectators if room_hub else 0)
	var finish := func(e: Dictionary) -> Variant:
		var l := _enter_lobby(e, setup)
		l.rate_limit = rl
		_remember_code(l.code)
		return l
	return await _run("", "", ["lobby"], finish, REQUEST_TIMEOUT_MS, build)


## Joins by code ("7HQ 4K2", "7hq-4k2" and look-alike letters are fine). `options`: password (the lobby's, if it has one;
## a wrong one fails with `bad_password`), role ("player" | "spectator"), data (your starting player data: color, avatar,
## team and the game's own keys; the host validates it).
func join(join_code: String, options: Dictionary = {}) -> OneLobbyLobby:
	if config != null:
		# with a config a lobby code goes to the lobby server, anything else (direct code, address) to join_direct
		if not _config_usable():
			return null
		if OneLobbyJoinCode.normalize(join_code) == "":
			return await join_direct(join_code, options)
		if not config.hosting["server"] or effective_server().is_empty():
			_fail("no_server", "this game has no lobby server (hosting.server is false in onelobby.json): join with a direct code or an address")
			return null
	var norm := OneLobbyJoinCode.normalize(join_code)
	if norm == "":
		_fail("unknown_code", "not a valid join code")
		return null
	var setup := _join_setup(options)
	var finish := func(e: Dictionary) -> Variant:
		var l := _enter_lobby(e, setup)
		_remember_code(norm)
		return l
	return await _run("", OneLobbySignaling.join(norm, str(options.get("password", ""))), ["lobby"], finish)


## Takes your seat back after a dropped connection (lobby.resume_token from before). If the connection to the server is
## still up (a lobby you left, or a seat you want to take over from another socket) it is closed and reopened first, so
## the server sees a fresh hello carrying the token.
func rejoin(token: String) -> OneLobbyLobby:
	if not _config_usable():
		return null
	var finish := func(e: Dictionary) -> Variant: return _enter_lobby(e, {"pid": player_id(), "bans": bans()})
	return await _run(token, "", ["lobby"], finish)


## A finder for LAN games (spec/lan-discovery.md): `finder.start()` asks the local network, `finder.games` is the list and
## `finder.changed` fires when it changes, `finder.stop()` closes its socket. It is a child of this client and polls itself.
## With a blueprint whose `hosting.lan` is false it stays off (`finder.status == "off"`). Options: targets (PackedStringArray; default the
## broadcast address, a test passes ["127.0.0.1"]), port. The same finder is returned every call.
func lan_finder(options: Dictionary = {}) -> OneLobbyLanFinder:
	if _lan_finder == null:
		_lan_finder = OneLobbyLanFinder.new(game_id, net_version, options)
		if config != null:
			_lan_finder.enabled = bool(config.hosting["lan"])
		_lan_finder.log_fn = func(line: String) -> void: get_net_log().add("info", line)
		add_child(_lan_finder)
	return _lan_finder


## Stops the LAN finder (closing its socket) and frees it, so no finder object exists until lan_finder() is called again. The drop-in
## menu uses this: it looks for LAN games only while its LAN list is the one on screen.
func drop_lan_finder() -> void:
	if _lan_finder == null:
		return
	var f := _lan_finder
	_lan_finder = null
	f.stop()
	remove_child(f)
	f.queue_free()


## Direct mode, host: runs the lobby inside this game with no lobby server. Joiners find you through public Nostr
## relays with a short code: `lobby.code` ("D1PB-1X9S-FPV"; show it, or copy it). The lobby, its signals and peers are
## the same as raw mode, and JS and .NET players can join it.
##
##     var lobby := await client.host_direct({"name": "My game", "max_players": 4})
##     print("Join code: ", lobby.code)
##
## `options`: name, max_players (4), password (""), late_join (true), meta, rate_limit, data and room as in host(); lan (false; the
## blueprint's hosting.lan: answer LAN discovery questions on UDP `lan_port` 47840, see spec/lan-discovery.md); relays (wss URLs,
## default: seven public ones), stun (default: Google and Cloudflare), upnp_port (0 = off: asks the router to forward
## that UDP port; best effort, see the README), ice_servers (Array of {urls, username?, credential?}, e.g. a TURN relay
## for players behind a strict NAT: sent to every joiner in welcome.ice; OneLobbyTurn.login() mints coturn-style
## logins). Godot's WebRTC reaches TURN over UDP only (libjuice): turn:...?transport=tcp and turns: are skipped.
## Fails with no_relay when no relay can be reached.
func host_direct(options: Dictionary = {}) -> OneLobbyLobby:
	if config != null:
		if not _config_usable():
			return null
		options = _with_defaults(config.direct_options(effective_name()), options)
	if not _op.is_empty():
		_fail("busy", "another request is in flight")
		return null
	if lobby != null:
		_fail("in_lobby", "already in a lobby; leave it first")
		return null
	var room_opts := _room_options(options.get("room", {}))
	var pw := str(options.get("password", ""))
	if not _room_host_ok(room_opts, pw):
		return null
	var range: Array = options.get("udp_port_range", [])
	if options.has("udp_port_range") and (range.size() != 2 or int(range[0]) < 1 or int(range[1]) > 65535 or int(range[0]) > int(range[1])):
		_fail("bad_request", "udp_port_range must be [begin, end] with 1 <= begin <= end <= 65535")
		return null
	# the Direct hub has no spectator slots: it gets players + spectators as its capacity and the room splits it
	var players := int(options.get("max_players", 4))
	var cap := players + int(OneLobbyRoomRules.resolve_settings(room_opts, players, true)["spectators"])
	var hub_options := options.duplicate()
	hub_options["max_players"] = cap
	if bool(options.get("lan", false)):
		hub_options["lan_game_id"] = game_id
		hub_options["lan_net_version"] = net_version
		hub_options["lan_log"] = func(line: String) -> void: get_net_log().add("info", line)
	var d := OneLobbyDirectHost.start(hub_options)
	if d == null:
		if OneLobbyIpListener.last_error != "" and (options.has("tcp_port") or options.has("udp_port_range") or not bool(options.get("nostr", true))):
			_fail("port_in_use", "could not listen for joiners by IP: " + OneLobbyIpListener.last_error)
		else:
			_fail("bad_code", "could not make a join code")
		return null
	port_range = range
	no_default_stun = OneLobbyDirectHost.is_loopback_address(str(hub_options.get("listen_address", "*")))
	_direct_host = d
	d.lan_max_players = players
	d.lan_password = pw != ""
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
	while d.nostr != null and not d.nostr.relays_settled() and transport.now_ms() < rest and is_inside_tree():
		await get_tree().process_frame
	_socket_factory = d.connect_local
	var rl: Dictionary = options.get("rate_limit", {})
	var o := options.duplicate()
	o["relay_only"] = relay_only
	o["visibility"] = "unlisted"
	o["max_players"] = cap
	if room_opts.has("late_join"):
		o["late_join"] = room_opts["late_join"] != "refuse"
	var setup := _host_setup(options, room_opts, pw, players)
	var finish := func(e: Dictionary) -> Variant:
		var l := _enter_lobby(e, setup)
		l.rate_limit = rl
		return l
	var result: Variant = await _run("", OneLobbySignaling.create(o, sync_mode, tick_rate), ["lobby"], finish)
	if result == null:
		_clear_direct()
	else:
		_remember_code(_direct_code)
	return result


## Direct mode, joiner: joins the lobby a host_direct() host published. `join_code` is the code the host shows
## ("D1PB-1X9S-FPV"; case, dashes and look-alike letters do not matter). Needs no lobby server. `options`: password,
## role and data (as in join()), relays (wss URLs), timeout_ms (30000), ice_servers (as in host_direct; added to the host's list).
##
##     var lobby := await client.join_direct("D1PB-1X9S-FPV")
func join_direct(join_code: String, options: Dictionary = {}) -> OneLobbyLobby:
	if config != null:
		if not _config_usable():
			return null
		options = _with_defaults(_direct_join_defaults(), options)
	return await _direct_join(join_code, options, "", OneLobbySignaling.join_direct(str(options.get("password", ""))))


## Direct mode: takes your seat back after the connection dropped (lobby.resume_token and the code from before). Works
## only while the host is still running that lobby (60 s after the drop).
func rejoin_direct(join_code: String, token: String, options: Dictionary = {}) -> OneLobbyLobby:
	if config != null:
		if not _config_usable():
			return null
		options = _with_defaults(_direct_join_defaults(), options)
	return await _direct_join(join_code, options, token, "")


func _direct_join(join_code: String, options: Dictionary, resume: String, request: String) -> OneLobbyLobby:
	var dec := OneLobbyJoinCode.decode_dc1(join_code)
	if not dec.has("room") and not dec.has("ip"):
		dec = OneLobbyJoinCode.parse_address(join_code) # "1.2.3.4" or "1.2.3.4:47810", for hosts that show an address
	if dec.has("error") or (not dec.has("room") and not dec.has("ip")):
		if dec.get("error", "") == "unknown_version":
			_fail("unsupported_code", "this code is from a newer version of the game (an unknown code version)")
		else:
			_fail("unknown_code", "not a valid join code")
		return null
	if not _op.is_empty():
		_fail("busy", "another request is in flight")
		return null
	if lobby != null:
		_fail("in_lobby", "already in a lobby; leave it first")
		return null
	_extra_ice = options.get("ice_servers", [])
	if dec.has("ip"):
		# join by IP: the host's TCP port carries signaling, no Nostr
		var url := "ws://%s:%d/" % [dec["ip"], dec["port"]]
		remote_ip = str(dec["ip"])
		no_default_stun = OneLobbyDirectHost.is_loopback_address(remote_ip)
		_direct_code = OneLobbyJoinCode.encode_ip(remote_ip, int(dec["port"]))
		_route = "ip"
		_socket_factory = func() -> OneLobbyTransport.OLSocket: return transport.connect_signaling(url)
	else:
		var norm := OneLobbyJoinCode.normalize_dc1(join_code)
		var relays: Array = options.get("relays", [])
		_direct_code = OneLobbyJoinCode.group(norm)
		_route = "nostr"
		_socket_factory = func() -> OneLobbyTransport.OLSocket: return OneLobbyNostrSocket.new(norm, relays)
	var setup := _join_setup(options) if resume == "" else {"pid": player_id(), "bans": bans()}
	var finish := func(e: Dictionary) -> Variant: return _enter_lobby(e, setup)
	var result: Variant = await _run(resume, request, ["lobby"], finish, int(options.get("timeout_ms", DIRECT_TIMEOUT_MS)))
	if result == null:
		_clear_direct()
	elif resume == "":
		_remember_code(_direct_code)
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
	if not _config_usable():
		return []
	if config != null and not config.hosting["server"]:
		_fail("listing_disabled", "this game has no lobby server (hosting.server is false in onelobby.json)")
		return []
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
			sock.send_text(OneLobbySignaling.hello(game_id, net_version, effective_name(), _hello_resume, player_id()))
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


## This install's player id for the game (32 hex characters, made once and kept in `store`; spec/room.md 1). It goes out in
## `hello` so hubs can refuse banned ids and hosts can keep a player's seat. Not an account or a hardware id.
func player_id() -> String:
	if _pid == "":
		_pid = OneLobbyStore.load_player_id(_store(), game_id)
	return _pid


## The host-side ban list for this game (also `lobby.room.bans`): persistent in `store`.
func bans() -> OneLobbyBanList:
	if _bans == null:
		_bans = OneLobbyBanList.new(_store(), game_id)
	return _bans


func _store() -> OneLobbyStore:
	if store == null:
		store = OneLobbyStore.file()
	return store


## The room options of a host call: the blueprint's `room` section under the explicit ones (their `data` declarations merge).
func _room_options(explicit: Variant) -> Dictionary:
	var out: Dictionary = config.room_options() if config != null and config.ok else {}
	if explicit is Dictionary:
		for k: Variant in explicit:
			if str(k) == "data" and explicit[k] is Dictionary:
				var merged: Dictionary = (out.get("data", {}) as Dictionary).duplicate(true)
				for dk: Variant in explicit[k]:
					merged[dk] = explicit[k][dk]
				out["data"] = merged
			elif explicit[k] != null:
				out[str(k)] = explicit[k]
	return out


## False (after failing) when the room options or the password break a rule: password_required, a password over 64 characters.
func _room_host_ok(room_opts: Dictionary, pw: String) -> bool:
	if bool(room_opts.get("password_required", false)) and pw == "":
		_fail("password_required", "this game requires a lobby password (room.passwordRequired); pass `password`")
		return false
	if pw.length() > 64:
		_fail("bad_request", "password must be at most 64 characters")
		return false
	return true


func _host_setup(options: Dictionary, room_opts: Dictionary, pw: String, players: int) -> Dictionary:
	return {"options": room_opts, "password": pw, "max_players": players, "pid": player_id(), "bans": bans(),
		"join": {"role": "player", "data": options.get("data", {}), "password": ""}}


func _join_setup(options: Dictionary) -> Dictionary:
	return {"pid": player_id(), "bans": bans(),
		"join": {"role": str(options.get("role", "player")), "data": options.get("data", {}), "password": str(options.get("password", ""))}}


## False (after failing with the config's own error) when `config` is invalid or refuses this client; true without a config.
func _config_usable() -> bool:
	if config == null:
		return true
	if not config_error.is_empty():
		_fail(str(config_error["code"]), str(config_error["message"]))
		return false
	return true


## `defaults` with every key of `options` on top.
static func _with_defaults(defaults: Dictionary, options: Dictionary) -> Dictionary:
	var o := defaults.duplicate()
	for k: Variant in options:
		o[k] = options[k]
	return o


func _direct_join_defaults() -> Dictionary:
	var relays: Array = config.hosting["nostr_relays"]
	return {"relays": relays.duplicate()} if not relays.is_empty() else {}


## The player's saved settings (spec/settings.md): load_values(), effective(), save({...}), masked_relay(). Kept in `store` (by
## default user://onelobby.json) under `onelobby.settings.<game_id>`; the client applies them as defaults.
var settings: OneLobbySettings:
	get:
		var s := _store()
		if _settings == null or _settings_store != s or _settings.game_id != game_id:
			_settings = OneLobbySettings.create(s, game_id, settings_env)
			_settings_store = s
		return _settings


## The name hello and the lobby use: `display_name` when the game gave one (anything but empty or the default "Player"), else
## the saved name (unless `settings_use["name"]` is false or the blueprint is anonymous), clamped to players.maxNameLength.
func effective_name() -> String:
	if not bool(settings_use.get("name", true)) or not (display_name.is_empty() or display_name == "Player"):
		return display_name
	var max_len := 24
	if config != null and config.ok:
		if str(config.players.get("identity", "name")) == "anonymous":
			return display_name
		max_len = int(config.players.get("max_name_length", 24))
	var saved := OneLobbySettings.clean_name(settings.effective()["name"], max_len)
	return saved if saved != "" else display_name


## The lobby server to connect to: `lobby_server` when the game gave one, else (with no `onelobby.json` address either) the
## saved one, unless `settings_use["server"]` is false.
func effective_server() -> String:
	if not lobby_server.is_empty() or not bool(settings_use.get("server", true)):
		return lobby_server
	return str(settings.effective()["server"])


## `list` plus this player's saved relay entry, unless it is already in it (spec/settings.md s.5). Warns once about a saved
## relay line that does not parse, without printing it.
func _with_saved_relay(list: Array) -> Array:
	if not bool(settings_use.get("relay", true)):
		return list
	var st := settings.relay_status()
	if st["invalid"] and not _relay_warned:
		_relay_warned = true
		push_warning(OneLobbySettings.RELAY_SKIPPED_WARNING)
		warning.emit(OneLobbySettings.RELAY_SKIPPED_WARNING)
	var entry: Dictionary = st["entry"]
	if entry.is_empty():
		return list
	for e: Variant in list:
		if e is Dictionary and str(e.get("urls")) == str(entry["urls"]) and str(e.get("username", "")) == str(entry.get("username", "")) and str(e.get("credential", "")) == str(entry.get("credential", "")):
			return list
	return list + [entry]


## Saves the code of a lobby this player hosted or joined as `last_code` (a code that does not clean is not saved).
func _remember_code(code: String) -> void:
	if not bool(settings_use.get("last_code", true)):
		return
	var c: Variant = OneLobbySettings.clean_last_code(code)
	if c is String and c != "":
		settings.save({"last_code": c})


func raise_error(code: String, message: String, extra: Dictionary = {}) -> void:
	last_error = {"code": code, "message": message}
	last_error.merge(extra)
	error.emit(code, message)


func _enter_lobby(e: Dictionary, room_setup: Dictionary = {}) -> OneLobbyLobby:
	var l := OneLobbyLobby.new(self, e, room_setup)
	if _direct_code != "":
		l._direct = true
		l.code = _direct_code
		if _direct_host != null:
			l.ip_code = _direct_host.ip_code
			if _direct_host.lan != null:
				var dh := _direct_host
				dh.lan_info = func() -> Dictionary:
					if l._closed or dh.ip == null:
						return {}
					var host_name := ""
					for p in l.peers():
						if int(p["peer_id"]) == l.local_peer_id:
							host_name = str(p["name"])
					return {"lobby_name": l.name, "host_name": host_name, "players": l.peers().size(), "max_players": dh.lan_max_players,
						"password": dh.lan_password, "port": dh.ip.port}
	if config != null:
		l.pause.mode = str(config.session["pause"])
		l.chat.enabled = bool(config.chat["text"])
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
	_extra_ice = []
	port_range = []
	remote_ip = ""
	no_default_stun = false
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


func _run(resume: String, request: String, expect: Array, finish: Callable, timeout_ms: int = REQUEST_TIMEOUT_MS, build: Callable = Callable()) -> Variant:
	if not _op.is_empty():
		_fail("busy", "another request is in flight")
		return null
	if lobby != null and expect[0] == "lobby":
		_fail("in_lobby", "already in a lobby; leave it first")
		return null
	if (_socket == null or _socket.state == OneLobbyTransport.OLSocket.CLOSED) and not _socket_factory.is_valid() and effective_server().is_empty():
		_fail("no_server", "no lobby server address (set lobby_server, or save one in the multiplayer settings)")
		return null
	_op = {"request": "<built>" if build.is_valid() else request, "build": build, "expect": expect, "sent": false, "deadline": transport.now_ms() + timeout_ms, "finish": finish, "started": transport.now_ms()}
	# A resume needs a fresh hello: if this connection already said hello, drop it and start a new one.
	if _socket != null and resume != "" and _welcomed:
		_socket.close()
	if _socket == null or _socket.state == OneLobbyTransport.OLSocket.CLOSED:
		get_net_log().add("sig", "open route=" + _route, OneLobbySettings.redact_url(effective_server()) if not _socket_factory.is_valid() else "")
		_socket = _socket_factory.call() if _socket_factory.is_valid() else transport.connect_signaling(effective_server())
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
		var build: Callable = _op.get("build", Callable())
		_socket.send_text(str(build.call()) if build.is_valid() else _op["request"])
	elif not _stashed_lobby.is_empty():
		var s := _stashed_lobby
		_stashed_lobby = {}
		_finish_op(s)


func _finish_op(e: Dictionary) -> void:
	var finish: Callable = _op["finish"]
	_op = {}
	# deferred: the awaiting coroutine resumes after this pump, with its signal handlers free to connect first
	_emit_done.call_deferred(finish.call(e))


## The error codes a connect failure carries a diagnosis for (spec/diagnostics.md s.9).
const DIAGNOSED_CODES := ["connect_failed", "direct_unreachable", "version_mismatch", "server_closed", "closed"]


func _fail_op(code: String, message: String, versions: Variant = null) -> void:
	if _op.is_empty():
		return
	var started := int(_op.get("started", transport.now_ms()))
	_op = {}
	var extra := {}
	# a failure after the welcome is a refused join: only a version mismatch is about connecting
	if DIAGNOSED_CODES.has(code) and (not _welcomed or code == "version_mismatch"):
		var facts := {
			"side": "joiner", "route": _route, "error": code, "reached": "signaling" if _welcomed else "none",
			"elapsedMs": maxi(0, transport.now_ms() - started), "versions": versions, "relaysUp": null, "stun": false,
			"relay": "none", "local": [], "remote": [], "retried": false, "nat": "unknown", "heard": null,
		}
		var d := OneLobbyDiagnose.diagnose(facts)
		extra["diagnosis"] = d
		get_net_log().add("diag", "cause %s stage %s after %d ms" % [d["cause"], d["stage"], int(facts["elapsedMs"])])
	_fail(code, message, extra)
	_emit_done.call_deferred(null)


func _fail(code: String, message: String, extra: Dictionary = {}) -> void:
	last_error = {"code": code, "message": message}
	last_error.merge(extra)
	get_net_log().add("error", code, "", code)
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
			ice = _with_saved_relay(OneLobbySignaling.ice_of(e) + OneLobbySignaling.ice_of({"ice": _extra_ice}))
			var fs: Variant = e.get("features")
			features = fs if fs is Array else []
			_welcomed = true
			get_net_log().add("sig", "welcome features=%s" % [",".join(PackedStringArray(features)) if not features.is_empty() else "none"])
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
				var versions: Variant = null
				if code == "version_mismatch" and data is Dictionary and str(data.get("hostNetVersion", "")) != "":
					versions = {"mine": str(data.get("yourNetVersion", net_version)), "theirs": str(data["hostNetVersion"])}
				_fail_op(code, msg, versions)
			else:
				raise_error(code, msg)
			if lobby != null:
				lobby._on_server_error(code, disconnected, data if data is Dictionary else {})
			return
	if not _op.is_empty() and _op["sent"] and (_op["expect"] as Array).has(t):
		_finish_op(e)
		return
	if t == "lobby" and lobby == null:
		_stashed_lobby = e # a resume reply that beat the request
		return
	if lobby != null:
		lobby._on_signaling(t, e)
