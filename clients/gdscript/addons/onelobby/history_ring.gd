class_name OneLobbyHistoryRing
extends RefCounted
## Host-side lag compensation history: record each entity's hit volume (or pose) every tick, then ask for it at the tick the
## shooter was seeing (`view_tick` of an input, clamped by `OneLobbyReplicationSession.rewind_tick`). `lerp_fn` is
## `Callable(a, b, t) -> value`. GDScript twin of JS `HistoryRing` and C# `HistoryRing<T>`.

var _capacity: int
var _lerp: Callable
var _rings := {} # id -> Array of null | {tick, value}


func _init(capacity_ticks: int, lerp_fn: Callable) -> void:
	if capacity_ticks < 2:
		push_error("OneLobbyHistoryRing: capacity_ticks must be at least 2")
		capacity_ticks = 2
	_capacity = capacity_ticks
	_lerp = lerp_fn


func record(tick: int, id: int, value: Variant) -> void:
	var ring: Array
	if _rings.has(id):
		ring = _rings[id]
	else:
		ring = []
		ring.resize(_capacity)
		_rings[id] = ring
	ring[tick % _capacity] = {"tick": tick, "value": value}


func forget(id: int) -> void:
	_rings.erase(id)


## The value at a fractional tick, interpolated between the two recorded ticks around it; null when not held.
func try_sample(id: int, tick: float) -> Variant:
	if not _rings.has(id) or tick < 0.0:
		return null
	var ring: Array = _rings[id]
	var a := floori(tick)
	var ea: Variant = ring[a % _capacity]
	if ea == null or int(ea["tick"]) != a or a == 0:
		# nothing at a: accept an exact hit on the next tick only
		var eb0: Variant = ring[(a + 1) % _capacity]
		if eb0 != null and int(eb0["tick"]) == a + 1 and absf(tick - float(a + 1)) < 1e-9:
			return eb0["value"]
		return null
	var frac := tick - float(a)
	var eb: Variant = ring[(a + 1) % _capacity]
	if eb != null and int(eb["tick"]) == a + 1 and frac > 0.0:
		return _lerp.call(ea["value"], eb["value"], frac)
	return ea["value"]
