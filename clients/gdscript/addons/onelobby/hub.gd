class_name OneLobbyHub
extends RefCounted
## The signaling hub (protocol lk1) for a host that runs its own lobby inside the game (Direct mode). A port of
## clients/js/packages/client/src/direct/hub.ts (and so of server/OneLobby.Hub/Hub.cs) without metrics, TURN and the
## per-IP limits: one lobby, no join codes issued, no list. Transport-agnostic: feed it text with receive(), call
## tick() about once a second. Sessions are connected with connect(address, send, close).

const PROTO := "lk1"
const NAME_MAX := 24
const LOBBY_NAME_MAX := 48
const META_KEYS_MAX := 16
const META_LEN_MAX := 64
const PENDING_MAX := 8
const SIGNAL_FANOUT := 8
const SIGNAL_PER_SEC := 20
## `signal` per second per (sender, Nostr target): relays reject high publish rates.
const NOSTR_SIGNAL_PER_SEC := 10
const NOSTR_ADDR := "nostr:"
const IDLE_TIMEOUT_MS := 30000
const RESUME_WINDOW_MS := 60000
const MAX_MESSAGE_BYTES := 16 * 1024
const CROCKFORD := "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const KNOWN_TYPES := ["hello", "create", "join", "list", "leave", "signal", "meta", "phase", "kick", "approve", "ping", "host_changed", "path", "set_name"]


## Sliding-window counter: at most `limit` events per `window_ms`.
class OLRateWindow:
	var limit := 0
	var window_ms := 0
	var hits: Array[int] = []

	func _init(l: int, w: int) -> void:
		limit = l
		window_ms = w

	func try_hit(now: int) -> bool:
		_trim(now)
		if hits.size() >= limit:
			return false
		hits.append(now)
		return true

	func retry_after_ms(now: int) -> int:
		_trim(now)
		if hits.size() < limit or hits.is_empty():
			return 0
		return maxi(1, window_ms - (now - hits[0]))

	func is_idle(now: int) -> bool:
		_trim(now)
		return hits.is_empty()

	func _trim(now: int) -> void:
		while not hits.is_empty() and now - hits[0] >= window_ms:
			hits.pop_front()


class OLMember:
	var peer_id := 0
	var name := ""
	var joined_at := 0
	var session: OLSession = null
	var detached_at := 0
	var token := ""
	var ip := ""
	var renames: OLRateWindow = null


class OLSession:
	var id := 0
	var ip := ""
	var send: Callable   # (text: String)
	var close: Callable  # (code: int, reason: String)
	var closed := false
	var last_seen := 0
	var hello_done := false
	var game_id := ""
	var net_version := ""
	var name := ""
	var lobby: OLLobby = null
	var member: OLMember = null
	var pending_in: OLLobby = null
	var pending_member: OLMember = null
	var signal_rates := {}  # Member -> RateWindow
	var signal_total: OLRateWindow = null


class OLLobby:
	var code := ""
	var game_id := ""
	var net_version := ""
	var name := ""
	var visibility := "public"
	var mode := "lockstep"
	var tick_rate := 20
	var late_join := false
	var relay_only := false
	var phase := "lobby"
	var max_players := 0
	var created_at := 0
	var owner_ip := ""
	var meta := {}
	var members: Array[OLMember] = []
	var pending: Array[OLMember] = []
	var kicked := {}
	var host_id := 0
	var epoch := 0
	var next_peer_id := 1

	func find(peer_id: int) -> OLMember:
		for m in members:
			if m.peer_id == peer_id:
				return m
		return null


# options (see direct_options)
var stun_urls: Array = []
## Extra ICE servers ({urls, username?, credential?}) for welcome.ice after the STUN entry, e.g. a TURN relay.
var ice_servers: Array = []
var max_players_hard := 64
var max_peers := 10000
var password := ""  # empty = none
var issue_codes := false

var _lobbies := {}   # code -> Lobby
var _tokens := {}    # token -> [Lobby, Member]
var _sessions := {}  # id -> Session
var _next_session := 0
var _created_once := false
var _members := 0


