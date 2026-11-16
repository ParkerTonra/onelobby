extends SceneTree
## LAN discovery (spec/lan-discovery.md): the shared vectors, the host's limits, then host and finder over real UDP sockets that
## all bind 127.0.0.1 and ask 127.0.0.1 only (nothing is broadcast, nothing leaves this machine). Also the switch-off proofs and
## the taken-port case.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/lan.gd
## Prints "lan: N passed, M failed"; exits 1 on any failure.

var _pass := 0
var _fail := 0
var _v: Dictionary = {}


func _init() -> void:
	process_frame.connect(func() -> void:
		if Time.get_ticks_msec() > 60000:
			print("lan FAIL: timed out")
			quit(1))
	_run.call_deferred()


func _check(ok: bool, what: String) -> void:
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL: ", what)


func _load(path: String) -> Dictionary:
	var spec := ProjectSettings.globalize_path("res://").path_join("../../spec").simplify_path()
	var d: Variant = JSON.parse_string(FileAccess.get_file_as_string(spec.path_join(path)))
	return d if d is Dictionary else {}


func _hex(s: String) -> PackedByteArray:
	return s.hex_decode()


func _info(players := 1, password := false, lobby := "Sam's game", host := "Sam", port := 47810) -> Dictionary:
	return {"lobby_name": lobby, "host_name": host, "players": players, "max_players": 4, "password": password, "port": port}


## A UDP port nobody holds right now (127.0.0.1 only).
func _free_udp_port() -> int:
	var u := PacketPeerUDP.new()
	u.bind(0, "127.0.0.1")
	var p := u.get_local_port()
	u.close()
	return p


func _q(n: int, game_id := "g") -> PackedByteArray:
	return OneLobbyLan.encode_question(PackedByteArray([n, 0, 0, 0, 0, 0, 0, 0]), game_id)


func _wait_until(cond: Callable, finder: OneLobbyLanFinder, ms := 6000) -> bool:
	var t0 := Time.get_ticks_msec()
	while not cond.call():
		if Time.get_ticks_msec() - t0 > ms:
			return false
		if finder != null:
			finder.poll()
		await process_frame
	return true


func _run() -> void:
	_v = _load("vectors/lan-discovery.json")
	_check(not _v.is_empty(), "vectors load")
	_check(int(_v["constants"]["defaultPort"]) == OneLobbyLan.DEFAULT_PORT, "default port matches the vectors")
	_vectors()
	_limits()
	await _sockets()
	await _switch()
	await _loopback()
	print("lan: %d passed, %d failed" % [_pass, _fail])
	quit(1 if _fail > 0 else 0)


func _vectors() -> void:
	for q: Dictionary in _v["questions"]:
		_check(OneLobbyLan.encode_question(_hex(q["nonce"]), q["gameId"]).hex_encode() == q["hex"], "encode question " + q["name"])
		var d := OneLobbyLan.decode_question(_hex(q["hex"]))
		_check(not d.is_empty() and (d["nonce"] as PackedByteArray).hex_encode() == q["nonce"] and d["game_id"] == q["gameId"], "decode question " + q["name"])
	for a: Dictionary in _v["answers"]:
		var f: Dictionary = a["fields"]
		var enc := OneLobbyLan.encode_answer({"nonce": _hex(f["nonce"]), "port": int(f["port"]), "players": int(f["players"]), "max_players": int(f["maxPlayers"]),
			"password": f["password"], "game_id": f["gameId"], "net_version": f["netVersion"], "lobby_name": f["lobbyName"], "host_name": f["hostName"]})
		_check(enc.hex_encode() == a["hex"], "encode answer " + a["name"])
		var d := OneLobbyLan.decode_answer(_hex(a["hex"]))
		_check(not d.is_empty() and (d["nonce"] as PackedByteArray).hex_encode() == f["nonce"] and int(d["port"]) == int(f["port"])
			and int(d["players"]) == int(f["players"]) and int(d["max_players"]) == int(f["maxPlayers"]) and d["password"] == f["password"]
			and d["game_id"] == f["gameId"] and d["net_version"] == f["netVersion"] and d["lobby_name"] == f["lobbyName"] and d["host_name"] == f["hostName"],
			"decode answer " + a["name"])
		_check(_hex(a["hex"]).size() <= OneLobbyLan.MAX_DATAGRAM, "answer fits " + a["name"])
	for d: Dictionary in _v["dropQuestions"]:
		_check(OneLobbyLan.decode_question(_hex(d["hex"])).is_empty(), "drop question " + d["name"])
	for d: Dictionary in _v["dropAnswers"]:
		_check(OneLobbyLan.decode_answer(_hex(d["hex"])).is_empty(), "drop answer " + d["name"])
	for s: Dictionary in _v["sourceClasses"]:
		var want := "" if s["class"] == null else str(s["class"])
		_check(OneLobbyLan.source_class(s["ip"]) == want, "source class " + str(s["ip"]))
	for r: Dictionary in _v["hostRules"]:
		var sent := []
		var a := OneLobbyLanAnswerer.new(r["ownGameId"], "3", func() -> Dictionary: return _info(), func(b: PackedByteArray, _ad: String, _p: int) -> void: sent.append(b))
		var got := a.handle(_hex(r["question"]), r["source"], 50000)
		_check(got == r["expect"], "host rule %s: %s" % [r["name"], got])
		_check(sent.size() == (1 if r["expect"] == "answer" else 0), "host rule sends " + r["name"])
	for r: Dictionary in _v["finderRules"]:
		var f := OneLobbyLanFinder.new(r["ownGameId"], r["ownNetVersion"])
		for n: String in r["sentNonces"]:
			f.remember_nonce(n)
		var got := f.receive(_hex(r["answer"]), r["source"], 47840)
		_check(got == r["expect"], "finder rule %s: %s" % [r["name"], got])
		var kept: bool = r["expect"] == "ok" or r["expect"] == "other_version"
		_check(f.games.size() == (1 if kept else 0), "finder rule keeps " + r["name"])
		if r["expect"] == "other_version":
			_check(not f.games[0]["same_version"], "other version marked")
		f.free()


