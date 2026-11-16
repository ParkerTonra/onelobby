class_name OneLobbyReplicationProtocol
extends RefCounted
## The replication wire format (spec/replication.md, version 1): snapshot, input, event and stream event messages, `peek`
## and `describe`. Pure functions, no lobby. Every message is the body of one lobby `raw` frame and starts 0x52 'R',
## version 1, kind. Byte for byte the same as the C# reference (`Protocol.cs`) and the JS port (`protocol.ts`).
##
## A world is `{"tick": int, "ents": Array}` with the entities sorted by id; an entity is
## `{"id": int, "type": int, "owner": int, "state": PackedByteArray}`; the state is never mutated, only replaced.
## Decoders never throw and never print: a malformed message comes back as `{"error": "<name>"}` with one of the names
## in `ERRORS` (the table in the spec); a good one has no "error" key.

const MAGIC := 0x52
const VERSION := 1
const KIND_SNAPSHOT := 1
const KIND_INPUT := 2
const KIND_EVENT := 3
const KIND_STREAM_EVENT := 4
const MAX_STATE_BYTES := 255

## Every error name of the spec.
const ERRORS: Array[String] = ["too_short", "trailing", "varint", "range", "tick", "baseline", "id", "op", "delta", "despawn", "full", "seq", "stream_0", "seq_0"]

const _OP_DELTA := 0
const _OP_FULL := 1
const _OP_DESPAWN := 2
const _U32 := 0xFFFFFFFF


## Cursor over a message; the first error sticks in `err` and every later read returns zero / empty.
class OLByteReader:
	var s: PackedByteArray
	var p := 0
	var err := ""

	func _init(data: PackedByteArray, start: int = 0) -> void:
		s = data
		p = start

	func remaining() -> int:
		return s.size() - p

	func u8() -> int:
		if err != "":
			return 0
		if p >= s.size():
			err = "too_short"
			return 0
		p += 1
		return s[p - 1]

	## An unsigned LEB128 of up to 64 bits in an int (a value of 2^63 or more reads as negative: callers range-check).
	func varuint() -> int:
		var v := 0
		var shift := 0
		while shift < 70:
			var b := u8()
			if err != "":
				return 0
			if shift == 63 and b > 1:
				err = "varint"
				return 0
			v |= (b & 0x7F) << shift
			if (b & 0x80) == 0:
				return v
			shift += 7
		err = "varint"
		return 0

	## A varuint that must fit 32 bits.
	func var32() -> int:
		var v := varuint()
		if err != "":
			return 0
		if v < 0 or v > 0xFFFFFFFF:
			err = "range"
			return 0
		return v

	func bytes(n: int) -> PackedByteArray:
		if err != "":
			return PackedByteArray()
		if n < 0 or n > remaining():
			err = "too_short"
			return PackedByteArray()
		p += n
		return s.slice(p - n, p)

	func rest() -> PackedByteArray:
		return bytes(remaining())


# ---- small helpers -------------------------------------------------------------------------------------------------

## True when this raw payload is a replication message (at least 3 bytes, first byte 0x52).
static func is_replication(p: PackedByteArray) -> bool:
	return p.size() >= 3 and p[0] == MAGIC


static func fail(name: String) -> Dictionary:
	return {"error": name}


## Index of `id` in the world's entities, or -1.
static func index_of(w: Dictionary, id: int) -> int:
	var ents: Array = w["ents"]
	var lo := 0
	var hi := ents.size() - 1
	while lo <= hi:
		var mid := (lo + hi) >> 1
		var v: int = ents[mid]["id"]
		if v == id:
			return mid
		if v < id:
			lo = mid + 1
		else:
			hi = mid - 1
	return -1


static func _varuint(b: PackedByteArray, v: int) -> void:
	while v >= 0x80 or v < 0:
		b.append((v & 0x7F) | 0x80)
		v = (v >> 7) & 0x01FFFFFFFFFFFFFF
	b.append(v)