## A hub for a host's own game: one lobby, `max_players` seats, optional password, STUN list and extra ICE servers
## handed to joiners.
static func direct(max_players: int, pw := "", stun: Array = [], ice_servers: Array = []) -> OneLobbyHub:
	var h := OneLobbyHub.new()
	var n := clampi(max_players, 2, 250)
	h.max_players_hard = n
	h.max_peers = n + 8
	h.password = pw
	h.stun_urls = stun
	h.ice_servers = ice_servers
	return h


static func _now() -> int:
	return Time.get_ticks_msec()


func lobby_count() -> int:
	return _lobbies.size()


func session_count() -> int:
	return _sessions.size()


# ---------------------------------------------------------------- connection lifecycle

## Registers a socket. Returns null (after sending server_full and closing) when over the peer limit.
func connect_session(ip: String, send: Callable, close: Callable) -> OLSession:
	var s := OLSession.new()
	_next_session += 1
	s.id = _next_session
	s.ip = ip
	s.send = send
	s.close = close
	s.last_seen = _now()
	if _sessions.size() >= max_peers:
		_error(s, "server_full", "server is at its peer limit")
		s.close.call(1000, "")
		return null
	_sessions[s.id] = s
	return s


func disconnect_session(s: OLSession) -> void:
	if not _sessions.erase(s.id):
		return
	s.closed = true
	if s.pending_in != null:
		s.pending_in.pending.erase(s.pending_member)
		s.pending_in = null
		s.pending_member = null
	var m := s.member
	var lobby := s.lobby
	if m != null and lobby != null:
		# The slot and token stay reserved for the resume window (tick expires them); others hear peer_left{timeout} now.
		m.session = null
		m.detached_at = _now()
		s.member = null
		s.lobby = null
		_broadcast(lobby, {"t": "peer_left", "peerId": m.peer_id, "reason": "timeout"})
		if lobby.host_id == m.peer_id:
			_promote_host(lobby, m.peer_id)


func _close_session(s: OLSession) -> void:
	s.close.call(1000, "")
	disconnect_session(s)


## Call about once a second: idle timeouts and resume-window expiry.
func tick() -> void:
	var now := _now()
	for s: OLSession in _sessions.values():
		if now - s.last_seen > IDLE_TIMEOUT_MS:
			_close_session(s)
	for lobby: OLLobby in _lobbies.values():
		for m in lobby.members.duplicate():
			if m.detached_at > 0 and now - m.detached_at >= RESUME_WINDOW_MS:
				_remove_member(lobby, m, "timeout")


# ---------------------------------------------------------------- inbound

func receive(s: OLSession, text: String) -> void:
	if s.closed:
		return
	s.last_seen = _now()
	if text.length() > MAX_MESSAGE_BYTES:
		_error(s, "bad_request", "message too large")
		_close_session(s)
		return
	var parsed: Variant = JSON.parse_string(text)
	var msg: Dictionary = parsed if parsed is Dictionary else {}
	var t: Variant = msg.get("t")
	if msg.is_empty() or not t is String:
		_error(s, "bad_request", "expected a JSON object with a string t", {"field": "t"})
		return
	if t == "hello":
		_hello(s, msg)
		return
	if not s.hello_done:
		if KNOWN_TYPES.has(t):
			_error(s, "bad_request", "send hello first")
		return
	match t:
		"create": _create(s, msg)
		"join": _join(s, msg)
		"list": _send(s, {"t": "lobbies", "items": []})
		"leave": _leave(s)
		"signal": _signal(s, msg)
		"meta": _host_meta(s, msg)
		"phase": _host_phase(s, msg)
		"kick": _kick(s, msg)
		"approve": _approve(s, msg)
		"ping":
			var n: Variant = _int(msg, "n")
			if n == null or n < 0:
				_error(s, "bad_request", "ping needs an integer n", {"field": "n"})
			else:
				_send(s, {"t": "pong", "n": n})
		"host_changed": pass # a direct lobby has no migration: the host leaving ends the session
		"path": _path_report(s, msg)
		"set_name": _set_name(s, msg)


# ---------------------------------------------------------------- hello / welcome

