# Downloads the webrtc-native GDExtension (Godot's WebRTC implementation for desktop) into addons/godot_webrtc/.
# Binaries are not committed. Release: https://github.com/godotengine/webrtc-native/releases/tag/1.2.2-stable
param([string]$Version = "1.2.2-stable")
$ErrorActionPreference = "Stop"
$url = "https://github.com/godotengine/webrtc-native/releases/download/$Version/godot-extension-webrtc_native.zip"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("kawebrtc-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    Write-Host "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp "webrtc.zip")
    Expand-Archive -Path (Join-Path $tmp "webrtc.zip") -DestinationPath (Join-Path $tmp "unpacked")
    $ext = Get-ChildItem -Path (Join-Path $tmp "unpacked") -Recurse -Filter *.gdextension | Select-Object -First 1
    $dest = Join-Path $PSScriptRoot "addons\godot_webrtc"
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot "addons") | Out-Null
    Copy-Item -Recurse $ext.Directory.FullName $dest
    Write-Host "Installed to $dest"
    Write-Host "Run once so Godot registers the extension:  godot --headless --import --path `"$PSScriptRoot`""
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
