# Recipe: the drop-in menu for Godot (GDScript and C#), Unity and the web

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
	# the menu already shows its PLAYING screen here: set your own role and "line is live" state FIRST, then attach the lobby to your session or panel
	# (a panel that refreshes on the roster and finds no live line calls menu.leave(), and both peers hang up)
	print("start the match with ", lobby.room.players().size(), " players")


func _on_back_in_lobby(_lobby: OneLobbyLobby) -> void:
	print("end the match; the menu is showing the lobby again")


func _on_left() -> void:
	print("the player left the lobby")
```

## What it shows

- **Start.** Name (cleaned with the room's name rules and saved), Host, Join (cleaned as typed; offers the last code; also takes a pasted invite sentence, a bare code, an `ip:port` or an invite link), Password,
  Browse (when a lobby server is set or LAN games are on, see "LAN games"), Settings.
- **Connecting.** What is being tried, and Cancel.
- **Lobby.** The code, large, with Copy code and Copy invite (the sentence `Join my game in <Game>: code 7HQ 4K2`, the game's `game.title`, or `Join my game: code 7HQ 4K2` with no title; when `invite_base` is set and the code is a lobby-server code, a space and the invite link follow); the roster
  (host mark, ready, watching, reconnecting, ping); a Ready toggle; for the host Start (everyone sees the countdown, the host can
  cancel it), Kick and Ban on every row with an optional reason, the ban list with Unban, the lobby settings the room layer lets the host
  change (start by itself, players needed, countdown, late join), and Let in / Refuse when the lobby asks to approve joins; text chat when
  `chat.text` is on; Leave. Against a host that has no room layer the lobby falls back to a plain peer list.
- **Removed / Error.** The sentence and the next step from `OneLobbyFriendly` and `OneLobbyDiagnose`, the code small underneath, Copy logs
  and Save logs (the net log, addresses masked), Back. A kicked or banned player reads the host's reason.
- **Settings.** The relay line (pasted, only ever shown masked, with its status), the lobby server, the Connection check (a one-line
  verdict and three facts) and Copy logs. The check runs by itself once, when the menu opens (see "The connection check on open"
  below), so this page is already filled in; the button runs it again.

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

With `boot_flags` on (default), `--host`, `--join=<code>`, `--name=<name>`, `--local` and `--autostart` after `--` act at once:

```
godot --path . -- --host --local --name=Sam                 # this PC only
godot --path . -- --join=<the code the host window shows> --local --name=Ann   # not a fixed port: another match on this PC may hold it
godot --path . -- --join=D1PB-1X9S-FPV --name=Ann           # a real code: the internet
```

The flags are read only after `--` (user args): a game that took a plain `--host` before now needs `-- --host`. A headless GDScript host prints one line, `OneLobby: hosting, join code <code>` (a Unity player logs `direct host listening ...; code <code>`), so a second headless copy joins by that code; start each with `timeout <seconds>` (`--quit-after` counts frames, not time) and `--log-file <path>` (redirected stdout is lost when a process is killed).
`--autostart` (the GDScript menu; the C# menu and Unity have it for the player layer only; Unity has no `StartOnHost` either: set `room.autoStart` to `"players"` in `onelobby.json` to start with no click) is for tests with no clicks: the host does what its Start button does, once, as soon as a second player is in the room, so `game_started` fires on both copies
(`OneLobbyMenuModel.apply_autostart()`; it works in every sync mode and needs no player layer). Start both copies with `--local --autostart` and read what the game prints from
its `game_started` handler.

`--local` makes the menu local (`OneLobbyMenuModel.apply_local()`): the direct route, the host listens on 127.0.0.1 only with Nostr off
and no public address (these keys win over `host_options` the game set; its other keys stay), and the connection check never runs by
itself. Without `--local` a game's own `route` and `host_options` are not touched. Never test a game with `--host` and no `--local`: it
opens a real port and reaches public relays. The GDScript menu needs no game code for it; the C# menu takes it from `OneLobbyNet.Wire`.

The process command line is read once per process. The first menu that is built takes `--host`, `--join=<code>`, `--name=<name>` and `--autostart`; every later menu in the same process (a game that builds one in each world, or after a scene change) acts on none of them, so it does not host or join a second time. `--local` is read by every menu. `boot_args` is never consumed: each menu that has it acts on it.

One switch (`boot_flags = false`) turns all five off: set it when the game reads flags of those names itself (the menu and the game would both act on `--host`), and call
`menu.model.host()`, `join()` or `apply_local()` yourself. The menu still reads `--local` on its own to keep the connection check off. Tests give the flags to a menu with `boot_args` instead of the process command line.

The host's `game_started` fires after the room's countdown (3 s by default, `room.countdown_seconds`), also with `start_on_host`: the world keeps ticking solo
meanwhile and the session attaches when the signal arrives. **Inside your own panel** give the menu a size: in a `Container` parent set
`menu.custom_minimum_size = Vector2(520, 460)` and the expand size flags before `add_child`; in a plain `Control` parent it fills the parent through its full-rect
anchors, so size the parent.

## A game that hosts from its running world

A game that opens a line from a world that is already running has no room and no Start of its own. The menu is the screen before the match: connect `game_started(lobby)` and attach the game's session there (the host over the world already up, a joiner starting its join session and keeping its solo world until the host's first snapshot). To skip the room step for the host, set `start_on_host = true` before `add_child` (`OneLobbyMenuModel.start_on_host`): after a successful Host the menu presses Start once, so `game_started` fires after the room's countdown (`host_options.room.countdown_seconds`). A joiner is not started by it. The menu hides during the match; a game that opens its own panel mid-match (F2, Esc) keeps its own roster and Leave plate for that.

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
| `hosting.server` / `hosting.lobbyServer` | Host and Join use the lobby server; without them a direct lobby with a Nostr code. The Online list in Browse needs a server. |
| `hosting.lan` (needs `hosting.direct`) | Browse gets a "LAN games" list, and a lobby the menu hosts direct answers LAN questions. Off: no list, no socket. |
| `lobby.approveJoins` | the host sees Let in / Refuse |
| `chat.text` | the lobby shows the chat box |
| `room.*` | countdown, auto start, spectators, late join, seat rules: the room layer's, shown as it runs |
| `diagnostics.showConnectionCheck` | false hides the Connection check button in Settings, and the check never runs by itself |
| `diagnostics.checkOnOpen` | false: the check runs only on the button (default true: once, when the menu opens) |
| `diagnostics.reportToHost`, `logSize`, `relayProbe` | applied to the client by `from_config` |

## LAN games

A game with `"hosting": { "direct": true, "lan": true }` in `onelobby.json` shows the games on the same local network in the menu,
and a click joins one. The library half is `docs/recipes/direct-ip.md` section 7b and `spec/lan-discovery.md`; this is what the menu
does with it. Typing the host's `ip:port` in the Join box keeps working in every game.

- **Where.** The Browse screen has two lists: the lobby server's ("Online") and "LAN games". With both available a two-button tab bar
  picks one, and the screen opens on the tab used last in this run (first time: Online). With only one available there is no tab bar,
  the list fills the screen and the title says which ("Online games" / "LAN games"). The start screen's Browse button shows when
  either is available. LAN is available when the blueprint has `hosting.lan` true and the client can open UDP; a game with no
  blueprint turns it on with the menu property `lan` (GDScript `lan`, Godot C# `Lan`, Unity `Lan`; default off).
- **Looking only while the list is shown.** The menu makes and starts the finder when the LAN list becomes the shown list and stops it
  (the socket closes, the object is dropped) when it stops being shown for any reason: the other tab, Back, a join, a game starting,
  the menu hidden or disabled, taken out of the tree or freed, the application closing. At any other time no finder and no socket exist.
- **Rows.** One per host, first seen first (the finder's order; not re-sorted): lobby name, host player's name, `2/4`, and
  "Needs a password" when one is needed. Names are shown as plain text, never markup. A host on another version stays listed,
  greyed, its Join disabled, with the sentence the menu already uses for a version mismatch ("You and the host are running different
  versions of the game."). A full lobby stays clickable: the join answers as it does today.
- **Sentences** (`MenuText` keys, the same in every menu): `lan_looking` (shown at once), `lan_empty` (after 3 seconds without a row;
  it says the host can also read out their address), `lan_socket_failed`, `lan_off` (LAN switched off in this game: the UI does not
  reach it, a finder that reports `off` shows it), `lan_row`, `lan_locked`, and the tab and title keys `browse_tab_online`,
  `browse_tab_lan`, `browse_title_online`, `browse_title_lan`.
- **Joining.** A click joins through the menu's own join path with `address:port`, as if typed. The start screen's password box is
  cleared whenever that screen opens and the Online list has no password field, so the LAN list has one password field
  (`BrowseLanPasswordEdit`) above its rows; what is typed there goes with the join.
- **The host side.** A lobby hosted from the menu answers LAN questions when the direct host it starts has the switch on: GDScript
  (`client.config.direct_options()`) and C# (`Blueprint.ToDirectHostOptions`, which the Unity menu uses itself and the Godot C# demo and
  the scaffolder's `OneLobbyNet` use) copy `hosting.lan`; with no blueprint the menu's `lan` / `Lan` is passed on (GDScript and
  Unity do it themselves; a Godot C# game passes `DirectHostOptions.Lan` in its own `HostDirect`). A menu that hosts on the lobby
  server (`hosting.server` true and not `--local`) hosts no direct lobby, so nothing answers.
- **`--local`.** A local-only menu (`--local`) gives the finder the single target `127.0.0.1`, so nothing is broadcast, and its own
  host listens on `127.0.0.1` only. To try it on one PC, open a host window and a second window of the same game, both with `--local`
  and `hosting.lan` on, and press Browse games in the second. The demos: GDScript
  `godot --path clients/gdscript res://examples/menu_demo/main.tscn -- --local --host --name=Sam` then
  `... -- --local --name=Ann`; Godot C# `godot --path clients/dotnet/demo-godot res://MenuDemo.tscn -- --local --host --name=Sam` then
  `... -- --local --name=Ann`. Both demos' `onelobby.json` have `hosting.lan` on.
