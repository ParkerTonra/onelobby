---
name: onelobby
description: Make a game multiplayer with OneLobby in one pass. Surveys the game, asks the scaffolder (create-onelobby) for a recommendation, proposes onelobby.json with a reason per setting, builds with the scaffolder's templates and the drop-in menu, proves it with `create-onelobby verify` and reports. Use when the user says "make it multiplayer", "add OneLobby", "add co-op", "host and join", "online play", or edits onelobby.json and wants the game to match.
---

# OneLobby: make this game multiplayer

You turn a single-player game into one that players can host and join, and that keeps working after any server is gone
(a player hosts from their own machine and shares a join code). The user drives the choices; you propose them with
reasons. One file holds every choice: `onelobby.json` (at the game's root; Unity: `Assets/Resources/onelobby.json`; schema: `onelobby/blueprint.schema.json` in the
npm package; design: `docs/design/blueprint.md`). **In a clone of the OneLobby repo (an unreleased build), run
`node <clone>/clients/js/packages/create-onelobby/bin/create-onelobby.js ...` for every command below, and never `npx create-onelobby`:
`npx` fetches the published, older scaffolder (it answers `unknown option: --recommend`).** Build it first: `npm ci && npm run build` in
`clients/js`, then `node scripts/build.mjs` in that package; `--help` prints on its first line which build it is (a clone's or the
published package). Everywhere else the commands below are `npx create-onelobby ...`. The scaffolder's own rules are not repeated here: it answers,
you explain its answer. Run the phases in order. Never skip Verify. Never write "works": name the checks that ran.

## 1. Survey (read only, change nothing)

Note each finding with the file and line that told you:

- **Engine**: `project.godot` alone = Godot GDScript (`godot-gdscript`); `project.godot` with a `.csproj` = Godot C#
  (`godot-csharp`); an HTML page and JS = browser (`web`); a Node server that serves the page = `node-browser`; `ProjectSettings/`
  = Unity (`unity`); other .NET = `dotnet`. Anything else (Unreal, ...): stop, tell the user OneLobby has no client for it yet.
- **Loop**: fixed tick (`setInterval`, accumulator, `_physics_process`, `_PhysicsProcess`, `FixedUpdate`) or frame-driven.
- **Determinism**: RNG seeded and kept in game state vs `Math.random` / `randf()` / `UnityEngine.Random`; wall clock in the
  sim (`Date.now`, `Time.get_ticks_msec`, `Time.time`); unordered iteration; physics engine; floats.
- **Genre and pace**; **players** the design implies (map slots, spawns, else 4); **menus** (where a "Play together" entry fits);
  **pause** (what the Escape menu calls); **settings storage**; **build and test commands**.
- **What multiplayer it already has** (skip for a new game): its own menu, join-code or relay (TURN) paste field, settings storage, a copy of the add-on
  in `addons/onelobby/` (older pin file `PIN`, a `PIN.json`, or no pin), its own snapshot or session code, its own two-process test. Note each file; the section
  "A game that already has multiplayer" below says what to do with them.
