# Recipe: Unity 6 (desktop and mobile)

Unity uses `OneLobby.Core` unchanged (shipped as a netstandard2.1 DLL) and adds the `com.onelobby.unity` package for the
WebRTC transport (`UnityTransport`, over Unity's `com.unity.webrtc`), microphone capture and playback (`UnityVoiceAudio`)
and a `OneLobbyRunner` MonoBehaviour that pumps the client every frame. All protocol and netcode logic stays in Core, so
the same game-side code works in Godot or any .NET engine. Unity snippets are tagged `csharp unity`: `check-snippets.mjs`
does not compile them (they need UnityEngine); the same code is compiled in a Unity 6000.2 project by the package's
sample and tests.

Platforms: Windows x64, macOS (Apple Silicon), Linux x64, iOS, Android ARM64, as `com.unity.webrtc` 3.0.0 supports.
**Not WebGL** (see "WebGL" below). Unity 6000.0 or newer; tested with 6000.2.7f2. API Compatibility Level: the default
.NET Standard 2.1 works (.NET Framework too).

## 1. Add the package

Build the DLLs once from a clone of this repo (needs the .NET 8 SDK; it runs `dotnet publish -f netstandard2.1` and copies
OneLobby.Core, OneLobby.Opus and the dependencies Unity lacks into the package's `Runtime/Plugins/`):

```
powershell -File clients/unity/build-unity-package.ps1     # Windows (or pwsh)
clients/unity/build-unity-package.sh                       # macOS / Linux
```

Then add it to your project's `Packages/manifest.json` (Unity resolves `com.unity.webrtc` 3.0.0 itself):

```json
{
  "dependencies": {
    "com.onelobby.unity": "file:C:/path/to/onelobby/clients/unity/com.onelobby.unity"
  }
}
```

Or build a tarball with `-Pack` (`--pack`) and use Package Manager, "Add package from tarball". Re-run the build script
after pulling OneLobby changes. If another package already ships `System.Text.Json.dll` (or one of the other DLLs in
`Runtime/Plugins/Dependencies`), delete the duplicate there.

## 2. `Net.cs`: one object that owns the lobby

Put it on a GameObject in your first scene. The lobby server is a setting (AGENTS.md rule 5): a default, a saved
override, and a `--lobby-server=` command-line flag (`OneLobbyRunner` reads the flag).

```csharp unity
#nullable enable
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using OneLobby;
using OneLobby.Unity;
using UnityEngine;

public sealed class Net : MonoBehaviour
{
    public const string DefaultServer = "wss://lobby.onelobby.example/ws";
    public static Net Instance { get; private set; } = null!;
    public OneLobbyRunner Runner { get; private set; } = null!;
    public Lobby? Lobby => Runner.Lobby;
    public event Action<string>? Status;

    void Awake()
    {
        Instance = this;
        Runner = gameObject.AddComponent<OneLobbyRunner>();      // pumps the client in Update; survives scene loads
        Runner.LobbyServer = PlayerPrefs.GetString("lobby_server", DefaultServer);
        Runner.GameId = "com.you.yourgame";
        Runner.NetVersion = "1";                                 // bump when your message bytes change
        Runner.Mode = SyncMode.Raw;                              // host-authoritative; Lockstep for deterministic sims
        Runner.DisplayName = PlayerPrefs.GetString("player_name", "Player");
        Runner.Error += e => Status?.Invoke(e.Message);
    }

    public async Task<string?> HostAsync()
    {
        try { var l = await Runner.HostAsync(new LobbyOptions("My game", MaxPlayers: 4, Visibility: Visibility.Public)); return l.Code; }
        catch (Exception e) { Status?.Invoke("Multiplayer unavailable: " + e.Message); return null; }
    }

    public async Task<bool> JoinAsync(string code)
    {
        try { var l = await Runner.JoinAsync(code); await l.ReadyAsync; return true; }   // ReadyAsync: link to host open
        catch (Exception e) { Status?.Invoke("Multiplayer unavailable: " + e.Message); return false; }
    }

    public async Task<IReadOnlyList<LobbySummary>> BrowseAsync()
    {
        try { return await Runner.ListAsync(); }
        catch (Exception e) { Status?.Invoke("Multiplayer unavailable: " + e.Message); return Array.Empty<LobbySummary>(); }
    }
}
```

`await` from a MonoBehaviour resumes on the main thread. Never block on a OneLobby task (`.Result`, `.Wait()`): it
completes inside `Pump`, which runs in `Update`, so blocking the main thread deadlocks.

## 3. Game traffic

Raw mode, host-authoritative (a co-op shooter): joiners send inputs, the host simulates and broadcasts state.

```csharp unity
#nullable enable
using System;
using OneLobby;
using UnityEngine;

public sealed class NetTraffic : MonoBehaviour
{
    void Start()
    {
        var lobby = Net.Instance.Lobby;
        if (lobby == null) return;
        lobby.MessageReceived += (from, payload, channel) =>
        {
            ReadOnlySpan<byte> b = payload.Span;
            if (lobby.IsHost && b.Length >= 1 && b[0] == 1) { /* input from peer `from`: validate, apply */ }
            if (!lobby.IsHost && b.Length >= 1 && b[0] == 2) { /* state from the host: apply */ }
        };
        lobby.PeerLeft += (peer, reason) => Debug.Log($"{peer.Name} left: {reason}");
        lobby.HostChanged += newHost => Debug.Log($"host is now {newHost}");   // raw mode: handle it yourself
    }

    void FixedUpdate()
    {
        var lobby = Net.Instance.Lobby;
        if (lobby == null || !lobby.IsReady) return;
        if (lobby.IsHost) lobby.Broadcast(new byte[] { 2 /* , state... */ }, Channel.Fast);              // unreliable, latest wins
        else lobby.Send(lobby.HostPeerId, new byte[] { 1 /* , input... */ }, Channel.Fast);
    }
}
```

`Channel.Reliable` (default) for events that must arrive (hits, pickups, round changes), `Channel.Fast` for state that
is replaced every tick. Frames stay ≤ 16 KiB; bigger payloads are chunked on Reliable. More in `raw-mode.md`. Additional
engine-agnostic OneLobby assemblies (for example a replication layer) ship the same way: `build-unity-package` copies
every listed project's DLL into `Runtime/Plugins` (add one with `-Extra OneLobby.Foo` / `EXTRA=OneLobby.Foo`).

## 4. Voice (second tier)

```csharp unity
#nullable enable
using OneLobby;
using OneLobby.Unity;
using UnityEngine;

public sealed class NetVoice : MonoBehaviour
{
    UnityVoiceAudio? _audio;

    void Start()
    {
        var lobby = Net.Instance.Lobby;
        if (lobby == null) return;
        _audio = UnityVoiceAudio.Attach(transform, lobby.Voice);    // Opus (Concentus, managed) + Microphone + AudioSources
        _audio.SpeakerCreated += (peerId, source) => { /* source.outputAudioMixerGroup = voiceGroup; */ };
        lobby.Voice.Enabled = true;
    }

    public void SetTalking(bool down) => Net.Instance.Lobby?.Voice.PushToTalk(down);   // wire to your talk key

    void OnDestroy() => _audio?.Dispose();
}
```

Capture is `Microphone` resampled to 48 kHz mono 20 ms frames; each remote speaker gets a child `AudioSource` fed in
`OnAudioFilterRead`. The codec is the managed Concentus Opus port (no native libopus needed, works under IL2CPP in
principle). Mobile needs the microphone permission (iOS: Microphone Usage Description; Android: request
`Permission.Microphone`). Voice on Unity has not been verified on real audio hardware yet; data channels are the
tested path.

## Threading and Unity WebRTC notes

- Everything OneLobby raises (events, task completions) happens inside `Pump`, on the thread that calls it. `OneLobbyRunner`
  calls it from `Update` with `[DefaultExecutionOrder(-100)]`, so your scripts see this frame's messages.
- `com.unity.webrtc` posts its callbacks (channel open, message, ICE candidate) to Unity's main-thread
  `SynchronizationContext`; `UnityTransport` only queues them and hands them to Core in `Poll`. Its async operations
  (CreateOffer, SetLocal/RemoteDescription, GetStats) are polled for `IsDone` from `Poll`, so no coroutine is needed.
  `StartCoroutine(WebRTC.Update())` is only for video tracks and is not needed.
- The signaling WebSocket is `System.Net.WebSockets.ClientWebSocket` on the thread pool, also queue-only.
- `Peer.Relayed` and `PingMs` come from the selected ICE candidate pair (WebRTC stats, refreshed every 2 s).

## WebGL

`com.unity.webrtc` does not support WebGL, and `ClientWebSocket` does not work there either. A WebGL build would need a
`.jslib` transport that drives the browser's `RTCPeerConnection` and `WebSocket` (the JS client's `WebRtcLink` shows the
exact channel setup) behind the same `ITransport`. Not built yet.

## Done when

- The project compiles with the package added and the Console shows no errors.
- With a local server (`dotnet run --project server/OneLobby.Server -- --listen :8080`, then `--lobby-server=ws://127.0.0.1:8080/ws`
  or the field on `OneLobbyRunner`), one build presses Host and shows a code, a second instance (a build, or the editor)
  joins it, and a message sent by one arrives in the other's `MessageReceived`.
- The package test passes: add `"testables": ["com.onelobby.unity"]` to the manifest and run
  `Unity.exe -batchmode -projectPath <project> -runTests -testPlatform EditMode` with the server running
  (`ONELOBBY_TEST_SERVER` overrides the URL). It connects two `UnityTransport` peers and checks reliable, fast and broadcast.
- With the server address wrong, the game still starts and plays, and the menu shows "Multiplayer unavailable".
- No Unity licence at hand (CI)? `clients/unity/mono-probe/run.ps1` runs Core, the shipped DLLs and the WebSocket
  adapter on Unity's own Mono against a server (no WebRTC).
