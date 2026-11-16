# {{title}}: multiplayer with OneLobby

A Unity 6 game with OneLobby multiplayer wired in by `create-onelobby`. Read the recipe, not the library:
{{recipeUrl}} (it lists every step this folder already did).

## What is here

- `Assets/Resources/onelobby.json`: the multiplayer blueprint (game id, lobby size, hosting, sync mode). Change choices there; the menu reads it at run time.
- `Packages/manifest.json`: OneLobby is one package, `com.onelobby.unity` (`{{packageRef}}`), plus the built-in modules the menu uses
  and the test framework. The package carries the drop-in menu (`OneLobbyMenu`), the transport and the native WebRTC library, so there is nothing
  to copy into `Assets/` and nothing to pin. `npx create-onelobby update` moves the reference to a newer version.
- `Assets/Scripts/Boot.cs`: adds the menu to every scene by itself (no scene file) and shows a stand-in "In game" line on `GameStarted`.
  Start your game in that handler; end it on `ReturnedToLobby` or `Left`. It logs `Lobby: 2 players: Host, Joiner` each time the roster changes
  (search a player's log for it) and adds no menu while a play-mode test plays. Yours to edit. The menu doc: docs/recipes/menu.md in the OneLobby repo ("Unity").
- `Assets/OneLobby/Tests/`: `MultiplayerTests.cs` and its `OneLobbyGame.Tests.asmdef` (it references `OneLobby.Unity` and the package's `OneLobby.Core.dll`
  and `OneLobby.Direct.dll`): two peers in one process on 127.0.0.1 (no Nostr, no public server), host, join by address, one message each way.
  `create-onelobby verify` runs its other routes through this same test, so keep it.
- `Assets/OneLobby/Editor/BuildPlayer.cs`: `OneLobbyBuild.Windows` builds `{{exe}}` (Mono, 64-bit) with no manual step.
- `.olc/{{slug}}.json`: the play entry for OneLobby Console: builds the player, then opens a host window and a small joiner window on this PC.

There is no scene file: `Boot.cs` needs none, and the build script makes an empty scene for the time of the build. Add your own scenes when the game has some
(File > Build Profiles); the build script uses them when there are any.

## Run it (always headless; the Unity Editor window is never needed)

`Unity.exe` is the editor from the Unity Hub (`Unity/Hub/Editor/<version>/Editor/Unity.exe` under Program Files) or `$UNITY`. Close the editor on this project first:
one editor at a time can open a project folder. Pass an absolute path to `-logFile`.

```
# the test, headless, loopback only (the first run also imports the project)
Unity.exe -batchmode -nographics -projectPath . -runTests -testPlatform PlayMode -assemblyNames {{testAssembly}} -testResults C:\abs\tests.xml -logFile C:\abs\tests.log --local
# the Windows player
Unity.exe -batchmode -nographics -quit -projectPath . -logFile C:\abs\build.log -executeMethod {{build}}
# play: one window hosts (--local: 127.0.0.1 only), a second one joins
{{exe}} --host --local --name=Sam
{{exe}} --local --name=Ann   # type the code the host window shows (or --join=<that code>; no fixed port, another match on this PC may hold it)
```

A built player with no window: add `-batchmode -nographics -logFile C:\abs\host.log` (a player run for a test needs no screen). `--local` is required on every
test run on one PC: without it the host opens a port and may reach public relays. On the test command `--local` is for a menu your own start-up may open while the
test plays: it stays on 127.0.0.1 and skips its connection check.

The Unity editor opens its own ports in every run, whether or not OneLobby is in the project: it listens on TCP and UDP ports on all interfaces (0.0.0.0) and connects out to Unity's own licence, package and services hosts. OneLobby's own sockets in the test and in `--local` players are on 127.0.0.1 (and ::1).

## Test it (headless, loopback only)

The test command is `npx create-onelobby verify` (the editor from `--unity <exe>`, else `$UNITY`, else the Unity Hub's default folder). It checks
the editor, that Unity resolves the package, `onelobby.json` (in JS and in C#), that something outside the package uses the menu, and proves two peers on
127.0.0.1 directly, through a local Nostr relay and relay-only through a local TURN server, then prints one last line: `VERIFY_OK` or
`VERIFY_FAIL <check>: <what to do>` (exit 0 / 1). `npx create-onelobby update` moves the package reference to the version of the tool.

The quick one (direct route only): the first command above; the log has `MULTIPLAYER_OK` or `MULTIPLAYER_FAIL <what>`. Read that line, not the exit code:
on Windows the editor ends with exit code 0xC0000005 while it closes after a test that used the WebRTC library, when the test has already passed (`verify` prints
`ok` with a `WARNING:` then). `--hold=5` after the Unity arguments keeps the two peers connected for 5 seconds (time to look at the open sockets).

## Rules

- Messages go through `lobby.Send(peerId, bytes)` / `lobby.Broadcast(bytes)` and the `MessageReceived` event; a joiner's send goes via the host.
- Events fire on the main thread. The menu pumps the client; once a game has started the lobby is `menu.Model.Lobby`, and you pump it (set `menu.Pump = false` when your game pumps).
- Code that uses `OneLobbyMenu`, `OneLobbyRunner` or the client from your own `.asmdef` must list `"OneLobby.Unity"` in its references; the default assembly needs nothing.
- Keep a player's data out of file names that two instances on one PC would share (give each a suffix).
