# Networked players (JS)

Players in the world with no player sync of your own: position, facing, movement state, jump, shoot, melee and the rest,
smooth on every other screen. Built on `ReplicationSession` (`docs/recipes/replication.md`); the wire and every number are in
`spec/net-player.md`.

**Status: JS only.** The Godot `NetPlayer` node, the Unity `NetPlayer` component and the GDScript and C# code are the next
lanes; they will be built from the spec and its vectors. Everything here is proven on an in-memory network with a virtual clock
and nothing else: no two processes, no real link and no real game engine have run it, and nobody has looked at a networked
player on a screen. The smoothing numbers are the plan's numbers, not tuned by eye.

A game that does not use the layer sees no change: no new entity, no new message, the same bytes.

## 1. What a player is

One replicated entity of the reserved type id 65535 per seated peer (not spectators), owned by that peer. Its state is the
player preset (`spec/net-player.md` section 2): position, velocity, facing, aim, on-ground, movement mode, held item, aiming,
blocking, health, alive, team, and a teleport counter. Action events (jump, land, shoot, melee, reload, use, item switch,
throw, hit, death, respawn, emote) travel next to it, arrive exactly once and play when the other screens' render time reaches
their tick. Players appear and disappear on their own as peers come and go.

## 2. Who places a player

Who places a player is decided by the game type: the player's own PC for co-op, the host for competitive, and the player's own
PC when a game does not say; the game maker can overrule it in `onelobby.json` (`sync.player.authority`).

- **`"owner"`** (the default): your game moves its own character as it always did and hands the state to the layer each tick.
  Nothing to predict, nothing to correct, and the host trusts its friends (with the limits of section 6 if you set them). Use
  it for co-op, sandbox, party games.
- **`"host"`**: you write one movement function, `step(state, input, dt) -> state`. The host runs it for every player and the
  owner runs it at once on its own screen, then corrects itself when the host disagrees (blended over 100 ms, snapped past
  2.0 m on the ground plane or 0.5 m vertically). A player cannot place itself. Use it for competitive games. The step must
  depend only on its three arguments.

`npx create-onelobby --recommend "..."` proposes `host` for the shooter and physics shape and `owner` for the free-roam co-op
shape.

## 3. `"owner"`: a working example

```ts compile file=owner.ts
import type { Lobby } from "onelobby";
import { NetPlayers } from "onelobby";

declare function addAvatar(peer: number): void;
declare function removeAvatar(peer: number): void;
declare function moveAvatar(peer: number, x: number, y: number, z: number, yaw: number): void;
declare function playGunshot(peer: number, yaw: number, pitch: number): void;
declare const me: { x: number; y: number; z: number; yaw: number; running: boolean };

export function start(lobby: Lobby): NetPlayers {
  const players = new NetPlayers(lobby); // or NetPlayers.fromBlueprint(lobby, parseBlueprint(json))
  players.on("playerJoined", (peer) => addAvatar(peer));
  players.on("playerLeft", (peer) => removeAvatar(peer));
  players.onAction("shoot", (e) => playGunshot(e.player, e.args.yaw, e.args.pitch)); // other screens: at the shooter's tick
  players.on("corrected", (s) => { me.x = s.x; me.y = s.y; me.z = s.z; }); // the host put you back (a limit): take its state

  function frame(): void {
    players.setLocalState({ x: me.x, y: me.y, z: me.z, yaw: me.yaw, mode: me.running ? 2 : 1, onGround: true });
    players.pump(); // instead of session.pump(): runs the due ticks, snapshots, events and corrections
    for (const peer of players.players) {
      if (peer === players.localPeerId) continue;
      const s = players.get(peer); // smoothed, a short delay behind
      if (s) moveAvatar(peer, s.x, s.y, s.z, s.yaw);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return players;
}
// when the player jumps: players.action("jump"); when it fires: players.action("shoot", { yaw: me.yaw, pitch: 0 });
```

## 4. `"host"`: a working example

```ts compile file=host.ts
import type { Lobby } from "onelobby";
import { NetPlayers, type PlayerInput, type PlayerState } from "onelobby";

declare function moveAvatar(peer: number, x: number, y: number, z: number): void;
declare function readKeys(): { right: number; forward: number; yaw: number; fire: boolean };

// the same function on the host and in every owner's prediction
function step(s: PlayerState, i: PlayerInput, dt: number): PlayerState {
  return { ...s, x: s.x + i.moveX * 6 * dt, z: s.z + i.moveY * 6 * dt, vx: i.moveX * 6, vz: i.moveY * 6, yaw: i.yaw };
}

export function start(lobby: Lobby): NetPlayers {
  const players = new NetPlayers(lobby, { authority: "host", step, spawn: () => ({ y: 1 }) });
  players.onAction("shoot", (e) => {
    // host: judge the hit where the shooter saw the target
    for (const peer of players.players) {
      if (peer === e.player) continue;
      const then = players.rewound(peer, e.args.view);
      if (then && Math.hypot(then.x - 0, then.z - 0) < 0.5) players.hostAction(peer, "hit", { by: e.player, damage: 20 });
    }
  });

  function frame(): void {
    const k = readKeys();
    players.setLocalInput({ moveX: k.right, moveY: k.forward, yaw: k.yaw, buttons: { fire: k.fire } });
    players.pump();
    const me = players.local; // predicted; draw it at me + players.smoother.offset
    const o = players.smoother.offset;
    moveAvatar(players.localPeerId, me.x + o.x, me.y + o.y, me.z + o.z);
    for (const peer of players.players) {
      const s = players.get(peer);
      if (s && peer !== players.localPeerId) moveAvatar(peer, s.x, s.y, s.z);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return players;
}
```

