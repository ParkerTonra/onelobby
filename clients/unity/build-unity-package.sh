#!/usr/bin/env bash
# Mirrors build-unity-package.ps1: builds the engine-agnostic OneLobby projects for netstandard2.1 and copies the DLLs plus
# the NuGet dependencies Unity lacks into com.onelobby.unity/Runtime/Plugins, with .meta files (fixed GUIDs).
#   clients/unity/build-unity-package.sh            # build into the package folder
#   clients/unity/build-unity-package.sh --pack     # also write clients/unity/com.onelobby.unity-<version>.tgz
# Extra projects: EXTRA="OneLobby.Foo OneLobby.Bar" clients/unity/build-unity-package.sh
#   clients/unity/build-unity-package.sh --pack --version 0.6.0-dev.4   # stamp that version into the packed package.json and file name
# Every run also copies the recipes into com.onelobby.unity/Documentation~ (untracked build output).
#   clients/unity/build-unity-package.sh --out /tmp/feed --version 0.6.0-dev.12   # read-only checkout: implies --pack;
# builds a staged copy of the package with dotnet bin/obj in a temp folder and writes only <out>/<tgz>.
set -euo pipefail
pack=0; version_override=""; out_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pack) pack=1 ;;
    --version) version_override="${2:?--version needs a value}"; shift ;;
    --out) out_dir="${2:?--out needs a value}"; pack=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$here/com.onelobby.unity"
dotnetdir="$(dirname "$here")/dotnet"
plugins="$pkg/Runtime/Plugins"
deps="$plugins/Dependencies"
projects="OneLobby.Core OneLobby.DataChannel OneLobby.Opus OneLobby.Replication OneLobby.Direct ${EXTRA:-}"
# Built as project references of the above (OneLobby.Direct embeds the signaling hub from server/) and shipped too.
also_ours="OneLobby.Hub"
# Not copied (built into Unity's .NET Standard 2.1 profile): System.Memory, System.Buffers, System.Numerics.Vectors,
# System.Threading.Tasks.Extensions.
ship_deps="System.Text.Json System.Text.Encodings.Web Microsoft.Bcl.AsyncInterfaces System.Runtime.CompilerServices.Unsafe Concentus
  Microsoft.Extensions.Logging.Abstractions Microsoft.Extensions.DependencyInjection.Abstractions"
# The hub only uses NullLogger, which never loads System.Diagnostics.DiagnosticSource (Unity has its own copy in the
# editor only), so it is not shipped and Unity's import-time reference check is off for the DLL that names it.
no_validate="Microsoft.Extensions.Logging.Abstractions.dll"

publish_args=()
stage_root=""
if [ -n "$out_dir" ]; then
  mkdir -p "$out_dir"; out_dir="$(cd "$out_dir" && pwd)"
  stage_root="$(mktemp -d)"
  # the staged copy is what gets filled and packed; build output in the checkout is left out of it
  cp -R "$pkg" "$stage_root/package"
  pkg="$stage_root/package"; plugins="$pkg/Runtime/Plugins"; deps="$plugins/Dependencies"
  rm -rf "$plugins" "$pkg/Runtime/Plugins.meta"
  # PathMap: the PDB path in each DLL names the temp folder otherwise (in-repo builds map to /_/ already)
  map_from="$stage_root"; command -v cygpath >/dev/null && map_from="$(cygpath -w "$stage_root")"   # MSYS on Windows: dotnet sees C:\...
  publish_args=(--artifacts-path "$stage_root/artifacts" "-p:PathMap=$map_from=/_stage/")
fi

out="$(mktemp -d)"
ours=""
for p in $projects; do
  csproj="$dotnetdir/$p/$p.csproj"
  if [ ! -f "$csproj" ]; then echo "skip $p (not in this checkout)"; continue; fi
  echo "build $p (netstandard2.1)"
  # ContinuousIntegrationBuild: source paths in the DLLs become /_/... instead of this machine's checkout path
  dotnet publish "$csproj" -c Release -f netstandard2.1 -o "$out" --nologo -v quiet -p:ContinuousIntegrationBuild=true ${publish_args[@]+"${publish_args[@]}"}
  ours="$ours $p"
done

rm -rf "$plugins"
mkdir -p "$deps"

