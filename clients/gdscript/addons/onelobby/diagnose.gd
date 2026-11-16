class_name OneLobbyDiagnose
extends RefCounted
## Diagnostics, the pure part (spec/diagnostics.md, vectors in spec/vectors/diagnostics.json): the cause table, `diagnose`,
## the host's one-line view, the joiner-to-host report and the connection check's verdict. Nothing here touches the
## network or any clock; the net log is in netlog.gd and the measurements are in connection_check.gd.
##
## Facts are a Dictionary with the spec's keys (side, route, error, reached, elapsedMs, versions {mine, theirs} or null,
## relaysUp, stun, relay, local, remote, retried, nat, heard); the answer is {cause, message, hint, stage}.

const NAT_BLOCKED := "nat_blocked"
const RELAY_REFUSED := "relay_refused"
const RELAY_UNREACHABLE := "relay_unreachable"
const UDP_BLOCKED := "udp_blocked"
const FIREWALL := "firewall"
const VERSION_MISMATCH := "version_mismatch"
const HOST_UNREACHABLE := "host_unreachable"
const SIGNALING_UNREACHABLE := "signaling_unreachable"
const TIMEOUT_UNKNOWN := "timeout_unknown"

## {message, hint, hostHint, short} per cause (spec/diagnostics.md s.4). {mine}, {theirs}, {stage_text} and {elapsed} are
## filled in by explain_cause.
const CAUSE_TEXT := {
	"nat_blocked": {
		"message": "Your network blocks direct connections (strict NAT) and no relay is set.",
		"hint": "Paste a relay line in the game's settings, ask the host for one, or try another network such as a phone hotspot.",
		"hostHint": "A relay (TURN) set on your side, or a forwarded game port, would let this player in.",
		"short": "strict NAT, no relay set",
	},
	"relay_refused": {
		"message": "The relay rejected the login.",
		"hint": "Check the relay line in the settings; it may have been typed wrong or expired.",
		"hostHint": "Their relay line may be wrong or expired.",
		"short": "the relay rejected the login",
	},
	"relay_unreachable": {
		"message": "The relay could not be used: it did not answer.",
		"hint": "Check the relay line for typos and that the relay is online; some networks block relays.",
		"hostHint": "Their relay is down or their network blocks it.",
		"short": "the relay did not answer",
	},
	"udp_blocked": {
		"message": "Your network blocks UDP, the kind of traffic games use to connect.",
		"hint": "Try another network, such as a phone hotspot, or a relay that can be reached from this network.",
		"hostHint": "Their network blocks UDP. Ask them to try another network.",
		"short": "UDP blocked",
	},
	"firewall": {
		"message": "A firewall may be blocking the game on the host's computer: nothing from the player ever reached it.",
		"hint": "Allow the game in the firewall (on Windows, tick Private networks when asked), then try again.",
		"hostHint": "Allow the game in your firewall (on Windows, tick Private networks when asked), then ask them to try again.",
		"short": "nothing reached the host (firewall?)",
	},
	"version_mismatch": {
		"message": "You have version {mine}, the host has {theirs}.",
		"hint": "Update the game on the older side, then try again.",
		"hostHint": "Make sure you both have the same version of the game.",
		"short": "different game version",
	},
	"host_unreachable": {
		"message": "The host did not answer.",
		"hint": "Check the code or address, and that the host is online with the game open.",
		"hostHint": "They could not reach you. Check that your game is open and the code is current.",
		"short": "the host did not answer",
	},
	"signaling_unreachable": {
		"message": "Could not reach the lobby server or any relay that introduces players.",
		"hint": "Check your internet connection; if it works elsewhere, try again in a few minutes.",
		"hostHint": "Their internet connection or the lobby service may be down.",
		"short": "no lobby server or relay reachable",
	},
	"timeout_unknown": {
		"message": "The connection did not finish. It stopped at {stage_text} after {elapsed}.",
		"hint": "Try again. If it keeps happening, copy the log and send it to the host.",
		"hostHint": "Ask them to copy their log and send it to you.",
		"short": "unknown cause",
	},
}

const VERSION_MISMATCH_PLAIN := "You and the host have different versions of the game."

const STAGE_TEXT := {
	"signaling": "reaching the lobby",
	"join": "joining the lobby",
	"offer": "waiting for the host to start the connection",
	"ice": "the connection check",
	"channels": "opening the game connection",
	"handshake": "the final hello with the host",
}

const STAGE_OF := {"none": "signaling", "signaling": "join", "joined": "offer", "offer": "ice", "ice": "channels", "channels": "handshake"}

const UNREACHED_CODES := ["direct_unreachable", "connect_failed", "no_server", "server_closed", "closed"]

## The largest `diag` frame a hub accepts, in characters of JSON text.
const REPORT_MAX_BYTES := 1024
const REPORTS_PER_WINDOW := 3
const REPORT_WINDOW_MS := 60000
## The host keeps at most one report per peer in this long.
const REPORT_HOST_GAP_MS := 10000

