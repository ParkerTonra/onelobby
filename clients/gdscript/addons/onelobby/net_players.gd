class_name OneLobbyNetPlayers
extends RefCounted
## The networked player layer (spec/net-player.md): players in the world with no player sync of your own. One replicated entity
## of type `OneLobbyPlayerWire.PLAYER_TYPE_ID` per seated peer, whose state is the player preset; action events (jump, shoot,
## melee ...) that arrive exactly once and play at the right moment; the host's limits; prediction and hit rewind.
## GDScript twin of JS `NetPlayers`: the same wire, the same order of operations, snake_case names. No scene tree: the node
## `OneLobbyNetPlayer` and the spawner `OneLobbyNetPlayerSpawner` sit on top of it, and a game may use it directly.
##
## "owner": each peer places its own player (the state travels as the bytes of the input message). "host": the input preset
## travels, the host steps every player with the game's `step` function and the owner predicts the same step.
##
##     var players := OneLobbyNetPlayers.from_config(lobby, cfg)       # or .new(lobby_or_session, {authority: "owner", ...})
##     players.player_joined.connect(func(peer: int) -> void: make_character(peer))
##     func _process(_dt: float) -> void:
##         players.pump()                                              # instead of session.pump()
##     players.tick.connect(func(_t: int) -> void: players.set_local_state({"x": body.x, "y": body.y, "z": body.z}))
##     draw(players.get_state(peer))                                   # smoothed; null while that player is not in the world
##
## Names next to JS: `get` is `get_state`, `latest` is `latest_state`, `local` is `local_state`, `players` is `player_ids`,
## `action` is `send_action` and the event of the same name is the signal `action_played`, `onAction` is `on_action`
## (returns a Callable that unsubscribes), `fromBlueprint` is `from_config`. States, inputs and events are Dictionaries with the
## snake_case keys of `OneLobbyPlayerWire`. Where JS throws, this logs one error and does nothing.

const W := preload("res://addons/onelobby/net_player_wire.gd")

## Numbers of spec/net-player.md; all of them are constants of the wire contract.
const EVENT_REPEATS := 4 ## an action event is sent on `fast` in this many consecutive ticks (and once on `reliable`)
const CARRY_ON_MAX_MS := 250.0 ## a player is carried on by its velocity for at most this long past the newest snapshot, then held
const SPEED_TOLERANCE := 1.25 ## owner mode: a claimed move may be this much faster than `max_speed` (network bunching)
const TELEPORT_MIN_INTERVAL_MS := 1000 ## owner mode with limits: an owner-raised teleport is accepted at most this often
const RATE_TOLERANCE := 0.9 ## a rate limit allows this fraction of its interval, less one tick (clock noise)
const CORRECTION_BLEND_MS := 100.0 ## host mode: a correction is blended over this long
const SNAP_HORIZONTAL := 2.0 ## host mode: a correction past this on the ground plane snaps
const SNAP_VERTICAL := 0.5 ## host mode: a correction past this vertically snaps
const CLAIM_MAX_AGE_TICKS := 15 ## the claimed tick of an event may be at most this many ticks older than the host's tick
## The host raises the teleport counter by this much (an owner raises it by 1).
const HOST_TELEPORT_STEP := 4
const PUMP_SAMPLE_MS := 100

## A player appeared (every peer sees every player, the local one included).
signal player_joined(peer_id: int)
## A player is gone (its peer left, or it became a spectator).
signal player_left(peer_id: int)
## Every action event once it is played: `{player, name, args, tick, seq, late, local}` (see `on_action` for one name).
signal action_played(event: Dictionary)
## Host: one local tick is about to run (step your own world here, before the snapshot). Client: one input tick.
signal tick(n: int)
## Owner mode: the host put this player back (a limit, or a teleport by the host); take `state` as yours.
signal corrected(state: Dictionary)
## Host: an owner's update broke a limit: `limit` is "speed", "step" or "teleport_rate".
signal limit_violation(peer_id: int, limit: String)

var session: OneLobbyReplicationSession
## "owner" (default) or "host".
var authority := "owner"
var codec: OneLobbyPlayerCodec
## The host's limits: any of `max_speed`, `max_step`, `min_shot_interval_ms`, `min_melee_interval_ms`; one that is not there is not checked.
var limits := {}
var stats := {
	"actions_sent": 0, "actions_played": 0, "actions_late": 0, "actions_duplicate": 0, "actions_rate_limited": 0,
	"actions_rejected": 0, "states_rejected": 0, "limit_violations": 0, "corrections": 0,
}
## Host mode: the movement step `Callable(state, input, dt) -> state` (also settable here after construction).
var step := Callable()
## Smooths host-mode corrections of the local player (drawn position = `local_state()` + `smoother.offset`).
var smoother: OneLobbyPredictionSmoother

var is_host: bool:
	get:
		return session.is_host
var local_peer_id: int:
	get:
		return session.local_peer_id

