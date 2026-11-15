class_name OneLobbyChat
extends RefCounted
## Text chat (spec/binary.md "Chat"): sender -> host (validates, stamps) -> everyone, over the reliable channel. Reach it as
## `lobby.chat`; the same wire as the JS `lobby.chat` and C# `lobby.Chat`, so GDScript, JS and C# players can talk in one lobby
## (server lobbies and Direct lobbies, raw and lockstep).
##
##     lobby.chat.message.connect(func(line: Dictionary) -> void: print(line["peer_id"], ": ", line["text"]))
##     lobby.chat.send("gg")
##
## A line is {peer_id, id, ts, text}: `id` and `ts` (Unix ms) are stamped by the host. Limits (the host enforces them):
## 256 UTF-8 bytes per line, a burst of 3 then 5 per 5 s per player; control characters and bidi overrides are stripped.

## A line arrived (your own included: the host echoes every accepted line to everyone). A locally muted peer's lines are dropped.
signal message(line: Dictionary)
## The host refused a line of yours: `id` is what send() returned, reason is "rate", "length" or "muted_by_host".
signal rejected(id: int, reason: String)
## The host's recent lines arrived (joiners, right after the handshake). Fires with the lines, oldest first.
signal history_received(lines: Array)

const MAX_BYTES := 256
const BURST := 3
const WINDOW_MS := 5000
const PER_WINDOW := 5
const HISTORY_LINES := 100
const REJECT_RATE := 1
const REJECT_LENGTH := 2
const REJECT_MUTED := 3

## Set by a blueprint (`chat.text`): false makes send() do nothing but raise the client error "chat_disabled".
var enabled := true
## Game-provided profanity hook, applied to every line a player is shown: `func(text: String) -> String`.
var filter := Callable()

var _l: OneLobbyLobby
var _lines: Array = []
var _buckets := {} # peer id -> [tokens, at_ms]
var _host_muted := {}
var _local_muted := {}
var _local_id := 0
var _stamp_id := 0


func _init(lobby: OneLobbyLobby) -> void:
	_l = lobby


## The last lines (up to 100), oldest first: Dictionaries {peer_id, id, ts, text}.
func history() -> Array:
	return _lines.duplicate()


## Sends a line to the lobby. Returns the local message id (what `rejected` refers to), or 0 when chat is turned off.
func send(text: String) -> int:
	if _l == null:
		return 0
	if not enabled:
		_l._c.raise_error("chat_disabled", "this game has text chat turned off (chat.text is false)")
		return 0
	_local_id = (_local_id + 1) & 0xFFFFFFFF
	var id := _local_id
	if text.to_utf8_buffer().size() > MAX_BYTES * 4:
		# do not even ship absurd payloads; the host would reject on length anyway
		rejected.emit.call_deferred(id, "length")
		return id
	if _l.is_host:
		_host_process(_l.local_peer_id, id, text)
	else:
		_l._send_msg_to_host({"type": "chat", "id": id, "ts": 0, "text": text})
	return id


## Host only: drops a peer's chat for everyone (it gets `rejected` with "muted_by_host").
func host_mute(peer_id: int, muted: bool) -> void:
	if _l == null or not _l._require_host("mute chat"):
		return
	if muted:
		_host_muted[peer_id] = true
	else:
		_host_muted.erase(peer_id)


func is_host_muted(peer_id: int) -> bool:
	return _host_muted.has(peer_id)


## Hides one peer's lines for you only (history included).
func set_local_mute(peer_id: int, muted: bool) -> void:
	if muted:
		_local_muted[peer_id] = true
	else:
		_local_muted.erase(peer_id)


func is_local_muted(peer_id: int) -> bool:
	return _local_muted.has(peer_id)


# ---- internals (called by the lobby) -------------------------------------------------------------------------------

func _detach() -> void:
	_l = null


func _on_peer_left(peer_id: int) -> void:
	_buckets.erase(peer_id)
	_host_muted.erase(peer_id)


