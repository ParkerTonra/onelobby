---
name: onelobby
description: Make a game multiplayer with OneLobby in one pass. Surveys the game, asks the scaffolder (create-onelobby) for a recommendation, proposes onelobby.json with a reason per setting, builds with the scaffolder's templates and the drop-in menu, proves it with `create-onelobby verify` and reports. Use when the user says "make it multiplayer", "add OneLobby", "add co-op", "host and join", "online play", or edits onelobby.json and wants the game to match.
---

# OneLobby: make this game multiplayer

You turn a single-player game into one that players can host and join, and that keeps working after any server is gone
(a player hosts from their own machine and shares a join code). The user drives the choices; you propose them with
reasons. One file holds every choice: `onelobby.json` at the game's root (schema: `onelobby/blueprint.schema.json` in the
npm package; design: `docs/design/blueprint.md`). Commands below are `npx create-onelobby ...`; in a clone of the OneLobby
repo run the same as `node clients/js/packages/create-onelobby/bin/create-onelobby.js ...` (after `npm ci && npm run build`
in `clients/js`, then `node scripts/build.mjs` in that package). The scaffolder's own rules are not repeated here: it answers,
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
- **One plain sentence** for the recommender: genre, engine, player count, tick rate. Write "deterministic" only for what the
  survey proved (fixed tick, state-held seed, no wall clock, no unordered iteration), never as a hope.

## 2. Recommend

`npx create-onelobby --recommend "<the sentence>" --json` writes nothing and needs no network. Read the one object:

- `answers`: `[key, value, why]` rows, each a blueprint key; they become the proposal. `shape` names the game type
  (`lockstep`, `coop-snapshots`, `replication`, `turn-based`, `own-server`); keep it for the report.
- `shape: null`: the sentence matched nothing clearly. Answer each of `questions` from the survey where a file and line
  settle it, ask the user the rest, add the `add` words to the sentence and run again. Do not guess a shape.
- `limits`: what this engine's client or template cannot do yet (it wanted X, wrote Y). Tell the user, do not hide it.
- `advice`: `built-in` is a client feature to use; `by-hand` is work the game must do; `depends` waits on the engine.
- `engine.template` `"planned"` or `runCommand: null`: the scaffolder cannot write this engine yet; take the by-hand path (4.5).
- **The survey wins over the sentence.** The matcher reads words and ignores code facts ("deterministic ... calls `Math.random`"
  still gives `lockstep`). When they disagree, fix the sentence ("not deterministic", the real tick rate) and run again; if that is
  not enough, correct a value with a flag (`--mode raw`, `--max-players 2`) or `--set key=value`: a flag beats the recommendation
  and the run lists it under `overridden` / `dropped`. Say each override in the report.

## 3. Propose

Preview, writing and downloading nothing: `npx create-onelobby --into . --template <engine> --recommend "<sentence>" --yes
--dry-run --json` (a new game: `npx create-onelobby my-game --template <engine> ...`). `--recommend` fills in its `answers` by
itself; add a flag only to override one (section 2), not to repeat them. Pass `--template` when you know the engine; without it
`--into` reads the folder (Godot, Unity, .NET or web files) and stops with `engine_unknown` when the folder tells nothing. `--yes` invents the game id `com.example.<folder>`; give the real one with
`--game-id`. The result holds `blueprint` (the file to be written), `files` (added or updated) and `recommendation`.

