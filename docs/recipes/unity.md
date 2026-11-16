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
  dependencies it adds; a game that already references `com.onelobby.unity` keeps its line: it never moves, see "an older package line" below), and the tool prints the lines that put the menu into your own start-up.
- The package is not on a registry yet. `--package-from <tgz>` writes a `file:` line (relative to `Packages/`); without it the line is
  `file:com.onelobby.unity-<version>.tgz` and the tarball goes next to `manifest.json` (build one with `clients/unity/build-unity-package.sh --pack`, or take the
  `unity-dev-package` CI artifact, which has the natives). `npx create-onelobby update` moves that line to the tool's version (a `file:` line you wrote is kept
  unless `--package-from` is given).
- **Getting the package** (a clone, or a build that is not released yet): a released game takes the release tarball (`com.onelobby.unity-<version>.tgz` on the
  GitHub release, natives included). From a clone run `clients/unity/fetch-natives.sh` once (anonymous download, SHA-256 checked, puts the WebRTC libraries where
  the build looks; or build them: `clients/dotnet/OneLobby.DataChannel/native/build-windows.ps1`), then `clients/unity/build-unity-package.sh --pack` and
  copy the `.tgz` next to `manifest.json`. `--pack` stops with `PACK_FAIL` when the Windows library (`Runtime/Plugins/x86_64/datachannel.dll`) is missing, and
  `create-onelobby verify` fails its `package` check, before it starts anything, when the tarball has no `datachannel.dll`: on Windows two peers
  would never link.
- The test runs headless: `Unity.exe -batchmode -nographics -projectPath . -runTests -testPlatform PlayMode -assemblyNames OneLobbyGame.Tests -testResults <abs>.xml -logFile <abs>.log --local`
  and logs `MULTIPLAYER_OK` (or `MULTIPLAYER_FAIL <what>`). The first run also imports the project. `verify` runs the other routes through the same test with
  arguments after Unity's own (`--route=nostr --relay=...`), against a local Nostr relay and TURN server that it starts on 127.0.0.1. `--hold=5` keeps the two
  peers connected for 5 seconds before the result line (time to look at the open sockets).
- Read the result line, not Unity's exit code: on Windows the editor ends with exit code 0xC0000005 while it closes after a test that used the WebRTC
  library (the open finding in `tools/engine-smoke/README.md`); the test has passed and its results file is written by then.
- The Unity editor opens its own ports in every run, whether or not OneLobby is in the project: it listens on TCP and UDP ports on all interfaces (0.0.0.0) and connects out to Unity's own licence, package and services hosts. OneLobby's own sockets in the test and in `--local` players are on 127.0.0.1 (and ::1).
- Never run a player or the editor without `-batchmode` in tests, and never run a player with `--host` without `--local` (127.0.0.1 only, no Nostr, no router request).
- `clients/unity/scaffold-test.sh` runs all of this end to end on a machine with Unity; it is local only (CI has no Unity licence).

### `--into` a game that already has its own multiplayer (runner, Setup page, Room screen, replication, own build)

For a game with its own runner or client, its own Setup (menu) page and its own Room screen, on its own sync (`--mode raw`). The agent skill
(`.claude/skills/onelobby/SKILL.md`, "Unity, a game that already has multiplayer") gives the ordered steps; this section is the reference it opens for
the exact names and one code skeleton. Nothing here needs the package source: every member a game wires is listed.

**0. An older package line.** `--into` and a rerun never move the `com.onelobby.unity` line of `Packages/manifest.json`. A game on an older tarball
(`file:com.onelobby.unity-0.7.2-ci.30.tgz`): put the new tarball in `Packages/`, run `npx create-onelobby update --package-from Packages/<new>.tgz` (it moves
only that line), delete the old tarball, then open the project in Unity once so it rewrites `Packages/packages-lock.json` and commit both. The run's note and
its Next line say this whenever the line differs from the one this run would write.

**1. Fill the blueprint from the game's own constants.** The proposal answers from the sentence; the game's constants win. Grep for each row, pass the flag
(or `--set <key>=<value>`) and write the file and line in the report. A constant left in code beside a blueprint key is a drift bug.

