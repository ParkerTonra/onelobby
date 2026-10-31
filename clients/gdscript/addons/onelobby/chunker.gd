class_name OneLobbyChunker
extends RefCounted
## Chunking (spec/binary.md "Snapshot and chunks"): split bytes into chunk frames that share one id, and reassemble
## them in any order with duplicates ignored. One OneLobbyChunker per sender (every sender numbers its own ids).

const MAX_PARTIAL_SETS := 8
const MAX_COUNT := 8192

var _partials := {} # id -> {parts: Array, got: int, bytes: int}
var _order: Array[int] = []


## The chunk frames for `data`: every one a complete wire frame (type 0x16) of at most 16384 bytes.
static func split(id: int, data: PackedByteArray, chunk_size: int = OneLobbyWire.DEFAULT_CHUNK, route: int = 0) -> Array[PackedByteArray]:
	chunk_size = clampi(chunk_size, 1, OneLobbyWire.MAX_CHUNK_BODY)
	var count := maxi(1, ceili(float(data.size()) / chunk_size))
	var out: Array[PackedByteArray] = []
	for i in count:
		var f := OneLobbyWire.header(OneLobbyWire.CHUNK, route)
		for k in 4:
			f.append((id >> (8 * k)) & 0xFF)
		f.append(i & 0xFF); f.append((i >> 8) & 0xFF)
		f.append(count & 0xFF); f.append((count >> 8) & 0xFF)
		f.append_array(data.slice(i * chunk_size, mini((i + 1) * chunk_size, data.size())))
		out.append(f)
	return out


## Feeds one chunk body (the bytes after the 3-byte header). Returns {done: true, id, bytes} when the last piece of a
## set arrives, {done: false} while waiting, or {error: text} for a malformed chunk or a set over 64 MiB.
func add(body: PackedByteArray) -> Dictionary:
	if body.size() < 8:
		return {"error": "too_short"}
	var id := body.decode_u32(0)
	var index := body.decode_u16(4)
	var count := body.decode_u16(6)
	var bytes := body.slice(8)
	if count == 0 or index >= count or count > MAX_COUNT:
		return {"error": "bad chunk"}
	var p: Dictionary = _partials.get(id, {})
	if p.is_empty() or (p["parts"] as Array).size() != count:
		_drop(id)
		while _order.size() >= MAX_PARTIAL_SETS:
			_drop(_order[0])
		var parts := []
		parts.resize(count)
		p = {"parts": parts, "got": 0, "bytes": 0}
		_partials[id] = p
		_order.append(id)
	var parts: Array = p["parts"]
	if parts[index] == null:
		parts[index] = bytes
		p["got"] += 1
		p["bytes"] += bytes.size()
	if p["bytes"] > OneLobbyWire.MAX_REASSEMBLED:
		_drop(id)
		return {"error": "chunk set over 64 MiB"}
	if p["got"] < count:
		_evict_over_budget(id)
		return {"done": false}
	_drop(id)
	var all := PackedByteArray()
	for part: PackedByteArray in parts:
		all.append_array(part)
	return {"done": true, "id": id, "bytes": all}


func clear() -> void:
	_partials.clear()
	_order.clear()


func _drop(id: int) -> void:
	_partials.erase(id)
	_order.erase(id)


# Many half-sent sets must not add up to more than one whole message: the oldest others go first.
func _evict_over_budget(keep: int) -> void:
	while _order.size() > 1:
		var total := 0
		for v: Dictionary in _partials.values():
			total += int(v["bytes"])
		if total <= OneLobbyWire.MAX_REASSEMBLED:
			return
		_drop(_order[1] if _order[0] == keep else _order[0])
