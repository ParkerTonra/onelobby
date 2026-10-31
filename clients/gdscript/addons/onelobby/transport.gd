class_name OneLobbyTransport
extends RefCounted
## The seam between the lobby logic and the network (like ITransport in the C# client). OneLobbyGodotTransport is the
## real one; tests drive the lobby through their own subclass. Everything is polled: OneLobbyClient calls poll() once
## per frame, then reads sockets and links.


## Milliseconds on a monotonic clock.
func now_ms() -> int:
	return Time.get_ticks_msec()


## Opens a signaling WebSocket to `url`.
func connect_signaling(_url: String) -> Socket:
	return null


## A WebRTC link to one peer. `opts`: remote_id, initiator (bool), ice_servers (Array of {urls, username?,
## credential?}), relay_only (bool).
func create_link(_opts: Dictionary) -> Link:
	return null


func poll() -> void:
	pass


## A signaling socket: text messages only.
class Socket:
	extends RefCounted
	const CONNECTING := 0
	const OPEN := 1
	const CLOSED := 2
	var state := CONNECTING
	var close_reason := ""

	func send_text(_text: String) -> void:
		pass

	## The text messages that arrived since the last call.
	func receive() -> Array[String]:
		return []

	func close() -> void:
		state = CLOSED


## A peer link: three negotiated data channels (reliable 0, fast 1, voice 2) over one WebRTC connection.
class Link:
	extends RefCounted
	var is_open := false
	var is_failed := false
	## True when the link runs through a TURN relay.
	var relayed := false

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
