#!/usr/bin/env bash
# Direct mode, no lobby server: two headless Godot instances, a GDScript host and a GDScript joiner, meet through the
# Nostr test relay (integration/nostr-test-relay.mjs, needs node) and exchange reliable + fast messages; then the
# host leaves. Real WebRTC between the two processes. Then send-after-leave (tests/send_closed.gd, no engine error).
#   usage: GODOT=/path/to/godot ./direct-test.sh            # local test relay
#          GODOT=/path/to/godot ./direct-test.sh public     # the default public relays (needs internet)
#   DIRECT_E2E_ARGS="--relay-only=1 --turn-url=turn:HOST:PORT --turn-secret=S" adds tests/direct_e2e.gd flags (TURN).
# Run fetch-webrtc.sh + `godot --headless --import --path .` first.
set -uo pipefail
GODOT="${GODOT:?set GODOT to a Godot 4.4+ executable}"
MODE="${1:-local}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d)"
RELAY_PID=""
cleanup() { [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
RELAY="public"
if [ "$MODE" != "public" ]; then
  node "$ROOT/integration/nostr-test-relay.mjs" 0 > "$WORK/relay.out" 2>&1 &
  RELAY_PID=$!
  for _ in $(seq 1 50); do grep -q '^relay ws' "$WORK/relay.out" 2>/dev/null && break; sleep 0.1; done
  RELAY="$(grep -m1 '^relay ws' "$WORK/relay.out" | cut -d' ' -f2)"
  [ -n "$RELAY" ] || { echo "test relay did not start"; cat "$WORK/relay.out"; exit 1; }
fi
run() { "$GODOT" --headless --audio-driver Dummy --path "$HERE" -s res://tests/direct_e2e.gd -- --role="$1" --relay="$RELAY" --code-file="$WORK/code.txt" ${DIRECT_E2E_ARGS:-} > "$WORK/$1.out" 2>&1; }
run host & H=$!
run join & J=$!
wait $H; HC=$?
wait $J; JC=$?
echo "relay: $RELAY"
echo "host   (exit $HC): $(grep -E '^(hosting|host got|host sees|direct e2e)' "$WORK/host.out" | tr '\n' ' ')"
echo "joiner (exit $JC): $(grep -E '^(joined|joiner got|joiner has|direct e2e)' "$WORK/join.out" | tr '\n' ' ')"
grep -h "ERROR" "$WORK/host.out" "$WORK/join.out" | head -n 10
if [ $HC -ne 0 ] || [ $JC -ne 0 ]; then tail -n 30 "$WORK/host.out" "$WORK/join.out"; exit 1; fi
"$GODOT" --headless --audio-driver Dummy --path "$HERE" -s res://tests/send_closed.gd > "$WORK/closed.out" 2>&1; CC=$?
grep -E '^send closed' "$WORK/closed.out"
if [ $CC -ne 0 ] || grep -q 'isClosed' "$WORK/closed.out"; then tail -n 30 "$WORK/closed.out"; exit 1; fi
echo "direct e2e: passed"
