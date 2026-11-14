extends SceneTree
## Regression: a peer leaves, and the game sends before the next poll has noticed. Real WebRTC, two links in one
## process. Passes when this prints "send closed: passed" and no engine error names isClosed (direct-test.sh checks).

const Transport := preload("res://addons/onelobby/godot_transport.gd")


func _initialize() -> void:
	var why := _run()
	print("send closed: passed" if why == "" else "send closed: FAILED: " + why)
	quit(0 if why == "" else 1)


func _run() -> String:
	var a := Transport.OLRtcLink.new({"initiator": true})
	var b := Transport.OLRtcLink.new({})
	a.start_offer()
	if not _pump(a, b, func() -> bool: return a.is_open and b.is_open):
		return "links never opened"
	b.close()
	# No a.poll() from here on: a.is_open stays true, as it does for a game that sends between two polls.
	var deadline := Time.get_ticks_msec() + 5000
	while a._ch[0].get_ready_state() == WebRTCDataChannel.STATE_OPEN and Time.get_ticks_msec() < deadline:
		a._pc.poll()
		OS.delay_msec(10)
	if a._ch[0].get_ready_state() == WebRTCDataChannel.STATE_OPEN:
		return "channel never closed"
	if not a.is_open:
		return "is_open fell, so this no longer tests the gap between polls"
	for id in 3:
		a.send(id, PackedByteArray([1, 2, 3]))
	if a.is_open:
		return "is_open still true after a send found the channel closed"
	a.close()
	return ""


func _pump(a: OneLobbyTransport.OLLink, b: OneLobbyTransport.OLLink, done: Callable) -> bool:
	var deadline := Time.get_ticks_msec() + 10000
	while Time.get_ticks_msec() < deadline:
		a.poll()
		b.poll()
		for sig in a.take_signals():
			b.apply_signal(sig)
		for sig in b.take_signals():
			a.apply_signal(sig)
		if done.call():
			return true
		OS.delay_msec(10)
	return false

