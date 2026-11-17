class_name OneLobbyNetworkClock
extends RefCounted
## Fixed-step tick clock over a monotonic millisecond source (JS `NetworkClock`, C# `NetworkClock`). The game runs one
## simulation step per `try_advance()` that returns true, so the step rate is independent of the frame rate.

## Last tick handed out (0 before the first).
var tick := 0
## At most this many ticks run back to back after a stall; older ones are skipped.
var max_catch_up := 5
var tick_rate := 30

var _now: Callable
var _start_ms := 0
var _started := false


## `now_fn`: a Callable giving monotonic milliseconds (a lobby's `now_ms`).
func _init(rate: int, now_fn: Callable) -> void:
	if rate < 1 or rate > 240:
		push_error("OneLobbyNetworkClock: tick_rate must be 1..240")
		rate = clampi(rate, 1, 240)
	tick_rate = rate
	_now = now_fn


func tick_ms() -> float:
	return 1000.0 / float(tick_rate)


## Fraction (0..1) of the way from `tick` to the next tick, for rendering a local sim smoothly.
func alpha() -> float:
	if not _started:
		return 0.0
	var t := float(int(_now.call()) - _start_ms) / tick_ms() - float(tick)
	return minf(1.0, maxf(0.0, t))


## True when the next tick is due; advances `tick`. Call in a while loop each frame.
func try_advance() -> bool:
	var now := int(_now.call())
	if not _started:
		_started = true
		_start_ms = now - ceili(tick_ms())
	var due := floori(float(now - _start_ms) / tick_ms())
	if due <= tick:
		return false
	if due - tick > max_catch_up:
		tick = due - max_catch_up # skip the backlog by number: the epoch stays, so the tick numbers stay on the schedule
	tick += 1
	return true