static func _header(kind: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.append(MAGIC)
	b.append(VERSION)
	b.append(kind)
	return b


# ---- snapshot ------------------------------------------------------------------------------------------------------

static func _rec_head(recs: PackedByteArray, prev: Array, id: int, op: int) -> void:
	_varuint(recs, (id - int(prev[0])) * 4 + op)
	prev[0] = id


static func _full(recs: PackedByteArray, prev: Array, e: Dictionary) -> void:
	_rec_head(recs, prev, e["id"], _OP_FULL)
	_varuint(recs, e["type"])
	_varuint(recs, e["owner"])
	var st: PackedByteArray = e["state"]
	_varuint(recs, st.size())
	recs.append_array(st)


## Encode `cur` as a delta against `baseline` (null = a full snapshot).
static func encode_snapshot(cur: Dictionary, baseline: Variant, last_input_seq: int) -> PackedByteArray:
	var w := _header(KIND_SNAPSHOT)
	var recs := PackedByteArray()
	_varuint(w, cur["tick"])
	_varuint(w, int(cur["tick"]) - int(baseline["tick"]) if baseline != null else 0)
	_varuint(w, last_input_seq)
	var bas: Array = baseline["ents"] if baseline != null else []
	var c: Array = cur["ents"]
	var i := 0
	var j := 0
	var count := 0
	var prev := [0]
	while i < c.size() or j < bas.size():
		if j >= bas.size() or (i < c.size() and int(c[i]["id"]) < int(bas[j]["id"])):
			_full(recs, prev, c[i])
			i += 1
			count += 1
		elif i >= c.size() or int(bas[j]["id"]) < int(c[i]["id"]):
			_rec_head(recs, prev, bas[j]["id"], _OP_DESPAWN)
			j += 1
			count += 1
		else:
			var a: Dictionary = c[i]
			var b: Dictionary = bas[j]
			i += 1
			j += 1
			var sa: PackedByteArray = a["state"]
			var sb: PackedByteArray = b["state"]
			if a["type"] != b["type"] or a["owner"] != b["owner"] or sa.size() != sb.size():
				_full(recs, prev, a)
				count += 1
				continue
			if sa == sb:
				continue
			_rec_head(recs, prev, a["id"], _OP_DELTA)
			var n := sa.size()
			var mask := PackedByteArray()
			mask.resize((n + 7) >> 3)
			var changed := PackedByteArray()
			for k in n:
				if sa[k] != sb[k]:
					mask[k >> 3] = mask[k >> 3] | (1 << (k & 7))
					changed.append(sa[k])
			recs.append_array(mask)
			recs.append_array(changed)
			count += 1
	_varuint(w, count)
	w.append_array(recs)
	return w


## Reads only the header so the caller can find the baseline: {tick, baseline_tick, last_input}, or {"error"}.
static func peek_snapshot(p: PackedByteArray) -> Dictionary:
	var r := OLByteReader.new(p, 3)
	var tick := r.var32()
	var back := r.var32()
	var last := r.var32()
	if r.err != "":
		return fail(r.err)
	if tick == 0 or back > tick:
		return fail("tick")
	return {"tick": tick, "baseline_tick": 0 if back == 0 else tick - back, "last_input": last}


## Apply a snapshot to its baseline (null for a full snapshot): the new world, or {"error"}.
static func decode_snapshot(p: PackedByteArray, baseline: Variant) -> Dictionary:
	var r := OLByteReader.new(p, 3)
	var tick := r.var32()
	var back := r.var32()
	r.var32()
	if r.err != "":
		return fail(r.err)
	if tick == 0 or back > tick:
		return fail("tick")
	if (back == 0) != (baseline == null):
		return fail("baseline")
	var count := r.varuint()
	if r.err != "":
		return fail(r.err)
	var bas: Array = baseline["ents"] if baseline != null else []
	var out: Array = []
	var j := 0
	var prev := 0
	var n := 0
	while count < 0 or n < count:
		n += 1
		var head := r.varuint()
		if r.err != "":
			return fail(r.err)
		var op := head & 3
		var delta := (head >> 2) & 0x3FFFFFFFFFFFFFFF
		if delta == 0 or prev + delta > _U32:
			return fail("id")
		var id := prev + delta
		prev = id
		while j < bas.size() and int(bas[j]["id"]) < id:
			out.append(bas[j])
			j += 1
		var in_base := j < bas.size() and int(bas[j]["id"]) == id
		match op:
			_OP_FULL:
				var type := r.varuint()
				var owner := r.varuint()
				var len := r.varuint()
				if r.err != "":
					return fail(r.err)
				if type < 0 or type > 65535 or owner < 0 or owner > 0x7FFFFFFF or len < 0 or len > MAX_STATE_BYTES:
					return fail("full")
				var st := r.bytes(len)
				if r.err != "":
					return fail(r.err)
				out.append({"id": id, "type": type, "owner": owner, "state": st})
				if in_base:
					j += 1
			_OP_DESPAWN:
				if not in_base:
					return fail("despawn")
				j += 1
			_OP_DELTA:
				if not in_base:
					return fail("delta")
				var b: Dictionary = bas[j]
				j += 1
				var bst: PackedByteArray = b["state"]
				var size := bst.size()
				var mask := r.bytes((size + 7) >> 3)
				if r.err != "":
					return fail(r.err)
				var st2 := bst.duplicate()
				for k in size:
					if ((mask[k >> 3] >> (k & 7)) & 1) != 0:
						st2[k] = r.u8()
				if r.err != "":
					return fail(r.err)
				out.append({"id": id, "type": b["type"], "owner": b["owner"], "state": st2})
			_:
				return fail("op")
	while j < bas.size():
		out.append(bas[j])
		j += 1
	if r.remaining() != 0:
		return fail("trailing")
	return {"tick": tick, "ents": out}


# ---- input ---------------------------------------------------------------------------------------------------------

## `newest_first`: entries `{view256, bytes}` for seq newest_seq, newest_seq - 1, ...; the first `count` are written
## (-1 = all of them).
static func encode_input(ack: int, newest_seq: int, newest_first: Array, count: int = -1) -> PackedByteArray:
	var w := _header(KIND_INPUT)
	var n := newest_first.size() if count < 0 else count
	_varuint(w, ack)
	_varuint(w, newest_seq)
	w.append(n & 0xFF)
	for i in n:
		var e: Dictionary = newest_first[i]
		var b: PackedByteArray = e["bytes"]
		_varuint(w, e["view256"])
		_varuint(w, b.size())
		w.append_array(b)
	return w


## {ack, newest_seq, inputs: [{seq, view256, bytes}]}, or {"error"}.
static func decode_input(p: PackedByteArray) -> Dictionary:
	var r := OLByteReader.new(p, 3)
	var ack := r.var32()
	var newest := r.var32()
	var n := r.u8()
	if r.err != "":
		return fail(r.err)
	if n > newest:
		return fail("seq")
	var inputs: Array = []
	for i in n:
		var view256 := r.varuint()
		var len := r.varuint()
		if r.err != "":
			return fail(r.err)
		if len < 0 or len > 0x7FFFFFFF:
			len = 0x7FFFFFFF
		var b := r.bytes(len)
		if r.err != "":
			return fail(r.err)
		inputs.append({"seq": newest - i, "view256": view256, "bytes": b})
	if r.remaining() != 0:
		return fail("trailing")
	return {"ack": ack, "newest_seq": newest, "inputs": inputs}


# ---- events --------------------------------------------------------------------------------------------------------

static func encode_event(tick: int, payload: PackedByteArray) -> PackedByteArray:
	var w := _header(KIND_EVENT)
	_varuint(w, tick)
	w.append_array(payload)
	return w


## {tick, payload}, or {"error"}.
static func decode_event(p: PackedByteArray) -> Dictionary:
	var r := OLByteReader.new(p, 3)
	var tick := r.var32()
	if r.err != "":
		return fail(r.err)
	return {"tick": tick, "payload": r.rest()}


static func encode_stream_event(tick: int, stream: int, seq: int, payload: PackedByteArray) -> PackedByteArray:
	var w := _header(KIND_STREAM_EVENT)
	_varuint(w, tick)
	w.append(stream & 0xFF)
	_varuint(w, seq)
	w.append_array(payload)
	return w


## {tick, stream, seq, payload}, or {"error"}.
static func decode_stream_event(p: PackedByteArray) -> Dictionary:
	var r := OLByteReader.new(p, 3)
	var tick := r.var32()
	var stream := r.u8()
	if r.err != "":
		return fail(r.err)
	if stream == 0:
		return fail("stream_0")
	var seq := r.var32()
	if r.err != "":
		return fail(r.err)
	if seq == 0:
		return fail("seq_0")
	return {"tick": tick, "stream": stream, "seq": seq, "payload": r.rest()}


# ---- debug view ----------------------------------------------------------------------------------------------------

static func to_hex(b: PackedByteArray) -> String:
	return b.hex_encode()


static func from_hex(h: String) -> PackedByteArray:
	return h.hex_decode()


static func _payload(o: Dictionary, key: String, b: PackedByteArray) -> void:
	o["len"] = b.size()
	o[key] = b.hex_encode()


## One replication message as a plain JSON-able Dictionary (spec/replication.md "Debug view", key order as in the spec).
## A delta record needs its baseline (the state length decides the mask size), so pass the baseline world when known.
## Never fails.
static func describe(p: PackedByteArray, baseline: Variant = null) -> Dictionary:
	if not is_replication(p):
		return {"kind": "other", "bytes": p.size()}
	if p[1] != VERSION:
		return {"kind": "ignored", "reason": "version", "version": p[1], "bytes": p.size()}
	var names := {1: "snapshot", 2: "input", 3: "event", 4: "streamEvent"}
	if not names.has(int(p[2])):
		return {"kind": "unknown", "number": p[2], "bytes": p.size()}
	var kind: String = names[int(p[2])]
	var out := {"kind": kind, "bytes": p.size()}
	var r := OLByteReader.new(p, 3)
	match int(p[2]):
		KIND_SNAPSHOT:
			_describe_snapshot(r, out, baseline)
		KIND_INPUT:
			_describe_input(r, out)
		KIND_EVENT:
			out["tick"] = r.var32()
			if r.err == "":
				_payload(out, "payload", r.rest())
		_:
			var tick := r.var32()
			var stream := r.u8()
			if r.err == "" and stream == 0:
				r.err = "stream_0"
			var seq := r.var32()
			if r.err == "" and seq == 0:
				r.err = "seq_0"
			if r.err == "":
				out["tick"] = tick
				out["stream"] = stream
				out["seq"] = seq
				_payload(out, "payload", r.rest())
	if r.err != "":
		return {"kind": kind, "bytes": p.size(), "error": r.err}
	return out


static func _describe_input(r: OLByteReader, out: Dictionary) -> void:
	var ack := r.var32()
	var newest := r.var32()
	var n := r.u8()
	if r.err == "" and n > newest:
		r.err = "seq"
	var inputs: Array = []
	var i := 0
	while r.err == "" and i < n:
		var view := r.varuint()
		var len := r.varuint()
		if r.err != "":
			break
		if len < 0 or len > 0x7FFFFFFF:
			len = 0x7FFFFFFF
		var e := {"seq": newest - i, "view256": view}
		_payload(e, "hex", r.bytes(len))
		inputs.append(e)
		i += 1
	if r.err == "" and r.remaining() != 0:
		r.err = "trailing"
	if r.err != "":
		return
	out["ack"] = ack
	out["newest"] = newest
	out["n"] = n
	out["inputs"] = inputs


static func _describe_snapshot(r: OLByteReader, out: Dictionary, baseline: Variant) -> void:
	var tick := r.var32()
	var back := r.var32()
	var last := r.var32()
	if r.err == "" and (tick == 0 or back > tick):
		r.err = "tick"
	var count := r.varuint()
	if r.err != "":
		return
	out["tick"] = tick
	out["back"] = back
	out["baselineTick"] = 0 if back == 0 else tick - back
	out["lastInput"] = last
	out["count"] = count
	var records: Array = []
	out["records"] = records
	var prev := 0
	var truncated := false
	var n := 0
	while (count < 0 or n < count) and not truncated:
		n += 1
		var head := r.varuint()
		if r.err != "":
			return
		var delta := (head >> 2) & 0x3FFFFFFFFFFFFFFF
		if delta == 0 or prev + delta > _U32:
			r.err = "id"
			return
		var id := prev + delta
		prev = id
		var rec := {"id": id}
		match head & 3:
			_OP_FULL:
				var type := r.varuint()
				var owner := r.varuint()
				var len := r.varuint()
				if r.err != "":
					return
				if type < 0 or type > 65535 or owner < 0 or owner > 0x7FFFFFFF or len < 0 or len > MAX_STATE_BYTES:
					r.err = "full"
					return
				rec["op"] = "full"
				rec["type"] = type
				rec["owner"] = owner
				_payload(rec, "state", r.bytes(len))
				if r.err != "":
					return
			_OP_DESPAWN:
				rec["op"] = "despawn"
			_OP_DELTA:
				rec["op"] = "delta"
				if baseline == null:
					rec["unknown"] = true
					truncated = true
				else:
					var at := index_of(baseline, id)
					if at < 0:
						r.err = "delta"
						return
					var size: int = (baseline["ents"][at]["state"] as PackedByteArray).size()
					var mask := r.bytes((size + 7) >> 3)
					if r.err != "":
						return
					var changed: Array = []
					for k in size:
						if ((mask[k >> 3] >> (k & 7)) & 1) != 0:
							changed.append(k)
					var vals := PackedByteArray()
					for _k in changed.size():
						vals.append(r.u8())
					if r.err != "":
						return
					rec["changed"] = changed
					rec["values"] = vals.hex_encode()
			_:
				r.err = "op"
				return
		records.append(rec)
	if truncated:
		out["truncated"] = true
	elif r.remaining() != 0:
		r.err = "trailing"
