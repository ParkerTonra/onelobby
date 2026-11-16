#!/usr/bin/env bash
# Puts the libdatachannel natives (datachannel.dll, libdatachannel.so, libdatachannel.dylib) where build-unity-package.sh looks for them,
# clients/dotnet/OneLobby.DataChannel/runtimes/<rid>/native/, WITHOUT building them: it downloads a released com.onelobby.unity tarball
# (anonymous, from the public GitHub release, no login, nothing sent but the request) and takes the natives out of it. The tarball is checked
# against a pinned SHA-256 first. The natives are built from the pins in clients/dotnet/OneLobby.DataChannel/native/versions.env
# (libdatachannel v0.24.6), unchanged since this release.
#   clients/unity/fetch-natives.sh                 # then: clients/unity/build-unity-package.sh --pack
#   clients/unity/fetch-natives.sh --force         # fetch again although the files are there
# Offline, or to build them yourself instead: clients/dotnet/OneLobby.DataChannel/native/build-windows.ps1 (needs Visual Studio's C++ tools).
set -euo pipefail
TAG="unity-v0.7.1"
SHA256="27883fa5c8a965fe554f5457b2811b87335cf4d93e864a351021dec2cf5c861c"
URL="https://github.com/ParkerTonra/onelobby/releases/download/$TAG/com.onelobby.unity-${TAG#unity-v}.tgz"
force=0
case "${1:-}" in "") ;; --force) force=1 ;; *) echo "unknown argument: $1 (only --force)" >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
runtimes="$(dirname "$here")/dotnet/OneLobby.DataChannel/runtimes"
# rid  path inside the package  file
specs=("win-x64 x86_64 datachannel.dll" "linux-x64 x86_64 libdatachannel.so" "osx macOS libdatachannel.dylib" "android-arm64 Android/arm64-v8a libdatachannel.so")
if [ "$force" = 0 ]; then
  all=1; for s in "${specs[@]}"; do set -- $s; [ -f "$runtimes/$1/native/$3" ] || all=0; done
  if [ "$all" = 1 ]; then echo "natives: already in $runtimes (use --force to fetch again)"; exit 0; fi
fi
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "fetching $URL"
curl -fsSL -o "$tmp/pkg.tgz" "$URL" || { echo "fetch-natives: the download failed (offline?). Build the library instead: clients/dotnet/OneLobby.DataChannel/native/build-windows.ps1" >&2; exit 1; }
got="$(sha256sum "$tmp/pkg.tgz" | cut -d' ' -f1)"
if [ "$got" != "$SHA256" ]; then echo "fetch-natives: the tarball's SHA-256 is $got, expected $SHA256; nothing was extracted" >&2; exit 1; fi
tarflags=(); tar --version 2>/dev/null | grep -q GNU && tarflags=(--force-local)
for s in "${specs[@]}"; do
  set -- $s
  member="package/Runtime/Plugins/$2/$3"
  mkdir -p "$runtimes/$1/native"
  tar "${tarflags[@]}" -xzf "$tmp/pkg.tgz" -C "$tmp" "$member"
  cp "$tmp/$member" "$runtimes/$1/native/$3"
  echo "native $1: $(wc -c < "$runtimes/$1/native/$3") bytes"
done
echo "natives are in $runtimes; now run clients/unity/build-unity-package.sh --pack"