- **Game id and net version** of a game that already has them: grep its data and settings files for `game_id`, `gameId`, `net_version`, `netVersion` (a tunables or
  config file, the old client's constructor). Pass them as `--game-id` and `--net-version` (`--yes` would invent `com.example.<folder>` and the version `1`), and the game's own name as `--title '<its name>'` (Godot: `config/name` in
  `project.godot`; `--yes` would take the folder name, so a game in `goo/` would be titled "goo").
- **One plain sentence** for the recommender: genre, **the engine named in the sentence itself** ("in Godot", "in Unity", "in the browser", "a Node server"; also when you will pass `--template`:
  a sentence with no engine answers `runCommand: null` and "no engine is known"), player count, and the tick rate when the game has one (a new game:
  leave it out; every game type has a default `tickRate`, and `why` says how to change it). Write "deterministic" only for what the
  survey proved (fixed tick, state-held seed, no wall clock, no unordered iteration), never as a hope.

## 2. Recommend

`npx create-onelobby --recommend "<the sentence>" --json` writes nothing and needs no network. Read the one object:

- `answers`: `[key, value, why]` rows, each a blueprint key; they become the proposal. `shape` names the game type
  (`lockstep`, `coop-snapshots`, `replication`, `turn-based`, `own-server`); keep it for the report.
- A **new game has no code to survey**: its sentence is the only input, so write what the players do ("run and jump around an arena
  together", "co-op", "side view platformer"). Words like run, jump, arena, platform, move around, co-op lead to a shape by themselves (a
  player world: `fallback: "world"` in the result, with a note saying so) unless the sentence says turn based, puzzle, deterministic or lockstep.
- `shape: null`: the sentence matched nothing clearly. `candidates` (present only then) lists every shape that scored, best first. Answer each
  of `questions` from the survey where a file and line settle it, ask the user the rest, add the `add` words to the sentence and run again.
  When nobody can answer (a new game, no user at hand), use the top `candidates` entry: add its words to the sentence, run again, and say in
  the report that the shape was the recommender's best candidate. With no candidates at all, ask; do not invent a shape.
- Players that move in a 2D world: the recommender reads "2D", "side view", "top-down", "side scroller" and "platformer" as
  `sync.player.space` = `2d` (an explicit "3D" keeps the default `3d`). Say "2D" or "3D" in the sentence of a game with players.
- `limits`: what this engine's client or template cannot do yet (it wanted X, wrote Y). Tell the user, do not hide it.
- `advice`: `built-in` is a client feature to use; `by-hand` is work the game must do; `depends` waits on the engine.
- `engine.template` `"planned"`: the scaffolder cannot write this engine yet; take the by-hand path (4.5). `runCommand: null` with a built engine means the sentence named no engine: add it to the sentence and run again.
- **A Node process that hosts** ("a Node server runs the match", "the host's node process serves the page") is engine `node-browser` with `hosting.direct` true (the recommender reads the words `node` and `nodejs`);
  without them a browser game is engine `web`, which cannot listen (`hosting.direct` false).
- **Co-op where the host runs the world** (the host sends snapshots, joiners predict their own actions, "not deterministic" next to "co-op") is `coop-snapshots`, not
  the competitive `replication`: write "co-op" or "cooperative" and "the host runs the world" or "the host sends snapshots". A competitive word (shooter, versus, pvp,
  racing, physics, battle royale) keeps `replication`. Both shapes answer `sync.mode replication`: for a game that keeps its own sync see "A game that already has multiplayer".
- **The survey wins over the sentence.** The matcher reads words and ignores code facts ("deterministic ... calls `Math.random`"
  still gives `lockstep`). When they disagree, fix the sentence ("not deterministic", the real tick rate) and run again; if that is
  not enough, correct a value with a flag (`--mode raw`, `--max-players 2`) or `--set key=value`: a flag beats the recommendation
  and the run lists it under `overridden` / `dropped`. Say each override in the report.

## 3. Propose

Preview, writing and downloading nothing: `npx create-onelobby --into . --template <engine> --recommend "<sentence>" --yes
--dry-run --json` (a new game: `npx create-onelobby my-game --template <engine> ...`). `--recommend` fills in its `answers` by
itself; add a flag only to override one (section 2), not to repeat them. Pass `--template` when you know the engine; without it
`--into` reads the folder (Godot, Unity, .NET or web files) and stops with `engine_unknown` when the folder tells nothing. `--yes` invents the game id `com.example.<folder>`; give the real one with
`--game-id`, and a game's own net version with `--net-version` (survey). The result holds `blueprint` (the file to be written), `files` (added or updated), `recommendation`,
`collisions` (game files that differ from what the run would write), `removed` (old add-on files that go) and `addon.replaces` (old version -> new). In words, the dry run says
`Add-on: <old> -> <new>` and lists every game file that collides under `Collides with files already in your game`: read both before the go.

Show the user a table `key | value | why` (the `why` of `applied` rows, else the survey's reason with file and line), the plan
(the command, the files it adds or changes, where the menu goes and which scene or page opens it) and the `limits`. If every value
is a schema default, build without stopping; otherwise stop for the user's go or edits. With no user at hand (an unattended run),
the task that started you is the go: build, and list every value that is not a schema default in the report. After the build, put the reasons in the
file: one key named exactly `"$comment"` in each object (`hosting`, `lobby`, `sync`, ...), holding the reasons for that object's
keys in one string. The loaders ignore that name only; any other spelling (`"$comment tickRate"`) fails as `unknown_key`. A run with `--from <file>` keeps the `$comment` keys of that file, in the same objects, so a file that already holds its reasons keeps them. `--force` never replaces an existing `onelobby.json` (the dry run lists it as kept): delete the file to write a fresh one.

## 4. Build

1. Run the previewed command without `--dry-run`; its "Next:" lines are part of the job. Godot downloads the WebRTC natives once
   (pinned, SHA-256 checked, anonymous; offline: `--webrtc-zip <file>`). Godot C# needs the .NET build of Godot and the .NET 8 SDK,
   and until a release is on NuGet `--packages-from <folder of .nupkg>`. Then `godot --headless --audio-driver Dummy --import --path .`
   (C#: first `dotnet build <the .csproj>`). Natives already in `addons/godot_webrtc/` are kept; the run says when their version is not the pinned one (a pin of ours records it, else it is "unknown") and `--force` replaces them with the pinned release, and `verify` warns on `natives` in the same case.
   A second Godot run changes nothing and keeps your `onelobby.json` (`--force` keeps it too); web stops with
   `exists`: edit by hand. **Unity needs the package tarball** at the path its manifest names (the "Next:" line says where; a manifest that already has a `com.onelobby.unity` line keeps it, and the line is only printed when the file it names is missing): a released game
   takes the release tarball (`com.onelobby.unity-<version>.tgz`, natives included); in a clone, or for an unreleased build, run
   `clients/unity/fetch-natives.sh` once (anonymous, SHA-256 checked download of the last released package for its WebRTC libraries; it
   writes them into the clone's `clients/dotnet/OneLobby.DataChannel/runtimes/`; both scripts need bash, Git Bash on Windows), then `clients/unity/build-unity-package.sh --pack`,
   and put the new `.tgz` there. `--pack` stops with `PACK_FAIL` when `Runtime/Plugins/x86_64/datachannel.dll` would be missing, and `verify`
   fails `package` for a tarball without it: on Windows two peers never link. Your own code that uses OneLobby from its own `.asmdef` lists
   `OneLobby.Unity` in `references` (and `OneLobby.Replication.dll` in `precompiledReferences` for the player layer).
2. **Wire the drop-in menu where the survey said** (a new project has it as the main scene; a new Unity project has nothing to wire:
   its `Boot.cs` adds the menu when the first scene loads, the game's `AGENTS.md` says where). Godot `--into` never edits your scenes:
   instance `addons/onelobby/menu/menu.tscn` (C#: `addons/onelobby_menu/OneLobbyMenu.tscn`) in the menu entry's scene (it is a
   Control; a Node2D scene can hold it as a child). GDScript: give it the client before the menu's own `_ready`, so from the
   parent's `_enter_tree` (`$Menu.client = Net.client`) when the menu sits in the scene file, or before `add_child` when you
   instance it in code (`Net` is the autoload the scaffolder registered). Connect `game_started(lobby)` (start the match),
   `returned_to_lobby` and `left` (end it), keep a way to play alone. Restyle and reword: `docs/recipes/menu.md`.
   **Inside your own panel or container** the menu (a full-rect Control with no minimum size of its own) needs a size: in a `Container` parent give it `menu.custom_minimum_size = Vector2(520, 460)` and
   `menu.size_flags_horizontal = Control.SIZE_EXPAND_FILL` (and `..._vertical`) before `add_child`; in a plain `Control` or `Panel` parent it fills the parent through its full-rect anchors, so size the parent (the same 520x460 minimum
   is a workable floor for the room page; tune it).
   **Order when you hand over to your own session: `game_started(lobby)` fires with the menu's screen already PLAYING, so set your own role and "line is live" state FIRST, then attach the lobby.** Code that refreshes on the
   lobby's roster signals while the menu says PLAYING reads your state at once; a panel that finds no live line then hangs up (`menu.leave()`) and both peers drop the moment the match starts. Wrong: `attach(lobby); role = ...`;
   right: `role = ...; attach(lobby)`. The host's `game_started` comes after the room's countdown (3 s by default, `room.countdown_seconds`), with `start_on_host` too: the world keeps ticking solo for that time, and your
   session attaches only when the signal arrives.
   **Handing over to a game's own session** (the add-on's `menu.gd` comment has the same list): `game_started(lobby)` fires on every copy when the match starts
   (the host after its Start and the room's countdown, a joiner when the host's phase turns `in_game`, also a late joiner) and hands over the `OneLobbyLobby`
   (`lobby.local_peer_id`, `lobby.host_peer_id`, `lobby.is_host`, `lobby.room.players()`; in raw mode `lobby.send`, `lobby.broadcast` and `lobby.message_received` carry
   the game's own bytes). The menu has a room step the old flow may not have had: after Host or Join the lobby page shows the roster, Ready and the host's Start;
   nothing starts until the host clicks Start. With `pump` on (the default) the menu turns the client's `auto_pump` off and pumps it from its own `_process`, so the pump stops when the menu is freed: set
   `menu.pump = false` on a menu inside a node the game frees or replaces when the match starts (the autoload's client then keeps pumping itself). The menu reads `--host`, `--join=<code>`, `--name=<name>`, `--local` and `--autostart` from the command line itself: a game that reads flags of
   those names too would act twice (both copies host), so set `menu.boot_flags = false` and open the host or join yourself (`menu.model.apply_local()` for the
   127.0.0.1-only setup). The process flags are read once per process: the first menu that builds takes `--host`, `--join`, `--name` and `--autostart` and every later menu
   (a game that builds one in each world) acts on none of them (`--local` stays on for all), so a game needs no flag of its own for that. A menu built in code (a runtime CanvasLayer, no scene file): `var menu: OneLobbyMenu = load("res://addons/onelobby/menu/menu.tscn").instantiate()`,
   `menu.client = Net.client`, then `layer.add_child(menu)`: the client and every export are set before `add_child`. The "Next:" lines name both ways (scene and code).
   **Test on this PC only.** The menu acts on `-- --host` and `-- --join=<code>` by itself, and a plain `--host` opens a port and
   reaches public relays. `--local` (127.0.0.1 only, no Nostr) is read by the GDScript menu itself, with no game code, as long as `boot_flags`
   is on; the C# menu reads it too (no lobby server, no check on open), and the "Next:" line's `OneLobbyNet.Wire(menu, args)` in the
   scene script's `_Ready` gives it the 127.0.0.1 host (`BootFlags` stays on). Never run `-- --host` without `--local`. `--local` also hands out and uses no ICE servers at all (no STUN lookup, so no server-reflexive candidate): a local run gathers host candidates only.
   **JS Node host, same thing:** a Node host has no flag, so `hostDirect(kit, { local: true })` is the JS `--local` (it sets `bindHost: "127.0.0.1"`, `openPort: false`, `nostr: false`; passing `bindHost` alone still asks the
   router and reaches public relays, so spell out those two too).
3. **Web** `--into` writes `onelobby.json`, `multiplayer/session.js` and `test/multiplayer.mjs` only: no menu (`ui.kind` stays
   `generated`, you draw the buttons; `--ui drop-in` is refused) and no `AGENTS.md`, and a minimal `package.json` only when the folder has
   none (an existing one is never edited: add `onelobby` as the "Next:" lines say, then `npm install`; a package.json with no `"type": "module"` (a CommonJS game) gets the glue as `multiplayer/session.mjs`, which Node reads as an ES module whatever the
   package says, so do not add `"type": "module"` to it). Put the game behind
   `step(tick, commands) -> hash`, `snapshot()`, `restore(tick, bytes)`, `hash()` and swap it into the test's stand-in `Game`.
   In the page go through `multiplayer/session.js`: `loadBlueprint()`, `makeKit(bp, { displayName })`, `kit.host()` or
   `kit.join(code)`, then `const s = bindSession(lobby, kit.blueprint, game)` before `lobby.start()`; call
   `s.pump(performance.now())` every frame and `s.send(bytes)` when the player acts; the match runs while `lobby.phase` is
   `"in_game"` (`lobby.on("phase", ...)`); keep the old loop for playing alone. A page with no bundler cannot resolve the glue's bare `onelobby` import: it needs the import map of
   `docs/recipes/js-web.md` section 1, and when your own server does not expose `node_modules/`, serve `onelobby/bundle` (`dist/onelobby.bundle.mjs`) at a URL and map `onelobby` to it (one line, in the "Next:" lines); the Host / Join / Start buttons and their errors are its sections 3 and 4. The `<one-lobby>`
   element (`menu.md`, "Web") fits only games that sync through its own `send` / `shared`, not through a Lobby.
   **`node-browser`** (a Node process hosts and serves the page): `--into <folder> --template node-browser` writes `onelobby.json` (`engine: "node-browser"`, `hosting.direct` true) and the glue, and the lockstep stand-in
   `test/multiplayer.mjs` only for `sync.mode` lockstep (a raw or replication game keeps its own sync: no stand-in, and `verify` skips `project-test` with that reason). Without `--into` it stops (the game already has its server). In the
   Node process build the kit with `OneLobby.fromConfig(onelobby.json)` and call `hostDirect(kit, { http })` (`onelobby/direct`): `hostDirect`, `hostNostr` and the other recipes take seats, late join, port, `openPort`, Nostr and
   its relays, LAN and the rate limit from `kit.blueprint`, and an option you pass still wins. Test on this PC only with `hostDirect(kit, { local: true })`; the same options that fit `bindHost: "127.0.0.1"`, `openPort: false`,
   `nostr: false` are in `docs/recipes/direct-ip.md`.
4. Hand work the template does not cover, after 1 to 3: the game's sim as lockstep frames (`docs/recipes/godot-gdscript.md` section 4b,
   `js-web.md`), replication (`replication.md`), a pause-menu call when `session.pause` is not `off` (`pause.md`), the `by-hand`
   advice. Room (ready, countdown, kick, ban, rematch), saved settings, the connection check (it runs once when the menu opens, except with `--local` or in a headless run (no display), where it never runs by itself, so a game's own headless
   tests that build the menu reach no STUN server; `diagnostics.checkOnOpen: false` in `onelobby.json` switches it off everywhere, the button stays) and plain-language errors already live in the menu and the library.
   **Players in the world are not hand work on Godot or Unity any more:** when the recommendation has `sync.player.authority` (the `coop-snapshots` and `replication` shapes) or you
   pass `--mode replication --set sync.player.authority=owner|host` (add `--set sync.player.space=2d` for a side-on or top-down character: `sync.player.space` is `3d` or `2d`, default `3d`,
   so a 2D game without it gets a 3D player), the same one command writes the networked player: a new GDScript, C# or Unity project gets a character
   (`player.tscn`, `Player.tscn`, `Assets/Scripts/GamePlayer.cs`), a game with the spawner and a player check in its two-peer test (both ways: the joiner's player on the host and the host's player on the joiner, one `MULTIPLAYER_PLAYER` line each) (C# also vendors `addons/onelobby_net_player/` and references
   `OneLobby.Replication`; Unity needs neither, the package has the component); `--into` adds the vendored parts and prints the spawner lines to put where your game starts (it writes no scene into the game). The `--json` result
   has `netPlayer`. `verify` then has a `player` line. Web does not write it yet (`docs/recipes/net-player.md` sections 3 and 4).
5. **By hand** (`template_planned`, a planned engine): ask the tool, do not assume; its `template_planned` refusal
   names what it builds today. Follow the engine's recipe (`dotnet-generic.md`, `browser-game.md`; Unity is built now: `docs/recipes/unity.md` "One command"), write
   `onelobby.json` yourself against the schema, and say in the report that this path was by hand.
6. Rules that stay: read `onelobby.json` at run time, never copy its values into code (`OneLobby.fromConfig`,
   `OneLobbyClient.from_config`, `Blueprint.Load`); the game plays offline and every lobby call can fail (show `describeError`);
   the lobby server URL is a player setting; bump `game.netVersion` when command bytes change. **Relay list** (only when
   `hosting.nostr` is on; a web game on a lobby server skips this): the scaffolder writes the library's default list unprobed and
   some are dead. The check reaches public relays: run it only where that is allowed (a "nothing leaves the PC" test skips it and
   keeps the default list; say so in the report). In a scratch folder `npm install onelobby` (in a clone, or for an unreleased build,
   the clone's own: `npm install <clone>/clients/js/packages/client --install-links`, so the default list is the one this game ships), then run
   `node -e "import('onelobby').then(async m => console.log(JSON.stringify((await m.checkNostrRelays(m.DEFAULT_NOSTR_RELAYS, 8000)).filter(r => r.ok).map(r => r.url))))"`
   (anonymous, random keys) and write the result to `hosting.nostrRelays` with a `$comment` naming the date; offline, keep the default.

## 5. Verify

`npx create-onelobby verify` in the game folder (Godot from `--godot <exe>`, else `$GODOT`, else `godot`; headless, loopback only:
for `nostr` and `turn` it starts a local Nostr relay and a TURN server in node, bound to 127.0.0.1, and stops them at the end).
Read the last line: `VERIFY_OK`, or `VERIFY_FAIL <check>: <next step>`. Do that step and run again until `VERIFY_OK`, or until you can
name why a check cannot run here. (A `direct` failure that says `never linked` after 15 s can be a slow first start, not a bug: its text says what to try, once.) `--fetch-helpers` (once) fetches the TURN helper anonymously when `turn` says skipped; `server`
runs only with `--server <ws url>` of a lobby server you started. `skipped` is not a pass: list it (a web game skips `nostr` and `turn`:
verify starts no JS peers for a web game; the line says whether `node-datachannel` is in the folder (a Node host has it, a browser-only game does not), and a game that has it proves the route with its own two-peer test over real WebRTC: run
that test and name it in the report). `verify` proves the routes, and `project-test` for a `raw` or `replication` game proves only OneLobby's lobby and messages plus the stand-in game ("NOT this game's own netcode" is in its line): `VERIFY_OK` never means your own sync works, so run the
game's own two-player test and name it. In `wiring` that some scene or page uses
the menu or the glue and names them (every file, or the count and the first five: check that your real front end is in the list; a bare `--into` fails it until you wire the game); it does not run your game, so also boot it and read the output for errors. Godot: `godot --headless --audio-driver Dummy --path . --quit-after 90` (no flags).
Unity: a game with its own player build and generated scenes skips the boot check below and leans on verify's in-process `MultiplayerTests` (the `direct` line); otherwise build the player (`Unity.exe -batchmode -nographics -quit -projectPath . -logFile <abs>/build.log -executeMethod OneLobbyBuild.Windows`, the command in the game's `AGENTS.md`), run
`Builds/Windows/Game.exe -batchmode -nographics -logFile <abs>/boot.log --host --local --name=Sam` for about 20 s and stop that process yourself (a player has no quit flag; the log should say
`direct host listening` and hold no exception). Web: `node test/multiplayer.mjs`. Check **offline** the same way: with `--local` nothing leaves the PC, and with no lobby server the game still plays and the menu says multiplayer is unavailable.
Headless, the boot runs above are that check (no lobby server, no error in the output); the menu's text shows only on screen, so a headless run lists it as not seen.
**Two real copies, headless:** the generated two-peer test already prints one `MULTIPLAYER_PLAYER` line per way. Two real copies of a game with the GDScript drop-in menu, in any mode (the menu reads `--autostart` itself, so a raw or
replication game with no player layer runs the same path: `game_started` fires on both copies and the game's own session code starts from it; put a `print` in that handler to see it) or a game with the player layer (Godot C#, Unity: `--autostart` exists for the player layer only)
start both with `--local --autostart`: the host starts the match as soon as a second player has joined (no menu click), and with the player layer every copy walks its own player and prints
`MULTIPLAYER_PLAYER <me> sees <other> (peer N) move: from x = .. to x = ..` once it sees the other's player move. Godot: `godot --headless --audio-driver Dummy --path . --quit-after 1500 -- --host --local --autostart --name=Sam`,
then the same with `--join=127.0.0.1:47810 --name=Ann` in place of `--host --name=Sam` (Unity: the built player with `-batchmode -nographics -logFile <abs>.log`). Read both logs.
`verify` refuses engines the scaffolder does not build (no verdict line); then use the recipe's "Done when" and say which checks you could not run.

## 6. Report

```
OneLobby: <title> is multiplayer.   Shape: <shape id from --recommend>

Settings (onelobby.json)          Why
  <key>  <value>  <reason, or "default">
Overrode the recommendation: <key: recommended -> chosen, because the survey found ...>   (or "none")

Built
  <file>   <what it does>

Verified
  PASS <check> / FAIL <check>: <why, what to do> / SKIPPED <check>: <why>

Next
  - <what only the user can do: a lobby server URL, a store setting, the by-hand parts left, the `limits`>
```

Every Settings line is a key the user can change by hand.

## A game that already has multiplayer

Read at Survey when the game has a menu, a code or relay field, settings storage or session code of its own. The drop-in pieces replace the front end; the game's own
sync stays unless the user asks for OneLobby's.

- **The drop-in pieces replace** the host/join menu with its roster and Start step, the join-code field and its cleaning, the relay (TURN) paste field with its parsing and
  warnings, the storage of name, relay and last code, the name rules, the error texts, and the two-process smoke test (`tests/multiplayer.gd`; the game's own tests stay beside
  it, and a test of a piece you delete goes with it: list those in the report). Delete a hand-built piece only after the menu works.
- **Its own sync stays: `--mode raw`.** `coop-snapshots` and `replication` both answer `sync.mode replication`, which means OneLobby's `ReplicationSession` replaces the game's
  snapshot code. A game that keeps its own codec and sessions passes `--mode raw` (the game sends its own bytes over `lobby.send` / `lobby.broadcast`), and the report says
  "Overrode the recommendation: sync.mode replication -> raw, because <the files that already do it>". Use `replication` only to replace that code on purpose (`docs/recipes/replication.md`).
- **A test that drives your own sessions stays** (a bot or script that starts its own host and join sessions, for example `tools/coop_test.sh` with a code-driven bot): only a test of lobby linking (host, join by code, a message
  each way) goes, with the add-on's `tests/multiplayer.gd` taking its place. Rewrite the script's flags to the menu's (`-- --host --local --autostart`, `-- --join=127.0.0.1:47810 --local`) and say in the report which tests stayed.
- **Environment variables** the client reads for one run: `ONELOBBY_NAME`, `ONELOBBY_RELAY` (a TURN line), `ONELOBBY_LOBBY_SERVER` and `ONELOBBY_LAST_CODE` (`spec/settings.md`; in JS, C# and GDScript alike). They replace a game's own
  name and TURN environment variables (for example a `GAME_TURN_LINE` in a test script: set `ONELOBBY_RELAY` instead); the library applies the relay to the host's and the joiner's ICE list, so the game's own relay wiring goes.
- **Rejoin**: a joiner's `rejoin_direct(code, token)` takes `lobby.code` of the lobby it was in (for an IP join the host's address code, for Nostr the grouped code) and `lobby.resume_token`; keep both before the line drops (the host's
  window is 60 s).
- **A game that builds its own `OneLobbyClient`** (in a service or autoload) switches to the autoload's: there is one client per process, `Net.client`. Delete the
  `OneLobbyClient.from_config(...)` call and write `var client: OneLobbyClient = Net.client` and, when the game adds to the net version at run time, `client.net_version = <its own value>`
  (the game's own line). Give the same client to the menu (`menu.client = Net.client`).
- **A game that hosts from its running world** (no room, no Start button: the world is already up when the line opens) uses the menu for the part before the match and
  attaches its session in `game_started(lobby)`: the host builds its host session over the world that is already running, a joiner builds its join session and keeps its solo
  world until the host's first snapshot arrives. The menu's room step is not skipped by default; for a host that should not see it set `menu.start_on_host = true` (before `add_child`):
  after Host the menu presses Start itself, once, and `game_started` fires after the room's countdown. A joiner still sees the room and waits for the host.
- **A game whose multiplayer UI is an overlay in the world** (an F2 or Esc panel, a roster and Leave plate) keeps that plate for the match: the menu hides itself when the match
  starts (`auto_hide_on_start`) and shows again on `returned_to_lobby`, so the game's own in-match roster and Leave button (calling `lobby.leave()`) stay, and the menu is only the
  screen before the match.
- **Settings**: the client's settings and the player id live in `user://onelobby.json` (the game's user-data folder, outside the game folder), not in the game folder.
- **`sync.tickRate` in `--mode raw`**: unused (the game ticks itself); leave the default in `onelobby.json`.
- **Stays hand-built**: the game's session and snapshot code, its wire codec, host migration and rejoin logic (the lobby gives `host_changed` and `resume_token`), its in-world roster, its
  solo start, and anything it adds to the net version at run time (`client.net_version = <its own value>` after `from_config` is the game's own line, not a copy of `onelobby.json`).
- **Old settings**: write the one-time import BEFORE deleting the old storage code, because it needs the old file path and keys (for example `user://settings.cfg`, section `[multiplayer]`, keys `name` and `turn_relay`). Read the old name and relay line once and keep them: `client.settings.save({"name": old_name, "relay": old_line})` returns `{ok, rejected}` (a relay line that
  does not parse is rejected). Then delete the old storage code. If you do not carry them over, say why in the report (existing players start with an empty name and no relay).
- **Names**: `--into` refuses with `name_clash` when a script it adds would take a `class_name` or autoload name the game already has, or when a script makes a node named `Net` at run time (`name = "Net"`, `get_node("/root/Net")`), naming both files; rename the one in the game
  and run again. It never writes a clash. The autoload is `Net` (script `net.gd`, no `class_name`): a game with its own node or autoload called `Net` renames that one (the check reads the scripts' text for `name = "Net"` and `/root/Net`, so a node made another way still needs your own `grep`).
- **Unity, a game that already has multiplayer** (its own `OneLobbyRunner`, replication or wire): `--into` an existing project writes no `.olc` entry (the new-project one builds `OneLobbyBuild.Windows` and runs `Builds/Windows/Game.exe`;
  point your own entry at the game's build, with `--host --local` and `--join=127.0.0.1:47810 --local`) and prints `game.title` came from the folder name: pass `--title '<name>'`.
  - A blueprint you load in code keeps your wire version: `ConfigureConfig = c => c with { NetVersion = <your constant> }` on the runner (the Unity form of `client.net_version = ...`); never copy the other `onelobby.json` values into code.
  - `OneLobbyRunner.Blueprint` set means the runner's `GameId`, `NetVersion` and `Mode` fields are ignored: the blueprint wins; `Blueprint.ToDirectHostOptions(null, name)` gives the host options (port 47810 with 9 fallback ports; a fixed port needs `FallbackPorts = 0`).
  - `PlayerSettings` works without a client: `new PlayerSettings(new PlayerPrefsStore(), gameId)`. It keeps name and relay in one PlayerPrefs key, `onelobby.settings.<gameId>`: copy the old keys once (`PlayerSettings.Save`) before deleting them. The name "Player" counts as no name.
  - Safe to delete once the menu or the client works, in Unity names: the join-code cleaning (`MenuModel.ParseJoin`), the name rules (`SettingsRules.CleanName`: it trims, then clamps, so a cut at a space leaves a trailing space; trim again where it shows), the error texts (`Friendly.DescribeError`), the hand-built host options (`Blueprint.ToDirectHostOptions`), the relay-paste wiring.
  - A game with its own player build leans on verify's in-process `MultiplayerTests` (its `direct` line) instead of the boot check of section 5.
- **An older add-on** in `addons/onelobby/` (an old `PIN` file, a `PIN.json` of an older version, or no pin) is replaced whole by `--into` and by `update`: the dry run says
  `Add-on: <old> -> <new>` and lists every file that goes; files the new add-on does not have are removed, so old and new never mix. Pinned files you edited stop it
  (`local_changes`, each named) until `--force`. Do not delete the old `PIN` or old files by hand; `verify` fails `addon-pin` on a mixed folder and names the command.
