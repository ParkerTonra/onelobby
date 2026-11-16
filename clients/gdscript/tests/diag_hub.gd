extends SceneTree
## The `diag` relay of the GDScript hub (spec/diagnostics.md s.7.2), driven in process with fake sessions: the feature is
## listed, a joiner's report reaches the host only (rebuilt, `from` stamped by the hub), bad reports are bad_request (field
## report), the host and a peer outside a lobby cannot send one, and the fourth report within a minute is rate_limited.
## (conformance/server/suite.mjs has the same two tests for hubs it can reach over a socket; it creates its own lobbies,
## which a direct hub does not allow, so it cannot run against this one.)
##   godot --headless --audio-driver Dummy --path clients/gdscript -s res://tests/diag_hub.gd

var _fails := 0

const REPORT := {
	"cause": "nat_blocked", "stage": "ice", "elapsedMs": 15000, "relaySet": false,
	"candidateTypes": {"local": ["host", "srflx"], "remote": ["host"]}, "clientVersion": "0.7.2",
}


func _check(ok: bool, what: String) -> void:
	if not ok:
		_fails += 1
		print("FAIL: ", what)


class Peer:
	extends RefCounted
	var hub: OneLobbyHub
	var s: OneLobbyHub.OLSession
	var got: Array = []

	func _init(h: OneLobbyHub) -> void:
		hub = h
		s = h.connect_session("127.0.0.1", func(text: String) -> void: got.append(JSON.parse_string(text)), func(_c: int, _r: String) -> void: pass)

	func say(msg: Dictionary) -> void:
		hub.receive(s, JSON.stringify(msg))

	func take(t: String) -> Array:
		var out := []
		for m: Dictionary in got:
			if m.get("t") == t:
				out.append(m)
		got = got.filter(func(m: Dictionary) -> bool: return m.get("t") != t)
		return out


func _hello(p: Peer, name: String) -> void:
	p.say({"t": "hello", "proto": "lk1", "gameId": "diag-hub", "netVersion": "1", "name": name, "client": {"lib": "test", "ver": "0", "platform": "test"}})


func _init() -> void:
	var hub := OneLobbyHub.direct(4)
	var host := Peer.new(hub)
	_hello(host, "Host")
	var welcome: Array = host.take("welcome")
	_check(welcome.size() == 1 and (welcome[0]["features"] as Array).has("diag"), "welcome lists the diag feature")
	host.say({"t": "create", "name": "room", "maxPlayers": 4, "mode": "raw", "visibility": "unlisted"})
	host.take("lobby")
	var outsider := Peer.new(hub)
	_hello(outsider, "Out")
	outsider.take("welcome")
	outsider.say({"t": "diag", "report": REPORT})
	var e := outsider.take("error")
	_check(e.size() == 1 and e[0]["code"] == "bad_request" and e[0]["data"]["field"] == "report", "not in a lobby: bad_request, field report")
	var sam := Peer.new(hub)
	_hello(sam, "Sam")
	sam.take("welcome")
	sam.say({"t": "join"})
	sam.take("lobby")
	host.take("peer_joined")
	host.take("lobby")

	# a report reaches the host only, rebuilt from the known fields, `from` stamped by the hub
	sam.say({"t": "diag", "from": 9, "report": REPORT.merged({"address": "203.0.113.9", "name": "Sam", "note": "hi"}, true)})
	var d := host.take("diag")
	_check(d.size() == 1 and int(d[0]["from"]) == 2, "the host gets the report from peer 2 (from is stamped, not the client's 9)")
	if d.size() == 1:
		var r: Dictionary = d[0]["report"]
		_check(not r.has("address") and not r.has("name") and not r.has("note") and r["cause"] == "nat_blocked", "the report is rebuilt: %s" % [r])
	_check(sam.take("diag").is_empty() and sam.take("error").is_empty(), "no reply on success")

	# bad reports and the host as sender
	sam.say({"t": "diag", "report": REPORT.merged({"elapsedMs": -1}, true)})
	sam.say({"t": "diag"})
	sam.say({"t": "diag", "report": REPORT.merged({"cause": "NatBlocked"}, true)})
	var bad := sam.take("error")
	_check(bad.size() == 3 and bad.all(func(m: Dictionary) -> bool: return m["code"] == "bad_request" and m["data"]["field"] == "report"), "invalid reports are bad_request with field report: %s" % [bad])
	host.say({"t": "diag", "report": REPORT})
	var hb := host.take("error")
	_check(hb.size() == 1 and hb[0]["code"] == "bad_request", "the host cannot send a report")
	var big := REPORT.duplicate(true)
	big["clientVersion"] = "x".repeat(2000)
	sam.say({"t": "diag", "report": big})
	_check(sam.take("error").size() == 1, "a frame over 1024 characters is bad_request")
	_check(host.take("diag").is_empty(), "nothing bad was forwarded")

	# three per minute: Sam used one, two more go, the fourth is rate_limited with retryAfterMs
	sam.say({"t": "diag", "report": REPORT})
	sam.say({"t": "diag", "report": REPORT})
	sam.say({"t": "diag", "report": REPORT})
	var fwd := host.take("diag")
	var limited := sam.take("error")
	_check(fwd.size() == 2, "two more reports were forwarded (%d)" % fwd.size())
	_check(limited.size() == 1 and limited[0]["code"] == "rate_limited" and int(limited[0]["data"]["retryAfterMs"]) > 0, "the fourth within a minute is rate_limited: %s" % [limited])

	print("diag hub ", "ok" if _fails == 0 else "FAILED (%d)" % _fails)
	quit(0 if _fails == 0 else 1)