func _limits() -> void:
	var t := [1000]
	var now := func() -> int: return t[0]
	var sent := []
	var a := OneLobbyLanAnswerer.new("g", "1", func() -> Dictionary: return _info(), func(b: PackedByteArray, _ad: String, _p: int) -> void: sent.append(b), now)
	for i in 200:
		a.handle(_q(i), "192.168.1.9", 5000)
	_check(sent.size() == OneLobbyLan.RATE_PER_SOURCE, "a flood from one source gets at most %d answers (got %d)" % [OneLobbyLan.RATE_PER_SOURCE, sent.size()])
	_check(int(a.stats["rate_limited"]) == 200 - OneLobbyLan.RATE_PER_SOURCE, "the rest are counted")
	t[0] += 1000
	a.handle(_q(250), "192.168.1.9", 5000)
	_check(sent.size() == OneLobbyLan.RATE_PER_SOURCE + 1, "the next window answers again")

	var sent2 := []
	var a2 := OneLobbyLanAnswerer.new("g", "1", func() -> Dictionary: return _info(), func(b: PackedByteArray, _ad: String, _p: int) -> void: sent2.append(b), func() -> int: return 5)
	for i in 200:
		a2.handle(_q(1), "10.0.%d.%d" % [i >> 8, i & 255], 5000)
	_check(sent2.size() == OneLobbyLan.RATE_TOTAL, "a flood from many sources gets at most %d answers (got %d)" % [OneLobbyLan.RATE_TOTAL, sent2.size()])

	var sent3 := []
	var a3 := OneLobbyLanAnswerer.new("g", "1", func() -> Dictionary: return _info(), func(b: PackedByteArray, _ad: String, _p: int) -> void: sent3.append(b))
	_check(a3.handle(_q(7), "192.168.1.9", 5000) == "answer" and a3.handle(_q(7), "192.168.1.9", 5000) == "duplicate" and sent3.size() == 1, "the same question is answered once")

	var sent4 := []
	var a4 := OneLobbyLanAnswerer.new("g", "1", func() -> Dictionary: return _info(1, false, "x".repeat(500), "\U0001F41C".repeat(300)), func(b: PackedByteArray, _ad: String, _p: int) -> void: sent4.append(b))
	a4.handle(_q(1), "127.0.0.1", 5000)
	var big := PackedByteArray()
	big.resize(4000)
	a4.handle(big, "127.0.0.1", 5000)
	_check(sent4.size() == 1 and sent4[0].size() <= OneLobbyLan.MAX_DATAGRAM, "an answer never exceeds 512 bytes whatever the question's size")
	_check(str(OneLobbyLan.decode_answer(sent4[0])["lobby_name"]).length() <= 24, "names are cut to 24 units")
	var a5 := OneLobbyLanAnswerer.new("g", "1", func() -> Dictionary: return {}, func(_b: PackedByteArray, _ad: String, _p: int) -> void: _check(false, "sent without a lobby"))
	_check(a5.handle(_q(1), "127.0.0.1", 5000) == "no_lobby", "nothing is answered before a lobby is open")


