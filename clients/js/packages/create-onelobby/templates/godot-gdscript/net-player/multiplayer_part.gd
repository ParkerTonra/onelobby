

## The networked player (sync.player in onelobby.json) on the same two peers: each machine gets a spawner with the game's player.tscn,
## the joiner's player appears on the host with a position that follows the joiner, and the joiner's one jump arrives once.
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
	var guest_peer := gl.local_peer_id
	var mine: Variant = spawners[1].character_of(guest_peer) # the joiner's own player, on the joiner
	mine.set_physics_process(false) # the test places this player itself: the character's own script (keys, gravity, no floor here) stays out of it
	var appeared := func() -> bool:
		var c: Variant = spawners[0].character_of(guest_peer) # the same player as the host sees it
		return c != null and c.visible # hidden until its first state has arrived
	if not await _until(appeared):
		return _player_fail("the joiner's player never appeared on the host")
#@if 3d
	var copy := spawners[0].character_of(guest_peer) as Node3D
#@end
#@if 2d
	var copy := spawners[0].character_of(guest_peer) as Node2D
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
		return _player_fail("the joiner's player moved but the host's copy stayed at x = %.2f (it was at %.2f)" % [copy.global_position.x, start_x])
	(mine.get_node("NetPlayer") as OneLobbyNetPlayer).jump()
	if not await _until(func() -> bool: return jumps.size() > 0):
		return _player_fail("the joiner's jump never arrived on the host")
	for _i in 90:
		await process_frame
	if jumps.size() != 1:
		return _player_fail("one jump arrived %d times on the host" % jumps.size())
	for h in holders:
		h.queue_free()
	await process_frame
	return true


func _player_fail(what: String) -> bool:
	_fail("player: " + what)
	return false
