class_name OneLobbyPlayerCodec
extends RefCounted
## Encodes and decodes the networked player preset for one configuration (spec/net-player.md sections 2 to 4): the state, the
## input preset of host-decides mode and the arguments of the action events. GDScript twin of JS `PlayerCodec`: same bytes,
## same order of fields. Positions go through `OneLobbyNetWriter` as doubles (never through a Vector3: its components are 32-bit).
##
## It is also a state schema for `OneLobbyReplicationSession` (`read`, `write`, `interpolate`).
##
## `config`: `space` "3d" | "2d", `range` (metres, default 300), `velocity_range` (default 32), `omit` (names left out, the file's
## spelling or snake_case). A bad value reports one error and the default is used for that key.

const W := preload("res://addons/onelobby/net_player_wire.gd")

const VEL_BITS := 10
const YAW_BITS := 12
const PITCH_BITS := 10
const MOVE_BITS := 7

var space := "3d"
var range_value := 300.0
var velocity_range := 32.0
var omit: Array[String] = []
var pos_bits := 16

var _omitted := {}
var _w := OneLobbyNetWriter.new()
var _r := OneLobbyNetReader.new()
var _state_bytes := -1
var _input_bytes := -1


func _init(config: Dictionary = {}) -> void:
	space = str(config.get("space", "3d"))
	if space != "2d" and space != "3d":
		push_error("OneLobbyPlayerCodec: space must be \"2d\" or \"3d\"")
		space = "3d"
	range_value = float(config.get("range", 300))
	if not (range_value > 0.0):
		push_error("OneLobbyPlayerCodec: range must be positive")
		range_value = 300.0
	velocity_range = float(config.get("velocity_range", 32))
	if not (velocity_range > 0.0):
		push_error("OneLobbyPlayerCodec: velocity_range must be positive")
		velocity_range = 32.0
	for n: Variant in config.get("omit", []):
		if not W.is_omittable(str(n)):
			push_error("OneLobbyPlayerCodec: cannot leave out \"%s\"" % str(n))
			continue
		var s := W.snake(str(n))
		omit.append(s)
		_omitted[s] = true
	pos_bits = W.position_bits(range_value)


func is_3d() -> bool:
	return space == "3d"


## False when `name` (a field or an event) is left out.
func has(name: String) -> bool:
	return not _omitted.has(W.snake(name))


func has_event(name: String) -> bool:
	return has(name)


## Bits of one state.
func state_bits() -> int:
	_w.reset()
	write_state(_w, W.default_player_state())
	return _w.bit_count()


func state_bytes() -> int:
	if _state_bytes < 0:
		_state_bytes = (state_bits() + 7) >> 3
	return _state_bytes


# ---- state --------------------------------------------------------------------------------------------------------------

func write_state(w: OneLobbyNetWriter, s: Dictionary) -> void:
	var r := range_value
	var v := velocity_range
	w.write_quantized(float(s["x"]), -r, r, pos_bits)
	w.write_quantized(float(s["y"]), -r, r, pos_bits)
	if is_3d():
		w.write_quantized(float(s["z"]), -r, r, pos_bits)
	if has("velocity"):
		w.write_quantized(float(s["vx"]), -v, v, VEL_BITS)
		w.write_quantized(float(s["vy"]), -v, v, VEL_BITS)
		if is_3d():
			w.write_quantized(float(s["vz"]), -v, v, VEL_BITS)
	if has("yaw"):
		w.write_angle(float(s["yaw"]), YAW_BITS)
	if is_3d() and has("pitch"):
		w.write_quantized(float(s["pitch"]), -90.0, 90.0, PITCH_BITS)
	if has("on_ground"):
		w.write_bool(bool(s["on_ground"]))
	if has("mode"):
		w.write_bits(int(s["mode"]), 4)
	if has("item"):
		w.write_bits(int(s["item"]), 4)
	if has("aiming"):
		w.write_bool(bool(s["aiming"]))
	if has("blocking"):
		w.write_bool(bool(s["blocking"]))
	if has("health"):
		w.write_bits(int(s["health"]), 8)
	if has("alive"):
		w.write_bool(bool(s["alive"]))
	if has("team"):
		w.write_bits(int(s["team"]), 4)
	w.write_bits(int(s["teleport"]), 3)
	w.write_bool(bool(s["carried"]))