## 5. The API

`new NetPlayers(lobbyOrSession, options)`; `NetPlayers.fromBlueprint(lobby, blueprint, extra?)` reads `sync.player` and
`sync.tickRate`. A lobby gets its own `ReplicationSession` (`players.session`) with the adaptive render delay on; pass a
session you made (with `adaptiveDelay: true`) to configure it yourself. Options are the `sync.player` keys (`authority`,
`space`, `range`, `velocityRange`, `limits`, `omit`) plus `step`, `spawn` and `session`.

| name | what |
|---|---|
| `players.pump()` | every frame, instead of `session.pump()`; runs ticks, snapshots, events, corrections |
| `players.on("playerJoined" \| "playerLeft", peer => ...)` | a player came or went (the local one included) |
| `players.on("tick", tick => ...)` | one local tick is due: step your own world here (host: before the snapshot) |
| `players.on("corrected", state => ...)` | owner: the host put you back; take `state` |
| `players.on("limitViolation", (peer, limit) => ...)` | host: an owner broke a limit |
| `players.on("action", e => ...)` / `players.onAction(name, e => ...)` | an action event; `e` has `player`, `name`, `args`, `tick`, `seq`, `late`, `local`. Returns the unsubscribe function |
| `players.setLocalState(patch)` | owner: your state, every tick (a patch is merged; the teleport counter is kept for you) |
| `players.setLocalInput(patch)` | host mode: this tick's input (`moveX`, `moveY`, `yaw`, `pitch`, `buttons`) |
| `players.local` / `players.smoother.offset` | your own state (host mode: predicted) and the blended correction to add when drawing |
| `players.get(peer)` | a player's state to draw now: smoothed, shortest-arc yaw, carried on by velocity for at most 250 ms past the newest snapshot, then held |
| `players.latest(peer)` | the authoritative state in the newest snapshot (host: its own record) |
| `players.players` | the peers that have a player in the world |
| `players.action(name, args)` | send an action event of the local player; it plays here at once |
| `players.hostAction(peer, name, args)` | host: raise an event for any player (`hit`, `death`) |
| `players.teleport(patch)` / `players.respawn(patch)` | put the local player somewhere without sliding (owner mode, or the host's own player) |
| `players.teleportPlayer(peer, patch)` / `players.respawnPlayer(peer, patch)` | host: place any player (the owner is told to take the state) |
| `players.stateAt(peer, tick)`, `players.rewound(peer, view)`, `players.rewindTick(view)` | host: where a player was, for hit rewind |
| `players.bytesPerSecond(peer)` | `{ sent, received }` replication bytes per second with that peer |
| `players.stats` | counters: `actionsSent`, `actionsPlayed`, `actionsLate`, `actionsDuplicate`, `actionsRateLimited`, `actionsRejected`, `statesRejected`, `limitViolations`, `corrections` |

Names of state fields and action arguments are those of `spec/net-player.md` (`x y z vx vy vz yaw pitch onGround mode item
aiming blocking health alive team teleport`; `shoot` has `yaw`, `pitch`, `view`). `Reconciler`, `PredictionSmoother` and
`HistoryRing` are exported on their own for games that want the pieces (they are the JS twins of the C# helpers).

## 6. The host's limits

`sync.player.limits`: `maxSpeed`, `maxStep` (owner mode), `minShotIntervalMs`, `minMeleeIntervalMs`. A limit that is not set
is not checked. When an owner's claimed move breaks one, the host keeps its last accepted position, raises the teleport
counter and puts the owner back (the owner's `corrected` event). A shot or swing over its limit is dropped and counted
(`stats.actionsRateLimited`), and nobody else ever sees it. An honest teleport (respawn, portal) passes: the layer raises the
counter, and the host accepts one such jump per second.

These are basic protection from glitches and cheats. They are **not an anti-cheat**: a player under the limits is not
stopped, and a client can still read everything the host sends it.

## 7. Hit rewind

The host records every player's state each tick. A `shoot` event carries `view`, the tick the shooter was seeing;
`players.rewound(target, e.args.view)` is where the target was then, clamped by the session's `maxRewindMs` (default 250 ms,
enough for links up to about 60 ms one way; raise it for slower ones). You decide what a hit is.

## 8. `onelobby.json`

```json
{ "game": { "id": "com.example.arena" }, "sync": { "mode": "replication", "player": {
  "authority": "host", "space": "3d", "range": 300,
  "limits": { "maxSpeed": 9, "minShotIntervalMs": 120 }, "omit": ["emote", "blocking"] } } }
```

Needs `sync.mode: "replication"`. Absent means the defaults (owner, 3d, range 300, no limits, nothing left out). Reasons for each
key: `docs/design/blueprint.md` section 4e. A game's own extra fields and events are not in the file yet.

## 9. What is not built yet

- The Godot `NetPlayer` node (reads a `CharacterBody2D` / `CharacterBody3D` and the `AnimationTree`), the Unity component, the
  GDScript client code and the C# client code of the player layer.
- An adapter for any JS game engine; this layer talks plain numbers.
- A dropped player is despawned at once (the rejoin window does not keep it frozen), and a rejoin starts a new player.
- Your own extra state fields and events in `onelobby.json`: send your own entity or `sendEvent` for now.

## Done when

Two peers in a lobby (`players.players` has both on each side), the other peer's `players.get(peer)` follows the owner a short
delay behind and never stands still longer than 250 ms while it moves, and every action you send arrives once on the other
screen: the in-memory tests of `clients/js/packages/client/test/net-player*.test.ts` run exactly that.
