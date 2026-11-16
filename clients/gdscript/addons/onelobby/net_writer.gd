class_name OneLobbyNetWriter
extends RefCounted
## Bit-packed state writer (spec/replication.md "State bits"): bits LSB first, the same packing as C# `NetWriter` and JS
## `NetWriter`. One entity state is at most 255 bytes (2040 bits). Reuse one writer; call `reset()` between states.
##
##     func write(w: OneLobbyNetWriter) -> void:
##         w.write_quantized(position.x, -256.0, 256.0, 16)
##         w.write_angle(yaw, 9)
##         w.write_bits(health, 7)

var _buf := PackedByteArray()
var _bits := 0


## Bits written so far.
func bit_count() -> int:
	return _bits


## Bytes the state occupies (the unused high bits of the last byte are zero).
func byte_count() -> int:
	return (_bits + 7) >> 3


func reset() -> void:
	_buf.fill(0)
	_bits = 0


## Write the low `bits` (1..32) bits of `value`; higher bits are discarded. Any other width is a programming error.
func write_bits(value: int, bits: int) -> void:
	if bits < 1 or bits > 32:
		push_error("OneLobbyNetWriter: bits must be 1..32")
		return
	var v := value & ((1 << bits) - 1)
	var need := (_bits + bits + 7) >> 3
	if need > _buf.size():
		_buf.resize(need)
	var pos := _bits
	var left := bits
	while left > 0:
		var off := pos & 7
		var take := mini(8 - off, left)
		var bi := pos >> 3
		_buf[bi] = _buf[bi] | ((v & ((1 << take) - 1)) << off)
		v >>= take
		pos += take
		left -= take
	_bits += bits


func write_bool(v: bool) -> void:
	write_bits(1 if v else 0, 1)


func write_byte(v: int) -> void:
	write_bits(v, 8)


func write_uint16(v: int) -> void:
	write_bits(v, 16)


func write_uint32(v: int) -> void:
	write_bits(v, 32)


func write_int32(v: int) -> void:
	write_bits(v, 32)


## Full-precision float (32 bits). Prefer the quantized writers for anything that moves every tick.
func write_float(v: float) -> void:
	write_bits(OneLobbyQuantize.float_bits(v), 32)


## Clamp to [min_v, max_v] and write in `bits` bits (see OneLobbyQuantize.float_q).
func write_quantized(v: float, min_v: float, max_v: float, bits: int) -> void:
	write_bits(OneLobbyQuantize.float_q(v, min_v, max_v, bits), bits)


## An angle in degrees, wrapped to [0, 360), in `bits` bits.
func write_angle(degrees: float, bits: int) -> void:
	write_bits(OneLobbyQuantize.angle(degrees, bits), bits)


## Unit quaternion, smallest-three: 2 bits index + 3 x `bits_per_component` (default 9: 29 bits).
func write_quaternion(x: float, y: float, z: float, w: float, bits_per_component: int = 9) -> void:
	var q := OneLobbyQuantize.smallest_three(x, y, z, w, bits_per_component)
	write_bits(int(q["largest"]), 2)
	write_bits(int(q["a"]), bits_per_component)
	write_bits(int(q["b"]), bits_per_component)
	write_bits(int(q["c"]), bits_per_component)


## A copy of the bytes written.
func to_bytes() -> PackedByteArray:
	return _buf.slice(0, byte_count())
