#!/usr/bin/env bash
# Builds libdatachannel (pinned, versions.env) + Mbed TLS for one POSIX target and copies the shared library to
# ../runtimes/<target>/native/ (or $OUT). Data channels only (NO_MEDIA, NO_WEBSOCKET), Mbed TLS linked statically.
#   TARGET=linux-x64      build-posix.sh   # on Linux (build-linux.sh runs this inside Docker ubuntu:22.04)
#   TARGET=osx            build-posix.sh   # on macOS: universal arm64 + x86_64 dylib
#   TARGET=android-arm64  build-posix.sh   # needs ANDROID_NDK_HOME (NDK r26+); API 24, static libc++
# Needs cmake, ninja, git, curl, bzip2 and a C/C++ toolchain.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$here/versions.env"
target="${TARGET:?set TARGET=linux-x64|osx|android-arm64}"
out="${OUT:-$here/../runtimes/$target/native}"
work="${WORK:-/tmp/ldc-$target}"
mkdir -p "$work" && cd "$work"

[ -d libdatachannel ] || git clone --quiet --depth 1 --branch "$LIBDATACHANNEL_TAG" --recurse-submodules --shallow-submodules \
  https://github.com/paullouisageneau/libdatachannel.git libdatachannel
if [ ! -d "mbedtls-$MBEDTLS_VERSION" ]; then
  curl -sSL -o mbedtls.tar.bz2 "https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-$MBEDTLS_VERSION/mbedtls-$MBEDTLS_VERSION.tar.bz2"
  if command -v sha256sum >/dev/null; then echo "$MBEDTLS_SHA256  mbedtls.tar.bz2" | sha256sum -c -
  else echo "$MBEDTLS_SHA256  mbedtls.tar.bz2" | shasum -a 256 -c -; fi
  tar -xjf mbedtls.tar.bz2
  # libdatachannel's DTLS transport needs DTLS-SRTP key export (off by default; Godot enables it too)
  cfg="mbedtls-$MBEDTLS_VERSION/include/mbedtls/mbedtls_config.h"
  sed 's|^//#define MBEDTLS_SSL_DTLS_SRTP|#define MBEDTLS_SSL_DTLS_SRTP|' "$cfg" > "$cfg.new" && mv "$cfg.new" "$cfg"
fi

common=(-G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_POLICY_VERSION_MINIMUM=3.5)
lib=libdatachannel.so
ldflags=""
case "$target" in
  linux-x64)
    ldflags="-static-libstdc++ -static-libgcc -Wl,--no-undefined" ;;
  osx)
    lib=libdatachannel.dylib
    common+=(-DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0) ;;
  android-arm64)
    : "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME}"
    common+=(-DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" -DANDROID_ABI=arm64-v8a
             -DANDROID_PLATFORM=android-24 -DANDROID_STL=c++_static -DCMAKE_FIND_ROOT_PATH="$work/prefix")
    ldflags="-Wl,--no-undefined -Wl,-z,max-page-size=16384" ;;   # 16 KB pages: required for new Play Store uploads
  *) echo "unknown TARGET $target"; exit 2 ;;
esac

cmake -S "mbedtls-$MBEDTLS_VERSION" -B build-mbedtls "${common[@]}" -DENABLE_PROGRAMS=OFF -DENABLE_TESTING=OFF \
  -DUSE_SHARED_MBEDTLS_LIBRARY=OFF -DUSE_STATIC_MBEDTLS_LIBRARY=ON -DCMAKE_INSTALL_PREFIX="$work/prefix"
cmake --build build-mbedtls --target install

# GNU ld resolves static archives in order and a shared object may keep undefined symbols: list the three Mbed TLS
# archives in a group at the end of the link line (Apple ld does not need it) and fail on anything left undefined.
mlib="$(dirname "$(find "$work/prefix" -name libmbedcrypto.a | head -1)")"
extra=()
if [ "$target" != "osx" ]; then
  extra+=(-DCMAKE_CXX_STANDARD_LIBRARIES="-Wl,--start-group $mlib/libmbedtls.a $mlib/libmbedx509.a $mlib/libmbedcrypto.a -Wl,--end-group$([ "$target" = linux-x64 ] && echo " -lpthread")")
fi
rm -rf build-ldc
cmake -S libdatachannel -B build-ldc "${common[@]}" -DUSE_MBEDTLS=ON -DNO_MEDIA=ON -DNO_WEBSOCKET=ON -DNO_EXAMPLES=ON \
  -DNO_TESTS=ON -DCMAKE_PREFIX_PATH="$work/prefix" \
  -DCMAKE_SHARED_LINKER_FLAGS="$ldflags" ${extra[@]+"${extra[@]}"}   # (empty-array safe on macOS bash 3.2)
cmake --build build-ldc --target datachannel

mkdir -p "$out"
cp -L "build-ldc/$lib" "$out/$lib"
case "$target" in
  osx) strip -x "$out/$lib" ;;
  android-arm64) "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*/bin/llvm-strip --strip-unneeded "$out/$lib" ;;
  *) strip --strip-unneeded "$out/$lib" ;;
esac
ls -l "$out/$lib"