| the game's constant | blueprint key | flag |
|---|---|---|
| game id, wire version, title | `game.id`, `game.netVersion`, `game.title` | `--game-id`, `--net-version` (a run-time suffix stays in code, see 2), `--title` |
| seats / max players | `lobby.maxPlayers` | `--max-players` |
| own snapshot or command code | `sync.mode` `raw` | `--mode raw` (it leaves out `sync.tickRate` and `sync.player.*` by itself) |
| who may pause (own pause menu, a `lobby.Pause` policy) | `session.pause` `off` / `host` / `anyone` | `--pause` |
| longest name | `players.maxNameLength` (default 24) | `--set players.maxNameLength=16` |
| names off | `players.identity` | `--identity anonymous` |
| join timeout (a joiner gives up) | `session.readyTimeoutMs` (default 15000; 0 waits forever) | `--set session.readyTimeoutMs=20000` |
| silent-peer timeout, heartbeat | `session.peerTimeoutMs` (0 = about 30 s; else at least 6000) | `--set session.peerTimeoutMs=8000` |
| message rate limit per joiner | `session.rateLimit.messages` and `.perMs` (set both) | `--set session.rateLimit.messages=60 --set session.rateLimit.perMs=1000` |
| host leaves | `session.hostLeaves` (`end` only without a lobby server) | `--host-leaves` |
| own rejoin or seat holding | `lobby.rejoin`, `room.rejoinWindowSeconds` | `--no-rejoin` |
| late join | `lobby.lateJoin`, `room.lateJoin` | `--no-late-join` |
| countdown, minimum players, auto start | `room.countdownSeconds`, `room.minPlayers`, `room.autoStart`, `room.autoStartPlayers` | `--set room.countdownSeconds=0` |
| port, router request | `hosting.directPort`, `hosting.openPort` | `--port`, `--no-open-port` |
| Nostr on or off, its relay list | `hosting.nostr`, `hosting.nostrRelays` | `--set hosting.nostr=false`, `--set hosting.nostrRelays=[...]` |
| lobby server (a hand-coded URL) | `hosting.lobbyServer`, `hosting.server` | `--lobby-server`, `--hosting direct\|server\|both` |
| chat | `chat.text`, `chat.voice` | `--no-chat`, `--voice` |
| keep running unfocused | `session.runInBackground` | `--set session.runInBackground=false` |

**2. Load the file and build the runner FIRST.** The file is `Assets/Resources/onelobby.json`; the runner takes it as a `TextAsset`:

