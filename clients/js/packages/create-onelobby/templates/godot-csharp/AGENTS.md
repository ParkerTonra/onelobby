# {{title}}: multiplayer with OneLobby

A Godot 4 (C#) game with OneLobby multiplayer wired in by `create-onelobby`. Read the recipe, not the library:
{{recipeUrl}} (it lists every step this folder already did).

## What is here

- `onelobby.json`: the multiplayer blueprint (game id, lobby size, hosting, sync mode). Change choices there.
- `{{assembly}}.csproj`: the game's project. `OneLobby.Core`, `OneLobby.Godot` and `OneLobby.Direct` come from NuGet (version {{packagesVersion}}){{feedNote}}.
- `addons/onelobby_menu/`: the drop-in menu, `OneLobbyMenu.cs` and `OneLobbyMenu.tscn`. These two files are copied into the game because Godot
  can only attach a C# script that is a source file of the game's own project. Do not edit them: `addons/onelobby_menu/PIN.json` lists the
  SHA-256 of each file so an untouched copy can be told from an edited one (`npx create-onelobby update` refreshes it).
- `addons/godot_webrtc/`: Godot's WebRTC extension (webrtc-native {{webrtcVersion}}). Not committed (`.gitignore`); a fresh clone gets it back with
  `npx create-onelobby update`.
- `OneLobbyNet.cs`: hands the menu its direct-hosting functions (`HostDirect` / `JoinDirect`; the menu cannot reference `OneLobby.Direct`) and
  reads `--local`. Yours to edit.
- `Main.tscn` / `Main.cs`: the menu plus a label that shows the roster on `GameStarted`. Start your game in that handler; end it on
  `ReturnedToLobby` or `Left`. The menu doc: docs/recipes/menu.md in the OneLobby repo ("Godot C#").
- `tests/MultiplayerTest.tscn` + `.cs`: two peers in one process on 127.0.0.1 (no Nostr, no public server), host, join by address, one message each way.
  `create-onelobby verify` runs its other routes through this scene, so keep it.

## Run it

```
dotnet build                                   # once, and after every C# change (Godot does not build for you in --headless runs)
godot --headless --import --path .             # once on a fresh clone: registers the WebRTC extension
godot --path . -- --host --local --name=Sam    # one window hosts (--local: 127.0.0.1 only)
godot --path . -- --join=127.0.0.1:47810 --local --name=Ann   # a second window joins
```

Use the .NET build of Godot (the "mono" download); the standard build cannot run C#.

## Test it (headless, loopback only)

The test command is `npx create-onelobby verify` (Godot from `--godot <exe>`, else `$GODOT`, else `godot` on PATH). It checks that Godot is the
.NET build and the game builds, the menu against `PIN.json`, the WebRTC natives, `onelobby.json` (in JS and in C#), and proves two peers on
127.0.0.1 directly, through a local Nostr relay and relay-only through a local TURN server, then prints one last line: `VERIFY_OK` or
`VERIFY_FAIL <check>: <what to do>` (exit 0 / 1). The TURN check needs the helper once: add `--fetch-helpers` (an anonymous npm download into
`.onelobby/`, gitignored). `npx create-onelobby update` brings the menu and the package versions up to date.

The quick one (direct route only):

```
dotnet build
godot --headless --audio-driver Dummy --path . res://tests/MultiplayerTest.tscn
```

It prints `MULTIPLAYER_OK` and exits 0, or `MULTIPLAYER_FAIL <what>` and exits 1. Always pass `--headless --audio-driver Dummy`.

## Rules

- Messages go through `lobby.Send(peerId, bytes)` / `lobby.Broadcast(bytes)` and the `MessageReceived` event; a joiner's send goes via the host.
- Events fire on the main thread. The menu pumps the client; once a game has started the lobby is `menu.Model.Lobby`, and you pump it (set `menu.Pump = false` when your game pumps).
- Windows export: ship `libwebrtc_native.windows.template_release.x86_64.dll` beside the exe, and add `*.json` to the export filters so `onelobby.json` is packed.
- Keep a player's data out of `user://` file names that two instances on one PC would share (give each a suffix).