var _lobby: Variant
var _spawn_fn := Callable()
var _handlers := {} # event name -> Array[Callable]
var _host_players := {} # peer -> HostPlayer
var _history: OneLobbyHistoryRing
var _known := {} # peer -> entity id (everyone's view of who is in the world)
var _in_dedupe := {} # host: per sending client
var _relay_dedupe := {} # client: per player
var _outboxes := {} # peer -> Array of {ev, left}
var _queue: Array = [] # [{ev, at, n}]
var _queue_n := 0
var _sent_teleport := {} # owner mode: input seq -> teleport counter I sent
var _samples := {} # peer -> Array of {at, sent, received}
var _last_sample_ms := -1000000000
var _my_seq := 0
var _last_pump_ms := 0
var _disposed := false
var _warned_step := false

# local player
var _local_state: Dictionary
var _have_local := false
var _local_input: Dictionary
var _predictor: OneLobbyReconciler
var _last_correct_tick := 0
var _last_sent_seq := 0
var _ignore_until_seq := 0
var _conns: Array = []


## Per-player host bookkeeping.
class OLHostPlayer:
	var peer := 0
	var entity_id := 0
	var state: Dictionary
	var spawned := false
	## Owner mode: ignore owner states until the owner shows the raised teleport counter.
	var awaiting := false
	var last_accept_tick := 0
	var last_teleport_ms := -1000000000
	var last_shot_tick := -1000000000
	var last_melee_tick := -1000000000
	var relay_seq := 0
	var last_input: Dictionary
	## Owner mode: ticks on which no new state came; the next ticks take a second one to make them up.
	var stalled := 0
	## Owner mode, while stalled: the last state that really came; `state` is carried on from it.
	var carried: Dictionary = {}


class OLDedupe:
	var floor_seq := 0
	var seen := {}


## `source`: a `OneLobbyReplicationSession` you made (give it `adaptive_delay: true` for smooth remote players) or a raw-mode
## lobby (the layer makes the session, with `adaptive_delay` on). `opts` (all optional): `authority`, `space`, `range`,
## `velocity_range`, `limits`, `omit` (the `sync.player` settings, snake_case), `step` (Callable, host mode), `spawn`
## (`Callable(peer_id) -> Dictionary`, host mode, host side: where a player starts) and `session` (config of the session the
## layer creates).
func _init(source: Variant, opts: Dictionary = {}) -> void:
	if source is OneLobbyReplicationSession:
		session = source
	else:
		var sc := {"adaptive_delay": true}
		sc.merge(opts.get("session", {}), true)
		session = OneLobbyReplicationSession.new(source, sc)
	_lobby = session.lobby_handle
	authority = str(opts.get("authority", "owner"))
	if authority != "owner" and authority != "host":
		push_error("OneLobbyNetPlayers: authority must be \"owner\" or \"host\"")
		authority = "owner"
	var wire := {}
	for k: String in ["space", "range", "velocity_range", "omit"]:
		if opts.has(k):
			wire[k] = opts[k]
	codec = OneLobbyPlayerCodec.new(wire)
	limits = (opts.get("limits", {}) as Dictionary).duplicate()
	step = opts.get("step", Callable())
	_spawn_fn = opts.get("spawn", Callable())
	smoother = OneLobbyPredictionSmoother.new(CORRECTION_BLEND_MS, SNAP_HORIZONTAL, SNAP_VERTICAL)
	_history = OneLobbyHistoryRing.new(int(session.config["history_ticks"]), func(a: Dictionary, b: Dictionary, t: float) -> Dictionary: return codec.interpolate(a, b, t))
	_local_state = W.default_player_state()
	_local_input = W.default_player_input()
	_last_pump_ms = int(_lobby.now_ms())
	session.register_kind(W.KIND_PLAYER_EVENTS, _on_events)
	var left := func(p: Dictionary, _reason: String) -> void:
		var id := int(p["peer_id"])
		_in_dedupe.erase(id)
		_outboxes.erase(id)
		_samples.erase(id)
	_lobby.peer_left.connect(left)
	_conns.append([_lobby.peer_left, left])


## A layer from a lobby and the settings of `onelobby.json` (`OneLobbyConfig`): `sync.player` and `sync.tick_rate`. `extra` is
## `opts` of `_init`, merged over the file's.
static func from_config(lobby: Variant, cfg: OneLobbyConfig, extra: Dictionary = {}) -> OneLobbyNetPlayers:
	var p: Dictionary = cfg.sync.get("player", {"authority": "owner", "space": "3d", "range": 300, "velocity_range": 32, "limits": {}, "omit": []})
	var opts := {
		"authority": p.get("authority", "owner"), "space": p.get("space", "3d"), "range": p.get("range", 300),
		"velocity_range": p.get("velocity_range", 32), "limits": p.get("limits", {}), "omit": p.get("omit", []),
	}
	opts.merge(extra, true)
	var sc := {"tick_rate": int(cfg.sync.get("tick_rate", 30)), "adaptive_delay": true}
	sc.merge(extra.get("session", {}), true)
	opts["session"] = sc
	return OneLobbyNetPlayers.new(lobby, opts)


func _tick_ms() -> float:
	return session.clock.tick_ms()


func _dt() -> float:
	return 1.0 / float(session.config["tick_rate"])


# ====================================================================== public API =======================================

## Peers whose player is in the world right now (as this peer sees it, the local one included).
func player_ids() -> Array[int]:
	var out: Array[int] = []
	for p: int in _known:
		out.append(p)
	return out