func _hello(s: OLSession, m: Dictionary) -> void:
	if s.hello_done:
		_error(s, "bad_request", "hello already sent")
		return
	if _str(m, "proto") != PROTO:
		_error(s, "bad_request", "unsupported proto, expected lk1", {"supported": [PROTO]})
		_close_session(s)
		return
	if _has(m, "name") and _str(m, "name") == null:
		_error(s, "bad_request", "name must be a string", {"field": "name"})
		return
	if _has(m, "client") and not m["client"] is Dictionary:
		_error(s, "bad_request", "client must be an object", {"field": "client"})
		return
	var game_id: Variant = _str(m, "gameId")
	var net_version: Variant = _str(m, "netVersion")
	if game_id == null or not _valid_game_id(game_id):
		_error(s, "bad_request", "gameId must match [A-Za-z0-9._-]{1,64}", {"field": "gameId"})
		return
	if net_version == null or net_version == "" or (net_version as String).length() > 32:
		_error(s, "bad_request", "netVersion must be 1-32 characters", {"field": "netVersion"})
		return
	s.game_id = game_id
	s.net_version = net_version
	s.name = sanitize(_str(m, "name"), NAME_MAX, "Player")
	s.hello_done = true

	var resumed: OLMember = null
	var rl: OLLobby = null
	var token: Variant = _str(m, "resumeToken")
	var entry: Variant = _tokens.get(token) if token != null else null
	if entry != null:
		var el: OLLobby = entry[0]
		var em: OLMember = entry[1]
		if el.game_id == game_id and el.net_version == net_version:
			var old := em.session
			var take_over := old != null and old != s
			var in_window := em.detached_at > 0 and _now() - em.detached_at < RESUME_WINDOW_MS
			if take_over or in_window:
				if take_over:
					_close_session(old)
				resumed = em
				rl = el

	var ice: Array = []
	if not stun_urls.is_empty():
		ice.append({"urls": stun_urls.duplicate()})
	for e: Variant in ice_servers:
		if e is Dictionary:
			ice.append(e.duplicate())
	var w := {
		"t": "welcome",
		"ice": ice,
		"serverTime": int(Time.get_unix_time_from_system() * 1000.0),
		"limits": {"maxMsg": MAX_MESSAGE_BYTES, "maxPlayers": max_players_hard},
		"features": ["set_name"],
	}
	if resumed != null:
		w["peerId"] = resumed.peer_id
	_send(s, w)

	if resumed != null and rl != null:
		_tokens.erase(resumed.token)
		resumed.token = _hex(16)
		_tokens[resumed.token] = [rl, resumed]
		resumed.session = s
		resumed.detached_at = 0
		s.lobby = rl
		s.member = resumed
		for other in rl.members:
			if other != resumed:
				_send_to(other, {"t": "peer_joined", "peer": _peer_obj(resumed)})
		_send(s, _lobby_msg(rl, resumed))


# ---------------------------------------------------------------- create / join / leave

