# Recipe: Unity 6 (desktop and mobile)

Unity uses `OneLobby.Core` and the engine-agnostic WebRTC transport `OneLobby.DataChannel` (libdatachannel) unchanged,
shipped as netstandard2.1 DLLs plus one native library per platform. The `com.onelobby.unity` package adds only Unity
plumbing: `UnityTransport` (wraps `DataChannelTransport`, native log to the console), microphone capture and playback
(`UnityVoiceAudio`) and a `OneLobbyRunner` MonoBehaviour that pumps the client every frame. All protocol, netcode and
transport logic stays out of Unity, so the same game-side code works in Godot or any .NET engine. Unity snippets are tagged `csharp unity`: `check-snippets.mjs`
does not compile them (they need UnityEngine); the same code is compiled in a Unity 6000.2 project by the package's
sample and tests.

Platforms: wherever a native build exists. Built and live-tested: Windows x64, Linux x64 (editor and standalone).
macOS (universal) and Android arm64 have build scripts and a CI job but have not been run yet; iOS needs a static
`__Internal` build (not done); **not WebGL** (see "WebGL" below). Unity 6000.0 or newer; tested with 6000.2.7f2. API Compatibility Level: the default
.NET Standard 2.1 works (.NET Framework too).

## One command

`create-onelobby` does section 1 and the menu below for you, and writes a two-peer test. A Unity game takes OneLobby as one package, `com.onelobby.unity`
(it carries the menu, the transport and the natives), so the tool copies nothing into `Assets/` except the blueprint, a test, a build script and, for a
new project, a boot script. It needs Unity 6000.0 or newer (the tool looks for `--unity <exe>`, then `$UNITY`, then the Unity Hub's default folder; a new
project is made for the editor it finds, else 6000.2.7f2).

```
npx create-onelobby my-game --template unity --yes --package-from path/to/com.onelobby.unity-<version>.tgz   # a new project
npx create-onelobby --into path/to/your-project --package-from path/to/com.onelobby.unity-<version>.tgz      # an existing Unity project
cd my-game
npx create-onelobby verify                       # opens the project in batchmode, then one line: VERIFY_OK or VERIFY_FAIL <check>: <next step>
```

- New project: `ProjectSettings/ProjectVersion.txt`, `Packages/manifest.json` (the package, the test framework and the built-in modules the menu needs),
  `Assets/Resources/onelobby.json`, `Assets/Scripts/Boot.cs` (adds the menu in every scene from `[RuntimeInitializeOnLoadMethod]`: no scene file;
  shows an "In game" line on `GameStarted`, logs `Lobby: 2 players: Host, Joiner` each time the roster changes, adds no menu while a play-mode test plays), `Assets/OneLobby/Tests/` (the two-peer play-mode test and its `.asmdef`), `Assets/OneLobby/Editor/BuildPlayer.cs`
  (`OneLobbyBuild.Windows`), `.olc/<name>.json` (builds the player, then opens a host and a joiner window with `--local`), `AGENTS.md`, and the managed
  `.gitignore` / `.gitattributes` blocks.
- `--into` adds the same except the boot script and `AGENTS.md`: your scenes and settings are not touched, `Packages/manifest.json` is edited in place (only the
  dependencies it adds; a game that already references `com.onelobby.unity` keeps its line), and the tool prints the lines that put the menu into your own start-up.
- The package is not on a registry yet. `--package-from <tgz>` writes a `file:` line (relative to `Packages/`); without it the line is
  `file:com.onelobby.unity-<version>.tgz` and the tarball goes next to `manifest.json` (build one with `clients/unity/build-unity-package.sh --pack`, or take the
  `unity-dev-package` CI artifact, which has the natives). `npx create-onelobby update` moves that line to the tool's version (a `file:` line you wrote is kept
  unless `--package-from` is given).