## Owner mode: give the layer your player's state. Sent every tick; call as often as you like (a partial patch is merged; the
## teleport counter is the layer's to keep unless the patch has one).
func set_local_state(patch: Dictionary) -> void:
	if authority != "owner":
		push_error("OneLobbyNetPlayers.set_local_state is for authority \"owner\"; hand over input with set_local_input")
		return
	var first := not _have_local
	var s: Dictionary = W.default_player_state() if first else _local_state.duplicate()
	var tp: int = int(patch.get("teleport", 0 if first else int(_local_state["teleport"])))
	s.merge(patch, true)
	s["teleport"] = tp
	_local_state = s
	_have_local = true


## Host mode: the input of the current tick (a partial patch is merged; `buttons` too); sent and stepped once per tick.
func set_local_input(patch: Dictionary) -> void:
	if authority != "host":
		push_error("OneLobbyNetPlayers.set_local_input is for authority \"host\"; give your state with set_local_state")
		return
	var i := _local_input.duplicate(true)
	for k: String in patch:
		if k == "buttons":
			for b: String in patch["buttons"]:
				i["buttons"][b] = patch["buttons"][b]
		else:
			i[k] = patch[k]
	_local_input = i


## The local player's state: yours in owner mode, the predicted one in host mode (draw it at `local_state()` + `smoother.offset`).
## Authority "host" on a client: an EMPTY Dictionary until the host's first state of this player has arrived (the player starts
## where the host spawned it, never at the origin); inputs before that are neither sent nor stepped. (JS `local` is `undefined`.)
func local_state() -> Dictionary:
	if authority == "owner":
		return _local_state
	if is_host:
		var hp: Variant = _host_players.get(local_peer_id)
		return (hp as OLHostPlayer).state if hp != null else {}
	return _predictor.current if _predictor != null else {}


## One player's state to draw now, or null while the player is not in the world. The local player: `local_state()`. A remote
## player on a client: its state at render time (about 100 ms behind, more on a jittery link), turning on the shortest arc,
## carried on by its velocity for at most 250 ms past the newest snapshot, then held. On the host (JS does the same):
## the host's own record one tick behind, interpolated, so a host that draws the others sees them move smoothly.
func get_state(peer_id: int) -> Variant:
	if peer_id == local_peer_id:
		if not (_known.has(peer_id) or _have_local or authority == "host"):
			return null
		var mine := local_state()
		return mine if not mine.is_empty() else null # authority "host": null until the host's first state of this player
	if is_host:
		if not _host_players.has(peer_id) or not (_host_players[peer_id] as OLHostPlayer).spawned:
			return null
		var t := float(session.clock.tick) - 1.0 + session.clock.alpha()
		var s: Variant = _history.try_sample(peer_id, t)
		return s if s != null else (_host_players[peer_id] as OLHostPlayer).state
	if not _known.has(peer_id):
		return null
	var smp: Variant = session.try_sample(int(_known[peer_id]), codec)
	if smp == null:
		return null
	var s2: Dictionary = smp
	var over_ms := (session.render_tick - float(session.latest_tick)) * _tick_ms()
	if over_ms > 0.0 and codec.has("velocity"):
		var k := minf(over_ms, CARRY_ON_MAX_MS) / 1000.0
		var rg := codec.range_value
		var o := s2.duplicate()
		o["x"] = clampf(float(s2["x"]) + float(s2["vx"]) * k, -rg, rg)
		o["y"] = clampf(float(s2["y"]) + float(s2["vy"]) * k, -rg, rg)
		o["z"] = clampf(float(s2["z"]) + float(s2["vz"]) * k, -rg, rg) if codec.is_3d() else s2["z"]
		return o
	return s2


## The authoritative state of a player in the newest snapshot (not smoothed), or null. Host: its own record.
func latest_state(peer_id: int) -> Variant:
	if is_host:
		var hp: Variant = _host_players.get(peer_id)
		return (hp as OLHostPlayer).state if hp != null else null
	if not _known.has(peer_id):
		return null
	var l := session.try_get_latest(int(_known[peer_id]), codec)
	return null if l.is_empty() else l["state"]


## Send an action event for the local player (arguments by the names of spec/net-player.md). It plays here at once.
## Returns false (after one error) for an unknown name, a left-out event or a host-only one on a client.
func send_action(name: String, args: Dictionary = {}) -> bool:
	var def: Variant = W.action_by_name(name)
	if def == null:
		push_error("OneLobbyNetPlayers: unknown action \"%s\"" % name)
		return false
	if not codec.has_event(name):
		push_error("OneLobbyNetPlayers: action \"%s\" is left out in this game's settings" % name)
		return false
	if def["origin"] == "host" and not is_host:
		push_error("OneLobbyNetPlayers: \"%s\" is raised by the host" % name)
		return false
	_emit_from(local_peer_id, str(def["name"]), args)
	return true


## Host: raise an action event for any player (`hit` and `death` come from here).
func host_action(peer_id: int, name: String, args: Dictionary = {}) -> bool:
	if not _require_host("host_action"):
		return false
	var def: Variant = W.action_by_name(name)
	if def == null:
		push_error("OneLobbyNetPlayers: unknown action \"%s\"" % name)
		return false
	if not codec.has_event(name):
		push_error("OneLobbyNetPlayers: action \"%s\" is left out in this game's settings" % name)
		return false
	_emit_from(peer_id, str(def["name"]), args)
	return true