func _create(s: OLSession, m: Dictionary) -> void:
	if s.lobby != null or s.pending_in != null:
		_error(s, "bad_request", "already in a lobby")
		return
	if _created_once:
		_error(s, "server_full", "this host runs one lobby")
		return
	if _lobbies.size() >= 1 or _members >= max_peers:
		_error(s, "server_full", "server is at its lobby limit")
		return
	if _has(m, "name") and _str(m, "name") == null:
		_error(s, "bad_request", "name must be a string", {"field": "name"})
		return
	var vis: String = _str(m, "visibility") if _str(m, "visibility") != null else "public"
	var mode: String = _str(m, "mode") if _str(m, "mode") != null else "lockstep"
	if vis != "public" and vis != "unlisted" and vis != "private":
		_error(s, "bad_request", "visibility must be public, unlisted or private", {"field": "visibility"})
		return
	if mode != "lockstep" and mode != "raw":
		_error(s, "bad_request", "mode must be lockstep or raw", {"field": "mode"})
		return
	if _has(m, "maxPlayers") and _int(m, "maxPlayers") == null:
		_error(s, "bad_request", "maxPlayers must be an integer", {"field": "maxPlayers"})
		return
	var max_players: int = _int(m, "maxPlayers") if _int(m, "maxPlayers") != null else 8
	if max_players < 2 or max_players > max_players_hard:
		_error(s, "bad_request", "maxPlayers must be 2-%d" % max_players_hard, {"field": "maxPlayers"})
		return
	if _has(m, "tickRate") and _int(m, "tickRate") == null:
		_error(s, "bad_request", "tickRate must be an integer", {"field": "tickRate"})
		return
	var tick: int = _int(m, "tickRate") if _int(m, "tickRate") != null else 20
	if tick < 1 or tick > 255:
		_error(s, "bad_request", "tickRate must be 1-255", {"field": "tickRate"})
		return
	if _has(m, "lateJoin") and _bool(m, "lateJoin") == null:
		_error(s, "bad_request", "lateJoin must be a boolean", {"field": "lateJoin"})
		return
	if _has(m, "relayOnly") and _bool(m, "relayOnly") == null:
		_error(s, "bad_request", "relayOnly must be a boolean", {"field": "relayOnly"})
		return
	var meta := _read_meta(m.get("meta"))
	if meta.has("err"):
		_error(s, "bad_request", meta["err"], {"field": "meta"})
		return

	var lobby := OLLobby.new()
	lobby.code = _new_code()
	lobby.game_id = s.game_id
	lobby.net_version = s.net_version
	lobby.name = sanitize(_str(m, "name"), LOBBY_NAME_MAX, "%s's lobby" % s.name)
	lobby.visibility = vis
	lobby.mode = mode
	lobby.tick_rate = tick
	lobby.late_join = _bool(m, "lateJoin") == true
	lobby.relay_only = _bool(m, "relayOnly") == true
	lobby.max_players = max_players
	lobby.created_at = _now()
	lobby.owner_ip = s.ip
	lobby.meta = meta["meta"]
	_lobbies[lobby.code] = lobby
	_created_once = true
	var host := _add_member(lobby, s, null)
	lobby.host_id = host.peer_id
	_send(s, _lobby_msg(lobby, host))


func _join(s: OLSession, m: Dictionary) -> void:
	if s.lobby != null or s.pending_in != null:
		_error(s, "bad_request", "already in a lobby")
		return
	var lobby: OLLobby = null
	if not _has(m, "code"):
		# the code (or address) is the invitation, so a join without one means the one lobby
		if not _lobbies.is_empty():
			lobby = _lobbies.values()[0]
		if lobby == null or lobby.game_id != s.game_id:
			_error(s, "unknown_code", "this host has no open lobby for that game")
			return
	else:
		var code := _normalize_code(m["code"])
		if code == "":
			_error(s, "bad_request", "malformed join code", {"field": "code"})
			return
		lobby = _lobbies.get(code)
		if lobby == null or lobby.game_id != s.game_id:
			_error(s, "unknown_code", "no lobby with that code")
			return
	if password != "" and _str(m, "password") != password:
		_error(s, "bad_password", "wrong password for this lobby")
		return
	if lobby.net_version != s.net_version:
		_error(s, "version_mismatch", "host is on %s, you are on %s" % [lobby.net_version, s.net_version], {"hostNetVersion": lobby.net_version, "yourNetVersion": s.net_version})
		return
	if lobby.kicked.has(s.ip):
		_error(s, "kicked", "you were removed from this lobby")
		return
	if lobby.phase == "in_game" and not lobby.late_join:
		_error(s, "in_game", "the game has already started")
		return
	if lobby.members.size() >= lobby.max_players:
		_error(s, "lobby_full", "lobby is full")
		return
	if _members >= max_peers:
		_error(s, "server_full", "server is at its peer limit")
		return
	if lobby.visibility == "private":
		if lobby.pending.size() >= PENDING_MAX:
			_error(s, "lobby_full", "too many pending requests")
			return
		var pm := OLMember.new()
		pm.peer_id = lobby.next_peer_id
		lobby.next_peer_id += 1
		pm.name = s.name
		pm.session = s
		pm.ip = s.ip
		lobby.pending.append(pm)
		s.pending_in = lobby
		s.pending_member = pm
		var hm := lobby.find(lobby.host_id)
		if hm != null and hm.session != null:
			_send(hm.session, {"t": "join_request", "peer": _peer_obj(pm)})
		return
	_admit(lobby, s, null)


