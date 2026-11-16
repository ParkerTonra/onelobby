class_name OneLobbyNetReader
extends RefCounted
## Reads what OneLobbyNetWriter wrote, in the same order. Reading past the end returns zero bits and sets `overrun`
## (the flag stays set), as in C# `NetReader` and JS `NetReader`.

## True when a read went past the end of the state (a schema mismatch).
var overrun := false

var _buf := PackedByteArray()
var _bits := 0


func _init(data: PackedByteArray = PackedByteArray()) -> void:
	_buf = data


func reset(data: PackedByteArray) -> void:
	_buf = data
	_bits = 0
	overrun = false


## Read `bits` (1..32) bits; the bits past the end are zero.
func read_bits(bits: int) -> int:
	if bits < 1 or bits > 32:
		push_error("OneLobbyNetReader: bits must be 1..32")
		return 0
	var v := 0
	var got := 0
	var size := _buf.size()
	while got < bits:
		var bi := _bits >> 3
		var off := _bits & 7
		var take := mini(8 - off, bits - got)
		if bi >= size:
			overrun = true
		else:
			v |= ((int(_buf[bi]) >> off) & ((1 << take) - 1)) << got
		_bits += take
		got += take
	return v


func read_bool() -> bool:
	return read_bits(1) != 0


func read_byte() -> int:
	return read_bits(8)


func read_uint16() -> int:
	return read_bits(16)


func read_uint32() -> int:
	return read_bits(32)


func read_int32() -> int:
	var v := read_bits(32)
	return v - 0x100000000 if v >= 0x80000000 else v


func read_float() -> float:
	return OneLobbyQuantize.bits_float(read_bits(32))


func read_quantized(min_v: float, max_v: float, bits: int) -> float:
	return OneLobbyQuantize.dequantize(read_bits(bits), min_v, max_v, bits)


func read_angle(bits: int) -> float:
	return OneLobbyQuantize.angle_from(read_bits(bits), bits)


## [x, y, z, w]
func read_quaternion(bits_per_component: int = 9) -> Array[float]:
	var largest := read_bits(2)
	var a := read_bits(bits_per_component)
	var b := read_bits(bits_per_component)
	var c := read_bits(bits_per_component)
	return OneLobbyQuantize.from_smallest_three(largest, a, b, c, bits_per_component)
