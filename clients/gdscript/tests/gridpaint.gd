extends RefCounted
## Gridpaint, the shared demo game (spec/demo-game.md), for the GDScript tests: the lockstep sim the conformance adapter,
## tests/sync.gd and the engine-smoke peer run through `lobby.lockstep`. A port of spec/reference/gridpaint.mjs; the goldens
## in spec/vectors/gridpaint.json (checked by tests/sync.gd) say it is right. Hashes are u64 values held in an int.

const W := 16
const H := 16
const OP_PAINT := 1
const DX := [0, 1, 0, -1]
const DY := [-1, 0, 1, 0]

var tick := 0
var rng := 1
var grid := PackedByteArray()


func _init(code: String = "000000") -> void:
	grid.resize(W * H)
	rng = seed_from_code(code)


static func colour_of(peer_id: int) -> int:
	return ((peer_id - 1) % 15) + 1


static func paint_cmd(x: int, y: int) -> PackedByteArray:
	return PackedByteArray([OP_PAINT, x, y])


static func seed_from_code(code: String) -> int:
	var h := 0x811c9dc5
	for b in OneLobbyJoinCode.normalize(code).to_utf8_buffer():
		h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
	return 1 if h == 0 else h


static func xorshift32(v: int) -> int:
	v ^= (v << 13) & 0xFFFFFFFF
	v ^= v >> 17
	v ^= (v << 5) & 0xFFFFFFFF
	return v & 0xFFFFFFFF


## Applies one tick. `commands`: [{peer_id, bytes}] in frame order. Returns the hash after the tick.
func step(t: int, commands: Array) -> int:
	assert(t == tick + 1, "gridpaint: expected tick %d, got %d" % [tick + 1, t])
	for c: Dictionary in commands:
		apply(int(c["peer_id"]), c["bytes"])
	spread()
	tick = t
	return hash_grid()


func apply(peer_id: int, bytes: PackedByteArray) -> void:
	if bytes.size() != 3 or bytes[0] != OP_PAINT:
		return # malformed: ignored, still deterministic
	if bytes[1] >= W or bytes[2] >= H:
		return
	grid[bytes[2] * W + bytes[1]] = colour_of(peer_id)


func spread() -> void:
	var old := grid.duplicate()
	for i in W * H:
		if old[i] == 0:
			continue
		rng = xorshift32(rng)
		var d := rng % 4
		var x: int = (i % W) + DX[d]
		var y: int = (i / W) + DY[d]
		if x < 0 or x >= W or y < 0 or y >= H:
			continue
		grid[y * W + x] = old[i]


## FNV-1a 64 over the grid (u64 in an int).
func hash_grid() -> int:
	var h := -3750763034362895579 # 0xcbf29ce484222325
	for b in grid:
		h = (h ^ b) * 0x100000001b3
	return h


## rng:u32 little-endian, then the 256 grid bytes (the tick travels in the snapshot header).
func snapshot() -> PackedByteArray:
	var o := PackedByteArray()
	o.resize(4)
	o.encode_u32(0, rng)
	o.append_array(grid)
	return o


func restore(t: int, bytes: PackedByteArray) -> bool:
	if bytes.size() != 4 + W * H:
		return false
	tick = t
	rng = bytes.decode_u32(0)
	grid = bytes.slice(4)
	return true
