extends SceneTree
## webrtc-native applies a UDP port range only from the nested "libdatachannel" config dictionary (a top-level
## portRangeBegin/End is ignored). Checks the local candidates' ports through OneLobbyGodotTransport, and that a link
## beyond the range's size fails with fail_reason "port_range_full". No network traffic leaves the machine.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/port_range.gd

func _init() -> void:
	var t := OneLobbyGodotTransport.new()
	var ports := {}
	var links := []
	for i in 3:
		var l: OneLobbyGodotTransport.OLRtcLink = t.create_link({"initiator": true, "ice_servers": [{"urls": []}], "port_range": [47950, 47952]})
		l.start_offer()
		links.append(l)
	var fails := 0
	var until := Time.get_ticks_msec() + 2000
	while Time.get_ticks_msec() < until:
		t.poll()
		OS.delay_msec(10)
	for l: OneLobbyGodotTransport.OLRtcLink in links:
		for s in l.take_signals():
			if s.has("candidate"):
				ports[int(str(s["candidate"]).split(" ")[5])] = true
	print("candidate ports ", ports.keys())
	for p: int in ports:
		if p < 47950 or p > 47952:
			fails += 1
			print("FAIL: port outside the range ", p)
	if ports.size() != 3:
		fails += 1
		print("FAIL: expected 3 distinct ports")
	var extra: OneLobbyGodotTransport.OLRtcLink = t.create_link({"initiator": true, "ice_servers": [{"urls": []}], "port_range": [47950, 47952]})
	if not extra.is_failed or extra.fail_reason != "port_range_full":
		fails += 1
		print("FAIL: a 4th link should fail with port_range_full")
	for l: OneLobbyGodotTransport.OLRtcLink in links:
		l.close()
	print("port range ", "ok" if fails == 0 else "FAILED")
	quit(0 if fails == 0 else 1)