func _admit(lobby: OLLobby, s: OLSession, pending: OLMember) -> void:
	var joiner := _add_member(lobby, s, pending)
	for other in lobby.members:
		if other != joiner:
			_send_to(other, {"t": "peer_joined", "peer": _peer_obj(joiner)})
	# A lobby whose host slot is only reserved (host dropped, nobody was connected) hands over to the first newcomer.
	var hm := lobby.find(lobby.host_id)
	if hm == null or hm.session == null:
		_promote_host(lobby, lobby.host_id)
	_send(s, _lobby_msg(lobby, joiner))


func _add_member(lobby: OLLobby, s: OLSession, reuse: OLMember) -> OLMember:
	var mem := reuse if reuse != null else OLMember.new()
	if reuse == null:
		mem.peer_id = lobby.next_peer_id
		lobby.next_peer_id += 1
	mem.name = s.name
	mem.session = s
	mem.ip = s.ip
	mem.joined_at = int(Time.get_unix_time_from_system() * 1000.0)
	mem.detached_at = 0
	mem.token = _hex(16)
	lobby.members.append(mem)
	_members += 1
	_tokens[mem.token] = [lobby, mem]
	s.lobby = lobby
	s.member = mem
	s.pending_in = null
	s.pending_member = null
	return mem


func _leave(s: OLSession) -> void:
	if s.pending_in != null:
		s.pending_in.pending.erase(s.pending_member)
		s.pending_in = null
		s.pending_member = null
		return
	if s.lobby == null or s.member == null:
		return
	_remove_member(s.lobby, s.member, "left")


# ---------------------------------------------------------------- relay + host-only

func _signal(s: OLSession, m: Dictionary) -> void:
	var lobby := s.lobby
	var me := s.member
	if lobby == null or me == null:
		_error(s, "bad_request", "not in a lobby")
		return
	var to: Variant = _int(m, "to")
	var target: OLMember = lobby.find(to) if to != null else null
	if target == null or target.session == null or target == me:
		_error(s, "bad_request", "unknown signal target", {"field": "to"})
		return
	# a direct hub has no migration: the only peer links are host <-> joiner, so a joiner cannot dial another joiner
	if me.peer_id != lobby.host_id and target.peer_id != lobby.host_id:
		_error(s, "bad_request", "signals go to or from the host only", {"field": "to"})
		return
	var now := _now()
	var rate := _signal_rate(s, target, now)
	if not rate.try_hit(now):
		_rate_limited(s, "signal", rate.retry_after_ms(now))
		return
	if s.signal_total == null:
		s.signal_total = OLRateWindow.new(SIGNAL_PER_SEC * SIGNAL_FANOUT, 1000)
	if not s.signal_total.try_hit(now):
		_rate_limited(s, "signal", s.signal_total.retry_after_ms(now))
		return
	if not _has(m, "sdp") and not _has(m, "ice"):
		_error(s, "bad_request", "signal needs sdp or ice", {"field": "sdp"})
		return
	var o := {"t": "signal", "from": me.peer_id}
	if _has(m, "sdp"):
		o["sdp"] = m["sdp"]
	if _has(m, "ice"):
		o["ice"] = m["ice"]
	_send(target.session, o)


func _signal_rate(s: OLSession, to: OLMember, now: int) -> OLRateWindow:
	var w: OLRateWindow = s.signal_rates.get(to)
	if w == null:
		for k in s.signal_rates.keys():
			if (s.signal_rates[k] as OLRateWindow).is_idle(now):
				s.signal_rates.erase(k)
		var per := NOSTR_SIGNAL_PER_SEC if (to.session != null and to.session.ip.begins_with(NOSTR_ADDR)) else SIGNAL_PER_SEC
		w = OLRateWindow.new(per, 1000)
		s.signal_rates[to] = w
	return w


func _require_host(s: OLSession) -> OLLobby:
	if s.lobby == null or s.member == null:
		_error(s, "bad_request", "not in a lobby")
		return null
	if s.lobby.host_id != s.member.peer_id:
		_error(s, "not_host", "only the host can do that")
		return null
	return s.lobby


