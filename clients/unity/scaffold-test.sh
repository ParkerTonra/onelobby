#!/usr/bin/env bash
# End-to-end check of create-onelobby's unity template. LOCAL ONLY: it needs a Unity 6 editor and its licence, which CI does not have, so it is
# not run by any workflow. Loopback only: the editor runs with -batchmode -nographics, every player with -batchmode and --local.
#   1. scaffold a new project (--package-from a tarball), run its own play-mode test (expect MULTIPLAYER_OK in the Unity log)
#   2. build the Windows player with the scaffolded editor script, then run two players the way the .olc entry does
#      (--host --local --name=Host, --join=127.0.0.1:47810 --local --name=Joiner): both logs must say they bound 127.0.0.1 only and
#      must hold the roster line the scaffolded Boot.cs logs, "Lobby: 2 players: Host, Joiner"
#   3. `create-onelobby verify` must end in VERIFY_OK, and in VERIFY_FAIL blueprint: on a copy with a broken onelobby.json
#   4. scaffold --into an empty Unity project (ProjectVersion.txt and a manifest only), the test again; a second --into run changes nothing
#   usage: PACKAGE_TGZ=<com.onelobby.unity-*.tgz with the natives> UNITY=<Unity.exe> clients/unity/scaffold-test.sh
#          (the unity-dev-package CI artifact has the natives; SCAFFOLD_TMP=<folder> chooses where projects are made, default: a temp folder)
# The editor has been seen to end with exit code 0xC0000005 while it closes after a test run that passed, so the result line decides, not the exit code.
set -uo pipefail
PACKAGE_TGZ="${PACKAGE_TGZ:?set PACKAGE_TGZ to a com.onelobby.unity tarball that has the native libraries}"
UNITY="${UNITY:?set UNITY to the Unity 6 editor (Unity.exe)}"
if ! tar --force-local -tzf "$PACKAGE_TGZ" 2>/dev/null | grep -q 'Runtime/Plugins/x86_64/datachannel\.dll$'; then
  echo "SCAFFOLD_FAIL no Windows WebRTC library (datachannel.dll) in $PACKAGE_TGZ: build the package with its natives or take the unity-dev-package CI artifact"; exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CLI="$ROOT/clients/js/packages/create-onelobby/bin/create-onelobby.js"
node "$ROOT/clients/js/packages/create-onelobby/scripts/build.mjs" || exit 1
WORK="${SCAFFOLD_TMP:-$(mktemp -d)}/scaffold-unity-e2e"
rm -rf "$WORK"; mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT
FAILS=0
T0=$SECONDS
U=("$UNITY" -batchmode -nographics)

run_test() { # run_test <name> <project dir>
  local name="$1" dir="$2"
  "${U[@]}" -projectPath "$dir" -runTests -testPlatform PlayMode -assemblyNames OneLobbyGame.Tests -testResults "$WORK/$name.tests.xml" -logFile "$WORK/$name.tests.log" --local
  local rc=$?
  local line; line="$(grep -a -E '^MULTIPLAYER_(OK|FAIL)' "$WORK/$name.tests.log" | tail -n 1 | tr -d '\r')"
  echo "$name: ${line:-no result line} (Unity exit $rc)"
  if [ "$line" != "MULTIPLAYER_OK" ]; then echo "FAIL $name"; grep -a -E 'error CS|Exception' "$WORK/$name.tests.log" | head -n 5; FAILS=$((FAILS + 1)); fi
}

