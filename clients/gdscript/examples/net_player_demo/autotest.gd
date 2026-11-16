extends Node
## The headless two-process check of the sample (`--netplayer-test` after `--` on both sides, run by clients/gdscript/net-player-test.sh):
## the joiner walks a scripted path and jumps once; the host records where its copy of the joiner's character is; the joiner sends
## its own trace to the host at the end; the host compares the two paths and prints NETPLAYER_OK or NETPLAYER_FAIL <why>.
## Both sides read the same wall clock (`Time.get_unix_time_from_system`), so the traces line up (the comparison also looks for the
## one constant lag where they match best, like the D1 test: the lag is the render delay plus the link).
##
## Bounds (spec/net-player.md section 11, D1): worst error under 0.5 m and mean under 0.15 m at the best lag. The check passes only
## when the joiner jumped once, the host's copy jumped once, and the copy ended near where the joiner stopped.

const MAX_ERROR := 0.5
const MEAN_ERROR := 0.15
const SETTLE_MS := 1500.0
const WALK_END_MS := 6500.0
const TIMEOUT_MS := 45000.0
const CHUNK := 20
const MSG_BYTE := 0x54 # 'T': raw messages that are not replication ones (those start with 0x52)

var game: Node3D
var players: OneLobbyNetPlayers
var is_host := false
## Milliseconds of the wall clock; a test can swap it.
var clock := Callable()

var _t_start := -1.0
var _t_boot := 0.0
var _peer := 0 # the other player (the joiner, on the host)
var _own: Array = [] # [t_ms, x, y, z]
var _copy: Array = []
var _jumps_seen := 0
var _jumps_own := 0
var _sent := false
var _done := false
var _remote_trace: Array = []
var _remote_jumps := -1
var _remote_final := Vector3.ZERO
var _jump_done := false
var _sample_at := 0.0


func _now() -> float:
	return float(clock.call()) if clock.is_valid() else Time.get_unix_time_from_system() * 1000.0


func attach(g: Node3D) -> void:
	game = g
	players = g.players
	is_host = players.is_host
	_t_boot = _now()
	Engine.max_fps = 60
	players.session.other_message.connect(_on_other)
	print("NETPLAYER_%s_READY" % ("HOST" if is_host else "JOINER"))


func _process(_delta: float) -> void:
	if _done or players == null:
		return
	var now := _now()
	if now - _t_boot > TIMEOUT_MS:
		_finish(false, "timeout: the other player or its trace never came")
		return
	if _peer == 0:
		for p: int in players.player_ids():
			if p != players.local_peer_id and game.spawner.character_of(p) != null and game.spawner.character_of(p).visible and game.spawner.character_of(game.players.local_peer_id) != null:
				_peer = p
				_t_start = now + SETTLE_MS
				_watch()
		return
	if now - _sample_at < 50.0:
		return
	_sample_at = now
	var elapsed := now - _t_start
	if is_host:
		var c := game.spawner.character_of(_peer) as Node3D
		if c != null and c.visible and elapsed > -SETTLE_MS:
			_copy.append([now, c.global_position.x, c.global_position.y, c.global_position.z])
	else:
		var me := game.spawner.character_of(players.local_peer_id) as Node3D
		if me != null and elapsed >= 0.0:
			_own.append([now, me.global_position.x, me.global_position.y, me.global_position.z])
		if elapsed >= WALK_END_MS and not _sent:
			_send_trace(me)


func _watch() -> void:
	var c: Node = game.spawner.character_of(_peer)
	var np: OneLobbyNetPlayer = c.get_node("NetPlayer")
	np.jumped.connect(func() -> void: _jumps_seen += 1)
	if not is_host:
		# the joiner's own character walks the script; the host's copy of the host's character just stands
		var me: Node = game.spawner.character_of(players.local_peer_id)
		me.scripted = Callable(self, "_script")
		(me.get_node("NetPlayer") as OneLobbyNetPlayer).jumped.connect(func() -> void: _jumps_own += 1)


## The joiner's path: stand 1 s, walk +x for 2.5 s (jump once at 1 s into the walk), walk +z for 1.5 s, stand.
func _script() -> Dictionary:
	var t := _now() - _t_start
	var move := Vector2.ZERO
	if t >= 1000.0 and t < 3500.0:
		move = Vector2(1.0, 0.0)
	elif t >= 3500.0 and t < 5000.0:
		move = Vector2(0.0, 1.0)
	var jump := false
	if t >= 2000.0 and not _jump_done:
		_jump_done = true
		jump = true
	return {"move": move, "jump": jump}


func _send_trace(me: Node3D) -> void:
	_sent = true
	var lobby: Variant = players.session.lobby_handle
	var host_peer := players.session.host_peer_id
	var i := 0
	while i < _own.size():
		var part: Array = []
		for s: Array in _own.slice(i, i + CHUNK):
			part.append("%d,%.3f,%.3f,%.3f" % [int(s[0]), float(s[1]), float(s[2]), float(s[3])])
		_send(lobby, host_peer, {"trace": part})
		i += CHUNK
	_send(lobby, host_peer, {"end": true, "jumps": _jumps_own, "final": [me.global_position.x, me.global_position.y, me.global_position.z]})
	print("NETPLAYER_JOINER_DONE samples=%d jumps=%d" % [_own.size(), _jumps_own])
	get_tree().create_timer(2.0).timeout.connect(func() -> void: _finish(true, ""))


