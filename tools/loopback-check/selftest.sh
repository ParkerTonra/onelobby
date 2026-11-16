#!/usr/bin/env bash
# Proves loopback-sockets.sh sees what it must: a node process on 127.0.0.1 passes, one on every interface fails, a known gap
# warns instead, and a run with no socket is reported as blind. Linux only.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/loopback-sockets.sh"
FAILS=0
# a node that opens a UDP and a TCP socket on $1 and holds them 1.5 s
hold() { node -e 'const a = process.argv[1]; require("dgram").createSocket("udp4").bind(0, a); require("net").createServer().listen(0, a); setTimeout(() => process.exit(0), 1500);' "$1"; }
expect() { # expect <wanted exit 0|1> <label> <check args...>
  local want="$1" label="$2"; shift 2
  bash "$CHECK" "$@"; local rc=$?
  if { [ "$want" = 0 ] && [ $rc -eq 0 ]; } || { [ "$want" = 1 ] && [ $rc -ne 0 ]; }; then echo "selftest ok: $label (exit $rc)"
  else echo "::error::selftest FAIL: $label (exit $rc, wanted $want)"; FAILS=$((FAILS + 1)); fi
}
export -f hold
expect 0 "loopback sockets pass" lo -- bash -c 'hold 127.0.0.1'
expect 1 "wildcard sockets fail" any -- bash -c 'hold 0.0.0.0'
expect 0 "wildcard sockets under --known-gap warn only" --known-gap "selftest" gap -- bash -c 'hold 0.0.0.0'
expect 1 "a run with no socket is blind" none -- sleep 1
expect 1 "the command's own failure stays a failure" bad -- bash -c 'hold 127.0.0.1; exit 3'
[ $FAILS -eq 0 ]
