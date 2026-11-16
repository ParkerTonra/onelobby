# Recipe: the player's saved multiplayer settings

Four settings belong to the player, not to the game: a name, a TURN relay line they pasted, the last join code and the
lobby server address. The client saves them on the player's machine and applies them as defaults, so a settings screen is
four fields and one `Save` call. Nothing leaves the machine except the values a call already sends (the name in the hello,
the relay entry in the peer link setup). The contract is `spec/settings.md`; shared test inputs are
`spec/vectors/settings.json`.

Snippets tagged `ts compile`, `csharp compile` and `gdscript compile` are checked by `docs/check-snippets.mjs`.

## 1. What is saved, where, and what overrides it

| Setting | What it is | Used as |
|---|---|---|
| `name` | the display name, cleaned like a room name (control and zero-width characters out, whitespace collapsed, 24 characters) | the name for host and join, when the game gives none |
| `relay` | the relay line the player pasted (`turn:relay.example.com:3478 alice s3cret`, see `docs/recipes/turn.md` section 5); saved only if the relay line parser accepts it | one more entry in this player's ICE list, after the host's |
| `lastCode` | the last code this player hosted or joined (cleaned like a pasted code) | nothing by itself: pre-fill the join field with it |
| `server` | the lobby server address (`wss://lobby.mygame.net/ws`; `https://` and a bare host are fixed up) | the lobby server, when neither the call nor `onelobby.json` gives one |

One entry per game id, one JSON object, in the key/value store the client already keeps the player id in:

| Platform | Default place |
|---|---|
| Browser | `localStorage`, key `onelobby.settings.<gameId>` |
| Node | the file path you pass (`settingsFile`), else memory (lasts one process) |
| Unity | `PlayerPrefs` (`PlayerPrefsStore`) |
| other C# | `OneLobbyConfig.SettingsFile` or `SettingsStore`, else memory |
| Godot C# | a file under `user://` (`GodotSettings`, `user://onelobby.json`) |
| GDScript | `client.store`, `user://onelobby.json` by default |

A corrupt or unreadable value reads as "no settings" and is replaced by the next save; fields this version does not know
are kept when it rewrites. Environment variables win over the saved value **for that run** and are never written back:

| Setting | Variable |
|---|---|
| `name` | `ONELOBBY_NAME` |
| `relay` | `ONELOBBY_RELAY` |
| `lastCode` | `ONELOBBY_LAST_CODE` |
| `server` | `ONELOBBY_LOBBY_SERVER` |

Browsers have no environment, so nothing is overridden there. A value that does not clean is ignored.

## 2. How the client applies them