```csharp unity
using System.Threading.Tasks;
using OneLobby;                 // Blueprint, LobbyClient, Lobby, PlayerSettings, Friendly
using OneLobby.Direct;          // DirectHostOptions, JoinDirectOptions, and the Blueprint.ToDirectHostOptions extension
using OneLobby.Unity;           // OneLobbyRunner, OneLobbyMenu, PlayerPrefsStore
using UnityEngine;

public sealed class MyGameNet : MonoBehaviour
{
    public const string WireVersion = "25";   // the game's own constant: the only value of onelobby.json that stays in code

    OneLobbyRunner runner;
    OneLobbyMenu menu;

    public TextAsset BlueprintAsset() => Resources.Load<TextAsset>(OneLobbyMenu.BlueprintResourceName);   // "onelobby"

    OneLobbyRunner Runner()
    {
        if (runner) return runner;
        runner = gameObject.AddComponent<OneLobbyRunner>();
        runner.Blueprint = BlueprintAsset();                       // the blueprint wins: the GameId, NetVersion and Mode fields are ignored
        runner.DisplayName = "Player";                             // the saved name takes over while this is empty or "Player"
        runner.ConfigureConfig = c => c with { NetVersion = WireVersion };   // read when the client is built, on the first runner.Client
        return runner;
    }

    // host options from the file: maxPlayers, port (with 9 fallback ports), Nostr and its relays, LAN, password; the library adds the player's saved relay
    DirectHostOptions HostOptions(string playerName)
    {
        var options = OneLobby.Blueprint.Parse(BlueprintAsset().text).ToDirectHostOptions(null, playerName);
        // options.Port = 47811; options.FallbackPorts = 0;        // a fixed port; without FallbackPorts = 0 a busy port moves to the next free one
        return options;
    }

    public void OpenMenu()   // only while solo: a menu built on a live line starts on its start page
    {
        if (menu) return;
        Runner();
        var go = new GameObject("OneLobbyMenu");
        go.SetActive(false);                       // every property is set before the menu's Start runs
        go.transform.SetParent(transform, false);
        menu = go.AddComponent<OneLobbyMenu>();
        menu.Runner = runner;                      // the runner built above: the menu takes it instead of adding its own
        menu.BootFlags = false;                    // the game reads its own --host / --join
        menu.Pump = false;                         // the menu is destroyed when the match starts; the runner keeps pumping the client
        menu.StartOnHost = true;                   // the game has its own room screen: the host does not press Start twice
        menu.BeforeHost = ConfirmHostAsync;        // false cancels the host (a "run in progress" dialog)
        menu.GameStarted += OnGameStarted;
        go.SetActive(true);
    }

    Task<bool> ConfirmHostAsync() => Task.FromResult(true);   // show your dialog, complete with the answer

    void OnGameStarted(Lobby lobby)
    {
        // YOUR role and "line is live" state FIRST, then attach: GameStarted runs with the menu's screen already Playing
        // role = lobby.IsHost ? Role.Host : Role.Client;
        var m = menu;
        menu = null;
        if (m) { m.GameStarted -= OnGameStarted; Destroy(m.gameObject); }
        // Attach(lobby);   // your session on lobby.Send / lobby.Broadcast / lobby.MessageReceived (or ReplicationSession)
    }
}
```

**3. The members a game wires** (everything else the menu does by itself):

