class_name OneLobbySignaling
extends RefCounted
## JSON signaling messages (spec/signaling.md, spec/signaling.schema.json): builders and tolerant field readers.

const PROTO := "lk1"
const LIB := "onelobby-gdscript"
const VERSION := "0.1.0"


static func hello(game_id: String, net_version: String, display_name: String, resume_token: String = "", player_id: String = "") -> String:
	var m := {
		"t": "hello", "proto": PROTO, "gameId": game_id, "netVersion": net_version,
		"client": {"lib": LIB, "ver": VERSION, "platform": "godot-" + OS.get_name().to_lower()},
		"name": display_name,
	}
	if resume_token != "":
		m["resumeToken"] = resume_token
	if player_id != "":
		m["playerId"] = player_id
	return JSON.stringify(m)


## `o`: name, max_players (4), visibility ("unlisted"), late_join (true), meta ({}), relay_only (false). `password` and
## `spectators` (a hub with the "room" feature, spec/room.md 7) are sent when given.
static func create(o: Dictionary, mode: String, tick_rate: int, password: String = "", spectators: int = 0) -> String:
	var m := {
		"t": "create", "name": str(o.get("name", "Lobby")), "maxPlayers": int(o.get("max_players", 4)),
		"visibility": str(o.get("visibility", "unlisted")), "mode": mode, "tickRate": tick_rate,
		"lateJoin": bool(o.get("late_join", true)), "meta": _meta(o.get("meta", {})),
	}
	if bool(o.get("relay_only", false)):
		m["relayOnly"] = true
	if password != "":
		m["password"] = password
	if spectators > 0:
		m["spectators"] = spectators
	return JSON.stringify(m)


static func join(code: String, password: String = "") -> String:
	var m := {"t": "join", "code": code}
	if password != "":
		m["password"] = password
	return JSON.stringify(m)


## Direct mode: a host runs exactly one lobby, so the join carries no code (the Nostr code was the invitation).
static func join_direct(password: String) -> String:
	var m := {"t": "join"}
	if password != "":
		m["password"] = password
	return JSON.stringify(m)


static func list(meta_filter: Dictionary) -> String:
	var m := {"t": "list", "visibility": "public", "limit": 100}
	if not meta_filter.is_empty():
		m["meta"] = _meta(meta_filter)
	return JSON.stringify(m)


static func simple(t: String) -> String:
	return JSON.stringify({"t": t})


static func phase(in_game: bool) -> String:
	return JSON.stringify({"t": "phase", "phase": "in_game" if in_game else "lobby"})


static func rename_msg(new_name: String) -> String:
	return JSON.stringify({"t": "set_name", "name": new_name})


static func meta(m: Dictionary) -> String:
	return JSON.stringify({"t": "meta", "meta": _meta(m)})


static func kick(peer_id: int, ban: bool = true, close_code: int = 0, close_reason: String = "", code: String = "") -> String:
	var m := {"t": "kick", "peerId": peer_id}
	if not ban:
		m["ban"] = false
	if close_code != 0:
		m["closeCode"] = close_code
	if close_reason != "":
		m["closeReason"] = close_reason
	if code != "":
		m["code"] = code
	return JSON.stringify(m)


## Host: the banned player ids (a hub with the "room" feature; replaces the lobby's set).
static func bans(ids: Array) -> String:
	return JSON.stringify({"t": "bans", "ids": ids})


static func approve(peer_id: int, ok: bool) -> String:
	return JSON.stringify({"t": "approve", "peerId": peer_id, "ok": ok})


static func ping(n: int) -> String:
	return JSON.stringify({"t": "ping", "n": n})


static func pong(n: int) -> String:
	return JSON.stringify({"t": "pong", "n": n})


static func path(relayed: bool) -> String:
	return JSON.stringify({"t": "path", "path": "relayed" if relayed else "direct"})


static func host_changed(host_id: int, epoch: int) -> String:
	return JSON.stringify({"t": "host_changed", "hostId": host_id, "epoch": epoch})


## `sig`: {type, sdp} for a description or {candidate, sdpMid, sdpMLineIndex} for one ICE candidate.
static func signal_to(to: int, sig: Dictionary) -> String:
	var m := {"t": "signal", "to": to}
	if sig.has("sdp"):
		m["sdp"] = {"type": sig["type"], "sdp": sig["sdp"]}
	else:
		m["ice"] = {"candidate": sig["candidate"], "sdpMid": sig["sdpMid"], "sdpMLineIndex": int(sig["sdpMLineIndex"])}
	return JSON.stringify(m)


static func _meta(m: Variant) -> Dictionary:
	var out := {}
	if m is Dictionary:
		for k: Variant in m:
			out[str(k)] = str(m[k])
	return out


# ---- readers -----------------------------------------------------------------------------------------------------

static func s(e: Variant, key: String, dflt: String = "") -> String:
	return e[key] if e is Dictionary and e.get(key) is String else dflt


static func i(e: Variant, key: String, dflt: int = 0) -> int:
	return int(e[key]) if e is Dictionary and (e.get(key) is float or e.get(key) is int) else dflt


static func b(e: Variant, key: String, dflt: bool = false) -> bool:
	return e[key] if e is Dictionary and e.get(key) is bool else dflt


static func meta_of(e: Variant) -> Dictionary:
	var out := {}
	var m: Variant = e.get("meta") if e is Dictionary else null
	if m is Dictionary:
		for k: Variant in m:
			out[str(k)] = m[k] if m[k] is String else JSON.stringify(m[k])
	return out


## The `ice` list of a welcome as Godot's WebRTCPeerConnection wants it: [{urls: [..], username?, credential?}].
static func ice_of(welcome: Dictionary) -> Array:
	var out: Array = []
	var list: Variant = welcome.get("ice")
	if not list is Array:
		return out
	for e: Variant in list:
		if not e is Dictionary:
			continue
		var urls: Array = []
		var u: Variant = e.get("urls")
		if u is Array:
			for x: Variant in u:
				urls.append(str(x))
		elif u is String:
			urls.append(u)
		var d := {"urls": urls}
		if s(e, "username") != "":
			d["username"] = s(e, "username")
		if s(e, "credential") != "":
			d["credential"] = s(e, "credential")
		out.append(d)
	return out


## A `signal` message's payload in the shape signal_to takes, or {} when it has neither sdp nor ice.
static func signal_of(e: Dictionary) -> Dictionary:
	var sdp: Variant = e.get("sdp")
	if sdp is Dictionary:
		return {"type": s(sdp, "type"), "sdp": s(sdp, "sdp")}
	var ice: Variant = e.get("ice")
	if ice is Dictionary:
		return {"candidate": s(ice, "candidate"), "sdpMid": s(ice, "sdpMid"), "sdpMLineIndex": i(ice, "sdpMLineIndex")}
	return {}


## A lobby list row (schema lobbyEntry) with snake_case keys.
static func summary_of(e: Dictionary) -> Dictionary:
	return {
		"code": s(e, "code"), "name": s(e, "name"), "host_name": s(e, "hostName"), "players": i(e, "players"),
		"max_players": i(e, "maxPlayers"), "phase": s(e, "phase", "lobby"), "meta": meta_of(e), "region": s(e, "region"),
		"created_at": e.get("createdAt", 0),
	}