func _pair(port: int, info: Callable, host_game := "g", host_version := "1", finder_game := "g", finder_version := "1") -> Array:
	var host := OneLobbyLanHost.new(host_game, host_version, info, {"port": port, "bind_address": "127.0.0.1"})
	var ok := host.start()
	_check(ok, "host socket opens on 127.0.0.1:%d" % port)
	var finder := OneLobbyLanFinder.new(finder_game, finder_version, {"targets": PackedStringArray(["127.0.0.1"]), "port": port,
		"ask_interval_ms": 100, "min_gap_ms": 40, "row_timeout_ms": 500})
	root.add_child(finder)
	return [host, finder]


func _sockets() -> void:
	# row appears with the right fields, changes with the lobby, disappears when the host closes
	var port := _free_udp_port()
	var info := [_info(1, true, "Ants!", "Sam", 47812)]
	var pair := _pair(port, func() -> Dictionary: return info[0])
	var host: OneLobbyLanHost = pair[0]
	var finder: OneLobbyLanFinder = pair[1]
	var counts := []
	finder.changed.connect(func(g: Array) -> void: counts.append(g.size()))
	_check(finder.start() == "running", "finder starts")
	var step := func() -> void:
		host.poll()
	var got := await _wait_until(func() -> bool:
		host.poll()
		return finder.games.size() == 1, finder)
	_check(got, "the row appears")
	if got:
		var r: Dictionary = finder.games[0]
		_check(r["address"] == "127.0.0.1" and r["port"] == 47812 and r["name"] == "Ants!" and r["host_name"] == "Sam" and r["players"] == 1
			and r["max_players"] == 4 and r["has_password"] == true and r["same_version"] == true, "row fields: " + JSON.stringify(r))
	info[0] = _info(2, true, "Ants!", "Sam", 47812)
	_check(await _wait_until(func() -> bool:
		host.poll()
		return finder.games.size() == 1 and int(finder.games[0]["players"]) == 2, finder), "the row follows the player count")
	host.close()
	_check(await _wait_until(func() -> bool: return finder.games.is_empty(), finder), "the row goes after the host closed")
	_check(counts.size() > 0 and counts[counts.size() - 1] == 0, "changed fired with the empty list")
	step.call()

	# stop() closes the socket and empties the list; a late answer reaches nothing
	var port2 := _free_udp_port()
	var pair2 := _pair(port2, func() -> Dictionary: return _info())
	var host2: OneLobbyLanHost = pair2[0]
	var finder2: OneLobbyLanFinder = pair2[1]
	finder2.start()
	_check(await _wait_until(func() -> bool:
		host2.poll()
		return finder2.games.size() == 1, finder2), "second finder sees the host")
	var finder_port := finder2.local_port
	_check(finder_port > 0, "the finder knows its own port")
	var changed_after := []
	finder2.stop()
	finder2.changed.connect(func(_g: Array) -> void: changed_after.append(1))
	_check(finder2.games.is_empty() and finder2.status == "idle", "stop() empties the list")
	var probe := PacketPeerUDP.new()
	_check(probe.bind(finder_port, "127.0.0.1") == OK, "the finder's port is free again: its socket is closed")
	probe.close()
	# a late answer, sent to the old port by something else, is delivered to nothing
	var late := PacketPeerUDP.new()
	late.set_dest_address("127.0.0.1", finder_port)
	late.put_packet(OneLobbyLan.encode_answer({"nonce": PackedByteArray([1, 2, 3, 4, 5, 6, 7, 8]), "port": 47810, "players": 1, "max_players": 4, "password": false,
		"game_id": "g", "net_version": "1", "lobby_name": "x", "host_name": "y"}))
	late.close()
	for _i in 10:
		finder2.poll()
		await process_frame
	_check(finder2.games.is_empty() and changed_after.is_empty(), "a late answer after stop() changes nothing")
	host2.close()

	# another netVersion is kept and marked
	var port3 := _free_udp_port()
	var pair3 := _pair(port3, func() -> Dictionary: return _info(), "g", "2", "g", "1")
	var host3: OneLobbyLanHost = pair3[0]
	var finder3: OneLobbyLanFinder = pair3[1]
	finder3.start()
	_check(await _wait_until(func() -> bool:
		host3.poll()
		return finder3.games.size() == 1, finder3), "other-version row appears")
	if not finder3.games.is_empty():
		_check(finder3.games[0]["same_version"] == false and finder3.games[0]["net_version"] == "2", "other version is marked")
	finder3.stop()
	host3.close()

	# a question for another game id gets no answer
	var port4 := _free_udp_port()
	var pair4 := _pair(port4, func() -> Dictionary: return _info(), "g", "1", "other", "1")
	var host4: OneLobbyLanHost = pair4[0]
	var finder4: OneLobbyLanFinder = pair4[1]
	finder4.start()
	_check(await _wait_until(func() -> bool:
		host4.poll()
		return int(host4.answerer.stats["wrong_game"]) >= 1, finder4), "the host saw the other game's question")
	_check(int(host4.answerer.stats["answered"]) == 0 and finder4.games.is_empty(), "no answer for another game id")
	finder4.stop()
	host4.close()

	# ask_now never faster than the minimum gap
	var port5 := _free_udp_port()
	var host5 := OneLobbyLanHost.new("g", "1", func() -> Dictionary: return _info(), {"port": port5, "bind_address": "127.0.0.1"})
	host5.start()
	var f5 := OneLobbyLanFinder.new("g", "1", {"targets": PackedStringArray(["127.0.0.1"]), "port": port5, "ask_interval_ms": 60000, "min_gap_ms": 200})
	root.add_child(f5)
	f5.start()
	for _i in 10:
		f5.ask_now()
	for _i in 6:
		host5.poll()
		await process_frame
	var seen := int(host5.answerer.stats["answered"]) + int(host5.answerer.stats["duplicate"])
	_check(seen == 1, "ten ask_now calls right after start send one question (host saw %d)" % seen)
	await create_timer(0.3).timeout
	f5.poll()
	await process_frame
	host5.poll()
	seen = int(host5.answerer.stats["answered"]) + int(host5.answerer.stats["duplicate"])
	_check(seen == 2, "the held ask goes out after the gap (host saw %d)" % seen)
	f5.stop()
	host5.close()

	# the taken-port case: the second host goes on without LAN discovery and says why
	var port6 := _free_udp_port()
	var logs := []
	var h6a := OneLobbyLanHost.new("g", "1", func() -> Dictionary: return _info(), {"port": port6, "bind_address": "127.0.0.1"})
	_check(h6a.start(), "first host takes the port")
	var h6b := OneLobbyLanHost.new("g", "1", func() -> Dictionary: return _info(), {"port": port6, "bind_address": "127.0.0.1", "log": func(l: String) -> void: logs.append(l)})
	var second := h6b.start()
	print("taken-port start() = ", second, " log = ", logs)
	_check(not second and not h6b.listening, "the second host cannot open the port")
	_check(logs.size() == 1 and str(logs[0]).begins_with("LAN discovery is off for this lobby: UDP port %d" % port6), "and logs one line saying so")
	h6a.close()
	h6b.close()
	for n in [finder, finder2, finder3, finder4, f5]:
		n.queue_free()


