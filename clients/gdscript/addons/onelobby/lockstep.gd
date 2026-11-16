class_name OneLobbyLockstep
extends RefCounted
## Host-ordered lockstep (spec/binary.md, DESIGN s.8), the GDScript twin of the JS `lobby.lockstep` and C# `lobby.Lockstep`
## (the same wire: a GDScript peer can host or join a lockstep lobby with JS and C# peers and gets identical frames).
## Reach it as `lobby.lockstep` in a lobby made with `client.sync_mode = "lockstep"` (or `sync.mode` in onelobby.json).
##
##     lobby.lockstep.snapshot = func() -> PackedByteArray: return game.save()
##     lobby.lockstep.restore = func(tick: int, bytes: PackedByteArray) -> void: game.load(tick, bytes)
##     lobby.lockstep.submit(command_bytes)                 # any player, any time
##     func _process(_dt):                                  # every frame
##         while true:
##             var f := lobby.lockstep.next_frame()         # {tick, commands: [{peer_id, bytes}]}, {} when none
##             if f.is_empty(): break
##             game.step(f["tick"], f["commands"])         # must be deterministic
##             lobby.lockstep.report_hash(f["tick"], game.hash())   # a u64 in an int
##
## The host emits frame T+1 every 1000/tick_rate ms and never waits for peers; commands go to the host, which puts them in
## the next frame (sorted by peer id, a peer's own commands in the order it sent them). Tick T is the state after applying
## frame T; the initial state is tick 0 and has no frame. The game's step must be a pure function of (state, frame). The
## frames come out of next_frame() in order; pump the lobby every frame (the client does) and call next_frame() until it
## is empty, or `catching_up` stays true. Hashes: report_hash() after applying a frame; the library only sends it when
## `tick % hash_every_ticks == 0`. On a mismatch the host sends a snapshot (your `restore` runs) and the 3rd mismatch of one
## peer drops it. A late joiner and a resync are served from `snapshot`, which must return the state after the last frame
## that next_frame() returned.
##
## A shared pause (lobby.pause) stops the host's frames and the joiner's silent-host check; it is not a command.

## The host's hash for `tick` differs from yours; a snapshot follows (your `restore` runs).
signal desync(tick: int, host_hash: int, your_hash: int)
## A snapshot was applied (late join, desync, falling too far behind).
signal restored(tick: int)
## The first frame (or snapshot) of the game reached this peer: the session is in game.
signal started

const MAX_DESYNCS := 3
const MAX_RESTORE_RETRIES := 3
const HOST_SILENCE_MS := 3000
const PEER_HASH_SILENCE_MS := 10000
## Commands one remote peer may have waiting for the host's next frame; the excess is dropped.
const MAX_PENDING_PER_PEER := 256
const SNAPSHOT_COMPRESS_MIN := 1024
const NO_STRIKE := 1 << 62

## `func() -> PackedByteArray`: the game state after the last frame next_frame() returned (host: serves late joiners and resyncs).
var snapshot := Callable()
## `func(tick: int, bytes: PackedByteArray) -> void`: replace the game state with a snapshot taken at `tick`; the next frame is tick + 1.
var restore := Callable()
## Snapshot chunk body size when serving snapshots.
var chunk_size := OneLobbyWire.DEFAULT_CHUNK

var hash_every_ticks := 20
## Remote commands the host dropped because that peer already had MAX_PENDING_PER_PEER waiting.
var dropped_commands := 0

var _l: OneLobbyLobby
var _history_max := 600
var _queue: Array = []
var _history: Array = []
## Highest frame tick received/emitted; -1 = no state (a fresh joiner).
var _last_frame_tick := -1
## Tick of the state the game holds (last frame returned by next_frame, or a restored snapshot).
var _consumed_tick := 0
var _cmd_seq := 1
var _awaiting_snapshot := false
var _last_frame_rx := 0
var _last_snapshot_req := -1000000
var _restore_failures := 0

# host side
var _hosting := false
var _started := false
var _pending: Array = []
var _ready := {}
var _snapshotting := {}
var _ticking := false
var _base_time := 0
var _emitted := 0
var _held := false
var _own_hashes := {}
var _peer_hashes := {} # tick -> {peer: hash}
var _desyncs := {}
var _last_hash_rx := {}
## Hashes a peer sent for ticks in (from, to] were computed before it restored a snapshot: stale, not evidence.
var _stale := {}

# joiner side
var _pending_snapshot := {}