## Subscribe to one action event by name, for every player (the local one included). Returns a Callable that unsubscribes.
func on_action(name: String, handler: Callable) -> Callable:
	var n := W.snake(name)
	var list: Array = _handlers.get(n, [])
	_handlers[n] = list
	list.append(handler)
	return func() -> void: list.erase(handler)


## Owner mode: put the local player somewhere else without sliding (raises the teleport counter). Host mode on the host: same
## for the host's own player. For another player use `teleport_player`.
func teleport(patch: Dictionary) -> void:
	if is_host:
		teleport_player(local_peer_id, patch)
		return
	if authority != "owner":
		push_error("OneLobbyNetPlayers: on a client only authority \"owner\" can teleport itself; the host places a \"host\" player")
		return
	var s := _local_state.duplicate()
	s.merge(patch, true)
	s["teleport"] = (int(_local_state["teleport"]) + 1) % W.TELEPORT_MODULO
	_local_state = s
	_have_local = true


## Host: place any player (respawn point, portal) without sliding. In owner mode the owner is told to take the host's state.
func teleport_player(peer_id: int, patch: Dictionary) -> void:
	if not _require_host("teleport_player"):
		return
	var p: OLHostPlayer = _host_players.get(peer_id)
	if p == null:
		return
	var s := p.state.duplicate()
	s.merge(patch, true)
	s["teleport"] = (int(p.state["teleport"]) + HOST_TELEPORT_STEP) % W.TELEPORT_MODULO
	p.carried = {}
	p.state = codec.quantize(s)
	if peer_id == local_peer_id:
		_local_state = p.state
		_have_local = true
		if authority == "host":
			_local_input = _local_input.duplicate(true)
	elif authority == "owner":
		p.awaiting = true
	p.last_teleport_ms = int(_lobby.now_ms())
	p.last_accept_tick = session.clock.tick
	if not p.spawned:
		_spawn_entity(p)


## Owner mode (and the host's own player): a teleport that also makes the player alive with full health, then the `respawn` event.
func respawn(patch: Dictionary = {}) -> void:
	if is_host:
		respawn_player(local_peer_id, patch)
		return
	var s := {"alive": true, "health": 100}
	s.merge(patch, true)
	teleport(s)
	if codec.has_event("respawn"):
		send_action("respawn")


## Host: respawn any player (a teleport, alive, full health, and the `respawn` event).
func respawn_player(peer_id: int, patch: Dictionary = {}) -> void:
	if not _require_host("respawn_player"):
		return
	var s := {"alive": true, "health": 100}
	s.merge(patch, true)
	teleport_player(peer_id, s)
	if codec.has_event("respawn"):
		_emit_from(peer_id, "respawn", {})


## Where a player was at a host tick (hit rewind). Host only; null when not recorded (too old, or never there).
func state_at(peer_id: int, tick_value: float) -> Variant:
	if not _require_host("state_at"):
		return null
	return _history.try_sample(peer_id, tick_value)


## Host: where a player was when a shooter saw the world at `view` (a `shoot` action's `view`, in 1/256 ticks), clamped by the
## session's rewind limit.
func rewound(peer_id: int, view: int) -> Variant:
	if not _require_host("rewound"):
		return null
	return _history.try_sample(peer_id, session.rewind_tick({"view_tick": float(view) / 256.0}))


## The host tick a shooter was seeing, clamped to the session's `max_rewind_ms`.
func rewind_tick(view: int) -> float:
	if not _require_host("rewind_tick"):
		return 0.0
	return session.rewind_tick({"view_tick": float(view) / 256.0})


## Replication bytes per second to and from one peer over about the last second: `{sent, received}`. Host: any client. Client: the host.
func bytes_per_second(peer_id: int) -> Dictionary:
	var list: Array = _samples.get(peer_id, [])
	if list.size() < 2:
		return {"sent": 0.0, "received": 0.0}
	var a: Dictionary = list[0]
	var b: Dictionary = list[list.size() - 1]
	var secs := float(int(b["at"]) - int(a["at"])) / 1000.0
	if secs > 0.0:
		return {"sent": float(int(b["sent"]) - int(a["sent"])) / secs, "received": float(int(b["received"]) - int(a["received"])) / secs}
	return {"sent": 0.0, "received": 0.0}


## Advance everything: call every frame instead of `session.pump()`. Runs the due ticks, snapshots, events and corrections.
func pump() -> void:
	if _disposed:
		return
	var now := int(_lobby.now_ms())
	var elapsed := now - _last_pump_ms
	_last_pump_ms = now
	session.pump()
	if is_host:
		_host_roster()
	else:
		_client_roster()
	while session.clock.try_advance():
		var t := session.clock.tick
		tick.emit(t)
		if is_host:
			_host_tick(t)
		else:
			_client_tick()
		_flush_outboxes()
	if not is_host:
		_client_corrections()
		smoother.update(float(elapsed))
	_play_queue()
	_sample_traffic(now)


## Stop listening. The session stays yours.
func dispose() -> void:
	if _disposed:
		return
	_disposed = true
	for c: Array in _conns:
		if (c[0] as Signal).is_connected(c[1]):
			(c[0] as Signal).disconnect(c[1])
	_conns.clear()


# ====================================================================== internals =========================================

