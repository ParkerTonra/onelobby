extends SceneTree
## One side of the cross-client LAN discovery run (js/e2e/lan-cross.mjs starts it); everything on 127.0.0.1.
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/lan_peer.gd -- host <udp port> <lobby name> <host name> <tcp port> <seconds>
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/lan_peer.gd -- find <udp port> <game id> <net version>
## host: answers questions for game "cross" version "1" for <seconds>, prints "HOST_READY" then "HOST_STATS {...}".
## find: asks 127.0.0.1 and prints "ROW {json}" for the first row it sees (or "NO_ROW"), then exits.

func _init() -> void:
	_run.call_deferred()


func _run() -> void:
	var a := OS.get_cmdline_user_args()
	if a.size() < 2:
		print("usage: host|find ...")
		quit(2)
		return
	var port := int(a[1])
	if a[0] == "host":
		var info := {"lobby_name": a[2], "host_name": a[3], "players": 2, "max_players": 4, "password": true, "port": int(a[4])}
		var host := OneLobbyLanHost.new("cross", "1", func() -> Dictionary: return info, {"port": port, "bind_address": "127.0.0.1"})
		if not host.start():
			print("HOST_FAILED")
			quit(1)
			return
		print("HOST_READY")
		var until := Time.get_ticks_msec() + int(a[5]) * 1000
		while Time.get_ticks_msec() < until:
			host.poll()
			await process_frame
		print("HOST_STATS ", JSON.stringify(host.answerer.stats))
		host.close()
		quit(0)
		return
	var finder := OneLobbyLanFinder.new(a[2], a[3], {"targets": PackedStringArray(["127.0.0.1"]), "port": port, "ask_interval_ms": 200, "min_gap_ms": 100})
	root.add_child(finder)
	finder.start()
	var t0 := Time.get_ticks_msec()
	while finder.games.is_empty() and Time.get_ticks_msec() - t0 < 8000:
		await process_frame
	if finder.games.is_empty():
		print("NO_ROW")
		finder.stop()
		quit(1)
		return
	print("ROW ", JSON.stringify(finder.games[0]))
	finder.stop()
	quit(0)