- The test runs headless: `Unity.exe -batchmode -nographics -projectPath . -runTests -testPlatform PlayMode -assemblyNames OneLobbyGame.Tests -testResults <abs>.xml -logFile <abs>.log --local`
  and logs `MULTIPLAYER_OK` (or `MULTIPLAYER_FAIL <what>`). The first run also imports the project. `verify` runs the other routes through the same test with
  arguments after Unity's own (`--route=nostr --relay=...`), against a local Nostr relay and TURN server that it starts on 127.0.0.1. `--hold=5` keeps the two
  peers connected for 5 seconds before the result line (time to look at the open sockets).
- Read the result line, not Unity's exit code: on Windows the editor ends with exit code 0xC0000005 while it closes after a test that used the WebRTC
  library (the open finding in `tools/engine-smoke/README.md`); the test has passed and its results file is written by then.
- The Unity editor opens its own ports in every run, whether or not OneLobby is in the project: it listens on TCP and UDP ports on all interfaces (0.0.0.0) and connects out to Unity's own licence, package and services hosts. OneLobby's own sockets in the test and in `--local` players are on 127.0.0.1 (and ::1).
- Never run a player or the editor without `-batchmode` in tests, and never run a player with `--host` without `--local` (127.0.0.1 only, no Nostr, no router request).
- `clients/unity/scaffold-test.sh` runs all of this end to end on a machine with Unity; it is local only (CI has no Unity licence).

The rest of this page is the hand-written way.

## The short way: the drop-in menu

Once the package is added (step 1 below), the multiplayer front end is one component: name, Host with a big code, Join by a pasted code,
roster with ready and countdown, kick and ban, chat, settings, browse and a plain "why it failed" screen. It needs no scene setup, no prefab and no
event system, and it hosts and joins direct lobbies (no server) by itself:

```csharp unity
using OneLobby.Unity;
using UnityEngine;

public sealed class Boot : MonoBehaviour
{
    void Awake()
    {
        var menu = new GameObject("Menu").AddComponent<OneLobbyMenu>();
        menu.GameStarted += lobby => Debug.Log("the game starts with " + lobby.Room.Players.Count + " players");
    }
}
```

`GameStarted` gives you the `Lobby` (`lobby.Send`, `lobby.Room`, `OneLobby.Replication`, ...); the menu hides itself while the game runs and shows
the lobby again on `ReturnedToLobby`. Put the blueprint at `Assets/Resources/onelobby.json` (or drop it on the component's `Blueprint` field).
Everything about it (events, options, restyling, rewording, `--host` / `--join=<code>` / `--local`, what is tested) is in
`docs/recipes/menu.md`, "Unity", and the package sample `Menu` is one script. The rest of this page is the hand-written way: your own `Net.cs`
and your own buttons.

## 1. Add the package

From a clone of this repo, build the native library for each platform you ship (Visual Studio C++ workload for Windows,
Docker for Linux; or take the CI artifacts), then the package (needs the .NET 8 SDK; it runs
`dotnet publish -f netstandard2.1` and copies OneLobby.Core, OneLobby.DataChannel, OneLobby.Opus, the dependencies Unity
lacks, the natives under `Runtime/Plugins/<platform>/` with their import settings, and the licence texts):

```
powershell -ExecutionPolicy Bypass -File clients/dotnet/OneLobby.DataChannel/native/build-windows.ps1   # datachannel.dll
clients/dotnet/OneLobby.DataChannel/native/build-linux.sh                                              # libdatachannel.so
powershell -File clients/unity/build-unity-package.ps1     # Windows (or pwsh)
clients/unity/build-unity-package.sh                       # macOS / Linux
```

Then add it to your project's `Packages/manifest.json` (no other Unity packages needed):

```json
{
  "dependencies": {
    "com.onelobby.unity": "file:C:/path/to/onelobby/clients/unity/com.onelobby.unity"
  }
}
```

Your own `.asmdef` files (game code and test assemblies) that use `OneLobbyRunner`, `GameConsoleServer` or anything else
from `OneLobby.Unity` must list it, or the compiler reports CS0012: `"references": ["OneLobby.Unity"]`. Code in the
default `Assembly-CSharp` needs nothing (the package asmdef is auto-referenced).

Or build a tarball with `-Pack` (`--pack`) and use Package Manager, "Add package from tarball". Re-run the build script
after pulling OneLobby changes. The tarball carries the recipes under `Documentation~/` (unity, direct-ip, pause,
game-console, replication, voice-and-chat, room, the Nostr spec and AGENTS.md); `-Version 0.6.0-dev.4` (`--version`) stamps the
version into the packed `package.json` and the file name. `-Out <dir>` (`--out <dir>`) packs without writing into the
checkout: it fills a staged copy, keeps dotnet's bin/obj in a temp folder and writes only `<dir>/<tarball>` (implies
`-Pack`). If another package already ships `System.Text.Json.dll` (or one of the other DLLs in
`Runtime/Plugins/Dependencies`), delete the duplicate there.