func read_state(r: OneLobbyNetReader) -> Dictionary:
	var rg := range_value
	var vr := velocity_range
	var s := W.default_player_state()
	s["x"] = r.read_quantized(-rg, rg, pos_bits)
	s["y"] = r.read_quantized(-rg, rg, pos_bits)
	if is_3d():
		s["z"] = r.read_quantized(-rg, rg, pos_bits)
	if has("velocity"):
		s["vx"] = r.read_quantized(-vr, vr, VEL_BITS)
		s["vy"] = r.read_quantized(-vr, vr, VEL_BITS)
		if is_3d():
			s["vz"] = r.read_quantized(-vr, vr, VEL_BITS)
	if has("yaw"):
		s["yaw"] = r.read_angle(YAW_BITS)
	if is_3d() and has("pitch"):
		s["pitch"] = r.read_quantized(-90.0, 90.0, PITCH_BITS)
	if has("on_ground"):
		s["on_ground"] = r.read_bool()
	if has("mode"):
		s["mode"] = r.read_bits(4)
	if has("item"):
		s["item"] = r.read_bits(4)
	if has("aiming"):
		s["aiming"] = r.read_bool()
	if has("blocking"):
		s["blocking"] = r.read_bool()
	if has("health"):
		s["health"] = r.read_bits(8)
	if has("alive"):
		s["alive"] = r.read_bool()
	if has("team"):
		s["team"] = r.read_bits(4)
	s["teleport"] = r.read_bits(3)
	s["carried"] = r.read_bool()
	return s


## Schema interface for `OneLobbyReplicationSession`.
func write(w: OneLobbyNetWriter, s: Dictionary) -> void:
	write_state(w, s)


## Schema interface for `OneLobbyReplicationSession`.
func read(r: OneLobbyNetReader) -> Dictionary:
	return read_state(r)


## The state as bytes (what goes into an entity's state, or into an input in owner mode).
func encode_state(s: Dictionary) -> PackedByteArray:
	_w.reset()
	write_state(_w, s)
	return _w.to_bytes()


## The state from bytes; null when the length is not exactly the layout's (a malformed state).
func decode_state(b: PackedByteArray) -> Variant:
	if b.size() != state_bytes():
		return null
	_r.reset(b)
	return read_state(_r)


## What `s` becomes after one trip over the wire (quantised, omitted fields at their defaults).
func quantize(s: Dictionary) -> Dictionary:
	return decode_state(encode_state(s))


## Blend two states for rendering: numbers by `t`, yaw on the shortest arc, everything else from `a`; a teleport holds `a`
## (the snap happens when render time reaches b's tick).
func interpolate(a: Dictionary, b: Dictionary, t: float) -> Dictionary:
	if int(a["teleport"]) != int(b["teleport"]):
		return a
	var o := a.duplicate()
	for k in ["x", "y", "z", "vx", "vy", "vz", "pitch"]:
		o[k] = OneLobbyNetMath.lerp_value(float(a[k]), float(b[k]), t)
	o["yaw"] = OneLobbyNetMath.lerp_angle(float(a["yaw"]), float(b["yaw"]), t)
	return o


# ---- input preset (host-decides mode) -----------------------------------------------------------------------------------

func write_input(w: OneLobbyNetWriter, i: Dictionary) -> void:
	w.write_quantized(float(i["move_x"]), -1.0, 1.0, MOVE_BITS)
	w.write_quantized(float(i["move_y"]), -1.0, 1.0, MOVE_BITS)
	w.write_angle(float(i["yaw"]), YAW_BITS)
	if is_3d():
		w.write_quantized(float(i["pitch"]), -90.0, 90.0, PITCH_BITS)
	for b in W.BUTTONS:
		w.write_bool(bool(i["buttons"][b]))


