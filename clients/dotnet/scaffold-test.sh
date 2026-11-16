#!/usr/bin/env bash
# End-to-end check of create-onelobby's godot-csharp template, in the GDScript CI job (it has the .NET build of Godot cached next to the
# standard one) and by hand. Loopback only.
#   0. pack the OneLobby NuGet packages to a fresh local folder under a new version (NuGet never re-reads a version it has seen)
#   1. scaffold a new project (--packages-from that folder), dotnet build, import, run its own tests/MultiplayerTest.tscn, expect MULTIPLAYER_OK
#   2. play it the way AGENTS.md and the .olc entry say: two headless processes (-- --host --local --name=Host and
#      -- --join=127.0.0.1:47810 --local --name=Joiner); pass when the joiner's menu reaches the lobby with two players
#   3. `create-onelobby verify` on that project must print VERIFY_OK (all routes on 127.0.0.1, the TURN helper fetched anonymously from npm
#      into the project's .onelobby/), and on a copy with a broken onelobby.json VERIFY_FAIL naming the blueprint check
#   4. scaffold --into an empty Godot C# project, the same as 1; then a second --into run must change nothing
#   5. the demo project's menu self-check (MenuDemo.tscn -- --menu-selfcheck, no sockets) prints MENU_OK, and its networked player
#      self-check (NetPlayerDemo.tscn -- --netplayer-selfcheck, in-memory network, no sockets) prints NETPLAYER_SELF_OK
# The menu comes from this checkout (--addon-from) and the natives from the folder fetch-webrtc.sh already unpacked (--webrtc-dir), so
# nothing is downloaded twice. Packages: only the registry for Godot.NET.Sdk / GodotSharp (anonymous); OneLobby.* from the local folder.
#   usage: GODOT=/path/to/godot_mono clients/dotnet/scaffold-test.sh   (SCAFFOLD_TMP=<folder> to choose where projects are made,
#          NATIVES=<folder> for the unpacked webrtc-native, default clients/gdscript/addons/godot_webrtc)
set -uo pipefail
GODOT="${GODOT:?set GODOT to the .NET (mono) build of Godot 4.5+}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CLI="$ROOT/clients/js/packages/create-onelobby/bin/create-onelobby.js"
NATIVES="${NATIVES:-$ROOT/clients/gdscript/addons/godot_webrtc}"
node "$ROOT/clients/js/packages/create-onelobby/scripts/build.mjs" || exit 1   # vendors the blueprint loader and the bundles (CI builds only the client)
WORK="${SCAFFOLD_TMP:-$(mktemp -d)}/scaffold-cs-e2e"
rm -rf "$WORK"; mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT
export NUGET_PACKAGES="${NUGET_PACKAGES:-$WORK/nuget-packages}"   # test versions never enter a shared package cache
export DOTNET_NOLOGO=1 DOTNET_CLI_TELEMETRY_OPTOUT=1
G=("$GODOT" --headless --audio-driver Dummy)
FAILS=0
T0=$SECONDS

echo "::group::pack the OneLobby packages (local folder, new version)"
VERSION="0.0.0-scaffold.$(date +%s)"
FEED="$WORK/feed"
if ! ONELOBBY_PACK_ONLY="OneLobby.Core OneLobby.Opus OneLobby.Godot OneLobby.Hub OneLobby.Direct" bash "$HERE/pack.sh" "$VERSION" "$FEED" > "$WORK/pack.out" 2>&1; then
  tail -n 30 "$WORK/pack.out"; echo "FAIL pack"; exit 1
fi
echo "packed $VERSION: $(ls "$FEED" | wc -l) packages in $((SECONDS - T0)) s"
echo "::endgroup::"

build() { # build <project dir>: the .csproj is named (a Godot folder with a .sln beside it makes a bare `dotnet build` ambiguous)
  local dir="$1" proj
  proj="$(cd "$dir" && ls ./*.csproj | head -n 1)"
  (cd "$dir" && dotnet build "$proj" -nologo -v q) > "$WORK/$(basename "$dir").build.out" 2>&1 || { echo "FAIL build $dir"; tail -n 30 "$WORK/$(basename "$dir").build.out"; return 1; }
}

