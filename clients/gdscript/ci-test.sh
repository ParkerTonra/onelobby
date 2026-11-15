#!/usr/bin/env bash
# CI runner for the GDScript client: every default test, one summary line. Loopback only (127.0.0.1), no internet.
#   usage: GODOT=/path/to/godot clients/gdscript/ci-test.sh
# Needs: addons/godot_webrtc (fetch-webrtc.sh), node deps (conformance/, clients/js built), dotnet 8 for the lobby server.
# Not run here (opt-in, need internet): direct-test.sh public, nostr-interop-gdscript.mjs --real, TURN flags,
# tests/sign_bench.gd is a timing bench (run for its BIP340 vectors only, no timing assertion).
set -uo pipefail
GODOT="${GODOT:?set GODOT to a Godot 4.4+ executable}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LOG="$(mktemp -d)"
SERVER_PID=""
trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null' EXIT
PASSED=(); FAILED=()
G=("$GODOT" --headless --audio-driver Dummy --path "$HERE")
step() { # step <name> <cmd...>
  local name="$1"; shift
  echo "::group::$name"
  timeout 240 "$@" > "$LOG/$name.out" 2>&1; local rc=$?
  tail -n 40 "$LOG/$name.out"
  echo "::endgroup::"
  if [ $rc -eq 0 ]; then PASSED+=("$name"); echo "PASS $name"; else FAILED+=("$name"); echo "::error::FAIL $name (exit $rc)"; fi
}

step vectors "${G[@]}" -s res://tests/vectors.gd
step blueprint "${G[@]}" -s res://tests/blueprint.gd
step friendly "${G[@]}" -s res://tests/friendly.gd
step nostr_unit "${G[@]}" -s res://tests/nostr_unit.gd
step relay_retry "${G[@]}" -s res://tests/relay_retry.gd
step port_range "${G[@]}" -s res://tests/port_range.gd
step ip_loopback "${G[@]}" -s res://tests/ip_loopback.gd
step sign_bench "${G[@]}" -s res://tests/sign_bench.gd
step direct-test bash "$HERE/direct-test.sh"
step conformance env GODOT="$GODOT" node "$ROOT/conformance/peer/run.mjs" --adapter="$ROOT/clients/gdscript/conformance-adapter.mjs"
step nostr-interop env GODOT="$GODOT" node "$ROOT/integration/nostr-interop-gdscript.mjs"

# lobby server on loopback for e2e.gd
echo "::group::server"
( cd "$ROOT/server" && dotnet run -c Release --project OneLobby.Server -- --listen 127.0.0.1:8787 ) > "$LOG/server.out" 2>&1 &
SERVER_PID=$!
UP=0
for _ in $(seq 1 120); do curl -fs http://127.0.0.1:8787/healthz > /dev/null 2>&1 && { UP=1; break; }; sleep 1; done
tail -n 5 "$LOG/server.out"; echo "::endgroup::"
if [ $UP -eq 1 ]; then step headless-test bash "$HERE/headless-test.sh" ws://127.0.0.1:8787/ws
else FAILED+=("headless-test(server did not start)"); echo "::error::lobby server did not start"; fi

echo "gdscript: ${#PASSED[@]} passed, ${#FAILED[@]} failed${FAILED:+ (${FAILED[*]})}"
[ ${#FAILED[@]} -eq 0 ]