Without a clone: every push to `main` runs the `unity-dev-package` workflow, which packs
`com.onelobby.unity-<version>-ci.<run>.tgz` with all four natives (taken from the newest `datachannel-natives` artifacts;
the run summary names the commit each one was built from). Download it from that run's `unity-dev-<sha>` artifact, or
`gh run download -R <owner>/<repo> -n unity-dev-<sha>`.

Committing the tarball into your game's repo: if that repo tracks `*.tgz` with Git LFS, a fresh clone or worktree holds
only a small pointer file and Unity fails to read the package. Run `git lfs pull -I "Packages/*.tgz"` (your path) after
cloning, and say so in your game's build notes.

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

`ReadyAsync` does not hang: a joiner whose link to the host does not open within `OneLobbyConfig.ReadyTimeout`
(default 15 s; `TimeSpan.Zero` waits forever) gets `OneLobbyException` code `ice_failed`, the lobby is left and
`SessionEnded("ice_failed")` fires. Change it with `Runner.ConfigureConfig = c => c with { ReadyTimeout = TimeSpan.FromSeconds(30) };`.

While it holds a lobby (from the moment Host/Join starts until the lobby ends or is left) `OneLobbyRunner` sets
`Application.runInBackground = true` and restores the old value afterwards, logging once when it flips it. Without that,
an unfocused player (two windows on one PC, or alt-tabbed) stops running `Update`, stops pumping, and the handshake
stalls. Set `Runner.KeepRunningInBackground = false` to manage it yourself.

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

## Shared pause

`runner.Lobby.Pause` needs nothing from the runner: call `Pause.Request(true)` from your pause button and set `Time.timeScale` in 
`Pause.Changed` (`Time.timeScale = s.Paused ? 0f : 1f`). `OneLobbyRunner` keeps pumping at timeScale 0 (it uses real time), so 
the pause itself, pings and chat keep working. The host calls `Pause.Clear()` before reloading the scene for a restart. 
Details: `pause.md`.

## Room: names, ready, countdown, spectators, kick and ban