func _init(lobby: OneLobbyLobby, hash_every: int) -> void:
	_l = lobby
	hash_every_ticks = maxi(1, hash_every)
	_history_max = maxi(60, lobby.tick_rate * 30)
	_last_frame_rx = lobby.now_ms()


# ---- public game-facing surface ------------------------------------------------------------------------------------

## True once the first frame or snapshot of the game reached this peer (the host: after start()).
var is_started: bool:
	get: return _started

## Frames waiting for next_frame().
var frames_buffered: int:
	get: return _queue.size()

## True when the game should run ticks without rendering (more than 2 frames behind).
var catching_up: bool:
	get: return _queue.size() > 2

## Tick of the game's current state.
var current_tick: int:
	get: return _consumed_tick

## Highest frame tick known to this peer (0 when none yet).
var last_tick: int:
	get: return maxi(0, _last_frame_tick)

## True while the shared pause holds the match.
var is_held: bool:
	get: return _held


## Queues a command (any bytes up to about 16 KB). Host: into its own next frame. Joiner: to the host (reliable).
func submit(bytes: PackedByteArray) -> void:
	if _l == null:
		return
	if _hosting:
		_pending.append({"peer_id": _l.local_peer_id, "bytes": bytes.duplicate()})
	else:
		_l._send_msg_to_host({"type": "cmd", "seq": _cmd_seq & 0xFFFFFFFF, "bytes": bytes})
		_cmd_seq += 1


## The next frame to apply: {tick, commands: [{peer_id, bytes}]}, or {} when none is waiting.
func next_frame() -> Dictionary:
	if _queue.is_empty():
		return {}
	var f: Dictionary = _queue.pop_front()
	_consumed_tick = int(f["tick"])
	return f


## Reports the game hash (a u64 held in an int) after applying frame `tick`. Sent to the host only when `tick` is a multiple
## of hash_every_ticks (tick > 0); the host compares it with its own.
func report_hash(tick: int, game_hash: int) -> void:
	if _l == null or _awaiting_snapshot or tick <= 0 or tick % hash_every_ticks != 0:
		return
	if _hosting:
		_own_hashes[tick] = game_hash
		_prune(_own_hashes)
		if _peer_hashes.has(tick):
			var theirs: Dictionary = _peer_hashes[tick]
			_peer_hashes.erase(tick)
			var ids: Array = theirs.keys()
			ids.sort()
			for peer: int in ids:
				_compare(peer, tick, game_hash, int(theirs[peer]))
	else:
		_l._send_msg_to_host({"type": "hash", "tick": tick, "hash": game_hash})


## The hi message's lastTick: -1 until the first frame or snapshot.
func hi_tick() -> int:
	return _last_frame_tick


# ---- role control (called by the lobby) ----------------------------------------------------------------------------

## Host role without emitting yet (lobby phase): peers may already say hi.
func _host_idle() -> void:
	_hosting = true
	if _last_frame_tick < 0:
		_last_frame_tick = 0


## Host begins emitting frames (game start, or after winning a migration), continuing after the last known tick.
func _host_start() -> void:
	_host_idle()
	_started = true
	_emitted = 0
	_base_time = _l.now_ms()
	_ticking = true


## Winning a migration: continue from our last received frame. Pending commands are lost by design.
func _become_host() -> void:
	_pending = []
	_ready.clear()
	_snapshotting.clear()
	_own_hashes.clear()
	_peer_hashes.clear()
	_desyncs.clear()
	_awaiting_snapshot = false
	_host_idle()
	if _started:
		_host_start()


## Losing a claim, or a new host appeared: stop emitting. Keep history; the new host decides replay vs snapshot.
func _become_joiner() -> void:
	_hosting = false
	_ticking = false
	_pending = []
	_ready.clear()
	_last_frame_rx = _l.now_ms()


## Back to the lobby phase: the next start is a fresh match (tick 0, no frames, hashes or pause hold). The host keeps its
## role and the peers that said hi.
func _reset() -> void:
	_ticking = false
	_started = false
	_queue = []
	_history = []
	_pending = []
	_last_frame_tick = 0 if _hosting else -1
	_consumed_tick = 0
	_awaiting_snapshot = false
	_pending_snapshot = {}
	_emitted = 0
	_held = false
	_snapshotting.clear()
	_own_hashes.clear()
	_peer_hashes.clear()
	_desyncs.clear()
	_last_hash_rx.clear()
	_stale.clear()
	_last_frame_rx = _l.now_ms() if _l != null else 0


