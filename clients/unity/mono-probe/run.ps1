# Licence-free smoke check of the managed half of com.onelobby.unity on Unity's own Mono runtime (unityjit profile):
# OneLobby.Core + OneLobby.DataChannel + the shipped System.Text.Json DLLs + the libdatachannel native plugin, two peers
# over real WebRTC data channels through a real server. Run build-unity-package.ps1 first, and a server:
#   dotnet run --project server/OneLobby.Server -- --listen :8080
#   powershell -File clients/unity/mono-probe/run.ps1 -Unity "C:\Program Files\Unity\Hub\Editor\6000.2.7f2" -Server ws://127.0.0.1:8080/ws
# -Direct needs no server: host by IP (OneLobby.Direct + the embedded hub) on loopback port 47831, join by address.
param([Parameter(Mandatory)] [string]$Unity, [string]$Server = 'ws://127.0.0.1:8080/ws', [switch]$Direct)
$ErrorActionPreference = 'Stop'
$lib = Join-Path $Unity 'Editor/Data/MonoBleedingEdge/lib/mono/unityjit-win32'
$pkg = Join-Path $PSScriptRoot '../com.onelobby.unity'
$out = Join-Path ([IO.Path]::GetTempPath()) ('onelobby-monoprobe-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $pkg 'Runtime/Plugins/*.dll'), (Join-Path $pkg 'Runtime/Plugins/Dependencies/*.dll'), (Join-Path $pkg 'Runtime/Plugins/x86_64/datachannel.dll') $out
$sdk = (dotnet --list-sdks | Select-Object -Last 1) -replace '^(\S+) \[(.+)\]$', '$2\$1'
$csc = Join-Path $sdk 'Roslyn/bincore/csc.dll'
$refs = @('mscorlib.dll', 'System.dll', 'System.Core.dll', 'Facades/netstandard.dll', 'Facades/System.Runtime.dll', 'Facades/System.Memory.dll') |
    ForEach-Object { "-r:$(Join-Path $lib $_)" }
dotnet $csc -nologo -nostdlib -noconfig -langversion:9 -nullable:enable "-out:$out/Probe.exe" @refs `
    "-r:$out/OneLobby.Core.dll" "-r:$out/OneLobby.DataChannel.dll" "-r:$out/OneLobby.Direct.dll" "-r:$out/OneLobby.Hub.dll" "-r:$out/System.Text.Json.dll" "-r:$out/Microsoft.Bcl.AsyncInterfaces.dll" `
    (Join-Path $PSScriptRoot 'Probe.cs')
if ($LASTEXITCODE -ne 0) { throw 'compile failed' }
# Unity's bin/mono.exe is 32-bit and cannot load the x64 native plugin; host the editor's own 64-bit runtime instead.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = @(& $vswhere -all -prerelease -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)[0]
if (-not $vs) { throw 'MSVC (C++ x64 tools) is needed to build monohost.exe' }
$vcvars = Join-Path $vs 'VC/Auxiliary/Build/vcvars64.bat'
cmd /c "`"$vcvars`" >nul 2>nul && cl /nologo /O2 `"$(Join-Path $PSScriptRoot 'host/monohost.c')`" /Fe:`"$out/monohost.exe`" /Fo:`"$out/monohost.obj`" >nul"
if ($LASTEXITCODE -ne 0) { throw 'monohost build failed' }
& "$out/monohost.exe" (Join-Path $Unity 'Editor/Data') "$out/Probe.exe" $(if ($Direct) { 'direct' } else { $Server })
$code = $LASTEXITCODE
Remove-Item -Recurse -Force $out
exit $code
