#!/usr/bin/env bash
# End-to-end check of create-onelobby's godot-gdscript template, in the GDScript CI job (and by hand). Loopback only.
#   1. scaffold a new project, import it, run its own tests/multiplayer.gd, expect MULTIPLAYER_OK
#   2. play it the way AGENTS.md and the .olc entry say: two headless processes (-- --host --local --name=Host and
#      -- --join=127.0.0.1:47810 --local --name=Joiner); pass when the joiner's menu reaches the lobby with two players
#   3. `create-onelobby verify` on that project must print VERIFY_OK (all routes on 127.0.0.1, the TURN helper fetched anonymously from npm
#      into the project's .onelobby/), and on a copy with a broken onelobby.json VERIFY_FAIL naming the blueprint check
#   3b. scaffold new projects with players in the world (sync.player: owner 3d, host 2d), import, and run their own tests/multiplayer.gd, which also
#      proves one thing about the player on the same two peers (the joiner's player appears on the host and follows it, one jump arrives once);
#      `verify` on the first must list a `player` line that is ok
#   4. scaffold --into an empty Godot project, the same as 1 and 2 (a main scene that only instances the menu; --local is the menu's own
#      flag); then a second --into run must change nothing
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

# two_process <name> <project dir>: the two windows of the play entry, headless. The command lines come from the scaffolded
# .olc/<slug>.json (both shells, matched against AGENTS.md by scaffold-play-args.mjs). test/helpers/scaffold_probe.gd, an autoload added to
# this scratch copy only, watches the real menu and prints PROBE_OK / PROBE_FAIL <the menu's own error text>.
PROBE="$ROOT/clients/js/packages/create-onelobby/test/helpers/scaffold_probe.gd"
two_process() {
  local name="$1" dir="$2" lines host_args join_args
  lines="$(node "$HERE/scaffold-play-args.mjs" "$dir" 2>&1)" || { echo "FAIL $name: $lines"; FAILS=$((FAILS + 1)); return; }
  host_args="$(echo "$lines" | sed -n 1p | tr -d '\r')"; join_args="$(echo "$lines" | sed -n 2p | tr -d '\r')"
  echo "play entry: host: -- $host_args | joiner: -- $join_args"
  # the play entry's direct port: say plainly when another program holds it instead of timing out
  if ! node -e 'const s = require("net").createServer(); s.once("error", (e) => { console.error(e.code); process.exit(3); }); s.listen(47810, "127.0.0.1", () => s.close(() => process.exit(0)));' 2> "$WORK/$name.port"; then
    echo "FAIL $name: port 47810 (the play entry's direct port) is already in use on this machine ($(tr -d '\r\n' < "$WORK/$name.port")); stop what holds it and rerun"; FAILS=$((FAILS + 1)); return
  fi
  cp "$PROBE" "$dir/scaffold_probe.gd"
  sed -i 's#^Net="\*res://net.gd"#&\nScaffoldProbe="*res://scaffold_probe.gd"#' "$dir/project.godot"
  grep -q ScaffoldProbe "$dir/project.godot" || { echo "FAIL $name: could not register the probe autoload"; FAILS=$((FAILS + 1)); return; }
  # shellcheck disable=SC2086
  "${G[@]}" --path "$dir" -- $host_args > "$WORK/$name.host.out" 2>&1 &
  local hpid=$! ok=1
  for _ in $(seq 1 400); do grep -a -q -E 'PROBE_HOST_LISTENING|PROBE_FAIL' "$WORK/$name.host.out" && break; kill -0 $hpid 2>/dev/null || break; sleep 0.1; done
  if grep -a -q PROBE_HOST_LISTENING "$WORK/$name.host.out"; then
    # shellcheck disable=SC2086
    timeout 70 "${G[@]}" --path "$dir" -- $join_args > "$WORK/$name.join.out" 2>&1
    grep -a -q "^PROBE_OK joiner" "$WORK/$name.join.out" && ok=0
    for _ in $(seq 1 100); do grep -a -q "^PROBE_OK host" "$WORK/$name.host.out" && break; sleep 0.1; done
    grep -a -q "^PROBE_OK host" "$WORK/$name.host.out" || ok=1
  fi
  kill $hpid 2>/dev/null; wait $hpid 2>/dev/null
  grep -a -h -E '^PROBE_' "$WORK/$name.host.out" "$WORK/$name.join.out" 2>/dev/null
  if [ $ok -ne 0 ]; then
    echo "FAIL $name: the two play-entry processes did not reach a two-player lobby"; tail -n 15 "$WORK/$name.host.out"; tail -n 15 "$WORK/$name.join.out" 2>/dev/null; FAILS=$((FAILS + 1))
  fi
}

echo "::group::new project (--template godot-gdscript)"
node "$CLI" "$WORK/new" --template godot-gdscript --yes --no-git --addon-from "$ROOT" --webrtc-dir "$NATIVES" || FAILS=$((FAILS + 1))
check new "$WORK/new"
two_process new "$WORK/new"

