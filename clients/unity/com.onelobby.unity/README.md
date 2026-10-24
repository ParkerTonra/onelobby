# OneLobby for Unity (`com.onelobby.unity`)

Lobbies with join codes, WebRTC peer-to-peer data channels, `raw` or `lockstep` netcode, text chat and voice for Unity 6.
All protocol and netcode logic lives in the engine-agnostic `OneLobby.Core`, and the WebRTC transport in the equally
engine-agnostic `OneLobby.DataChannel` (libdatachannel); both ship as DLLs plus one native library per platform. This
package only adds:

| Type | What |
|---|---|
| `UnityTransport : ITransport` | `OneLobby.DataChannel.DataChannelTransport` (three negotiated data channels, DESIGN s.8, + `ClientWebSocket` signaling), native log to the console |
| `UnityVoiceAudio : IVoiceAudio` | `Microphone` capture to 48 kHz mono 20 ms frames, one `AudioSource` per speaker (`OnAudioFilterRead`) |
| `OneLobbyRunner` | MonoBehaviour that owns a `LobbyClient` and pumps it every `Update` (events fire on the main thread) |

Platforms: whatever natives `Runtime/Plugins` holds. Built and tested here: Windows x64 and Linux x64. The CI workflow
also builds macOS (universal) and Android arm64 (not yet run). Not yet: iOS (needs a static `__Internal` build) and WebGL;
see `docs/recipes/unity.md`.

## Install

1. Build the native library once per platform you target (`clients/dotnet/OneLobby.DataChannel/native/build-windows.ps1`,
   `build-linux.sh`, or the CI artifacts), then the package (needs the .NET 8 SDK):
   `powershell -File clients/unity/build-unity-package.ps1` (or `clients/unity/build-unity-package.sh`). This fills
   `Runtime/Plugins/` (not committed) with the DLLs, the natives under their platform folders and the licence texts.
2. In your Unity project's `Packages/manifest.json`:
   `"com.onelobby.unity": "file:C:/path/to/onelobby/clients/unity/com.onelobby.unity"`.
   No other Unity packages are needed. A tarball for "Add package from tarball" comes from `-Pack` / `--pack`.

The full walkthrough, with the game loop and the "Done when" checks, is `docs/recipes/unity.md`.

## Tests

`Tests/Editor/UnityTransportLoopbackTests.cs` runs two `UnityTransport` peers in one editor through a real server
(`ONELOBBY_TEST_SERVER`, default `ws://127.0.0.1:8080/ws`; ignored when no server answers). Add
`"testables": ["com.onelobby.unity"]` to the manifest, then run it from the Test Runner window or
`Unity.exe -batchmode -projectPath <p> -runTests -testPlatform EditMode`.

## Licences

MIT (this package). Bundled: libdatachannel and libjuice (MPL-2.0), usrsctp (BSD-3-Clause), plog (MIT), Mbed TLS
(Apache-2.0) inside the native library; `System.Text.Json` and friends (MIT); Concentus (BSD-3-Clause). A shipped game
must credit them and say where the MPL source is; see `THIRD_PARTY.md`.