func _send(lobby: Variant, to: int, msg: Dictionary) -> void:
	var b := PackedByteArray([MSG_BYTE])
	b.append_array(JSON.stringify(msg).to_utf8_buffer())
	lobby.send(to, b, OneLobbyWire.RELIABLE)


func _on_other(_from: int, bytes: PackedByteArray, _channel: int) -> void:
	if not is_host or bytes.size() < 2 or bytes[0] != MSG_BYTE:
		return
	var j := JSON.new()
	if j.parse(bytes.slice(1).get_string_from_utf8()) != OK or not (j.data is Dictionary):
		return
	var d: Dictionary = j.data
	if d.has("trace"):
		for line: String in d["trace"]:
			var f := line.split(",")
			if f.size() == 4:
				_remote_trace.append([float(f[0]), float(f[1]), float(f[2]), float(f[3])])
	if d.has("end"):
		_remote_jumps = int(d["jumps"])
		var f: Array = d["final"]
		_remote_final = Vector3(float(f[0]), float(f[1]), float(f[2]))
		_evaluate()


func _evaluate() -> void:
	var r := compare_paths(_remote_trace, _copy)
	var copy_final := Vector3(float(_copy.back()[1]), float(_copy.back()[2]), float(_copy.back()[3])) if _copy.size() > 0 else Vector3(1e9, 0, 0)
	var end_gap := Vector2(copy_final.x - _remote_final.x, copy_final.z - _remote_final.z).length()
	print("NETPLAYER_NUMBERS lag %d ms, mean %.3f m, worst %.3f m, compared %d samples, joiner jumps %d, copy jumps %d, end gap %.2f m" % [r["lag_ms"], r["mean"], r["max"], r["n"], _remote_jumps, _jumps_seen, end_gap])
	var why := ""
	if int(r["n"]) < 20:
		why = "too few samples to compare (%d)" % int(r["n"])
	elif float(r["max"]) >= MAX_ERROR:
		why = "worst error %.3f m is over %.1f m" % [r["max"], MAX_ERROR]
	elif float(r["mean"]) >= MEAN_ERROR:
		why = "mean error %.3f m is over %.2f m" % [r["mean"], MEAN_ERROR]
	elif _remote_jumps != 1:
		why = "the joiner jumped %d times, expected 1" % _remote_jumps
	elif _jumps_seen != 1:
		why = "the host's copy jumped %d times, expected 1" % _jumps_seen
	elif end_gap > 1.0:
		why = "the copy ended %.2f m from where the joiner stopped" % end_gap
	_finish(why == "", why)


func _finish(ok: bool, why: String) -> void:
	if _done:
		return
	_done = true
	if is_host:
		print("NETPLAYER_OK" if ok else "NETPLAYER_FAIL " + why)
	elif not ok:
		print("NETPLAYER_FAIL " + why)
	get_tree().quit(0 if ok else 1)


## The owner's position at time `t` (ms), interpolated between its samples `[t, x, y, z]`; null outside the path.
static func at(path: Array, t: float) -> Variant:
	var n := path.size()
	if n == 0 or t < float(path[0][0]) or t > float(path[n - 1][0]):
		return null
	var lo := 0
	var hi := n - 1
	while hi - lo > 1:
		var m := (lo + hi) >> 1
		if float(path[m][0]) <= t:
			lo = m
		else:
			hi = m
	var a: Array = path[lo]
	var b: Array = path[hi]
	var k := 0.0 if float(b[0]) == float(a[0]) else (t - float(a[0])) / (float(b[0]) - float(a[0]))
	return [float(a[1]) + (float(b[1]) - float(a[1])) * k, float(a[2]) + (float(b[2]) - float(a[2])) * k, float(a[3]) + (float(b[3]) - float(a[3])) * k]


## Two paths that are a render delay apart: the one constant lag (0 to 600 ms, 8 ms steps) at which the watched path is closest to
## the owner's on average, then the mean and worst distance at that lag: `{lag_ms, mean, max, n}`.
static func compare_paths(owner: Array, watched: Array) -> Dictionary:
	var best := {"lag_ms": 0, "mean": INF, "max": INF, "n": 0}
	for lag in range(0, 601, 8):
		var sum := 0.0
		var mx := 0.0
		var n := 0
		for w: Array in watched:
			var o: Variant = at(owner, float(w[0]) - float(lag))
			if o == null:
				continue
			var d := sqrt((float(w[1]) - float(o[0])) ** 2 + (float(w[2]) - float(o[1])) ** 2 + (float(w[3]) - float(o[2])) ** 2)
			sum += d
			mx = maxf(mx, d)
			n += 1
		if n > 20 and sum / float(n) < float(best["mean"]):
			best = {"lag_ms": lag, "mean": sum / float(n), "max": mx, "n": n}
	return best