func _require_host(what: String) -> bool:
	if not is_host:
		push_error("OneLobbyNetPlayers.%s: host only" % what)
		return false
	return true


func _sample_traffic(now: int) -> void:
	if now - _last_sample_ms < PUMP_SAMPLE_MS:
		return
	_last_sample_ms = now
	var peers: Array = session.clients() if is_host else [session.host_peer_id]
	for peer: int in peers:
		var t := session.traffic_with(peer)
		var list: Array
		if _samples.has(peer):
			list = _samples[peer]
		else:
			list = []
			_samples[peer] = list
		list.append({"at": now, "sent": t["sent"], "received": t["received"]})
		while list.size() > 2 and now - int((list[1] as Dictionary)["at"]) >= 1000:
			list.pop_front()


# ---- roster ------------------------------------------------------------------------------------------------------------

## True when the room layer seats this peer as a spectator (a spectator has no player).
func is_spectator(peer: int) -> bool:
	var room: Variant = _lobby.get("room")
	if room == null:
		return false
	for e: Dictionary in room.entries():
		if int(e["id"]) == peer:
			return str(e.get("role", "")) == "spectator"
	return false


func _host_roster() -> void:
	var want := {}
	var all: Array = [local_peer_id]
	all.append_array(session.clients())
	for peer: int in all:
		if not is_spectator(peer):
			want[peer] = true
	for peer: int in want:
		if not _host_players.has(peer):
			_add_host_player(peer)
	for peer: int in _host_players.keys():
		if want.has(peer):
			continue
		var p: OLHostPlayer = _host_players[peer]
		if p.spawned:
			session.despawn(p.entity_id)
		_history.forget(peer)
		_host_players.erase(peer)
		_relay_dedupe.erase(peer)
		if _known.erase(peer):
			player_left.emit(peer)


func _add_host_player(peer: int) -> void:
	var over: Dictionary = _spawn_fn.call(peer) if _spawn_fn.is_valid() else {}
	var p := OLHostPlayer.new()
	p.peer = peer
	p.state = codec.quantize(W.default_player_state(over))
	p.last_accept_tick = session.clock.tick
	p.last_input = W.default_player_input()
	_host_players[peer] = p
	# host mode: the host places the player at once; owner mode: it appears with its first state
	if authority == "host":
		_spawn_entity(p)


func _spawn_entity(p: OLHostPlayer) -> void:
	p.entity_id = session.spawn(W.PLAYER_TYPE_ID, p.peer, func(w: OneLobbyNetWriter) -> void: codec.write_state(w, p.state))
	p.spawned = true
	_known[p.peer] = p.entity_id
	player_joined.emit(p.peer)


func _client_roster() -> void:
	var present := {}
	for e: Dictionary in session.entities():
		if int(e["type_id"]) == W.PLAYER_TYPE_ID:
			present[int(e["owner"])] = int(e["id"])
	for peer: int in present:
		if _known.get(peer, -1) == present[peer]:
			continue
		var fresh := not _known.has(peer)
		_known[peer] = present[peer]
		if fresh:
			player_joined.emit(peer)
	for peer: int in _known.keys():
		if present.has(peer):
			continue
		_known.erase(peer)
		_relay_dedupe.erase(peer)
		if peer == local_peer_id:
			_predictor = null
		player_left.emit(peer)


# ---- host tick ---------------------------------------------------------------------------------------------------------

var _last_host_tick := 0
var _skipped_ticks := 0


func _host_tick(t: int) -> void:
	var now := int(_lobby.now_ms())
	# ticks the clock skipped after a long stall (max_catch_up) were not run: remote players make them up like stalls
	_skipped_ticks = t - _last_host_tick - 1 if _last_host_tick > 0 and t > _last_host_tick + 1 else 0
	_last_host_tick = t
	for peer: int in _host_players.keys():
		var p: OLHostPlayer = _host_players[peer]
		if peer == local_peer_id:
			_host_local(p)
		else:
			_host_remote(p, t, now)
		if p.spawned:
			_history.record(t, peer, p.state)
	session.send_snapshot()


