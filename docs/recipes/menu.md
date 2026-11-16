# Recipe: the drop-in menu for Godot (GDScript and C#)

One scene, `res://addons/onelobby/menu/menu.tscn`, is the whole multiplayer front end: the player types a name, hosts, or joins with a
code, an `ip:port` or an invite link, waits in a lobby with a roster, readies up, and the host starts the game. When it works the
menu says so with a signal; when it does not, it says why in plain words. No game code beyond one connected signal. The sections below are
written for GDScript; "Godot C#" says what differs for the C# scene (`OneLobbyMenu.tscn`).

```gdscript compile file=menu-hookup.gd
extends Node

@onready var menu: OneLobbyMenu = $OneLobbyMenu


func _ready() -> void:
	menu.game_started.connect(_on_game_started)
	menu.returned_to_lobby.connect(_on_back_in_lobby)
	menu.left.connect(_on_left)


func _on_game_started(lobby: OneLobbyLobby) -> void:
	print("start the match with ", lobby.room.players().size(), " players")


func _on_back_in_lobby(_lobby: OneLobbyLobby) -> void:
	print("end the match; the menu is showing the lobby again")


func _on_left() -> void:
	print("the player left the lobby")
```

## What it shows

- **Start.** Name (cleaned with the room's name rules and saved), Host, Join (cleaned as typed; offers the last code; also takes a pasted invite sentence, a bare code, an `ip:port` or an invite link), Password,
  Browse (only when a lobby server is set), Settings.
- **Connecting.** What is being tried, and Cancel.
- **Lobby.** The code, large, with Copy code and Copy invite (the sentence `Join my game in <Game>: code 7HQ 4K2`, the game's `game.title`, or `Join my game: code 7HQ 4K2` with no title; when `invite_base` is set and the code is a lobby-server code, a space and the invite link follow); the roster
  (host mark, ready, watching, reconnecting, ping); a Ready toggle; for the host Start (everyone sees the countdown, the host can
  cancel it), Kick and Ban on every row with an optional reason, the ban list with Unban, the lobby settings the room layer lets the host
  change (start by itself, players needed, countdown, late join), and Let in / Refuse when the lobby asks to approve joins; text chat when
  `chat.text` is on; Leave. Against a host that has no room layer the lobby falls back to a plain peer list.
- **Removed / Error.** The sentence and the next step from `OneLobbyFriendly` and `OneLobbyDiagnose`, the code small underneath, Copy logs
  and Save logs (the net log, addresses masked), Back. A kicked or banned player reads the host's reason.
- **Settings.** The relay line (pasted, only ever shown masked, with its status), the lobby server, the Connection check (a one-line
  verdict and three facts) and Copy logs.

## Hand-off

| | |
|---|---|
| `game_started(lobby)` | the host started the game, or the player joined one already running; the menu hides itself when `auto_hide_on_start` is true (default) |
| `returned_to_lobby(lobby)` | the game went back to the lobby (`lobby.room.back_to_lobby()`); the menu shows again |
| `left()` | the player left the lobby |
| `client` | the `OneLobbyClient` the menu drives; default `OneLobbyClient.from_config(config_path)` (`config_path` defaults to `res://onelobby.json`). Set it before the menu enters the tree to use your own. |
| `pump` | true: the menu calls `client.pump()` every frame. Set false when your game pumps. |
| `host_options`, `join_options`, `route` | passed to `host()` / `join()`; `route` is `auto` (the blueprint decides), `direct` or `server` |
| `invite_base`, `texts`, `boot_flags`, `boot_args` | see below |

The lobby is `menu.client.lobby` (the signal gives it to you too). Nothing else is required of the game.

## Boot flags

With `boot_flags` on (default), `--host`, `--join=<code>` and `--name=<name>` after `--` act at once:

```
godot --path . -- --host --name=Sam
godot --path . -- --join=D1PB-1X9S-FPV --name=Ann
```

One switch (`boot_flags = false`) turns all three off. Tests give the flags to a menu with `boot_args` instead of the process command line.

## Restyling

The scene is stock Godot controls on the engine's default theme: no fonts, colours, images or sounds of its own (the join code and the
error code only change a font size). Give the menu, or any parent of it, a `Theme` resource and everything follows. `ui.theme` of the blueprint
is for the web element and does not apply here.

```gdscript compile file=menu-theme.gd
extends Control

@export var game_theme: Theme


func _ready() -> void:
	var menu: OneLobbyMenu = $OneLobbyMenu
	menu.theme = game_theme
```

## Rewording and translating

Every string of the menu is in `OneLobbyMenuText.TABLE`. Give the menu a Dictionary of the keys to change (`texts`, or
`OneLobbyMenuText.override(...)` before the menu appears):

```gdscript compile file=menu-text.gd
extends Node


func _ready() -> void:
	OneLobbyMenuText.override({"host": "Create game", "join": "Enter game", "players_header": "In this game: %d of %d"})
```

The invite sentence is two keys, `invite_sentence` and `invite_sentence_untitled`. The Join box finds the code in a pasted sentence by the word
after its "code" marker, else by scanning from the end, so a reworded or translated sentence must keep the code as its last word or right
after the word "code" (a game title that looks like a code is never taken for one). A clickable `mygame://` link is not part of the menu.

Sentences about errors, removals and the connection check come from the library (`OneLobbyFriendly`, `OneLobbyDiagnose`, the room's
removal reasons), so they are reworded at their source.

## What each blueprint key switches

| Key | Effect on the menu |
|---|---|
| `ui.kind` | `drop-in` (the default for `godot-gdscript` and `godot-csharp`) is this menu; `generated` / `none` mean you draw your own |
| `players.identity: "anonymous"` | no name field |
| `players.maxNameLength` | the name is cut at this length |
| `hosting.server` / `hosting.lobbyServer` | Host and Join use the lobby server; without them a direct lobby with a Nostr code. Browse needs a server. |
| `lobby.approveJoins` | the host sees Let in / Refuse |
| `chat.text` | the lobby shows the chat box |
| `room.*` | countdown, auto start, spectators, late join, seat rules: the room layer's, shown as it runs |
| `diagnostics.showConnectionCheck` | false hides the Connection check button in Settings |
| `diagnostics.reportToHost`, `logSize`, `relayProbe` | applied to the client by `from_config` |

## For a controller of your own

`menu.gd` draws `OneLobbyMenuModel` (no nodes, takes its client by injection: `OneLobbyMenuModel.new(client)`, then `host()`, `join()`,
`toggle_ready()`, `start_game()`, `kick()`, `ban()`, `leave()`, ... and `changed`). Every node a controller may touch has a unique name
(`%HostButton`, `%RosterList`, ...); the list is the comment at the top of `menu.gd`, and `tests/menu_scene.gd` checks it. Roster, ban,
request and browse rows are built at run time inside `RosterList`, `BansList`, `RequestsList` and `BrowseList`.

C# (Godot, Unity, any .NET app) has the same model in `OneLobby.Core`: `MenuModel`, taking its `LobbyClient` by injection, with the
clipboard, the connection check and the direct routes as delegates (no engine types). Its calls that wait are `Task`s that never throw
(a failure is the Error screen), and it raises `Changed`, `GameStarted`, `ReturnedToLobby` and `Left`:

```csharp compile file=MenuModelUse.cs
using System;
using OneLobby;

public static class MenuModelUse
{
    public static async System.Threading.Tasks.Task Run(LobbyClient client)
    {
        var menu = new MenuModel(client) { Clipboard = text => Console.WriteLine("copied: " + text) };
        menu.Changed += () => Console.WriteLine("draw the " + menu.ScreenName + " screen");
        menu.GameStarted += lobby => Console.WriteLine("start the match with " + lobby.Room.Players.Count + " players");
        menu.SetName("Sam");
        menu.SetJoinText("Join my game in Fortress: code 7HQ 4K2");   // a pasted invite sentence works too
        await menu.JoinAsync();                                       // Connecting, then Lobby (or Error with a plain sentence)
        menu.ToggleReady();
        foreach (var row in menu.RosterRows()) Console.WriteLine(row.Name + " " + menu.RowMarks(row));
        menu.CopyInvite();
        client.Pump();                                                // every frame: the client must be pumped
    }
}
```

Differences from the GDScript model that a C# controller should know: the room calls throw `OneLobbyException` (the model turns the code
into the lobby note), a removal's `Reason` is always a sentence (the host's text, or the default of the code), and a server lobby migrates
its host, so "the host left" ends the session only in a direct lobby.

