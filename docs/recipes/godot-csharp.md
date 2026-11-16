# Recipe: Godot 4 C# (desktop and web)

Godot uses `OneLobby.Core` unchanged and adds `OneLobby.Godot` for the WebRTC transport, microphone capture and Opus.
Godot snippets are not compiled by `check-snippets.mjs` (they need GodotSharp); the engine-free parts are in
`dotnet-generic.md` and are. Use Godot 4.5 or newer with the .NET build (tested on 4.5.1 and 4.7.2; `OneLobby.Godot`
builds against GodotSharp 4.5.1, and a newer project's GodotSharp takes its place).

## One command

`create-onelobby` does sections 1 and 2 below and the headless test for you. It adds `OneLobby.Core`, `OneLobby.Godot` and `OneLobby.Direct` to the
`.csproj` as package references, copies the menu (`addons/onelobby_menu/`, pinned by `PIN.json`), installs the WebRTC natives (a download whose SHA-256 is
checked), writes `onelobby.json`, `OneLobbyNet.cs` (the `HostDirect` / `JoinDirect` the menu needs, because `OneLobby.Core` cannot reference
`OneLobby.Direct`), `tests/MultiplayerTest.tscn` and an olc entry, and keeps the menu LF in git. It needs the .NET build of Godot 4.5 or newer and the .NET 8 SDK.

```
npx create-onelobby my-game --template godot-csharp --yes                 # a new project with the drop-in menu as its main scene
npx create-onelobby --into path/to/your-project                           # an existing Godot C# project; your scenes are not touched
cd my-game
dotnet build MyGame.csproj                                       # name the file: once Godot's editor writes a .sln beside it, a bare `dotnet build` cannot pick
godot --headless --import --path .                                        # once: registers the WebRTC extension
godot --headless --audio-driver Dummy --path . res://tests/MultiplayerTest.tscn   # prints MULTIPLAYER_OK (two peers on 127.0.0.1)
```

The packages of a version reach the public registry only with its release. Before that, pack them (`clients/dotnet/pack.sh <new version> <folder>`) and add
`--packages-from <folder>`: the references get that version and a `nuget.config` takes `OneLobby.*` from the folder.

`npx create-onelobby verify` is THE test command: Godot is the .NET build, the game builds, the menu matches `PIN.json`, the natives are registered,
`onelobby.json` loads in JS and in C#, then two peers on 127.0.0.1 directly and through a local Nostr relay, then the relay-only route through a local TURN server
(it must show allocations and relayed packets above 0); the last line is `VERIFY_OK` or
`VERIFY_FAIL <check>: <next step>`. `npx create-onelobby update` re-vendors the menu when a new one is out (it stops on files you edited unless `--force`) and moves the
`OneLobby.*` versions in the `.csproj`.

For `--into` the output prints the lines that add `OneLobbyMenu.tscn` to your main scene and wire it (section 2). A second run changes nothing.
The `.csproj` is edited in place: only the missing package references are added, everything else stays; a file it cannot read safely is refused
(`bad_csproj`) and nothing is written. Details: `clients/js/packages/create-onelobby/README.md`.

## By hand

What the command did, step by step: sections 1 and 2. The rest of the page is the same either way.

## 1. Add the packages

```
dotnet add package OneLobby.Core
dotnet add package OneLobby.Godot
```

Desktop: copy the `webrtc-native` GDExtension into `addons/` (the demo in `clients/dotnet/demo-godot/` shows where).
Web export: nothing extra, but see "Web builds" below.

## 2. Add the menu scene

The multiplayer front end (name, Host, Join with a code, an `ip:port` or an invite link, the lobby with a roster, ready, countdown,
chat, kick and ban, plain-language errors, settings, Browse) is one scene you copy in: `clients/dotnet/demo-godot/addons/onelobby_menu/`
holds `OneLobbyMenu.cs` and `OneLobbyMenu.tscn`. Godot can only attach a C# script that is a source file inside the game's own
project, so (unlike `OneLobby.Core` and `OneLobby.Godot`, which come from NuGet) these two files go into your project as they are.

1. Copy the folder `addons/onelobby_menu/` into your project, add `onelobby.json` at its root (`docs/design/blueprint.md`; `engine`
   `godot-csharp` makes `ui.kind` `drop-in`), and `dotnet build`.
2. Add `OneLobbyMenu.tscn` to your main scene and connect one event:

```csharp godot
public partial class Main : Node
{
    public override void _Ready()
    {
        var menu = GetNode<OneLobbyMenu>("OneLobbyMenu");
        menu.GameStarted += lobby => GD.Print($"start the match with {lobby.Room.Players.Count} players");
        menu.ReturnedToLobby += lobby => GD.Print("end the match; the menu is showing the lobby again");
        menu.Left += () => GD.Print("the player left the lobby");
    }
}
```

That is the whole integration. The menu builds its `LobbyClient` from `onelobby.json` over `GodotTransport`, keeps the player's name,
last code, lobby server and relay line under `user://onelobby.json`, pumps the client every frame, hides itself while the game runs
and acts on `--host`, `--join=<code>` and `--name=<name>` after `--`. Its properties, boot flags, rewording and restyling are in
`menu.md` ("Godot C#"); it is the same scene and the same text table as the GDScript menu. `MenuDemo.tscn` in the demo project
is a runnable example (`godot --path clients/dotnet/demo-godot res://MenuDemo.tscn -- --host --name=Sam`).

The scene is generated from the GDScript menu's (`node tools/make-menu-scene.mjs`), and a test fails when the two differ, so a
layout fix lands in both at once.

### Build your own

If your game draws its own menu, the engine-free `MenuModel` in `OneLobby.Core` holds every decision (`menu.md`, "For a controller
of your own"), or write the plain version below by hand.

### The autoload `Net.cs`

Add it under Project Settings, Autoload, as `Net`. The lobby server is a setting with a pre-filled default.

```csharp godot
using System;
using System.Threading.Tasks;
using Godot;
using OneLobby;
using OneLobby.Godot;

public partial class Net : Node
{
    public const string DefaultServer = "wss://lobby.onelobby.example/ws";
    LobbyClient _client = null!;
    public Lobby? Lobby { get; private set; }
    [Signal] public delegate void StatusEventHandler(string text);

    public override void _Ready()
    {
        string server = DefaultServer;
        foreach (var arg in OS.GetCmdlineArgs())                              // --lobby-server=ws://127.0.0.1:8080/ws
            if (arg.StartsWith("--lobby-server=")) server = arg["--lobby-server=".Length..];
        var cfg = new ConfigFile();
        if (cfg.Load("user://settings.cfg") == Error.Ok)
            server = (string)cfg.GetValue("multiplayer", "lobby_server", server);

        var config = new OneLobbyConfig("com.you.yourgame", "1", new Uri(server), SyncMode.Raw, DisplayName: "Player");
        _client = new LobbyClient(config, new GodotTransport());
        _client.Error += e => EmitSignal(SignalName.Status, e.Message);
    }

    public override void _Process(double delta)                               // events fire on the main thread
    {
        if (Lobby != null) Lobby.Pump(); else _client.Pump();                 // _client.Pump() only matters before a lobby exists
    }

    public async Task<string?> HostAsync()
    {
        try { Lobby = await _client.HostAsync(new LobbyOptions("My game", MaxPlayers: 2, Visibility: Visibility.Public)); return Lobby.Code; }
        catch (Exception e) { EmitSignal(SignalName.Status, "Multiplayer unavailable: " + e.Message); return null; }
    }

    public async Task<bool> JoinAsync(string code)
    {
        try { Lobby = await _client.JoinAsync(code); return true; }
        catch (Exception e) { EmitSignal(SignalName.Status, "Multiplayer unavailable: " + e.Message); return false; }
    }

    public async Task<System.Collections.Generic.IReadOnlyList<LobbySummary>> BrowseAsync()
    {
        try { return await _client.ListAsync(); }
        catch (Exception e) { EmitSignal(SignalName.Status, "Multiplayer unavailable: " + e.Message); return Array.Empty<LobbySummary>(); }
    }
}
```

### Host / Join / Browse buttons

```csharp godot
public partial class MultiplayerMenu : Control
{
    Net _net = null!;
    public override void _Ready()
    {
        _net = GetNode<Net>("/root/Net");
        var status = GetNode<Label>("Status");
        _net.Status += text => status.Text = text;

        GetNode<Button>("Host").Pressed += async () =>
        {
            var code = await _net.HostAsync();
            if (code != null) status.Text = $"Share this code: {code}";
        };
        GetNode<Button>("Join").Pressed += async () =>
        {
            if (await _net.JoinAsync(GetNode<LineEdit>("Code").Text)) status.Text = "Joined.";
        };
        GetNode<Button>("Browse").Pressed += async () =>
        {
            var list = GetNode<ItemList>("Lobbies");
            list.Clear();
            foreach (var s in await _net.BrowseAsync()) list.AddItem($"{s.Name} ({s.Players}/{s.MaxPlayers})");
        };
    }
}
```

## 3. Game traffic

Raw mode: `Lobby.Send` / `Broadcast` and `MessageReceived` (see `raw-mode.md`). Lockstep: set `SyncMode.Lockstep` and drain
frames in `_Process` after `Pump()` (the loop in `AGENTS.md` rule 3 and DESIGN s.11.1): decode each command, call your
sim, `ReportHash` every `HashEveryTicks`. The sim must be deterministic and not read Godot nodes or the clock.

## Web builds

Browser peers use the browser's own WebRTC through `OneLobby.Godot`'s web path. Serve the export with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (the `deploy/Caddyfile` snippet
does this) if you use threads. Voice needs `audio/driver/enable_input` on.

## Done when

- The project builds with `dotnet build` and the menu scene shows Host / Join / Browse (when `onelobby.json` names a lobby server).
- With a local `onelobby-server`, two Godot instances (`--lobby-server=ws://127.0.0.1:8080/ws`; use 127.0.0.1, not localhost): one presses Host and shows a
  code, the other joins it, and a message sent by one arrives in the other's `MessageReceived`.
- With the server address wrong, the game still starts and plays, and the menu shows "Multiplayer unavailable".
