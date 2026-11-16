# create-onelobby

Scaffold a multiplayer game with [OneLobby](https://github.com/ParkerTonra/onelobby): a browser game (`web`), a Godot 4
GDScript game (`godot-gdscript`) or a Godot 4 C# game (`godot-csharp`).

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

`--into` with no `--template` reads the folder: `project.godot` is Godot (C# when a `.csproj` / `.sln` sits beside it), `ProjectSettings/`
(with `ProjectVersion.txt`, or beside `Assets/`) is `unity` and a `.csproj` / `.sln` without `project.godot` is `dotnet` (both stop as
`template_planned`), a folder with `.html`, `.js` / `.ts` or a `package.json` is `web`, and anything else stops as `engine_unknown`
(pass `--template`; on a terminal it asks). A description that names the engine still picks it; `--template` always wins;
`engine.from` says `files` for what the folder told. The GDScript menu reads `--local` itself (the direct route, 127.0.0.1 only, no
Nostr), so `--host --local` is safe in any game that instances it with `boot_flags` on, with no game code.
A second `--into` run keeps a hand-edited `onelobby.json`: with `--recommend` it says `kept your onelobby.json; the recommendation was
not applied` (JSON: `recommendation.applied: []` and `recommendation.notApplied`); a web `--into` that stops with `exists` says the same.

A web `--into` also writes a minimal `package.json` (private, `"type": "module"`, the `onelobby` dependency) when the folder has none; an
existing one is never edited, and the "Next:" lines say what to add.

`--into` never touches your main scene: it prints the three lines that add the menu scene. Files that already exist are
skipped and listed (`--force` overwrites them); a second run changes nothing and says so. A folder with a `.csproj` or `.sln`
beside `project.godot` is a Godot C# project: see the next section (`--template godot-gdscript` on it is `wrong_template`).

| Flag | Meaning |
|---|---|
| `--addon-from <folder>` | vendor the add-on from a OneLobby checkout (or its `clients/gdscript`, or the add-on folder) instead of the bundled copy |
| `--webrtc-zip <file>` | install the natives from this webrtc-native zip: offline |
| `--webrtc-dir <folder>` | the same from an unpacked add-on folder (the one with `webrtc_native.gdextension`) |
| `--no-natives` | skip the natives; the output prints the command that fetches them later (`--into . --template godot-gdscript`) |

Errors (`--json` gives `{ ok: false, error: { code, message } }`): `autoload_taken` (`project.godot` already has `Net` pointing
elsewhere), `not_godot_project`, `wrong_template`, `bad_addon_from`, `bad_zip`, `bad_webrtc`, `download_failed`,
`bad_download`, `addon_missing`.

Godot needs one import run after the natives are in place: `godot --headless --import --path .` (it writes
`.godot/extension_list.cfg` itself; there is nothing to commit for it). Recipe: `docs/recipes/godot-gdscript.md`.

## Godot 4 C#

A new project, or add to the one you have. Use the .NET build of Godot 4.5 or newer (the standard build cannot run C#) and the .NET 8 SDK:

```
npx create-onelobby my-game --template godot-csharp --yes
cd my-game
dotnet build MyGame.csproj                                                      # restores the OneLobby packages and builds the game (the file is named: Godot also writes a .sln)
godot --headless --import --path .                                              # once: registers the WebRTC extension
godot --headless --audio-driver Dummy --path . res://tests/MultiplayerTest.tscn # MULTIPLAYER_OK
godot --path . -- --host --local --name=Sam                                     # play; a second window: -- --join=127.0.0.1:47810 --local --name=Ann

npx create-onelobby --into path/to/your-godot-csharp-project                    # an existing one (project.godot with a .csproj beside it)
```

A C# game takes OneLobby from NuGet, not from a vendored add-on: `OneLobby.Core`, `OneLobby.Godot` and `OneLobby.Direct` (host and join
without a server) are `PackageReference`s in the game's `.csproj`, at this create-onelobby's version. Only the menu is copied in, because
Godot can only attach a C# script that is a source file of the game's own project.

- `addons/onelobby_menu/`: `OneLobbyMenu.cs`, `.cs.uid` and `OneLobbyMenu.tscn`, from the copy bundled in this package, with `PIN.json`
  (the same guard as the GDScript add-on's: create-onelobby version, OneLobby commit, webrtc-native version, a SHA-256 per file).
- `addons/godot_webrtc/`: the same pinned, checked natives download as the GDScript template (`--webrtc-zip`, `--webrtc-dir`, `--no-natives`).
- `onelobby.json` (engine `godot-csharp`, `ui.kind` `drop-in`), `OneLobbyNet.cs` (gives the menu its `HostDirect` / `JoinDirect`: `OneLobby.Core`
  cannot reference `OneLobby.Direct`; reads `--local`, which listens on 127.0.0.1 only with no Nostr and no router request),
  `tests/MultiplayerTest.tscn` + `.cs` (two peers in one process on 127.0.0.1: host, join by address, a message each way; last line
  `MULTIPLAYER_OK` or `MULTIPLAYER_FAIL <why>`), `.olc/<name>.json` (builds, then a host window and a small joiner window, the same flags and
  port as the GDScript entry) and a managed block in `.gitignore` (also `bin/`, `obj/`) and `.gitattributes`.
- New project only: `<Name>.csproj`, `project.godot` (C# feature, assembly name; the microphone setting when `chat.voice` is on), `Main.tscn` +
  `Main.cs` (the menu, `GameStarted` / `ReturnedToLobby` / `Left`, the wiring, the boot flags), `AGENTS.md`.

**The Godot.NET.Sdk version** of a new project's `.csproj` follows the .NET Godot that `--godot`, `$GODOT` or PATH names (a stable 4.5 or
newer: its editor refuses a game built against another version's GodotSharp), else `4.5.1`, the version the packages were built and tested
against. `--into` leaves the project's own SDK line alone.

**Where the packages come from.** The packages of a version are on the public registry only after its release, so before that a game cannot
restore them. `--packages-from <folder>` points the project at a folder of `.nupkg` files (`clients/dotnet/pack.sh <version> <folder>`;
every pack needs a new version, NuGet never re-reads one): the references get the version read from the file names (`OneLobby.Core`, `.Godot`
and `.Direct` must share exactly one) and a `nuget.config` takes `OneLobby.*` from that folder (written relative to the project) and everything
else from nuget.org. Without the flag the references are this create-onelobby's version and no `nuget.config` is written. A `nuget.config` that
create-onelobby did not write is left alone and listed (`--force` replaces it).

**The `.csproj` edit (`--into`).** The package references are added in place: after the last package reference of an unconditional
`ItemGroup` (else in a new `ItemGroup` before `</Project>`), in the file's own indentation and line endings, a BOM and every other byte kept.
References already there are left as they are (a different version is a note: `update` moves it). A second run changes nothing. It refuses
(`bad_csproj`, nothing written) a file that is not well-formed XML, whose root is not `<Project>`, that does not use `Godot.NET.Sdk`, that
targets below net8.0, a folder under central package management (`Directory.Packages.props`), a folder with a `.sln` but no `.csproj`, and
several `.csproj` files when `project.godot` does not name the game's (`dotnet/project/assembly_name`). The output prints the lines that add
`OneLobbyMenu.tscn` to your main scene and wire it (`OneLobbyNet.Wire(menu, OS.GetCmdlineUserArgs())`, then `menu.Model!.ApplyBootFlags(...)`);
the menu's `BootFlags` goes off in the inspector so the wiring comes first.

| Flag | Meaning |
|---|---|
| `--packages-from <folder>` | use the OneLobby packages from this folder of `.nupkg` files (writes `nuget.config`); with `update`, moves the references to that folder's version |
| `--godot <exe>` | (new project) the .NET Godot whose version picks the Godot.NET.Sdk line |
| `--addon-from <folder>` | vendor the menu from a OneLobby checkout (or `clients/dotnet/demo-godot`, or the menu folder) instead of the bundled copy |
| `--webrtc-zip`, `--webrtc-dir`, `--no-natives` | as for GDScript |

Errors add `bad_csproj`, `bad_packages_from`, `not_csharp_project` (`--template godot-csharp --into` a Godot folder with no `.csproj` or `.sln`).
Recipe: `docs/recipes/godot-csharp.md`.

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
- `godot-csharp`: the same guard and the same rules for `addons/onelobby_menu/` (`no_pin`, `bad_pin`, `local_changes`, `--force`, natives only when
  their pinned version moved or the folder is gone). It also moves the `Version` of every `OneLobby.*` `PackageReference` in the game's `.csproj`
  to this version (only those attributes or `<Version>` elements; one written as a property such as `$(OneLobbyVersion)` is left and listed;
  `--dry-run` shows each `id from -> to`), or to the folder's version with `--packages-from` (which also refreshes a `nuget.config` this tool
  wrote). The `.csproj` is read before anything is written, so a file it refuses (`bad_csproj`) stops the whole update. It ends with
  `dotnet build` and the import command.
- `web`: the dependency is the `onelobby` npm package, so `update` prints the one `npm install onelobby@^<version>` line and
  whether `src/session.js` (or `multiplayer/session.js`) differs from this version's glue. It writes nothing and never runs npm
  (the glue is yours to edit).

Flags: `--addon-from`, `--webrtc-zip`, `--webrtc-dir`, `--no-natives`, `--packages-from` (C#), `--force`, `--dry-run`, `--json`. Errors: `no_pin`,
`bad_pin`, `local_changes` (with `details: { edited, missing, added }` in `--json`), `not_a_project`, `no_such_dir`, `bad_csproj`,
plus the natives errors above. (A folder literally named `update` or `verify` is scaffolded as `./update`.)

## verify

`npx create-onelobby verify [dir | --into <dir>]` answers "does multiplayer work here" with no manual steps. It prints one
line per check (`ok` / `FAIL <why>` / `skipped <why>`) and a last line `VERIFY_OK` (exit 0) or
`VERIFY_FAIL <first failing check>: <what is wrong and the next step>` (exit 1). `--json` prints one object with the same facts.
A failed `godot`, `addon-pin` (`dotnet` and `menu-pin` for C#), `natives` or `blueprint` check makes the later ones `skipped`.

| Check (godot-gdscript) | What it proves |
|---|---|
| `godot` | the executable: `--godot <exe>`, else `$GODOT`, else `godot` on PATH (Godot 4.4 or newer); always run `--headless --audio-driver Dummy` |
| `addon-pin` | `addons/onelobby/` matches `PIN.json`; edited files are a warning on the line, not a failure |
| `natives` | the WebRTC natives are there and registered (it runs the headless import itself when `.godot/extension_list.cfg` is missing) |
| `blueprint` | `onelobby.json` loads through the JS loader and through the game's GDScript loader |
| `wiring` | a static look: some scene or script outside `addons/` and `tests/` uses the drop-in menu (`ui.kind` `none` / `generated`: the client). A bare `--into` fails it until the game is wired; every project the scaffolder writes passes it |
| `direct` | two peers on 127.0.0.1, host and join by code, a message each way (the game's `tests/multiplayer.gd`, else a bundled probe) |
| `nostr` | the same through a LOCAL Nostr relay on 127.0.0.1 (built in), when `hosting.nostr` is on |
| `turn` | relay-only through a LOCAL TURN server on 127.0.0.1 with a random login given as one pasted line; fails unless the TURN server saw allocations and relayed packets |
| `server` | host and join through a lobby server, only when `hosting.server` is on AND `--server http://127.0.0.1:<port>` is given (verify never starts the server); else `skipped` with the reason |

| Check (godot-csharp) | What it proves | Where it ran |
|---|---|---|
| `godot` | the executable is the **.NET build** of Godot 4.5 or newer (`--version` says `.mono.`); a standard build is a FAIL that names the .NET download; a different `Godot.NET.Sdk` version in the `.csproj` is a warning on the line | locally, CI |
| `dotnet` | a .NET 8+ SDK answers and `dotnet build <the .csproj>` succeeds (the file is named: a Godot folder has a `.csproj` and a `.sln`); a missing OneLobby package points at `--packages-from` | locally, CI |
| `menu-pin` | `addons/onelobby_menu/` matches `PIN.json`; edited files are a warning, not a failure | locally, CI |
| `natives` | the WebRTC natives are there and registered (it runs the headless import when `.godot/extension_list.cfg` is missing; Godot may then rewrite the `Godot.NET.Sdk` version in the `.csproj` to its own) | locally, CI |
| `blueprint` | `onelobby.json` loads through the JS loader and through the game's C# loader (`Blueprint.Parse`, run by `tests/MultiplayerTest`) | locally, CI |
| `wiring` | as for GDScript, for `OneLobbyMenu` / `OneLobbyMenu.tscn` (not `OneLobbyNet.cs`) | locally, CI |
| `direct` | two peers on 127.0.0.1, host and join by address, a message each way (the game's `tests/MultiplayerTest`) | locally, CI |
| `nostr` | the same through a LOCAL Nostr relay, when `hosting.nostr` is on | locally, CI |
| `turn` | relay-only through a LOCAL TURN server: the peers connect and the TURN server counts allocations and relayed packets above 0. Connected with 0 relayed packets is a `FAIL` (the links are not relay-only) | locally, CI |
| `server` | host and join through a lobby server you started, with `--server`; else `skipped` | never run (it needs a lobby server process) |

How the routes run in a C# game: the game's code runs only from its own assembly, and MSBuild leaves folders that start with a dot out of the build,
so the probe file that GDScript's `verify` drops into `.onelobby/` would never be compiled. The scaffolder writes `tests/MultiplayerTest.cs` + `.tscn`,
a scene that takes the route as arguments after `--` (`--route=config|direct|nostr|turn|server`, `--relay`, `--turn`, `--server`), and `verify` runs
that scene. An `--into` game that lacks it gets the file from `npx create-onelobby --into .`; until then `blueprint` is `ok` with a warning (JS loader only) and
the route checks `FAIL` with that command as the next step. `verify` needs the project to build, so besides `.onelobby/` it writes what `dotnet build`
makes (`bin/`, `obj/`, `.godot/mono/`), all in the managed `.gitignore` block.

| Check (web) | What it proves |
|---|---|
| `blueprint` | `onelobby.json` loads through the real loader |
| `wiring` | some file outside `test/` and `node_modules/` imports the glue (`session.js`) or `onelobby`; a bare `--into` fails it until the page is wired |
| `project-test` | the game's own `test/multiplayer.mjs` passes (in memory; needs `npm install` first) |
| `nostr`, `turn` | `skipped` by design: two JS clients over real WebRTC in Node need node-datachannel, which a web game does not depend on (tools/engine-smoke covers it) |

Flags: `--godot <exe>`, `--server <url>`, `--fetch-helpers`, `--json`. Everything binds 127.0.0.1 on free ports, no window opens,
nothing it started outlives it (also on a failed check and on Ctrl+C), and it writes only inside the game folder
(`.onelobby/`, covered by the managed `.gitignore` block; a C# game also gets what `dotnet build` and the import write).

**Helpers.** The Nostr relay is built in (pure Node). The TURN server is the npm package `node-turn` (pinned), loaded only when
`verify` runs: from the game's own `node_modules` or from `.onelobby/helpers/`. Without it the `turn` check says
`skipped` and names the one command; `--fetch-helpers` installs it there (an anonymous npm download). Scaffolding never
downloads it, so `npm create onelobby` stays zero-dependency and offline-capable.

## --recommend: which multiplayer setup fits my game?

`--recommend "<one-line description of the game>"` reads one sentence and proposes the setup: sync mode, tick rate, player count,
pause and hosting, with a one-line reason per choice. It is a plain matcher over the words of the sentence: no network, no
model, no dependency, the same answer every time. Its rules are data in `src/recommend-data.js` (the five shapes, the words that
select them, the answers and reasons, the advice, what each engine can do today).

Two uses, one engine behind both:

1. **Alone** (no folder, no `--into`): writes nothing and prints the proposal. `--template <engine>` names the engine; otherwise
   it is read from the sentence ("Unity", "Godot", "GDScript", "C#", "browser", "web"); otherwise it is unknown and the output
   says what would differ per engine instead of guessing. `--json` prints one object (below), which is what an agent calls.
2. **With a scaffold run** (`create-onelobby my-game --recommend "..."`, also with `--into`): the proposal supplies the answers
   nothing else gave. Order of precedence: explicit flags and `--set`, then `--from <onelobby.json>`, then the recommendation,
   then the built-in defaults. The output (text and `--json`) lists the keys that came from it with each one's reason, and the
   ones it proposed that a flag or file kept; `--dry-run` shows the same and writes nothing. When no `--template`, `--from` or
   Godot project says otherwise, an engine named in the sentence picks the template (a planned one stops as `template_planned`: only `unity`, `dotnet` and `node-browser` are).
   On a terminal without `--yes` or `--no-input` it asks one first question, "Describe your game in one line (Enter to skip)",
   and then shows the recommended values as the defaults of the later prompts.

An empty description is `bad_flag`. A sentence that matches no shape, or two equally, is an answer too: shape `null`, no
proposal beyond the scaffolder's own defaults, the five shapes with one line each, and the questions to settle it (exit 0).

### The five shapes

| Id | Words that select it (weak ones alone never decide) | Proposes |
|---|---|---|
| `lockstep` | deterministic, lockstep, fixed tick, seeded, party, minigames, RTS | `sync.mode lockstep`, `sync.tickRate` (from the sentence, else 20), `sync.hashEveryTicks 60`, `session.pause off` (`anyone` for strategy); 8 players for a party game, else 4 |
| `coop-snapshots` | co-op, survival, sandbox, open world, free roam, the host runs the world | `sync.mode replication`, `sync.tickRate 15`, `session.pause host` |
| `replication` | shooter, FPS, hitscan, battle royale, racing, physics | `sync.mode replication`, `sync.tickRate 30`, `session.pause off` |
| `turn-based` | turn-based, card game, chess, board game, poker, trivia | `sync.mode raw`, no tick, no pause |
| `own-server` | own server loop, existing server, websocket | `sync.mode raw`; `asWebSocket` where the client has it |

Every shape also proposes `lobby.maxPlayers` (read from "4 player", "2-4 players", "up to 8", "1v1", "duel", "for 4"; else 4),
`room.spectators` only when the sentence mentions watching, and `hosting.direct` / `hosting.server` when the engine is known
(direct with join codes wherever the engine can listen; a lobby server for a browser page, which cannot listen). Nothing else is
proposed. A near miss is handled on purpose: "deterministic" outweighs "shooter"; "survival" inside a card game is a weak word;
lockstep is never proposed for Unity physics (Unity physics is not deterministic), whatever the sentence says.

Honest about this version: a proposal never promises what the engine's client lacks. Prediction (`Reconciler`) and hit rewind
(`HistoryRing`, `RewindTick`) exist in the C# replication layer only (Godot C#, Unity, .NET); the JS and GDScript clients keep
the data for them (`lastProcessedInput`, `trySampleAt`) and the advice row says "by-hand". The `web` template writes only the
`lockstep` and `raw` sample game, so where the best mode for the game is `replication` it proposes `raw` and the output says so in
a `limits` row. Input redundancy on the fast channel and an adaptive input delay are not in any lockstep helper yet (advice
rows `lockstep-fast-inputs` and `adaptive-input-delay`, status `by-hand`). A proposal for a planned template (`unity`,
`dotnet`, `node-browser`) is printed, with no command to run, because the scaffolder would stop with `template_planned`; one for `godot-csharp` carries a real command.

### Examples

A clear match (the full output, text):

```
create-onelobby --recommend: "4 player party minigames in Godot"

Game shape: lockstep (Deterministic fixed-tick game)
  matched: "party", "minigames"
Engine: godot-gdscript (Godot 4 GDScript), from the description ("Godot")

Proposal (blueprint key, proposed value, why):
  sync.mode            lockstep  every peer runs the same fixed-tick simulation and only the small inputs cross the network, so there is no state to sync
  sync.tickRate        20        lockstep sends one frame per tick, so this is your simulation's fixed step: set it to the rate your sim runs at (20 until you know)
  sync.hashEveryTicks  60        a state hash about every 60 ticks finds a drift between peers early (a mismatch raises Desync)
  lobby.maxPlayers     4         your description says "4 player"
  session.pause        off       a real-time round cannot wait for one player to find the pause key
  hosting.direct       true      the engine can listen, so players share a join code and one of them hosts: the game outlives any server
  hosting.server       false     a lobby server is optional here; switch it on if you also want a public list

Advice that is not a blueprint key yet:
  [by-hand] Send inputs on the fast channel with the last few ticks repeated
      why: a reliable ordered input channel stalled one game about half its frames at 80 ms and 2% loss;
      redundancy on the fast channel fixed it.
      how: no lockstep helper does this yet (its commands travel on the reliable channel); send your own input
      packets on the fast channel (Channel.Fast in C#, { channel: 'fast' } in JS) beside the lockstep frames
      (docs/recipes/raw-mode.md)
  [by-hand] Use an adaptive input delay (a few ticks, grown when the round trip grows)
      why: a fixed delay is either too laggy on a good link or too stuttery on a bad one.
      how: no client has it yet: measure the round trip yourself and schedule each command a few ticks ahead
      (docs/recipes/raw-mode.md)
  [built-in] Let bots take the seats of dropped players
      why: a lockstep game cannot wait for a player who left; a bot keeps the simulation moving.
      how: room.on("seatDropped", s => spawnBot(s.seat)) fires once the rejoin window has passed
      (room.seatDropped / rejoinWindowSeconds) (docs/recipes/room.md)

Open questions (add the words to the description and run again):
  - GDScript or C#? Assumed GDScript, the Godot template that exists today.
    add: "in Godot with GDScript, or in Godot with C#"
  - What fixed tick rate does the simulation run at?
    add: "at 30 ticks per second"
  - Is the simulation deterministic? Lockstep needs the same commands in the same order to give the same state
  on every peer: a fixed tick, in-state seeded random numbers, no wall clock, no unordered iteration, no
  floats that differ by platform (AGENTS.md rule 3).
    add: "deterministic with a fixed tick and seeded random numbers (or: not deterministic)"

Run it:
  npx create-onelobby my-game --template godot-gdscript --hosting direct --mode lockstep --tick-rate 20 --set sync.hashEveryTicks=60 --max-players 4 --pause off --yes
```

A sentence that matches nothing (text):

```
create-onelobby --recommend: "a puzzle game"

Game shape: unknown. The description does not clearly match one shape, so nothing is proposed beyond the scaffolder's normal defaults.
Engine: unknown (not given by --template or the description)

The five shapes (add words from one to the description):
  lockstep        Deterministic fixed-tick game: party minigames, an RTS on a seeded simulation: every peer runs the same sim and only small inputs cross the network
  coop-snapshots  Free-roam co-op with rich state: survival, sandbox: the host runs the world and sends snapshots, each joiner predicts its own actions
  replication     Shooter or physics game, host-authoritative: shooters, physics, AI: the host decides, joiners get interpolated snapshots and send inputs; anything that is not deterministic
  turn-based      Turn-based, card or board game: nothing to sync between turns: the host is the truth and raw messages are enough, with no tick
  own-server      An existing server-style game: the game keeps its own server loop and OneLobby only carries the bytes, shaped like a WebSocket

Open questions (add the words to the description and run again):
  - Which engine or platform is it for? It changes hosting, the modes the scaffolder writes today and which
  helpers (prediction, hit rewind) exist.
    add: "in Godot (GDScript or C#), in Unity, or in the browser"
  - What kind of game is it? The description did not clearly match one shape.
    add: "one of: deterministic fixed-tick party minigames; co-op survival sandbox; shooter or physics game; turn-based card game; a game with its own server loop"
  - How many players?
    add: "for 4 players, or up to 8 players, or a 1v1 duel"

Run it:
  npx create-onelobby my-game --yes
```

A scaffold run that mixes a flag with the recommendation. The flag wins and the output says what it kept (the file list and the
`onelobby.json` that the dry run prints are cut out here):

```
create-onelobby my-game --template godot-gdscript --recommend "co-op survival sandbox for 4 with spectators" --max-players 6 --yes --dry-run --no-natives
...
From the recommendation (coop-snapshots):
  sync.mode        replication  the host runs the world and sends binary delta snapshots; sending the whole state as text outgrew the link in a real game
  sync.tickRate    15           snapshots at about 10-20 Hz carry a rich world without outgrowing the link (15 is the middle)
  room.spectators  4            your description mentions watching; spectators do not count against lobby.maxPlayers
  session.pause    host         the host's machine runs the world, so the host decides when it stops
  hosting.direct   true         the engine can listen, so players share a join code and one of them hosts: the game outlives any server
  hosting.server   false        a lobby server is optional here; switch it on if you also want a public list
  kept lobby.maxPlayers = 6 from a flag (the recommendation said 4)

```

#### JSON fields

`create-onelobby --recommend "<text>" --json` prints exactly one object. The field names are a contract: an agent can rely on them.

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | always `true`; an error is `{ ok: false, error: { code, message } }` as everywhere else |
| `command` | string | always `"recommend"` |
| `description` | string | the sentence, trimmed |
| `shape` | string or `null` | `lockstep`, `coop-snapshots`, `replication`, `turn-based`, `own-server`, or `null` when unknown |
| `shapeName` | string or `null` | the shape in words |
| `matched` | string[] | the words of the sentence that decided the shape, as the sentence wrote them |
| `engine` | object | the engine the proposal assumed |
| `engine.id` | string or `null` | a blueprint `engine` value, or `null` when unknown |
| `engine.from` | string | `"template"` (--template or a --from file), `"files"` (read from the --into folder: Godot, Unity, .NET or web files), `"text"` (read from the sentence), `"default"` (the scaffolder's default, scaffold runs only) or `"none"` |
| `engine.words` | string[] | the words that named the engine (only when `from` is `"text"`) |
| `engine.label` | string or `null` | the engine in words |
| `engine.template` | string or `null` | `"built"` (create-onelobby writes a project for it) or `"planned"` |
| `answers` | array | the proposal: `[key, value, why]` rows in schema order; `key` is a blueprint key, `value` a value the schema allows |
| `advice` | object[] | advice that is not a blueprint key: `{ id, text, why, status, how, doc }`; `status` is `built-in` (the client has it), `by-hand` (the game writes it; `how` names the pieces) or `depends` (engine unknown; `how` says which engines) |
| `limits` | object[] | where the best choice is something the template cannot write: `{ key, wanted, got, why }` |
| `notes` | string[] | plain sentences: a ban that applied, a planned template, an unknown engine |
| `questions` | object[] | what the sentence did not say and would change the answer: `{ id, question, add }`; `add` is the words to add to the description |
| `flags` | string[] | the `create-onelobby` flags that apply `answers` (`--set key=value` for keys that have no flag of their own) |
| `runCommand` | string or `null` | one ready-to-run command line; `null` when there is none yet (planned template, unknown engine) |
| `shapes` | object[] | the five shapes: `{ id, name, summary }` |
| `candidates` | object[] | only when `shape` is `null`: the shapes the words hinted at, `{ shape, score, matched }` |
| `differences` | object[] | only when the engine is unknown and a shape matched: what would differ per engine, `{ topic, text }` |

#### In a scaffold run

With a folder or `--into`, `--json` is the usual scaffold result plus `recommendation`: `{ description, shape, matched, engine,
applied, overridden, dropped, limits, questions, notes }`. `applied` is `[key, value, why]` rows for the keys the recommendation
really supplied; `overridden` is `{ key, value, recommended, by }` for keys it proposed that a flag (`"a flag"`), a `--from` file or
an answer typed at a prompt (`"your answer"`) kept instead; `dropped` is `{ key, recommended, why }` for the other `sync.*` values
it proposed when its `sync.mode` was replaced (a tick rate chosen for lockstep is not applied to a raw game).

## All templates

`create-onelobby --help` lists every flag (one per setting, plus `--set key=value`). `--dry-run` writes nothing (and downloads
nothing), `--json` prints one machine-readable result, `--into <dir>` adds to an existing project. `node-browser`,
`unity` and `dotnet` are planned.

Zero runtime dependencies; Node 18 or newer. Design: `docs/design/blueprint.md` and `docs/design/one-shot.md` in the repository.
