# One-shot multiplayer: every core feature by default (0.7.2 phase 2)

Status: plan, 2026-11-15. Nothing here is built yet. Builds on [blueprint.md](blueprint.md) (the `onelobby.json` file,
the scaffolder and the agent skill), which is the right shape but only half built.

**Goal in one line.** A developer (usually through an AI agent) says "make my game multiplayer" once, and the game gets
every feature players expect from an online game, on every engine OneLobby supports, with no second round of "why
doesn't it have X".

**Why now.** Every game that adopted OneLobby so far went through the same loop: set up, notice a missing basic, ask,
iterate. Three games each hand-built the same co-op menu, the same relay paste field, the same settings storage, the same
name rules, the same plain-word errors and the same two-process smoke test; the relay field got built three times in
one day. That code belongs in OneLobby.

---

## 1. What exists today (dev main 3c322db)

Strong: join codes (typo-tolerant), join by IP, STUN/TURN/relay-only, player-pasted TURN parsers, approve/kick,
host settings, lobby browser, rejoin tokens, timeouts, rate limits, host migration (server lobbies), lockstep and
replication (JS/GDScript/C#), voice and text chat (JS/C#), pause (JS/C#), `tools/engine-smoke` (JS, GDScript, C# incl. a local TURN).

Missing or half there:

| Area | Gap |
|---|---|
| GDScript | Voice (needs Opus) is missing (replication landed with package 11); text chat, shared pause and lockstep landed in package 8 (the blueprint loader, `godot-gdscript` engine value, `describe_error` and invite links landed in package 1). The skill names `godot-gdscript` but has no GDScript template yet. |
| Scaffolder | `create-onelobby` builds `web`, `godot-gdscript` (a new project, or `--into` a GDScript project: add-on, natives, PIN file, autoload, menu wiring, headless two-peer test) and `godot-csharp` (a new project, or `--into` a Godot C# project: NuGet package references edited into the `.csproj`, the menu copied in and pinned, natives, direct-hosting wiring, headless two-peer test); `unity` (a new project, or `--into` a Unity project: the `com.onelobby.unity` line edited into `Packages/manifest.json`, a boot script (new projects), a two-peer play-mode test, a player build script, an `.olc` entry); `dotnet` and `node-browser` throw `template_planned`. `create-onelobby update` re-vendors the add-on or menu (PIN-guarded; for C# it also moves the `OneLobby.*` package versions; for Unity it moves the `com.onelobby.unity` line; for `web` it prints the npm line and the glue state) and `create-onelobby verify` proves multiplayer on 127.0.0.1 with one verdict line. `web` refuses `--mode replication` (`unsupported`). |
| UI | The Godot drop-in menu landed in GDScript (`menu.tscn`) and Godot C# (`OneLobbyMenu.tscn` over the engine-free `MenuModel` in `OneLobby.Core`, `docs/recipes/menu.md`); Unity has it too (`OneLobbyMenu` in `com.onelobby.unity`: UI Toolkit controls built in code over `MenuModel`, no prefab; `docs/recipes/menu.md`, "Unity"; proved locally in batchmode, not in CI). The web `<one-lobby>` element draws the same screens (ready, countdown, kick and ban, host settings, join requests, chat, error screen with logs, settings, browse; `docs/recipes/menu.md`, "Web"). |
| Room layer | Landed (`spec/room.md`, `docs/recipes/room.md`): ready, per-player data, seats, spectators, countdown, rematch, name dedupe in JS, C# and GDScript. The GDScript, Godot C# and Unity menus draw it (roster, ready, countdown, kick, ban, unban), and so does the web element. |
| Ban | Per lobby, by IP, forgotten when the lobby ends. No game shows kick/ban in its UI. |
| Settings | Landed (`spec/settings.md`, `docs/recipes/settings.md`): name, relay line (masked view), last code and lobby server are saved on the player's machine in JS, C# (Unity PlayerPrefs, Godot `user://`) and GDScript, applied as defaults, environment override, never logged. The GDScript and Godot C# menus draw the fields (name, masked relay line, lobby server, last code); and so do the web element and the Unity menu. |
| Errors | Plain-language `describeError` exists in JS only. Players never see *why* a connection failed. |
| Verify | No one-command two-peer test for a game; Unity is not in engine-smoke. |
| Recommendation | `create-onelobby --recommend "<one line>"` landed (alone, or filling a scaffold run's answers; `--json` for an agent; five shapes, section 5). The agent skill (`.claude/skills/onelobby/SKILL.md`) calls it with `--json` and explains the answer; it keeps no sync-mode rules of its own. |

Full matrix with file references: kept with the desk notes (not in this repo).

---

## 2. The core list (what "by default" means)

Every item works in JS, C#/Unity and GDScript (Godot C# goes through C#), is on in the drop-in menu, and is a blueprint
key where it is a choice.

**Connecting.** Join code, join by IP or `ip:port`, invite link (and deep link where the platform has one), one join
call that walks the whole route chain (lobby server, then Nostr code, then direct IP; STUN; TURN if set; relay-only
retry), player-pasted relay line, LAN discovery (same-network broadcast), rejoin after a drop with the token saved.
LAN discovery is built in this release as opt-in: off unless the game maker turns it on in `onelobby.json`; then the menu gets a
"LAN games" tab and the game listens only while that tab is open. Typing the host's IP and port keeps working in every game.
Status (2026-11-16): the library half is built in JS (Node), C# and GDScript (`spec/lan-discovery.md`, `hosting.lan`, the host's
answering socket, the finder and its rows; proven on one machine over 127.0.0.1 only). Landed (the menu lane): a "LAN games" list on the
Browse screen of the GDScript, Godot C# and Unity menus (a tab bar when the lobby server list is there too; the finder exists only while
the list is shown; rows with name, host, players, a password mark and a greyed other-version row; a click joins by `address:port`;
`--local` asks `127.0.0.1` only; the web element has no list). Run over 127.0.0.1 only: a two-PC run on a real network, several network
cards, a router that blocks broadcast and the Windows Firewall prompt are still unproven.

**Lobby.** Player names (default name, length clamp, sanitise, dedupe as "Name 2", rename), per-player data (colour,
avatar index, team or seat), ready toggle, host settings (max players, password on every route, listed or private),
lobby browser, approve joins, **kick** and **ban** in the roster with the reason shown to the kicked player, bans that
survive the lobby (host-side list keyed by a per-install player id, IP as fallback), late join policy, spectators,
bots filling empty seats (a seat-dropped hook the game answers with its bot).

**Session.** Start with countdown, auto-start at N players, back to lobby and rematch, pause rules, graceful leave
(`leave_and_flush`), host migration on direct lobbies (GDScript and C#), version gate (`<wire>.<content hash>` helper)
with the refusal reason in plain words.

**Chat.** Text chat everywhere (GDScript has it), voice where the engine has audio capture (JS, C#/Unity, Godot C#),
mute per player, speaking indicator.

**Players in the world (section 7).** Binary packets, smooth remote players, and the player's actions (what they hold,
shooting, melee, jumping, and so on) synced without the game writing any of it.

**Tells the player why (section 4).** Plain cause and next step on screen for every failure, connection check, copyable
logs, the joiner's diagnosis also shown to the host.

**Out of the box.** Saved player settings, drop-in menu per engine, one-command install and update, one-command verify,
`--host` / `--join=<code>` boot flags, loopback bind for tests, fake-network shim, network stats overlay (ping, relayed or
direct, loss).

**Architecture recommendation (section 5).** The skill and scaffolder recommend sync mode, rates and player count from
the game type, each with a one-line reason.

Out of scope for 0.7.2: Steam/Epic/Discord adapters (keys stay accepted, no-op), voice in GDScript (no Opus in pure
GDScript), Unity WebGL/iOS.

---

## 3. Work packages

Each is one lane unless noted; order matters for the first three.

1. **GDScript foundation.** `godot-gdscript` engine in the schema and vectors; GDScript blueprint loader (`OneLobbyConfig`
   from `onelobby.json`); `describe_error` in GDScript and C# matching JS (shared vectors); invite links in C# and GDScript.
2. **Room layer (spec first, then 3 clients).** Spec section + vectors: per-peer metadata, ready, countdown/start,
   auto-start, back-to-lobby/rematch, spectators, seats/teams, name rules, kick/ban reasons, persistent ban list,
   seat-dropped hook, server-lobby password. Then JS, C#, GDScript (2 lanes: spec+JS, then C#+GDScript).
3. **Diagnostics (section 4).** Error-code table in the spec; ring-buffer net log; connection check; joiner report to
   host; crash flush; IP masking. All clients (2 lanes).
4. **Settings store.** Name, relay line (masked), last code, lobby server: `user://` (Godot), PlayerPrefs (Unity),
   `localStorage` (web), env override, never logged.
5. **Drop-in menus.** Godot scene (GDScript and C#), Unity component (`OneLobbyMenu`, UI Toolkit built in code, no prefab; landed), upgraded `<one-lobby>` element. All read
   `onelobby.json`. Name, Host (big code, Copy code, Copy invite), Join (paste, cleaned), roster with ready, kick and ban,
   relay field, connection check, browse (when a server is set), error screen with Copy logs. Plain engine-default look;
   games restyle (a default; a styled look can come later). 2 lanes (Godot, Unity+web).
6. **Tooling.** `create-onelobby` templates `godot-gdscript`, `godot-csharp`, `unity` plus `--into` for existing projects:
   vendor the add-on with natives, `extension_list.cfg`, LF guard (`.gitattributes`), PIN file, autoload or runner,
   `onelobby.json`, olc entry. `create-onelobby update` (re-vendor to a sha or release). `create-onelobby verify`: two
   headless peers on 127.0.0.1 through a local Nostr relay and a local TURN, plus relay-only, one verdict line; Unity
   batchmode where available. 2 lanes.
   Landed (first half, `godot-gdscript` only): `create-onelobby my-game --template godot-gdscript` and `--into <godot project>`. An engine-neutral
   vendoring module (`src/vendor.js`, `src/zip.js`, `src/godot-project.js`: add-on bundled at build time with its repo commit or `--addon-from`, a
   zip reader on `node:zlib` for the webrtc-native release with a pinned SHA-256, `PIN.json` with a SHA-256 per file, managed `.gitignore` /
   `.gitattributes` blocks, an in-place `[autoload]` edit with `autoload_taken`), the autoload `Net`, `onelobby.json`, the menu as the main scene,
   `tests/multiplayer.gd` (two peers on 127.0.0.1, `MULTIPLAYER_OK`), an olc entry; a second `--into` run changes nothing; a C# project is
   `template_planned`. `extension_list.cfg` is not written by the scaffolder: `godot --headless --import` creates it itself once the natives are there.
   CI: `clients/gdscript/scaffold-test.sh` in the `gdscript` job. Second half landed (`godot-gdscript` and `web`): `create-onelobby update` (PIN-guarded re-vendor: changed / added / removed files listed, `--force` for edited ones, natives only when their pinned version moved, `no_pin` names `--into`; `web` prints the `npm install onelobby@^x` line and whether the glue differs) and `create-onelobby verify` (checks `godot`, `addon-pin`, `natives`, `blueprint`, `direct`, `nostr`, `turn`, `server`, one verdict line `VERIFY_OK` / `VERIFY_FAIL <check>: <next step>`; a built-in loopback Nostr relay, a local TURN server from the `node-turn` helper loaded only when it runs, `--fetch-helpers` to get it). CI: `scaffold-test.sh` also plays the `.olc` entry as two headless processes and runs `verify` (OK, and FAIL on a broken `onelobby.json`). Third part landed (`unity`, proved locally only: Unity is not in CI because CI has no licence): `--template unity` and `--into`, `--package-from <tgz>` (a `file:` reference; the package is not on a registry yet), `--unity <exe>`, `update` (moves only the package line), `verify` (checks `unity`, `package`, `blueprint`, `wiring`, `direct`, `nostr`, `turn`, `server`; each Unity run is `-batchmode -nographics`; the routes go through `Assets/OneLobby/Tests/MultiplayerTests.cs` with `--route=...` arguments) and `clients/unity/scaffold-test.sh` (local only). Not done: web `nostr`/`turn` checks (need node-datachannel). The Unity editor opens its own ports in every run, whether or not OneLobby is in the project: it listens on TCP and UDP ports on all interfaces (0.0.0.0) and connects out to Unity's own licence, package and services hosts. OneLobby's own sockets in the test and in `--local` players are on 127.0.0.1 (and ::1). Run locally with Unity 6000.2.7f2 on Windows: the scaffolded test (`MULTIPLAYER_OK`), the player build with no scene, two built players with `--local` (both log `Lobby: 2 players: Host, Joiner`), all eight `verify` checks, a real `update`, and `scaffold-test.sh` end to end.
   Landed (`godot-csharp`, the third lane of package 6): `create-onelobby my-game --template godot-csharp` and `--into <Godot C# project>`. A C# game takes `OneLobby.Core`, `.Godot` and `.Direct` from NuGet (`--packages-from <folder>` points at a folder of `.nupkg` files and writes a `nuget.config`, for the time before a release), so only the menu (`addons/onelobby_menu/`, `PIN.json`) is copied in; the `.csproj` is edited in place (`src/csproj.js`: adds once, keeps every other byte, refuses a file it cannot read); `OneLobbyNet.cs` gives the menu its `HostDirect` / `JoinDirect` (`OneLobby.Core` cannot reference `OneLobby.Direct`) and honours `--local`; `tests/MultiplayerTest.tscn` is the two-peer test (`MULTIPLAYER_OK`) and also how `verify` runs its routes inside the game's own assembly (a hidden `.onelobby/` folder is left out of the build); `update` moves the menu and the package versions; `verify` checks `godot` (.NET build), `dotnet`, `menu-pin`, `natives`, `blueprint`, `direct`, `nostr`, `turn`, `server`. CI: `clients/dotnet/scaffold-test.sh` in the `gdscript` job (the .NET build of Godot, pinned and cached) plus the demo's `MenuSelfCheck` (`MENU_OK`). Found on the way and fixed afterwards: `OneLobby.Godot` did not enforce relay-only on Godot 4.7.2 (.NET) (webrtc-native ignores `iceTransportPolicy`); it now filters candidates like the other transports (shared `RelayCandidates` in `OneLobby.Core`), and `verify`'s `turn` check fails when the TURN server sees no relayed packets.
7. **Architecture recommender** (section 5) in the skill and `create-onelobby --recommend "<one-line game description>"`.
   Landed (the `create-onelobby` half): a deterministic matcher over the sentence, rules as data in `src/recommend-data.js` (the shape ids are the first column of the section 5 table; a test keeps them in step), engine-aware (it never promises prediction or hit rewind outside the C# layer, or `replication` for the `web` template), text and `--json` (field names documented in the package README), and as defaults for a scaffold run (flags, then `--from`, then the recommendation, then the built-in defaults; one first question on a terminal). The skill half landed with package 9. The key for who decides a player's movement is `sync.player.authority` (package 12): the `replication` shape proposes `host`, `coop-snapshots` proposes `owner`, the others nothing, and prediction and hit rewind count as built in for the JS engines now.
8. **GDScript sync helpers.** Text chat, shared pause, a lockstep helper with the fast-channel input pattern (section 5).
9. **Skill rewrite.** Accept GDScript; one pass: survey, propose `onelobby.json` with reasons, build with the templates and
   drop-in menu, verify with `create-onelobby verify`, report. Fix stale lines (pause exists).
   Landed: `.claude/skills/onelobby/SKILL.md` rewritten: survey (with the one sentence for the recommender), `--recommend --json` (the survey wins over the sentence, corrected with a clearer sentence, a flag or `--set`), propose from `--dry-run --json`, build with the templates and the drop-in menu (by hand only for `template_planned` engines), `create-onelobby verify`, report with the shape id and any override. Closed by the scaffolder-gaps lane: `--into` with no `--template` reads the folder (.NET stops as `template_planned`, an unreadable folder as `engine_unknown`); `verify` has a static `wiring` check; a `web` `--into` writes a minimal `package.json` and says what to do next; `--help` lists the built templates from one list; the GDScript menu reads `--local` itself. Still open: a `web` `--into` has no drop-in menu.
10. **Proof (section 6)**, then move the existing games onto the drop-in pieces where it removes their own code.
11. **Binary by default (section 7.1).** Shared codec spec + vectors; JS and GDScript encoders matching the C# bit-packer;
    every snapshot, input and event path uses it; JSON only behind a debug switch. 2 lanes (spec+JS, GDScript).
    Landed (JS and GDScript, both lanes): `spec/replication.md`, `ReplicationSession` in `onelobby`, `OneLobbyReplicationSession` in the GDScript
    client (codec, session, stream receive, packet log, `sync.mode: replication` valid for every engine), reliable keyframes, `describe` debug
    view, bytes per second stats, vectors incl. the stream receive group, engine-smoke `--replication` over all nine js/gd/cs pairs. Lockstep and
    chat stay on their own codecs. Not in 11: prediction (`Reconciler`, `HistoryRing`) outside C#, repeating one-shot events on `fast` (7.2-7.4 are package 12).
12. **Networked player (sections 7.2-7.4).** The player preset (state + action events), smoothing and prediction, the
    Godot node and the Unity component that read the character and animator with no game code. 2 lanes (Godot, Unity+JS).
    Landed (the first lane, JS only): `spec/net-player.md` and `spec/vectors/net-player.json` (the state, the input preset, the 12 action events, the
    kind 5 message), `sync.player` in the three blueprint loaders (`authority` owner or host, `space`, `range`, `velocityRange`, `limits`, `omit`; rule
    `player_needs_replication`), and in the JS client `NetPlayers` (docs/recipes/net-player.md): both authorities (owner: the state travels as the bytes of the
    input; host: the input preset and the game's step function, with `Reconciler` and `PredictionSmoother` ported from C#), the host's limits, smooth remote
    players (adaptive render delay 2 snapshot intervals to 250 ms, carry-on by velocity for at most 250 ms, shortest-arc yaw, teleport counter), action events
    that arrive exactly once (4 repeats on `fast` plus one `reliable`, dropped by sequence number), `HistoryRing` hit rewind, players that come and go with
    their peers. Proven only on the in-memory rig (100 ms, 20 ms jitter, 3% loss, and 30% for the events); no real link, no real engine, and nobody has seen
    it on a screen. Next: the Unity component and the C# code (a lane), from the spec and its
    vectors; not built: your own extra fields and events in `onelobby.json`, an adapter for a JS game engine, section 8 item 3 (a dropped player stays
    visible: today it is despawned at once and a rejoin starts a new player).
    Landed (the GDScript lane, Godot node): `OneLobbyNetPlayers` (the layer: a port of JS `NetPlayers`, same names in snake_case and the same order of
    operations), `OneLobbyPlayerCodec` and `OneLobbyPlayerWire` (the preset and kind 5: every case of `spec/vectors/net-player.json` passes in both
    directions), `OneLobbyReconciler`, `OneLobbyPredictionSmoother`, `OneLobbyHistoryRing`, the session additions (adaptive render delay off by default,
    the kind hook, per-peer byte counters), and section 7.4 for Godot: the `OneLobbyNetPlayer` node under a `CharacterBody2D` / `CharacterBody3D` /
    `Node2D` / `Node3D` (owner: reads the parent and the values the game sets; host authority: input plus the game's step function and the smoothed
    correction; everyone else: writes the smoothed state into the parent; one signal per action event; an `AnimationPlayer` by mode name or an
    `AnimationTree` by a parameter map), `OneLobbyNetPlayerSpawner` (one character per seated player, the local one marked), and a sample that moves
    (`clients/gdscript/examples/net_player_demo`). Proven on the replication rig with the same scenario as JS (D1 to D9, `tests/net_player.gd`), in a
    scene tree on the rig (`tests/net_player_node.gd`), and, in CI only (it needs the WebRTC natives), by two headless processes of the sample on
    127.0.0.1 (`net-player-test.sh`: the joiner's path and one jump reach the host). Nobody has seen it on a screen, the smoothing numbers are the plan's,
    and no real link has carried it. Not built: the JS-to-Godot player scenario in `tools/engine-smoke` (needs a `--players` scenario in both peers).
    Landed (the C# lane, part 3a: the player layer only): `NetPlayers`, `PlayerCodec`, `PlayerWire` in `OneLobby.Replication` (same wire and numbers; states, inputs and event
    arguments are structs; no engine type), the session additions (`AdaptiveDelay`, `InterpolationDelayMs`, `JitterMs`, `RegisterKind` / `SendExtension`, per-peer
    `TrafficWith`, state schemas for `TrySampleAt` / `TryGetLatest`), every case of `spec/vectors/net-player.json` in both directions, and D1 to D9 on the C# `Rig`
    (`NetPlayerTests`, `NetPlayerHostTests`). In-memory only: no two processes and no real link have carried it, no game engine has run it, nobody has seen it
    on a screen. Not built (part 3b): the Unity `NetPlayer` component, a spawner, a sample, and the JS-to-C# trace test.
    Landed (the Godot C# lane, part 3c): `OneLobbyNetPlayer` and `OneLobbyNetPlayerSpawner` as an add-on folder of the demo project (`addons/onelobby_net_player/`, `[GlobalClass]`;
    a node class in a referenced assembly cannot be attached to a scene), with the same exports, properties, methods and signals as the GDScript node in PascalCase, and a sample
    that moves (`NetPlayerDemo.tscn`). Proven in one headless Godot process on an in-memory network (`--netplayer-selfcheck`, run by `scaffold-test.sh` in CI); the
    two-process script (`net-player-test.sh`) has never run (no CI step fetches the natives for the demo project). Nobody has seen it in a window, the smoothing numbers are the
    plan's, no real link has carried it. Not built: the scaffolder's `godot-csharp` template does not offer the node yet.
13. **The section 8 defaults** that survive review, folded into packages 2, 5 and 12 where they fit.

Estimate (a guess): about 17 lanes. Today's lanes took 6 to 50 minutes each, so roughly a day of agent time at 2 lanes.
Built after phase 1 lands in the games.

---

## 4. Tell the player why

Most games hide connection failures behind "Failed to connect". The cause (strict NAT, a firewall prompt that was
dismissed, a relay that refused the login, a version mismatch) is in a log the player never sees. OneLobby has the
information at every step, so it shows it.

1. **On the failing player's own screen, first.** Every failure maps to a stable code and a plain sentence with the next
   step. Examples:
   - `nat_blocked`: "Your network blocks direct connections (strict NAT). Paste a relay line in Settings, or ask the host
     to." Shown when ICE gathered no reflexive candidate that worked and no relay was set.
   - `relay_refused`: "The relay rejected the login. Check the relay line; it may have expired."
   - `udp_blocked`: "Your network blocks UDP. Godot games can only use a relay over UDP; try another network."
   - `firewall`: "Windows Firewall may be blocking this game. Allow it on Private networks." (Host side, when nothing ever
     reached the listener.)
   - `version_mismatch`: "You have version 1.4, the host has 1.5. Update the game."
   Each screen has **Copy logs** and **Save logs**.
2. **The host sees it too.** When the direct link fails, the signaling path (lobby server or Nostr) still works, so the
   joiner sends its diagnosis to the host it dialed: "Sam: strict NAT, no relay set, stopped at the connection check
   after 15 s." Only to that host; nothing goes anywhere else.
3. **Connection check** in the menu before playing: NAT type from two STUN servers, UDP reachable, relay reachable and
   login accepted, and the result in one line ("Direct connections: likely to fail. A relay is recommended."). The check runs when
   the co-op menu opens; a game can switch it to "button only" in `onelobby.json` (`diagnostics.checkOnOpen`).
4. **Net log.** A ring buffer of every connection step with timings (state changes, candidate types, chosen route, errors,
   versions, OS). Written to the player's user folder, flushed on a crash or quit. IP addresses masked by default.
5. **No harvesting.** Nothing is sent to OneLobby or any server we run. The log stays on the player's machine or goes to the
   host they joined.

Done when: a joiner behind a simulated strict NAT with no relay sees `nat_blocked` on their own screen within the ready
timeout, the host sees the same line, and Copy logs gives a log that names the cause, all from a test on 127.0.0.1.

---

## 5. Architecture recommendation by game type

From what the games actually ended up with (several changed after setup; the recommender skips those detours).

| Id | Game shape | Recommend | Why |
|---|---|---|---|
| `lockstep` | Fixed-tick, deterministic, small inputs (party minigames, RTS on a seeded sim) | Lockstep; inputs on the fast channel with the last N ticks repeated, adaptive input delay, state hash every ~60 ticks, bots take dropped seats | A reliable ordered input channel stalled one game about half its frames at 80 ms and 2% loss; redundancy on the fast channel fixed it |
| `coop-snapshots` | Free-roam co-op with rich state (survival, sandbox) | Host-authoritative snapshots, ~10-20 Hz, joiner predicts its own actions, binary deltas against an acked baseline once state passes ~3 KB, reliable keyframe every few seconds | Whole-state JSON at 10 Hz outgrew the link in one game |
| `replication` | Shooters and physics in a non-deterministic engine (Unity) | Replication (host authority, interpolation, owner prediction, hit rewind capped ~350 ms), 30 Hz sim / 20 Hz snapshots | Unity physics isn't deterministic, so lockstep is out |
| `turn-based` | Turn-based, card, board | Raw messages, host is truth, no tick | Nothing to sync between turns |
| `own-server` | An existing server-style game | OneLobby as a WebSocket transport (`asWebSocket`) | Keeps the game's own server loop |

Player count from the design (2-4 default, 8 for party games, spectators separate). Hosting: direct with Nostr codes
everywhere the engine can listen (games outlive any server), lobby server optional.

Who places a player is decided by the game type: the player's own PC for co-op, the host for competitive, and the player's own PC when
a game does not say; the game maker can overrule it in `onelobby.json`. Host-decides is built in every engine in this release, last.

---

## 6. Proof

1. An agent with only the skill, told "make this multiplayer", gets a fresh Godot GDScript game, a fresh Unity game and a
   fresh web game to a passing `create-onelobby verify` in one pass, with no manual steps.
2. The same on a copy of an existing game that already had hand-built multiplayer: the drop-in pieces replace its menu,
   relay field, settings and smoke test, and its own tests still pass.
3. The section 4 "Done when" test.
4. engine-smoke stays green, plus Unity in batchmode where the runner has it.

5. The section 7 "Done when" test.

0.7.2 ships after phase 1 (network routes, already merged and adopted) and this phase both pass, in one release.

---

## 7. Players in the world by default

Today a game gets a pipe and writes its own player sync: what to send, how to pack it, how to hide lag. Every game that
did it hit the same problems (JSON outgrowing the link, remote players stuttering, a jump or a shot that never showed
up on the other screen). OneLobby ships the answer.

### 7.1 Binary packets

- One wire codec for all three clients, spec'd with shared vectors: bit-packed, quantised (positions to ~1 cm in a
  game-set range, angles to 16 bits, velocities to 8-12 bits), booleans as single bits, small ints as varints.
- Deltas against the last baseline the receiver acked; a reliable keyframe every few seconds and on late join.
- Inputs and one-shot events ride the fast channel with the last few ticks repeated, so one lost packet costs nothing
  (the lockstep lesson in section 5).
- JSON stays available behind a debug switch for reading packets by eye; the net stats overlay shows bytes per second
  both ways.

### 7.2 Smooth remote players

- **Remote players:** snapshot interpolation, rendered a short delay behind (two snapshot intervals, grown on jitter,
  shrunk when the link is calm). Short gaps are extrapolated for at most ~250 ms, then the player holds still rather
  than flying off. A teleport flag (respawn, portal) snaps instead of sliding across the map.
- **Own player:** moves at once (owner prediction); when the host corrects it, the correction is blended over ~100 ms
  unless it is larger than the teleport threshold.
- **Clock:** a shared session clock (ping-based offset, smoothed) so every peer agrees on tick times and countdowns.
- **Rotation and aim** interpolate on the shortest arc; animation follows the interpolated state, never raw packets.

### 7.3 What every player sends by default (the player preset)

State, sent every snapshot (only what changed):
position, velocity, facing (yaw), aim (pitch), on-ground, movement mode (idle, walk, run, crouch, jump, fall, swim, climb,
fly), held item or slot, aiming down sights or blocking, health and alive, team or colour.

Action events, each with its tick so the other screens play it at the right moment:
jump, land, shoot (with aim direction), melee (with swing id), reload, use or interact, item switch, throw, hit taken,
death, respawn, emote.

The game can add its own fields and events in `onelobby.json`, and remove any it does not need.

### 7.4 No game code for the common case

- **Godot:** a `NetPlayer` node. Put it under a `CharacterBody2D` or `CharacterBody3D`; it reads the body and the
  `AnimationTree` / `AnimationPlayer` on the owner's machine and drives them on everyone else's. Signals for each
  action event (`shot`, `melee`, ...) so the game plays its own sounds and effects.
- **Unity:** a `NetPlayer` component that does the same with a `CharacterController` or `Rigidbody` and an `Animator`
  (parameters mapped by name), built on Replication.
  *Landed (Unity):* `OneLobbyNetPlayer` and `OneLobbyNetPlayerSpawner` in `com.onelobby.unity` (`docs/recipes/net-player.md` section 12): C# events per action event, a `CharacterController` switched off and a `Rigidbody` made kinematic on a character the component places, an `Animator` map by name, 2D by `sync.player.space`, a sample that moves (`Samples~/NetPlayer`). Proven in one editor process on an in-memory network and by two built players on one PC (`clients/unity/net-player-test.sh`, local only: Unity is not in CI).
- **Web:** the same preset in JS, with an adapter for the common engines added as games need them.
- Host authority stays: the host checks movement speed and fire rate against the game's limits and corrects the player,
  and hits are judged on the host with the existing rewind.

Done when: two headless peers on 127.0.0.1 behind the fake-network shim (100 ms, 20 ms jitter, 3% loss) show the remote
player's path within a set error of the owner's path with no frame of standing still longer than the extrapolation cap,
every jump, shot and melee arrives exactly once at the right tick, and bytes per second stay under a per-player budget.

---

## 8. More defaults before the freeze (proposed)

Each of these is something players expect and at least one game would otherwise write by hand. Proposed as default
unless noted.

1. **Late join gets the whole world.** A joiner mid-match gets a keyframe of every networked object, not only players.
2. **Networked objects and ownership.** Spawn and despawn by id, ownership handoff (pick up an item, enter a vehicle),
   host decides conflicts.
3. **Dropped player stays visible.** During the rejoin window their character freezes with a "reconnecting" tag
   instead of vanishing; a bot or the host takes over after it if the game set one.
4. **Name tags.** Name above each player, speaking icon, ping colour; one toggle off.
5. **Scoreboard with ping.** Hold Tab (or the platform's button): names, ping, team, host's kick and mute.
6. **Bandwidth priority.** When a link is tight, nearer and more important players and objects update first and far
   ones less often, instead of everyone stuttering.
7. **Desync detector.** For lockstep and replication, a periodic state hash; on a mismatch, the log names the tick and
   the first object that differs.
8. **Host sanity limits.** Speed, fire rate and teleport distance checked on the host (section 7.4). Basic protection
   from cheats and glitches, not a full anti-cheat.
9. **Quick chat and map ping.** "Over here" pings and a few canned lines, so players can talk without typing (optional,
   off by default).
10. **Name and chat filter hook.** A hook for the game's own word filter; nothing filtered by default.

Not proposed: local split-screen, saving a co-op world (game-specific), matchmaking by skill (needs a server we run).
