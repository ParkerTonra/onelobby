class_name OneLobbyPlayerWire
extends RefCounted
## The networked player's tables and its kind 5 message (spec/net-player.md): the reserved type id, the action events, the
## button names, the state and input defaults, and `encode_player_events` / `decode_player_events`. Pure functions, no lobby,
## no session. GDScript twin of the table part of JS `player-wire.ts`.
##
## Names are snake_case: state keys `x y z vx vy vz yaw pitch on_ground mode item aiming blocking health alive team teleport`,
## input keys `move_x move_y yaw pitch buttons`, event names `jump land shoot melee reload use item_switch throw hit death
## respawn emote`. The `omit` list of `onelobby.json` uses the file's spelling (`onGround`, `itemSwitch`): both spellings work.

const P := preload("res://addons/onelobby/replication_protocol.gd")

## The reserved entity type id of a networked player.
const PLAYER_TYPE_ID := 65535
## Message kind of the action events (additive to replication version 1).
const KIND_PLAYER_EVENTS := 5
## The teleport counter wraps at this value (3 bits).
const TELEPORT_MODULO := 8
## Records one message may carry (a u8 count) and the size past which older copies are left out.
const MAX_EVENTS_PER_MESSAGE := 255
const MAX_EVENT_MESSAGE_BYTES := 1000

## Movement modes of the preset; 9 to 15 are the game's own.
const MOVEMENT_MODES: Array[String] = ["idle", "walk", "run", "crouch", "jump", "fall", "swim", "climb", "fly"]
## The buttons of the input preset, in wire order.
const BUTTONS: Array[String] = ["jump", "crouch", "sprint", "aim", "block", "fire", "use", "reload"]
## State fields that may go into `omit`, snake_case. Position and the teleport counter can never be left out.
const OMITTABLE_FIELDS: Array[String] = ["velocity", "yaw", "pitch", "on_ground", "mode", "item", "aiming", "blocking", "health", "alive", "team"]

## The action events in id order: `origin` "owner" (the player's own peer, or the host for any player) or "host" only.
const ACTION_EVENTS: Array[Dictionary] = [
	{"id": 1, "name": "jump", "origin": "owner"},
	{"id": 2, "name": "land", "origin": "owner"},
	{"id": 3, "name": "shoot", "origin": "owner"},
	{"id": 4, "name": "melee", "origin": "owner"},
	{"id": 5, "name": "reload", "origin": "owner"},
	{"id": 6, "name": "use", "origin": "owner"},
	{"id": 7, "name": "item_switch", "origin": "owner"},
	{"id": 8, "name": "throw", "origin": "owner"},
	{"id": 9, "name": "hit", "origin": "host"},
	{"id": 10, "name": "death", "origin": "host"},
	{"id": 11, "name": "respawn", "origin": "owner"},
	{"id": 12, "name": "emote", "origin": "owner"},
]


## `onGround` -> `on_ground`, `itemSwitch` -> `item_switch`; snake_case names stay as they are.
static func snake(name: String) -> String:
	var out := ""
	for i in name.length():
		var c := name[i]
		if c != c.to_lower():
			out += "_" + c.to_lower()
		else:
			out += c
	return out


## True for a name that may go into `omit` (either spelling).
static func is_omittable(name: String) -> bool:
	var n := snake(name)
	return OMITTABLE_FIELDS.has(n) or action_by_name(n) != null


## The event definition `{id, name, origin}` by name (either spelling), or null.
static func action_by_name(name: String) -> Variant:
	var n := snake(name)
	for e: Dictionary in ACTION_EVENTS:
		if e["name"] == n:
			return e
	return null


static func action_by_id(id: int) -> Variant:
	for e: Dictionary in ACTION_EVENTS:
		if int(e["id"]) == id:
			return e
	return null