func _switch() -> void:
	# a finder that is not enabled opens no socket
	var f := OneLobbyLanFinder.new("g", "1", {"enabled": false, "targets": PackedStringArray(["127.0.0.1"])})
	root.add_child(f)
	_check(f.start() == "off" and f.local_port == 0 and not f.is_running(), "enabled=false: start() is off and opens nothing")
	f.ask_now()
	f.free()

	# a direct host with lan off opens no LAN socket: no object, and the port stays free
	var lan_port := _free_udp_port()
	var c := OneLobbyClient.new()
	c.game_id = "lan-switch"
	c.display_name = "Sam"
	root.add_child(c)
	var l: OneLobbyLobby = await c.host_direct({"nostr": false, "tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1", "lan_port": lan_port, "max_players": 4})
	_check(l != null, "host_direct without lan works: %s" % JSON.stringify(c.last_error))
	if l == null:
		return
	_check(c._direct_host.lan == null, "lan off: no LAN host object")
	var probe := PacketPeerUDP.new()
	_check(probe.bind(lan_port, "127.0.0.1") == OK, "lan off: the LAN port is free (nothing listens)")
	probe.close()
	l.leave()
	await process_frame
	c.queue_free()

	# lan on: one socket, a finder from the client sees the lobby, and it goes when the lobby leaves
	var c2 := OneLobbyClient.new()
	c2.game_id = "lan-switch"
	c2.display_name = "Sam"
	root.add_child(c2)
	var l2: OneLobbyLobby = await c2.host_direct({"nostr": false, "tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1", "lan": true, "lan_port": lan_port,
		"max_players": 3, "password": "pw", "name": "Ants!"})
	_check(l2 != null, "host_direct with lan works: %s" % JSON.stringify(c2.last_error))
	if l2 == null:
		return
	_check(c2._direct_host.lan != null and c2._direct_host.lan.listening, "lan on: the answering socket listens")
	var probe2 := PacketPeerUDP.new()
	_check(probe2.bind(lan_port, "127.0.0.1") != OK, "lan on: the LAN port is taken by the host")
	probe2.close()
	var fin := c2.lan_finder({"targets": PackedStringArray(["127.0.0.1"]), "port": lan_port, "ask_interval_ms": 100, "min_gap_ms": 40, "row_timeout_ms": 500})
	_check(fin.start() == "running", "client finder starts")
	var got := await _wait_until(func() -> bool: return fin.games.size() == 1, null)
	_check(got, "the client's finder lists the lobby")
	if got:
		var r: Dictionary = fin.games[0]
		_check(r["name"] == "Ants!" and r["host_name"] == "Sam" and r["players"] == 1 and r["max_players"] == 3 and r["has_password"] == true
			and r["address"] == "127.0.0.1" and int(r["port"]) == c2._direct_host.ip.port and r["same_version"] == true, "row fields from host_direct: " + JSON.stringify(r))
	l2.leave()
	_check(await _wait_until(func() -> bool: return fin.games.is_empty(), null), "the row goes when the lobby leaves")
	var probe3 := PacketPeerUDP.new()
	_check(probe3.bind(lan_port, "127.0.0.1") == OK, "after the lobby left the LAN port is free again")
	probe3.close()
	fin.stop()
	c2.queue_free()

	# blueprint: hosting.lan false keeps the client's finder off; true turns it on
	var c3 := OneLobbyClient.from_config({"game": {"id": "lan-bp"}, "engine": "godot-gdscript"}, {"display_name": "Sam"})
	root.add_child(c3)
	var f3 := c3.lan_finder({"targets": PackedStringArray(["127.0.0.1"])})
	_check(f3.start() == "off" and f3.local_port == 0, "blueprint hosting.lan false: the finder stays off and opens nothing")
	c3.queue_free()
	var c4 := OneLobbyClient.from_config({"game": {"id": "lan-bp"}, "engine": "godot-gdscript", "hosting": {"lan": true}}, {"display_name": "Sam"})
	root.add_child(c4)
	var f4 := c4.lan_finder({"targets": PackedStringArray(["127.0.0.1"])})
	_check(f4.start() == "running" and f4.local_port > 0, "blueprint hosting.lan true: the finder runs")
	f4.stop()
	c4.queue_free()


