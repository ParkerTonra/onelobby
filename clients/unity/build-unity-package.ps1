# Builds OneLobby.Core (and the other engine-agnostic OneLobby projects) for netstandard2.1 and copies the DLLs plus
# the NuGet dependencies Unity lacks into com.onelobby.unity/Runtime/Plugins, with .meta files (fixed GUIDs) so the
# package also works from an immutable location (tarball, git URL).
#   powershell -File clients/unity/build-unity-package.ps1  # build (or pwsh) into the package folder
#   powershell -File clients/unity/build-unity-package.ps1 -Pack   # also write clients/unity/com.onelobby.unity-<version>.tgz
# Mirrors build-unity-package.sh. Needs the .NET 8 SDK or newer.
#   powershell -File clients/unity/build-unity-package.ps1 -Pack -Version 0.6.0-dev.4   # stamp that version into the packed package.json and the file name
# Every run also copies the recipes into com.onelobby.unity/Documentation~ (untracked build output).
param([switch]$Pack, [string[]]$Extra = @(), [string]$Version = '')
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$pkg = (Resolve-Path (Join-Path $here "com.onelobby.unity")).Path
$dotnet = Join-Path (Split-Path $here) 'dotnet'
$plugins = Join-Path $pkg 'Runtime/Plugins'
$deps = Join-Path $plugins 'Dependencies'

# Engine-agnostic projects shipped as DLLs. OneLobby.Replication (and any -Extra project) is picked up when present.
$projects = @('OneLobby.Core', 'OneLobby.DataChannel', 'OneLobby.Opus', 'OneLobby.Replication', 'OneLobby.Direct') + $Extra
# Built as project references of the above (OneLobby.Direct embeds the signaling hub from server/) and shipped too.
$alsoOurs = @('OneLobby.Hub')
# NuGet dependencies Unity's .NET Standard 2.1 profile does NOT provide (checked against Unity 6000.2:
# System.Memory, System.Buffers, System.Numerics.Vectors and System.Threading.Tasks.Extensions are built in, so they
# are not copied; copying them would give duplicate-assembly errors).
$shipDeps = @('System.Text.Json', 'System.Text.Encodings.Web', 'Microsoft.Bcl.AsyncInterfaces',
              'System.Runtime.CompilerServices.Unsafe', 'Concentus',
              'Microsoft.Extensions.Logging.Abstractions', 'Microsoft.Extensions.DependencyInjection.Abstractions')
# The hub only uses NullLogger, which never loads System.Diagnostics.DiagnosticSource (Unity has its own copy in the
# editor only), so it is not shipped and Unity's import-time reference check is off for the DLL that names it.
$noValidate = @('Microsoft.Extensions.Logging.Abstractions.dll')

