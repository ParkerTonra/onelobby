class_name OneLobbyNostrPool
extends RefCounted
## Nostr events and the relay pool (spec/nostr-signaling.md s.3 and s.6). Anonymous: every connection uses a throw-away
## key and carries encrypted frames only. Every relay is dialled at once with a WebSocketPeer and reconnected with
## backoff (1 s doubling to 30 s); the owner calls poll() every frame.

const KIND := 25050
const SEEN_MAX := 4096
const SINCE_SLACK_S := 30

## Default public relays (probed 2026-10-26, docs/design/no-server-fallback.md): all accept and echo ephemeral kind 25050.
const DEFAULT_RELAYS: Array[String] = [
	"wss://nos.lol",
	"wss://relay.primal.net",
	"wss://nostr-pub.wellorder.net",
	"wss://nostr.oxtr.dev",
	"wss://nostr.bitcoiner.social",
	"wss://relay.nostr.net",
	"wss://nostr.sathoarder.com",
]

## Public STUN servers for Nostr joiners (spec s.5).
const DEFAULT_STUN: Array[String] = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"]

class OLRelay:
	var url := ""
	var ws: WebSocketPeer = null
	var open := false
	## The first connect to this relay has succeeded or failed (a dead relay is known to be dead).
	var attempted := false
	var skipped := false
	var backoff := OneLobbyNostrLimits.BACKOFF_START_MS
	var retry_at := 0

var _relays: Array[OLRelay] = []
var _topic := ""
var _on_event: Callable   # (ev: Dictionary)
var _on_change: Callable  # ()
var _seen := {}
var _sub := ""
var _closed := false


func _init(urls: Array, topic: String, on_event: Callable, on_change: Callable = Callable()) -> void:
	_topic = topic
	_on_event = on_event
	_on_change = on_change
	_sub = "ol" + Crypto.new().generate_random_bytes(4).hex_encode()
	for u in urls:
		var r := OLRelay.new()
		r.url = str(u)
		_relays.append(r)


func total() -> int:
	return _relays.size()


## Relays connected right now (and not skipped).
func connected() -> int:
	var n := 0
	for r in _relays:
		if r.open and not r.skipped:
			n += 1
	return n


## Every relay has either connected, failed a connect, or been skipped: waiting longer for the rest is pointless.
func settled() -> bool:
	for r in _relays:
		if not (r.attempted or r.skipped):
			return false
	return true


func start() -> void:
	for r in _relays:
		_dial(r)


func publish(ev: Dictionary) -> void:
	var msg := JSON.stringify(["EVENT", ev])
	for r in _relays:
		if r.open and not r.skipped and r.ws != null:
			r.ws.send_text(msg)
			r.ws.poll()


func close() -> void:
	if _closed:
		return
	_closed = true
	# give frames just published a moment to reach the socket (a final `close` frame)
	for _i in 40:
		var pending := false
		for r in _relays:
			if r.ws != null and r.open:
				r.ws.poll()
				if r.ws.get_current_outbound_buffered_amount() > 0:
					pending = true
		if not pending:
			break
		OS.delay_msec(5)
	for r in _relays:
		if r.ws != null:
			r.ws.close(1000)
		r.ws = null
		r.open = false
	_changed()


func poll() -> void:
	if _closed:
		return
	var now := Time.get_ticks_msec()
	for r in _relays:
		if r.skipped:
			continue
		if r.ws == null:
			if r.retry_at > 0 and now >= r.retry_at:
				r.retry_at = 0
				_dial(r)
			continue
		r.ws.poll()
		match r.ws.get_ready_state():
			WebSocketPeer.STATE_OPEN:
				if not r.open:
					r.open = true
					r.attempted = true
					r.backoff = OneLobbyNostrLimits.BACKOFF_START_MS
					var since := int(Time.get_unix_time_from_system()) - SINCE_SLACK_S
					r.ws.send_text(JSON.stringify(["REQ", _sub, {"kinds": [KIND], "#t": [_topic], "since": since}]))
					_changed()
				while r.ws != null and r.ws.get_available_packet_count() > 0:
					var pkt := r.ws.get_packet()
					if r.ws.was_string_packet():
						_on_message(r, pkt.get_string_from_utf8())
					if _closed:
						return
			WebSocketPeer.STATE_CLOSED:
				var was_open := r.open
				r.ws = null
				r.open = false
				r.attempted = true
				_retry_later(r)
				if was_open:
					_changed()


