extends SceneTree
## Text chat, shared pause and lockstep (lobby.chat, lobby.pause, lobby.lockstep) between real GDScript peers, all on
## 127.0.0.1 (a Direct host by IP, no Nostr, no internet), through OneLobbyClient.from_config. Also the gridpaint goldens
## (spec/vectors/gridpaint.json) against the GDScript sim. Cross-client checks (JS and C# peers) are in tools/engine-smoke.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/sync.gd
## Prints "sync: N passed, M failed"; exits 1 on any failure.

const Gridpaint := preload("res://tests/gridpaint.gd")
const CODE := "7HQ4K2"

var _pass := 0
var _fail := 0
var _players: Array = []


## One player: its client, lobby and gridpaint game; pump() applies the frames the lobby holds.
class Player:
	var client: OneLobbyClient
	var lobby: OneLobbyLobby
	var game: Gridpaint
	var hashes := {}
	var chats: Array = []
	var rejects: Array = []
	var pauses: Array = []
	var refusals: Array = []
	var desyncs := 0
	var restores: Array = []

	func hook(code: String) -> void:
		game = Gridpaint.new(code)
		var ls := lobby.lockstep
		ls.snapshot = func() -> PackedByteArray: return game.snapshot()
		ls.restore = func(tick: int, bytes: PackedByteArray) -> void:
			game.restore(tick, bytes)
			hashes.clear()
			hashes[tick] = game.hash_grid()
		ls.desync.connect(func(_t: int, _h: int, _y: int) -> void: desyncs += 1)
		ls.restored.connect(func(t: int) -> void: restores.append(t))
		lobby.chat.message.connect(func(l: Dictionary) -> void: chats.append(l))
		lobby.chat.rejected.connect(func(id: int, reason: String) -> void: rejects.append([id, reason]))
		lobby.pause.changed.connect(func(s: Dictionary) -> void: pauses.append(s))
		lobby.pause.refused.connect(func(c: String) -> void: refusals.append(c))

	func pump() -> void:
		if game == null or lobby == null:
			return
		while true:
			var f := lobby.lockstep.next_frame()
			if f.is_empty():
				break
			var h := game.step(int(f["tick"]), f["commands"])
			hashes[int(f["tick"])] = h
			lobby.lockstep.report_hash(int(f["tick"]), h)


func _init() -> void:
	process_frame.connect(func() -> void:
		if Time.get_ticks_msec() > 120000:
			print("sync FAIL: timed out")
			quit(1))
	_run.call_deferred()


func _check(ok: bool, what: String) -> void:
	if ok:
		_pass += 1
	else:
		_fail += 1
		print("FAIL: ", what)


func _spec(path: String) -> Variant:
	var spec := ProjectSettings.globalize_path("res://").path_join("../../spec").simplify_path()
	return JSON.parse_string(FileAccess.get_file_as_string(spec.path_join(path)))


func _run() -> void:
	_goldens()
	_chat_units()
	await _lockstep_lobby()
	print("sync: %d passed, %d failed" % [_pass, _fail])
	quit(1 if _fail > 0 else 0)


# ---- the sim against the shared vectors ----------------------------------------------------------------------------

func _goldens() -> void:
	var doc: Dictionary = _spec("vectors/gridpaint.json")
	var by_tick := {}
	for c: Dictionary in doc["commandLog"]:
		var t := int(c["tick"])
		if not by_tick.has(t):
			by_tick[t] = []
		by_tick[t].append({"peer_id": int(c["peerId"]), "bytes": Gridpaint.paint_cmd(int(c["x"]), int(c["y"]))})
	for g: Dictionary in doc["golden"]:
		var game := Gridpaint.new(str(g["code"]))
		var want: Dictionary = g["hashes"]
		_check(game.rng == int(g["seed"]), "gridpaint seed of %s" % g["code"])
		_check(OneLobbyWire.u64_to_string(game.hash_grid()) == want["0"], "gridpaint %s hash at tick 0" % g["code"])
		for t in range(1, 401):
			var h := game.step(t, by_tick.get(t, []))
			if want.has(str(t)):
				_check(OneLobbyWire.u64_to_string(h) == want[str(t)], "gridpaint %s hash at tick %d" % [g["code"], t])
	var snap: Dictionary = doc["snapshotAtTick100_code_7HQ4K2"]
	var restored := Gridpaint.new("000000")
	restored.restore(int(snap["tick"]), (snap["bytes"] as String).hex_decode())
	_check(OneLobbyWire.u64_to_string(restored.hash_grid()) == snap["hash"], "gridpaint snapshot at tick 100 restores to its hash")
	for t in range(101, 401):
		restored.step(t, by_tick.get(t, []))
	var gold400: Dictionary = (doc["golden"] as Array).filter(func(g: Dictionary) -> bool: return g["code"] == CODE)[0]["hashes"]
	_check(OneLobbyWire.u64_to_string(restored.hash_grid()) == gold400["400"], "gridpaint restored at 100 reproduces the tick-400 golden")


