class_name OneLobbyMenuText
extends RefCounted
## Every player-facing string of the drop-in menu, in one table. Reword or translate it by passing a table of your own keys:
##
##     OneLobbyMenuText.override({"host": "Create game", "join": "Enter game"})   # or the menu's `texts` property
##     OneLobbyMenuText.t("players_header", [2, 4])                              # "Players 2/4"
##
## Sentences about errors, removals and the connection check are not here: they come from OneLobbyFriendly, OneLobbyDiagnose
## and the room layer's removal reasons, so a game that rewords one of those does it at the source. A value may hold `%s` / `%d`
## placeholders; `t()` fills them from `args` in order.
##
## A reworded invite sentence (`invite_sentence`, `invite_sentence_untitled`) must keep the code as its last word or right after
## its "code" marker: the Join box finds the code there when a player pastes the sentence.

const TABLE := {
	# start
	"title": "Multiplayer",
	"name_label": "Your name",
	"name_placeholder": "Player",
	"host": "Host a game",
	"join": "Join",
	"join_label": "Join with a code, an address or an invite link",
	"join_placeholder": "7HQ 4K2",
	"password_label": "Password (only if the lobby has one)",
	"password_placeholder": "Password",
	"browse": "Browse games",
	"settings": "Settings",
	"start_invited": "You're invited! Check your name, then press Join.",
	# connecting
	"connecting_host": "Setting up your game...",
	"connecting_join": "Joining %s...",
	"connecting_join_address": "Connecting to the host...",
	"cancel": "Cancel",
	# lobby
	"code_caption": "Join code",
	"copy_code": "Copy code",
	"copy_invite": "Copy invite",
	"invite_sentence": "Join my game in %s: code %s",
	"invite_sentence_untitled": "Join my game: code %s",
	"copied": "Copied!",
	"copy_failed": "Couldn't copy, select it by hand",
	"players_header": "Players %d/%d",
	"players_header_plain": "Players %d",
	"mark_host": "Host",
	"mark_ready": "Ready",
	"mark_spectator": "Watching",
	"mark_reconnecting": "Reconnecting",
	"ping": "%d ms",
	"you": "(you)",
	"ready": "Ready",
	"not_ready": "Not ready",
	"start": "Start game",
	"start_wait": "Waiting for the host to start the game.",
	"countdown": "Starting in %d...",
	"cancel_countdown": "Cancel start",
	"leave": "Leave",
	"kick": "Kick",
	"ban": "Ban",
	"unban": "Unban",
	"reason_placeholder": "Reason for a kick or ban (optional)",
	"bans_header": "Banned players",
	"ban_row": "%s",
	"ban_row_reason": "%s: %s",
	"ban_unknown": "A banned player",
	"lobby_settings": "Lobby settings",
	"setting_auto_start": "Start by itself",
	"auto_start_off": "No",
	"auto_start_all_ready": "When everyone is ready",
	"auto_start_players": "When enough players are in",
	"setting_min_players": "Players needed to start",
	"setting_countdown": "Countdown (seconds)",
	"setting_late_join": "Players may join after the start",
	"requests_header": "Asking to join",
	"let_in": "Let in",
	"refuse": "Refuse",
	"chat_placeholder": "Say something",
	"chat_send": "Send",
	"chat_line": "%s: %s",
	"plain_list_note": "The host's game is older and has no ready or start buttons. The host starts the game.",
	"host_start_plain": "Start game",
	# error / removed
	"error_title": "Couldn't connect",
	"removed_title": "You were removed",
	"banned_title": "You were banned",
	"ended_title": "The game ended",
	"error_code": "Code: %s",
	"copy_logs": "Copy logs",
	"save_logs": "Save logs",
	"logs_copied": "Logs copied (addresses are hidden).",
	"logs_saved": "Logs saved to %s (addresses are hidden).",
	"logs_not_saved": "Couldn't save the logs.",
	"back": "Back",
	"bad_code": "That doesn't look like a lobby code.",
	"bad_code_hint": "Paste the code the host shows, an address like 192.168.1.20:47810, or an invite link.",
	"host_left": "The host left, so the game ended.",
	"host_left_hint": "Go back and host or join another game.",
	# settings
	"settings_title": "Settings",
	"relay_label": "Relay line (only needed on strict networks)",
	"relay_placeholder": "Paste a relay line",
	"relay_none": "No relay is set.",
	"relay_set": "Relay in use: %s",
	"relay_invalid": "The saved relay line is not valid, so it is not used.",
	"relay_bad_input": "That relay line is not valid, so it was not saved.",
	"relay_saved": "Relay saved.",
	"relay_cleared": "Relay cleared.",
	"relay_save": "Save relay",
	"relay_clear": "Clear relay",
	"server_label": "Lobby server",
	"server_placeholder": "wss://lobby.example.org/ws",
	"server_save": "Save server",
	"server_saved": "Lobby server saved.",
	"server_bad_input": "That doesn't look like a lobby server address.",
	"check": "Check my connection",
	"check_running": "Checking...",
	"check_udp": "UDP: %s",
	"check_nat": "Network type: %s",
	"check_relay": "Relay: %s",
	"udp_ok": "gets out",
	"udp_blocked": "blocked",
	"udp_unknown": "unknown",
	"nat_open": "open",
	"nat_cone": "normal (cone)",
	"nat_symmetric": "strict (symmetric)",
	"nat_unknown": "unknown",
	"nat_blocked": "unknown",
	"relay_ok": "login accepted",
	"relay_refused": "login refused",
	"relay_unreachable": "did not answer",
	"relay_unknown": "unknown",
	"relay_none_fact": "none set",
	# browse
	"browse_title": "Games to join",
	"browse_title_online": "Online games",
	"browse_title_lan": "LAN games",
	"browse_tab_online": "Online",
	"browse_tab_lan": "LAN games",
	"browse_loading": "Looking for games...",
	"browse_empty": "No games found right now.",
	"browse_row": "%s (%s) %d/%d",
	"browse_refresh": "Refresh",
	"browse_join": "Join",
	"lan_looking": "Looking for games on your network...",
	"lan_empty": "No games found on your network. The host can also read out their address: type it in the join box on the start screen.",
	"lan_socket_failed": "Couldn't look for games on your network. Ask the host for their address and type it in the join box.",
	"lan_off": "LAN games are switched off in this game.",
	"lan_row": "%s (%s) %d/%d",
	"lan_locked": "Needs a password",
}

## The table in use: TABLE plus what override() added.
static var _extra := {}


## The string for `key` (the key itself when there is none, so a typo shows up on screen), `%` placeholders filled from `args`.
static func t(key: String, args: Array = []) -> String:
	var s: String = str(_extra.get(key, TABLE.get(key, key)))
	return s % args if not args.is_empty() else s


## Replaces some strings (keys as in TABLE). Call it before the menu is shown; override({}) puts the defaults back.
static func override(values: Dictionary) -> void:
	_extra = values.duplicate()
