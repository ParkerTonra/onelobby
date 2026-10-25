---
name: onelobby
description: Make a game multiplayer with OneLobby. Surveys the game, writes onelobby.json (the blueprint) with a reason per setting, plans where Host / Join / Browse go in the game's menus, builds it through the engine's recipe and verifies two players headless. Use when the user says "make it multiplayer", "add OneLobby", "add co-op", "host and join", "online play", or edits onelobby.json and wants the game to match.
---

# OneLobby: make this game multiplayer

You turn a single-player game into one that players can host and join, and that keeps working after any server is
gone (players host from their own machine with a join code). The user drives the choices; you propose them with
reasons. One file holds every choice: `onelobby.json` at the game's root. Schema:
`spec/blueprint.schema.json` in the OneLobby repo (shipped as `onelobby/blueprint.schema.json` on npm). Design and the
reasons behind each key: `docs/design/blueprint.md`. API and rules: the OneLobby `AGENTS.md`.

Run the phases in order. Never skip Verify.

## 1. Survey (read only, change nothing)

Find and note, with the file and line that told you:

- **Engine**: browser JS (`web`), browser page served by a Node host (`node-browser`), Godot 4 C# (`godot-csharp`),
  Unity (`unity`), any other .NET (`dotnet`). Godot GDScript, Unreal and others: stop and tell the user OneLobby has no
  client for it yet.
- **Loop**: fixed tick (`setInterval`, accumulator, `_PhysicsProcess`, `FixedUpdate`) or frame-driven
  (`requestAnimationFrame`, `_Process`, `Update`).
- **Determinism**: seeded RNG kept in game state vs `Math.random` / `UnityEngine.Random` / `GD.Randf`; wall clock in
  the sim (`Date.now`, `performance.now`, `Time.time`); iteration over unordered maps or sets; physics engine.
- **Genre and pace**: real-time action, arcade, RTS / strategy, turn-based, long co-op, a world one player runs.
- **Players** the design implies (map slots, spawn points, UI seats), else 4.
- **Menus**: where a "Play together" or "Multiplayer" entry fits (main menu, pause menu, a settings tab).
- **Pause**: the function the Escape / pause menu calls.
- **Settings storage** and the **build and test commands**.

## 2. Propose (write onelobby.json)

Write the full file (every key, defaults included: a file you can read beats a default you have to look up), with a
`"$comment"` beside each non-default key giving the one-line reason from the survey. `"$schema"` points at the
schema of the onelobby version you install: `"./node_modules/onelobby/blueprint.schema.json"` in a JS project; in a C#
project, the `spec/blueprint.schema.json` of the OneLobby release you use (a relative path into a clone, or its raw
GitHub URL at that release tag).

| Key | Choose |
|---|---|
| `engine` | from the survey |
| `sync.mode` | `lockstep` only when the loop is fixed-tick AND the RNG is seeded in state AND the sim reads no wall clock and iterates nothing unordered. `replication` for a real-time C# game whose host owns physics or AI. Otherwise `raw`. |
| `sync.tickRate` | the game's own tick if it has one, else 20 |
| `hosting` | `direct: true` wherever the engine can listen (everything but `web`): that is what outlives the servers. `server: true` for `web`, or when the user has a lobby server URL. Both is fine. |
| `lobby.maxPlayers` | from the survey, else 4 |
| `lobby.listed` | `false` (join by code or link) unless the game wants strangers to find each other |
| `chat.text` | `true` |
| `chat.voice` | `false` unless you can name a reason the game needs it (co-op that needs callouts). Say the reason in `$comment`. |
| `session.hostLeaves` | `end`; `migrate` only with `hosting.server` and a lockstep game that has snapshot/restore |
| `session.hostLeaves` handling | `end` means the game must handle the session ending: JS `sessionEnded` with reason `host_left` (a server lobby whose host leaves, or any direct lobby), C# `SessionEnded`. Show it, return to the menu, keep the board playable offline. |
| `session.pause` | `off` for real-time action (a pause there is griefing) and for short turn-based games (a turn is already a pause); `anyone` for RTS, strategy and long co-op ("life happens"); `host` when one player runs the world |
| `players.identity` | `name`; `anonymous` for games aimed at young players or with no chat |
| `ui.kind`, `ui.entry` | `generated`, with the entry from the survey (a "Play together" panel or menu item). Not `drop-in`: the `<one-lobby>` element does not read onelobby.json yet and carries its own JSON message format (`el.send`, `el.shared`), so it cannot sit beside the game's own bytes. |

Not built yet, but recorded so the game is ready when they are: `session.pause` (the file keeps the choice; nothing
pauses over the network yet), `platforms.*` (Steam, Epic, Discord). Say so in the report.

## 3. Plan

List: the recipe you follow (AGENTS.md "Recipes"), each file you will add or change, where Host / Join / Browse /
lobby settings appear in the menus, and the checks you will run in Verify.

## 4. Approve

If every key in the file is its default (no `$comment` reasons), build without stopping. Otherwise show the proposal
(the Settings table from the Report format below: key, value, why) and the plan, and stop for the user to say go or
edit the file.

## 5. Build

Follow the engine's recipe. Rules:

- **Read the file at runtime, never copy its values into code.** JS: `OneLobby.fromConfig(blueprint, { displayName })`
  (load the JSON with `fetch("./onelobby.json")` in the browser so a hand edit applies on reload; the full browser
  version, with the lobby server setting, is `docs/recipes/js-web.md` section 3). C#:
  `Blueprint.Load("onelobby.json")` then `LobbyClient.FromBlueprint(bp, transport, displayName)`; Unity: the
  `OneLobbyRunner` Blueprint field. Show the voice button only when `blueprint.chat.voice`, the chat panel only when
  `chat.text`, Browse only when `hosting.server && lobby.listed`.
- Generate only what structural keys ask for: the menu entry (`ui.entry`), the Node host script when `hosting.direct`
  on `node-browser`, `Snapshot` / `Restore` when `lockstep` with `lateJoin` or `migrate`.
- The game stays fully playable offline: every lobby call can fail; show the error (`describeError`) and keep running.
- The lobby server URL stays a player setting with the file's value as the default (AGENTS.md rule 5): pass the
  player's value as `fromConfig(bp, { lobbyServer })`; with no address at all, `host()` / `join()` fail with
  `no_server`, which `describeError` turns into words.

## 6. Verify

Run the recipe's "Done when" checks and the testing recipe (`docs/recipes/testing.md`; with no lobby server running,
its in-memory section runs two players in Node with no network): two headless players, a
message each way (lockstep: frames advance and hashes match), the join link if `lobby.joinLink`, and the offline check
(no server: the game still plays and the menu says multiplayer is unavailable). Run direct hosting when
`hosting.direct`. Fix and re-run until each passes or you can name why it cannot run here.

## 7. Report

```
OneLobby: <title> is multiplayer.

Settings (onelobby.json)          Why
  <key>  <value>  <reason, or "default">
  ...

Built
  <file>   <what it does>

Verified
  PASS <check>
  FAIL <check>: <why, what to do>

Next
  - <the one or two things only the user can do: a lobby server URL, a store setting, a netVersion bump rule>
```

Every Settings line is a key the user can change by hand. Never write "works": name the checks that ran.