- **Name.** An empty name (C#: empty or the default `"Player"`) takes the saved one. A blueprint with
  `players.identity: "anonymous"` gets none; `players.maxNameLength` clamps it.
- **Relay.** A valid saved line is appended to the ICE list for every route (lobby server, direct IP, Nostr, rejoin),
  after the host's entries and after any entry your own call passed; an identical entry is not added twice. A line that does
  not parse is skipped, with one warning that does not print it (JS `kit.on("warning")`, C# `client.Warning`, GDScript
  `client.warning`).
- **Server.** An empty `lobbyServer` (JS option `""`, C# the blueprint's no-server stand-in, GDScript `lobby_server = ""`) with
  no address in `onelobby.json` takes the saved one. `no_server` is raised only when all three are empty.
- **Last code.** Written after a successful host or join. A rejoin does not count.
- **An explicit argument always wins.** Switch a default off with `settings` in the options: `false` for all of them, or one
  switch each for `name`, `relay`, `server`, `lastCode`.

## 3. A settings screen

Show the relay masked: the address stays readable, the user name and the credential are `<hidden>`. The field then holds
text that is not a relay line, so save the relay only when the player changed it.

### JavaScript

```ts compile file=settings-screen.ts
import { OneLobby, type SettingsValues } from "onelobby";

// lobbyServer "" means "the server the player saved"; a Node game also passes settingsFile (a browser uses localStorage)
const kit = new OneLobby({ gameId: "com.you.game", netVersion: "1", lobbyServer: "", mode: "raw" });
kit.on("warning", (message) => console.info(message)); // a saved relay line that is not valid; never holds the line

export interface Fields {
  name: HTMLInputElement;
  relay: HTMLInputElement;
  server: HTMLInputElement;
  lastCode: HTMLInputElement;
  error: HTMLElement;
}

export function show(f: Fields): void {
  const saved = kit.settings.load();
  f.name.value = saved.name;
  f.server.value = saved.server;
  f.lastCode.value = saved.lastCode; // pre-fill the join field
  f.relay.value = kit.settings.maskedRelay(); // turn:relay.example.com:3478 <hidden> <hidden>
}

export function save(f: Fields): boolean {
  const patch: Partial<SettingsValues> = { name: f.name.value, server: f.server.value };
  if (f.relay.value !== kit.settings.maskedRelay()) patch.relay = f.relay.value; // untouched: still the masked text
  const result = kit.settings.save(patch); // an empty string clears a setting
  f.error.textContent = result.rejected.length ? `Not saved: ${result.rejected.join(", ")}` : "";
  return result.ok;
}

// host and join use the saved name, relay and server unless you pass your own
export const host = () => kit.host({ name: "My game", maxPlayers: 4 });
```

Switch a default off: `new OneLobby({ ..., settings: { relay: false } })` (or `settings: false`). Node:
`settingsFile: "settings.json"` keeps them across runs; `advanced.settingsStore` takes any `KeyValueStore`.

### C#

```csharp compile file=SettingsScreen.cs
using System;
using OneLobby;
using OneLobby.DataChannel;

public static class SettingsScreen
{
    // Blueprint.NoServer: no address of the game's own, so the saved one is used; SettingsFile keeps the settings between runs
    public static LobbyClient NewClient(string settingsFile) =>
        new LobbyClient(new OneLobbyConfig("com.you.game", "1", Blueprint.NoServer, SyncMode.Raw, DisplayName: "") { SettingsFile = settingsFile },
                        new DataChannelTransport());

    public static string Show(LobbyClient client, out string name, out string server, out string lastCode)
    {
        var saved = client.Settings.Load();
        (name, server, lastCode) = (saved.Name, saved.Server, saved.LastCode);
        return client.Settings.MaskedRelay(); // turn:relay.example.com:3478 <hidden> <hidden>
    }

    // null leaves a setting alone, "" clears it; Rejected names the fields that did not clean
    public static bool Save(LobbyClient client, string name, string server, string? newRelay)
    {
        var result = client.Settings.Save(name: name, server: server, relay: newRelay);
        return result.Ok;
    }

    // switch a default off: new OneLobbyConfig(...) { Settings = new SettingsOptions { Relay = false } }, or SettingsOptions.None
}
```

Unity: `OneLobbyRunner` keeps the settings in `PlayerPrefs` (`PlayerPrefsStore`) unless `OneLobbyConfig.SettingsStore` or
`SettingsFile` is set in `ConfigureConfig`; leave its `LobbyServer` field empty to use the player's saved server.
Read and write them through `runner.Client.Settings`. Godot C#: `config.WithUserSettings()` (from `OneLobby.Godot`)
keeps them in `user://onelobby.json`, the file the GDScript client uses.

### GDScript

```gdscript compile file=settings_screen.gd
extends Control

@onready var client: OneLobbyClient = OneLobbyClient.new()


func _ready() -> void:
	client.game_id = "com.you.game"
	client.display_name = "" # empty (or "Player"): the saved name
	client.lobby_server = "" # empty: the saved server
	client.warning.connect(func(message: String) -> void: print(message)) # a saved relay line that is not valid
	add_child(client)
	var saved := client.settings.load_values()
	($Name as LineEdit).text = saved["name"]
	($Server as LineEdit).text = saved["server"]
	($Relay as LineEdit).text = client.settings.masked_relay() # turn:relay.example.com:3478 <hidden> <hidden>


func _on_save_pressed() -> void:
	var patch := {"name": ($Name as LineEdit).text, "server": ($Server as LineEdit).text}
	if ($Relay as LineEdit).text != client.settings.masked_relay():
		patch["relay"] = ($Relay as LineEdit).text # untouched: still the masked text
	var result := client.settings.save(patch) # {ok, rejected: ["relay"]}
	($Error as Label).text = "" if result["ok"] else "Not saved: " + ", ".join(PackedStringArray(result["rejected"]))
```

Switch a default off: `client.settings_use["relay"] = false`. The settings live in `client.store` (default
`user://onelobby.json`); `client.settings_env = {}` reads no environment (tests).

## 4. Never logged

No client writes the relay line, its user name or its credential to the net log, the console, an error message, a warning
or a signaling message. A rejected `save` names the field, never its text, and a lobby server address with `user:pass@`
is logged without that part (the net log mask hides `token=`). Do not log `settings.load()` yourself: use
`maskedRelay()` / `MaskedRelay()` / `masked_relay()`.

## 5. Tests

Give a test a memory store and a fixed environment so a settings file on the machine cannot change it: JS
`advanced: { settingsStore: memoryStore(), env: {} }`, C# `SettingsStore = KeyValueStores.Memory(), SettingsEnv =
PlayerSettings.NoEnvironment`, GDScript `client.store = OneLobbyStore.memory(); client.settings_env = {}`.

## Done when

- A name, a relay line and a server saved in one run are used by the next one with no code of yours, and a name you pass to
  the call wins over the saved one.
- The relay field shows `<hidden>` for the user name and the credential, and saving an invalid relay line is rejected by field.
- With `ONELOBBY_NAME=Ann` the game starts as Ann and the saved name is still the old one afterwards.