## A joiner just learned the session is in game (first frame, snapshot, or phase from the server).
func _mark_started() -> void:
	if _started:
		return
	_started = true
	started.emit()
	_l._set_phase("in_game")


## The shared pause is on: the host emits no frames and a joiner expects none (no silent-host check). Resuming rebases
## the host's tick clock to now, so the next frame is simply tick + 1 (no gap, no burst) and nobody counts as silent.
func hold(held: bool) -> void:
	if _held == held or _l == null:
		return
	_held = held
	if held:
		return
	var now := _l.now_ms()
	_base_time = now - int(_emitted * (1000.0 / _l.tick_rate))
	_last_frame_rx = now
	for p: int in _ready:
		_last_hash_rx[p] = now


func _stop() -> void:
	_ticking = false
	_l = null


func _on_peer_left(peer_id: int) -> void:
	_ready.erase(peer_id)
	_snapshotting.erase(peer_id)
	_desyncs.erase(peer_id)
	_last_hash_rx.erase(peer_id)
	_stale.erase(peer_id)
	for m: Dictionary in _peer_hashes.values():
		m.erase(peer_id)
	_pending = _pending.filter(func(c: Dictionary) -> bool: return c["peer_id"] != peer_id)


# ---- host: frame emission ------------------------------------------------------------------------------------------

## Called by the lobby every pump: emits the frames that are due.
func _pump(now: int) -> void:
	if not _hosting or not _ticking or _held:
		return
	var interval := 1000.0 / _l.tick_rate
	var due := int(floor((now - _base_time + 1) / interval)) - _emitted
	if due > 10:
		# starved (e.g. a stalled frame): do not flood. Rebase rather than emit a burst of empty frames.
		_base_time = now - int(_emitted * interval)
		due = 1
	for i in due:
		_emit_frame()
		if _l == null:
			return


func _emit_frame() -> void:
	# sorted by peer id, stable: one peer's commands keep their arrival order
	var ids := {}
	for c: Dictionary in _pending:
		ids[c["peer_id"]] = true
	var order: Array = ids.keys()
	order.sort()
	var commands: Array = []
	for id: int in order:
		for c: Dictionary in _pending:
			if c["peer_id"] == id:
				commands.append(c)
	_pending = []
	var frame := {"tick": _last_frame_tick + 1, "commands": commands}
	_emitted += 1
	_last_frame_tick = int(frame["tick"])
	_record(frame)
	_queue.append(frame)
	if not _ready.is_empty():
		var bytes := _encode_frame(frame)
		for p: int in _ready.keys():
			_l._send_bytes(p, bytes)
	_check_peer_silence()


static func _encode_frame(f: Dictionary) -> PackedByteArray:
	var cmds: Array = []
	for c: Dictionary in f["commands"]:
		cmds.append({"peerId": c["peer_id"], "bytes": c["bytes"]})
	return OneLobbyWire.encode({"type": "frame", "tick": f["tick"], "cmds": cmds}, OneLobbyWire.MAX_REASSEMBLED)


func _record(f: Dictionary) -> void:
	_history.append(f)
	if _history.size() > _history_max:
		_history = _history.slice(_history.size() - _history_max)


## The host drops a peer it has had no `hash` from for 10 s (scaled up when hashes are rare).
func _check_peer_silence() -> void:
	if _own_hashes.is_empty():
		return
	var now := _l.now_ms()
	var limit := maxf(PEER_HASH_SILENCE_MS, (float(hash_every_ticks) / _l.tick_rate) * 1000.0 * 3.0)
	for p: int in _ready.keys():
		var last: int = _last_hash_rx.get(p, now)
		if now - last > limit:
			_l._drop_for_lockstep(p, "timeout")
			if _l == null:
				return


# ---- message handling ----------------------------------------------------------------------------------------------

