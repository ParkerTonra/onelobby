# OneLobby for Unity (`com.onelobby.unity`)

Lobbies with join codes, WebRTC peer-to-peer data channels, `raw` or `lockstep` netcode, text chat and voice for Unity 6.
All protocol and netcode logic lives in the engine-agnostic `OneLobby.Core` (shipped as a DLL); this package only adds:

| Type | What |
|---|---|
| `UnityTransport : ITransport` | `com.unity.webrtc` peer links (three negotiated data channels, DESIGN s.8) + `ClientWebSocket` signaling |
| `UnityVoiceAudio : IVoiceAudio` | `Microphone` capture to 48 kHz mono 20 ms frames, one `AudioSource` per speaker (`OnAudioFilterRead`) |
| `OneLobbyRunner` | MonoBehaviour that owns a `LobbyClient` and pumps it every `Update` (events fire on the main thread) |

Platforms: what `com.unity.webrtc` 3.0.0 supports (Windows x64, macOS Apple Silicon, Linux x64, iOS, Android ARM64). WebGL is
not supported by `com.unity.webrtc`; see `docs/recipes/unity.md` for the status.

## Install

1. Build the DLLs once (needs the .NET 8 SDK): `powershell -File clients/unity/build-unity-package.ps1`
   (or `clients/unity/build-unity-package.sh`). This fills `Runtime/Plugins/` (not committed).
2. In your Unity project's `Packages/manifest.json`:
   `"com.onelobby.unity": "file:C:/path/to/onelobby/clients/unity/com.onelobby.unity"`.
   Unity pulls `com.unity.webrtc` 3.0.0 as a dependency. A tarball for "Add package from tarball" comes from `-Pack` / `--pack`.

The full walkthrough, with the game loop and the "Done when" checks, is `docs/recipes/unity.md`.

## Tests

`Tests/Editor/UnityTransportLoopbackTests.cs` runs two `UnityTransport` peers in one editor through a real server
(`ONELOBBY_TEST_SERVER`, default `ws://127.0.0.1:8080/ws`; ignored when no server answers). Add
`"testables": ["com.onelobby.unity"]` to the manifest, then run it from the Test Runner window or
`Unity.exe -batchmode -projectPath <p> -runTests -testPlatform EditMode`.

## Licences

MIT (this package). Bundled DLLs: `System.Text.Json`, `System.Text.Encodings.Web`, `Microsoft.Bcl.AsyncInterfaces`,
`System.Runtime.CompilerServices.Unsafe` (MIT, .NET Foundation) and Concentus (BSD-3-Clause; credit it if you ship voice).
`com.unity.webrtc` is a dependency resolved by Unity, not redistributed here; it is under the Unity Companion License.
See `THIRD_PARTY.md`.