func _set_name(s: OLSession, m: Dictionary) -> void:
	if s.lobby == null or s.member == null:
		_error(s, "bad_request", "not in a lobby")
		return
	var raw: Variant = m.get("name")
	var new_name := sanitize(raw, NAME_MAX) if raw is String else ""
	if new_name.is_empty():
		_error(s, "bad_request", "name must be a non-empty string", {"field": "name"})
		return
	if new_name == s.member.name:
		return
	var now := _now()
	if s.member.renames == null:
		s.member.renames = OLRateWindow.new(1, 1000)
	if not s.member.renames.try_hit(now):
		_rate_limited(s, "set_name", s.member.renames.retry_after_ms(now))
		return
	s.member.name = new_name
	s.name = new_name
	_broadcast_lobby(s.lobby)


func _host_meta(s: OLSession, m: Dictionary) -> void:
	var lobby := _require_host(s)
	if lobby == null:
		return
	var meta := _read_meta(m.get("meta"))
	if meta.has("err") or not _has(m, "meta"):
		_error(s, "bad_request", meta["err"] if meta.has("err") else "meta is required", {"field": "meta"})
		return
	lobby.meta = meta["meta"]
	_broadcast_lobby(lobby)


func _host_phase(s: OLSession, m: Dictionary) -> void:
	var lobby := _require_host(s)
	if lobby == null:
		return
	var ph: Variant = _str(m, "phase")
	if ph != "in_game" and ph != "lobby":
		_error(s, "bad_request", "phase must be in_game or lobby", {"field": "phase"})
		return
	lobby.phase = ph
	_broadcast_lobby(lobby)


func _kick(s: OLSession, m: Dictionary) -> void:
	var lobby := _require_host(s)
	if lobby == null:
		return
	var id: Variant = _int(m, "peerId")
	var target: OLMember = lobby.find(id) if id != null else null
	if id == null or id == s.member.peer_id or target == null:
		_error(s, "bad_request", "unknown peerId", {"field": "peerId"})
		return
	var ban: Variant = _bool(m, "ban")
	if _has(m, "ban") and ban == null:
		_error(s, "bad_request", "ban must be a boolean", {"field": "ban"})
		return
	var code: Variant = _int(m, "closeCode")
	if _has(m, "closeCode") and (code == null or not (code == 1000 or (code >= 3000 and code <= 4999))):
		_error(s, "bad_request", "closeCode must be 1000 or 3000-4999", {"field": "closeCode"})
		return
	var close_reason: Variant = _str(m, "closeReason")
	if _has(m, "closeReason") and (close_reason == null or (close_reason as String).length() > 120):
		_error(s, "bad_request", "closeReason must be a string of at most 120 characters", {"field": "closeReason"})
		return
	var data := {}
	if ban == false:
		data["ban"] = false
	if code != null:
		data["closeCode"] = code
	if close_reason != null:
		data["closeReason"] = close_reason
	var removal_code: Variant = _str(m, "code")
	if removal_code != null and OneLobbyRoomRules.is_code(removal_code):
		data["code"] = removal_code # the room layer's stable removal code (spec/room.md 5.2)
	if ban != false:
		lobby.kicked[target.ip] = true
	_remove_member(lobby, target, "disconnected" if ban == false else "kicked", data)


func _approve(s: OLSession, m: Dictionary) -> void:
	var lobby := _require_host(s)
	if lobby == null:
		return
	var id: Variant = _int(m, "peerId")
	var pm: OLMember = null
	for p in lobby.pending:
		if p.peer_id == id:
			pm = p
	var js: OLSession = pm.session if pm != null else null
	if pm == null or js == null:
		_error(s, "bad_request", "no such pending request", {"field": "peerId"})
		return
	if _has(m, "ok") and _bool(m, "ok") == null:
		_error(s, "bad_request", "ok must be a boolean", {"field": "ok"})
		return
	lobby.pending.erase(pm)
	js.pending_in = null
	js.pending_member = null
	if _bool(m, "ok") != true:
		_error(js, "kicked", "the host declined your request", {"reason": "denied"})
		return
	if lobby.members.size() >= lobby.max_players:
		_error(js, "lobby_full", "lobby is full")
		return
	if lobby.phase == "in_game" and not lobby.late_join:
		_error(js, "in_game", "the game has already started")
		return
	_admit(lobby, js, pm)


