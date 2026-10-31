#!/usr/bin/env bash
# Two headless Godot instances host/join by short code through a running onelobby-server and exchange a message.
#   usage: GODOT=/path/to/godot ./headless-test.sh [ws://127.0.0.1:8080/ws]
# Run fetch-webrtc.sh + `godot --headless --import --path .` first.
set -uo pipefail
GODOT="${GODOT:?set GODOT to a Godot 4.4+ executable}"
SERVER="${1:-ws://127.0.0.1:8080/ws}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
run() { "$GODOT" --headless --audio-driver Dummy --path "$HERE" -s res://tests/e2e.gd -- --role="$1" --server="$SERVER" --code-file="$WORK/code.txt" > "$WORK/$1.out" 2>&1; }
run host & H=$!
run join & J=$!
wait $H; HC=$?
wait $J; JC=$?
echo "host   (exit $HC): $(grep -E '^(hosting|host got|e2e)' "$WORK/host.out" | tr '\n' ' ')"
echo "joiner (exit $JC): $(grep -E '^(joiner listed|joiner got|e2e)' "$WORK/join.out" | tr '\n' ' ')"
grep -h "ERROR" "$WORK/host.out" "$WORK/join.out" | head -n 10
if [ $HC -ne 0 ] || [ $JC -ne 0 ]; then tail -n 30 "$WORK/host.out" "$WORK/join.out"; exit 1; fi
echo "e2e: passed"
