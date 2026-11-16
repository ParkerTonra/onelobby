class_name OneLobbyBanList
extends RefCounted
## The host's ban list: survives the lobby because it is saved in an OneLobbyStore (default a file under user://), keyed by
## the game id. Entries are {id?, ip?, name?, reason?, code?, at}: the player id, with the address as the fallback for peers
## without one (spec/room.md 5.3). A corrupt store loads as empty and is only overwritten by the next change.

## Fires after every change (add, remove, clear).
signal changed

## At most this many entries are kept; the oldest is dropped first.
const MAX_BANS := 1000
## The hub holds at most this many player ids per lobby (the `bans` message).
const HUB_BAN_IDS := 256

var _store: OneLobbyStore
var _key := ""
var _entries: Array = []


func _init(store: OneLobbyStore, game_id: String) -> void:
	_store = store
	_key = OneLobbyStore.bans_key(game_id)
	reload()


## Reads the store again.
func reload() -> void:
	_entries = []
	if _store == null:
		return
	var text: Variant = _store.get_item(_key)
	if not text is String or text == "":
		return
	var j := JSON.new()
	if j.parse(text) != OK or not j.data is Dictionary or not (j.data as Dictionary).get("bans") is Array:
		return
	for e: Variant in j.data["bans"]:
		if not e is Dictionary:
			continue
		var id: String = e["id"] if OneLobbyRoomRules.is_player_id(e.get("id")) else ""
		var ip: String = OneLobbyRoomRules.normalize_ip(e["ip"]) if e.get("ip") is String and e["ip"] != "" else ""
		if id == "" and ip == "":
			continue
		var entry := {}
		if id != "":
			entry["id"] = id
		if ip != "":
			entry["ip"] = ip
		for k in ["name", "reason", "code"]:
			if e.get(k) is String:
				entry[k] = e[k]
		entry["at"] = int(e["at"]) if e.get("at") is float or e.get("at") is int else 0
		_entries.append(entry)
	if _entries.size() > MAX_BANS:
		_entries = _entries.slice(_entries.size() - MAX_BANS)


## Copies of the entries, oldest first.
func list() -> Array:
	var out: Array = []
	for e: Dictionary in _entries:
		out.append(e.duplicate())
	return out


func size() -> int:
	return _entries.size()


## The entry that bans candidate `c` ({id?, ip?}), or {} when none does.
func match_entry(c: Dictionary) -> Dictionary:
	for e: Dictionary in _entries:
		if OneLobbyRoomRules.ban_matches(e, c):
			return e.duplicate()
	return {}


## Adds a ban for a player id and/or an address (`e`: id, ip, name, reason, code, at). A loopback address is never stored.
## One entry per id (or per address when it has no id): a new ban replaces the old. Returns the entry, or {} when there was
## neither a valid id nor a usable address.
func add(e: Dictionary) -> Dictionary:
	var id := str(e.get("id", ""))
	if not OneLobbyRoomRules.is_player_id(id):
		id = ""
	var ip := OneLobbyRoomRules.normalize_ip(e.get("ip", "")) if str(e.get("ip", "")) != "" else ""
	if ip != "" and OneLobbyRoomRules.is_loopback_ip(ip):
		ip = ""
	if id == "" and ip == "":
		return {}
	var entry := {}
	if id != "":
		entry["id"] = id
	if ip != "":
		entry["ip"] = ip
	for k in ["name", "reason", "code"]:
		if str(e.get(k, "")) != "":
			entry[k] = str(e[k])
	entry["at"] = int(e["at"]) if e.has("at") else int(Time.get_unix_time_from_system() * 1000.0)
	_entries = _entries.filter(func(x: Dictionary) -> bool:
		if id != "":
			return x.get("id", "") != id
		return not (not x.has("id") and x.get("ip", "") == ip))
	_entries.append(entry)
	if _entries.size() > MAX_BANS:
		_entries = _entries.slice(_entries.size() - MAX_BANS)
	_save()
	return entry.duplicate()


## Unban by player id or address (a String), or by a selector {id?, ip?} (every entry with either). Returns how many went.
func remove(sel: Variant) -> int:
	var id := ""
	var ip := ""
	if sel is Dictionary:
		id = str(sel.get("id", ""))
		ip = OneLobbyRoomRules.normalize_ip(sel.get("ip", "")) if str(sel.get("ip", "")) != "" else ""
	elif OneLobbyRoomRules.is_player_id(sel):
		id = sel
	else:
		ip = OneLobbyRoomRules.normalize_ip(sel)
	var before := _entries.size()
	_entries = _entries.filter(func(e: Dictionary) -> bool: return not ((id != "" and e.get("id", "") == id) or (ip != "" and e.get("ip", "") == ip)))
	var n := before - _entries.size()
	if n > 0:
		_save()
	return n


func clear() -> void:
	if _entries.is_empty():
		return
	_entries = []
	_save()


## The newest player ids, for the hub's `bans` message.
func hub_ids() -> Array:
	var ids: Array = []
	for e: Dictionary in _entries:
		if e.has("id"):
			ids.append(e["id"])
	return ids.slice(maxi(0, ids.size() - HUB_BAN_IDS))


func _save() -> void:
	if _store != null:
		_store.set_item(_key, OneLobbyRoomWire.json_text({"v": 1, "bans": _entries}))
	changed.emit()