## Host: sends the recent lines to a peer whose link just said hi (an empty list when there are none).
func _send_history(peer_id: int) -> void:
	var out: Array = []
	for line: Dictionary in _lines.slice(maxi(0, _lines.size() - HISTORY_LINES)):
		out.append({"peerId": line["peer_id"], "id": line["id"], "ts": line["ts"], "text": line["text"]})
	_l._send_msg(peer_id, {"type": "chat_history", "lines": out})


func _handle(from: int, route: int, m: Dictionary) -> void:
	match str(m["type"]):
		"chat":
			if _l.is_host:
				_host_process(from, int(m["id"]), str(m["text"]))
			else:
				_deliver({"peer_id": route, "id": int(m["id"]), "ts": int(m["ts"]), "text": str(m["text"])})
		"chat_history":
			if not _l.is_host:
				_lines = []
				var items: Array = m["lines"]
				for l: Dictionary in items.slice(maxi(0, items.size() - HISTORY_LINES)):
					_push({"peer_id": int(l["peerId"]), "id": int(l["id"]), "ts": int(l["ts"]), "text": _safe_filter(str(l["text"]))})
				history_received.emit(_lines.duplicate())
		"chat_reject":
			if not _l.is_host:
				rejected.emit(int(m["id"]), reason_name(int(m["reason"])))


static func reason_name(code: int) -> String:
	return "rate" if code == REJECT_RATE else ("length" if code == REJECT_LENGTH else ("muted_by_host" if code == REJECT_MUTED else "unknown"))


## Control characters (C0, DEL, C1) and bidi overrides/isolates are removed at the host.
static func sanitize(text: String) -> String:
	var out := ""
	for i in text.length():
		var c := text.unicode_at(i)
		if c <= 0x1F or (c >= 0x7F and c <= 0x9F) or (c >= 0x202A and c <= 0x202E) or (c >= 0x2066 and c <= 0x2069):
			continue
		out += text[i]
	return out


# ---- host path -----------------------------------------------------------------------------------------------------

func _try_take(peer_id: int, now: int) -> bool:
	var b: Array = _buckets.get(peer_id, [float(BURST), now])
	var refill_ms := float(WINDOW_MS) / PER_WINDOW
	b[0] = minf(BURST, float(b[0]) + float(now - int(b[1])) / refill_ms)
	b[1] = now
	_buckets[peer_id] = b
	if float(b[0]) < 1.0:
		return false
	b[0] = float(b[0]) - 1.0
	return true


func _host_process(from: int, id: int, raw_text: String) -> void:
	var reject := func(code: int) -> void:
		if from == _l.local_peer_id:
			rejected.emit(id, reason_name(code))
		else:
			_l._send_msg(from, {"type": "chat_reject", "id": id, "reason": code})
	# spec order: muted, length (before stripping), rate (a reject spends no token), strip, drop if empty
	if _host_muted.has(from):
		reject.call(REJECT_MUTED)
		return
	if raw_text.to_utf8_buffer().size() > MAX_BYTES:
		reject.call(REJECT_LENGTH)
		return
	if not _try_take(from, _l.now_ms()):
		reject.call(REJECT_RATE)
		return
	var text := sanitize(raw_text)
	if text.length() == 0:
		return
	_stamp_id = (_stamp_id + 1) & 0xFFFFFFFF
	var line := {"peer_id": from, "id": _stamp_id, "ts": int(Time.get_unix_time_from_system() * 1000.0), "text": text}
	var out := {"type": "chat", "id": line["id"], "ts": line["ts"], "text": text}
	for p: int in _l._hello_ids():
		_l._send_msg(p, out, from)
	_deliver(line)


func _deliver(line: Dictionary) -> void:
	var shown := line.duplicate()
	shown["text"] = _safe_filter(str(line["text"]))
	_push(shown)
	if _local_muted.has(int(line["peer_id"])): # a local mute drops the peer's chat, history included
		return
	message.emit(shown)


func _push(line: Dictionary) -> void:
	if _local_muted.has(int(line["peer_id"])):
		return
	_lines.append(line)
	if _lines.size() > HISTORY_LINES:
		_lines = _lines.slice(_lines.size() - HISTORY_LINES)


func _safe_filter(text: String) -> String:
	if filter.is_valid():
		var r: Variant = filter.call(text)
		if r is String:
			return r
	return text
