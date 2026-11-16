#!/usr/bin/env bash
# A Direct-IP host and a joiner as two processes on 127.0.0.1 (no lobby server, no Nostr, no router request): the echo smoke
# of the JS client (clients/js/e2e/direct-smoke.mjs, needs `npm run build` first) or of the C# client (OneLobby.DataChannel.Smoke,
# needs its libdatachannel native). Prints both logs; exits 0 when the joiner printed PASS and the host PASS host.
# Run it through loopback-sockets.sh to also check which sockets the two processes hold.
#   usage: direct-pair.sh js|dotnet
set -uo pipefail
KIND="${1:?usage: direct-pair.sh js|dotnet}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=47811
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [ -n "${HPID:-}" ] && kill "$HPID" 2>/dev/null' EXIT
case "$KIND" in
  js)
    HOST=(node "$ROOT/clients/js/e2e/direct-smoke.mjs" host "$PORT" - --loopback --wait=40)
    JOIN=(node "$ROOT/clients/js/e2e/direct-smoke.mjs" join "127.0.0.1:$PORT") ;;
  dotnet)
    DLL="$ROOT/clients/dotnet/OneLobby.DataChannel.Smoke/bin/Release/net8.0/OneLobby.DataChannel.Smoke.dll"
    [ -f "$DLL" ] || { echo "direct-pair: build first: dotnet build clients/dotnet/OneLobby.DataChannel.Smoke -c Release"; exit 2; }
    HOST=(dotnet "$DLL" host-direct "$PORT" - --loopback --no-upnp --no-nostr --wait=40)
    JOIN=(dotnet "$DLL" join-direct "127.0.0.1:$PORT" --loopback --no-nostr) ;;
  *) echo "usage: direct-pair.sh js|dotnet"; exit 2 ;;
esac
"${HOST[@]}" > "$WORK/host.out" 2>&1 &
HPID=$!
for _ in $(seq 1 200); do grep -a -q 'waiting for joiners' "$WORK/host.out" && break; kill -0 "$HPID" 2> /dev/null || break; sleep 0.1; done
timeout 60 "${JOIN[@]}" > "$WORK/join.out" 2>&1; JC=$?
wait "$HPID"; HC=$?
HPID=""
echo "--- host (exit $HC) ---"; tail -n 12 "$WORK/host.out"; echo "--- joiner (exit $JC) ---"; tail -n 12 "$WORK/join.out"
grep -a -q '^PASS host' "$WORK/host.out" && grep -a -q 'PASS' "$WORK/join.out" && [ "$JC" -eq 0 ] && [ "$HC" -eq 0 ]
