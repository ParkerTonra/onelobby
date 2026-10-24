#!/usr/bin/env bash
# linux-x64 libdatachannel.so inside Docker (ubuntu:22.04, glibc 2.35): runs build-posix.sh there and copies the result
# to ../runtimes/linux-x64/native/. Needs Docker. Run from anywhere (Git Bash on Windows works):
#   clients/dotnet/OneLobby.DataChannel/native/build-linux.sh
# Already on Linux with the tools installed? TARGET=linux-x64 build-posix.sh does the same without Docker.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../runtimes/linux-x64/native"
mkdir -p "$out"
hostpath() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }   # C:/... under Git Bash, plain path elsewhere
# MSYS_NO_PATHCONV keeps Git Bash from rewriting the container paths
MSYS_NO_PATHCONV=1 docker run --rm -v "$(hostpath "$here"):/native:ro" -v "$(hostpath "$out"):/out" ubuntu:22.04 \
  bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential cmake ninja-build git curl bzip2 ca-certificates >/dev/null && TARGET=linux-x64 OUT=/out bash /native/build-posix.sh'
ls -l "$out/libdatachannel.so"
