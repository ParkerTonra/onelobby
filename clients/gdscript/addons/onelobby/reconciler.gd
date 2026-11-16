class_name OneLobbyReconciler
extends RefCounted
## Client-side prediction for the local player (Gambetta: sequence numbers, the host echoes the last input it processed, the
## client re-applies the inputs the host has not seen yet). GDScript twin of JS `Reconciler` and C# `Reconciler`.
## `step` is the game's own movement function, `Callable(state, input) -> state`; it must match what the host runs.
##
##     var r := OneLobbyReconciler.new(start_state, step_fn)
##     var seq := rep.submit_input(bytes)
##     r.predict(seq, input)                                  # draw r.current
##     r.reconcile(host_state, rep.last_processed_input)      # when a newer snapshot arrives

## The predicted state: render this for the local player.
var current: Variant
## Corrections where the replayed state differed from the prediction (needs `equal`).
var corrections := 0
## Optional `Callable(a, b) -> bool` used to count `corrections`.
var equal := Callable()

var _pending: Array = [] # [{seq, input}]
var _step: Callable


func _init(initial: Variant, step: Callable) -> void:
	current = initial
	_step = step


func pending_count() -> int:
	return _pending.size()


## Apply one local input now (call with the seq `submit_input` returned). Keeps at most 256 unconfirmed inputs.
func predict(seq: int, input: Variant) -> Variant:
	_pending.append({"seq": seq, "input": input})
	if _pending.size() > 256:
		_pending.pop_front()
	current = _step.call(current, input)
	return current


## The host says: after input `last_processed_seq` you were at `authoritative`. Replay the inputs it has not seen.
func reconcile(authoritative: Variant, last_processed_seq: int) -> Variant:
	var keep: Array = []
	for p: Dictionary in _pending:
		if int(p["seq"]) > last_processed_seq:
			keep.append(p)
	_pending = keep
	var s: Variant = authoritative
	for p: Dictionary in _pending:
		s = _step.call(s, p["input"])
	if equal.is_valid() and not bool(equal.call(s, current)):
		corrections += 1
	current = s
	return s
