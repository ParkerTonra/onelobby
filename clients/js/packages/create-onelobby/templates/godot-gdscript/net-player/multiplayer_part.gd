## The networked player (sync.player in onelobby.json) on the same two peers, BOTH ways: each machine gets a spawner with the game's
## player.tscn; the joiner's player appears on the host with a position that follows the joiner, and the joiner's one jump arrives once;
## then the host's player appears on the joiner, follows the host, and the host's one jump arrives once. It prints one line per way:
##   MULTIPLAYER_PLAYER the joiner's player (peer 2) moved from x = 0.00 to x = 6.00 on the host, one jump arrived once
##   MULTIPLAYER_PLAYER the host's player (peer 1) moved from x = 0.00 to x = 6.00 on the joiner, one jump arrived once
## (It uses the game's own player.tscn; if you change that scene a lot, adjust or drop this check.)
func _check_player(hl: OneLobbyLobby, gl: OneLobbyLobby) -> bool:
	var cfg := OneLobbyConfig.load_file("res://onelobby.json")
	var scene: PackedScene = load("res://player.tscn")
	var holders: Array[Node] = []
	var spawners: Array[OneLobbyNetPlayerSpawner] = []
	for lobby: OneLobbyLobby in [hl, gl]:
		var holder := Node.new() # one world per machine: both are in this one process
		root.add_child(holder)
		var sp := OneLobbyNetPlayerSpawner.new()
		sp.scene = scene
#@if 3d
		sp.spawn_point = func(peer: int) -> Vector3: return Vector3(float(peer) * 2.0, 1.0, 0.0)
#@end
#@if 2d
		sp.spawn_point = func(peer: int) -> Vector2: return Vector2(float(peer) * 80.0, -16.0)
#@end
#@if host
		sp.step_function = load("res://player.gd").step
#@end
		holder.add_child(sp)
		sp.start(lobby, cfg)
		holders.append(holder)
		spawners.append(sp)
	var host_peer := hl.local_peer_id
	var guest_peer := gl.local_peer_id
	var up := await _player_way("the joiner's", guest_peer, spawners[1], spawners[0], "host")
	if up == "":
		return false
	print("MULTIPLAYER_PLAYER ", up)
	var down := await _player_way("the host's", host_peer, spawners[0], spawners[1], "joiner")
	if down == "":
		return false
	print("MULTIPLAYER_PLAYER ", down)
	for h in holders:
		h.queue_free()
	await process_frame
	return true


## One way: the player of `peer` lives on the machine of `from_sp` (its owner) and is watched on the machine of `to_sp`. The owner moves it
## and jumps once; the watcher's copy must appear, follow and see one jump. Returns the line to print, or "" (after failing the test).
func _player_way(whose: String, peer: int, from_sp: OneLobbyNetPlayerSpawner, to_sp: OneLobbyNetPlayerSpawner, watcher: String) -> String:
	var mine: Variant = from_sp.character_of(peer) # this player on its own machine
	if mine == null:
		_player_fail("%s player never got a character of its own" % whose)
		return ""
	mine.set_physics_process(false) # the test places this player itself: the character's own script (keys, gravity, no floor here) stays out of it
	var appeared := func() -> bool:
		var c: Variant = to_sp.character_of(peer) # the same player as the other machine sees it
		return c != null and c.visible # hidden until its first state has arrived
	if not await _until(appeared):
		_player_fail("%s player never appeared on the %s" % [whose, watcher])
		return ""
#@if 3d
	var copy := to_sp.character_of(peer) as Node3D
#@end
#@if 2d
	var copy := to_sp.character_of(peer) as Node2D
#@end
	var jumps := []
	(copy.get_node("NetPlayer") as OneLobbyNetPlayer).jumped.connect(func() -> void: jumps.append(1))
	var start_x := copy.global_position.x
#@if owner
	mine.global_position.x += 6.0 # the owner places its own player (authority "owner")
#@end
#@if host
	var net := mine.get_node("NetPlayer") as OneLobbyNetPlayer
	net.set_input({"move_x": 1.0, "move_y": 0.0, "yaw": 0.0}) # the host places every player from its inputs (authority "host"): hold "right"
#@end
	var follows := func() -> bool:
#@if host
		net.set_input({"move_x": 1.0, "move_y": 0.0, "yaw": 0.0})
#@end
		return copy.global_position.x > start_x + 2.0
	if not await _until(follows, 20000):
		_player_fail("%s player moved but its copy on the %s stayed at x = %.2f (it was at %.2f)" % [whose, watcher, copy.global_position.x, start_x])
		return ""
	(mine.get_node("NetPlayer") as OneLobbyNetPlayer).jump()
	if not await _until(func() -> bool: return jumps.size() > 0):
		_player_fail("%s jump never arrived on the %s" % [whose, watcher])
		return ""
	for _i in 90:
		await process_frame # a second arrival would show here
	if jumps.size() != 1:
		_player_fail("%s jump arrived %d times on the %s" % [whose, jumps.size(), watcher])
		return ""
	return "%s player (peer %d) moved from x = %.2f to x = %.2f on the %s, one jump arrived once" % [whose, peer, start_x, copy.global_position.x, watcher]


func _player_fail(what: String) -> bool:
	_fail("player: " + what)
	return false