const CAND_TYPES := ["host", "srflx", "relay"]
const NAT_TYPES := ["open", "cone", "symmetric", "blocked"]

static var _name_re: RegEx = null
static var _version_re: RegEx = null


## The step a failed attempt stopped at, from how far it got ("none", "signaling", "joined", "offer", "ice", "channels").
static func stage_of(reached: String) -> String:
	return STAGE_OF.get(reached, "ice")


## `under 1 s` below a second, else whole seconds rounded to nearest (halves up) and ` s`.
static func elapsed_text(ms: float) -> String:
	if not (ms >= 1000.0):
		return "under 1 s"
	return "%d s" % int(floor(ms / 1000.0 + 0.5))


static func stage_text(stage: String) -> String:
	return STAGE_TEXT.get(stage, STAGE_TEXT["ice"])


## The sentence, next step and host-side step for a cause code (an unknown code reads as timeout_unknown). `vars`:
## stage, elapsedMs, mine, theirs. Returns {cause, message, hint, hostHint, short}.
static func explain_cause(cause: String, vars: Dictionary = {}) -> Dictionary:
	var known := CAUSE_TEXT.has(cause)
	var t: Dictionary = CAUSE_TEXT[cause if known else "timeout_unknown"]
	var message: String = t["message"]
	var mine := str(vars.get("mine", ""))
	var theirs := str(vars.get("theirs", ""))
	if cause == "version_mismatch" and (mine.is_empty() or theirs.is_empty()):
		message = VERSION_MISMATCH_PLAIN
	message = message.replace("{mine}", mine).replace("{theirs}", theirs)
	message = message.replace("{stage_text}", stage_text(str(vars.get("stage", "ice"))))
	message = message.replace("{elapsed}", elapsed_text(float(vars.get("elapsedMs", 0))))
	return {"cause": cause if known else "timeout_unknown", "message": message, "hint": t["hint"], "hostHint": t["hostHint"], "short": t["short"]}


static func _cause_of(f: Dictionary) -> String:
	var err: Variant = f.get("error")
	var reached := str(f.get("reached", "none"))
	if err == "version_mismatch":
		return VERSION_MISMATCH
	if (reached == "none" or reached == "signaling") and err != null and UNREACHED_CODES.has(str(err)):
		var route := str(f.get("route", "server"))
		if route == "server":
			return SIGNALING_UNREACHABLE
		if route == "nostr":
			return SIGNALING_UNREACHABLE if f.get("relaysUp") == false else HOST_UNREACHABLE
		return HOST_UNREACHABLE
	if err == "ice_failed" or err == "timeout":
		var relay := str(f.get("relay", "none"))
		if relay == "refused":
			return RELAY_REFUSED
		if relay == "unreachable" or relay == "failed":
			return RELAY_UNREACHABLE
		var negotiated := reached == "offer"
		if negotiated and relay == "none":
			var local: Array = f.get("local", [])
			var remote: Array = f.get("remote", [])
			var nat := str(f.get("nat", "unknown"))
			if nat == "blocked":
				return UDP_BLOCKED
			if bool(f.get("stun", false)) and not local.is_empty() and not local.has("srflx"):
				return UDP_BLOCKED
			if nat == "symmetric":
				return NAT_BLOCKED
			if f.get("side") == "host" and f.get("heard") == false:
				return FIREWALL
			if f.get("side") == "joiner" and not local.is_empty() and not remote.is_empty():
				return NAT_BLOCKED
	return TIMEOUT_UNKNOWN


## The cause of a failed connection, from what the client observed: {cause, message, hint, stage}. Pure: every client
## gives the same answer for the same facts (vectors `diagnose`).
static func diagnose(facts: Dictionary) -> Dictionary:
	var stage := stage_of(str(facts.get("reached", "none")))
	var cause := _cause_of(facts)
	var v: Variant = facts.get("versions")
	var mine := ""
	var theirs := ""
	if v is Dictionary:
		mine = str((v as Dictionary).get("mine", ""))
		theirs = str((v as Dictionary).get("theirs", ""))
	var e := explain_cause(cause, {"stage": stage, "elapsedMs": facts.get("elapsedMs", 0), "mine": mine, "theirs": theirs})
	return {"cause": cause, "message": e["message"], "hint": e["hint"], "stage": stage}


## The line a host shows for a joiner's failure: `Sam: strict NAT, no relay set, stopped at the connection check after 15 s.`
static func host_line(peer_name: String, cause: String, stage: String, elapsed_ms: float) -> String:
	return "%s: %s, stopped at %s after %s." % [peer_name, explain_cause(cause)["short"], stage_text(stage), elapsed_text(elapsed_ms)]


# ---- the joiner's report to the host (spec/diagnostics.md s.7) -------------------------------------------------------

static func _type_list(v: Variant) -> Variant:
	if not v is Array or (v as Array).size() > 3:
		return null
	var out: Array = []
	for x: Variant in v:
		if typeof(x) != TYPE_STRING or not CAND_TYPES.has(x) or out.has(x):
			return null
		out.append(x)
	return out