func _changed() -> void:
	if _on_change.is_valid():
		_on_change.call()


func _dial(r: OLRelay) -> void:
	if _closed or r.skipped:
		return
	var ws := WebSocketPeer.new()
	ws.inbound_buffer_size = 1 << 20
	ws.outbound_buffer_size = 1 << 20
	ws.max_queued_packets = 4096
	var err := ws.connect_to_url(r.url)
	if err != OK:
		r.attempted = true
		_retry_later(r)
		return
	r.ws = ws


func _retry_later(r: OLRelay) -> void:
	if _closed or r.skipped or r.retry_at > 0:
		return
	r.retry_at = Time.get_ticks_msec() + r.backoff
	r.backoff = mini(OneLobbyNostrLimits.BACKOFF_MAX_MS, r.backoff * 2)


func _skip(r: OLRelay) -> void:
	if r.skipped:
		return
	r.skipped = true
	r.retry_at = 0
	if r.ws != null:
		r.ws.close(1000)
	r.ws = null
	r.open = false
	_changed()


func _on_message(r: OLRelay, text: String) -> void:
	var m: Variant = JSON.parse_string(text)
	if not m is Array or (m as Array).is_empty():
		return
	var a: Array = m
	match str(a[0]):
		"EVENT":
			if a.size() < 3 or not a[2] is Dictionary:
				return
			var ev: Dictionary = a[2]
			if not (ev.get("id") is String and ev.get("pubkey") is String and ev.get("content") is String and ev.get("created_at") is float):
				return
			if int(ev.get("kind", 0)) != KIND or not ev.get("tags") is Array:
				return
			var has_topic := false
			for t in ev["tags"]:
				if t is Array and t.size() >= 2 and t[0] == "t" and t[1] == _topic:
					has_topic = true
			if not has_topic or _seen.has(ev["id"]):
				return
			_seen[ev["id"]] = true
			if _seen.size() > SEEN_MAX:
				_seen.erase(_seen.keys()[0])
			_on_event.call(ev)
		"OK":
			# refused (not a plain duplicate): this relay does not take our events, skip it for the session
			if a.size() >= 3 and a[2] is bool and a[2] == false and not (a.size() > 3 and str(a[3]).begins_with("duplicate")):
				_skip(r)
		"CLOSED":
			_skip(r)


# ---------------------------------------------------------------- events

## NIP-01 event id: SHA-256 of [0, pubkey, created_at, kind, tags, content] serialised without whitespace. Every field
## is plain ASCII with nothing to escape (hex, digits, base64), so the string is built by hand.
static func event_id(pubkey: String, created_at: int, kind: int, topic: String, content: String) -> String:
	var s := '[0,"%s",%d,%d,[["t","%s"]],"%s"]' % [pubkey, created_at, kind, topic, content]
	return OneLobbySecp256k1.sha256(s.to_utf8_buffer()).hex_encode()


## A signed kind-25050 event (BIP340 Schnorr over the id).
static func make_event(kp: OneLobbySecp256k1.OLKeypair, topic: String, content: String, created_at: int) -> Dictionary:
	var pubkey := kp.pubkey_hex()
	var id := event_id(pubkey, created_at, KIND, topic, content)
	var sig := OneLobbySecp256k1.sign_random(id.hex_decode(), kp)
	return {"id": id, "pubkey": pubkey, "created_at": created_at, "kind": KIND, "tags": [["t", topic]], "content": content, "sig": sig.hex_encode()}