`runner.Lobby.Room` is the whole room layer (`docs/recipes/room.md`, section C#); the runner adds only two things. Its
`PlayerIdFile` and `BanFile` fields (default `onelobby-player.json` and `onelobby-bans.json` under
`Application.persistentDataPath`) keep this install's player id and the host's ban list across runs. `JoinAsync(code,
new RoomJoinOptions { ... })` joins with a password, as a spectator or with your starting colour and team. Pass
`LobbyOptions.Room` / `Password` (or `DirectHostOptions.Room`) to `HostAsync` / `HostDirectAsync`. Subscribe to `lobby.Room`
events in `LobbyChanged`, next to the lobby's own.

## A friend could not connect (`PeerFailed`)

The host learns that a joiner never got its link up from `lobby.PeerFailed(peer, reason)`: `reason` is `"timeout"` when
the joiner is still not ready `ReadyTimeout` (15 s) after joining (it keeps its seat and may still connect, so say "still
trying"), otherwise why it left before its link opened (`ice_failed`, a closed game, ...). It fires inside `Pump`, at
most once per peer, just before that peer's `PeerLeft`, and never for kicks or `DisconnectAsync`.

`OneLobbyRunner` forwards no lobby events. Subscribe in exactly one place: `LobbyChanged`, which fires before the first
`Pump` of a new lobby, so nothing is missed. Do not also subscribe where your game attaches to the lobby, or every notice
shows twice. Key notices by `PeerId`, never by name: names can repeat and change. Joining mostly happens in the pre-match
room, so show it there first (a line in the player list or a status area that stays until dismissed), not only as a
short in-game banner:

```csharp unity
#nullable enable
using System.Collections.Generic;
using OneLobby;
using OneLobby.Unity;
using UnityEngine;

public sealed class ConnectionNotices : MonoBehaviour
{
    [SerializeField] OneLobbyRunner runner = null!;
    // PeerId -> line; draw these in the room screen and the HUD; Remove(id) on dismiss
    public readonly Dictionary<int, string> Lines = new();

    void Awake() => runner.LobbyChanged += lobby =>
    {
        Lines.Clear();   // a new lobby is a new object, so the old one's handlers never fire again
        if (lobby == null || !lobby.IsHost) return;
        lobby.PeerFailed += (peer, reason) => Lines[peer.PeerId] =
            reason == "timeout" ? $"{peer.Name} is still trying to connect" : $"{peer.Name} could not connect ({reason})";
        lobby.PeerReady += peer => Lines.Remove(peer.PeerId);   // a "still trying" peer made it
    };
}
```

## Threading notes

- Everything OneLobby raises (events, task completions) happens inside `Pump`, on the thread that calls it. `OneLobbyRunner`
  calls it from `Update` with `[DefaultExecutionOrder(-100)]`, so your scripts see this frame's messages.
- libdatachannel calls back on its own threads; `DataChannelTransport` only copies the data into lock-free queues there
  and hands it to Core in `Poll`. The callbacks are static methods marked `[MonoPInvokeCallback]` and native code only
  holds integer ids, so IL2CPP is supported by design (not yet tested in an IL2CPP build).
- The signaling WebSocket is `System.Net.WebSockets.ClientWebSocket` on the thread pool, also queue-only.
- `Peer.Relayed` comes from the selected ICE candidate pair; ping is measured by Core itself.
- Set `UnityTransport.LogNativeWarnings = true` before the first transport to see libdatachannel warnings in the Console.

## WebGL

A native library cannot load in WebGL, and `ClientWebSocket` does not work there either. A WebGL build would need a
`.jslib` transport that drives the browser's `RTCPeerConnection` and `WebSocket` (the JS client's `WebRtcLink` shows the
exact channel setup) behind the same `ITransport`. Not built yet. (libdatachannel's datachannel-wasm wrapper is the other
route.)

## Play over the internet with no server (host by IP)

`OneLobbyRunner.HostDirectAsync` makes the host's game the server: it runs the signaling hub in-process on TCP + UDP
**47810**, asks the home router to open that port (UPnP, then NAT-PMP) and gives a **join code** like `6B01-RGFE-P2B`
that friends paste into `JoinDirectAsync`. No lobby server is involved, so `LobbyServer` is ignored. Everything after
host/join is the same `Lobby` (and `ReplicationSession`) API. Design and router details: `docs/recipes/direct-ip.md`.

```csharp
// in Net.cs, next to HostAsync / JoinAsync (add `using OneLobby.Direct;`)
public async Task<string?> HostByIpAsync(string? password = null)
{
    try
    {
        var l = await Runner.HostDirectAsync(new DirectHostOptions { Password = password, MaxPlayers = 4 });
        // Internet: works from anywhere. SameNetwork: the router said no (l.PortMapping says why); LAN only.
        Status?.Invoke(l.JoinCodeKind == JoinCodeKind.Internet ? "Share " + l.JoinCode : "Same network only: " + l.JoinCode);
        return l.JoinCode;
    }
    catch (OneLobbyException e) when (e.Code == "port_in_use") { Status?.Invoke("Another copy is already hosting"); return null; }
    catch (Exception e) { Status?.Invoke("Multiplayer unavailable: " + e.Message); return null; }
}

public async Task<bool> JoinByIpAsync(string codeOrAddress, string? password = null)
{
    try { var l = await Runner.JoinDirectAsync(codeOrAddress, password); await l.ReadyAsync; return true; }
    catch (Exception e) { Status?.Invoke("Multiplayer unavailable: " + e.Message); return false; }   // bad_code, direct_unreachable, bad_password
}
```

- Show the code grouped as it comes (`6B01-RGFE-P2B`); `JoinDirectAsync` also takes `192.168.1.20` or `ip:port`.
- `Runner.JoinDirectAsync(code, new JoinDirectOptions { Password, Nostr, IceServers })` and `RejoinDirectAsync(code, token, options)`
  reach the same options as the C# client (a pasted TURN entry, Nostr relays/STUN) and still raise `LobbyChanged`. Tick
  `RelayOnly` on the runner to send and accept relay candidates only (docs/recipes/turn.md).
- The first host on Windows gets the firewall prompt for the game's exe ("allow on private networks" is enough on a LAN;
  tick public too for internet play). When another program holds 47810 the host takes the next free port up to 47819
  (the code carries it); set `DirectHostOptions.Port` to pick one (`FallbackPorts` to allow others after it),
  `OpenPort = false` to skip the router request.