## Godot C#

The same menu, drawn by a C# script. `OneLobby.Core` has the engine-free `MenuModel` and `MenuText` (the same screens, decisions and
English text as the GDScript model; a test fails when the two text tables differ). The Godot controller is two files you copy into your
project, because Godot can only attach a C# script that is a source file of the game's own project (a class inside the `OneLobby.Godot`
NuGet package cannot be a scene's script): `clients/dotnet/demo-godot/addons/onelobby_menu/OneLobbyMenu.cs` and `OneLobbyMenu.tscn`.
The scene has the same node tree and unique names as `menu.tscn` (`tools/make-menu-scene.mjs` writes it from that file, and a test fails
when the two trees differ), so everything above under "What it shows", "Boot flags" and "Restyling" holds as written.

```csharp godot
public partial class Main : Node
{
    public override void _Ready()
    {
        var menu = GetNode<OneLobbyMenu>("OneLobbyMenu");
        menu.GameStarted += lobby => GD.Print($"start the match with {lobby.Room.Players.Count} players");
        menu.ReturnedToLobby += _ => GD.Print("end the match; the menu is showing the lobby again");
        menu.Left += () => GD.Print("the player left the lobby");
    }
}
```

| | |
|---|---|
| `GameStarted(lobby)`, `ReturnedToLobby(lobby)` | C# events (a `Lobby` is not a Godot type, so it cannot travel in a Godot signal); the menu hides itself on `GameStarted` when `AutoHideOnStart` is true (default) |
| `Left` | a Godot signal (`menu.Left += ...` or the editor) |
| `ConfigPath` (exported) | the blueprint to read when `Client` is not set; default `res://onelobby.json` |
| `Pump`, `AutoHideOnStart`, `BootFlags`, `InviteBase`, `Texts` (exported) | as `pump`, `auto_hide_on_start`, `boot_flags`, `invite_base`, `texts` above (`Texts` is a `Dictionary<string, string>` of `MenuText` keys) |
| `Client` | the `LobbyClient` the menu drives; default `LobbyClient.FromBlueprint(...)` over `GodotTransport` with `WithUserSettings()`. Set it before the menu enters the tree to use your own. |
| `HostOptions`, `JoinOptions`, `Route` | `LobbyOptions`, `RoomJoinOptions` and `MenuRoute` (`Auto`, `Direct`, `Server`), passed to `HostAsync` / `JoinAsync` |
| `HostDirect`, `JoinDirect` | optional: how to host and join a direct lobby (`client.HostDirectAsync(...)` and friends from `OneLobby.Direct`, which `OneLobby.Core` cannot reference). Without them a direct code or an `ip:port` shows the "no server" sentence. |
| `BootArgs`, `Model` | the command line the boot flags read (default `OS.GetCmdlineUserArgs()`), and the `MenuModel` being drawn |