## One remote player on a host tick. The session hands over one input a tick, oldest first; a tick on which none has come
## (late or lost) is a stall. Owner mode, so that a stall is not seen and does not stay: the record of the player is carried
## on by its own velocity for each stalled tick (the next real state replaces it), and the next ticks take a second state
## until the stalls are made up, so the queue does not keep for good the tick a stall gave it. The same goes for the ticks the
## clock skipped after a long stall of the host (`max_catch_up`): the inputs of those ticks wait in the queue. The queue here may hold
## `max_input_buffer` plus `max_catch_up` inputs (the session's own cap would drop the oldest of such a burst, and a dropped input puts
## the record ahead of its schedule for good), so up to one less than that is counted as stalls, and when the queue runs dry before the
## count does the rest is forgiven: a record carried on past the newest input is a guess, not a delay. At most `max_input_buffer - 1`
## ticks are carried on. Host mode steps one input a tick, and one more for each stall it counted (only while inputs are queued).
func _host_remote(p: OLHostPlayer, t: int, now: int) -> void:
	var queue := maxi(1, int(session.config["max_input_buffer"])) + maxi(0, session.clock.max_catch_up)
	var stall_cap := maxi(1, queue - 1)
	if authority != "owner":
		if _skipped_ticks > 0:
			p.stalled = mini(p.stalled + _skipped_ticks, stall_cap)
		var f0 := session.try_get_input(p.peer, queue)
		if f0.is_empty():
			return
		if bool(f0["repeated"]):
			p.stalled = mini(p.stalled + 1, stall_cap)
			return
		_step_remote(p, f0["bytes"])
		while p.stalled > 0:
			var g0 := session.try_get_input(p.peer, queue)
			if g0.is_empty() or bool(g0["repeated"]):
				p.stalled = 0
				break
			p.stalled -= 1
			_step_remote(p, g0["bytes"])
		return
	if not p.carried.is_empty():
		p.state = p.carried
		p.carried = {}
	if _skipped_ticks > 0:
		p.stalled = mini(p.stalled + _skipped_ticks, stall_cap)
	var f := session.try_get_input(p.peer, queue)
	if not f.is_empty() and not bool(f["repeated"]):
		_accept_owner_state(p, f["bytes"], t, now)
		while p.stalled > 0:
			var g := session.try_get_input(p.peer, queue)
			if g.is_empty() or bool(g["repeated"]):
				p.stalled = 0
				break
			p.stalled -= 1
			_accept_owner_state(p, g["bytes"], t, now)
	elif not f.is_empty():
		p.stalled = mini(p.stalled + 1, stall_cap)
	if p.stalled > 0 and p.spawned and not p.awaiting:
		p.carried = p.state
		var s: Dictionary = p.state
		for i in mini(p.stalled, maxi(1, int(session.config["max_input_buffer"]) - 1)):
			s = _coast(s)
		p.state = s


func _coast(st: Dictionary) -> Dictionary:
	var rg := codec.range_value
	var o := st.duplicate()
	var dt := _dt()
	o["x"] = clampf(float(st["x"]) + float(st["vx"]) * dt, -rg, rg)
	o["y"] = clampf(float(st["y"]) + float(st["vy"]) * dt, -rg, rg)
	o["z"] = clampf(float(st["z"]) + float(st["vz"]) * dt, -rg, rg) if codec.is_3d() else st["z"]
	return codec.quantize(o)


func _host_local(p: OLHostPlayer) -> void:
	if authority == "owner":
		if not _have_local:
			return
		p.state = codec.quantize(_local_state)
		_local_state = p.state
	else:
		var input := codec.quantize_input(_local_input)
		p.state = _run_step(p.state, input)
		_local_state = p.state
	p.last_accept_tick = session.clock.tick
	if not p.spawned:
		_spawn_entity(p)


func _run_step(s: Dictionary, input: Dictionary) -> Dictionary:
	if not step.is_valid():
		if not _warned_step:
			_warned_step = true
			push_error("OneLobbyNetPlayers: authority \"host\" needs a step function: OneLobbyNetPlayers.new(lobby, {\"authority\": \"host\", \"step\": Callable(state, input, dt) -> state})")
		return s
	return codec.quantize(step.call(s, input, _dt()))


func _step_remote(p: OLHostPlayer, bytes: PackedByteArray) -> void:
	var input: Variant = codec.decode_input(bytes)
	if input == null:
		stats["states_rejected"] += 1
		return
	p.last_input = input
	p.state = _run_step(p.state, input)
	p.last_accept_tick = session.clock.tick


func _accept_owner_state(p: OLHostPlayer, bytes: PackedByteArray, t: int, now: int) -> void:
	var sv: Variant = codec.decode_state(bytes)
	if sv == null:
		stats["states_rejected"] += 1
		return
	var s: Dictionary = sv
	if not p.spawned:
		p.state = s
		p.last_accept_tick = t
		_spawn_entity(p)
		return
	if p.awaiting:
		if int(s["teleport"]) != int(p.state["teleport"]):
			return # still the old counter: this state is from before the correction
		p.awaiting = false
	var prev := p.state
	var raised := int(s["teleport"]) != int(prev["teleport"])
	var violation := ""
	if raised:
		if _any_move_limit() and now - p.last_teleport_ms < TELEPORT_MIN_INTERVAL_MS:
			violation = "teleport_rate"
		else:
			p.last_teleport_ms = now
	else:
		var dist := _distance(prev, s)
		if limits.has("max_step") and dist > float(limits["max_step"]):
			violation = "step"
		elif limits.has("max_speed"):
			var secs := float(maxi(1, t - p.last_accept_tick)) * _tick_ms() / 1000.0
			var pos_step := (2.0 * codec.range_value) / float((1 << codec.pos_bits) - 1)
			if dist > float(limits["max_speed"]) * secs * SPEED_TOLERANCE + 2.0 * pos_step:
				violation = "speed"
	if violation != "":
		stats["limit_violations"] += 1
		var nv := prev.duplicate()
		nv["teleport"] = (int(prev["teleport"]) + HOST_TELEPORT_STEP) % W.TELEPORT_MODULO
		p.state = nv
		p.awaiting = true
		p.last_accept_tick = t
		limit_violation.emit(p.peer, violation)
		return
	p.state = s
	p.last_accept_tick = t


func _any_move_limit() -> bool:
	return limits.has("max_speed") or limits.has("max_step")


func _distance(a: Dictionary, b: Dictionary) -> float:
	var dx := float(b["x"]) - float(a["x"])
	var dy := float(b["y"]) - float(a["y"])
	var dz := float(b["z"]) - float(a["z"]) if codec.is_3d() else 0.0
	return sqrt(dx * dx + dy * dy + dz * dz)


