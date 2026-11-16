class_name OneLobbyStore
extends RefCounted
## Small synchronous key/value stores for what a client keeps on the player's machine: the per-install player id and the
## host's ban list (spec/room.md 1 and 5.3). The shape is the Web Storage subset the JS client uses (`getItem`, `setItem`,
## `removeItem`), so a game can plug in its own (a ConfigFile, a save slot) by subclassing this one.
##
##     client.store = OneLobbyStore.memory()                  # nothing kept (tests)
##     client.store = OneLobbyStore.file("user://mygame.json") # the default is user://onelobby.json

const DEFAULT_PATH := "user://onelobby.json"


## The stored text of `key`, or null when there is none.
func get_item(_key: String) -> Variant:
	return null


func set_item(_key: String, _value: String) -> void:
	pass


func remove_item(_key: String) -> void:
	pass


## Keeps values for the life of the process.
static func memory() -> OneLobbyStore:
	return OLMemory.new()


## A JSON file `{ key: text }` at `path` (default user://onelobby.json). Read once, written on every change; an unreadable or
## corrupt file reads as empty and is replaced by the next write.
static func file(path: String = DEFAULT_PATH) -> OneLobbyStore:
	return OLFile.new(path)


## The store key of a game's player id.
static func player_id_key(game_id: String) -> String:
	return "onelobby.pid." + game_id


## The store key of a game's ban list.
static func bans_key(game_id: String) -> String:
	return "onelobby.bans." + game_id


## This install's player id for `game_id`: read from `store`, else made (32 hex characters from the CSPRNG) and saved. A
## store that cannot save still returns a fresh id, so the id then lasts one session. It is not an account, a hardware id or
## derived from anything on the machine (spec/room.md 1).
static func load_player_id(store: OneLobbyStore, game_id: String) -> String:
	var key := player_id_key(game_id)
	if store != null:
		var have: Variant = store.get_item(key)
		if OneLobbyRoomRules.is_player_id(have):
			return have
	var id := OneLobbyRoomRules.new_player_id()
	if store != null:
		store.set_item(key, id)
	return id


class OLMemory:
	extends OneLobbyStore
	var _m := {}

	func get_item(key: String) -> Variant:
		return _m.get(key)

	func set_item(key: String, value: String) -> void:
		_m[key] = value

	func remove_item(key: String) -> void:
		_m.erase(key)


class OLFile:
	extends OneLobbyStore
	var path := ""
	var _data := {}

	func _init(p: String) -> void:
		path = p
		if FileAccess.file_exists(p):
			var j := JSON.new()
			if j.parse(FileAccess.get_file_as_string(p)) == OK and j.data is Dictionary:
				for k: Variant in j.data:
					if j.data[k] is String:
						_data[str(k)] = j.data[k]

	func get_item(key: String) -> Variant:
		return _data.get(key)

	func set_item(key: String, value: String) -> void:
		_data[key] = value
		_flush()

	func remove_item(key: String) -> void:
		if _data.erase(key):
			_flush()

	func _flush() -> void:
		var f := FileAccess.open(path, FileAccess.WRITE)
		if f != null: # a store that cannot save: the values last this session
			f.store_string(OneLobbyRoomWire.json_text(_data))
			f.close()
