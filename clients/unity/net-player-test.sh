#!/usr/bin/env bash
# End-to-end check of the Unity networked player sample (Samples~/NetPlayer). LOCAL ONLY: it needs a Unity 6 editor and its licence, which CI
# does not have, so no workflow runs it. Loopback only: the editor runs with -batchmode -nographics, every player with -batchmode -nographics --local.
#   1. build the package's libraries into the package folder (build-unity-package.sh; skipped with SKIP_PACKAGE_BUILD=1)
#   2. make a scratch project under .tmp-unity/np that references the package by path, holds the sample and a boot script, build Game.exe
#   3. run a host and a joiner of it, both with --local --netplayer-test; the host log must end with NETPLAYER_OK
#   usage: UNITY=<Unity.exe of Unity 6> clients/unity/net-player-test.sh
# The editor has been seen to end with exit code 0xC0000005 after a run that used WebRTC, so the result lines decide, not the exit code.
set -uo pipefail
UNITY="${UNITY:?set UNITY to the Unity 6 editor (Unity.exe)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PKG="$HERE/com.onelobby.unity"
WORK="$ROOT/.tmp-unity/np"
VERSION="$(sed -n 's/^m_EditorVersion: //p' "$ROOT/.tmp-unity/proj/ProjectSettings/ProjectVersion.txt" 2>/dev/null | tr -d '\r')"
VERSION="${UNITY_VERSION:-${VERSION:-6000.2.7f2}}"
[ "${SKIP_PACKAGE_BUILD:-0}" = 1 ] || bash "$HERE/build-unity-package.sh" > "$ROOT/.tmp-unity/package-build.log" 2>&1 || { echo "NETPLAYER_FAIL package build failed (see .tmp-unity/package-build.log)"; exit 1; }
if tasklist //FI "IMAGENAME eq Unity.exe" 2>/dev/null | grep -qi unity.exe; then echo "NETPLAYER_FAIL another Unity editor is running; one at a time"; exit 1; fi
if ! node -e 'const s = require("net").createServer(); s.once("error", (e) => { console.error(e.code); process.exit(3); }); s.listen(47810, "127.0.0.1", () => s.close(() => process.exit(0)));' 2> "$ROOT/.tmp-unity/port"; then
  echo "NETPLAYER_FAIL port 47810 is already in use on this machine"; exit 1
fi
rm -rf "$WORK"; mkdir -p "$WORK/Assets/Editor" "$WORK/ProjectSettings" "$WORK/Packages"
printf 'm_EditorVersion: %s\n' "$VERSION" > "$WORK/ProjectSettings/ProjectVersion.txt"
RELPKG="$(realpath --relative-to="$WORK/Packages" "$PKG" 2>/dev/null || echo "../../../clients/unity/com.onelobby.unity")"
cat > "$WORK/Packages/manifest.json" <<JSON
{ "dependencies": { "com.onelobby.unity": "file:$RELPKG",
  "com.unity.modules.imgui": "1.0.0", "com.unity.modules.ui": "1.0.0", "com.unity.modules.uielements": "1.0.0", "com.unity.modules.audio": "1.0.0",
  "com.unity.modules.jsonserialize": "1.0.0", "com.unity.modules.unitywebrequest": "1.0.0", "com.unity.modules.physics": "1.0.0",
  "com.unity.modules.animation": "1.0.0", "com.unity.modules.imageconversion": "1.0.0", "com.unity.modules.screencapture": "1.0.0" } }
JSON
cp "$PKG/Samples~/NetPlayer/NetPlayerSample.cs" "$WORK/Assets/NetPlayerSample.cs"
cp "$ROOT/clients/js/packages/create-onelobby/templates/unity/editor/BuildPlayer.cs" "$WORK/Assets/Editor/BuildPlayer.cs"
cat > "$WORK/Assets/Boot.cs" <<'CS'
using UnityEngine;
public static class NetPlayerBoot
{
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void Create() { new GameObject("NetPlayerSample").AddComponent<NetPlayerSample>(); }
}
CS
"$UNITY" -batchmode -nographics -quit -projectPath "$WORK" -logFile "$WORK/build.log" -executeMethod OneLobbyBuild.Windows
GAME="$WORK/Builds/Windows/Game.exe"
[ -f "$GAME" ] || { echo "NETPLAYER_FAIL no Game.exe was built"; grep -a -E 'error CS|OneLobbyBuild' "$WORK/build.log" | head -n 5; exit 1; }
# a built player runs only headless and only with --local
"$GAME" -batchmode -nographics -logFile "$WORK/host.log" --host --local --name=Host --netplayer-test & HPID=$!
trap 'kill $HPID 2>/dev/null' EXIT
for _ in $(seq 1 200); do (exec 3<>/dev/tcp/127.0.0.1/47810) 2>/dev/null && break; kill -0 $HPID 2>/dev/null || break; sleep 0.1; done
[ -n "${SOCKET_LIST:-}" ] && (sleep 12; netstat -ano > "$SOCKET_LIST"; tasklist //FI "IMAGENAME eq Game.exe" > "$SOCKET_LIST.pids") &
timeout 90 "$GAME" -batchmode -nographics -logFile "$WORK/join.log" --join=127.0.0.1:47810 --local --name=Joiner --netplayer-test
JC=$?
for _ in $(seq 1 300); do grep -a -q -E '^NETPLAYER_(OK|FAIL)' "$WORK/host.log" && break; kill -0 $HPID 2>/dev/null || break; sleep 0.1; done
grep -a -h -E '^NETPLAYER_' "$WORK/host.log" "$WORK/join.log" | tr -d '\r'
if grep -a -q '^NETPLAYER_OK' "$WORK/host.log"; then exit 0; fi
echo "NETPLAYER_FAIL the host printed no OK (joiner exit $JC)"; tail -n 25 "$WORK/host.log"; tail -n 25 "$WORK/join.log"; exit 1
