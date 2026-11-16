class_name OneLobbyNetMath
extends RefCounted
## Small interpolation helpers for a state schema's `lerp` (same as C# `NetMath` and JS `NetMath`).

static func lerp_value(a: float, b: float, t: float) -> float:
	return a + (b - a) * t


## Lerp, but return `b` when the two samples are more than `max_distance` apart (a teleport is a jump, not a streak).
static func lerp_or_snap(a: float, b: float, t: float, max_distance: float) -> float:
	return b if absf(b - a) > max_distance else a + (b - a) * t


## Lerp between two angles in degrees along the shorter arc; the result is in [0, 360).
static func lerp_angle(a: float, b: float, t: float) -> float:
	var d := fmod(b - a, 360.0)
	if d > 180.0:
		d -= 360.0
	if d < -180.0:
		d += 360.0
	var r := fmod(a + d * t, 360.0)
	return r + 360.0 if r < 0.0 else r
