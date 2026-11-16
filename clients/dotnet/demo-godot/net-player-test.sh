#!/usr/bin/env bash
# The Godot C# sample of the networked player (NetPlayerDemo.tscn) as two headless processes on 127.0.0.1: a host and a joiner, both
# with --local (the direct route, loopback only, no Nostr, nothing leaves this PC) and --netplayer-test. The joiner walks a scripted
# path and jumps once; the host compares where its copy of the joiner's character was with the joiner's own trace and prints
# NETPLAYER_OK or NETPLAYER_FAIL <why>. The twin of clients/gdscript/net-player-test.sh. Needs `dotnet build` of this project, the WebRTC
# natives (fetch-webrtc.sh) and the .NET build of Godot. NO CI STEP RUNS THIS: none fetches the natives for this project. It has run by hand on Windows with Godot 4.7.2 (NETPLAYER_OK, twice). Its WebRTC UDP sockets are bound to every address (0.0.0.0 and [::]), not only to 127.0.0.1: only the signalling TCP link is loopback-only. Known gap, cause: webrtc-native 1.2.2 reads no bindAddress (docs/recipes/direct-ip.md, Automated tests); tools/loopback-check/loopback-sockets.sh --known-gap prints it.
#   usage: GODOT=/path/to/godot_mono clients/dotnet/demo-godot/net-player-test.sh
set -uo pipefail
GODOT="${GODOT:?set GODOT to the .NET (mono) build of Godot 4.5+}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [ -n "${HPID:-}" ] && kill "$HPID" 2>/dev/null' EXIT
G=("$GODOT" --headless --audio-driver Dummy --path "$HERE" res://NetPlayerDemo.tscn --)
# the play entry's direct port: say plainly when another program holds it instead of timing out
if ! node -e 'const s = require("net").createServer(); s.once("error", (e) => { console.error(e.code); process.exit(3); }); s.listen(47810, "127.0.0.1", () => s.close(() => process.exit(0)));' 2> "$WORK/port"; then
  echo "NETPLAYER_FAIL port 47810 is already in use on this machine ($(tr -d '\r\n' < "$WORK/port")); stop what holds it and rerun"; exit 1
fi
"${G[@]}" --host --local --name=Host --netplayer-test > "$WORK/host.out" 2>&1 &
HPID=$!
# the host listens on 127.0.0.1:47810 once its menu has hosted
for _ in $(seq 1 200); do
  (exec 3<>/dev/tcp/127.0.0.1/47810) 2>/dev/null && break
  kill -0 "$HPID" 2>/dev/null || break
  sleep 0.1
done
timeout 90 "${G[@]}" --join=127.0.0.1:47810 --local --name=Joiner --netplayer-test > "$WORK/join.out" 2>&1
JC=$?
for _ in $(seq 1 300); do grep -a -q -E '^NETPLAYER_(OK|FAIL)' "$WORK/host.out" && break; kill -0 "$HPID" 2>/dev/null || break; sleep 0.1; done
wait "$HPID" 2>/dev/null; HC=$?
HPID=""
grep -a -h -E '^NETPLAYER_' "$WORK/host.out" "$WORK/join.out"
if grep -a -q '^NETPLAYER_OK' "$WORK/host.out" && [ "$JC" -eq 0 ]; then exit 0; fi
if ! grep -a -q -E '^NETPLAYER_(OK|FAIL)' "$WORK/host.out"; then echo "NETPLAYER_FAIL the host printed no verdict (host exit $HC, joiner exit $JC)"; fi
echo "--- host ---"; tail -n 25 "$WORK/host.out"; echo "--- joiner ---"; tail -n 25 "$WORK/join.out"
exit 1