## Any loopback bind_address keeps the answering socket on 127.0.0.1; a real address opens it on every network card.
func _loopback() -> void:
	for a in ["127.0.0.1", "127.0.0.2", "127.255.0.1", "localhost", "LOCALHOST", "::1", "[::1]", "::ffff:127.0.0.1"]:
		_check(OneLobbyLanHost.is_loopback(a), "'%s' is a loopback address" % a)
		var h := OneLobbyLanHost.new("g", "1", func() -> Dictionary: return {}, {"bind_address": a})
		_check(h.bind_host() == "127.0.0.1", "bind_address '%s' binds 127.0.0.1" % a)
	for a in ["", "*", "0.0.0.0", "192.168.1.20", "128.0.0.1", "1127.0.0.1", "127.0.0", "example.com"]:
		_check(not OneLobbyLanHost.is_loopback(a), "'%s' is not a loopback address" % a)
		var h2 := OneLobbyLanHost.new("g", "1", func() -> Dictionary: return {}, {"bind_address": a})
		_check(h2.bind_host() == "0.0.0.0", "bind_address '%s' binds every card" % a)
	# and for real, on a loopback name: the socket opens and a finder on 127.0.0.1 gets its answer
	var port := _free_udp_port()
	var host := OneLobbyLanHost.new("g", "1", func() -> Dictionary: return _info(), {"port": port, "bind_address": "127.0.0.2"})
	_check(host.start() and host.listening, "a host with bind_address 127.0.0.2 opens its socket")
	var finder := OneLobbyLanFinder.new("g", "1", {"targets": PackedStringArray(["127.0.0.1"]), "port": port, "ask_interval_ms": 100, "min_gap_ms": 40})
	root.add_child(finder)
	finder.start()
	_check(await _wait_until(func() -> bool:
		host.poll()
		return finder.games.size() == 1, finder), "and a finder on 127.0.0.1 finds it")
	finder.stop()
	finder.queue_free()
	host.close()