echo "::group::new project (--template unity)"
node "$CLI" "$WORK/new" --template unity --yes --no-git --unity "$UNITY" --package-from "$PACKAGE_TGZ" || FAILS=$((FAILS + 1))
run_test new "$WORK/new"
"${U[@]}" -quit -projectPath "$WORK/new" -logFile "$WORK/new.build.log" -executeMethod OneLobbyBuild.Windows
test -f "$WORK/new/Builds/Windows/Game.exe" || { echo "FAIL build: no Builds/Windows/Game.exe"; grep -a -E 'error CS|OneLobbyBuild' "$WORK/new.build.log" | head -n 5; FAILS=$((FAILS + 1)); }
# the play entry's commands: the flags are read from the scaffolded .olc entry, so a change there is caught here
ENTRY="$WORK/new/.olc/new.json"
node -e '
const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).entries.find((x) => x.shell === "bash").command;
if (!/--host --local --name=Host/.test(e) || !/--join=127\.0\.0\.1:47810 --local --name=Joiner/.test(e)) { console.error("the .olc entry does not carry the host and joiner flags"); process.exit(1); }
' "$ENTRY" || FAILS=$((FAILS + 1))
GAME="$WORK/new/Builds/Windows/Game.exe"
if [ -f "$GAME" ]; then
  "$GAME" -batchmode -nographics -logFile "$WORK/host.log" --host --local --name=Host & HPID=$!
  sleep 6
  timeout 25 "$GAME" -batchmode -nographics -logFile "$WORK/join.log" --join=127.0.0.1:47810 --local --name=Joiner
  kill $HPID 2>/dev/null; wait $HPID 2>/dev/null
  for l in host join; do
    grep -a -q "bound to 127.0.0.1 only" "$WORK/$l.log" || { echo "FAIL players: the $l log never says it bound 127.0.0.1 only"; FAILS=$((FAILS + 1)); }
    grep -a -q "^Lobby: 2 players: Host, Joiner" "$WORK/$l.log" || { echo "FAIL players: the $l log never shows the two-player lobby (Lobby: 2 players: Host, Joiner)"; FAILS=$((FAILS + 1)); }
    echo "$l: $(grep -a -E '^Lobby: ' "$WORK/$l.log" | tail -n 1 | tr -d '\r')"
  done
fi
echo "::endgroup::"

echo "::group::verify"
T1=$SECONDS
node "$CLI" verify "$WORK/new" --unity "$UNITY" > "$WORK/verify.out" 2>&1; rc=$?
cat "$WORK/verify.out"
if [ $rc -ne 0 ] || [ "$(tail -n 1 "$WORK/verify.out" | tr -d '\r')" != "VERIFY_OK" ]; then echo "FAIL verify: expected VERIFY_OK as the last line and exit 0 (exit $rc)"; FAILS=$((FAILS + 1)); fi
echo "verify took $((SECONDS - T1)) s"
cp -r "$WORK/new" "$WORK/new-broken"
sed -i 's/"maxPlayers": *[0-9]*/"maxPlayers": 1/' "$WORK/new-broken/Assets/Resources/onelobby.json"
node "$CLI" verify "$WORK/new-broken" --unity "$UNITY" > "$WORK/verify-broken.out" 2>&1; rc=$?
tail -n 3 "$WORK/verify-broken.out"
if [ $rc -ne 1 ] || ! tail -n 1 "$WORK/verify-broken.out" | grep -q '^VERIFY_FAIL blueprint:'; then echo "FAIL verify: expected VERIFY_FAIL blueprint on the broken copy (exit $rc)"; FAILS=$((FAILS + 1)); fi
echo "::endgroup::"

echo "::group::--into an empty Unity project"
mkdir -p "$WORK/into/Assets" "$WORK/into/ProjectSettings" "$WORK/into/Packages"
printf 'm_EditorVersion: %s\n' "$(sed -n 's/^m_EditorVersion: //p' "$WORK/new/ProjectSettings/ProjectVersion.txt")" > "$WORK/into/ProjectSettings/ProjectVersion.txt"
printf '{\n  "dependencies": {\n    "com.unity.modules.ui": "1.0.0"\n  }\n}\n' > "$WORK/into/Packages/manifest.json"
INTO=(--into "$WORK/into" --yes --unity "$UNITY" --package-from "$PACKAGE_TGZ")
node "$CLI" "${INTO[@]}" || FAILS=$((FAILS + 1))
grep -q '"com.onelobby.unity"' "$WORK/into/Packages/manifest.json" || { echo "FAIL into: the package line was not added"; FAILS=$((FAILS + 1)); }
run_test into "$WORK/into"
echo "-- second run:"
node "$CLI" "${INTO[@]}" --json > "$WORK/again.json"; head -c 300 "$WORK/again.json"; echo " ..."
grep -q '"changed":false' "$WORK/again.json" || { echo "FAIL into: the second run changed something"; FAILS=$((FAILS + 1)); }
echo "::endgroup::"

echo "total $((SECONDS - T0)) s"
[ $FAILS -eq 0 ] && echo "scaffold e2e (unity): ok" || echo "scaffold e2e (unity): $FAILS failed"
[ $FAILS -eq 0 ]