# ---- client tick -------------------------------------------------------------------------------------------------------

func _client_tick() -> void:
	if authority == "owner":
		if not _have_local:
			return
		var seq := session.submit_input(codec.encode_state(_local_state))
		_last_sent_seq = seq
		_sent_teleport[seq] = int(_local_state["teleport"])
		_sent_teleport.erase(seq - 256)
		return
	# host mode: start from the host's first state of this player (where it spawned it), send the input, predict the step at once
	if _predictor == null:
		var first := session.try_get_latest(int(_known[local_peer_id]), codec) if _known.has(local_peer_id) else {}
		if first.is_empty():
			return # no state yet: this input is neither sent nor stepped
		var start: Dictionary = first["state"]
		_predictor = OneLobbyReconciler.new(start, func(s: Dictionary, i: Dictionary) -> Dictionary: return _run_step(s, i))
		_predictor.equal = func(a: Dictionary, b: Dictionary) -> bool: return _distance(a, b) <= 0.05
		_last_correct_tick = int(first["tick"]) # the predictor already is this state: no correction, no snap
		smoother.correct(0.0, 0.0, 0.0, int(start["teleport"])) # only records the counter
	var input := codec.quantize_input(_local_input)
	var hseq := session.submit_input(codec.encode_input(input))
	_predictor.predict(hseq, input)


func _client_corrections() -> void:
	if not _known.has(local_peer_id):
		return
	var latest := session.try_get_latest(int(_known[local_peer_id]), codec)
	if latest.is_empty() or int(latest["tick"]) <= _last_correct_tick:
		return
	_last_correct_tick = int(latest["tick"])
	var auth: Dictionary = latest["state"]
	if authority == "owner":
		# the host put me back when the snapshot shows another teleport counter than the one I sent in the input it applied
		var processed := session.last_processed_input
		if _sent_teleport.has(processed) and processed > _ignore_until_seq and int(auth["teleport"]) != int(_sent_teleport[processed]):
			_ignore_until_seq = _last_sent_seq # inputs already on their way still carry the old counter
			_local_state = auth
			_have_local = true
			stats["corrections"] += 1
			corrected.emit(auth)
		return
	if _predictor == null:
		return
	var before: Dictionary = _predictor.current
	var after: Dictionary = _predictor.reconcile(auth, session.last_processed_input)
	var d3 := codec.is_3d()
	var dz := float(after["z"]) - float(before["z"]) if d3 else float(after["y"]) - float(before["y"])
	var snapped := smoother.correct(float(after["x"]) - float(before["x"]), (float(after["y"]) - float(before["y"])) if d3 else 0.0, dz, int(auth["teleport"]))
	if snapped:
		stats["corrections"] += 1


# ---- action events -----------------------------------------------------------------------------------------------------

func _emit_from(player: int, name: String, args_in: Dictionary) -> void:
	var def: Dictionary = W.action_by_name(name)
	var args := args_in
	if name == "shoot" and not args.has("view"):
		args = args.duplicate()
		args["view"] = maxi(0, roundi(session.render_tick * 256.0))
	# what the others see is what the wire carries: quantised
	var bytes := codec.encode_args(name, args)
	var decoded: Variant = codec.decode_args(name, bytes)
	var wire: Dictionary = decoded if decoded != null else {}
	var t := session.clock.tick if is_host else maxi(0, floori(session.server_tick))
	stats["actions_sent"] += 1
	if is_host:
		var p: OLHostPlayer = _host_players.get(player)
		var seq := 0
		if p != null:
			p.relay_seq += 1
			seq = p.relay_seq
		else:
			_my_seq += 1
			seq = _my_seq
		_play({"player": player, "name": name, "args": wire, "tick": t, "seq": seq, "late": false, "local": player == local_peer_id})
		var ev := {"player": player, "seq": seq, "id": int(def["id"]), "tick": t, "args": bytes}
		for c: int in session.clients():
			_enqueue(c, ev)
	else:
		_my_seq += 1
		_play({"player": player, "name": name, "args": wire, "tick": t, "seq": _my_seq, "late": false, "local": true})
		_enqueue(session.host_peer_id, {"player": player, "seq": _my_seq, "id": int(def["id"]), "tick": t, "args": bytes})


## Queue an event for a peer: one copy on `reliable` now, and the next few ticks on `fast`.
func _enqueue(peer: int, ev: Dictionary) -> void:
	session.send_extension(peer, W.encode_player_events([ev]), OneLobbyWire.RELIABLE)
	var box: Array
	if _outboxes.has(peer):
		box = _outboxes[peer]
	else:
		box = []
		_outboxes[peer] = box
	box.append({"ev": ev, "left": EVENT_REPEATS})


func _flush_outboxes() -> void:
	for peer: int in _outboxes:
		var box: Array = _outboxes[peer]
		if box.is_empty():
			continue
		var batch: Array = []
		var size := 8
		for e: Dictionary in box:
			var n := 12 + (e["ev"]["args"] as PackedByteArray).size()
			if batch.size() > 0 and size + n > W.MAX_EVENT_MESSAGE_BYTES:
				break
			batch.append(e["ev"])
			size += n
		session.send_extension(peer, W.encode_player_events(batch), OneLobbyWire.FAST)
		for i in batch.size():
			box[i]["left"] -= 1
		while box.size() > 0 and int(box[0]["left"]) <= 0:
			box.pop_front()