guid() { printf '%s' "com.onelobby.unity/$1" | md5sum | cut -c1-32; }
meta() { # path kind
  local rel="${1#"$pkg"/}" g; g="$(guid "$rel")"
  case "$2" in
    folder) printf 'fileFormatVersion: 2\nguid: %s\nfolderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n' "$g" ;;
    dll) local v=1; case " $no_validate " in *" $(basename "$1") "*) v=0 ;; esac
      printf 'fileFormatVersion: 2\nguid: %s\nPluginImporter:\n  externalObjects: {}\n  serializedVersion: 2\n  iconMap: {}\n  executionOrder: {}\n  defineConstraints: []\n  isPreloaded: 0\n  isOverridable: 0\n  isExplicitlyReferenced: 0\n  validateReferences: %s\n  platformData:\n  - first:\n      Any: \n    second:\n      enabled: 1\n      settings: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n' "$g" "$v" ;;
    native) sed "s/{{GUID}}/$g/" "$here/plugin-meta/$3.meta.template" ;;
    *) printf 'fileFormatVersion: 2\nguid: %s\nTextScriptImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n' "$g" ;;
  esac > "$1.meta"
}

for p in $also_ours; do [ -f "$out/$p.dll" ] && ours="$ours $p"; done
for p in $ours; do
  cp "$out/$p.dll" "$plugins/"
  [ -f "$out/$p.xml" ] && cp "$out/$p.xml" "$plugins/"
done
for d in $ship_deps; do [ -f "$out/$d.dll" ] && cp "$out/$d.dll" "$deps/"; done
mkdir -p "$plugins/Licenses"
cp "$dotnetdir/OneLobby.DataChannel/native/licenses/"* "$plugins/Licenses/"
meta "$plugins" folder
meta "$deps" folder
meta "$plugins/Licenses" folder
find "$plugins" -type f ! -name '*.meta' | while read -r f; do
  case "$f" in *.dll) meta "$f" dll ;; *) meta "$f" text ;; esac
done

# libdatachannel natives into Unity's platform folders, import settings from plugin-meta/*.meta.template
runtimes="$dotnetdir/OneLobby.DataChannel/runtimes"
for spec in "win-x64 datachannel.dll x86_64" "linux-x64 libdatachannel.so x86_64" "osx libdatachannel.dylib macOS"             "android-arm64 libdatachannel.so Android/arm64-v8a"; do
  set -- $spec
  from="$runtimes/$1/native/$2"
  if [ ! -f "$from" ]; then echo "native $1: not built (skipped)"; continue; fi
  dir="$plugins"
  IFS=/ read -r -a parts <<< "$3"
  for part in "${parts[@]}"; do
    dir="$dir/$part"
    if [ ! -d "$dir" ]; then mkdir -p "$dir"; meta "$dir" folder; fi
  done
  cp "$from" "$dir/$2"
  meta "$dir/$2" native "$1"
  echo "native $1: $(wc -c < "$dir/$2") bytes"
done
rm -rf "$out"

# Docs a game team needs, shipped in Documentation~ (Unity ignores it; the copies are gitignored build output).
repo="$(dirname "$(dirname "$dotnetdir")")"
docs="docs/recipes/unity.md docs/recipes/direct-ip.md docs/recipes/pause.md docs/recipes/game-console.md
      docs/recipes/replication.md docs/recipes/voice-and-chat.md docs/recipes/room.md spec/nostr-signaling.md AGENTS.md"
mkdir -p "$pkg/Documentation~"
for d in $docs; do
  if [ -f "$repo/$d" ]; then cp "$repo/$d" "$pkg/Documentation~/"; else echo "doc $d: not in this checkout (skipped)"; fi
done
# Repo paths inside the copies point where a package user can open them: a shipped doc at Documentation~/<name>,
# any other docs/ or spec/ file at its GitHub page.
for f in "$pkg/Documentation~/"*.md; do
  SHIPPED="$docs" perl -0pi -e '
    BEGIN { %ship = map { $_ => 1 } split " ", $ENV{SHIPPED} }
    s{(?<![\w/.~-])((?:docs|spec)/[\w./-]+?\.(?:md|json))}{
      $ship{$1} ? "Documentation~/" . ($1 =~ s{.*/}{}r) : "https://github.com/ParkerTonra/onelobby/blob/main/$1" }ge' "$f"
done
echo "plugins:"; (cd "$pkg" && find Runtime/Plugins -name '*.dll' | sed 's/^/  /')

if [ "$pack" = 1 ]; then
  version="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$pkg/package.json" | head -1)"
  if [ -n "$stage_root" ]; then
    stage="$stage_root"; rm -rf "$stage/artifacts"
  else
    stage="$(mktemp -d)"
    cp -R "$pkg" "$stage/package"
  fi
  if [ -n "$version_override" ]; then
    # stamp the packed copy only; the tracked package.json stays as it is
    version="$version_override"
    sed -i "0,/\"version\": *\"[^\"]*\"/s//\"version\": \"$version\"/" "$stage/package/package.json"
  fi
  tgz="${out_dir:-$here}/com.onelobby.unity-$version.tgz"
  tar $(tar --version 2>/dev/null | grep -q GNU && echo --force-local) -czf "$tgz" -C "$stage" package
  rm -rf "$stage"
  echo "packed $tgz"
fi
