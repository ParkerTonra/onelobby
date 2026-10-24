# Licence-free smoke check of the managed half of com.onelobby.unity on Unity's own Mono runtime (unityjit profile):
# OneLobby.Core + the shipped System.Text.Json DLLs + UnitySignalingSocket (ClientWebSocket) against a real server.
# Does not touch WebRTC (that needs the editor or a player). Run build-unity-package.ps1 first, and a server:
#   dotnet run --project server/OneLobby.Server -- --listen :8080
#   powershell -File clients/unity/mono-probe/run.ps1 -Unity "C:\Program Files\Unity\Hub\Editor\6000.2.7f2" -Server ws://127.0.0.1:8080/ws
param([Parameter(Mandatory)] [string]$Unity, [string]$Server = 'ws://127.0.0.1:8080/ws')
$ErrorActionPreference = 'Stop'
$mono = Join-Path $Unity 'Editor/Data/MonoBleedingEdge'
$lib = Join-Path $mono 'lib/mono/unityjit-win32'
$pkg = Join-Path $PSScriptRoot '../com.onelobby.unity'
$out = Join-Path ([IO.Path]::GetTempPath()) ('onelobby-monoprobe-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $pkg 'Runtime/Plugins/*.dll'), (Join-Path $pkg 'Runtime/Plugins/Dependencies/*.dll') $out
$sdk = (dotnet --list-sdks | Select-Object -Last 1) -replace '^(\S+) \[(.+)\]$', '$2\$1'
$csc = Join-Path $sdk 'Roslyn/bincore/csc.dll'
$refs = @('mscorlib.dll', 'System.dll', 'System.Core.dll', 'Facades/netstandard.dll', 'Facades/System.Runtime.dll', 'Facades/System.Memory.dll') |
    ForEach-Object { "-r:$(Join-Path $lib $_)" }
dotnet $csc -nologo -nostdlib -noconfig -langversion:9 -nullable:enable "-out:$out/Probe.exe" @refs `
    "-r:$out/OneLobby.Core.dll" "-r:$out/System.Text.Json.dll" "-r:$out/Microsoft.Bcl.AsyncInterfaces.dll" `
    (Join-Path $PSScriptRoot 'Probe.cs') (Join-Path $pkg 'Runtime/UnitySignalingSocket.cs')
if ($LASTEXITCODE -ne 0) { throw 'compile failed' }
$env:MONO_PATH = "$lib;$lib/Facades"
& (Join-Path $mono 'bin/mono.exe') "$out/Probe.exe" $Server
$code = $LASTEXITCODE
Remove-Item -Recurse -Force $out
exit $code