func _dedupe(map: Dictionary, key: int, seq: int) -> bool:
	var d: OLDedupe
	if map.has(key):
		d = map[key]
	else:
		d = OLDedupe.new()
		map[key] = d
	if seq <= d.floor_seq or d.seen.has(seq):
		return false
	d.seen[seq] = true
	while d.seen.has(d.floor_seq + 1):
		d.floor_seq += 1
		d.seen.erase(d.floor_seq)
	if d.seen.size() > 512:
		var lowest := 0x7FFFFFFFFFFFFFFF
		for k: int in d.seen:
			lowest = mini(lowest, k)
		d.floor_seq = lowest - 1
		while d.seen.has(d.floor_seq + 1):
			d.floor_seq += 1
			d.seen.erase(d.floor_seq)
	return true


func _on_events(from: int, payload: PackedByteArray, _channel: int) -> void:
	if not is_host and from != session.host_peer_id:
		return
	var d := W.decode_player_events(payload)
	if d.has("error"):
		session.count_malformed()
		return
	for w: Dictionary in d["events"]:
		if is_host:
			_host_receive(from, w)
		else:
			_client_receive(w)


func _host_receive(from: int, w: Dictionary) -> void:
	var def: Variant = W.action_by_id(int(w["id"]))
	var p: OLHostPlayer = _host_players.get(from)
	if def == null or int(w["player"]) != from or def["origin"] == "host" or not codec.has_event(str(def["name"])) or p == null:
		if _dedupe(_in_dedupe, from, int(w["seq"])):
			stats["actions_rejected"] += 1
		else:
			stats["actions_duplicate"] += 1
		return
	if not _dedupe(_in_dedupe, from, int(w["seq"])):
		stats["actions_duplicate"] += 1
		return
	var args: Variant = codec.decode_args(str(def["name"]), w["args"])
	if args == null:
		stats["actions_rejected"] += 1
		return
	var t := session.clock.tick
	var claimed := mini(t + 1, maxi(t - CLAIM_MAX_AGE_TICKS, int(w["tick"])))
	if not _within_rate(p, str(def["name"]), claimed):
		stats["actions_rate_limited"] += 1
		return
	p.relay_seq += 1
	var seq := p.relay_seq
	_play({"player": from, "name": def["name"], "args": args, "tick": t, "seq": seq, "late": false, "local": false})
	var ev := {"player": from, "seq": seq, "id": int(w["id"]), "tick": t, "args": w["args"]}
	for c: int in session.clients():
		if c != from:
			_enqueue(c, ev)


func _within_rate(p: OLHostPlayer, name: String, claimed_tick: int) -> bool:
	var key := "min_shot_interval_ms" if name == "shoot" else ("min_melee_interval_ms" if name == "melee" else "")
	if key == "" or not limits.has(key):
		return true
	var min_ms := float(limits[key])
	var last := p.last_shot_tick if name == "shoot" else p.last_melee_tick
	var gap_ms := float(claimed_tick - last) * _tick_ms()
	if gap_ms < min_ms * RATE_TOLERANCE - _tick_ms():
		return false
	if name == "shoot":
		p.last_shot_tick = claimed_tick
	else:
		p.last_melee_tick = claimed_tick
	return true


func _client_receive(w: Dictionary) -> void:
	var def: Variant = W.action_by_id(int(w["id"]))
	var args: Variant = codec.decode_args(str(def["name"]), w["args"]) if def != null else null
	if def == null or args == null or not codec.has_event(str(def["name"])):
		stats["actions_rejected"] += 1
		return
	if not _dedupe(_relay_dedupe, int(w["player"]), int(w["seq"])):
		stats["actions_duplicate"] += 1
		return
	var ev := {"player": int(w["player"]), "name": def["name"], "args": args, "tick": int(w["tick"]), "seq": int(w["seq"]), "late": false, "local": false}
	var render := session.render_tick
	if int(w["player"]) == local_peer_id or render <= 0.0:
		_play(ev)
		return
	if float(int(w["tick"])) <= render:
		ev["late"] = true
		stats["actions_late"] += 1
		_play(ev)
		return
	_queue_n += 1
	_queue.append({"ev": ev, "at": int(w["tick"]), "n": _queue_n})


func _play_queue() -> void:
	if _queue.is_empty():
		return
	var render := session.render_tick
	_queue.sort_custom(func(a: Dictionary, b: Dictionary) -> bool:
		if a["at"] != b["at"]:
			return a["at"] < b["at"]
		if a["ev"]["seq"] != b["ev"]["seq"]:
			return a["ev"]["seq"] < b["ev"]["seq"]
		return a["n"] < b["n"])
	while _queue.size() > 0 and float((_queue[0] as Dictionary)["at"]) <= render:
		_play((_queue.pop_front() as Dictionary)["ev"])


func _play(e: Dictionary) -> void:
	stats["actions_played"] += 1
	for h: Callable in (_handlers.get(str(e["name"]), []) as Array).duplicate():
		if h.is_valid():
			h.call(e)
	action_played.emit(e)
