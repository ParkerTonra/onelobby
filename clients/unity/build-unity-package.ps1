# Builds OneLobby.Core (and the other engine-agnostic OneLobby projects) for netstandard2.1 and copies the DLLs plus
# the NuGet dependencies Unity lacks into com.onelobby.unity/Runtime/Plugins, with .meta files (fixed GUIDs) so the
# package also works from an immutable location (tarball, git URL).
#   powershell -File clients/unity/build-unity-package.ps1  # build (or pwsh) into the package folder
#   powershell -File clients/unity/build-unity-package.ps1 -Pack   # also write clients/unity/com.onelobby.unity-<version>.tgz
# Mirrors build-unity-package.sh. Needs the .NET 8 SDK or newer.
param([switch]$Pack, [string[]]$Extra = @())
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$pkg = (Resolve-Path (Join-Path $here "com.onelobby.unity")).Path
$dotnet = Join-Path (Split-Path $here) 'dotnet'
$plugins = Join-Path $pkg 'Runtime/Plugins'
$deps = Join-Path $plugins 'Dependencies'

# Engine-agnostic projects shipped as DLLs. OneLobby.Replication (and any -Extra project) is picked up when present.
$projects = @('OneLobby.Core', 'OneLobby.Opus', 'OneLobby.Replication') + $Extra
# NuGet dependencies Unity's .NET Standard 2.1 profile does NOT provide (checked against Unity 6000.2:
# System.Memory, System.Buffers, System.Numerics.Vectors and System.Threading.Tasks.Extensions are built in, so they
# are not copied; copying them would give duplicate-assembly errors).
$shipDeps = @('System.Text.Json', 'System.Text.Encodings.Web', 'Microsoft.Bcl.AsyncInterfaces',
              'System.Runtime.CompilerServices.Unsafe', 'Concentus')

$out = Join-Path ([IO.Path]::GetTempPath()) ('onelobby-unity-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $out | Out-Null
$ours = @()
foreach ($p in $projects) {
    $csproj = Join-Path $dotnet "$p/$p.csproj"
    if (-not (Test-Path $csproj)) { Write-Host "skip $p (not in this checkout)"; continue }
    Write-Host "build $p (netstandard2.1)"
    dotnet publish $csproj -c Release -f netstandard2.1 -o $out --nologo -v quiet
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish $p failed" }
    $ours += $p
}

if (Test-Path $plugins) { Remove-Item -Recurse -Force $plugins }
New-Item -ItemType Directory -Force $deps | Out-Null

function Write-Meta([string]$path, [string]$kind) {
    $rel = $path.Substring($pkg.Length + 1).Replace('\', '/')
    $md5 = [Security.Cryptography.MD5]::Create()
    $guid = -join ($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes("com.onelobby.unity/$rel")) | ForEach-Object { $_.ToString('x2') })
    $body = switch ($kind) {
        'folder' { "fileFormatVersion: 2`nguid: $guid`nfolderAsset: yes`nDefaultImporter:`n  externalObjects: {}`n  userData: `n  assetBundleName: `n  assetBundleVariant: `n" }
        'dll' { "fileFormatVersion: 2`nguid: $guid`nPluginImporter:`n  externalObjects: {}`n  serializedVersion: 2`n  iconMap: {}`n  executionOrder: {}`n  defineConstraints: []`n  isPreloaded: 0`n  isOverridable: 0`n  isExplicitlyReferenced: 0`n  validateReferences: 1`n  platformData:`n  - first:`n      Any: `n    second:`n      enabled: 1`n      settings: {}`n  userData: `n  assetBundleName: `n  assetBundleVariant: `n" }
        default { "fileFormatVersion: 2`nguid: $guid`nTextScriptImporter:`n  externalObjects: {}`n  userData: `n  assetBundleName: `n  assetBundleVariant: `n" }
    }
    [IO.File]::WriteAllText("$path.meta", $body)
}

foreach ($p in $ours) {
    Copy-Item (Join-Path $out "$p.dll") $plugins
    if (Test-Path (Join-Path $out "$p.xml")) { Copy-Item (Join-Path $out "$p.xml") $plugins }
}
foreach ($d in $shipDeps) {
    $f = Join-Path $out "$d.dll"
    if (Test-Path $f) { Copy-Item $f $deps }
}
Write-Meta $plugins 'folder'
Write-Meta $deps 'folder'
Get-ChildItem $plugins -File -Recurse | Where-Object { $_.Extension -ne '.meta' } | ForEach-Object {
    Write-Meta $_.FullName $(if ($_.Extension -eq '.dll') { 'dll' } else { 'text' })
}
Remove-Item -Recurse -Force $out
Write-Host "plugins:"; Get-ChildItem $plugins -Recurse -Filter *.dll | ForEach-Object { Write-Host "  $($_.FullName.Substring($pkg.Length + 1))" }

if ($Pack) {
    $version = (Get-Content (Join-Path $pkg 'package.json') -Raw | ConvertFrom-Json).version
    $stage = Join-Path ([IO.Path]::GetTempPath()) ('onelobby-pack-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $stage | Out-Null
    Copy-Item -Recurse $pkg (Join-Path $stage 'package')
    $tgz = Join-Path $here "com.onelobby.unity-$version.tgz"
    # Windows' own bsdtar; a GNU tar earlier on PATH (Git for Windows) reads "C:" as a remote host
    $tar = Join-Path $env:SystemRoot 'System32/tar.exe'
    if (-not $env:SystemRoot -or -not (Test-Path $tar)) { $tar = 'tar' }
    & $tar -czf $tgz -C $stage package
    if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
    Remove-Item -Recurse -Force $stage
    Write-Host "packed $tgz"
}
