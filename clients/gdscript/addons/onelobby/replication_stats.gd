class_name OneLobbyReplicationStats
extends RefCounted
## Counters for tests and debug overlays (JS `ReplicationStats`, C# `ReplicationStats`). Byte counts are replication
## payloads, before the 3-byte lobby header.

var snapshots_sent := 0
var full_snapshots_sent := 0
var keyframes_sent := 0
var snapshot_bytes_sent := 0
var largest_snapshot := 0
var oversize_snapshots := 0
var snapshots_received := 0
var snapshots_dropped := 0
var inputs_sent := 0
var input_bytes_sent := 0
var inputs_received := 0
var inputs_repeated := 0
var inputs_skipped := 0
var inputs_lost := 0
var events_sent := 0
var events_received := 0
var events_duplicate := 0
var events_gap := 0
var events_out_of_order := 0
var malformed := 0


func to_dict() -> Dictionary:
	var d := {}
	for p in get_property_list():
		if int(p["usage"]) & PROPERTY_USAGE_SCRIPT_VARIABLE:
			d[p["name"]] = get(p["name"])
	return d
