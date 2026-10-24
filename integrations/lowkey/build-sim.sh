#!/bin/sh
# Builds Lowkey's Sim into integrations/lowkey/.lowkey-sim/ without writing anything inside the Lowkey repo
# (separate output dir and obj dir). Usage: LOWKEY=/c/Users/parke/ClaudeCode/Lowkey sh build-sim.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
LOWKEY="${LOWKEY:-/c/Users/parke/ClaudeCode/Lowkey}"
OUT="$HERE/.lowkey-sim"
dotnet build "$LOWKEY/src/LowkeyIndustries.Sim/LowkeyIndustries.Sim.csproj" -c Release -o "$OUT/bin" \
  -p:BaseIntermediateOutputPath="$OUT/obj/" -p:MSBuildProjectExtensionsPath="$OUT/obj/" --nologo -p:DefaultItemExcludes=obj/**