## A new state with every field at its default; `over` replaces some.
static func default_player_state(over: Dictionary = {}) -> Dictionary:
	var s := {
		"x": 0.0, "y": 0.0, "z": 0.0, "vx": 0.0, "vy": 0.0, "vz": 0.0, "yaw": 0.0, "pitch": 0.0, "on_ground": true, "mode": 0,
		"item": 0, "aiming": false, "blocking": false, "health": 100, "alive": true, "team": 0, "teleport": 0, "carried": false,
	}
	for k: String in over:
		s[k] = over[k]
	return s


## A new input with every field at its default; `over` replaces some (`buttons` is merged, not replaced).
static func default_player_input(over: Dictionary = {}) -> Dictionary:
	var buttons := {}
	for b in BUTTONS:
		buttons[b] = false
	var i := {"move_x": 0.0, "move_y": 0.0, "yaw": 0.0, "pitch": 0.0, "buttons": buttons}
	for k: String in over:
		if k == "buttons":
			for b: String in over["buttons"]:
				buttons[b] = over["buttons"][b]
		else:
			i[k] = over[k]
	return i


## Bits of a position axis: the smallest b in 8..24 with 2^b - 1 >= ceil(2 x range / 0.01) (about 1 cm a step).
static func position_bits(range_value: float) -> int:
	var steps := ceili((2.0 * range_value) / 0.01)
	var b := 8
	while b < 24 and (1 << b) - 1 < steps:
		b += 1
	return b


# ---- kind 5: player events -------------------------------------------------------------------------------------------

static func _varuint(b: PackedByteArray, v: int) -> void:
	while v >= 0x80 or v < 0:
		b.append((v & 0x7F) | 0x80)
		v = (v >> 7) & 0x01FFFFFFFFFFFFFF
	b.append(v)


## One event record as it travels: `{player, seq, id, tick, args: PackedByteArray}`.
## Returns the message bytes; an empty array (and an error) for 0 or more than 255 events or arguments over 255 bytes.
static func encode_player_events(events: Array) -> PackedByteArray:
	if events.is_empty() or events.size() > MAX_EVENTS_PER_MESSAGE:
		push_error("OneLobbyPlayerWire.encode_player_events: 1..255 events per message")
		return PackedByteArray()
	var w := PackedByteArray([P.MAGIC, P.VERSION, KIND_PLAYER_EVENTS, events.size()])
	for e: Dictionary in events:
		var args: PackedByteArray = e["args"]
		if args.size() > 255:
			push_error("OneLobbyPlayerWire.encode_player_events: event arguments over 255 bytes")
			return PackedByteArray()
		_varuint(w, int(e["player"]))
		_varuint(w, int(e["seq"]))
		w.append(int(e["id"]))
		_varuint(w, int(e["tick"]))
		w.append(args.size())
		w.append_array(args)
	return w


## Decode a kind 5 message: `{"events": Array}` or `{"error": name}` with `too_short`, `trailing`, `varint`, `range`,
## `count_0`, `player_0`, `seq_0` or `event_id`. Never throws, never prints.
static func decode_player_events(p: PackedByteArray) -> Dictionary:
	if p.size() < 4:
		return P.fail("too_short")
	var r := P.OLByteReader.new(p, 3)
	var count := r.u8()
	if r.err != "":
		return P.fail(r.err)
	if count == 0:
		return P.fail("count_0")
	var out: Array = []
	for _i in count:
		var player := r.var32()
		var seq := r.var32()
		var id := r.u8()
		var tick := r.var32()
		var length := r.u8()
		if r.err != "":
			return P.fail(r.err)
		var args := r.bytes(length)
		if r.err != "":
			return P.fail(r.err)
		if player == 0:
			return P.fail("player_0")
		if seq == 0:
			return P.fail("seq_0")
		if id == 0:
			return P.fail("event_id")
		out.append({"player": player, "seq": seq, "id": id, "tick": tick, "args": args})
	if r.remaining() != 0:
		return P.fail("trailing")
	return {"events": out}