static func _is_int(v: Variant) -> bool:
	if typeof(v) == TYPE_INT:
		return true
	return typeof(v) == TYPE_FLOAT and floorf(v) == v and absf(v) < 1.0e15


## The report rebuilt from the known fields (anything else dropped), or an empty Dictionary when `input` is not a valid
## report. Key order is the spec's (cause, stage, elapsedMs, relaySet, natType?, candidateTypes, clientVersion).
static func clean_report(input: Variant) -> Dictionary:
	if not input is Dictionary:
		return {}
	if _name_re == null:
		_name_re = RegEx.create_from_string("^[a-z][a-z0-9_]{0,31}\\z")
		_version_re = RegEx.create_from_string("^[A-Za-z0-9._+-]{1,32}\\z")
	var r: Dictionary = input
	var cause: Variant = r.get("cause")
	var stage: Variant = r.get("stage")
	var elapsed: Variant = r.get("elapsedMs")
	var relay_set: Variant = r.get("relaySet")
	var nat: Variant = r.get("natType")
	var ct: Variant = r.get("candidateTypes")
	var version: Variant = r.get("clientVersion")
	if typeof(cause) != TYPE_STRING or _name_re.search(cause) == null:
		return {}
	if typeof(stage) != TYPE_STRING or _name_re.search(stage) == null:
		return {}
	if not _is_int(elapsed) or int(elapsed) < 0 or int(elapsed) > 3600000:
		return {}
	if typeof(relay_set) != TYPE_BOOL:
		return {}
	if r.has("natType") and (typeof(nat) != TYPE_STRING or not NAT_TYPES.has(nat)):
		return {}
	if not ct is Dictionary:
		return {}
	var local: Variant = _type_list((ct as Dictionary).get("local"))
	var remote: Variant = _type_list((ct as Dictionary).get("remote"))
	if local == null or remote == null:
		return {}
	if typeof(version) != TYPE_STRING or _version_re.search(version) == null:
		return {}
	var out := {"cause": cause, "stage": stage, "elapsedMs": int(elapsed), "relaySet": relay_set}
	if r.has("natType"):
		out["natType"] = nat
	out["candidateTypes"] = {"local": local, "remote": remote}
	out["clientVersion"] = version
	return out


# ---- the connection check's verdict and NAT classification (spec/diagnostics.md s.8) ---------------------------------

## The one line a menu shows for a check ({udp, natType, relay} in, {verdict, message} out; first match wins).
static func check_verdict(r: Dictionary) -> Dictionary:
	var udp := str(r.get("udp", "unknown"))
	var nat := str(r.get("natType", "unknown"))
	var relay := str(r.get("relay", "none"))
	if relay == "refused":
		return {"verdict": "relay_refused", "message": "The relay rejected the login. Check the relay line; it may have expired."}
	if relay == "unreachable":
		return {"verdict": "relay_unreachable", "message": "The relay did not answer. Check the relay line and your network."}
	if udp == "blocked" and relay == "ok":
		return {"verdict": "relay_works", "message": "Direct connections will fail, but your relay works."}
	if udp == "blocked":
		return {"verdict": "blocked", "message": "Direct connections: will fail. Your network blocks UDP (or the test servers could not be reached). A relay or another network is needed."}
	if nat == "symmetric" and relay == "ok":
		return {"verdict": "relay_works", "message": "Direct connections may fail, but your relay works."}
	if nat == "symmetric":
		return {"verdict": "likely_fail", "message": "Direct connections: likely to fail. A relay is recommended."}
	if nat == "open" or nat == "cone":
		return {"verdict": "good", "message": "Direct connections: likely to work."}
	return {"verdict": "unknown", "message": "Could not tell how your network handles direct connections."}


## `udp` and `natType` from what the STUN servers saw: `asked` servers were queried from one socket, `answers` are the
## mapped addresses that came back ([{ip, port}]), `local` the socket's own {ip, port} when known (it decides `open`).
static func classify_nat(asked: int, answers: Array, local: Variant) -> Dictionary:
	if answers.is_empty():
		return {"udp": "blocked" if asked > 0 else "unknown", "natType": "unknown"}
	if answers.size() == 1:
		return {"udp": "ok", "natType": "unknown"}
	var first: Dictionary = answers[0]
	for a: Dictionary in answers:
		if str(a["ip"]) != str(first["ip"]) or int(a["port"]) != int(first["port"]):
			return {"udp": "ok", "natType": "symmetric"}
	if local is Dictionary and str(local["ip"]) == str(first["ip"]) and int(local["port"]) == int(first["port"]):
		return {"udp": "ok", "natType": "open"}
	return {"udp": "ok", "natType": "cone"}


## The `nat` fact a `diagnose` call takes from a check result.
static func nat_fact(r: Variant) -> String:
	if not r is Dictionary or (r as Dictionary).is_empty():
		return "unknown"
	if str(r.get("udp", "")) == "blocked":
		return "blocked"
	return str(r.get("natType", "unknown"))
