# Builds libdatachannel (pinned) with Mbed TLS for win-x64 and copies datachannel.dll to ../runtimes/win-x64/native/.
#   powershell -ExecutionPolicy Bypass -File clients/dotnet/OneLobby.DataChannel/native/build-windows.ps1 [-WorkDir D:\tmp\ldc]
# Needs: Visual Studio 2022+ (or Build Tools) with the C++ workload, git. CMake/Ninja are taken from the Visual Studio
# install (C++ CMake tools component) or PATH. Data channels only: NO_MEDIA, NO_WEBSOCKET (signaling uses ClientWebSocket).
# Static CRT (/MT), so the DLL needs no Visual C++ redistributable. Versions live in versions.env (shared with Linux/CI).
param([string]$WorkDir = (Join-Path ([IO.Path]::GetTempPath()) 'onelobby-datachannel-build'))
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$versions = @{}
foreach ($line in Get-Content (Join-Path $here 'versions.env')) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $k, $v = $line.Split('=', 2); $versions[$k.Trim()] = $v.Trim()
}
$ldcTag = $versions['LIBDATACHANNEL_TAG']; $mbedVer = $versions['MBEDTLS_VERSION']; $mbedSha = $versions['MBEDTLS_SHA256']
$outDir = Join-Path (Split-Path $here) 'runtimes/win-x64/native'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$installs = & $vswhere -all -prerelease -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installs) { throw 'No Visual Studio with the C++ x64 tools found (vswhere).' }
$vs = @($installs)[0]
$vcvars = Join-Path $vs 'VC/Auxiliary/Build/vcvars64.bat'
function Find-Tool([string]$name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($root in (& $vswhere -all -prerelease -products '*' -property installationPath)) {
        $hit = Get-ChildItem -Path (Join-Path $root 'Common7/IDE/CommonExtensions/Microsoft/CMake') -Recurse -Filter $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    throw "$name not found: install the 'C++ CMake tools for Windows' component or put it on PATH"
}
$cmake = Find-Tool 'cmake.exe'
$ninja = Find-Tool 'ninja.exe'
Write-Host "MSVC: $vs`ncmake: $cmake`nninja: $ninja"

New-Item -ItemType Directory -Force $WorkDir | Out-Null
$src = Join-Path $WorkDir "libdatachannel-$ldcTag"
if (-not (Test-Path $src)) {
    git clone --quiet --depth 1 --branch $ldcTag --recurse-submodules --shallow-submodules https://github.com/paullouisageneau/libdatachannel.git $src
    if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }
}
$tarball = Join-Path $WorkDir "mbedtls-$mbedVer.tar.bz2"
if (-not (Test-Path $tarball)) {
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-$mbedVer/mbedtls-$mbedVer.tar.bz2" -OutFile $tarball
}
$sha = (Get-FileHash -Algorithm SHA256 $tarball).Hash.ToLowerInvariant()
if ($sha -ne $mbedSha) { throw "mbedtls tarball sha256 $sha does not match $mbedSha" }
$tar = Join-Path $env:SystemRoot 'System32/tar.exe'
$mbedSrc = Join-Path $WorkDir "mbedtls-$mbedVer"
if (-not (Test-Path $mbedSrc)) { & $tar -xjf $tarball -C $WorkDir; if ($LASTEXITCODE -ne 0) { throw 'extract failed' } }
# libdatachannel's DTLS transport needs DTLS-SRTP key export, off in the default config (Godot enables it too).
$cfg = Join-Path $mbedSrc 'include/mbedtls/mbedtls_config.h'
$text = [IO.File]::ReadAllText($cfg)
if ($text.Contains('//#define MBEDTLS_SSL_DTLS_SRTP')) { [IO.File]::WriteAllText($cfg, $text.Replace('//#define MBEDTLS_SSL_DTLS_SRTP', '#define MBEDTLS_SSL_DTLS_SRTP')) }

$prefix = Join-Path $WorkDir 'prefix-win-x64'
$common = "-G Ninja -DCMAKE_MAKE_PROGRAM=`"$ninja`" -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_DEFAULT_CMP0091=NEW " +
          "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_POSITION_INDEPENDENT_CODE=ON"
function Invoke-Vs([string]$cmdline) {
    cmd /c "`"$vcvars`" >nul && $cmdline"
    if ($LASTEXITCODE -ne 0) { throw "failed: $cmdline" }
}
$mbedBuild = Join-Path $WorkDir 'build-mbedtls-win-x64'
Invoke-Vs "`"$cmake`" -S `"$mbedSrc`" -B `"$mbedBuild`" $common -DENABLE_PROGRAMS=OFF -DENABLE_TESTING=OFF -DUSE_SHARED_MBEDTLS_LIBRARY=OFF -DUSE_STATIC_MBEDTLS_LIBRARY=ON -DCMAKE_INSTALL_PREFIX=`"$prefix`""
Invoke-Vs "`"$cmake`" --build `"$mbedBuild`" --target install"

$ldcBuild = Join-Path $WorkDir 'build-ldc-win-x64'
Invoke-Vs "`"$cmake`" -S `"$src`" -B `"$ldcBuild`" $common -DUSE_MBEDTLS=ON -DNO_MEDIA=ON -DNO_WEBSOCKET=ON -DNO_EXAMPLES=ON -DNO_TESTS=ON -DCMAKE_PREFIX_PATH=`"$prefix`""
Invoke-Vs "`"$cmake`" --build `"$ldcBuild`" --target datachannel"

New-Item -ItemType Directory -Force $outDir | Out-Null
Copy-Item (Join-Path $ldcBuild 'datachannel.dll') $outDir -Force
$dll = Get-Item (Join-Path $outDir 'datachannel.dll')
Write-Host ("datachannel.dll {0:N0} bytes -> {1}" -f $dll.Length, $dll.FullName)