- Automated tests with every player on one machine: pass `--bind-address=127.0.0.1` (or set `OneLobbyRunner.BindAddress`)
  so the host listener and the WebRTC sockets stay on loopback and Windows never shows the firewall prompt. Not for
  shipped builds: other machines cannot connect.
- A joiner's `Lobby.JoinCode` is the code it joined with (normalized), so a HUD shows the same code on both sides
  (`Lobby.Code` is empty in direct mode).
- No host migration: when the host leaves, joiners get `SessionEnded("host_left")` (with `OneLobby.Replication`, end the
  match as on `HostLost`).
- A runner that hosted or joined by IP gets a fresh client on the next `HostAsync` / `JoinAsync`, so a game can offer both.
- Desktop only for hosting (Windows tested; Linux and macOS should work, not yet run). Any platform with the native plugin can
  join.

## Testing two players headless (batchmode)

Test multiplayer with two **batchmode** players, not two windows: they need no screen, no focus and no audio device, they
always run (an unfocused window may not; the runner keeps `runInBackground` on while in a lobby, but batchmode never
needs it), and they leave logs a script can check. Reach for windows only when the test is about rendering, and then
mute them and keep them off the user's screens.

Give the game a few command-line flags (read once at startup; ignored in normal play):

```csharp
using System;
using System.IO;
using System.Threading.Tasks;
using OneLobby;
using OneLobby.Unity;
using UnityEngine;

/// <summary>Test-only: `--smoke-host <file>` hosts and writes the code to file; `--smoke-join <file>` joins it.</summary>
public sealed class SmokeFlags : MonoBehaviour
{
    [SerializeField] OneLobbyRunner runner = null!;

    async void Start()
    {
        string? Arg(string name) { var a = Environment.GetCommandLineArgs(); int i = Array.IndexOf(a, name); return i >= 0 && i + 1 < a.Length ? a[i + 1] : null; }
        var hostFile = Arg("--smoke-host");
        var joinFile = Arg("--smoke-join");
        if (hostFile == null && joinFile == null) return;
        try
        {
            Lobby lobby;
            if (hostFile != null)
            {
                lobby = await runner.HostAsync(new LobbyOptions("smoke", MaxPlayers: 2));
                File.WriteAllText(hostFile, lobby.Code);
            }
            else
            {
                string code;
                while (!File.Exists(joinFile!) || (code = File.ReadAllText(joinFile!).Trim()) == "") await Task.Delay(200);
                lobby = await runner.JoinAsync(code);
                await lobby.ReadyAsync;                // faults with "ice_failed" after ReadyTimeout (default 15 s)
            }
            lobby.PeerJoined += p => Debug.Log($"[smoke] player {p.PeerId} entered");
            lobby.MessageReceived += (from, bytes, ch) => Debug.Log($"[smoke] got {bytes.Length} bytes from {from}");
            lobby.Broadcast(new byte[] { 1, 2, 3 });
            Debug.Log("[smoke] ready");
            await Task.Delay(20_000);
            Debug.Log("[smoke] PASS");                 // the script also checks the "got" lines
            Application.Quit(0);
        }
        catch (Exception e)
        {
            Debug.LogError($"[smoke] FAIL {e.Message}");
            Application.Quit(1);
        }
    }
}
```

