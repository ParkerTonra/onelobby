class_name OneLobbyFriendly
extends RefCounted
## Plain-language error text for players: the JS client's `describeError`, word for word (spec/vectors/describe-error.json
## is the shared test). Nothing here touches the network.
##
##     var d := OneLobbyFriendly.describe_error(client.last_error)   # {code, message, hint?}
##     label.text = d["message"] + (" " + d["hint"] if d.has("hint") else "")

## code -> [message, hint] ("" = no hint). Same table as clients/js/packages/client/src/friendly.ts.
const TEXT := {
	"unknown_code": ["We couldn't find a lobby with that code.", "Check the code with the host. Codes stop working once everyone leaves."],
	"bad_code": ["That doesn't look like a lobby code.", "Codes are 6 letters and numbers, like 7HQ 4K2."],
	"lobby_full": ["That lobby is full.", "Ask the host to make room, or start your own lobby."],
	"version_mismatch": ["You and the host are running different versions of the game.", "Reload the page (or update the game) on both sides, then try again."],
	"in_game": ["That game has already started.", "Ask the host to let people join mid-game, or wait for the next round."],
	"kicked": ["The host removed you from the lobby.", ""],
	"denied": ["The host didn't let you in this time.", "Ask the host to approve you, then try again."],
	"bad_password": ["That password isn't right.", "Check it with the host, then try again."],
	"not_host": ["Only the host can do that.", ""],
	"rate_limited": ["Slow down a little: too many tries in a short time.", "Wait a moment, then try again."],
	"max_lobbies": ["You already have the most lobbies open that this server allows.", "Close one of your other lobbies, then try again."],
	"server_full": ["The game server is full right now.", "Try again in a few minutes."],
	"game_not_allowed": ["This game server doesn't host this game.", "The game's server setting may be wrong; let the game's owner know."],
	"bad_request": ["The game sent something the server didn't understand.", "Reload the page and try again. If it keeps happening, the game may need an update."],
	"connect_failed": ["Couldn't reach the game server.", "Check your internet connection, then try again."],
	"server_closed": ["Lost the connection to the game server.", "Check your internet connection, then try again."],
	"bad_address": ["That doesn't look like a join code or an address.", "Paste the code the host shows, or an address like 192.168.1.20:47810."],
	"port_in_use": ["Couldn't open a port to host this game.", "Close other copies of the game, or pick another port, then try again."],
	"unknown_version": ["That code is from a newer version of the game.", "Update the game, then try again."],
	"unsupported_code": ["That code is from a newer version of the game.", "Update the game, then try again."],
	"no_relay": ["Couldn't reach any of the servers that set up direct games.", "Check your internet connection, then try again."],
	"busy": ["Still working on your last request.", "Wait a moment, then try again."],
	"in_lobby": ["You are already in a lobby.", "Leave it first, then try again."],
	"closed": ["Lost the connection to the game server.", "Check your internet connection, then try again."],
	"server_lost": ["Lost the connection to the game server.", "Your game may keep going; new players can't join until it's back."],
	"invalid_token": ["Your old seat in that lobby is no longer available.", "Join again with the lobby code."],
	"ice_failed": ["Couldn't connect to the other players.", "Some networks (school, work, public Wi-Fi) block game connections. Try another network or a phone hotspot, or ask the host to port-forward."],
	"no_server": ["This game has no lobby server address yet.", "Enter one in the multiplayer settings, or host from your own computer with a join code."],
	"timeout": ["The connection took too long.", "Check your internet connection, then try again."],
	"unsupported": ["The host's game is too old for that.", "Ask the host to update the game."],
	"voice_disabled": ["Voice chat is turned off in this game.", ""],
	"chat_disabled": ["Text chat is turned off in this game.", ""],
	"pause_disabled": ["Pausing is turned off in this game.", ""],
	"not_in_game": ["You can only pause while a game is running.", "Start the game first."],
	"not_allowed": ["You can't do that right now.", "The player who paused, or the host, can resume."],
	"listing_disabled": ["This game has no public lobby list.", "Join with a code or a link from the host."],
	"direct_unreachable": ["Couldn't reach the host.", "Check the code, and that the host is still online. A host in a browser needs its tab open and visible."],
	"nostr_disabled": ["This game can't be hosted from a browser.", "Host from the desktop version, or let the game's owner know."],
	"identity_anonymous": ["This game doesn't use player names.", "Everyone shows up as Player 1, Player 2, and so on."],
	"bad_config": ["The game's multiplayer settings file is not valid.", "Let the game's owner know; the details are in the error message."],
	"left": ["You left the lobby.", ""],
	"unknown": ["Something went wrong.", "Try again. If it keeps happening, reload the page."],
}

