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