Then build a standalone player once and run two copies with a local server (PowerShell):

```
dotnet run --project server/OneLobby.Server -- --listen :8080     # in its own terminal
$exe = "C:\path\to\Build\MyGame.exe"; $code = "$env:TEMP\smoke-code.txt"; Remove-Item $code -ErrorAction Ignore
$h = Start-Process $exe -PassThru -ArgumentList "-batchmode -nographics -logFile $env:TEMP\host.log --smoke-host $code"
$j = Start-Process $exe -PassThru -ArgumentList "-batchmode -nographics -logFile $env:TEMP\join.log --smoke-join $code"
$h, $j | Wait-Process -Timeout 60
Select-String "\[smoke\]" $env:TEMP\host.log, $env:TEMP\join.log
```

Both logs should show `[smoke] ready`, a `got 3 bytes` line and `[smoke] PASS`. `-nographics` also skips the GPU, so
this runs on CI machines. The same flags drive a windowed run when a test needs pixels: add
`-screen-fullscreen 0` and mute the game (`AudioListener.volume = 0` when a `--mute` flag is set).

## Done when

- The project compiles with the package added and the Console shows no errors.
- With a local server (`dotnet run --project server/OneLobby.Server -- --listen :8080`, then `--lobby-server=ws://127.0.0.1:8080/ws`
  or the field on `OneLobbyRunner`), one build presses Host and shows a code, a second instance (a build, or the editor)
  joins it, and a message sent by one arrives in the other's `MessageReceived`.
- The package test passes: add `"testables": ["com.onelobby.unity"]` to the manifest and run
  `Unity.exe -batchmode -projectPath <project> -runTests -testPlatform EditMode` with the server running
  (`ONELOBBY_TEST_SERVER` overrides the URL). It connects two `UnityTransport` peers and checks reliable, fast and broadcast.
  `DirectLoopbackTests` needs no server: it hosts by IP on port 47832, joins by address and checks `host_left`.
- Host by IP: one machine presses "Host by IP" and shows a join code; a friend on another network pastes it and joins.
- With the server address wrong, the game still starts and plays, and the menu shows "Multiplayer unavailable".
- No Unity licence at hand (CI)? `clients/unity/mono-probe/run.ps1` runs the package's DLLs and `datachannel.dll` on the
  editor's own 64-bit Mono runtime (unityjit profile): two peers host, list, join and exchange reliable + fast messages over
  real WebRTC through a server. `-Direct` does the same by IP with no server (OneLobby.Direct and the embedded hub).

Licences: the native library bundles libdatachannel and libjuice (MPL-2.0), usrsctp (BSD-3-Clause), plog (MIT) and
Mbed TLS (Apache-2.0). A shipped game must credit them and say where the MPL source is; texts in
`Runtime/Plugins/Licenses/`, details in `clients/dotnet/OneLobby.DataChannel/THIRD_PARTY.md`.