check() { # check <name> <project dir>
  local name="$1" dir="$2"
  build "$dir" || { FAILS=$((FAILS + 1)); return; }
  # --import can crash on exit after a good import (harmless); a bad import shows as a missing extension list
  "${G[@]}" --import --path "$dir" > "$WORK/$name.import.out" 2>&1 || echo "import exited $? (tolerated; checked below)"
  if ! test -s "$dir/.godot/extension_list.cfg"; then
    echo "FAIL $name: import did not register the WebRTC extension"; tail -n 20 "$WORK/$name.import.out"; FAILS=$((FAILS + 1)); return
  fi
  timeout 120 "${G[@]}" --path "$dir" res://tests/MultiplayerTest.tscn > "$WORK/$name.out" 2>&1
  grep -a -E 'MULTIPLAYER_(OK|FAIL)' "$WORK/$name.out" | head -n 3
  if [ "$(grep -a -E 'MULTIPLAYER_(OK|FAIL)' "$WORK/$name.out" | tail -n 1 | tr -d '\r')" != "MULTIPLAYER_OK" ]; then echo "FAIL $name"; tail -n 30 "$WORK/$name.out"; FAILS=$((FAILS + 1)); fi
}

# two_process <name> <project dir>: the two windows of the play entry, headless. The command lines come from the scaffolded
# .olc/<slug>.json (both shells, matched against AGENTS.md by clients/gdscript/scaffold-play-args.mjs). ScaffoldProbe.cs, an autoload added to
# this scratch copy only, watches the real menu and prints PROBE_OK / PROBE_FAIL <the menu's own error text>.
PROBE="$ROOT/clients/js/packages/create-onelobby/test/helpers/ScaffoldProbe.cs"
two_process() {
  local name="$1" dir="$2" lines host_args join_args
  lines="$(node "$ROOT/clients/gdscript/scaffold-play-args.mjs" "$dir" 2>&1)" || { echo "FAIL $name: $lines"; FAILS=$((FAILS + 1)); return; }
  host_args="$(echo "$lines" | sed -n 1p | tr -d '\r')"; join_args="$(echo "$lines" | sed -n 2p | tr -d '\r')"
  echo "play entry: host: -- $host_args | joiner: -- $join_args"
  # the play entry's direct port: say plainly when another program holds it instead of timing out
  if ! node -e 'const s = require("net").createServer(); s.once("error", (e) => { console.error(e.code); process.exit(3); }); s.listen(47810, "127.0.0.1", () => s.close(() => process.exit(0)));' 2> "$WORK/$name.port"; then
    echo "FAIL $name: port 47810 (the play entry's direct port) is already in use on this machine ($(tr -d '\r\n' < "$WORK/$name.port")); stop what holds it and rerun"; FAILS=$((FAILS + 1)); return
  fi
  cp "$PROBE" "$dir/ScaffoldProbe.cs"
  printf '\n[autoload]\n\nScaffoldProbe="*res://ScaffoldProbe.cs"\n' >> "$dir/project.godot"
  build "$dir" || { FAILS=$((FAILS + 1)); return; }
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

echo "::group::new project (--template godot-csharp)"
T1=$SECONDS
node "$CLI" "$WORK/new" --template godot-csharp --yes --no-git --godot "$GODOT" --addon-from "$ROOT" --webrtc-dir "$NATIVES" --packages-from "$FEED" || FAILS=$((FAILS + 1))
head -n 3 "$WORK/new/New.csproj"
check new "$WORK/new"
echo "new project built and tested in $((SECONDS - T1)) s"

# verify: the one-command proof, on the good project and on a broken copy (before the probe autoload goes into the project)
verify_check() {
  local t0=$SECONDS rc
  node "$CLI" verify "$WORK/new" --godot "$GODOT" --fetch-helpers > "$WORK/verify.out" 2>&1; rc=$?
  cat "$WORK/verify.out"
  if [ $rc -ne 0 ] || [ "$(tail -n 1 "$WORK/verify.out" | tr -d '\r')" != "VERIFY_OK" ]; then echo "FAIL verify: expected VERIFY_OK as the last line and exit 0 (exit $rc)"; FAILS=$((FAILS + 1)); fi
  cp -r "$WORK/new" "$WORK/new-broken"
  sed -i 's/"maxPlayers": *[0-9]*/"maxPlayers": 1/' "$WORK/new-broken/onelobby.json"
  node "$CLI" verify "$WORK/new-broken" --godot "$GODOT" > "$WORK/verify-broken.out" 2>&1; rc=$?
  tail -n 3 "$WORK/verify-broken.out"
  if [ $rc -ne 1 ] || ! tail -n 1 "$WORK/verify-broken.out" | grep -q '^VERIFY_FAIL blueprint:'; then echo "FAIL verify: expected VERIFY_FAIL blueprint on the broken copy (exit $rc)"; FAILS=$((FAILS + 1)); fi
  echo "verify took $((SECONDS - t0)) s"
}
verify_check
two_process new "$WORK/new"
echo "::endgroup::"

echo "::group::--into an empty Godot C# project"
T2=$SECONDS
mkdir -p "$WORK/into"
SDK="$(grep -o 'Godot.NET.Sdk/[0-9.]*' "$WORK/new/New.csproj" | head -n 1)"
printf 'config_version=5\n\n[application]\n\nconfig/name="Into"\nconfig/features=PackedStringArray("4.5", "C#")\n\n[dotnet]\n\nproject/assembly_name="Into"\n' > "$WORK/into/project.godot"
printf '<Project Sdk="%s">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <EnableDynamicLoading>true</EnableDynamicLoading>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n</Project>\n' "$SDK" > "$WORK/into/Into.csproj"
printf 'Microsoft Visual Studio Solution File, Format Version 12.00\n' > "$WORK/into/Into.sln"
INTO=(--into "$WORK/into" --yes --addon-from "$ROOT" --webrtc-dir "$NATIVES" --packages-from "$FEED")
node "$CLI" "${INTO[@]}" || FAILS=$((FAILS + 1))
grep -q "OneLobby.Direct\" Version=\"$VERSION\"" "$WORK/into/Into.csproj" || { echo "FAIL into: the package references were not added to Into.csproj"; FAILS=$((FAILS + 1)); }
check into "$WORK/into"
echo "-- second run:"
node "$CLI" "${INTO[@]}" --json > "$WORK/again.json"; head -c 300 "$WORK/again.json"; echo " ..."
grep -q '"changed":false' "$WORK/again.json" || { echo "FAIL into: the second run changed something"; FAILS=$((FAILS + 1)); }
echo "--into done in $((SECONDS - T2)) s"
echo "::endgroup::"

echo "::group::the demo project's menu and networked player self-checks"
T3=$SECONDS
DEMO="$ROOT/clients/dotnet/demo-godot"
# no --import here: the editor would rewrite the SDK version in OneLobbyDemo.csproj (and leave a .old file) in this checkout
if build "$DEMO"; then
  timeout 240 "${G[@]}" --path "$DEMO" res://MenuDemo.tscn -- --menu-selfcheck > "$WORK/demo.out" 2>&1
  grep -a -E '^(MENU_OK|MENU_FAIL|FAIL:)' "$WORK/demo.out" | head -n 5
  if [ "$(grep -a -E '^MENU_(OK|FAIL)' "$WORK/demo.out" | tail -n 1 | cut -c1-7)" != "MENU_OK" ]; then echo "FAIL menu self-check"; tail -n 30 "$WORK/demo.out"; FAILS=$((FAILS + 1)); fi
  # the networked player's check (Godot C# node, spawner, the sample's scripted walk): in-memory network, no sockets, about 10 s
  timeout 240 "${G[@]}" --path "$DEMO" res://NetPlayerDemo.tscn -- --netplayer-selfcheck > "$WORK/netplayer.out" 2>&1
  grep -a -E '^(NETPLAYER_SELF_OK|NETPLAYER_SELF_FAIL|FAIL:)' "$WORK/netplayer.out" | head -n 5
  if [ "$(grep -a -E '^NETPLAYER_SELF_(OK|FAIL)' "$WORK/netplayer.out" | tail -n 1 | cut -c1-17)" != "NETPLAYER_SELF_OK" ]; then echo "FAIL netplayer self-check"; tail -n 30 "$WORK/netplayer.out"; FAILS=$((FAILS + 1)); fi
else
  FAILS=$((FAILS + 1))
fi
echo "menu self-check in $((SECONDS - T3)) s"
echo "::endgroup::"

echo "total $((SECONDS - T0)) s"
[ $FAILS -eq 0 ] && echo "scaffold e2e (godot-csharp): ok" || echo "scaffold e2e (godot-csharp): $FAILS failed"
[ $FAILS -eq 0 ]
