class_name OneLobbyQuantize
extends RefCounted
## Quantization (spec/replication.md "Quantization"): the same float32 rules and the same rounding as the C# reference and
## the JS port, so a value read back is exactly dequantize(quantize(v)) on every engine. GDScript floats are 64-bit; every
## input is rounded to float32 first (`f32`) and every output is a float32 value held in a float.

static var _scratch := PackedByteArray([0, 0, 0, 0])
static var _inv_sqrt2: float = f32(0.70710678)


## The nearest float32 to `v` (as a GDScript float).
static func f32(v: float) -> float:
	_scratch.encode_float(0, v)
	return _scratch.decode_float(0)


## The 32 IEEE-754 bits of a float32.
static func float_bits(v: float) -> int:
	_scratch.encode_float(0, v)
	return _scratch.decode_u32(0)


## The float32 with these 32 bits.
static func bits_float(bits: int) -> float:
	_scratch.encode_u32(0, bits & 0xFFFFFFFF)
	return _scratch.decode_float(0)


static func _max_of(bits: int) -> int:
	return (1 << mini(bits, 32)) - 1


## Round half away from zero (for non-negative input: floor, plus 1 when the fraction is at least a half).
static func _round_half_away(x: float) -> int:
	var neg := x < 0.0
	var a := -x if neg else x
	var r := floori(a)
	var up := r + 1 if a - float(r) >= 0.5 else r
	return -up if neg else up


## Clamp `v` to [min_v, max_v] and map linearly onto 0 .. 2^bits - 1 (NaN becomes min), rounding half away from zero.
static func float_q(v: float, min_v: float, max_v: float, bits: int) -> int:
	v = f32(v)
	min_v = f32(min_v)
	max_v = f32(max_v)
	if not (max_v > min_v):
		push_error("OneLobbyQuantize: max must be greater than min")
		return 0
	if is_nan(v):
		v = min_v
	var t := (minf(maxf(v, min_v), max_v) - min_v) / (max_v - min_v)
	return _round_half_away(t * float(_max_of(bits)))


static func dequantize(q: int, min_v: float, max_v: float, bits: int) -> float:
	min_v = f32(min_v)
	max_v = f32(max_v)
	var m := _max_of(bits)
	return f32(min_v + ((max_v - min_v) * float(mini(q, m))) / float(m))


## Bits needed to cover [min_v, max_v] with a step no larger than `precision`.
static func bits_for(min_v: float, max_v: float, precision: float) -> int:
	var steps := ceili((f32(max_v) - f32(min_v)) / f32(precision))
	var bits := 1
	while bits < 32 and _max_of(bits) < steps:
		bits += 1
	return bits


## Degrees wrapped to [0, 360) mapped onto 0 .. 2^bits - 1 (360 wraps to 0).
static func angle(degrees: float, bits: int) -> int:
	var a := fmod(f32(degrees), 360.0)
	if a < 0.0:
		a += 360.0
	var steps := _max_of(bits) + 1
	return _round_half_away((a / 360.0) * float(steps)) % steps


static func angle_from(q: int, bits: int) -> float:
	return f32((float(q) * 360.0) / float(_max_of(bits) + 1))


## Smallest-three quaternion: {largest, a, b, c}.
static func smallest_three(x: float, y: float, z: float, w: float, bits: int) -> Dictionary:
	var q: Array[float] = [f32(x), f32(y), f32(z), f32(w)]
	var len2 := f32(f32(f32(f32(q[0] * q[0]) + f32(q[1] * q[1])) + f32(q[2] * q[2])) + f32(q[3] * q[3]))
	var length := sqrt(len2)
	if length < 1e-6:
		q = [0.0, 0.0, 0.0, 1.0]
		length = 1.0
	var largest := 0
	for i in 4:
		q[i] = f32(q[i] / length)
		if absf(q[i]) > absf(q[largest]):
			largest = i
	var sign := -1.0 if q[largest] < 0.0 else 1.0
	var o: Array[int] = []
	for i in 4:
		if i != largest:
			o.append(float_q(q[i] * sign, -_inv_sqrt2, _inv_sqrt2, bits))
	return {"largest": largest, "a": o[0], "b": o[1], "c": o[2]}


## Inverse of smallest_three: [x, y, z, w].
static func from_smallest_three(largest: int, a: int, b: int, c: int, bits: int) -> Array[float]:
	var q: Array[float] = [0.0, 0.0, 0.0, 0.0]
	var src := [a, b, c]
	var k := 0
	var sum := 0.0
	var skip := largest & 3
	for i in 4:
		if i == skip:
			continue
		q[i] = dequantize(int(src[k]), -_inv_sqrt2, _inv_sqrt2, bits)
		k += 1
		sum += f32(q[i] * q[i])
	q[skip] = f32(sqrt(maxf(0.0, 1.0 - sum)))
	return q
