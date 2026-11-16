class_name OneLobbyTransport
extends RefCounted
## The seam between the lobby logic and the network (like ITransport in the C# client). OneLobbyGodotTransport is the
## real one; tests drive the lobby through their own subclass. Everything is polled: OneLobbyClient calls poll() once
## per frame, then reads sockets and links.


## Milliseconds on a monotonic clock.
func now_ms() -> int:
	return Time.get_ticks_msec()


## Opens a signaling WebSocket to `url`.
func connect_signaling(_url: String) -> OLSocket:
	return null


## A WebRTC link to one peer. `opts`: remote_id, initiator (bool), ice_servers (Array of {urls, username?,
## credential?}), relay_only (bool).
func create_link(_opts: Dictionary) -> OLLink:
	return null


func poll() -> void:
	pass


## A signaling socket: text messages only.
class OLSocket:
	extends RefCounted
	const CONNECTING := 0
	const OPEN := 1
	const CLOSED := 2
	var state := CONNECTING
	var close_reason := ""

	## Sockets that need their own polling (the Direct-mode ones) do it here; OneLobbyClient calls it every pump.
	func poll() -> void:
		pass

	func send_text(_text: String) -> void:
		pass

	## The text messages that arrived since the last call.
	func receive() -> Array[String]:
		return []

	## Bytes sent but not yet on the wire (or not yet acknowledged, for a Nostr socket).
	func buffered() -> int:
		return 0

	func close() -> void:
		state = CLOSED


## A peer link: three negotiated data channels (reliable 0, fast 1, voice 2) over one WebRTC connection.
class OLLink:
	extends RefCounted
	var is_open := false
	var is_failed := false
	## True when the link runs through a TURN relay.
	var relayed := false
	## The remote end's IP address once the transport knows it, else "" (the room layer's ban check polls it; Godot's
	## WebRTC does not expose the selected candidate pair, so the stock link leaves it empty).
	var remote_address := ""

	## The initiator creates its offer (the answerer waits for apply_signal).
	func start_offer() -> void:
		pass

	## Applies a remote description {type, sdp} or ICE candidate {candidate, sdpMid, sdpMLineIndex}.
	func apply_signal(_sig: Dictionary) -> void:
		pass

	## Local descriptions and candidates to send to the remote peer through signaling.
	func take_signals() -> Array[Dictionary]:
		return []

	func send(_channel: int, _bytes: PackedByteArray) -> void:
		pass

	## Frames that arrived since the last call, each [channel, bytes].
	func receive() -> Array:
		return []

	## Bytes queued on the reliable channel and not yet sent.
	func buffered() -> int:
		return 0

	func close() -> void:
		is_open = false
