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
replication (JS/C#), voice and text chat (JS/C#), pause (JS/C#), `tools/engine-smoke` (JS, GDScript, C# incl. a local TURN).

Missing or half there:

| Area | Gap |
|---|---|
| GDScript | Raw bytes only: no blueprint loader, chat, pause, lockstep helper. Schema `engine` has no `godot-gdscript`. The skill refuses GDScript games. |
| Scaffolder | `create-onelobby` builds `web` only; Godot and Unity templates throw `template_planned`. Nothing installs or updates engine add-ons. |
| UI | No drop-in menu for Godot or Unity. The web `<one-lobby>` element has no kick, ready, settings or browse. |
| Room layer | No ready toggle, per-player data (colour, team, seat), spectators, countdown, rematch, name dedupe. |
| Ban | Per lobby, by IP, forgotten when the lobby ends. No game shows kick/ban in its UI. |
| Settings | Nothing persists name, relay line or last code outside the browser. |
| Errors | Plain-language `describeError` exists in JS only. Players never see *why* a connection failed. |
| Verify | No one-command two-peer test for a game; Unity is not in engine-smoke. |
| Recommendation | The skill has sync-mode rules; the scaffolder asks instead of recommending. |

Full matrix with file references: kept with the desk notes (not in this repo).

---

## 2. The core list (what "by default" means)

Every item works in JS, C#/Unity and GDScript (Godot C# goes through C#), is on in the drop-in menu, and is a blueprint
key where it is a choice.

**Connecting.** Join code, join by IP or `ip:port`, invite link (and deep link where the platform has one), one join
call that walks the whole route chain (lobby server, then Nostr code, then direct IP; STUN; TURN if set; relay-only
retry), player-pasted relay line, LAN discovery (same-network broadcast), rejoin after a drop with the token saved.

**Lobby.** Player names (default name, length clamp, sanitise, dedupe as "Name 2", rename), per-player data (colour,
avatar index, team or seat), ready toggle, host settings (max players, password on every route, listed or private),
lobby browser, approve joins, **kick** and **ban** in the roster with the reason shown to the kicked player, bans that
survive the lobby (host-side list keyed by a per-install player id, IP as fallback), late join policy, spectators,
bots filling empty seats (a seat-dropped hook the game answers with its bot).

**Session.** Start with countdown, auto-start at N players, back to lobby and rematch, pause rules, graceful leave
(`leave_and_flush`), host migration on direct lobbies (GDScript and C#), version gate (`<wire>.<content hash>` helper)
with the refusal reason in plain words.

**Chat.** Text chat everywhere (GDScript gains it), voice where the engine has audio capture (JS, C#/Unity, Godot C#),
mute per player, speaking indicator.

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
5. **Drop-in menus.** Godot scene (GDScript and C#), Unity uGUI prefab, upgraded `<one-lobby>` element. All read
   `onelobby.json`. Name, Host (big code, Copy code, Copy invite), Join (paste, cleaned), roster with ready, kick and ban,
   relay field, connection check, browse (when a server is set), error screen with Copy logs. Plain engine-default look;
   games restyle (a default; a styled look can come later). 2 lanes (Godot, Unity+web).
6. **Tooling.** `create-onelobby` templates `godot-gdscript`, `godot-csharp`, `unity` plus `--into` for existing projects:
   vendor the add-on with natives, `extension_list.cfg`, LF guard (`.gitattributes`), PIN file, autoload or runner,
   `onelobby.json`, olc entry. `create-onelobby update` (re-vendor to a sha or release). `create-onelobby verify`: two
   headless peers on 127.0.0.1 through a local Nostr relay and a local TURN, plus relay-only, one verdict line; Unity
   batchmode where available. 2 lanes.
7. **Architecture recommender** (section 5) in the skill and `create-onelobby --recommend "<one-line game description>"`.
8. **GDScript sync helpers.** Text chat, shared pause, a lockstep helper with the fast-channel input pattern (section 5).
9. **Skill rewrite.** Accept GDScript; one pass: survey, propose `onelobby.json` with reasons, build with the templates and
   drop-in menu, verify with `create-onelobby verify`, report. Fix stale lines (pause exists).
10. **Proof (section 6)**, then move the existing games onto the drop-in pieces where it removes their own code.

Estimate (a guess): about 13 lanes. Today's lanes took 6 to 50 minutes each, so roughly a day of agent time at 2 lanes.
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
   login accepted, and the result in one line ("Direct connections: likely to fail. A relay is recommended.").
4. **Net log.** A ring buffer of every connection step with timings (state changes, candidate types, chosen route, errors,
   versions, OS). Written to the player's user folder, flushed on a crash or quit. IP addresses masked by default.
5. **No harvesting.** Nothing is sent to OneLobby or any server we run. The log stays on the player's machine or goes to the
   host they joined.

Done when: a joiner behind a simulated strict NAT with no relay sees `nat_blocked` on their own screen within the ready
timeout, the host sees the same line, and Copy logs gives a log that names the cause, all from a test on 127.0.0.1.

---

## 5. Architecture recommendation by game type

From what the games actually ended up with (several changed after setup; the recommender skips those detours).

| Game shape | Recommend | Why |
|---|---|---|
| Fixed-tick, deterministic, small inputs (party minigames, RTS on a seeded sim) | Lockstep; inputs on the fast channel with the last N ticks repeated, adaptive input delay, state hash every ~60 ticks, bots take dropped seats | A reliable ordered input channel stalled one game about half its frames at 80 ms and 2% loss; redundancy on the fast channel fixed it |
| Free-roam co-op with rich state (survival, sandbox) | Host-authoritative snapshots, ~10-20 Hz, joiner predicts its own actions, binary deltas against an acked baseline once state passes ~3 KB, reliable keyframe every few seconds | Whole-state JSON at 10 Hz outgrew the link in one game |
| Shooters and physics in a non-deterministic engine (Unity) | Replication (host authority, interpolation, owner prediction, hit rewind capped ~350 ms), 30 Hz sim / 20 Hz snapshots | Unity physics isn't deterministic, so lockstep is out |
| Turn-based, card, board | Raw messages, host is truth, no tick | Nothing to sync between turns |
| An existing server-style game | OneLobby as a WebSocket transport (`asWebSocket`) | Keeps the game's own server loop |

Player count from the design (2-4 default, 8 for party games, spectators separate). Hosting: direct with Nostr codes
everywhere the engine can listen (games outlive any server), lobby server optional.

---

## 6. Proof

1. An agent with only the skill, told "make this multiplayer", gets a fresh Godot GDScript game, a fresh Unity game and a
   fresh web game to a passing `create-onelobby verify` in one pass, with no manual steps.
2. The same on a copy of an existing game that already had hand-built multiplayer: the drop-in pieces replace its menu,
   relay field, settings and smoke test, and its own tests still pass.
3. The section 4 "Done when" test.
4. engine-smoke stays green, plus Unity in batchmode where the runner has it.

0.7.2 ships after phase 1 (network routes, already merged and adopted) and this phase both pass, in one release.
