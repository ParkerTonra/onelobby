#!/usr/bin/env bash
# Mirrors build-unity-package.ps1: builds the engine-agnostic OneLobby projects for netstandard2.1 and copies the DLLs plus
# the NuGet dependencies Unity lacks into com.onelobby.unity/Runtime/Plugins, with .meta files (fixed GUIDs).
#   clients/unity/build-unity-package.sh            # build into the package folder
#   clients/unity/build-unity-package.sh --pack     # also write clients/unity/com.onelobby.unity-<version>.tgz
# Extra projects: EXTRA="OneLobby.Foo OneLobby.Bar" clients/unity/build-unity-package.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$here/com.onelobby.unity"
dotnetdir="$(dirname "$here")/dotnet"
plugins="$pkg/Runtime/Plugins"
deps="$plugins/Dependencies"
projects="OneLobby.Core OneLobby.Opus OneLobby.Replication ${EXTRA:-}"
# Not copied (built into Unity's .NET Standard 2.1 profile): System.Memory, System.Buffers, System.Numerics.Vectors,
# System.Threading.Tasks.Extensions.
ship_deps="System.Text.Json System.Text.Encodings.Web Microsoft.Bcl.AsyncInterfaces System.Runtime.CompilerServices.Unsafe Concentus"

out="$(mktemp -d)"
ours=""
for p in $projects; do
  csproj="$dotnetdir/$p/$p.csproj"
  if [ ! -f "$csproj" ]; then echo "skip $p (not in this checkout)"; continue; fi
  echo "build $p (netstandard2.1)"
  dotnet publish "$csproj" -c Release -f netstandard2.1 -o "$out" --nologo -v quiet
  ours="$ours $p"
done

rm -rf "$plugins"
mkdir -p "$deps"

guid() { printf '%s' "com.onelobby.unity/$1" | md5sum | cut -c1-32; }
meta() { # path kind
  local rel="${1#"$pkg"/}" g; g="$(guid "$rel")"
  case "$2" in
    folder) printf 'fileFormatVersion: 2\nguid: %s\nfolderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n' "$g" ;;
    dll) printf 'fileFormatVersion: 2\nguid: %s\nPluginImporter:\n  externalObjects: {}\n  serializedVersion: 2\n  iconMap: {}\n  executionOrder: {}\n  defineConstraints: []\n  isPreloaded: 0\n  isOverridable: 0\n  isExplicitlyReferenced: 0\n  validateReferences: 1\n  platformData:\n  - first:\n      Any: \n    second:\n      enabled: 1\n      settings: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n' "$g" ;;
    *) printf 'fileFormatVersion: 2\nguid: %s\nTextScriptImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n' "$g" ;;
  esac > "$1.meta"
}

for p in $ours; do
  cp "$out/$p.dll" "$plugins/"
  [ -f "$out/$p.xml" ] && cp "$out/$p.xml" "$plugins/"
done
for d in $ship_deps; do [ -f "$out/$d.dll" ] && cp "$out/$d.dll" "$deps/"; done
meta "$plugins" folder
meta "$deps" folder
find "$plugins" -type f ! -name '*.meta' | while read -r f; do
  case "$f" in *.dll) meta "$f" dll ;; *) meta "$f" text ;; esac
done
rm -rf "$out"
echo "plugins:"; (cd "$pkg" && find Runtime/Plugins -name '*.dll' | sed 's/^/  /')

if [ "${1:-}" = "--pack" ]; then
  version="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$pkg/package.json" | head -1)"
  stage="$(mktemp -d)"
  cp -R "$pkg" "$stage/package"
  tar -czf "$here/com.onelobby.unity-$version.tgz" -C "$stage" package
  rm -rf "$stage"
  echo "packed $here/com.onelobby.unity-$version.tgz"
fi
