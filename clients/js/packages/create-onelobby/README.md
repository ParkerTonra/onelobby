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

## All templates

`create-onelobby --help` lists every flag (one per setting, plus `--set key=value`). `--dry-run` writes nothing (and downloads
nothing), `--json` prints one machine-readable result, `--into <dir>` adds to an existing project. `node-browser`,
`godot-csharp`, `unity` and `dotnet` are planned.

Zero runtime dependencies; Node 18 or newer. Design: `docs/design/blueprint.md` and `docs/design/one-shot.md` in the repository.
