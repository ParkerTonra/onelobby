# Player settings (`settings` v1): the player's own multiplayer settings, saved on their machine

Four settings that belong to the player, not to the game: a name, a relay line, the last join code and a lobby server
address. Each client saves them in the key/value store it already has for the player id (`spec/room.md` s.1) and applies
them as defaults, so a menu has nothing to build but four fields. Nothing here changes the wire: a setting leaves the
machine only as the value a call already sends (the name in `hello`, the ICE entry in the peer link setup).

JS, C# (including the Unity and Godot C# surfaces) and GDScript implement this file and must match
`spec/vectors/settings.json` exactly. Words in **(decision)** go beyond what `docs/design/one-shot.md` s.3 item 4 fixed.

Contents: 1 the settings, 2 storage, 3 environment override, 4 masking and "never logged", 5 how a client applies them,
6 API names, 7 vectors.

## 1. The settings

| Field | Meaning | Cleaning (`clean`) |
|---|---|---|
| `name` | the player's display name | Name rules steps 1-3 of `spec/room.md` s.4.1 (strip control, bidi and zero-width characters, collapse whitespace, trim, clamp to 24 code points). A result of `Player` exactly counts as no name. |
| `relay` | the raw relay line the player pasted | Trimmed. Empty = none. Otherwise valid only when the client's existing relay line parser accepts it (`parseTurnLine`, `TurnLogin.TryParse`, `OneLobbyTurn.parse_line`: `docs/recipes/turn.md` s.5; a parser warning does not make it invalid). The text is stored as pasted (inside, whitespace and newlines kept). |
| `lastCode` | the last code this player hosted or joined | The code rules a pasted code already gets (`normalizeCode`, `Crockford.Normalize`): upper-case, spaces and hyphens dropped, `I` and `L` read as `1`, `O` as `0`; valid when what is left is 6 Crockford characters (a lobby server code) or 11 (a direct join code). Stored without separators. Anything else, such as an `ip:port` address, is invalid. |
| `server` | the lobby server address | The server URL rule of the web drop-in (`lobbyServerUrl` in JS; **(decision)** C# and GDScript follow it so the three agree): trimmed; empty = none; no whitespace; not a placeholder (`your-server`, `your-lobby-server`, `replace-me`, or `<` `>` in it, any case); `http(s)://` becomes `ws(s)://`, a bare host gets `wss://`; the host (after any `user:pass@`) is a name or IP of letters, digits, `.`, `-`, `_` or a bracketed IPv6 literal, with a port from 1 to 65535 if given; not a documentation name (`example`, `example.com`, `.net`, `.org` or any `*.example`); a single word other than `localhost` is not a server. Path, query (`?token=...`) and `user:pass@` are kept as given. |

`clean(field, value)` returns the cleaned text, or "invalid". The empty string is always valid and means "none".
Cleaning never throws. A `name` that cleans to nothing is valid ("none").

## 2. Storage

One entry per game id in the existing key/value store, key `onelobby.settings.<gameId>` (like `onelobby.pid.<gameId>`),
value one JSON object (UTF-8 text):

```json
{ "v": 1, "name": "Sam", "relay": "turn:relay.example.com:3478 alice s3cret", "lastCode": "7HQ4K2", "server": "wss://lobby.mygame.net/ws" }
```

- A field with no value is left out. `v` is the format version: kept as found when it is an integer, else written as 1.
- **Read** (`load`): parse the value; anything that is not a JSON object (missing, unreadable, corrupt text, an array)
  reads as "no settings" with all four fields empty. Each field is then cleaned; a field of the wrong type or one that
  does not clean reads as empty. A read never throws and never reports an error to the player.
- **Write** (`save(patch)`): read the stored object again (a corrupt one counts as `{}`), set or remove each field in
  the patch (an empty value removes it), keep every unknown field exactly as it was, write the object back. A field in
  the patch that does not clean is not written; `save` reports which fields were rejected (a menu shows "That is not a
  relay line" next to the field) and the other fields are still written. A store that cannot write is not an error:
  the settings last for the session.
- Default store per platform: browser `localStorage`; Node the file path the game passes (`settingsFile`; a JSON file
  `{ key: value }` like `playerIdFile`), else memory; Unity PlayerPrefs; other C# a JSON file the game passes, else
  memory; Godot (GDScript and C#) the `user://onelobby.json` store (`OneLobbyStore`; Godot C# a file under `user://`).
  A game can pass any store of its own.
- Tests use a memory store or a temp path, never the player's real one.

## 3. Environment override

Per setting one environment variable. A non-empty value, once cleaned, wins over the stored value for that run, and is
never written to the store. A value that is empty, unset or does not clean is ignored, and the stored value is used.

| Setting | Variable |
|---|---|
| `name` | `ONELOBBY_NAME` |
| `relay` | `ONELOBBY_RELAY` |
| `lastCode` | `ONELOBBY_LAST_CODE` |
| `server` | `ONELOBBY_LOBBY_SERVER` |

(`ONELOBBY_SERVER` is not used: the test suites already read it to find a real server.) The variables are read by Node
(`process.env`), C# (`Environment.GetEnvironmentVariable`) and GDScript (`OS.get_environment`). A browser has no
environment, so nothing is overridden there. `effective()` is stored-with-environment; `load()` is the stored values only.
A game can hand a client a fixed map of variables instead (tests do), or switch the environment off.

## 4. Masking and "never logged"

`masked(relay)` is the view for a settings field that shows the relay without exposing it:

- valid line: the URLs joined by `,`, then ` <hidden>` for the user name if there is one, then ` <hidden>` for the
  credential if there is one. So `turn:relay.example.com:3478 alice s3cret` shows as
  `turn:relay.example.com:3478 <hidden> <hidden>`; a JSON line with two URLs shows both, comma-joined; a `stun:` line
  has nothing to hide and shows as is.
- empty: empty. A non-empty line that does not parse: `<hidden>` alone.
- The marker is the one of the net log mask (`spec/diagnostics.md` s.6): `<hidden>`.

A client never writes the relay line, its user name or its credential (or any part) to the net log, the console, an
error message, a warning, a signaling message or a diagnostics report. The only place they go is the ICE entry the peer
link is created with. A rejected `save` names the field, never its text. The skipped saved relay (section 5) warns with
the fixed text `The saved relay line is not valid, so it is not used.` The lobby server address may hold `?token=` or
`user:pass@`: it is logged only through the net log mask (`token=` is hidden there; **(decision)** a client also drops a
`user:pass@` part before it puts an address in the log).

## 5. How a client applies them

Each default can be switched off (`settings` option; one switch per setting, `name`, `relay`, `server`, `lastCode`, or
all at once), and an explicit argument always wins over a saved or environment value.

1. **Name.** When the game gives no name (empty; **(decision)** in C# and GDScript the default `Player` counts as empty too, as in
   room name rule 5), the effective `name` is the name for host and join. The game's name, when it gives one, wins. A blueprint with `players.identity: "anonymous"` gets no saved name; `players.maxNameLength`
   clamps it.
2. **Relay.** When the effective `relay` is valid, its entry is appended to this player's ICE list exactly as
   `docs/recipes/turn.md` s.5 "How it combines" says: after the host's `welcome` list on a join, and after any entries
   the player's own host or join call carried; an identical entry already in the list is not added twice. It applies to
   every route (lobby server, direct IP, Nostr, rejoin). An invalid relay line (stored or environment) is skipped, and the
   client warns once per client object with the fixed text of section 4 (JS: `warning` event, plus the net log
   as an `info` line; C#: `Warning` event; GDScript: `warning` signal and `push_warning`).
3. **Server.** When neither the call nor `onelobby.json` (`hosting.lobbyServer`) gives a lobby server address (JS: an empty
   `lobbyServer`; C#: the blueprint's `Blueprint.NoServer` stand-in, and the Unity runner's empty `LobbyServer` field;
   GDScript: an empty `lobby_server`), the effective `server` is used. Anything the call or the file gives wins, so `no_server` is only raised when all three
   are empty.
4. **Last code.** After a successful host or join (server lobby, direct IP or Nostr; a rejoin does not count), the
   client saves the code (`lobby.code`, or the direct lobby's join code) as `lastCode`. A code that does not clean is not
   saved. The client never joins by `lastCode` on its own: a menu may pre-fill its code field with it.

## 6. API names

| | JS | C# | GDScript |
|---|---|---|---|
| object | `kit.settings` (`PlayerSettings`) | `client.Settings` (`PlayerSettings`) | `client.settings` (`OneLobbySettings`) |
| stored values | `load()` | `Load()` | `load_values()` (keys `name`, `relay`, `last_code`, `server`) |
| with environment | `effective()` | `Effective()` | `effective()` |
| save a patch | `save({ name, relay, lastCode, server })` -> `{ ok, rejected: string[] }` | `Save(name:, relay:, lastCode:, server:)` -> `SaveResult` (null = leave alone) | `save({name, relay, last_code, server})` -> `{ok, rejected}` |
| forget | `clear()` | `Clear()` | `clear()` |
| masked relay (of the effective line) | `maskedRelay()` | `MaskedRelay()` | `masked_relay()` |
| warning | `kit.on("warning", fn)` | `client.Warning` | `client.warning` signal |
| pure helpers | `cleanName` `cleanRelay` `cleanLastCode` `cleanServer` `maskRelay` | `SettingsRules.CleanName` ... | `OneLobbySettings.clean_name` ... |
| switch a default off | `new OneLobby({ settings: { name: false } })`, `settings: false` | `config with { Settings = new SettingsOptions { Name = false } }`, `SettingsOptions.None` | `client.settings_use["name"] = false` |
| store | `settingsFile`, `advanced.settingsStore` | `SettingsFile`, `SettingsStore` | the client's `store` |
| fixed environment (tests) | `advanced.env` (`null`: none) | `SettingsEnv` (`PlayerSettings.NoEnvironment`) | `client.settings_env` (`{}`: none) |

## 7. Vectors

`spec/vectors/settings.json`: `key` (the store key), `clean` (per field: input, expected text or `invalid`), `mask`
(a relay line and its masked view), `load` (stored text and what it reads as), `save` (stored text, a patch, the object
that must then be stored and the rejected fields), `env` (stored object, a variable map, the `effective` result). Every
client runs every case.