$out = Join-Path ([IO.Path]::GetTempPath()) ('onelobby-unity-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $out | Out-Null
$ours = @()
foreach ($p in $projects) {
    $csproj = Join-Path $dotnet "$p/$p.csproj"
    if (-not (Test-Path $csproj)) { Write-Host "skip $p (not in this checkout)"; continue }
    Write-Host "build $p (netstandard2.1)"
    # ContinuousIntegrationBuild: source paths in the DLLs become /_/... instead of this machine's checkout path
    dotnet publish $csproj -c Release -f netstandard2.1 -o $out --nologo -v quiet -p:ContinuousIntegrationBuild=true
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish $p failed" }
    $ours += $p
}

if (Test-Path $plugins) { Remove-Item -Recurse -Force $plugins }
New-Item -ItemType Directory -Force $deps | Out-Null

function Write-Meta([string]$path, [string]$kind, [string]$template = '') {
    $rel = $path.Substring($pkg.Length + 1).Replace('\', '/')
    $md5 = [Security.Cryptography.MD5]::Create()
    $guid = -join ($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes("com.onelobby.unity/$rel")) | ForEach-Object { $_.ToString('x2') })
    $body = switch ($kind) {
        'folder' { "fileFormatVersion: 2`nguid: $guid`nfolderAsset: yes`nDefaultImporter:`n  externalObjects: {}`n  userData: `n  assetBundleName: `n  assetBundleVariant: `n" }
        'dll' { $validate = if ($noValidate -contains (Split-Path $path -Leaf)) { 0 } else { 1 }
                "fileFormatVersion: 2`nguid: $guid`nPluginImporter:`n  externalObjects: {}`n  serializedVersion: 2`n  iconMap: {}`n  executionOrder: {}`n  defineConstraints: []`n  isPreloaded: 0`n  isOverridable: 0`n  isExplicitlyReferenced: 0`n  validateReferences: $validate`n  platformData:`n  - first:`n      Any: `n    second:`n      enabled: 1`n      settings: {}`n  userData: `n  assetBundleName: `n  assetBundleVariant: `n" }
        'native' { (Get-Content -Raw (Join-Path $here "plugin-meta/$template.meta.template")).Replace('{{GUID}}', $guid) }
        default { "fileFormatVersion: 2`nguid: $guid`nTextScriptImporter:`n  externalObjects: {}`n  userData: `n  assetBundleName: `n  assetBundleVariant: `n" }
    }
    [IO.File]::WriteAllText("$path.meta", $body)
}

foreach ($p in $alsoOurs) { if (Test-Path (Join-Path $out "$p.dll")) { $ours += $p } }
foreach ($p in $ours) {
    Copy-Item (Join-Path $out "$p.dll") $plugins
    if (Test-Path (Join-Path $out "$p.xml")) { Copy-Item (Join-Path $out "$p.xml") $plugins }
}
foreach ($d in $shipDeps) {
    $f = Join-Path $out "$d.dll"
    if (Test-Path $f) { Copy-Item $f $deps }
}
$lic = Join-Path $plugins 'Licenses'
New-Item -ItemType Directory -Force $lic | Out-Null
Copy-Item (Join-Path $dotnet 'OneLobby.DataChannel/native/licenses/*') $lic
Write-Meta $plugins 'folder'
Write-Meta $deps 'folder'
Write-Meta $lic 'folder'
Get-ChildItem $plugins -File -Recurse | Where-Object { $_.Extension -ne '.meta' } | ForEach-Object {
    Write-Meta $_.FullName $(if ($_.Extension -eq '.dll') { 'dll' } else { 'text' })
}

# libdatachannel natives (built by clients/dotnet/OneLobby.DataChannel/native/*, or CI) into Unity's platform folders,
# with per-platform import settings from plugin-meta/*.meta.template.
$natives = @(
    @{ Rid = 'win-x64';       File = 'datachannel.dll';      Dir = 'x86_64' },
    @{ Rid = 'linux-x64';     File = 'libdatachannel.so';    Dir = 'x86_64' },
    @{ Rid = 'osx';           File = 'libdatachannel.dylib'; Dir = 'macOS' },
    @{ Rid = 'android-arm64'; File = 'libdatachannel.so';    Dir = 'Android/arm64-v8a' }
)
$runtimes = Join-Path $dotnet 'OneLobby.DataChannel/runtimes'
foreach ($n in $natives) {
    $from = Join-Path $runtimes "$($n.Rid)/native/$($n.File)"
    if (-not (Test-Path $from)) { Write-Host "native $($n.Rid): not built (skipped)"; continue }
    $dir = $plugins
    foreach ($part in $n.Dir.Split('/')) {
        $dir = Join-Path $dir $part
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory $dir | Out-Null; Write-Meta $dir 'folder' }
    }
    $to = Join-Path $dir $n.File
    Copy-Item $from $to
    Write-Meta $to 'native' $n.Rid
    Write-Host ("native $($n.Rid): {0:N0} bytes" -f (Get-Item $to).Length)
}
Remove-Item -Recurse -Force $out

# Docs a game team needs, shipped in Documentation~ (Unity ignores it; the copies are gitignored build output).
$repo = Split-Path (Split-Path $here)
$docDir = Join-Path $pkg 'Documentation~'
New-Item -ItemType Directory -Force $docDir | Out-Null
$docs = @('docs/recipes/unity.md', 'docs/recipes/direct-ip.md', 'docs/recipes/pause.md', 'docs/recipes/game-console.md',
          'docs/recipes/replication.md', 'docs/recipes/voice-and-chat.md', 'spec/nostr-signaling.md', 'AGENTS.md')
foreach ($d in $docs) {
    $src = Join-Path $repo $d
    if (Test-Path $src) { Copy-Item $src $docDir -Force } else { Write-Host "doc ${d}: not in this checkout (skipped)" }
}
Write-Host "plugins:"; Get-ChildItem $plugins -Recurse -Filter *.dll | ForEach-Object { Write-Host "  $($_.FullName.Substring($pkg.Length + 1))" }

if ($Pack) {
    $version = if ($Version) { $Version } else { (Get-Content (Join-Path $pkg 'package.json') -Raw | ConvertFrom-Json).version }
    $stage = Join-Path ([IO.Path]::GetTempPath()) ('onelobby-pack-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $stage | Out-Null
    Copy-Item -Recurse $pkg (Join-Path $stage 'package')
    if ($Version) {
        # stamp the packed copy only; the tracked package.json stays as it is
        $pj = Join-Path $stage 'package/package.json'
        $text = [IO.File]::ReadAllText($pj)
        $text = [regex]::Replace($text, '"version"\s*:\s*"[^"]*"', '"version": "' + $Version + '"', 1)
        [IO.File]::WriteAllText($pj, $text, (New-Object Text.UTF8Encoding($false)))
    }
    $tgz = Join-Path $here "com.onelobby.unity-$version.tgz"
    # Windows' own bsdtar; a GNU tar earlier on PATH (Git for Windows) reads "C:" as a remote host
    $tar = Join-Path $env:SystemRoot 'System32/tar.exe'
    if (-not $env:SystemRoot -or -not (Test-Path $tar)) { $tar = 'tar' }
    & $tar -czf $tgz -C $stage package
    if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
    Remove-Item -Recurse -Force $stage
    Write-Host "packed $tgz"
}
