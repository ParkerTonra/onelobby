# create-onelobby

Scaffold a multiplayer game with [OneLobby](https://github.com/ParkerTonra/onelobby): a browser game (`web`) or a Godot 4
GDScript game (`godot-gdscript`).

## Web

```
npm create onelobby@latest my-game -- --template web --yes
cd my-game && npm start      # the game; set the lobby server in the page or in onelobby.json
npm test                     # two players, a message each way (in-memory; LOBBY_SERVER=ws://... uses a real server)
```

It writes `onelobby.json` (the blueprint: every multiplayer setting, with a description per key in its schema), the glue
that reads it at runtime, a starter game and the test. Edit `onelobby.json` by hand and reload: no rebuild.

## Godot 4 GDScript

A new project, or add to the one you have:

```
npx create-onelobby my-game --template godot-gdscript --yes
cd my-game
godot --headless --import --path .                                              # once: registers the WebRTC extension and the add-on's classes
godot --headless --audio-driver Dummy --path . -s res://tests/multiplayer.gd    # MULTIPLAYER_OK
godot --path . -- --host --local --name=Sam                                     # play; a second window: -- --join=127.0.0.1:47810 --local --name=Ann

npx create-onelobby --into path/to/your-godot-project                           # an existing GDScript project (a folder with project.godot)
```

What it installs (the same for both, except the main scene):

- `addons/onelobby/`: the GDScript add-on, copied from the copy bundled in this package (no network for the scripts), with
  `addons/onelobby/PIN.json`: the create-onelobby version, the OneLobby commit it came from, the webrtc-native version and a
  SHA-256 per file, so an untouched add-on can be told from an edited one (`verifyPin` in `src/vendor.js`).
- `addons/godot_webrtc/`: Godot's WebRTC extension (webrtc-native 1.2.2-stable, about 35 MB). It is downloaded anonymously from
  the godotengine GitHub release and its SHA-256 is checked against a pinned value before anything is unpacked. It is not
  committed (`.gitignore`); run the same command again on a fresh clone to get it back.
- `onelobby.json` (engine `godot-gdscript`, `ui.kind` `drop-in`), the autoload `Net` (`net.gd`, registered in `project.godot` in place),
  `tests/multiplayer.gd` (two peers in one process on 127.0.0.1: host, join by code, a message each way), `.olc/<name>.json`
  (a host window and a small joiner window), and a managed block in `.gitignore` and `.gitattributes` (keeps the add-on LF).
- New project only: `project.godot`, `main.tscn` + `main.gd` (the drop-in menu, and a label that shows the roster on
  `game_started`), `AGENTS.md`.

`--into` never touches your main scene: it prints the three lines that add the menu scene. Files that already exist are
skipped and listed (`--force` overwrites them); a second run changes nothing and says so. A folder with a `.csproj` or `.sln`
beside `project.godot` is a Godot C# project: `template_planned`.

| Flag | Meaning |
|---|---|
| `--addon-from <folder>` | vendor the add-on from a OneLobby checkout (or its `clients/gdscript`, or the add-on folder) instead of the bundled copy |
| `--webrtc-zip <file>` | install the natives from this webrtc-native zip: offline |
| `--webrtc-dir <folder>` | the same from an unpacked add-on folder (the one with `webrtc_native.gdextension`) |
| `--no-natives` | skip the natives; the output prints the command that fetches them later (`--into . --template godot-gdscript`) |

Errors (`--json` gives `{ ok: false, error: { code, message } }`): `autoload_taken` (`project.godot` already has `Net` pointing
elsewhere), `not_godot_project`, `template_planned`, `bad_addon_from`, `bad_zip`, `bad_webrtc`, `download_failed`,
`bad_download`, `addon_missing`.

Godot needs one import run after the natives are in place: `godot --headless --import --path .` (it writes
`.godot/extension_list.cfg` itself; there is nothing to commit for it). Recipe: `docs/recipes/godot-gdscript.md`.

## update

`npx create-onelobby update [dir | --into <dir>]` (default: the current folder) brings a game's add-on up to the one bundled in this
package (or `--addon-from <folder>`).

- `godot-gdscript`: it reads `addons/onelobby/PIN.json` first. An untouched add-on is replaced file by file (changed, added and
  removed files are listed) and `PIN.json` is rewritten. A locally edited, added or missing add-on file stops it with the list
  (exit 1, `local_changes`) unless `--force`, which overwrites the edited, restores the missing, keeps what you added, and says
  what it did. Nothing outside `addons/onelobby/` changes except the managed `.gitignore` / `.gitattributes` blocks and, when the
  natives version pinned by this create-onelobby differs from the one in `PIN.json` or `addons/godot_webrtc/` is gone, the natives
  (a checked download, `--webrtc-zip`, `--webrtc-dir`, or `--no-natives`). No `PIN.json`: error `no_pin`, which names `--into` as
  the way to adopt the project. Already current: it says so, exit 0, nothing written. It ends with the import command
  `godot --headless --import --path .` (new `class_name`s need it).
- `web`: the dependency is the `onelobby` npm package, so `update` prints the one `npm install onelobby@^<version>` line and
  whether `src/session.js` (or `multiplayer/session.js`) differs from this version's glue. It writes nothing and never runs npm
  (the glue is yours to edit).

Flags: `--addon-from`, `--webrtc-zip`, `--webrtc-dir`, `--no-natives`, `--force`, `--dry-run`, `--json`. Errors: `no_pin`,
`bad_pin`, `local_changes` (with `details: { edited, missing, added }` in `--json`), `not_a_project`, `no_such_dir`,
`template_planned`, plus the natives errors above. (A folder literally named `update` or `verify` is scaffolded as `./update`.)

## verify

`npx create-onelobby verify [dir | --into <dir>]` answers "does multiplayer work here" with no manual steps. It prints one
line per check (`ok` / `FAIL <why>` / `skipped <why>`) and a last line `VERIFY_OK` (exit 0) or
`VERIFY_FAIL <first failing check>: <what is wrong and the next step>` (exit 1). `--json` prints one object with the same facts.
A failed `godot`, `addon-pin`, `natives` or `blueprint` check makes the later ones `skipped`.

| Check (godot-gdscript) | What it proves |
|---|---|
| `godot` | the executable: `--godot <exe>`, else `$GODOT`, else `godot` on PATH (Godot 4.4 or newer); always run `--headless --audio-driver Dummy` |
| `addon-pin` | `addons/onelobby/` matches `PIN.json`; edited files are a warning on the line, not a failure |
| `natives` | the WebRTC natives are there and registered (it runs the headless import itself when `.godot/extension_list.cfg` is missing) |
| `blueprint` | `onelobby.json` loads through the JS loader and through the game's GDScript loader |
| `direct` | two peers on 127.0.0.1, host and join by code, a message each way (the game's `tests/multiplayer.gd`, else a bundled probe) |
| `nostr` | the same through a LOCAL Nostr relay on 127.0.0.1 (built in), when `hosting.nostr` is on |
| `turn` | relay-only through a LOCAL TURN server on 127.0.0.1 with a random login given as one pasted line; fails unless the TURN server saw allocations and relayed packets |
| `server` | host and join through a lobby server, only when `hosting.server` is on AND `--server http://127.0.0.1:<port>` is given (verify never starts the server); else `skipped` with the reason |

| Check (web) | What it proves |
|---|---|
| `blueprint` | `onelobby.json` loads through the real loader |
| `project-test` | the game's own `test/multiplayer.mjs` passes (in memory; needs `npm install` first) |
| `nostr`, `turn` | `skipped` by design: two JS clients over real WebRTC in Node need node-datachannel, which a web game does not depend on (tools/engine-smoke covers it) |

Flags: `--godot <exe>`, `--server <url>`, `--fetch-helpers`, `--json`. Everything binds 127.0.0.1 on free ports, no window opens,
nothing it started outlives it (also on a failed check and on Ctrl+C), and it writes only inside the game folder
(`.onelobby/`, covered by the managed `.gitignore` block).

**Helpers.** The Nostr relay is built in (pure Node). The TURN server is the npm package `node-turn` (pinned), loaded only when
`verify` runs: from the game's own `node_modules` or from `.onelobby/helpers/`. Without it the `turn` check says
`skipped` and names the one command; `--fetch-helpers` installs it there (an anonymous npm download). Scaffolding never
downloads it, so `npm create onelobby` stays zero-dependency and offline-capable.

## All templates

`create-onelobby --help` lists every flag (one per setting, plus `--set key=value`). `--dry-run` writes nothing (and downloads
nothing), `--json` prints one machine-readable result, `--into <dir>` adds to an existing project. `node-browser`,
`godot-csharp`, `unity` and `dotnet` are planned.

Zero runtime dependencies; Node 18 or newer. Design: `docs/design/blueprint.md` and `docs/design/one-shot.md` in the repository.
