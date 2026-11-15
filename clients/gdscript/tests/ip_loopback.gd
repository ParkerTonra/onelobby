extends SceneTree
## Join by IP, all on 127.0.0.1 (no Nostr, no internet, nothing listens beyond this machine): one process, a host with a
## 3-port UDP range and joiners that use its v0 code or the typed "ip:port" address. Then more joiners, and checks the range
## error when more peers than ports come. Also unit checks for v0 codes. Exit 0 and "ip loopback ok" on success.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/ip_loopback.gd

var _fails := 0

func _check(ok: bool, what: String) -> void:
	if not ok:
		_fails += 1
		print("FAIL: ", what)

func _init() -> void:
	process_frame.connect(func() -> void:
		if Time.get_ticks_msec() > 60000:
			print("ip loopback FAIL: timed out")
			quit(1))
	_run.call_deferred()


func _mk(name: String) -> OneLobbyClient:
	var c := OneLobbyClient.new()
	c.game_id = "ip-loopback"
	c.display_name = name
	root.add_child(c)
	return c


func _run() -> void:
	# ---- unit: v0 codes and addresses
	var code := OneLobbyJoinCode.encode_ip("127.0.0.1", 47810)
	_check(code != "", "encode_ip")
	var dec := OneLobbyJoinCode.decode_dc1(code)
	_check(dec.get("ip", "") == "127.0.0.1" and dec.get("port", 0) == 47810, "v0 round trip")
	_check(OneLobbyJoinCode.parse_address("10.0.0.5:5000") == {"ip": "10.0.0.5", "port": 5000}, "parse_address with port")
	_check(OneLobbyJoinCode.parse_address("10.0.0.5").get("port", 0) == 47810, "parse_address default port")
	_check(OneLobbyJoinCode.parse_address("nonsense").has("error"), "parse_address rejects")
	_check(OneLobbyLobby.ice_failed_message(false, true).contains("port-forward its UDP port range"), "by-ip message names the next step")
	_check(OneLobbyLobby.port_range_full_message([47900, 47901]).contains("47900-47901"), "range message")

	var at := OneLobbyGodotTransport.OLRtcLink.is_at_address
	_check(at.call("candidate:1 1 UDP 2122317823 127.0.0.1 47940 typ host", "127.0.0.1"), "a candidate already at the code's address is not added twice")
	_check(not at.call("candidate:1 1 UDP 2122317823 10.0.0.5 47940 typ host", "127.0.0.1"), "a candidate at another address still gets the code's address added")
	_check(not at.call("candidate:1 1 UDP 2122317823 127.0.0.1 47940 typ relay raddr 1.2.3.4 rport 5", "127.0.0.1"), "only host candidates count")

	# ---- loopback: host with range, join by v0 code
	var host := _mk("host")
	var lobby_h: OneLobbyLobby = await host.host_direct({"nostr": false, "tcp_port": 0, "listen_address": "127.0.0.1",
		"public_ip": "127.0.0.1", "udp_port_range": [47940, 47942], "max_players": 8})
	if lobby_h == null:
		print("ip loopback FAIL: host ", host.last_error)
		quit(1)
		return
	_check(lobby_h.ip_code != "" and lobby_h.code == lobby_h.ip_code, "host shows its ip code")
	print("host ip code ", lobby_h.ip_code, " ", OneLobbyJoinCode.decode_dc1(lobby_h.ip_code))
	# joiner 1 types the plain address a player would ("127.0.0.1:<tcp port>"), the others use the v0 code
	var typed := "127.0.0.1:%d" % int(OneLobbyJoinCode.decode_dc1(lobby_h.ip_code).get("port", 0))
	var joiners := []
	for i in 3:
		var j := _mk("join%d" % i)
		var lj: OneLobbyLobby = await j.join_direct(typed if i == 1 else lobby_h.ip_code, {"timeout_ms": 15000})
		if lj == null:
			print("ip loopback FAIL: joiner %d: %s" % [i, j.last_error])
			quit(1)
			return
		joiners.append([j, lj])
	# the first two get a link (range holds 3 ports; the host's own links count one each)
	var ok_links := 0
	for step in 400:
		await process_frame
		ok_links = 0
		for p in lobby_h.peers():
			if int(p["peer_id"]) != lobby_h.local_peer_id and lobby_h.is_peer_ready(int(p["peer_id"])):
				ok_links += 1
		if ok_links >= 3:
			break
	print("ready links ", ok_links, " host error ", host.last_error)
	_check(ok_links == 3, "three joiners over a 3-port range all link")
	# a 4th joiner finds the range used up
	var j4 := _mk("join3")
	var errs := []
	host.error.connect(func(c: String, m: String) -> void: errs.append([c, m]))
	var l4: OneLobbyLobby = await j4.join_direct(lobby_h.ip_code, {"timeout_ms": 15000})
	for step in 120:
		await process_frame
	_check(l4 != null, "4th joiner reaches signaling")
	var saw := false
	for e in errs:
		if e[0] == "ice_failed" and str(e[1]).contains("47940-47942"):
			saw = true
	_check(saw, "host reports the range used up: " + str(errs))

	for pair in joiners:
		pair[1].leave()
	lobby_h.leave()
	await process_frame
	print("ip loopback ", "ok" if _fails == 0 else "FAILED (%d)" % _fails)
	quit(0 if _fails == 0 else 1)
