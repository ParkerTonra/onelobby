class_name OneLobbyTurn
extends RefCounted
## TURN logins in the coturn shared-secret scheme (spec/vectors/turn-rest.json, the same one onelobby-server uses):
## username = "<expiry unix seconds>:<user_id>", credential = base64(HMAC-SHA1(secret, username)). For a TURN server
## that hands out logins this way, mint one per session instead of storing a fixed password:
##
##     var login := OneLobbyTurn.login(secret, "p1", 6 * 3600)
##     var turn := {"urls": ["turn:turn.example.com:3478"], "username": login.username, "credential": login.credential}
##     var lobby := await client.host_direct({"ice_servers": [turn]})
##
## The secret ships inside your game, so anyone with the build can mint logins: use a server whose secret you may
## share, or one with a spend cap. Godot's WebRTC reaches TURN over UDP only: list turn: URLs without ?transport=tcp.


## {username, credential} valid for `ttl_seconds` from `now_seconds` (0 = the system clock).
static func login(secret: String, user_id: String, ttl_seconds: int, now_seconds: int = 0) -> Dictionary:
	var now := now_seconds if now_seconds > 0 else int(Time.get_unix_time_from_system())
	var username := "%d:%s" % [now + ttl_seconds, user_id.replace(":", "")]
	return {"username": username, "credential": credential(secret, username)}


## base64(HMAC-SHA1(secret, username)), both as UTF-8.
static func credential(secret: String, username: String) -> String:
	var h := HMACContext.new()
	h.start(HashingContext.HASH_SHA1, secret.to_utf8_buffer())
	h.update(username.to_utf8_buffer())
	return Marshalls.raw_to_base64(h.finish())


## Turn what a player pastes into a "my TURN relay" settings field into one `ice_servers` entry. Format: the URL, the
## username, the credential, split on any whitespace (`turn:relay.example.com:3478 alice s3cret`), or a JSON object
## {"urls": ..., "username": ..., "credential": ...}. turn:/turns: need both username and credential; stun:/stuns: need
## none. Vectors: spec/vectors/turn-paste.json. Returns {ok, server, error, warnings}: on ok, `server` is the entry
## ({urls: [..], username?, credential?}); otherwise `error` is a message fit to show the player. `warnings` is non-empty
## when the entry will not work in Godot (libjuice does UDP TURN only: `turns:` and `?transport=tcp` are skipped); the
## entry is still returned, so a warning never fails the paste.
##
##     var r := OneLobbyTurn.parse_line(settings.turn_relay)   # never commit what the player typed
##     if r.ok: ice.append(r.server)
static func parse_line(text: String) -> Dictionary:
	var t := text.strip_edges()
	if t.is_empty():
		return _paste_error("Paste a relay as: turn:host:3478 username credential")
	var urls: Array = []
	var username := ""
	var credential := ""
	if t.begins_with("{"):
		var j := JSON.new()
		var o: Variant = j.data if j.parse(t) == OK else null
		if not o is Dictionary:
			return _paste_error("That is not valid JSON. Paste a relay as: turn:host:3478 username credential")
		var u: Variant = o.get("urls")
		if u is String:
			urls = [u]
		elif u is Array:
			for x: Variant in u:
				urls.append(str(x))
		if urls.is_empty():
			return _paste_error("The JSON needs \"urls\" (a turn: or stun: URL, or a list of them).")
		var un: Variant = o.get("username")
		var cr: Variant = o.get("credential")
		username = un if un is String else ""
		credential = cr if cr is String else ""
	else:
		var parts := _split_ws(t)
		if parts.size() > 3:
			return _paste_error("Too many parts. Use: URL username credential (the credential cannot contain spaces).")
		urls = [parts[0]]
		username = parts[1] if parts.size() > 1 else ""
		credential = parts[2] if parts.size() > 2 else ""
	var has_turn := false
	var warnings: Array = []
	var rx := RegEx.create_from_string("^(?i)(stuns?|turns?):[^\\s?]+(\\?\\S*)?$")
	for u: String in urls:
		if rx.search(u) == null:
			return _paste_error("\"%s\" is not a stun:, stuns:, turn: or turns: URL (for example turn:relay.example.com:3478)." % u)
		var low := u.to_lower()
		if low.begins_with("turn"):
			has_turn = true
			if low.begins_with("turns:") or low.contains("transport=tcp"):
				warnings.append("%s needs TCP or TLS, and Godot reaches TURN over UDP only, so this entry will be skipped. Use turn:host:3478 without ?transport=tcp." % u)
	if has_turn and (username.is_empty() or credential.is_empty()):
		return _paste_error("A turn: relay needs a username and a credential after the URL: turn:host:3478 username credential")
	var server := {"urls": urls}
	if not username.is_empty():
		server["username"] = username
	if not credential.is_empty():
		server["credential"] = credential
	return {"ok": true, "server": server, "error": "", "warnings": warnings}


static func _paste_error(msg: String) -> Dictionary:
	return {"ok": false, "server": {}, "error": msg, "warnings": []}


static func _split_ws(t: String) -> Array:
	var out: Array = []
	for p in RegEx.create_from_string("\\s+").sub(t, " ", true).split(" ", false):
		out.append(p)
	return out