static var _code_re: RegEx = null
static var _prefix_re: RegEx = null
static var _bare_re: RegEx = null
static var _network_re: RegEx = null
static var _timeout_re: RegEx = null


## Player-facing text for any error the client (or its server) can produce: {code, message} plus `hint` when there is
## something to do. `err` is what `client.last_error` and the `error` signal give ({code, message}), a bare code or a
## "code: text" String, or a Dictionary with optional `code`, `data` ({reason, retryAfterMs} from the server), `message`
## and `name` ("NetworkError" / "TimeoutError" for a failed or timed-out request). Never returns a technical message:
## unknown errors get the generic line with code "unknown" (or the unfamiliar code itself).
static func describe_error(err: Variant) -> Dictionary:
	_init_regex()
	var code := ""
	var data := {}
	if typeof(err) == TYPE_STRING or typeof(err) == TYPE_STRING_NAME:
		var m := _bare_re.search(str(err).strip_edges())
		if m != null:
			code = m.get_string(1)
	elif err is Dictionary:
		var o: Dictionary = err
		var d: Variant = o.get("data")
		var has_data: bool = d is Dictionary
		var oc: Variant = o.get("code")
		var msg: Variant = o.get("message")
		var nm: Variant = o.get("name")
		if (typeof(oc) == TYPE_STRING or typeof(oc) == TYPE_STRING_NAME) and _code_re.search(str(oc)) != null:
			code = str(oc)
			data = d if has_data else {}
		elif typeof(msg) == TYPE_STRING:
			var m := _prefix_re.search(msg)
			if m != null and TEXT.has(m.get_string(1)):
				code = m.get_string(1)
				data = d if has_data else {}
			elif str(nm) == "NetworkError" or _network_re.search(msg) != null:
				code = "connect_failed"
			elif str(nm) == "TimeoutError" or _timeout_re.search(msg) != null:
				code = "timeout"
	if code.is_empty():
		return _entry("unknown", "unknown", {})
	var key := code
	if code == "kicked" and str(data.get("reason", "")) == "denied":
		key = "denied"
	if code == "rate_limited" and str(data.get("reason", "")) == "max_lobbies":
		key = "max_lobbies"
	if not TEXT.has(key):
		return _entry(code, "unknown", {})
	var out := _entry(code, key, data)
	if key == "rate_limited" and (typeof(data.get("retryAfterMs")) == TYPE_INT or typeof(data.get("retryAfterMs")) == TYPE_FLOAT):
		var s := maxi(1, ceili(float(data["retryAfterMs"]) / 1000.0))
		out["hint"] = "Wait %d second%s, then try again." % [s, "" if s == 1 else "s"]
	return out


static func _entry(code: String, key: String, _data: Dictionary) -> Dictionary:
	var t: Array = TEXT[key]
	var out := {"code": code, "message": t[0]}
	if not str(t[1]).is_empty():
		out["hint"] = t[1]
	return out


static func _init_regex() -> void:
	if _code_re != null:
		return
	_code_re = RegEx.create_from_string("^[a-z][a-z0-9_]*\\z")
	_prefix_re = RegEx.create_from_string("^([a-z][a-z0-9_]*):")
	_bare_re = RegEx.create_from_string("^([a-z][a-z0-9_]*)(?::|\\z)")
	_network_re = RegEx.create_from_string("(?i)network|failed to fetch|websocket")
	_timeout_re = RegEx.create_from_string("(?i)timed? ?out")
