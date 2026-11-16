class_name OneLobbyPredictionSmoother
extends RefCounted
## Hides small prediction corrections. The sim adopts the corrected state at once; draw the local player at the sim position
## plus `offset`, which starts at minus the correction and decays linearly to zero over `decay_ms`. A correction past the snap
## thresholds, or with a changed teleport sequence, snaps (offset cleared). Y is up. Call `update` once per rendered frame.
## GDScript twin of JS `PredictionSmoother` and C# `PredictionSmoother`.

## Add this to the sim position when drawing (a Vector3; the maths inside is in doubles).
var offset := Vector3.ZERO
## Corrections that snapped instead of gliding.
var snap_count := 0
var decay_ms: float
var snap_horizontal: float
var snap_vertical: float

var _sx := 0.0
var _sy := 0.0
var _sz := 0.0
var _ox := 0.0
var _oy := 0.0
var _oz := 0.0
var _left_ms := 0.0
var _seq := -1 # -1: none seen yet


## `decay_ms` default 100; `snap_horizontal` (X/Z plane) default 2.0; `snap_vertical` (Y) default 0.5.
func _init(decay: float = 100.0, horizontal: float = 2.0, vertical: float = 0.5) -> void:
	decay_ms = decay
	snap_horizontal = horizontal
	snap_vertical = vertical


## Length of `offset` (for a debug overlay).
func offset_remaining() -> float:
	return sqrt(_ox * _ox + _oy * _oy + _oz * _oz)


## Report a correction: `error_*` is the corrected sim position minus the position before it. Pass the state's teleport counter
## as `sequence` (or -1 for none) to snap whenever it differs from the last one seen (the first one only records it). Returns
## true when it snapped.
func correct(error_x: float, error_y: float, error_z: float, sequence: int = -1) -> bool:
	var seq_changed := sequence >= 0 and _seq >= 0 and sequence != _seq
	if sequence >= 0:
		_seq = sequence
	if seq_changed or sqrt(error_x * error_x + error_z * error_z) > snap_horizontal or absf(error_y) > snap_vertical:
		snap()
		snap_count += 1
		return true
	if error_x == 0.0 and error_y == 0.0 and error_z == 0.0:
		return false
	_sx = _ox - error_x
	_sy = _oy - error_y
	_sz = _oz - error_z
	_left_ms = decay_ms
	if decay_ms > 0.0:
		_set_offset(_sx, _sy, _sz)
	else:
		_set_offset(0.0, 0.0, 0.0)
	return false


## Advance the decay by one frame's time.
func update(delta_ms: float) -> void:
	if _left_ms <= 0.0:
		return
	_left_ms = maxf(0.0, _left_ms - delta_ms)
	var k := _left_ms / decay_ms if decay_ms > 0.0 else 0.0
	_set_offset(_sx * k, _sy * k, _sz * k)


## Clear the offset now.
func snap() -> void:
	_left_ms = 0.0
	_sx = 0.0
	_sy = 0.0
	_sz = 0.0
	_set_offset(0.0, 0.0, 0.0)


func _set_offset(x: float, y: float, z: float) -> void:
	_ox = x
	_oy = y
	_oz = z
	offset = Vector3(x, y, z)
