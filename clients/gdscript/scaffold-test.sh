#!/usr/bin/env bash
# End-to-end check of create-onelobby's godot-gdscript template, in the GDScript CI job (and by hand). Loopback only.
#   1. scaffold a new project, import it, run its own tests/multiplayer.gd, expect MULTIPLAYER_OK
#   2. scaffold --into an empty Godot project, the same; then a second --into run must change nothing
# The add-on comes from this checkout (--addon-from) and the natives from the folder fetch-webrtc.sh already unpacked
# (--webrtc-dir), so nothing is downloaded twice.
#   usage: GODOT=/path/to/godot clients/gdscript/scaffold-test.sh      (SCAFFOLD_TMP=<folder> to choose where projects are made)
set -uo pipefail
GODOT="${GODOT:?set GODOT to a Godot 4.4+ executable}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CLI="$ROOT/clients/js/packages/create-onelobby/bin/create-onelobby.js"
NATIVES="$HERE/addons/godot_webrtc"
node "$ROOT/clients/js/packages/create-onelobby/scripts/build.mjs" || exit 1   # vendors the blueprint loader and the add-on bundle (CI builds only the client)
WORK="${SCAFFOLD_TMP:-$(mktemp -d)}/scaffold-e2e"
rm -rf "$WORK"; mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT
G=("$GODOT" --headless --audio-driver Dummy)
FAILS=0

check() { # check <name> <project dir>
  local name="$1" dir="$2"
  # --import can crash on exit after a good import (harmless); a bad import shows as a missing class cache or extension list
  "${G[@]}" --import --path "$dir" > "$WORK/$name.import.out" 2>&1 || echo "import exited $? (tolerated; checked below)"
  if ! grep -q OneLobbyClient "$dir/.godot/global_script_class_cache.cfg" || ! test -s "$dir/.godot/extension_list.cfg"; then
    echo "FAIL $name: import did not register the add-on classes and the WebRTC extension"; tail -n 20 "$WORK/$name.import.out"; FAILS=$((FAILS + 1)); return
  fi
  timeout 120 "${G[@]}" --path "$dir" -s res://tests/multiplayer.gd > "$WORK/$name.out" 2>&1
  grep -a -E 'MULTIPLAYER_(OK|FAIL)' "$WORK/$name.out" | head -n 3
  if ! grep -a -q '^MULTIPLAYER_OK' "$WORK/$name.out"; then echo "FAIL $name"; tail -n 30 "$WORK/$name.out"; FAILS=$((FAILS + 1)); fi
}

echo "::group::new project (--template godot-gdscript)"
node "$CLI" "$WORK/new" --template godot-gdscript --yes --no-git --addon-from "$ROOT" --webrtc-dir "$NATIVES" || FAILS=$((FAILS + 1))
check new "$WORK/new"
echo "::endgroup::"

echo "::group::--into an empty Godot project"
mkdir -p "$WORK/into"
printf 'config_version=5\n\n[application]\n\nconfig/name="Into"\nconfig/features=PackedStringArray("4.4")\n' > "$WORK/into/project.godot"
node "$CLI" --into "$WORK/into" --yes --addon-from "$ROOT" --webrtc-dir "$NATIVES" || FAILS=$((FAILS + 1))
grep -q 'Net="\*res://net.gd"' "$WORK/into/project.godot" || { echo "FAIL into: autoload not registered"; FAILS=$((FAILS + 1)); }
check into "$WORK/into"
echo "-- second run:"
node "$CLI" --into "$WORK/into" --yes --addon-from "$ROOT" --webrtc-dir "$NATIVES" --json > "$WORK/again.json"; head -c 300 "$WORK/again.json"; echo " ..."
grep -q '"changed":false' "$WORK/again.json" || { echo "FAIL into: the second run changed something"; FAILS=$((FAILS + 1)); }
echo "::endgroup::"

[ $FAILS -eq 0 ] && echo "scaffold e2e: ok" || echo "scaffold e2e: $FAILS failed"
[ $FAILS -eq 0 ]