The saved name reaches the lobby when the client's config name is empty or "Player" (what `FromBlueprint` with no name gives), because
a `LobbyClient` has no settable display name. The menu pumps the client itself; set `Pump = false` when your game pumps.

A runnable example is `MenuDemo.tscn` in `clients/dotnet/demo-godot` (the menu plus a few lines that show "In game" on `GameStarted`):

```
godot --path clients/dotnet/demo-godot res://MenuDemo.tscn -- --host --name=Sam
godot --path clients/dotnet/demo-godot res://MenuDemo.tscn -- --join=<code> --name=Ann
```

The headless layout check (the .NET build of Godot, no window, two menus on an in-memory network, no sockets) prints `MENU_OK`:

```
godot --headless --path clients/dotnet/demo-godot res://MenuDemo.tscn -- --menu-selfcheck
```

CI runs the model tests and the scene-tree test (`MenuModelTests`, `MenuSceneTests` in `OneLobby.Core.Tests`) but not that check, because
it needs the .NET build of Godot.

## Not in the menu yet

Changing max players, the password or the listing of a lobby that is already open (the room layer does not offer it), voice, name tags,
quick chat, and a scoreboard overlay.

Tests: `clients/gdscript/tests/menu.gd` (the model, with real peers on 127.0.0.1) and `tests/menu_scene.gd` (the scene at 1280x720 and
640x360, and the demo with `--host` / `--join`). For C#: `MenuModelTests` and `MenuSceneTests` in `clients/dotnet/OneLobby.Core.Tests` (the model on an
in-memory network; the two scenes' node trees) and the local `--menu-selfcheck` run (see "Godot C#").