Show the user a table `key | value | why` (the `why` of `applied` rows, else the survey's reason with file and line), the plan
(the command, the files it adds or changes, where the menu goes and which scene or page opens it) and the `limits`. If every value
is a schema default, build without stopping; otherwise stop for the user's go or edits. After the build, put the reasons in the
file: one key named exactly `"$comment"` in each object (`hosting`, `lobby`, `sync`, ...), holding the reasons for that object's
keys in one string. The loaders ignore that name only; any other spelling (`"$comment tickRate"`) fails as `unknown_key`.

## 4. Build

1. Run the previewed command without `--dry-run`; its "Next:" lines are part of the job. Godot downloads the WebRTC natives once
   (pinned, SHA-256 checked, anonymous; offline: `--webrtc-zip <file>`). Godot C# needs the .NET build of Godot and the .NET 8 SDK,
   and until a release is on NuGet `--packages-from <folder of .nupkg>`. Then `godot --headless --audio-driver Dummy --import --path .`
   (C#: first `dotnet build <the .csproj>`). A second Godot run changes nothing and keeps your `onelobby.json`; web stops with
   `exists`: edit by hand.
2. **Wire the drop-in menu where the survey said** (a new project has it as the main scene). Godot `--into` never edits your scenes:
   instance `addons/onelobby/menu/menu.tscn` (C#: `addons/onelobby_menu/OneLobbyMenu.tscn`) in the menu entry's scene (it is a
   Control; a Node2D scene can hold it as a child). GDScript: give it the client before the menu's own `_ready`, so from the
   parent's `_enter_tree` (`$Menu.client = Net.client`) when the menu sits in the scene file, or before `add_child` when you
   instance it in code (`Net` is the autoload the scaffolder registered). Connect `game_started(lobby)` (start the match),
   `returned_to_lobby` and `left` (end it), keep a way to play alone. Restyle and reword: `docs/recipes/menu.md`.
   **Test on this PC only.** The menu acts on `-- --host` and `-- --join=<code>` by itself, and a plain `--host` opens a port and
   reaches public relays. `--local` (127.0.0.1 only, no Nostr) is read by the GDScript menu itself, with no game code, as long as `boot_flags`
   is on; the C# menu reads it too (no lobby server, no check on open), and the "Next:" line's `OneLobbyNet.Wire(menu, args)` in the
   scene script's `_Ready` gives it the 127.0.0.1 host (`BootFlags` stays on). Never run `-- --host` without `--local`.
3. **Web** `--into` writes `onelobby.json`, `multiplayer/session.js` and `test/multiplayer.mjs` only: no menu (`ui.kind` stays
   `generated`, you draw the buttons; `--ui drop-in` is refused) and no `AGENTS.md`, and a minimal `package.json` only when the folder has
   none (an existing one is never edited: add `onelobby` and `"type": "module"` as the "Next:" lines say, then `npm install`). Put the game behind
   `step(tick, commands) -> hash`, `snapshot()`, `restore(tick, bytes)`, `hash()` and swap it into the test's stand-in `Game`.
   In the page go through `multiplayer/session.js`: `loadBlueprint()`, `makeKit(bp, { displayName })`, `kit.host()` or
   `kit.join(code)`, then `const s = bindSession(lobby, kit.blueprint, game)` before `lobby.start()`; call
   `s.pump(performance.now())` every frame and `s.send(bytes)` when the player acts; the match runs while `lobby.phase` is
   `"in_game"` (`lobby.on("phase", ...)`); keep the old loop for playing alone. A page with no bundler needs the import map of
   `docs/recipes/js-web.md` section 1; the Host / Join / Start buttons and their errors are its sections 3 and 4. The `<one-lobby>`
   element (`menu.md`, "Web") fits only games that sync through its own `send` / `shared`, not through a Lobby.
4. Hand work the template does not cover, after 1 to 3: the game's sim as lockstep frames (`docs/recipes/godot-gdscript.md` section 4b,
   `js-web.md`), replication (`replication.md`), a pause-menu call when `session.pause` is not `off` (`pause.md`), the `by-hand`
   advice. Room (ready, countdown, kick, ban, rematch), saved settings, the connection check and plain-language errors already
   live in the menu and the library.
5. **By hand** (`template_planned`, planned engine, `runCommand: null`): ask the tool, do not assume; its `template_planned` refusal
   names what it builds today. Follow the engine's recipe (`dotnet-generic.md`, `browser-game.md`; Unity is built now: `docs/recipes/unity.md` "One command"), write
   `onelobby.json` yourself against the schema, and say in the report that this path was by hand.
6. Rules that stay: read `onelobby.json` at run time, never copy its values into code (`OneLobby.fromConfig`,
   `OneLobbyClient.from_config`, `Blueprint.Load`); the game plays offline and every lobby call can fail (show `describeError`);
   the lobby server URL is a player setting; bump `game.netVersion` when command bytes change. **Relay list** (only when
   `hosting.nostr` is on; a web game on a lobby server skips this): the scaffolder writes the library's default list unprobed and
   some are dead. In a scratch folder `npm install onelobby`, then run
   `node -e "import('onelobby').then(async m => console.log(JSON.stringify((await m.checkNostrRelays(m.DEFAULT_NOSTR_RELAYS, 8000)).filter(r => r.ok).map(r => r.url))))"`
   (anonymous, random keys) and write the result to `hosting.nostrRelays` with a `$comment` naming the date; offline, keep the default.

## 5. Verify

`npx create-onelobby verify` in the game folder (Godot from `--godot <exe>`, else `$GODOT`, else `godot`; headless, loopback only).
Read the last line: `VERIFY_OK`, or `VERIFY_FAIL <check>: <next step>`. Do that step and run again until `VERIFY_OK`, or until you can
name why a check cannot run here. `--fetch-helpers` (once) fetches the TURN helper anonymously when `turn` says skipped; `server`
runs only with `--server <ws url>` of a lobby server you started. `skipped` is not a pass: list it (a web game always skips
`nostr` and `turn`: two JS clients over real WebRTC in Node need a package the game does not have). `verify` proves the routes, and in `wiring` that some scene or page uses
the menu or the glue (a bare `--into` fails it until you wire the game); it does not run your game, so also boot it (`godot --headless --audio-driver Dummy --path . --quit-after 90`, no flags; web: `node test/multiplayer.mjs`)
and read it for errors, and check **offline**: with no lobby server the game still plays and the menu says multiplayer is unavailable.
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