func _chat_units() -> void:
	var dirty := "a" + char(0x01) + "b" + char(0x7f) + "c" + char(0x85) + "d" + char(0x202e) + "e" + char(0x2066) + "f"
	_check(OneLobbyChat.sanitize(dirty) == "abcdef", "chat strips control characters and bidi overrides")
	_check(OneLobbyChat.sanitize("café ☕") == "café ☕", "chat keeps text")
	_check(OneLobbyChat.reason_name(1) == "rate" and OneLobbyChat.reason_name(2) == "length" and OneLobbyChat.reason_name(3) == "muted_by_host" and OneLobbyChat.reason_name(9) == "unknown", "chat reject names")


# ---- real peers over loopback --------------------------------------------------------------------------------------

func _pump_all() -> void:
	for p: Player in _players:
		p.pump()


func _until(cond: Callable, frames: int = 600) -> bool:
	for _i in frames:
		await process_frame
		_pump_all()
		if cond.call():
			return true
	return cond.call()


func _frames(n: int) -> void:
	for _i in n:
		await process_frame
		_pump_all()


func _player(bp: Dictionary, name: String) -> Player:
	var p := Player.new()
	p.client = OneLobbyClient.from_config(bp, {"display_name": name})
	root.add_child(p.client)
	return p


func _lockstep_lobby() -> void:
	var bp := {"game": {"id": "sync-loopback"}, "engine": "godot-gdscript", "hosting": {"nostr": false},
		"sync": {"mode": "lockstep", "tickRate": 20, "hashEveryTicks": 10}, "session": {"pause": "anyone"}}
	var h := _player(bp, "Sam")
	h.lobby = await h.client.host({"tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1", "udp_port_range": [47970, 47974]})
	if h.lobby == null:
		_check(false, "host() of a lockstep file: %s" % JSON.stringify(h.client.last_error))
		return
	_check(h.lobby.mode == "lockstep" and h.lobby.tick_rate == 20 and h.lobby.lockstep.hash_every_ticks == 10, "the file's lockstep settings reach the lobby")
	h.hook(h.lobby.code)
	_players.append(h)
	var a := _player(bp, "Ann")
	a.lobby = await a.client.join(h.lobby.ip_code)
	if a.lobby == null:
		_check(false, "join(): %s" % JSON.stringify(a.client.last_error))
		return
	_check(a.lobby.mode == "lockstep", "a joiner takes the host's lockstep mode")
	var b := _player(bp, "Bob")
	b.lobby = await b.client.join(h.lobby.ip_code)
	_check(b.lobby != null, "second joiner")
	a.hook(h.lobby.code)
	b.hook(h.lobby.code)
	_players.append(a)
	_players.append(b)
	_check(await _until(func() -> bool: return a.lobby.is_ready and b.lobby.is_ready and h.lobby.is_peer_ready(a.lobby.local_peer_id) and h.lobby.is_peer_ready(b.lobby.local_peer_id)), "both joiners are linked")

	# ---- chat before the game: stamped by the host, everyone (the sender too) gets it
	a.lobby.chat.send("hello from Ann")
	_check(await _until(func() -> bool: return h.chats.size() == 1 and a.chats.size() == 1 and b.chats.size() == 1), "a chat line reaches every peer, the sender included")
	_check(b.chats[0]["peer_id"] == a.lobby.local_peer_id and b.chats[0]["text"] == "hello from Ann" and b.chats[0]["id"] >= 1 and absf(float(b.chats[0]["ts"]) - Time.get_unix_time_from_system() * 1000.0) < 10000.0, "the line carries the author, text, host id and host time")
	var long_id := a.lobby.chat.send("x".repeat(257))
	_check(await _until(func() -> bool: return not a.rejects.is_empty()) and a.rejects[0] == [long_id, "length"], "a line over 256 bytes is rejected with length")
	a.rejects.clear()
	for i in 6:
		a.lobby.chat.send("burst %d" % i)
	_check(await _until(func() -> bool: return a.rejects.size() >= 2) and a.rejects[0][1] == "rate", "the 4th line in a burst is rate limited")
	h.lobby.chat.host_mute(b.lobby.local_peer_id, true)
	var mid := b.lobby.chat.send("muted")
	_check(await _until(func() -> bool: return not b.rejects.is_empty()) and b.rejects[0] == [mid, "muted_by_host"], "a host-muted peer is rejected with muted_by_host")
	h.lobby.chat.host_mute(b.lobby.local_peer_id, false)
	_check(a.lobby.chat.history().size() >= 3 and h.lobby.chat.history().size() >= 3, "chat history is kept")

	# ---- pause is refused before the game
	a.lobby.pause.request(true)
	_check(await _until(func() -> bool: return a.refusals == ["not_in_game"]), "pause before start() is refused with not_in_game")

	# ---- lockstep: host starts, everyone submits, everyone applies identical frames
	h.lobby.start()
	_check(await _until(func() -> bool: return a.lobby.phase == "in_game" and b.lobby.phase == "in_game"), "joiners see the game start")
	var all := [h, a, b]
	for i in 30:
		(all[i % 3] as Player).lobby.lockstep.submit(Gridpaint.paint_cmd(i % 16, (i * 5) % 16))
		await _frames(2)
		for p: Player in all:
			p.pump()
	_check(await _until(func() -> bool:
		for p: Player in all:
			p.pump()
		return h.game.tick >= 40 and a.game.tick >= 40 and b.game.tick >= 40), "every peer reached tick 40")
	var common := mini(h.game.tick, mini(a.game.tick, b.game.tick))
	var t := common - common % 10
	_check(h.hashes.has(t) and h.hashes[t] == a.hashes.get(t, -1) and h.hashes[t] == b.hashes.get(t, -2), "identical hash at tick %d on all three peers" % t)
	_check(h.game.grid.hex_encode() != "00".repeat(256), "the commands changed the grid")
	_check(h.desyncs == 0 and a.desyncs == 0 and b.desyncs == 0, "no desync")

	# ---- shared pause
	_check(not a.lobby.pause.state["paused"] and not a.lobby.pause.can_resume, "not paused at first")
	a.lobby.pause.request(true)
	_check(await _until(func() -> bool: return h.pauses.size() == 1 and a.pauses.size() == 1 and b.pauses.size() == 1), "a pause reaches every peer")
	_check(b.pauses[0] == {"paused": true, "by_peer": a.lobby.local_peer_id, "pauser_left": false} and a.lobby.pause.can_resume and not b.lobby.pause.can_resume and h.lobby.pause.can_resume, "state names the pauser; the pauser and the host can resume, a third player cannot")
	a.refusals.clear()
	a.lobby.pause.request(false)
	_check(await _until(func() -> bool: return a.refusals == ["rate_limited"]), "resuming within 500 ms of pausing is rate limited")
	await _frames(15)
	var frozen := h.lobby.lockstep.last_tick
	await _frames(40)
	_check(h.lobby.lockstep.last_tick == frozen, "the host emits no frames while paused")
	b.lobby.pause.request(false)
	_check(await _until(func() -> bool: return b.refusals == ["not_allowed"]), "a third player cannot resume (not_allowed)")
	await _frames(40)
	a.lobby.pause.request(false)
	_check(await _until(func() -> bool: return not h.pauses.back()["paused"]), "the pauser resumes after the rate window")
	_check(await _until(func() -> bool: return h.lobby.lockstep.last_tick > frozen), "frames continue after the resume")
	_check(h.lobby.lockstep.last_tick - frozen < 200, "the clock restarted at the resume (no burst of missed ticks)")
	h.lobby.pause.policy = func(peer: int, _want: bool) -> bool: return peer != b.lobby.local_peer_id
	b.refusals.clear()
	b.lobby.pause.request(true)
	_check(await _until(func() -> bool: return b.refusals == ["not_allowed"]), "the host's policy can deny a pause")
	h.lobby.pause.policy = Callable()
	h.lobby.pause.request(true)
	_check(await _until(func() -> bool: return a.pauses.back()["paused"] and a.pauses.back()["by_peer"] == h.lobby.local_peer_id), "the host can pause")
	h.lobby.pause.clear()
	_check(await _until(func() -> bool: return not a.pauses.back()["paused"] and not b.pauses.back()["paused"]), "clear() unpauses everyone at once")

	# ---- a hash mismatch: the host resyncs the peer from a snapshot
	var before := a.restores.size()
	a.game.rng = Gridpaint.xorshift32(a.game.rng) # corrupt Ann's state (the grid heals itself, the rng does not)
	_check(await _until(func() -> bool: return a.desyncs >= 1 and a.restores.size() > before, 900), "a corrupted peer gets desync + a snapshot")
	_check(await _until(func() -> bool:
		for p: Player in all:
			p.pump()
		var tk := mini(h.game.tick, a.game.tick)
		var cmp := tk - tk % 10
		return a.hashes.has(cmp) and h.hashes.has(cmp) and a.hashes[cmp] == h.hashes[cmp] and not a.restores.is_empty() and a.game.tick > a.restores.back(), 900), "the resynced peer converges with the host")

	# ---- late join: a snapshot, then frames
	var c := _player(bp, "Cy")
	c.lobby = await c.client.join(h.lobby.ip_code)
	if c.lobby == null:
		_check(false, "late joiner: %s" % JSON.stringify(c.client.last_error))
		return
	c.hook(h.lobby.code)
	all.append(c)
	_players.append(c)
	_check(await _until(func() -> bool:
		for p: Player in all:
			p.pump()
		return not c.restores.is_empty() and c.game.tick > c.restores[0] and c.lobby.phase == "in_game", 900), "a late joiner restores the host's snapshot and keeps up")
	_check(await _until(func() -> bool:
		for p: Player in all:
			p.pump()
		var tk := mini(h.game.tick, c.game.tick)
		var cmp := tk - tk % 10
		return cmp > c.restores[0] and c.hashes.has(cmp) and h.hashes.has(cmp) and c.hashes[cmp] == h.hashes[cmp], 900), "the late joiner's hash equals the host's")
	_check(not c.lobby.chat.history().is_empty(), "a late joiner gets the chat history")

	# ---- blueprint switches: chat.text false and session.pause off (the default) in a file
	var off := _player({"game": {"id": "sync-loopback"}, "engine": "godot-gdscript", "hosting": {"nostr": false}, "chat": {"text": false}}, "Dee")
	off.lobby = await off.client.host({"tcp_port": 0, "listen_address": "127.0.0.1", "public_ip": "127.0.0.1", "udp_port_range": [47980, 47982]})
	if off.lobby == null:
		_check(false, "host() of a chat-off file: %s" % JSON.stringify(off.client.last_error))
		return
	var errs: Array = []
	off.client.error.connect(func(code: String, _m: String) -> void: errs.append(code))
	_check(off.lobby.chat.send("hi") == 0 and errs == ["chat_disabled"], "chat.text false: send() does nothing and raises chat_disabled")
	_check(not off.lobby.pause.request(true) and errs == ["chat_disabled", "pause_disabled"] and off.lobby.pause.mode == "off", "session.pause off (the default in a file): request() raises pause_disabled")

	for p: Player in [h, a, b, c, off]:
		p.lobby.leave()
	await _frames(5)
	for p: Player in [h, a, b, c, off]:
		p.client.queue_free()
