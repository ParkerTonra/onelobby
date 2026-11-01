class_name OneLobbyNostrRoom
extends RefCounted
## One side's connection to a Nostr room: a fresh session key pair, the relay pool, and encrypted frames in and out
## (spec/nostr-signaling.md s.2-4). OneLobbyNostrSocket (joiner) and OneLobbyNostrHost (host) sit on top.

const MAX_AGE_S := 120

## Hex of this side's session public key.
var pub := ""
## Called with each valid frame addressed to nobody in particular or to us (`to` empty or our pubkey).
var on_frame: Callable
var _kp: OneLobbySecp256k1.Keypair
var _key := PackedByteArray()
var _topic := ""
var _pool: OneLobbyNostrPool
var _closed := false


## Derives the keys and starts connecting. `code` is a version 1 join code in any display form; null when it is not one.
static func open(code: String, relays: Array = [], on_change: Callable = Callable()) -> OneLobbyNostrRoom:
	var norm := OneLobbyJoinCode.normalize_dc1(code)
	if norm == "":
		return null
	var room := OneLobbyNostrRoom.new()
	var keys := OneLobbyNostrCrypto.derive(norm)
	room._key = keys["key"]
	room._topic = keys["topic"]
	room._kp = OneLobbySecp256k1.random_keypair()
	room.pub = room._kp.pubkey_hex()
	room._pool = OneLobbyNostrPool.new(relays if not relays.is_empty() else OneLobbyNostrPool.DEFAULT_RELAYS, room._topic, room._on_event, on_change)
	room._pool.start()
	return room


func relays_connected() -> int:
	return _pool.connected()


func relays_total() -> int:
	return _pool.total()


## Every relay has connected, failed or been skipped.
func relays_settled() -> bool:
	return _pool.settled()


func poll() -> void:
	if not _closed:
		_pool.poll()


## Stamps, encrypts, signs and publishes a frame (an OneLobbyNostrLink out frame) to every relay.
func send(to: String, f: Dictionary) -> void:
	if _closed:
		return
	var frame := {"v": 1, "type": f["type"], "from": pub, "to": to, "seq": f["seq"], "ack": f["ack"]}
	if f.has("msgs"):
		frame["msgs"] = f["msgs"]
	if f.get("reason", "") != "":
		frame["reason"] = f["reason"]
	var content := OneLobbyNostrCrypto.seal_content(_key, JSON.stringify(frame))
	_pool.publish(OneLobbyNostrPool.make_event(_kp, _topic, content, int(Time.get_unix_time_from_system())))


func close() -> void:
	if _closed:
		return
	_closed = true
	on_frame = Callable()
	_pool.close()


func _on_event(ev: Dictionary) -> void:
	if _closed or ev["pubkey"] == pub:
		return
	if Time.get_unix_time_from_system() - float(ev["created_at"]) > MAX_AGE_S:
		return
	var text: Variant = OneLobbyNostrCrypto.open_content(_key, ev["content"])
	if text == null or _closed:
		return
	var parsed: Variant = JSON.parse_string(text)
	if not parsed is Dictionary:
		return
	var f: Dictionary = parsed
	if int(f.get("v", 0)) != 1 or f.get("from") != ev["pubkey"] or f.get("from") == pub:
		return
	var type := str(f.get("type", ""))
	if type != "open" and type != "data" and type != "beat" and type != "close":
		return
	var to: Variant = f.get("to")
	if not to is String or (to != "" and to != pub):
		return
	if on_frame.is_valid():
		on_frame.call(f)