func read_input(r: OneLobbyNetReader) -> Dictionary:
	var i := W.default_player_input()
	i["move_x"] = r.read_quantized(-1.0, 1.0, MOVE_BITS)
	i["move_y"] = r.read_quantized(-1.0, 1.0, MOVE_BITS)
	i["yaw"] = r.read_angle(YAW_BITS)
	if is_3d():
		i["pitch"] = r.read_quantized(-90.0, 90.0, PITCH_BITS)
	for b in W.BUTTONS:
		i["buttons"][b] = r.read_bool()
	return i


func input_bytes() -> int:
	if _input_bytes < 0:
		_w.reset()
		write_input(_w, W.default_player_input())
		_input_bytes = _w.byte_count()
	return _input_bytes


func encode_input(i: Dictionary) -> PackedByteArray:
	_w.reset()
	write_input(_w, i)
	return _w.to_bytes()


## The input from bytes; null when the length is not exactly the layout's.
func decode_input(b: PackedByteArray) -> Variant:
	if b.size() != input_bytes():
		return null
	_r.reset(b)
	return read_input(_r)


## What an input becomes after one trip over the wire.
func quantize_input(i: Dictionary) -> Dictionary:
	return decode_input(encode_input(i))


# ---- action events ------------------------------------------------------------------------------------------------------

func write_args(w: OneLobbyNetWriter, name: String, a: Dictionary) -> void:
	match W.snake(name):
		"land":
			w.write_quantized(float(a.get("impact", 0)), 0.0, 64.0, 6)
		"shoot":
			w.write_angle(float(a.get("yaw", 0)), YAW_BITS)
			if is_3d():
				w.write_quantized(float(a.get("pitch", 0)), -90.0, 90.0, PITCH_BITS)
			w.write_uint32(int(a.get("view", 0)))
		"melee":
			w.write_bits(int(a.get("swing", 0)), 8)
		"use":
			w.write_bits(int(a.get("target", 0)), 16)
		"item_switch":
			w.write_bits(int(a.get("slot", 0)), 4)
		"throw":
			w.write_angle(float(a.get("yaw", 0)), YAW_BITS)
			if is_3d():
				w.write_quantized(float(a.get("pitch", 0)), -90.0, 90.0, PITCH_BITS)
			w.write_quantized(float(a.get("power", 0)), 0.0, 1.0, 6)
		"hit":
			w.write_bits(int(a.get("by", 0)), 16)
			w.write_bits(int(a.get("damage", 0)), 8)
		"death":
			w.write_bits(int(a.get("by", 0)), 16)
		"emote":
			w.write_bits(int(a.get("emote", 0)), 6)
		_:
			pass # jump, reload, respawn: no arguments


func read_args(r: OneLobbyNetReader, name: String) -> Dictionary:
	match W.snake(name):
		"land":
			return {"impact": r.read_quantized(0.0, 64.0, 6)}
		"shoot":
			var yaw := r.read_angle(YAW_BITS)
			var pitch := r.read_quantized(-90.0, 90.0, PITCH_BITS) if is_3d() else 0.0
			return {"yaw": yaw, "pitch": pitch, "view": r.read_uint32()}
		"melee":
			return {"swing": r.read_bits(8)}
		"use":
			return {"target": r.read_bits(16)}
		"item_switch":
			return {"slot": r.read_bits(4)}
		"throw":
			var ty := r.read_angle(YAW_BITS)
			var tp := r.read_quantized(-90.0, 90.0, PITCH_BITS) if is_3d() else 0.0
			return {"yaw": ty, "pitch": tp, "power": r.read_quantized(0.0, 1.0, 6)}
		"hit":
			var by := r.read_bits(16)
			return {"by": by, "damage": r.read_bits(8)}
		"death":
			return {"by": r.read_bits(16)}
		"emote":
			return {"emote": r.read_bits(6)}
	return {}


func encode_args(name: String, a: Dictionary = {}) -> PackedByteArray:
	_w.reset()
	write_args(_w, name, a)
	return PackedByteArray() if _w.bit_count() == 0 else _w.to_bytes()


## Bytes of this event's arguments.
func args_bytes(name: String) -> int:
	return encode_args(name).size()


## Decode arguments; null when the length is not exactly the layout's.
func decode_args(name: String, b: PackedByteArray) -> Variant:
	if b.size() != args_bytes(name):
		return null
	_r.reset(b)
	return read_args(_r, name)
