#!/usr/bin/env bash
# Packs the OneLobby NuGet packages (Core, Opus, Godot, Direct, Hub, Replication, DataChannel) into one folder.
#   clients/dotnet/pack.sh <version> <out-dir>
#   clients/dotnet/pack.sh 0.6.0-dev.1 ~/onelobby-feed     # a local feed: point a nuget.config at the folder
# Use a new version for every pack: NuGet caches a package by id + version and never re-reads it.
set -euo pipefail
version="${1:?version, e.g. 0.6.0-dev.1}"
out="${2:?output folder}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
mkdir -p "$out"
for proj in \
  "$here/OneLobby.Core/OneLobby.Core.csproj" \
  "$here/OneLobby.Opus/OneLobby.Opus.csproj" \
  "$here/OneLobby.Godot/OneLobby.Godot.csproj" \
  "$repo/server/OneLobby.Hub/OneLobby.Hub.csproj" \
  "$here/OneLobby.Direct/OneLobby.Direct.csproj" \
  "$here/OneLobby.Replication/OneLobby.Replication.csproj" \
  "$here/OneLobby.DataChannel/OneLobby.DataChannel.csproj"; do
  # ContinuousIntegrationBuild: source paths in the DLLs become /_/... instead of this machine's checkout path
  dotnet pack "$proj" -c Release -o "$out" -nologo -v q \
    -p:ContinuousIntegrationBuild=true \
    -p:Version="$version" \
    -p:Authors="OneLobby contributors" \
    -p:PackageLicenseExpression=MIT \
    -p:PackageProjectUrl=https://github.com/ParkerTonra/onelobby \
    -p:RepositoryUrl=https://github.com/ParkerTonra/onelobby \
    -p:RepositoryType=git
done
ls "$out"/*."$version".nupkg
