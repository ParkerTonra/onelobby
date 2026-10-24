#!/usr/bin/env bash
# Downloads the webrtc-native GDExtension (Godot's WebRTC implementation for desktop) into addons/godot_webrtc/.
# Binaries are not committed. Release: https://github.com/godotengine/webrtc-native/releases/tag/1.2.2-stable
set -euo pipefail
VERSION="${WEBRTC_NATIVE_VERSION:-1.2.2-stable}"
URL="https://github.com/godotengine/webrtc-native/releases/download/${VERSION}/godot-extension-webrtc_native.zip"
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading $URL"
curl -fL --retry 3 -o "$TMP/webrtc.zip" "$URL"
mkdir -p "$TMP/unpacked"
unzip -q "$TMP/webrtc.zip" -d "$TMP/unpacked"
rm -rf "$HERE/addons/godot_webrtc"
mkdir -p "$HERE/addons"
# the zip holds webrtc/ (webrtc.gdextension + lib/); keep it under a stable folder name
SRC="$(find "$TMP/unpacked" -name '*.gdextension' -print -quit | xargs dirname)"
cp -r "$SRC" "$HERE/addons/godot_webrtc"
echo "Installed to $HERE/addons/godot_webrtc"
echo "Run once so Godot registers the extension:  godot --headless --import --path \"$HERE\""
