# OneLobby blueprint: one settings file, two ways to fill it

Status: design, 2026-10-25. Nothing in this doc exists yet unless the schema table says "exists".
Audience: the designer (decides the taste calls), then the agents that build it.

**The vision in one line.** Be Vite for multiplayer: a developer, usually working with an AI coding agent, says "make my
game multiplayer with a self-host plan ready", answers a handful of questions, and the game has Host and Join buttons,
voice and chat if wanted, and a way to keep playing after every server is gone (the Stop Killing Games outcome: an
offline mode or private servers, [Wikipedia](https://en.wikipedia.org/wiki/Stop_Killing_Games)).

**The mechanism in one line.** A file, `onelobby.json`, holds the game's multiplayer decisions. The library reads the
runtime keys directly (`OneLobby.fromConfig`), so flipping voice off is a one-line edit with no agent. An agent skill or
a `npm create onelobby` scaffolder fills the file and generates the code for the structural keys (engine, menus, sync
mode), then proves it works with two headless players.

---

## 1. Prior art

Accessibility: none apply to the file or the library (they draw nothing). The menus the scaffolder and the skill
generate keep the three rules the demos already follow (DESIGN.md s.1): join codes in large monospace with Crockford
decoding of typos, nothing in the lobby flow on a timer, and voice off until the player turns it on with a visible
"transmitting" state.

| Source | Establishes | Backs |
|---|---|---|
| [Vite guide](https://vite.dev/guide/) | "Vite is opinionated and comes with sensible defaults out of the box"; `npm create vite@latest my-vue-app -- --template vue`; "To create a project without interactive prompts, you can use the `--no-interactive` flag." | s.2 shape, s.6 flags |
| [Vite config](https://vite.dev/config/) | `defineConfig` "should provide intellisense without the need for JSDoc annotations" | s.7 typed wrapper |
| [npm init](https://docs.npmjs.com/cli/v11/commands/npm-init) | "`npm init foo` -> `npm exec create-foo`": the `create-<name>` package convention | s.6 package name |
| [create-next-app](https://nextjs.org/docs/app/api-reference/cli/create-next-app) | `--yes`: "Use previous preferences or defaults for all options"; `--skip-install`; `--use-npm`; every prompt has a flag | s.6 flags |
| [create-t3-app](https://create.t3.gg/en/installation) | `--CI`: "Let the CLI know you're in CI mode"; feature flags only act in CI mode; `-y` "bypasses the prompts and selects all options" | s.6 non-interactive |
| [create-astro](https://github.com/withastro/astro/tree/main/packages/create-astro) | `--yes` "Skip all prompts by accepting defaults"; `--dry-run` "Walk through steps without executing" | s.6 dry run |
| [Angular `ng new`](https://angular.dev/cli/new) | `--dry-run` "Run through and reports activity without writing out results"; `--defaults` "Disable interactive input prompts for options with a default" | s.6 dry run |
| [clig.dev](https://clig.dev/) | "Only use prompts or interactive elements if `stdin` is an interactive terminal (a TTY)"; "Never _require_ a prompt"; "If `--no-input` is passed, don't prompt"; "Display output as formatted JSON if `--json` is passed" | s.6 TTY rule, `--json` |
| [VS Code JSON](https://code.visualstudio.com/docs/languages/json) | A schema can be attached "in the JSON file itself using the $schema attribute" for validation and completion | s.5 `$schema` |
| [Mirror NetworkManager.cs](https://raw.githubusercontent.com/MirrorNetworking/Mirror/master/Assets/Mirror/Core/NetworkManager.cs) | One inspector object: `maxConnections` ("Maximum number of concurrent connections"), `runInBackground = true` ("Multiplayer games should always run in the background so the network doesn't time out"), `sendRate`, offline/online scene, `headlessStartMode` | s.4 keys |
| [Unity Netcode NetworkManager](https://mp-docs.dl.it.unity3d.com/netcode/current/components/networkmanager) | Tick Rate ("controls the network tick update rate"), Connection Approval, Protocol Version ("help distinguish between builds"), Player Prefab, Log Level | s.4 keys |
| [FishNet ServerManager](https://fish-networking.gitbook.io/docs/fishnet-building-blocks/components/managers/server-manager) | Remote Client Timeout: "decides if the server should disconnect clients which seem unresponsive" | s.4 `peerTimeoutMs` |
| [Photon PUN setup](https://doc.photonengine.com/pun/v2/getting-started/initial-setup) | A settings asset with App Id, App Version ("part of the Game Version"), Fixed Region, Protocol, Network Logging | s.4 keys, s.2 settings-asset shape |
| [Godot ENetMultiplayerPeer](https://docs.godotengine.org/en/stable/classes/class_enetmultiplayerpeer.html), [high-level multiplayer](https://docs.godotengine.org/en/stable/tutorials/networking/high_level_multiplayer.html) | `create_server(port, max_clients)`; "the server remains the source of truth for important states"; "treat all client input as untrusted" | s.4 `maxPlayers`, rules |
| [GodotSteam lobbies](https://godotsteam.com/tutorials/lobbies/) | `Steam.createLobby(lobby_type, max_players)`, name and tags via `setLobbyData`; app id 480 for testing | s.9 Steam adapter |
| [Steam ISteamMatchmaking](https://partner.steamgames.com/doc/api/ISteamMatchmaking) | Lobby types: private ("The only way to join the lobby is from an invite"), friends-only, public, invisible; `SetLobbyData` key/values; cap "can not be above 250" | s.4 visibility, s.9 |
| [Steam ISteamFriends](https://partner.steamgames.com/doc/api/ISteamFriends) | Rich Presence `connect`: "A UTF-8 string that contains the command-line for how a friend can connect to a game"; `GetFriendPersonaName` "Gets the specified user's persona (display) name" | s.9 join-from-friends-list, identity |
| [Steam ISteamNetworkingSockets](https://partner.steamgames.com/doc/api/ISteamNetworkingSockets) | `ConnectP2P` by platform identifier; relay "prevents IP addresses from being revealed" | s.9 Steam transport (later) |
| [Epic lobbies (Unreal docs)](https://dev.epicgames.com/documentation/en-us/unreal-engine/lobbies-interface-in-unreal-engine) | "A lobby is a group of players ... where all of the players have some shared state"; `MaxMembers`; attributes with a schema; search by attributes; invites per privacy setting | s.9 Epic adapter |
| [Nakama](https://github.com/heroiclabs/nakama), [authentication](https://heroiclabs.com/docs/nakama/concepts/authentication/) | Apache-2 backend; "A device identifier can be used as a way to unobtrusively register a user" | s.4 identity, s.9 |
| [Apple review guidelines 5.1.1](https://developer.apple.com/app-store/review/guidelines/) | "Apps may not require users to enter personal information to function, except when directly relevant to the core functionality" | s.4 identity default |
| [ESRB ratings guide](https://www.esrb.org/ratings-guide/) | "Users Interact": "possible exposure to unfiltered/uncensored user-generated content, including user-to-user communications" | s.4 chat and voice off by default |
| [Factorio wiki: Multiplayer](https://wiki.factorio.com/Multiplayer) | "Game is paused while there are no players connected"; `no-auto-pause` in server settings | s.4 pause |
| [Terraria wiki: Settings](https://terraria.wiki.gg/wiki/Setting) | Autopause "For singleplayer only": real-time multiplayer does not pause | s.4 pause default off |
| [agents.md](https://agents.md/) | Open format for agent instructions; "The closest AGENTS.md to the edited file wins" | s.5 agent-facing files |
| [llms.txt](https://llmstxt.org/) | H1 + blockquote + H2 link sections; "Optional" section for secondary material | s.5 |
| [Claude Code skills](https://code.claude.com/docs/en/skills), [plugins](https://code.claude.com/docs/en/plugins) | `SKILL.md` with `name` and `description`; project skills in `.claude/skills/<name>/`; "Claude uses skills when relevant, or you can invoke one directly with `/skill-name`"; plugin manifest `.claude-plugin/plugin.json`, marketplace `.claude-plugin/marketplace.json` | s.5 the skill |
| [Cursor rules](https://cursor.com/docs/context/rules), [Copilot instructions](https://docs.github.com/en/copilot/concepts/prompting-and-context/custom-instructions) | `.cursor/rules/*.mdc`; `.github/copilot-instructions.md` | s.5 other agents |
| [Stop Killing Games (Wikipedia)](https://en.wikipedia.org/wiki/Stop_Killing_Games) | Goal: games left "in a reasonably functional state after discontinuation"; 1.29 M verified signatures (Jan 2026) | s.2 why direct hosting is the default plan |

Not verified: Epic's own EOS pages (P2P, Connect interface, lobby member cap) render client-side and returned nothing to
an anonymous fetch. Everything about EOS below is scoped from the Unreal docs page plus the shape of the Steam adapter,
and marked "to confirm" in s.9.

---

## 2. Problem and audience

**Who.** A solo or small-team developer who builds with an AI coding agent (Claude Code, Cursor, Copilot). They have
a working single-player game in a browser, Godot, Unity or plain .NET. They want multiplayer the way they want a build
tool: pick it, accept the defaults, move on. They also want the game to outlive them (Stop Killing Games).

**What is wrong today.** OneLobby has the pieces (AGENTS.md lists them) but no single place to decide. The decisions
are spread over constructor arguments (`OneLobbyOptions`, `OneLobbyConfig`), host options (`HostOptions`,
`DirectHostOptions`), recipe prose ("the lobby server is a setting") and rules ("bump `NetVersion` when bytes change").
An agent reading AGENTS.md can integrate a game, but every integration re-derives the same ten choices, and a human who
later wants voice off has to find the line the agent wrote.

**What the other frameworks do.** Every engine framework puts its choices in one object with an inspector: Mirror's
`NetworkManager` (max connections, run in background, send rate, scenes), Unity Netcode's `NetworkManager` (tick rate,
connection approval, protocol version), Photon's `PhotonServerSettings` asset (app id, app version, region, protocol).
OneLobby has no inspector, so its "one object" has to be a file that every engine, the scaffolder and the agent can
read. JSON with a `$schema` line gives autocomplete and validation in any editor (VS Code docs).

**What the scaffolders do.** `create-vite`, `create-next-app`, `create-astro`, `create-t3-app` all ask the same few
questions interactively and accept every answer as a flag, with `--yes` to take defaults and `--dry-run` to show the
plan. clig.dev states the rule: prompt only on a TTY, never require a prompt. An AI agent cannot drive arrow-key
prompts, so the flag path is the primary one for this audience, not an afterthought.

---

## 3. User flows

### 3a. Agent path (the main one)

```
dev:   "make it multiplayer, 2-4 players, keep a self-host plan"
agent: (survey)  reads the game: engine, loop, menus, genre, is the sim deterministic
       (propose) writes onelobby.json with one-line reasons per key
       (plan)    says where Host / Join go in the existing UI
       -> shows the proposal; dev edits or says go
       (build)   generates glue code and menus from the structural keys
       (verify)  two headless players, the recipe's "Done when" checks, offline check
       (report)  what was set, what was built, what passed, what to do next
```

The proposal is a table the developer reads cold. Example for an ant colony arcade game in a browser:

| Key | Proposed | Why |
|---|---|---|
| `sync.mode` | `lockstep` | the sim already runs on a fixed tick with a seeded RNG and no wall clock |
| `lobby.maxPlayers` | 4 | the arena fits four nests; more needs a bigger map |
| `chat.voice` | off | fast arcade rounds, no coordination needed; keeps the mic permission prompt out |
| `chat.text` | on | a lobby with no way to say "ready?" feels dead |
| `hosting.direct` | on | a Node host script ships with the game, so friends play with no server (the shutdown plan) |
| `hosting.server` | on, `lobbyServer` pre-filled | the hosted lobby gives browser players codes today |
| `ui.entry` | `Settings > Multiplayer` tab | the Settings menu already has three tabs; the main menu has no room |
| `players.identity` | `name` (empty allowed) | a name box, but "Player 2" works if left blank (Apple 5.1.1: never require personal info) |

### 3b. Scaffolder path

New game, or a game that does not need the survey:

```
npm create onelobby@latest my-game -- --template web --max-players 4 --voice no --chat yes --hosting both --yes
```

Same questions, same keys, no survey. Interactive when stdin is a TTY and no `--yes`; otherwise flags only (clig.dev).
`--dry-run` prints the plan and writes nothing (Angular, Astro). `--json` prints the resulting `onelobby.json` and the
file list as JSON for an agent to read. Details in s.6.

### 3c. Hand-edit later

The developer opens `onelobby.json`, changes `"voice": true` to `false`, saves. Next launch the library refuses to
enable voice (`voice_disabled`) and the generated voice button, which reads `kit.blueprint.chat.voice`, is hidden. No
agent, no rebuild.

Structural keys are different: changing `"engine"` or `"ui.entry"` by hand does nothing until code is regenerated. The
file says so in a comment-equivalent (`"$comment"` keys are allowed by JSON Schema and ignored by the loader), and
`fromConfig` logs one line when a structural key differs from the one the generated code was built with (s.7, drift).

---

## 4. The schema

One file, `onelobby.json`, at the game's root (next to `package.json`, `project.godot`, `Assets/`, or the `.csproj`).
Keys are grouped by section. Two columns matter most: **R/S** (runtime: the library reads it; structural: it shapes
generated code; both: the library enforces it and the UI reflects it) and **Today** (exists as an API now, or new).

### 4a. `game`

| Key | Type | Default | R/S | Today | Prior art |
|---|---|---|---|---|---|
| `game.id` | string, reverse-DNS | required | R | exists (`gameId` / `GameId`) | Photon App Id; Steam app id |
| `game.netVersion` | string | `"1"` | R | exists (`netVersion`) | Photon App Version "part of the Game Version"; Unity Netcode Protocol Version "distinguish between builds"; AGENTS.md rule 6 |
| `game.title` | string | folder name | S | new | scaffolders' project name prompt |

### 4b. `engine` (structural)

| Key | Type | Default | R/S | Today | Prior art |
|---|---|---|---|---|---|
| `engine` | `"web"` \| `"node-browser"` \| `"godot-csharp"` \| `"unity"` \| `"dotnet"` | surveyed or `--template` | S | new (the recipes exist per engine) | create-vite `--template` |

The agent fills it from the survey; the scaffolder from `--template`. It picks the recipe, the package to install and
the transport (`DataChannelTransport`, `GodotTransport`, `UnityTransport`, browser WebRTC, node-datachannel).

### 4c. `hosting`

| Key | Type | Default | R/S | Today | Prior art |
|---|---|---|---|---|---|
| `hosting.direct` | bool | `true` where the engine can listen (`node-browser`, `godot-csharp`, `unity`, `dotnet`); `false` for `web` (a browser cannot listen on a port) | both | exists (`HostDirectAsync`, `hostDirect`) | Terraria Host & Play, Minecraft Open to LAN (direct-ip recipe); Stop Killing Games "private servers" |
| `hosting.server` | bool | `true` for `web`; `false` otherwise | both | exists (`HostAsync`, `kit.host`) | Photon / Nakama hosted rooms |
| `hosting.lobbyServer` | URL string | `""` | R | exists (`lobbyServer`) | AGENTS.md rule 5: a setting, never a constant |
| `hosting.directPort` | int 1024-65535 | 47810 | R | exists (`DirectPort`, `port`) | Godot `create_server(port, ...)`; Factorio documents its port |
| `hosting.openPort` | bool | `true` | R | exists (`OpenPort`) | direct-ip recipe s.5 toggle |
| `hosting.relayOnly` | bool | `false` | R | exists (`relayOnly`) | Steam SDR's IP-hiding rationale (DESIGN.md s.10) |
| `hosting.allowedOrigins` | string[] | `[]` | R | exists (`AllowedOrigins`) | direct host origin check (0.4.1) |

At least one of `direct` / `server` must be true (schema `anyOf`). `both` is the shutdown-safe default the vision asks
for: codes from the hosted server while it runs, direct codes forever.

### 4d. `lobby`

| Key | Type | Default | R/S | Today | Prior art |
|---|---|---|---|---|---|
| `lobby.maxPlayers` | int 2-64 | 4 | R | exists (`maxPlayers`) | Mirror `maxConnections`; Godot `max_clients`; Steam cap 250 |
| `lobby.listed` | bool | `false` | both | exists (`visibility: "public"` + `list()`); the Browse button is new | Steam public vs invisible; `host()` default unlisted |
| `lobby.approveJoins` | bool | `false` | both | exists (`visibility: "private"`, `joinRequested`) | Unity Netcode Connection Approval; Steam private lobbies |
| `lobby.password` | bool (the game asks for one) | `false` | both | exists for direct (`Password`); new for server lobbies | Minecraft / Valheim server passwords; direct-ip recipe |
| `lobby.lateJoin` | bool | `true` | R | exists (`lateJoin`) | Photon `IsOpen`; AGENTS.md rule 7 (lockstep needs snapshot) |
| `lobby.rejoin` | bool | `true` | both | exists (`rememberSeat`, `rejoin`, `RejoinDirectAsync`) | Colyseus `allowReconnection` (DESIGN.md) |
| `lobby.joinLink` | bool | `true` for `web` and `node-browser` | S | exists (`shareUrl`, `codeFromUrl`, `joinUrl`) | Steam Rich Presence `connect` string (the same idea on a platform) |
| `lobby.meta` | object of strings | `{}` | R | exists (`meta`) | Steam `SetLobbyData`; Nakama labels; Epic lobby attributes |

`listed` and `approveJoins` map onto the existing `visibility`: listed → `public`, approveJoins → `private`, neither →
`unlisted`. Both true is an error (the server has no "listed but approved" type; Steam has no such type either).

### 4e. `sync`

| Key | Type | Default | R/S | Today | Prior art |
|---|---|---|---|---|---|
| `sync.mode` | `"raw"` \| `"lockstep"` \| `"replication"` | surveyed; scaffolder default `raw` | both | `raw` and `lockstep` exist (`mode`); `replication` exists in C# only (`OneLobby.Replication`) | Rune (deterministic), 1500 Archers (lockstep), Photon Fusion (host-authoritative) in DESIGN.md s.1 |
| `sync.tickRate` | int 1-120 | 20 | R | exists (`tickRate`, 30 Hz in replication) | Unity Netcode Tick Rate; Mirror `sendRate` with its "60-100Hz fast paced ... 1-10Hz slow paced" guidance |
| `sync.hashEveryTicks` | int | `tickRate` | R | exists (`hashEveryTicks`) | 1500 Archers checksums; Factorio desync detection |

The agent chooses `lockstep` only when the survey finds a fixed-tick loop, seeded RNG and no wall clock or unordered
iteration (AGENTS.md rule 3); otherwise `raw`, or `replication` for a real-time C# game with host-owned physics or AI.
`replication` on a non-C# engine is a schema error until a JS port exists.

### 4f. `players`

| Key | Type | Default | R/S | Today | Prior art |
|---|---|---|---|---|---|
| `players.identity` | `"name"` \| `"anonymous"` \| `"platform"` | `"name"` | both | `name` exists (empty `displayName` shows "Player N"); `anonymous` is new as an enforced mode; `platform` is new (s.9) | Apple 5.1.1(v) (never require personal info); Nakama device-id ("unobtrusively register"); Steam persona names |
| `players.maxNameLength` | int | 24 | R | new | the name box in `<one-lobby>` today has no stated cap |

`anonymous` is the designer's "hashes": no name box anywhere, every player is "Player N" (N = seat) and the library rejects
a non-empty `displayName` (`identity_anonymous`). It is the right default for games with young players or no chat.
`platform` takes the name from the platform adapter (Steam persona name) and falls back to `name`.

### 4g. `chat`

| Key | Type | Default | R/S | Today | Prior art |
|---|---|---|---|---|---|
| `chat.text` | bool | `true` | both | exists (`lobby.chat`); the chat panel is generated | ESRB "Users Interact": a disclosure the developer must know they are opting into |
| `chat.voice` | bool | `false` | both | exists (`lobby.voice`); the button and level meter are generated | same; mic permission prompt; DESIGN.md s.9a |
| `chat.voiceMode` | `"pushToTalk"` \| `"voiceActivity"` | `"pushToTalk"` | R | exists (`VoiceMode`) | voice-and-chat recipe; Steam voice API cadence |

Runtime enforcement: with `chat.voice: false`, `lobby.voice.enabled = true` throws `voice_disabled` (JS) /
`OneLobbyException("voice_disabled")` (C#); with `chat.text: false`, `lobby.chat.send` throws `chat_disabled`. That is
what makes the hand-edit path real: the file wins even over code that still calls the API.

### 4h. `session`

| Key | Type | Default | R/S | Today | Prior art |
|---|---|---|---|---|---|
| `session.hostLeaves` | `"end"` \| `"migrate"` | `"end"` | both | `migrate` exists for server lobbies (lowest `peerId`, lockstep needs Snapshot/Restore); direct lobbies always end | Photon PUN (lowest actor), Steam automatic owner migration; direct-ip recipe |
| `session.pause` | `"off"` \| `"host"` \| `"anyone"` | `"off"` for real-time action; agent proposes `"anyone"` for RTS, strategy and long co-op sessions, `"host"` when the host runs the world | both | **new** (s.10) | Stardew host-only `/pause`; Factorio pauses when empty; Terraria autopause "For singleplayer only"; Mirror/FishNet/Netcode have no network pause |
| `session.readyTimeoutMs` | int | 15000 | R | exists | AGENTS.md friendly defaults |
| `session.peerTimeoutMs` | int, 0 or ≥ 6000 | 0 | R | exists | FishNet Remote Client Timeout |
| `session.rateLimit` | `{ messages, perMs }` | none | R | exists (`rateLimit`) | browser-game recipe |
| `session.runInBackground` | bool | `true` | both | exists for Unity (`KeepRunningInBackground`); structural for Godot (project setting) and web (nothing to do) | Mirror `runInBackground = true`: "so the network doesn't time out"; Unity `Application.runInBackground` |

`migrate` with `direct: true` and `server: false` is a schema error (direct has no migration). `migrate` with
`sync.mode: "replication"` is an error too (AGENTS.md rule 7: end the match on `HostLost`).

### 4i. `platforms` (all new, s.9)

| Key | Type | Default | R/S | Today | Prior art |
|---|---|---|---|---|---|
| `platforms.steam` | bool or `{ appId }` | `false` | S | new | Steam lobbies, Rich Presence `connect`, GodotSteam |
| `platforms.epic` | bool or `{ productId, ... }` | `false` | S | new | EOS lobbies (attributes, invites) |
| `platforms.discord` | bool | `false` | S | new | Discord Social SDK (lobbies, presence); not researched further |

### 4j. `ui` (structural)

| Key | Type | Default | R/S | Today | Prior art |
|---|---|---|---|---|---|
| `ui.kind` | `"drop-in"` \| `"generated"` \| `"none"` | `drop-in` for `web`; `generated` elsewhere | S | `drop-in` exists (`<one-lobby>` element); `generated` is what the recipes hand-write today | no-code.md; js-web recipe s.4 |
| `ui.entry` | free text, e.g. `"Settings > Multiplayer tab"`, `"Main menu: Play together"` | surveyed | S | new | the agent's plan; Mirror offline/online scene slots are the engine-side analogue |
| `ui.theme` | `"light"` \| `"dark"` \| `"auto"` | `auto` | R (drop-in only) | exists (`theme` attribute) | |

### 4k. Example

```json
{
  "$schema": "https://unpkg.com/onelobby@0.5.0/blueprint.schema.json",
  "version": 1,
  "game": { "id": "com.example.antcolony", "netVersion": "1", "title": "Ant Colony" },
  "engine": "node-browser",
  "hosting": { "direct": true, "server": true, "lobbyServer": "wss://lobby.example.org/ws", "directPort": 47810, "openPort": true },
  "lobby": { "maxPlayers": 4, "listed": false, "approveJoins": false, "password": false, "lateJoin": true, "rejoin": true, "joinLink": true },
  "sync": { "mode": "lockstep", "tickRate": 20, "hashEveryTicks": 20 },
  "players": { "identity": "name" },
  "chat": { "text": true, "voice": false, "voiceMode": "pushToTalk" },
  "session": { "hostLeaves": "end", "pause": "host", "readyTimeoutMs": 15000, "peerTimeoutMs": 0, "runInBackground": true },
  "platforms": { "steam": false, "epic": false, "discord": false },
  "ui": { "kind": "generated", "entry": "Settings > Multiplayer tab" }
}
```

Every key but `game.id` has a default, so the smallest valid file is `{ "game": { "id": "com.example.antcolony" } }`.
The scaffolder and the skill write the full file anyway: a file you can read beats a default you have to look up.

### 4l. JSON Schema plan

- `spec/blueprint.schema.json`, draft 2020-12, next to the existing `spec/signaling.schema.json`. Every key has
  `description` (the one-line "why" the agent shows) and `default`. Cross-key rules as `allOf`/`if`/`then`: at least one
  hosting mode; `listed` and `approveJoins` not both; `migrate` needs `server`; `replication` needs a C# engine.
- Shipped three ways: in the npm package (`onelobby/blueprint.schema.json`, so the `$schema` URL above works from
  unpkg or jsDelivr with a pinned version), as an embedded resource in `OneLobby.Core` (C# validates with the same
  file), and in the repo for the test vectors.
- `spec/vectors/blueprint.json`: valid and invalid files with the expected error path, run by the JS and C# test suites
  like the signaling vectors today. One schema, two loaders, one set of vectors.
- SchemaStore listing (`onelobby.json` file match) later, so editors pick it up with no `$schema` line. The catalog
  format is public (`fileMatch` + `url`); the contribution policy was not fetched, so this stays a nice-to-have.
- `"$comment"` keys are allowed anywhere and ignored by the loaders, so the agent can leave its reasons in the file.

---

## 5. The agent skill

A Claude Code skill in this repo, `.claude/skills/onelobby/SKILL.md`, with `name: onelobby` and a `description` that
triggers on "make it multiplayer", "add OneLobby", "co-op", "host and join". Installable as a plugin
(`.claude-plugin/plugin.json`) so a game repo pulls it without copying. For other agents, the same text lives in a
section of AGENTS.md ("Integrate a game: the blueprint flow"), and llms.txt links the schema and this doc; a
`.cursor/rules/onelobby.mdc` and a `.github/copilot-instructions.md` snippet are one-paragraph pointers to AGENTS.md
(agents.md: "The closest AGENTS.md to the edited file wins").

### Phases

| Phase | What the agent does | Output |
|---|---|---|
| 1 Survey | Reads the game: engine and version, loop (fixed tick? `requestAnimationFrame`? `_PhysicsProcess`?), RNG and wall-clock use, menu structure, genre and pace, player count the design implies, existing settings storage, build and test commands. Never changes anything. | A short survey block in the report |
| 2 Propose | Writes `onelobby.json` with a `$comment` per non-default key. Defaults come from the schema; deviations come from the survey with one-line reasons. | The proposal table (s.3a) |
| 3 Plan | Names where Host / Join / Browse / Settings go in the game's UI, what files change, which recipe it follows, what the "Done when" checks will be. | The plan list |
| 4 Approve | Stops. The developer edits the file or the plan, or says go. (Taste call 1 asks whether an all-defaults proposal may skip this stop.) | |
| 5 Build | Follows the engine's recipe. Reads runtime keys through `fromConfig`, never copies values into code. Generates only what structural keys demand: the UI entry, the Node host script when `hosting.direct`, snapshot/restore stubs when `lockstep` + `lateJoin` or `migrate`, the pause hook when `session.pause` is not `off`. | Files, each listed |
| 6 Verify | Runs the recipe's "Done when": two headless players (testing recipe, playwright-core for web; batchmode for Unity; the .NET smoke for direct), a message each way, and the offline check (server stopped: the game still plays and shows "Multiplayer unavailable"). | Pass/fail per check |
| 7 Report | The report below. | |

### The report the developer sees

```
OneLobby: Ant Colony is multiplayer.

Settings (onelobby.json)          Why
  sync.mode        lockstep       fixed 20 Hz tick, seeded RNG, no Date.now() in sim
  lobby.maxPlayers 4              four nests on the arena map
  chat.text        on             lobby needs a "ready?"
  chat.voice       off            arcade rounds; flip to true in onelobby.json to enable
  hosting          direct + server  host.mjs ships with the game (no server needed); codes from the lobby server while it runs
  session.pause    host           turn-free arcade, but the host can freeze a round
  players.identity name           blank name shows "Player N"

Built
  src/net/multiplayer.js   fromConfig, host/join/browse, lockstep frames into tick()
  src/ui/settings.js       new "Multiplayer" tab (the menu had no room on the main screen)
  host.mjs                 direct host: serves the page on 47810, prints a join code
  test/multiplayer.mjs     two headless players

Verified
  PASS two players, 60 frames in lockstep, hashes equal
  PASS join link ?join=CODE
  PASS offline: server stopped, game still plays, menu says "Multiplayer unavailable"
  PASS direct: host.mjs printed Same-network code; joiner PASS

Next
  - Put your lobby server URL in onelobby.json > hosting.lobbyServer (deploy/EASY_SERVER.md), or leave it blank for direct only.
  - Bump game.netVersion whenever the command bytes change.
```

Every line of "Settings" is a key the developer can change by hand. "Built" names files so the developer can read
them. "Verified" never says "works": it names the checks that ran.

---

## 6. The scaffolder: `create-onelobby`

Package `create-onelobby` on npm, so `npm create onelobby@latest` resolves to it (npm docs: "`npm init foo` ->
`npm exec create-foo`"). Also `npx create-onelobby`. Zero runtime dependencies like the client; prompts with a small
prompt library in the CLI only.

### Two jobs

1. **New project:** `npm create onelobby@latest my-game -- --template web`. Writes a playable starter (the engine's
   demo: gridpaint for web) with `onelobby.json`, the recipe's glue, a test script, and an AGENTS.md pointer.
2. **Existing project:** `npm create onelobby@latest -- --into .`. Writes only `onelobby.json`, `multiplayer/` glue for
   the engine and the test script, then prints the integration steps from the recipe. The agent skill is the better
   path here (it has the survey); the scaffolder is for people without an agent or for CI.

### Templates

| Template | Engine | Phase |
|---|---|---|
| `web` | browser game, hosted lobby server, drop-in or generated UI | v1 |
| `node-browser` | Node host serves the page, direct codes, browser joiners (browser-game recipe) | v2 |
| `godot-csharp` | autoload `Net.cs`, `OneLobby.Godot` | v2 |
| `unity` | `OneLobbyRunner`, `com.onelobby.unity` package | v2 |
| `dotnet` | console / MonoGame, `OneLobby.DataChannel` + `OneLobby.Direct` | v2 |

### Flags

Every question has a flag, named after the schema key (create-next-app's pattern: one flag per prompt).

```
create-onelobby [dir] [options]
  --template <web|node-browser|godot-csharp|unity|dotnet>
  --into <dir>                 add to an existing project instead of creating one
  --from <onelobby.json>       take every answer from this file (hand-edit path, CI)
  --game-id <reverse.dns>  --title <text>
  --max-players <n>  --listed  --approve-joins  --password  --no-late-join  --no-rejoin  --no-join-link
  --mode <raw|lockstep|replication>  --tick-rate <n>
  --hosting <direct|server|both>  --lobby-server <url>  --port <n>  --no-open-port
  --identity <name|anonymous|platform>
  --chat / --no-chat  --voice / --no-voice  --voice-mode <pushToTalk|voiceActivity>
  --host-leaves <end|migrate>  --pause <off|host|anyone>
  --steam [appId]  --epic  --discord
  --ui <drop-in|generated|none>  --ui-entry <text>
  --set <key=value>            any schema key by dotted path, for the long tail
  -y, --yes                    defaults for everything not given (create-astro, create-next-app)
  --no-input                   never prompt; missing required answers are an error (clig.dev)
  --dry-run                    print the plan and the file, write nothing (Angular, Astro)
  --json                       machine-readable result: the file, the file list, next steps (clig.dev)
  --no-install  --no-git       as the other scaffolders
```

Rules: prompt only when stdin is a TTY and neither `--yes` nor `--no-input` is set (clig.dev: "Only use prompts or
interactive elements if stdin is an interactive terminal"). `CI=true` in the environment implies `--no-input`
(create-t3-app's `--CI`). The interactive prompt order is the schema's section order, and the prompt text is each key's
`description`, so the TUI, the skill and the schema cannot drift. `--dry-run --json` is what the agent skill calls when
it wants the scaffolder to do the file generation for a template it recognizes.

### What it writes (web template)

```
my-game/
  onelobby.json
  index.html                 drop-in <one-lobby> element, or generated Host/Join/Browse
  src/game.js                the starter game (pure, deterministic) or your own
  src/multiplayer.js         OneLobby.fromConfig(blueprint) + the recipe's glue
  test/multiplayer.mjs       two headless players (testing recipe)
  AGENTS.md                  three lines: read onelobby.json first; the schema URL; the recipe link
```

---

## 7. The runtime `fromConfig` API

The library reads the runtime keys itself. The generated code never copies a value out of the file.

### JS

```ts
import { OneLobby } from "onelobby";
import blueprint from "./onelobby.json" with { type: "json" };     // or fetch("/onelobby.json")

const kit = OneLobby.fromConfig(blueprint, { displayName: nameBox.value });
// kit.blueprint: the validated, frozen file (defaults filled in)
// kit.host()        -> HostOptions from lobby.*; name defaults to "<displayName>'s game"
// kit.join(code), kit.list(), kit.resume(): unchanged
// hostDirect(kit)   -> DirectHostOptions from hosting.* and lobby.* (Node only)
if (kit.blueprint.chat.voice) showVoiceButton();
```

- `fromConfig(json, overrides?)` validates against the schema and throws `OneLobbyError` code `bad_config` with the
  JSON path and the schema message (`hosting: at least one of direct, server`). Overrides are the few things that are
  per-player or per-launch: `displayName`, `lobbyServer`, `advanced.*`.
- Lobby server precedence stays what js-web.md s.2 says, with the file as the new bottom layer: `?lobby=` param,
  then `localStorage`, then `<meta name="lobby-server">`, then `hosting.lobbyServer`. Rule 5 holds: user-editable,
  overridable, defaulted.
- Enforcement: `voice_disabled`, `chat_disabled`, `identity_anonymous`, `listing_disabled` (`list()` when
  `hosting.server` is false) are `OneLobbyError` codes with `describeError` text.
- `defineBlueprint(obj)` is exported for TypeScript projects that prefer a `.ts` config with completion (Vite's
  `defineConfig` idea); it returns the object unchanged. JSON stays canonical because C# and the scaffolder read it.
- Drift: `fromConfig` accepts `{ builtFrom: { engine, "ui.kind", "sync.mode", ... } }` which generated code passes
  from the values it was built with; a mismatch logs one `console.warn` naming the key and the fix ("regenerate with
  the onelobby skill or `npm create onelobby -- --into . --from onelobby.json`"). Runtime keys never warn; they just
  apply.

### C#

```csharp
var bp = Blueprint.Load("onelobby.json");                       // or Blueprint.Parse(json); Unity: a TextAsset
var client = LobbyClient.FromBlueprint(bp, new DataChannelTransport(), displayName: "Ann");
Lobby lobby = await client.HostAsync();                         // LobbyOptions from bp.Lobby
Lobby lobby = await client.HostDirectAsync();                   // DirectHostOptions from bp.Hosting + bp.Lobby (OneLobby.Direct)
if (bp.Chat.Voice) voiceButton.Visible = true;
```

- `Blueprint` is a record in `OneLobby.Core` with one property per section; `Blueprint.Load` validates with the
  embedded schema and throws `OneLobbyException("bad_config")` with the path.
- `bp.ToConfig(displayName)` returns today's `OneLobbyConfig`; `bp.ToLobbyOptions()` and `bp.ToDirectHostOptions()`
  return today's option records, so existing code can adopt the file one call at a time.
- Unity: `OneLobbyRunner.Blueprint` (a `TextAsset` field in the inspector, default `Assets/onelobby.json`); the runner's
  `LobbyServer` field becomes the override layer above the file, same precedence as JS. Godot: `res://onelobby.json`,
  `--lobby-server=` flag on top, as the recipe already does.
- Enforcement mirrors JS with the same error codes (`LobbyErrorCodes.VoiceDisabled`, ...), tested by the shared
  vectors.

---

## 8. Honest inventory: what exists, what is new

| Exists today (reuse, do not rebuild) | New in this design |
|---|---|
| Every runtime knob in s.4 marked "exists": ids, version, lobby server, sync modes, tick and hash rates, max players, visibility (public / unlisted / private with approval), late join, rejoin, meta, rate limit, ready and peer timeouts, direct port, open port, allowed origins, voice mode, text chat, relay-only | The file, the schema, the vectors |
| Direct hosting (.NET, Unity, Node) and joining (.NET, Node, browser) with join codes; the Node host serving its own page | `fromConfig` / `Blueprint` in both languages, with enforcement codes and drift warning |
| Host migration on hosted-server lobbies; "host leaves ends the session" on direct | `session.pause` (s.10) |
| `<one-lobby>` drop-in element; per-engine recipes with "Done when"; headless two-player test recipe; AGENTS.md and llms.txt | `players.identity: anonymous` as an enforced mode; `lobby.password` on server lobbies; `listed` / `approveJoins` as two booleans over `visibility` |
| Replication (C#) | The agent skill, the plugin, the cursor/copilot pointers |
| | `create-onelobby` and its templates |
| | Steam / Epic / Discord adapters (s.9) |

---

## 9. Steam, Epic, Discord: scoped as adapters, later

DESIGN.md already decided the shape: "Steam / Epic / Discord are optional adapters that plug into the same lobby API"
and "Invites via platform adapters ... as an optional `ILobbyDirectory`". Nothing here changes the wire protocol or the
blueprint's runtime keys; a platform key only adds a package and generated glue. Three layers, built in order:

| Layer | What it gives the player | How | Phase |
|---|---|---|---|
| Directory and invites | "Join Game" on the Steam friends list; invite from the overlay; the lobby shows up for friends | A Steam lobby (GodotSteam: `createLobby(lobby_type, max_players)`; Steamworks.NET elsewhere) whose `SetLobbyData` holds the OneLobby join code (direct or server); Rich Presence `connect` carries the code, so a friend's click runs `kit.join(code)`. Steam lobby type follows `lobby.listed` / `approveJoins` (public / friends-only / private: the same three ideas) | 3 |
| Identity | `players.identity: "platform"`: the persona name, no name box | `GetFriendPersonaName`; never expose the Steam ID in `peers` (the seat id stays the id) | 3 |
| Transport | Play through Steam Datagram Relay: IPs hidden, works where UPnP fails | A transport over `ISteamNetworkingSockets` (`ConnectP2P` by Steam ID) behind the same `Lobby` API; the hub's signaling rides the Steam lobby chat. Largest piece; only if the directory layer proves wanted | 4 |

Epic: the same three layers against EOS lobbies (shared state, attributes with a schema, search, invites per privacy
setting, per the Unreal docs) and EOS P2P. Epic's own EOS pages could not be fetched anonymously, so the cap on lobby
members, the relay terms and the Connect/Device-ID anonymous login are **to confirm** before scoping work. Discord: the
Social SDK offers lobbies, voice and presence; not researched past that, so it stays a `false` key with no plan.

Blueprint today: `platforms.steam: true` is accepted by the schema and does nothing but make the agent and scaffolder
print "Steam adapter: not built yet, tracked in docs/design/blueprint.md s.9". Better an honest no-op than a key that
appears when the feature does.

---

## 10. Pause: scoped

Practice is split by genre. Real-time multiplayer does not pause (Terraria's autopause is "For singleplayer only";
Mirror, FishNet and Unity Netcode have no network pause). Slow or turn-based co-op does: Stardew Valley's host-only
`/pause` (wiki, older revision: not re-verified on the current page), Factorio's "Game is paused while there are no
players connected". So the key is three-valued and the default depends on the game.

| Value | Meaning | Who can unpause |
|---|---|---|
| `off` | no network pause; the pause menu is local and the sim keeps running (default for real-time) | |
| `host` | the host freezes the sim for everyone; a banner says "Paused by Ann" | the host only (Stardew) |
| `anyone` | any player freezes it, because life happens (RTS, strategy, long co-op sessions) | anyone; the banner names who paused and who resumed |

Which value the agent proposes (s.5, propose phase): `off` for real-time action (shooters, arcade, physics), where a
pause would be griefing; `anyone` for RTS, strategy and long co-op sessions, where any player may need to step away
(classic RTS games let any player pause: to verify per title before citing); `host` when one player clearly runs the
world (Stardew-style farms). A per-player pause budget (anti-grief) is a later option, not v2.

How it is built: in `lockstep` the host simply stops issuing frames, so every peer freezes in step; `TryNextFrame`
returns nothing and a `Paused(by)` / `Resumed` event fires. In `raw` and `replication` OneLobby cannot stop the game's
sim, so it adds one reserved control message and the same events; the generated glue calls the game's existing pause
function (the survey finds it; every game already has one for the Escape menu). Nothing in voice or chat pauses
(AGENTS.md rule 8). Phase 2.

---

## 11. Phased plan

| Phase | Ships | Done when |
|---|---|---|
| **v1** | `spec/blueprint.schema.json` + vectors; `OneLobby.fromConfig` (JS) and `Blueprint` (C#) with enforcement codes; the agent skill in `.claude/skills/onelobby/` plus the AGENTS.md section; `create-onelobby` with the `web` template, all flags, `--yes`, `--no-input`, `--dry-run`, `--json` | `npm create onelobby@latest demo -- --template web --yes --no-input` produces a game whose `test/multiplayer.mjs` passes; the skill takes `examples/tictactoe` to a passing two-player test with no human input beyond "go"; editing `chat.voice` by hand toggles the voice button with no rebuild |
| **v2** | Templates `node-browser`, `godot-csharp`, `unity`, `dotnet`; `session.pause`; `players.identity: anonymous` enforced; `lobby.password` on server lobbies; drift warning; SchemaStore listing | Each template's generated test passes on its engine; pause freezes two headless lockstep players and resumes |
| **v3** | Steam adapter: directory + invites + identity (`platforms.steam`), Godot and Unity first | A friend's "Join Game" click lands in the OneLobby lobby; the Steam ID never appears in `peers` |
| **v4** | Steam transport over SDR; Epic adapter after confirming the EOS facts; Discord if asked for | |

v1 deliberately has one template. The schema and `fromConfig` are the product; templates are copies of recipes.

---

## 12. Open taste calls

Practice settled everything else. Three remained; each has a default that gets built unless the designer says no.

**1. May the agent build without stopping when every setting is a default?**
Today the plan has a hard stop after the proposal (s.5 phase 4). Yes: when the survey finds nothing unusual (no
lockstep, no voice, no platform keys), the agent prints the proposal and builds in the same turn, so "make it
multiplayer" is one message. No: it always stops once, so the developer reads the file before any code changes.
`Default:` yes, one message when all defaults; always stop when any key deviates.

**2. Is voice off until the developer asks for it?**
Today nothing decides. Yes: `chat.voice` defaults to `false` and the agent only proposes `true` when the survey finds
a reason (team play, long sessions); the mic prompt and the ESRB "Users Interact" disclosure are opt-in. No: voice
defaults on for any game with three or more players, the way text chat does.
`Default:` yes, off unless proposed with a reason.

**3. When the host pauses, can only the host unpause?** Decided (designer, 2026-10-25): it depends on the game, so
both modes stay. In `"host"` only the host pauses and unpauses (Stardew); in `"anyone"` any player pauses and any
player unpauses ("some games, RTS or an ant colony game, should let anyone pause, because life happens"). The agent
proposes the mode by genre (s.10).

---

## 13. Sources

- Vite: [guide](https://vite.dev/guide/), [config](https://vite.dev/config/)
- npm: [npm init](https://docs.npmjs.com/cli/v11/commands/npm-init)
- Scaffolders: [create-next-app](https://nextjs.org/docs/app/api-reference/cli/create-next-app), [create-t3-app](https://create.t3.gg/en/installation), [create-astro](https://github.com/withastro/astro/tree/main/packages/create-astro), [Angular ng new](https://angular.dev/cli/new)
- CLI practice: [Command Line Interface Guidelines](https://clig.dev/)
- Editors: [VS Code JSON and schemas](https://code.visualstudio.com/docs/languages/json), [SchemaStore catalog](https://www.schemastore.org/api/json/catalog.json)
- Engines: [Mirror NetworkManager.cs](https://raw.githubusercontent.com/MirrorNetworking/Mirror/master/Assets/Mirror/Core/NetworkManager.cs), [Mirror NetworkManager docs](https://mirror-networking.gitbook.io/docs/components/network-manager), [Unity Netcode NetworkManager](https://mp-docs.dl.it.unity3d.com/netcode/current/components/networkmanager), [FishNet ServerManager](https://fish-networking.gitbook.io/docs/fishnet-building-blocks/components/managers/server-manager), [Photon PUN initial setup](https://doc.photonengine.com/pun/v2/getting-started/initial-setup), [Unity Application.runInBackground](https://docs.unity3d.com/ScriptReference/Application-runInBackground.html), [Godot ENetMultiplayerPeer](https://docs.godotengine.org/en/stable/classes/class_enetmultiplayerpeer.html), [Godot high-level multiplayer](https://docs.godotengine.org/en/stable/tutorials/networking/high_level_multiplayer.html), [GodotSteam lobbies](https://godotsteam.com/tutorials/lobbies/)
- Platforms: [Steam ISteamMatchmaking](https://partner.steamgames.com/doc/api/ISteamMatchmaking), [Steam ISteamFriends](https://partner.steamgames.com/doc/api/ISteamFriends), [Steam ISteamNetworkingSockets](https://partner.steamgames.com/doc/api/ISteamNetworkingSockets), [Epic lobbies interface (Unreal)](https://dev.epicgames.com/documentation/en-us/unreal-engine/lobbies-interface-in-unreal-engine), [Nakama](https://github.com/heroiclabs/nakama), [Nakama authentication](https://heroiclabs.com/docs/nakama/concepts/authentication/), [Discord Social SDK](https://discord.com/developers/docs/social-sdk/index.html)
- Identity and ratings: [Apple App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), [ESRB ratings guide](https://www.esrb.org/ratings-guide/)
- Pause in shipped games: [Factorio wiki: Multiplayer](https://wiki.factorio.com/Multiplayer), [Terraria wiki: Settings](https://terraria.wiki.gg/wiki/Setting), [Stardew Valley wiki](https://stardewvalleywiki.com/) (host-only `/pause`, older revision)
- Agent conventions: [agents.md](https://agents.md/), [llms.txt](https://llmstxt.org/), [Claude Code skills](https://code.claude.com/docs/en/skills), [Claude Code plugins](https://code.claude.com/docs/en/plugins), [MCP](https://modelcontextprotocol.io/docs/getting-started/intro), [Cursor rules](https://cursor.com/docs/context/rules), [Copilot custom instructions](https://docs.github.com/en/copilot/concepts/prompting-and-context/custom-instructions)
- Why: [Stop Killing Games (Wikipedia)](https://en.wikipedia.org/wiki/Stop_Killing_Games)
- This repo: AGENTS.md, DESIGN.md s.1 and s.2, docs/recipes/*.md, `clients/js/packages/client/src/onelobby.ts` (`OneLobbyOptions`, `HostOptions`), `clients/dotnet/OneLobby.Core/Api.cs` (`OneLobbyConfig`, `LobbyOptions`), `clients/dotnet/OneLobby.Direct/DirectLobby.cs` (`DirectHostOptions`), `clients/js/packages/client/src/ui/element.ts` (`<one-lobby>`)