func _path_report(s: OLSession, m: Dictionary) -> void:
	var p: Variant = _str(m, "path")
	if p != "relayed" and p != "direct":
		_error(s, "bad_request", "path must be relayed or direct", {"field": "path"})


# ---------------------------------------------------------------- membership changes

## Removes a member for good. A member that is already detached was announced as left, so nothing is sent for it.
func _remove_member(lobby: OLLobby, mem: OLMember, reason: String, kick_data: Dictionary = {}) -> void:
	var i := lobby.members.find(mem)
	if i < 0:
		return
	lobby.members.remove_at(i)
	_members -= 1
	_tokens.erase(mem.token)
	var ms := mem.session
	var was_connected := mem.detached_at == 0
	if ms != null:
		ms.lobby = null
		ms.member = null
	if was_connected:
		_broadcast(lobby, {"t": "peer_left", "peerId": mem.peer_id, "reason": reason})
		if (reason == "kicked" or reason == "disconnected") and ms != null:
			_error(ms, "kicked", "the host removed you from the lobby" if reason == "kicked" else "the host disconnected you", kick_data if not kick_data.is_empty() else null)
	if lobby.members.is_empty():
		_close_lobby(lobby)
		return
	if lobby.host_id == mem.peer_id:
		_promote_host(lobby, mem.peer_id)


## The new host is the lowest peerId still connected; epoch +1.
func _promote_host(lobby: OLLobby, leaving_id: int) -> void:
	var next: OLMember = null
	for x in lobby.members:
		if x.session != null and x.peer_id != leaving_id and (next == null or x.peer_id < next.peer_id):
			next = x
	if next == null:
		# Nobody connected. Keep a reserved host slot (it may resume); otherwise fall back to the lowest slot.
		if lobby.find(leaving_id) != null:
			return
		for x in lobby.members:
			if next == null or x.peer_id < next.peer_id:
				next = x
		if next == null:
			return
	lobby.host_id = next.peer_id
	lobby.epoch += 1
	_broadcast(lobby, {"t": "host_changed", "hostId": next.peer_id, "epoch": lobby.epoch})
	if next.session != null:
		for pm in lobby.pending:
			_send(next.session, {"t": "join_request", "peer": _peer_obj(pm)})


func _close_lobby(lobby: OLLobby) -> void:
	_lobbies.erase(lobby.code)
	for pm: OLMember in lobby.pending.duplicate():
		var ps := pm.session
		if ps != null:
			ps.pending_in = null
			ps.pending_member = null
			_error(ps, "unknown_code", "the lobby closed")
	lobby.pending = []


func _new_code() -> String:
	var bytes := Crypto.new().generate_random_bytes(6)
	var c := ""
	for b in bytes:
		c += CROCKFORD[b & 31]
	return c


# ---------------------------------------------------------------- output helpers

func _lobby_msg(l: OLLobby, you: OLMember) -> Dictionary:
	var ms: Array = []
	for x in l.members:
		if x.detached_at == 0:
			ms.append(x)
	ms.sort_custom(func(a: OLMember, b: OLMember) -> bool: return a.peer_id < b.peer_id)
	var peers: Array = []
	for p: OLMember in ms:
		peers.append({"peerId": p.peer_id, "name": p.name, "joinedAt": p.joined_at})
	return {
		"t": "lobby", "code": l.code if issue_codes else "", "gameId": l.game_id, "netVersion": l.net_version, "hostId": l.host_id,
		"you": you.peer_id, "mode": l.mode, "tickRate": l.tick_rate, "lateJoin": l.late_join, "phase": l.phase,
		"meta": l.meta.duplicate(), "peers": peers, "resumeToken": you.token, "name": l.name, "maxPlayers": l.max_players,
		"visibility": l.visibility, "relayOnly": l.relay_only,
	}


func _broadcast_lobby(l: OLLobby) -> void:
	for m in l.members:
		if m.session != null:
			_send_to(m, _lobby_msg(l, m))