| member | signature and meaning |
|---|---|
| `OneLobbyRunner.Blueprint` | `TextAsset?`; set before the first `Client` read |
| `OneLobbyRunner.ConfigureConfig` | `Func<OneLobbyConfig, OneLobbyConfig>?`, e.g. `c => c with { NetVersion = "25" }`; applied when the client is built |
| `OneLobbyRunner.Client`, `.Lobby` | `LobbyClient` (built on first read), `Lobby?` (null when solo); events `LobbyChanged` `Action<Lobby?>`, `Error` `Action<LobbyError>` |
| `OneLobbyRunner` calls | `Task<Lobby> HostDirectAsync(DirectHostOptions? options = null)`, `Task<Lobby> JoinDirectAsync(string codeOrAddress, string? password = null)` or `(string, JoinDirectOptions)`, `Task LeaveAsync()` |
| `OneLobbyMenu.BlueprintResourceName` | `const string` = `"onelobby"`: `Resources.Load<TextAsset>(OneLobbyMenu.BlueprintResourceName)` |
| `OneLobbyMenu.Runner`, `.Client` | `OneLobbyRunner?`, `LobbyClient?`: set `Runner` before the first frame (the menu builds itself in `Start`); a menu added with none adds a runner and builds the client at once |
| `OneLobbyMenu.GameStarted` / `ReturnedToLobby` / `Left` | `event Action<Lobby>`, `event Action<Lobby>`, `event Action`. `GameStarted` fires on every copy when the match starts (host: after Start and the countdown; joiner: when the host's phase turns `in_game`, a late joiner too) |
| `OneLobbyMenu.Pump` | `bool`, default true: pumps a lobby the runner does not hold; with a runner the menu never pumps twice, and `false` is right when the menu is destroyed at match start |
| `OneLobbyMenu.BootFlags` | `bool`, default true: acts on `--host`, `--join=<code>`, `--name=<name>`; `--local` is always read |
| `OneLobbyMenu.AutoHideOnStart` | `bool`, default true: hides on `GameStarted`, shows on `ReturnedToLobby` |
| `OneLobbyMenu.StartOnHost` | `bool`, default false: after a successful Host the menu presses Start itself, once; a joiner is unaffected; the countdown still runs (`room.countdownSeconds`, 0 = at once) |
| `OneLobbyMenu.BeforeHost` | `Func<Task<bool>>?`: asked before every Host (the button and `--host`); `false` cancels, a throw counts as false, a second press while it waits is ignored; null = no question |
| `OneLobbyMenu.LeaveAsync()`, `.SortingOrder`, `.Model` | `Task`; `int` draw order (default 1000: above your uGUI); the `MenuModel` (`StartOnHost` and `BeforeHost` are on it too) |
| `PlayerSettings` | `new PlayerSettings(IKeyValueStore? store, string gameId, Func<string,string?>? env = null)`; `static string Key(string gameId)` (STATIC: `PlayerSettings.Key(id)`, not on an instance); `SettingsValues Load()` (`Name`, `Relay`, `LastCode`, `Server`); `SaveResult Save(string? name = null, string? relay = null, string? lastCode = null, string? server = null)` (null leaves a field alone, `""` removes it; `SaveResult.Ok`, `.Rejected` lists the fields that did not clean); `Clear()`. Without a client: `new PlayerSettings(new PlayerPrefsStore(), gameId)`; a client's own is `client.Settings` |
| `Friendly.DescribeError` | `static FriendlyError DescribeError(Exception? error)`, `(LobbyError error)`, `(string? codeOrText)`; `FriendlyError` has `Code`, `Message`, `Hint` (nullable), `Cause`, `Stage` |
| `Blueprint` | `static Blueprint Parse(string json)`, `static Blueprint Load(string path)`; extension `DirectHostOptions ToDirectHostOptions(string? name = null, string? displayName = null)` (`using OneLobby.Direct;`); `LobbyOptions ToLobbyOptions(string? name = null, string? displayName = null)`; `LobbyClient.FromBlueprint(Blueprint, ITransport, string? displayName = null, string? lobbyServerOverride = null, Func<OneLobbyConfig,OneLobbyConfig>? configure = null)`. In a class that has a `Blueprint` member write `OneLobby.Blueprint` |

**4. Replace in this order, deleting a hand-built piece only after the menu works.**
1. The runner's setup: blueprint from the file, `ConfigureConfig` for the wire version only (delete the `GameId`, `NetVersion`, `Mode` and `ReadyTimeout` lines and a hand-written blueprint string built from constants).
2. The Setup page's name field, code field, Paste, Join, Host and server buttons: the menu over the page (the page keeps its frame: title, status, Back). The menu panel is above uGUI (`SortingOrder` 1000), so a Back button under it cannot be clicked, and the menu has no Back on its start screen (`MenuModel.Back()` is false there): close it from your own Esc or Back handling by destroying `menu.gameObject`.
3. The relay (TURN) paste field and its parser, and the saved name and relay in `PlayerPrefs`: `PlayerSettings` and the menu's settings page (step 5).
4. The hand-built `DirectHostOptions` and the relay applied to joiners: `Blueprint.ToDirectHostOptions` and `JoinDirectOptions` (the library adds the saved relay); `ONELOBBY_RELAY` sets one for a run.
5. The error strings of join and host: `Friendly.DescribeError(ex)` (the menu shows them itself).
6. Tests of the deleted pieces go with them (list them in the report); a test that builds a client from the game's code blueprint reads the file instead: `LobbyClient.FromBlueprint(OneLobby.Blueprint.Load(path), transport, name, null, c => c with { NetVersion = "25" })`, or `Resources.Load` in play mode.

**5. Old saved settings, once.** `PlayerSettings` keeps name and relay in one `PlayerPrefs` key, `onelobby.settings.<gameId>`: decide the game id first. At start, only when the old
keys exist and `settings.Load().Name` is empty or `"Player"`: `settings.Save(name: oldName, relay: oldRelay)` (a relay that does not parse comes back in `Rejected`: say so in the report); in every case then
`PlayerPrefs.DeleteKey` the old keys, so a later launch never overwrites a name the player chose in the menu.

**6. Your own Room screen after the menu.** The menu has a room step (roster, Ready, the host's Start). A game with its own pre-match screen (a class pick) keeps it: set `menu.StartOnHost = true`
so the host's Host click goes straight on (countdown, then `GameStarted`) and the game's own Start is the only one the host presses; joiners see the menu's room until the host's phase turns
`in_game`. Without it the host presses Start twice. Set `room.countdownSeconds` to `0` to skip the countdown.

**7. Tests and tools.** The game's own two-copy tool, its own flags and sessions stay (they drive the game's own netcode); only a test of lobby linking goes. Run the scaffolder's assembly alone
(`-assemblyNames OneLobbyGame.Tests`) and the game's own PlayMode assembly as a separate run. A game's own Unity tooling may write to the system temp folder: where that is not allowed, set `TEMP` and `TMP` for the run.

- **Runner first.** `OneLobbyRunner` builds its `LobbyClient` the first time `Client` is read, and `Blueprint`, `ConfigureConfig` and `BindAddress` are read then. A menu added first adds a runner of its own and builds the client at once.
- **`menu.BootFlags = false`** when the game's own code reads `--host` / `--join`: the menu reads them too (default on), and both copies would act. There is no `--autostart` on Unity: `room.autoStart` `"players"` with `room.autoStartPlayers` 2 starts both copies of a headless test with no click.
- **Event order.** `GameStarted` runs with the menu's screen already `Playing`: set your own role and "line is live" state first, then attach the lobby. `ReturnedToLobby` (back to the room) and `Left` (the player left) end the match. A direct lobby has no host migration.
- **Your own player build stays yours.** If a script outside `Assets/OneLobby/` calls `BuildPipeline.BuildPlayer`, `--into` writes no
  `Assets/OneLobby/Editor/BuildPlayer.cs`, adds a note saying so, and prints no "build the Windows player" line; point your `.olc` entry at your own exe. Without such a
  call it writes `BuildPlayer.cs`, which builds the scenes enabled in File > Build Profiles into `Builds/Windows/Game.exe`. `verify` never builds a player.
- **Close the Unity editor** before `verify` or any batchmode run: a project open in the editor cannot be opened again (`Temp/UnityLockfile`), and `verify` says so instead of blaming the tarball.
- `lobby.joinLink` is `false` for a Unity player: a join link is the share URL of a web page, which a player build does not have (the default is `true` for `web` and `node-browser` only).

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

## Players in the world

`OneLobbyNetPlayer` and `OneLobbyNetPlayerSpawner` put the players of a replication-mode lobby in the world (position, facing, movement state, jump, shoot, melee, smooth on the other screens) with no player sync of your own: `docs/recipes/net-player.md`, section 12, and the package's `NetPlayer` sample. Two built players of that sample on one PC are run by `clients/unity/net-player-test.sh` (local only: Unity is not in CI; the script stops at once with `NETPLAYER_FAIL no Windows WebRTC library (datachannel.dll) ...` when the package has no Windows native).

In one command: `npx create-onelobby my-game --template unity --mode replication --set sync.player.authority=owner --yes --package-from <tgz>` (`host` for the other authority, `--set sync.player.space=2d` for a side-on game, or a `--recommend` sentence of the co-op or shooter shape) writes, besides the files above, `Assets/Scripts/Game.cs` (a floor, a light, a camera and the spawner), `Assets/Scripts/GamePlayer.cs` (a capsule or square made in code, with the `OneLobbyNetPlayer` component; WASD or arrows and space; the file says whether the owner's PC or the host places it), `Assets/Scripts/OneLobbyGame.asmdef` (so the test can use the character), a `Boot.cs` that opens the game on `GameStarted`, and a player check in the play-mode test: the joiner's player appears on the host, follows the joiner, and one jump arrives once (`MULTIPLAYER_PLAYER` in the log, then `MULTIPLAYER_OK`). All of it is yours to edit and `update` never rewrites it. `--into` writes none of it: it prints the lines that add the spawner and the component to your own start-up. `--yes` alone and `--mode replication` alone do not turn it on; a game without `sync.player` is written byte for byte as before. `verify` has a `player` line for such a game.

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