func _handle(from: int, m: Dictionary) -> void:
	match str(m["type"]):
		"cmd":
			if _hosting:
				var waiting := 0
				for c: Dictionary in _pending:
					if c["peer_id"] == from:
						waiting += 1
				if waiting >= MAX_PENDING_PER_PEER:
					dropped_commands += 1
				else:
					_pending.append({"peer_id": from, "bytes": m["bytes"]})
		"frame":
			if not _hosting:
				var cmds: Array = []
				for c: Dictionary in m["cmds"]:
					cmds.append({"peer_id": int(c["peerId"]), "bytes": c["bytes"]})
				_on_frame(int(m["tick"]), cmds)
		"hash":
			if _hosting:
				_on_peer_hash(from, int(m["tick"]), int(m["hash"]))
		"desync":
			if not _hosting:
				_awaiting_snapshot = true
				_queue = []
				desync.emit(int(m["tick"]), int(m["hostHash"]), int(m["yourHash"]))
		"snapshot_req":
			if _hosting:
				_send_snapshot(from)
		"snapshot":
			if not _hosting:
				_mark_started()
				_pending_snapshot = {"tick": int(m["tick"]), "total": int(m["total"]), "flags": int(m["flags"])}


## True when a `snapshot` header was seen and its chunk set has not completed yet.
func _snapshot_pending() -> bool:
	return not _pending_snapshot.is_empty()


## The reassembled chunk set that follows a `snapshot` header.
func _on_snapshot_payload(payload: PackedByteArray) -> void:
	var ps := _pending_snapshot
	_pending_snapshot = {}
	if ps.is_empty():
		return
	if payload.size() != int(ps["total"]):
		# spec: a receiver that gets a different sum drops the snapshot and re-requests
		_awaiting_snapshot = false
		_request_snapshot()
		return
	_apply_snapshot(ps, payload)


func _on_frame(tick: int, commands: Array) -> void:
	_last_frame_rx = _l.now_ms()
	_mark_started()
	if _awaiting_snapshot:
		return
	var expected := maxi(0, _last_frame_tick) + 1
	if tick < expected:
		return # duplicate (replay overlap)
	if tick > expected:
		_request_snapshot() # gap: the host changed under us
		return
	var f := {"tick": tick, "commands": commands}
	_last_frame_tick = tick
	_record(f)
	_queue.append(f)
	if _queue.size() > _l.tick_rate * 3:
		_request_snapshot()


## Joiner asks the host for a snapshot (far behind, gap, silent host). Throttled while one is outstanding.
func _request_snapshot() -> void:
	var now := _l.now_ms()
	if _awaiting_snapshot and now - _last_snapshot_req < 2000:
		return
	_last_snapshot_req = now
	_awaiting_snapshot = true
	_queue = []
	_l._send_msg_to_host({"type": "snapshot_req", "sinceTick": _last_frame_tick})


## 3 s without frames: ask the host for a snapshot without discarding anything (a live host answers).
func _poke_host() -> void:
	_l._send_msg_to_host({"type": "snapshot_req", "sinceTick": _last_frame_tick})


func _apply_snapshot(ps: Dictionary, payload: PackedByteArray) -> void:
	var bytes := payload
	var ok := true
	if int(ps["flags"]) & 1:
		bytes = payload.decompress_dynamic(OneLobbyWire.MAX_REASSEMBLED, FileAccess.COMPRESSION_DEFLATE)
		ok = bytes.size() > 0 or payload.size() == 0
	if ok and not restore.is_valid():
		_l._c.raise_error("lockstep_error", "lockstep.restore is not set; cannot apply a snapshot")
		ok = false
	if ok:
		# restore first: if the game's restore fails, our bookkeeping must not have moved
		restore.call(int(ps["tick"]), bytes)
		_queue = []
		_history = []
		_last_frame_tick = int(ps["tick"])
		_consumed_tick = int(ps["tick"])
		_awaiting_snapshot = false
		_restore_failures = 0
		_mark_started()
		_last_frame_rx = _l.now_ms()
		restored.emit(int(ps["tick"]))
		return
	# the game's state is unknown after a failed restore: keep our tick where it was, drop frames, ask again
	_restore_failures += 1
	if _restore_failures <= MAX_RESTORE_RETRIES:
		_awaiting_snapshot = false
		_last_snapshot_req = -1000000
		_request_snapshot()
	else:
		_l._c.raise_error("lockstep_error", "snapshot restore failed %d times; giving up" % _restore_failures)


# ---- host: hello, hashes, snapshots --------------------------------------------------------------------------------