func _broadcast(l: OLLobby, o: Dictionary) -> void:
	for m in l.members:
		_send_to(m, o)


func _peer_obj(m: OLMember) -> Dictionary:
	return {"peerId": m.peer_id, "name": m.name}


func _send(s: OLSession, o: Dictionary) -> void:
	if not s.closed:
		s.send.call(JSON.stringify(o))


func _send_to(m: OLMember, o: Dictionary) -> void:
	if m.session != null:
		_send(m.session, o)


func _error(s: OLSession, code: String, msg: String, data: Variant = null) -> void:
	var o := {"t": "error", "code": code, "msg": msg}
	if data != null:
		o["data"] = data
	s.send.call(JSON.stringify(o))


func _rate_limited(s: OLSession, kind: String, retry_after_ms: int) -> void:
	_error(s, "rate_limited", "too many %s requests" % kind, {"retryAfterMs": retry_after_ms})


# ---------------------------------------------------------------- helpers

static func _hex(n: int) -> String:
	return Crypto.new().generate_random_bytes(n).hex_encode()


static func _has(o: Dictionary, k: String) -> bool:
	return o.get(k) != null


static func _str(o: Dictionary, k: String) -> Variant:
	var v: Variant = o.get(k)
	return v if v is String else null


static func _int(o: Dictionary, k: String) -> Variant:
	var v: Variant = o.get(k)
	if v is int:
		return v if absi(v) < 2147483647 else null
	if v is float and v == floorf(v) and absf(v) < 2147483647.0:
		return int(v)
	return null


static func _bool(o: Dictionary, k: String) -> Variant:
	var v: Variant = o.get(k)
	return v if v is bool else null


static func _valid_game_id(g: String) -> bool:
	if g.length() < 1 or g.length() > 64:
		return false
	for ch in g:
		var c := ch.unicode_at(0)
		var ok := (c >= 0x30 and c <= 0x39) or (c >= 0x41 and c <= 0x5A) or (c >= 0x61 and c <= 0x7A) or c == 0x2E or c == 0x5F or c == 0x2D
		if not ok:
			return false
	return true


## Not sanitised (spec/signaling.md): over the limits or non-string values are rejected.
static func _read_meta(node: Variant) -> Dictionary:
	if node == null:
		return {"meta": {}}
	if not node is Dictionary:
		return {"err": "meta must be an object of strings"}
	var d: Dictionary = node
	if d.size() > META_KEYS_MAX:
		return {"err": "meta allows at most %d keys" % META_KEYS_MAX}
	var out := {}
	var keys: Array = d.keys()
	keys.sort()
	for k in keys:
		var v: Variant = d[k]
		if not v is String:
			return {"err": "meta values must be strings"}
		if str(k).length() > META_LEN_MAX or (v as String).length() > META_LEN_MAX:
			return {"err": "meta keys and values are limited to %d chars" % META_LEN_MAX}
		out[str(k)] = v
	return {"meta": out}


static func _normalize_code(input: Variant) -> String:
	if not input is String:
		return ""
	var out := ""
	for ch in (input as String):
		if ch == " " or ch == "-":
			continue
		var c: String = ch.to_upper() if (ch >= "a" and ch <= "z") else ch
		if c == "I" or c == "L":
			c = "1"
		elif c == "O":
			c = "0"
		if CROCKFORD.find(c) < 0 or out.length() >= 6:
			return ""
		out += c
	return out if out.length() == 6 else ""


## Control characters and bidi overrides out, then at most `max_units` UTF-16 units without splitting a character.
static func sanitize(s: Variant, max_units: int, fallback := "") -> String:
	if s == null or s == "":
		return fallback
	var r := ""
	var units := 0
	for ch in (s as String):
		var c := ch.unicode_at(0)
		if c <= 0x1F or (c >= 0x7F and c <= 0x9F) or (c >= 0x202A and c <= 0x202E) or (c >= 0x2066 and c <= 0x2069):
			continue
		var w := 2 if c > 0xFFFF else 1
		if units + w > max_units:
			break
		r += ch
		units += w
	return fallback if r == "" else r