- **Not in the web element.** A browser cannot send UDP, so `<one-lobby>` has no LAN list (the finder there reports `browser`).
- **Not proven.** Everything here ran over `127.0.0.1` only. Still unproven: a real broadcast on Wi-Fi or cable, a PC with several
  network cards, a router that blocks broadcast between clients, and whether Windows Firewall asks "allow this app?" for a game whose
  LAN list is opened or that hosts with the switch on.

## The connection check on open

Every drop-in menu (GDScript, Godot C#, the `<one-lobby>` element) runs the connection check once, the first time its start screen is
shown. It asks two public STUN servers one small UDP question each (the two every join already asks), plus the login of the player's
own relay line when one is saved, in at most 8 seconds; nothing else is contacted and nothing goes to OneLobby. The verdict fills the
Settings page. On the start screen the menu adds ONE line, the verdict sentence itself ("Direct connections: likely to fail. A relay is
recommended."), and only when the check found a problem (direct connections likely to fail, UDP blocked, a relay that refuses the login
or does not answer). While it runs, and when all is well, the start screen says nothing. Hosting and joining are never delayed.

- Switch it off for a game: `"diagnostics": { "checkOnOpen": false }` in `onelobby.json` (the button stays). `showConnectionCheck: false`
  hides the button and the automatic run both.
- Not again when the player comes back from a lobby or from Settings; the button runs it on demand.
- A headless run (the display server is `headless`: `--headless`, a game's own tests, a server) never runs it by itself either (`OneLobbyMenuModel.headless`, set from the display server; a test that wants the check sets `headless_default` false before building the menu), so a game's own headless tests that build the menu reach no STUN server.
- A menu started with `--local` (127.0.0.1 only, see Boot flags) never runs it by itself. The menu reads `--local` from the
  command line itself (`OneLobbyMenuModel.args_say_local`, also when `boot_flags` is off), so the order of your own start-up code does not matter.
- Tests: give the menu a fake runner (`check_runner` / `CheckRunner` / the controller's `checkRunner`); a test that opens a real menu
  without one, and without `checkOnOpen: false`, would contact the public STUN servers.
- Your own controller: call the model's `start_shown()` / `StartShown()` / `startShown()` whenever you draw the start screen and show
  `start_check_line()` / `StartCheckLine` / `startCheckLine` when it is not empty.

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
| `HostOptions`, `JoinOptions`, `Route` | `LobbyOptions`, `RoomJoinOptions` and `MenuRoute` (`Auto`, `Direct`, `Server`), passed to `HostAsync` / `JoinAsync`. A menu started with `--local` stays on `Direct` |
| `HostDirect`, `JoinDirect` | optional: how to host and join a direct lobby (`client.HostDirectAsync(...)` and friends from `OneLobby.Direct`, which `OneLobby.Core` cannot reference). Without them a direct code or an `ip:port` shows the "no server" sentence. |
| `BootArgs`, `Model` | the command line the boot flags and `--local` are read from (default `OS.GetCmdlineUserArgs()`), and the `MenuModel` being drawn |

The boot flags are applied right after the scene's `_Ready` calls, not inside the menu's own: a scene script that sets `HostDirect` /
`JoinDirect` in its `_Ready` (the scaffolder's `OneLobbyNet.Wire(menu, args)`) is in time, with `BootFlags` left on. `--local` is read
whatever `BootFlags` says: the menu then never hosts through a lobby server and never runs the check on open, and with no `HostDirect`
`--host --local` ends on the "no server" sentence instead of leaving this PC.

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

## Unity

The same menu for Unity 6, drawn by one component with UI Toolkit controls built in code: no prefab, no scene object, no asset to create,
no event system to add, and no package besides `com.onelobby.unity` (UI Toolkit is a built-in module). It draws the engine-free
`MenuModel` and takes every string from `MenuText`, so "What it shows", "Boot flags" and the blueprint table above hold as written.

**One-step install**, in an otherwise empty scene (or add the component in the Inspector):

```csharp unity
using OneLobby;
using OneLobby.Unity;
using UnityEngine;

public sealed class Boot : MonoBehaviour
{
    void Awake()
    {
        var menu = new GameObject("Menu").AddComponent<OneLobbyMenu>();
        menu.GameStarted += lobby => Debug.Log("start the match with " + lobby.Room.Players.Count + " players");
        menu.ReturnedToLobby += _ => Debug.Log("end the match; the menu is showing the lobby again");
        menu.Left += () => Debug.Log("the player left the lobby");
    }
}
```

The menu finds an `OneLobbyRunner` in the scene or adds one (the runner owns the `LobbyClient` and pumps it; the menu pumps only a lobby the
runner does not hold, so nothing is pumped twice). **The blueprint** is the `Blueprint` TextAsset field when set, else
`Assets/Resources/onelobby.json` (found with no Inspector step). With neither, the menu logs one warning and works with direct lobbies only
(Host gives a join code, no server). Host and Join of a direct lobby are wired to the runner by the menu itself (nothing to write); a lobby-server
code goes through the blueprint's server. `--local` does the whole job inside the menu: no automatic check, the direct route, and a host that
listens on 127.0.0.1 only with Nostr and the router request off.

| | |
|---|---|
| `GameStarted(lobby)`, `ReturnedToLobby(lobby)`, `Left` | C# events; the menu hides itself on `GameStarted` when `AutoHideOnStart` is true (default) |
| `Blueprint` (TextAsset), `Pump`, `AutoHideOnStart`, `BootFlags`, `InviteBase` | fields (Inspector or code), as in the Godot C# table; `BootFlags` covers `--host`, `--join=<code>`, `--name=<name>`; `--local` is always read |
| `Texts` (`Dictionary<string,string>`), `TextOverrides` (Inspector list) | rewording, `MenuText` keys |
| `StyleSheets`, `PanelSettings`, `SortingOrder` | restyling (below) |
| `Client`, `Runner`, `Model` | the `LobbyClient` the menu drives (default the runner's; set `Client` before the first frame to use your own, then set `HostDirect` / `JoinDirect` too if you want direct lobbies), the runner, and the `MenuModel` being drawn |
| `HostOptions`, `JoinOptions`, `Route`, `HostDirect`, `JoinDirect` | as in the Godot C# table (`HostDirect` / `JoinDirect` default to the runner's direct calls) |
| `BootArgs`, `CheckRunner` | the command line the flags are read from (default the process command line), and the connection check (a test gives a fake) |
| `ControlNames`, `Root`, `Q(name)`, `Q<T>(name)`, `FocusedControl`, `IsShown`, `LeaveAsync()` | the control tree and its state |

Set `Client`, `CheckRunner`, `BootArgs` and the options before the first frame (the menu builds itself in `Start`). Every control has the name of its
Godot unique name (`StartPage`, `NameEdit`, `HostButton`, `JoinEdit`, `RosterList`, `ReadyButton`, `ErrorPage`, ...: `OneLobbyMenu.ControlNames`,
the list at the top of the Godot controller). No Godot name lacks a Unity control; the types differ (`NameEdit` is a `TextField`, `MinPlayersSpin`
an `IntegerField`, `AutoStartOption` a `DropdownField`, `LateJoinCheck` a `Toggle`, `LobbySettingsToggle` a `Button`, `ChatLog` a `Label` in a scroll
view), and `Pages` (the container of the six pages) is listed too.

**Keyboard and gamepad.** Tab and the gamepad's navigation move through the controls in the order of the screen; Enter submits the screen's action
(the Join box joins, the chat line sends, the relay and server lines save); Escape and the gamepad's cancel button go back one screen exactly as
`MenuModel.Back()` decides; focus lands on a sensible control when a screen opens. The menu reads no `UnityEngine.Input`, so it works with the old
Input Manager, the new Input System or both: UI Toolkit takes its input from the engine, and the game adds no event system.

**Size.** The stock panel scales with the screen from an 800x450 reference (the same layout at 640x360 and at 4K) and every page scrolls when it is
taller than the screen. It draws above everything at sorting order 1000.

**Restyling.** The look is Unity's default runtime theme plus one small style sheet (`Resources/OneLobbyMenu.uss`: spacing, a dark backdrop, two
larger font sizes). Add your own USS to `StyleSheets` (it comes after the stock one, so the same selectors win) and style by control name
(`#HostButton`) or class (`.onelobby-title`, `.onelobby-code`, `.onelobby-row`), or give the menu your own `PanelSettings` with your own theme.
The `ui.theme` of the blueprint is for the web element and does not apply here.

**Rewording.** `menu.Texts = new Dictionary<string, string> { ["host"] = "Create game" }` before the first frame (or `TextOverrides` in the
Inspector), keys as in `MenuText.Table`. The menu undoes its override when it is destroyed, so nothing static stays behind when Unity enters
Play mode without reloading the domain.

**Sample.** The package sample `Menu` (one script) adds the menu and a label that says "In game" on `GameStarted`; run it with `--host --name=Sam`
and `--join=<code> --name=Ann`.

**What is checked where.** Unity is not in CI (no licence there), so no pull-request check compiles or runs any of it. The proof is local:
`OneLobbyMenuTests` (`clients/unity/com.onelobby.unity/Tests/Runtime`), in the editor in batchmode, Play mode, no window:

```
Unity -batchmode -nographics -projectPath <project> -runTests -testPlatform PlayMode -testFilter OneLobby.Unity.PlayTests -testResults <xml> -logFile <log>
```

Two menus share one `InMemoryNetwork` (no socket, no firewall prompt; every menu has a counted fake connection check). It covers host, join by
code, roster marks, ready, countdown, start, back to the lobby, kick with a reason, ban, a refused rejoin, unban, chat, the masked relay line, the
bad-code error screen, Escape on every screen, boot flags, the connection check on open and `--local`, every named control with a size at 1280x720
and 640x360 (the panel renders to a RenderTexture of that size), and that no static state or listener is left after the menu is destroyed; the main
test logs `MENU_OK`. Not checked: how it looks on a screen, a real key or gamepad press, and the Input System setting of the project.

## Not in the menu yet

Changing max players, the password or the listing of a lobby that is already open (the room layer does not offer it), voice, name tags,
quick chat, and a scoreboard overlay.

Tests: `clients/gdscript/tests/menu.gd` (the model, with real peers on 127.0.0.1) and `tests/menu_scene.gd` (the scene at 1280x720 and
640x360, and the demo with `--host` / `--join`). For C#: `MenuModelTests` and `MenuSceneTests` in `clients/dotnet/OneLobby.Core.Tests` (the model on an
in-memory network; the two scenes' node trees) and the local `--menu-selfcheck` run (see "Godot C#").

## Web: the `<one-lobby>` element

The same menu for a web page. One tag, the `onelobby/ui` import (or the `<script>` build), no code:

```html
<one-lobby server="https://your-name.onrender.com" game="my-game" max-players="4" countdown="3"></one-lobby>
```

It draws the same screens as the Godot menu. `docs/no-code.md` is the guide for people who paste HTML; this section is the reference.

| Screen | What it has |
|---|---|
| Start | Name (saved; hidden by `name="..."` or a blueprint with anonymous players), Host, a Join box that takes a bare code, a direct code, an `ip:port`, an invite link or a pasted invite sentence (`Join my game in <Game>: code 7HQ 4K2`; it finds the code, never the game title), the last code as its default, an optional password, Browse (only when a lobby server is known and the blueprint uses one), Settings. |
| Connecting | What is being tried, and Cancel (a late answer is ignored; a lobby that still arrives is left). |
| Lobby | The code with Copy code, Copy invite (the sentence, then the invite link) and Copy invite link; the roster with marks (Host, Ready, Watching, Reconnecting, ping where measured, "(you)"); a Ready toggle; for the host Start (everyone sees the countdown; Cancel start), Kick and Ban on every row with an optional reason, the ban list with Unban, the lobby settings the room layer offers (start by itself, players needed, countdown seconds, late join), Let in / Refuse when joins need approval, Back to lobby while a game runs; text chat (last 100 lines) unless the blueprint turns it off; a plain-list note against a host with no room layer. |
| Removed / error | A title, the plain sentence (a kick or ban shows the host's reason, or the default sentence of the code), the hint, the stable code, Try again (not after a removal), Back, Copy logs and Save logs (a file download; addresses are hidden). |
| Settings | The relay line (saved, then shown only masked: `turn:host:3478 <hidden> <hidden>`; the typed line is cleared on save and never read back), the lobby server (a page that sets `server=` keeps its own; the saved one is the fallback), the connection check (a verdict line and three facts; it runs only when the button is pressed), Copy logs. |
| Browse | Listed lobbies from the lobby server with Join, Refresh, and the empty and failure texts. No LAN list: a browser cannot send UDP. |

Escape goes back one screen (`ui_cancel`): settings and browse to start, an error or a connecting screen to start, a lobby leaves it.
Enter submits the Join box, the chat line, the relay line and the server line. Focus moves to a sensible control when a screen
opens (the name box or Host, Cancel, Ready, Try again, the relay box, the first Join).

**Attributes** (existing ones unchanged): `server`, `game`, `version`, `max-players`, `name`, `theme`; new and optional: `countdown`
(seconds between Start and the game; default 0, which starts at once as before; the host can change it in the lobby settings),
`approve-joins` (a private lobby: the host answers each join), `invite-base` (the address the invite sentence's link opens, default the
current page), `invite-param` (the query key, default `join`).

**Properties and methods** (existing ones unchanged): `isHost`, `players`, `code`, `state`, `shared`, `send()`, `host()`, `join(code)`,
`start()`, `leave()`; new: `screen` (`start`, `connecting`, `lobby`, `playing`, `error`, `settings`, `browse`; `state` keeps its five
values and stays `idle` under settings and browse), `back()` (what Escape does), `texts` (reword, below), `blueprint` (a parsed
`onelobby.json`: it switches chat, join approval, names, the connection check and adds the game title to the invite sentence).

**Events** (all bubble; `event.detail` carries the data): `message`, `player-joined`, `player-left`, `start`, `error`, `shared-change` as
before; new: `chat` (`{ from, text }`), `removed` (`{ code, reason, ban }`, then `error`), `lobby-return` (the host sent everyone back
to the lobby).

**CSS parts** (`::part(...)`; `card` is the old one): `title`, `status`, `hint`, `name-label`, `name-input`, `host-button`, `join-form`,
`join-input`, `password-label`, `password-input`, `join-button`, `browse-button`, `settings-button`, `cancel-button`, `codebox`, `code`,
`copy-code-button`, `copy-invite-button`, `copy-link-button`, `countdown`, `players-title`, `roster`, `roster-row`, `roster-name`,
`mark` (and `mark-host`, `mark-ready`, `mark-spectator`, `mark-reconnecting`, `mark-you`), `ping`, `kick-button`, `ban-button`,
`reason-label`, `reason-input`, `requests`, `request-row`, `let-in-button`, `refuse-button`, `plain-note`, `note`, `ready-button`,
`start-button`, `cancel-start-button`, `back-to-lobby-button`, `leave-button`, `lobby-settings`, `setting-input`, `bans`, `ban-row`,
`unban-button`, `chat`, `chat-log`, `chat-line`, `chat-form`, `chat-input`, `chat-send-button`, `error-code`, `retry-button`,
`back-button`, `copy-logs-button`, `save-logs-button`, `log-note`, `relay-form`, `relay-input`, `relay-status`, `save-relay-button`,
`clear-relay-button`, `relay-note`, `server-form`, `server-input`, `save-server-button`, `server-note`, `check`, `check-button`,
`check-verdict`, `check-facts`, `check-fact`, `browse-status`, `browse-list`, `browse-row`, `browse-join-button`, `refresh-button`.

**Rewording.** Every string comes from one table with the same keys and English as the Godot menu (`menu_text.gd`; a test fails when the
two differ) plus a few web-only keys (`status_*`, `copy_link`, `back_to_lobby`, `retry`, ...; `MENU_TEXT_WEB` in `onelobby/ui`). Set
`texts` to a table of your own keys:

```html
<script type="module">
  await customElements.whenDefined("one-lobby");
  document.querySelector("one-lobby").texts = { host: "Create game", join: "Enter game", status_idle: "Pick a way in." };
</script>
```

A value may hold `%s` and `%d` (filled in order; `%%` is a percent sign). A reworded invite sentence must keep the code as its last word
or right after its "code" marker, so the Join box can read it back. Error and removal sentences come from `describeError` and the room
layer, not from this table.

In code, `LobbyController` (also exported from `onelobby/ui`) is the element's model with no DOM: `roster()`, `toggleReady()`,
`startGame()`, `kick(id, reason)`, `ban()`, `unban(key)`, `setLobbySetting(key, value)`, `approve(id, ok)`, `sendChat(text)`,
`openSettings()`, `saveRelay(line)`, `runCheck()`, `openBrowse()`, `inviteText()`, `back()`, and `parseJoin(text)` for the Join box.
Tests: `test/ui-menu.test.ts` (the model on the in-memory network) and `test/ui-element.test.ts` (the element in a DOM emulation).