# verify: the one-command proof, on the good project and on a broken copy
verify_check() {
  local t0=$SECONDS
  node "$CLI" verify "$WORK/new" --godot "$GODOT" --fetch-helpers > "$WORK/verify.out" 2>&1; local rc=$?
  cat "$WORK/verify.out"
  if [ $rc -ne 0 ] || [ "$(tail -n 1 "$WORK/verify.out")" != "VERIFY_OK" ]; then echo "FAIL verify: expected VERIFY_OK as the last line and exit 0 (exit $rc)"; FAILS=$((FAILS + 1)); fi
  cp -r "$WORK/new" "$WORK/new-broken"
  sed -i 's/"maxPlayers": *[0-9]*/"maxPlayers": 1/' "$WORK/new-broken/onelobby.json"
  node "$CLI" verify "$WORK/new-broken" --godot "$GODOT" > "$WORK/verify-broken.out" 2>&1; rc=$?
  tail -n 3 "$WORK/verify-broken.out"
  if [ $rc -ne 1 ] || ! tail -n 1 "$WORK/verify-broken.out" | grep -q '^VERIFY_FAIL blueprint:'; then echo "FAIL verify: expected VERIFY_FAIL blueprint on the broken copy (exit $rc)"; FAILS=$((FAILS + 1)); fi
  echo "verify took $((SECONDS - t0)) s"
}
verify_check
echo "::endgroup::"

echo "::group::--into an empty Godot project"
mkdir -p "$WORK/into"
printf 'config_version=5\n\n[application]\n\nconfig/name="Into"\nconfig/features=PackedStringArray("4.4")\n' > "$WORK/into/project.godot"
node "$CLI" --into "$WORK/into" --yes --addon-from "$ROOT" --webrtc-dir "$NATIVES" || FAILS=$((FAILS + 1))
grep -q 'Net="\*res://net.gd"' "$WORK/into/project.godot" || { echo "FAIL into: autoload not registered"; FAILS=$((FAILS + 1)); }
check into "$WORK/into"
# the --into game is wired by hand: a main scene that only instances the menu (no game code, no --local logic of its own), then the
# same two-process play as the new project, from the written .olc entry: --local must be enough
cat > "$WORK/into/main.tscn" <<'TSCN'
[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://addons/onelobby/menu/menu.tscn" id="1_menu"]

[node name="Main" type="Control"]
layout_mode = 3
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0

[node name="Menu" parent="." instance=ExtResource("1_menu")]
layout_mode = 1
TSCN
sed -i 's#^config/name="Into"#&\nrun/main_scene="res://main.tscn"#' "$WORK/into/project.godot"
grep -q 'run/main_scene' "$WORK/into/project.godot" || { echo "FAIL into: could not set the main scene"; FAILS=$((FAILS + 1)); }
two_process into "$WORK/into"
echo "-- second run:"
node "$CLI" --into "$WORK/into" --yes --addon-from "$ROOT" --webrtc-dir "$NATIVES" --json > "$WORK/again.json"; head -c 300 "$WORK/again.json"; echo " ..."
grep -q '"changed":false' "$WORK/again.json" || { echo "FAIL into: the second run changed something"; FAILS=$((FAILS + 1)); }
echo "::endgroup::"

echo "::group::new projects with players (sync.player: owner 3d, host 2d)"
for variant in "owner 3d" "host 2d"; do
  set -- $variant
  name="players-$1-$2"
  node "$CLI" "$WORK/$name" --template godot-gdscript --yes --no-git --addon-from "$ROOT" --webrtc-dir "$NATIVES" --mode replication --set "sync.player.authority=$1" --set "sync.player.space=$2" || FAILS=$((FAILS + 1))
  for f in player.tscn player.gd game.gd; do test -f "$WORK/$name/$f" || { echo "FAIL $name: $f was not written"; FAILS=$((FAILS + 1)); }; done
  grep -q '_check_player' "$WORK/$name/tests/multiplayer.gd" || { echo "FAIL $name: the generated test has no player check"; FAILS=$((FAILS + 1)); }
  check "$name" "$WORK/$name"
done
node "$CLI" verify "$WORK/players-owner-3d" --godot "$GODOT" > "$WORK/verify-players.out" 2>&1; rc=$?
grep -E '^(player|wiring|direct):' "$WORK/verify-players.out"
if [ $rc -ne 0 ] || [ "$(tail -n 1 "$WORK/verify-players.out" | tr -d '\r')" != "VERIFY_OK" ] || ! grep -q -E '^player: +ok' "$WORK/verify-players.out"; then echo "FAIL verify (players): expected VERIFY_OK and an ok player line (exit $rc)"; tail -n 12 "$WORK/verify-players.out"; FAILS=$((FAILS + 1)); fi
echo "::endgroup::"

[ $FAILS -eq 0 ] && echo "scaffold e2e: ok" || echo "scaffold e2e: $FAILS failed"
[ $FAILS -eq 0 ]
