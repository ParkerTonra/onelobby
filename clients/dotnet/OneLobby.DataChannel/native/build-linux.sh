#!/usr/bin/env bash
# Builds libdatachannel (pinned, versions.env) with Mbed TLS for linux-x64 inside Docker (ubuntu:22.04, glibc 2.35) and
# copies libdatachannel.so to ../runtimes/linux-x64/native/. Needs Docker. Run from anywhere:
#   clients/dotnet/OneLobby.DataChannel/native/build-linux.sh
# Without Docker (on a Linux box with build-essential cmake ninja-build git curl bzip2): INSIDE=1 build-linux.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$here/versions.env"
out="$here/../runtimes/linux-x64/native"

if [ "${INSIDE:-}" != "1" ]; then
  mkdir -p "$out"
  # MSYS_NO_PATHCONV keeps Git Bash on Windows from rewriting the container paths
  hostpath() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }   # C:/... under Git Bash, plain path elsewhere
  MSYS_NO_PATHCONV=1 docker run --rm -v "$(hostpath "$here"):/native:ro" -v "$(hostpath "$out"):/out" ubuntu:22.04 \
    bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential cmake ninja-build git curl bzip2 ca-certificates >/dev/null && INSIDE=1 OUT=/out bash /native/build-linux.sh'
  ls -l "$out/libdatachannel.so"
  exit 0
fi

out="${OUT:-$out}"
work="${WORK:-/tmp/ldc}"
mkdir -p "$work" && cd "$work"
[ -d libdatachannel ] || git clone --quiet --depth 1 --branch "$LIBDATACHANNEL_TAG" --recurse-submodules --shallow-submodules \
  https://github.com/paullouisageneau/libdatachannel.git libdatachannel
if [ ! -d "mbedtls-$MBEDTLS_VERSION" ]; then
  curl -sSL -o mbedtls.tar.bz2 "https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-$MBEDTLS_VERSION/mbedtls-$MBEDTLS_VERSION.tar.bz2"
  echo "$MBEDTLS_SHA256  mbedtls.tar.bz2" | sha256sum -c -
  tar -xjf mbedtls.tar.bz2
  # libdatachannel's DTLS transport needs DTLS-SRTP key export (off by default; Godot enables it too)
  sed -i 's|^//#define MBEDTLS_SSL_DTLS_SRTP|#define MBEDTLS_SSL_DTLS_SRTP|' "mbedtls-$MBEDTLS_VERSION/include/mbedtls/mbedtls_config.h"
fi
common=(-G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_POLICY_VERSION_MINIMUM=3.5)
cmake -S "mbedtls-$MBEDTLS_VERSION" -B build-mbedtls "${common[@]}" -DENABLE_PROGRAMS=OFF -DENABLE_TESTING=OFF \
  -DUSE_SHARED_MBEDTLS_LIBRARY=OFF -DUSE_STATIC_MBEDTLS_LIBRARY=ON -DCMAKE_INSTALL_PREFIX="$work/prefix"
cmake --build build-mbedtls --target install
# GNU ld resolves static archives in order and a shared object may keep undefined symbols, so: list the three Mbed TLS
# archives in a group at the end of the link line, and fail the build on anything left undefined.
mlib="$(dirname "$(find "$work/prefix" -name libmbedcrypto.a | head -1)")"
rm -rf build-ldc
cmake -S libdatachannel -B build-ldc "${common[@]}" -DUSE_MBEDTLS=ON -DNO_MEDIA=ON -DNO_WEBSOCKET=ON -DNO_EXAMPLES=ON \
  -DNO_TESTS=ON -DCMAKE_PREFIX_PATH="$work/prefix" \
  -DCMAKE_SHARED_LINKER_FLAGS="-static-libstdc++ -static-libgcc -Wl,--no-undefined" \
  -DCMAKE_CXX_STANDARD_LIBRARIES="-Wl,--start-group $mlib/libmbedtls.a $mlib/libmbedx509.a $mlib/libmbedcrypto.a -Wl,--end-group -lpthread"
cmake --build build-ldc --target datachannel
mkdir -p "$out"
cp -L build-ldc/libdatachannel.so "$out/libdatachannel.so"
strip --strip-unneeded "$out/libdatachannel.so"
ls -l "$out/libdatachannel.so"
