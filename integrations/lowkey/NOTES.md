# Lowkey Industries on Keepalive: exact change list (DESIGN.md s.14 expanded)

Read against Lowkey `master` at `6b233bf3` (2026-10-23), read-only. Line numbers are that commit's; symbols are the stable handle.
Nothing here is applied: the desk adds pointers and decides what lands. Items marked **[design first]** are direction changes:
Lowkey's CLAUDE.md says write them in its DESIGN.md and wait for the designer before code.

Companion files: `hash-cost.md` (measured `StateHash()` cost), `codec/` (`LowkeyCommandCodec` + a round-trip test over all
180 Command types), `build-sim.sh` (builds Lowkey's Sim into `.lowkey-sim/` here without touching the Lowkey repo).

## 0. Lowkey rules this must not break

- **Pure Sim.** `src/LowkeyIndustries.Sim` has zero Godot references and now also zero Keepalive references. All networking
  lives in `game/` (the Godot project) and a new Godot-free helper folder; the Sim only gains data (seats) and one new
  `Enqueue` overload.
- **Every action is a Command through `Simulation.Enqueue`.** Peers' commands arrive as frames and are enqueued exactly as a
  local click would be; there is no second path (no direct state pokes for "remote players").
- **Determinism.** In-state RNG only, ordered collections (`List`/`SortedDictionary`), new state in `WorldState`. Seat data is
  state, so it is hashed and saved. Nothing in the Sim may read a peer id, a clock or a socket.
- **No fast-forward (golden rule).** In a lobby the host's frame clock is the only clock. Sleep stays the one skip (see 6).
- **Names are data.** Display names come from data (`{person:hashi}` tokens). Lobby UI strings are plain UI text, but a
  peer's chosen display name is user input: never feed it into a `{person:...}` token or a dialog line, and never put a Goal E
  person/org/drug/mark name in a C# literal (`NamesAreDataTests`). Never reintroduce the name "Dez".
- **Tunables in `game/data/*.json`.** The lobby server default, tick rate, hash interval, max players live in a new
  `game/data/net.json`, not in C# constants.
- **Bots use commands only.** `UnplugBot` stays single-player; `Main.Send` already returns early in `BotMode`.
- **Dialog / UI style.** No new character dialog is needed. UI: stylized game UI, icons with hover names via `TooltipLayer`,
  no soft shadows or pills. Sound code-only (the voice output bus is code, no audio assets).
- **Co-op, not PvP; police are never fought.** Nothing here changes combat; shootouts stay a Sim system.

## 1. Facts about Lowkey today (what the list below is built on)

| Fact | Where |
|---|---|
| `Simulation.Enqueue(Command, CommandSource)` appends to `_pending`; `Tick()` first runs `ApplyPending()` (in order), then the step | `Simulation.cs:334`, `Simulation.Tick.cs:8,27` |
| A scene stretch stops the world clock: `Tick()` returns before `State.Tick++`, so **`State.Tick` is not the frame number** | `Simulation.Tick.cs:12-15` |
| `StateHash()` = `Fnv1a(Save())`, `Save()` = JSON of `WorldState` (commands/logs are not in it) | `Simulation.cs:310-312` |
| `Command` is `[JsonPolymorphic("$cmd")]` with 180 concrete types, each with a `[JsonDerivedType]`; `Json.Options` is the shared serializer | `Commands/Commands*.cs`, `Core/Json.cs` |
| `CommandSource` {Unspecified, Player, Bot, Scene, Dev}; `For()` forces Dev for any `Dev*` command | `CommandSource.cs` |
| `Main.Send(Command)` is the UI's one entry: `Sim.Enqueue(c, CommandSource.Player)` (534 call sites go through it, plus ~60 direct `Sim.Enqueue` in views and probes) | `game/Scripts/Main.cs:494` |
| The tick loop: `_accum += delta * TicksPerSecond * scale`, `while (_accum >= 1 ...) Sim.Tick()`, 25 ms frame budget, scale 600 while `IsFastForwarding` | `Main.cs:567-589` |
| One `PlayerState` at `WorldState.Player` (`State.Player` 23 uses in src, 236 in game, 821 in tests; `S.Player` 451 in src) | `State/WorldState.cs:48,192` |
| `Moved` (avatar tile report) is a Command, sent by Godot on tile change; it is how the Sim knows where the player is | `Commands.cs:228` |
| `Sleep` sets `State.FastForwardUntil`; the Godot loop runs 600x while it is set; `FinishFastForward` autosaves | `ProgressionSystem.cs:193`, `Simulation.Tick.cs:106` |
| Save/load: `Simulation.Load(content, json)` (+`Migrate`), `PeekScenario(json)`, `SaveVersion = 3`; scenario id is in the save | `Simulation.cs:215,222,236` |
| New game seed is wall clock (`Time.GetUnixTimeFromSystem()`) unless `--seed` | `Main.cs:251` |
| Existing proof of replay determinism: log round-trips through JSON, replayed on a new sim, `StateHash` equal | `BotPlaythroughTests.cs:~211-221` |
| Pause (`Paused`, `GetTree().Paused`) stops the loop; menus use it | `Main.cs:52,567` |

## 2. Change list

Order is the order to build in. Each row: file + symbol, change, why.

### 2.1 Wire layer (no Sim change, no design question)

| # | File / symbol | Change | Why |
|---|---|---|---|
| 1 | `game/LowkeyIndustries.csproj` | Add `PackageReference`/`ProjectReference` to `Keepalive.Core` and `Keepalive.Godot` (stream D). Do NOT add them to `src/LowkeyIndustries.Sim.csproj`. | Keeps the Sim pure; the test project (which references only the Sim) keeps compiling. |
| 2 | `game/Scripts/Net/LowkeyCommandCodec.cs` (new, copy of `integrations/lowkey/codec/src/LowkeyCommandCodec.cs`, namespace changed to `LowkeyIndustries.Game.Net`) | `Encode(Command) -> byte[]`, `Decode(ReadOnlySpan<byte>) -> Command` (throws `CommandCodecException`), `TryDecode`, `IsDev`. `System.Text.Json` with `Json.Options`, always serializing as the base type so `$cmd` is written first. | Zero new serialization: it is the replay log format Lowkey already round-trips. Verified for all 180 types (codec test). |
| 3 | `game/Scripts/Net/NetSession.cs` (new, Godot-free where possible) | Owns `LobbyClient`/`Lobby`, the seat map, the host-side validation, `Pump()` each frame, and the `Snapshot`/`Restore` delegates (see 2.4). | One place for all net state; `Main` only asks it "is there a frame?". |
| 4 | `game/data/net.json` (new) + loader in `ContentDb`-free game code (`Settings`-style) | `{ "gameId": "com.lowkeyindustries.lowkey", "lobbyServer": "wss://lobby.keepalive.example", "tickRate": 20, "hashEveryTicks": 20, "maxPlayers": 4, "minPlayers": 2, "chatMaxChars": ... }` | Tunables in data. `tickRate` must equal `Sim.B.TicksPerSecond` (assert at lobby start). |
| 5 | `game/Scripts/Settings.cs` (`Data`, load/save near line 68-93) + `DevFlags.cs` flag table (~line 121) | New setting `LobbyServer` (string, empty = `net.json` default), persisted in `settings.json`; flag `--lobby-server=<wss url>` (`V("Run", "--lobby-server", "URL", "lobby server override", false)`, not `ImpliesGame`) beating the setting. Settings page gets a text field and a "reset". Add `PlayerName` setting (the Keepalive `DisplayName`). | DESIGN s.6/s.13: self-hosters point Lowkey at their own server; priority flag > setting > data. Headless/agent runs already use `settings_agent.json` so they never touch the designer's file. |
| 6 | `game/Scripts/Net/NetVersion.cs` (new) | `NetVersion = $"{Simulation.SaveVersion}-{scenarioId}"`, e.g. `"3-unplug"`; passed as `KeepaliveConfig.NetVersion` and put in lobby `Meta` with `scenario`. Compare on Browse before showing Join. **Add a command-set component:** bump a `NetProtocol` int in `net.json` whenever a Command is added/renamed (`CommandRegistryTests` Golden list already fails on those: put the bump in that test's failure message). Optional taste call: append an 8-hex hash of `game/data/**/*.json` so a data-patched client cannot join. | s.14: a patched client must not meet an unpatched host. `SaveVersion` alone misses command-set and content drift (the Sim's deterministic output depends on content JSON). |

### 2.2 The tick loop and `Main.Send` (the core of the integration)

| # | File / symbol | Change | Why |
|---|---|---|---|
| 7 | `Main.cs:494` `Send(Command c)` | If `Net.InLobby`: `Net.Lobby.Lockstep!.Submit(LowkeyCommandCodec.Encode(c))` and **do not** `Sim.Enqueue`. Else unchanged. Dev* commands in a lobby are refused locally (`IsDev`) except under an explicit dev switch on the host. | The local player's own command must also come back through a frame, so it applies on the same tick on every peer. |
| 8 | ~60 direct `Sim.Enqueue(` sites outside `Send` (`SceneDirector.Proposal*.cs`, `WorldView.Outskirts.cs`, `HudCams.cs`, `GuideBook.cs`, `Hud.cs`, `YardChaseView.cs`, `StreetView.Shootout.cs`, `NosyCamera.cs`, `AgentInput.cs`, `Main.cs:266`) | Route every non-Dev one through `Send` (or a `Net.Submit`), so none can bypass lockstep. Dev/probe/demo sites are single-player-only and stay (guard: `Net.InLobby` throws in debug). Add a test or grep guard: no `Sim.Enqueue(` in `game/` outside `Main.Send`, `NetSession` and Dev probes. | A command that skips lockstep desyncs the lobby on the first hash check. |
| 9 | `Main.cs:567-589` tick loop | Replace the `_accum` accumulator, **in a lobby only**, with the Keepalive loop: `lobby.Pump(); while (n < max && ls.TryNextFrame(out var f)) { foreach (var (peer, bytes) in f.Commands) { if (!Codec.TryDecode(bytes, out var c) \|\| Codec.IsDev(c)) { log; continue; } Sim.Enqueue(c, CommandSource.Player, seat: Net.SeatOf(peer)); } Sim.Tick(); if (f.Tick % hashEvery == 0) ls.ReportHash(f.Tick, Sim.StateHash()); n++; if (sw.ElapsedMilliseconds > 25) break; }`. Keep the 25 ms budget; `ls.FramesBuffered > 2` means catch-up: skip rendering extras. Time scale is forced to 1 and `--timescale` is ignored in a lobby. | s.11.1 loop. The host (Keepalive) emits frames at 20/s and assigns each command its tick, so the Sim never runs on `delta`. |
| 10 | same loop: **hash key is `f.Tick`, not `Sim.State.Tick`** | `State.Tick` stops advancing during a scene stretch (`Simulation.Tick.cs:12`) so two frames can share a `State.Tick`. | The easy bug: reporting `State.Tick` would report the same tick twice during a scene. |
| 11 | `Main.cs` `Paused` (line 52) and the pause menu | In a lobby, opening a menu must not stop the Sim: set a `MenuOpen` flag instead of `GetTree().Paused = true`, and keep ticking frames (the avatar is simply idle). | A shared clock cannot pause for one player. A "pause" is only a local overlay; leaving the lobby is the real stop. |
| 12 | `Main.cs:673` `TickAutosave` / `AutosaveAllowed`, `_Notification` close-save | Host autosaves as today; joiners do not autosave the shared game (they may save a "co-op copy" slot named from the lobby code, later). Closing the window in a lobby does `LeaveAsync` first. | A joiner's save would be a stale shadow of the host's. |
| 13 | `Simulation.Enqueue` overload (`Simulation.cs:334`) | `Enqueue(Command c, CommandSource source, int seat)`: `_pending` becomes `(Command, CommandSource, int Seat)`; `ApplyPending` (`Simulation.Tick.cs:27`) sets `ActingSeat = seat` for the duration of `Apply(c)` and resets to `LocalSeat (0)`; `LoggedCommand` gets `Seat` (omitted when 0 so old logs read the same). The seat comes from the transport (`Frame.Commands` peer id mapped through the seat table), **not** from the command payload. | A peer id in the payload could be spoofed; the host stamps the peer. Seat lives in the Sim as plain int state, no Keepalive types. |
| 14 | `FinishFastForward` autosave line (`Simulation.Tick.cs:106-109`) | Already pure state (`LastSaveTick`, an event). Keep; just confirm `Ev.Saved` text ("Game saved") is not misleading for joiners (data string). | Hashed state must be identical; it is. |

### 2.3 Per-peer players on one shared business (co-op, 2-4 players) **[design first]**

This is the real work. Today `WorldState.Player` is the one and only person; ~900 call sites in src + game (`State.Player`,
`S.Player`, `.Player.`) mean "the player" (counts above; tests another ~1,700). The shape proposed:

```
WorldState
  Seats: List<SeatState>          // index = seat 0..3, stable for the whole game
  Players: List<PlayerState>      // same index as Seats; today's PlayerState minus the shared fields
  Business: BusinessState         // new; the shared wallet and progression (below)
  [JsonIgnore] Player => Players[ActingSeatOrLocal]   // compatibility accessor for the first pass

SeatState { Slot, Joined, Away(bool), Colour(id) }   // NO peer id here: peer ids are session-scoped and change on migration
```

* **Seat vs peer.** Keepalive peer ids are per-lobby-session and the host can migrate; seats are the game's own identity.
  `NetSession` keeps `peerId <-> seat` (assigned by the host in join order, persisted in the host's snapshot meta, re-claimed
  by `ResumeToken` or by display name on `RejoinAsync`). The Sim only ever sees `seat`.
* **Per-seat (the person):** `Location`, `TravellingTo`, `ArriveTick`, `LastMoveTick`, `Inventory`, `PocketTier`, `Weapon`,
  `CraftQueue`, `Gather`, `BusyUntil`, `TileX/Y/Z/Known/Rolling/LastRollTick`, `Ride*`, `CartHeld`, `OnVan`, `Appearance`,
  `Sprint*`, `SkillXp`, `HomeTeleport*`, `CarriedSettings`, `TakeAlls`.
* **Shared (the business):** `DirtyCash`, `CleanCash`, `DropPaid`, plus everything already outside `PlayerState`
  (factory, customers, quests, Heat, turf, unlocks, milestones, debt to the lender).
* **Open calls (taste, for the designer):** skills per person or shared; one shared `Unlocks` (yes, already global);
  whether Heat/chases/cameras (`NoticingSystem`, `ChaseSystem`, `Shootouts`) follow the nearest player, all of them, or the
  seat that triggered it; scenes (below).
* **Migration (`Simulation.Migrate`, `SaveVersion` 3 -> 4):** old save `Player` becomes `Players[0]`; its cash moves to
  `Business`; `Seats = [seat 0]`. `SaveVersion` bump also bumps `NetVersion` automatically.
* **Call-site classes, in the order to convert:** (a) `Command.Apply(sim)` bodies: use `sim.Actor` (the acting
  `PlayerState`) instead of `sim.State.Player` (the 23+451 src sites split roughly half commands, half systems);
  `Command.RequireAt` and `RequireReach` (`Commands.cs:25-40`) become per-actor and are the chokepoint for most of them.
  (b) per-tick systems that read the player (customers, noticing, chase, shootout, laundromat, quests): loop over seats
  (ordered) or take the nearest-seat helper `sim.NearestSeat(x, y)`. (c) Godot views: read `Main.LocalSeat`
  (`Net.LocalSeat`, 0 offline) via `Sim.PlayerOf(seat)`; remote avatars draw from `Players[s].TileX/Y` interpolated
  by `TickAlpha`. Convert (a) behind the compatibility accessor first so the single-player game and all 197 tests keep
  passing at each step.
* **`Moved`** stays a Command. Local avatar moves immediately in the view (the view owns the body); the Sim's copy of the
  tile lags by the lockstep input delay (host-assigned tick, one RTT/2 plus the lib's delay). Remote avatars are drawn from
  Sim state, so they are always input-delay old but identical on every screen. `Moved` is throttled today; check bandwidth,
  not correctness.
* **Scenes** (`State.Scene`, `Scenes.ClockStopped`): a cutscene stops the world clock for everyone. Proposal: the scene
  belongs to the seat that triggered it; others keep their body but the clock waits (already the Sim's behaviour);
  `SceneNext/SceneSkip/SceneEscape` accepted from the owner seat only, with a host-side 30 s dead-man skip so an AFK
  owner cannot freeze the lobby. **[design first]**
* **Dev commands:** refused from remote seats always (codec `IsDev`); the host may keep them for debugging.
* **Test plan:** `CoopSeatTests` (two seats, one command each per tick, hash equal after replay), plus the existing
  `AgencyHarnessTests` pattern (source must not change the hash) extended to seat.

### 2.4 Snapshot, late join, resync

| # | File / symbol | Change | Why |
|---|---|---|---|
| 15 | `NetSession`: `Lockstep.Snapshot = () => Encoding.UTF8.GetBytes(Sim.Save())` plus a small header (netVersion, scenario, the seat table) | Host side, called by Keepalive for late join and for desync resync. | `Save()` is already the full deterministic state. 150 KB at day 30 (`hash-cost.md`): fine for a data channel (chunked, s.8). |
| 16 | `NetSession`: `Lockstep.Restore = (tick, bytes) => ...` | Cleanest: stash the JSON in a static like the existing `Main.PendingLoad` and reload `Main.tscn` (the title screen's Load path, `Main.cs:257`), because the views hold references to `Sim`. For a desync resync mid-game do the same (a short "resyncing" overlay). Must first check `Simulation.PeekScenario(json)` against the local scenario and load that scenario's content. | Reuses the proven load path; avoids hot-swapping `Sim` under ~90 view classes. |
| 17 | `Simulation.Load` / `Migrate` (`Simulation.cs:222`) | No change except the seat migration in 2.3. A joiner at a different `SaveVersion` never gets here (`NetVersion`). | |
| 18 | Hash-check policy | `hashEveryTicks = 20` (see `hash-cost.md`). On `Desync`, host snapshot resync; after 3 resyncs in a minute, drop to the title with a data string ("out of sync"). Log both `Save()`s' first differing JSON path in dev builds (cheap, invaluable). | |

### 2.5 Fast-forward and Sleep **[design first]**

* `ProgressionSystem.Sleep()` (`ProgressionSystem.cs:193`) sets `FastForwardUntil` for the whole world. In a lobby that
  would skip hours under other players mid-action. Proposal: `Sleep` becomes a **vote**: `Business.SleepVotes` (sorted seat
  list) and the skip starts when every non-`Away` seat is in the garage and has voted; `Moved`/any other command from a seat
  clears its vote. Deterministic, all state in the Sim.
* The skip itself: lockstep has no fast-forward of its own; the host's Keepalive frame pump emits frames at 10x
  (s.14 "a sleep is just more frames at 10x") while `Sim.IsFastForwarding`, joiners run those frames without rendering
  (`FramesBuffered > 2`). `Main.cs:570` `scale = IsFastForwarding ? 600` is offline-only. Net effect: the golden rule
  "No fast-forward" still holds because the only skip is sleep, with unchanged semantics.

### 2.6 UI: menu, lobby screen, chat, voice

| # | File / symbol | Change | Why |
|---|---|---|---|
| 19 | `game/Scripts/TitleScreen.cs` (buttons: New Game, Continue, Load Game, Settings, Quit) | Add **Multiplayer** with three sub-pages: **Host lobby** (scenario or a save slot, lobby name, 2-4 players, Public/Unlisted/Private, late join on/off), **Join lobby** (code field: accepts `7HQ 4K2` / `7hq4k2`, Crockford decode is `Keepalive.Core`'s; paste button), **Browse** (`ListAsync(metaFilter { scenario, netVersion })` as a list: name, host, players n/max, phase, ping region; greyed with a reason when `netVersion` differs). | s.6/s.14. Code-only UI in the existing style. |
| 20 | `game/Scripts/Net/LobbyScreen.cs` (new, `Control`) | Peer list (name, seat colour, ping, relayed icon), host controls (Start, Kick, Approve for Private), copy-code button, chat box, mic meter, "leave". Start loads the game from the host's snapshot on every peer. Icons with hover names via `TooltipLayer`. | Lobby phase before `Lobby.StartAsync`. |
| 21 | `Main.cs` `Key(...)` input map (~line 798) + `Settings` keybinds | New action `voice_ptt` (default `V`, rebindable), `chat_open` (Enter; note `box_accept` already uses Enter, so chat opens on `T` by default). Keybind list lives where the others do. | s.9a/9b. |
| 22 | `game/Scripts/Net/ChatView.cs` (new), Hud | One-line fading chat in the HUD, history on open; sends `lobby.Chat.Send(text)`. Text only ever shown as plain text (no BBCode, no tokens), length-capped by data. Mute/ignore per peer. | s.9b; chat is outside the Sim by design (not a Command). |
| 23 | `game/Scripts/Net/VoiceBus.cs` (new) | Mic capture -> `Lobby.Voice` (stream D's Godot capture/Opus); playback on a dedicated `Voice` audio bus; music/ambience duck on it (bus effects in code, no assets). Mic meter in the lobby; push-to-talk default, voice-activity option in Settings. | s.9a; code-only audio per the art/sound rule. |
| 24 | Remote avatars: `PlayerAvatar` / `StreetView` / `WorldView` | Draw a figure per remote seat from `Players[s]` (`Appearance`, tile, ride) with a name tag from the peer display name; they are not `CharacterBody3D`s you collide with at first. | The Sim state is the only source of truth for others. |

### 2.7 Tests and CI in the Lowkey repo

| # | Where | What |
|---|---|---|
| 25 | `tests/.../CommandCodecTests.cs` (new; adapt `integrations/lowkey/codec/tests`) | Round-trip every Command type; `CommandRegistryTests` already pins the discriminators. |
| 26 | `tests/.../LockstepReplayTests.cs` (new) | Two `Simulation`s from the same seed; feed both the same framed command stream (via the codec) with 2 seats; `StateHash` equal every 20 frames; includes a scene stretch (frame tick != State.Tick). |
| 27 | determinism audit across processes (Gaffer): replay the same log in two separate processes and in Debug vs Release, compare hashes every 20 ticks | The Sim is single-threaded and uses its own RNG, but floating point and `double` formatting in `Save()` (JSON) are the risks. `InvariantGlobalization` is already on. Check x64 vs ARM later. |
| 28 | Existing bot suites | Unchanged: they never touch `Net`. |

## 3. Things found while reading that the desk should know

1. `State.Tick` is not monotonic per frame (scene stretches). Use the frame tick for hashes and for anything keyed to lockstep.
2. The new-game seed is wall clock: in a lobby the **host** picks it and everyone gets it via the snapshot; a joiner must
   never call `Simulation.NewGame` itself.
3. `Moved`/`Precise` position reports are trusted by the Sim (client-authoritative position). Fine for co-op between friends;
   the host cannot verify them. A public-lobby anti-cheat is out of scope (DESIGN non-goals).
4. `CommandSourceExt.For` marks `Dev*` as `CommandSource.Dev` but does not refuse them: the lobby must refuse them from remote
   seats (`LowkeyCommandCodec.IsDev`).
5. Content JSON is part of determinism. `NetVersion` as specified (`SaveVersion` + scenario) does not catch a modded
   `game/data`; see row 6.
6. `HandsOff` / `RecordCommands` / `CommandLog` stay per-process debug tools; with seats, `LoggedCommand.Seat` makes a lobby
   game replayable offline from the host's log.
7. Web export: none until Godot ships C# web export (s.5).

## 4. Build / verify this folder

```
sh integrations/lowkey/build-sim.sh                         # Lowkey Sim -> integrations/lowkey/.lowkey-sim (nothing written in Lowkey)
dotnet test integrations/lowkey/codec                       # codec round-trip over every Command type
dotnet run --project integrations/lowkey/hash-cost -c Release -- 20261011 301   # hash-cost numbers
```
`build-sim.sh` passes `-p:DefaultItemExcludes=obj/**` because moving `BaseIntermediateOutputPath` out of the Lowkey tree
otherwise makes the SDK glob Lowkey's existing `obj/*.cs` into the build (duplicate assembly attributes).