## Host: a peer said hi (welcome_dc and chat_history already sent). Decide: nothing, replay, or snapshot.
func _on_peer_hi(peer_id: int, last_tick: int) -> void:
	_last_hash_rx[peer_id] = _l.now_ms()
	var host_tick := _last_frame_tick
	var first: int = int(_history[0]["tick"]) if not _history.is_empty() else host_tick + 1
	if last_tick < 0:
		# fresh joiner: initial state if no game is running, otherwise a snapshot
		if _started and host_tick > 0:
			_send_snapshot(peer_id)
		else:
			_ready[peer_id] = true
		return
	if last_tick <= host_tick and last_tick + 1 >= first:
		# the peer's timeline is a prefix of ours: replay what it lacks, then go live
		for f: Dictionary in _history:
			if int(f["tick"]) > last_tick:
				_l._send_bytes(peer_id, _encode_frame(f))
		_ready[peer_id] = true
	else:
		_send_snapshot(peer_id)


func _on_peer_hash(peer_id: int, tick: int, hash: int) -> void:
	_last_hash_rx[peer_id] = _l.now_ms()
	if _is_stale(peer_id, tick):
		return
	if not _own_hashes.has(tick):
		if not _peer_hashes.has(tick):
			_peer_hashes[tick] = {}
		_peer_hashes[tick][peer_id] = hash
		_prune(_peer_hashes)
		return
	_compare(peer_id, tick, int(_own_hashes[tick]), hash)


func _compare(peer_id: int, tick: int, host_hash: int, your_hash: int) -> void:
	if host_hash == your_hash:
		return
	if _is_stale(peer_id, tick):
		return
	if not _ready.has(peer_id) or _snapshotting.has(peer_id):
		return # already being resynced
	var n: int = int(_desyncs.get(peer_id, 0)) + 1
	_desyncs[peer_id] = n
	if n >= MAX_DESYNCS:
		_l._drop_for_lockstep(peer_id, "desync")
		return
	_l._send_msg(peer_id, {"type": "desync", "tick": tick, "hostHash": host_hash, "yourHash": your_hash})
	_send_snapshot(peer_id, tick)


## Hashes computed before a peer restored its snapshot (ticks after the strike, up to what we had emitted) are not evidence.
func _is_stale(peer_id: int, tick: int) -> bool:
	if not _stale.has(peer_id):
		return false
	var w: Dictionary = _stale[peer_id]
	return tick > int(w["from"]) and tick <= int(w["to"])


func _send_snapshot(peer_id: int, strike_tick: int = NO_STRIKE) -> void:
	if _snapshotting.has(peer_id):
		return
	if not snapshot.is_valid():
		_l._c.raise_error("lockstep_error", "lockstep.snapshot is not set; cannot serve a snapshot")
		return
	_snapshotting[peer_id] = true
	_ready.erase(peer_id) # live frames now flow only through the replay below
	var s := _consumed_tick
	var raw: PackedByteArray = snapshot.call()
	var payload := raw
	var flags := 0
	if raw.size() >= SNAPSHOT_COMPRESS_MIN:
		payload = raw.compress(FileAccess.COMPRESSION_DEFLATE) # a zlib stream (RFC 1950), what the JS and C# clients inflate
		flags = 1
	# header + one contiguous chunk set + frames S+1... with nothing else in between
	_l._send_msg(peer_id, {"type": "snapshot", "tick": s, "total": payload.size(), "flags": flags})
	for c in OneLobbyChunker.split(_l._next_chunk_id(), payload, chunk_size):
		_l._send_bytes(peer_id, c)
	for f: Dictionary in _history:
		if int(f["tick"]) > s:
			_l._send_bytes(peer_id, _encode_frame(f))
	if strike_tick != NO_STRIKE:
		_stale[peer_id] = {"from": strike_tick, "to": _last_frame_tick}
	else:
		_stale.erase(peer_id)
	for m: Dictionary in _peer_hashes.values():
		m.erase(peer_id)
	_ready[peer_id] = true
	_last_hash_rx[peer_id] = _l.now_ms()
	_snapshotting.erase(peer_id)


func _prune(m: Dictionary) -> void:
	if m.size() <= 64:
		return
	var keys: Array = m.keys()
	keys.sort()
	for k: int in keys.slice(0, keys.size() - 64):
		m.erase(k)


# ---- joiner watchdog -----------------------------------------------------------------------------------------------

## True when a started joiner has heard no frames for 3 s: the lobby then runs the host-loss rule (spec/binary.md "Migration").
func _host_silent() -> bool:
	return not _hosting and not _held and _started and _l.now_ms() - _last_frame_rx > HOST_SILENCE_MS


## Resets the silence timer, e.g. after the link to a new host opened.
func _touch() -> void:
	_last_frame_rx = _l.now_ms()
