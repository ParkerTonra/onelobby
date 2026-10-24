#!/usr/bin/env bash
# Two headless Godot instances host/join through a running onelobby-server and play gridpaint; compares hashes.
#   usage: GODOT=/path/to/godot_console ./headless-test.sh [ws://127.0.0.1:8080/ws] [ticks]
# Run `dotnet build` and fetch-webrtc.sh + `godot --headless --import --path .` first.
set -euo pipefail
GODOT="${GODOT:?set GODOT to the Godot 4.5.1 mono console executable}"
SERVER="${1:-ws://127.0.0.1:8080/ws}"
TICKS="${2:-600}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
run() { "$GODOT" --headless --path "$HERE" --audio-driver Dummy --log-file "$WORK/$1.log" -- --server="$SERVER" --run-ticks="$TICKS" --paint --name="$1" --result-file="$WORK/$1.txt" ${EXTRA_ARGS:-} "${@:2}" > "$WORK/$1.out" 2>&1; }
run host --auto-host --expect-peers=1 --code-file="$WORK/code.txt" &
H=$!
run joiner --auto-join-file="$WORK/code.txt" &
J=$!
wait $H $J || true
echo "host   : $(grep -c '^hash' "$WORK/host.txt") hash lines, $(grep '^final' "$WORK/host.txt" || echo 'no final')"
echo "joiner : $(grep -c '^hash' "$WORK/joiner.txt") hash lines, $(grep '^final' "$WORK/joiner.txt" || echo 'no final')"
join <(grep '^hash' "$WORK/host.txt" | awk '{print $2, $3}' | sort) <(grep '^hash' "$WORK/joiner.txt" | awk '{print $2, $3}' | sort)   | awk '{c++; if ($2 != $3) bad++} END {print "common hash ticks: " c ", mismatches: " bad+0; exit (bad > 0 || c < 10)}'
grep -h '^chat' "$WORK/host.txt" "$WORK/joiner.txt" | sort | uniq -c
grep -h "^voice" "$WORK/host.txt" "$WORK/joiner.txt" || true
