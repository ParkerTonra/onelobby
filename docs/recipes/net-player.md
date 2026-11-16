# Networked players (JS, GDScript and C#)

Players in the world with no player sync of your own: position, facing, movement state, jump, shoot, melee and the rest,
smooth on every other screen. Built on `ReplicationSession` (`docs/recipes/replication.md`); the wire and every number are in
`spec/net-player.md`.

**Status: JS, GDScript and C#** (the GDScript side is section 10: the `OneLobbyNetPlayer` node, the spawner and the layer; the C# side is section 11:
the layer in `OneLobby.Replication`, the same wire). The Unity `NetPlayer` component and a Godot C# node are the next lane. The JS and C# sides are
proven on an in-memory network with a virtual clock and nothing else; the GDScript side on the same kind of rig and, in CI, by two
headless processes of a sample on one PC. No real link and no real game engine window has run it, and nobody has looked at a
networked player on a screen. The smoothing numbers are the plan's numbers, not tuned by eye.

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
    const me = players.local; // predicted; undefined until the host's first state of your player has arrived (nothing to draw yet)
    const o = players.smoother.offset;
    if (me) moveAvatar(players.localPeerId, me.x + o.x, me.y + o.y, me.z + o.z); // draw it at me + players.smoother.offset
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
| `players.local` / `players.smoother.offset` | your own state (host mode: predicted) and the blended correction to add when drawing. Host mode on a client: `players.local` is `undefined` until the host's first state of your player has arrived (it starts where the host spawned it, never at the origin); inputs before that are not sent or stepped |
| `players.get(peer)` | a player's state to draw now: smoothed, shortest-arc yaw, carried on by velocity for at most 250 ms past the newest snapshot, then held. On the host: the host's own record of that player, one tick behind and interpolated (a teleport snaps) |
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
`players.rewound(target, e.args.view)` is where the target was then, clamped by the session's `maxRewindMs` (default 250 ms). The
shooter's view is its render delay (66.7 ms up to 250 ms) plus two one-way trips old, so the default covers about 60 ms one way
and leaves almost no room: on such a link a few shots are past the limit and are judged at the oldest allowed state, off by the
target's speed times the time past it. For slower links raise it with `session: { maxRewindMs: 400 }` (400 ms finds every shot on a
60 ms link); the most it can reach is the history the host keeps, `historyTicks` (64 ticks, about 2.1 s at 30 Hz; raise that too
to go further). You decide what a hit is. Details: `spec/net-player.md` section 8.

## 8. `onelobby.json`

```json
{ "game": { "id": "com.example.arena" }, "sync": { "mode": "replication", "player": {
  "authority": "host", "space": "3d", "range": 300,
  "limits": { "maxSpeed": 9, "minShotIntervalMs": 120 }, "omit": ["emote", "blocking"] } } }
```

Needs `sync.mode: "replication"`. Absent means the defaults (owner, 3d, range 300, no limits, nothing left out). Reasons for each
key: `docs/design/blueprint.md` section 4e. A game's own extra fields and events are not in the file yet.

## 9. What is not built yet

- The Unity component and a Godot C# node (the C# layer itself is section 11; the Godot node and the GDScript code are section 10).
- An adapter for any JS game engine; this layer talks plain numbers.
- A dropped player is despawned at once (the rejoin window does not keep it frozen), and a rejoin starts a new player.
- Your own extra state fields and events in `onelobby.json`: send your own entity or `sendEvent` for now.

## 10. Godot (GDScript)

The GDScript client has the same layer on the same wire (a JS peer and a GDScript peer can be in one game): `OneLobbyNetPlayers`
(the layer, no scene tree), `OneLobbyNetPlayer` (a node under the character) and `OneLobbyNetPlayerSpawner` (one character per
seated player). Names are snake_case; states, inputs and events are Dictionaries with the keys of `spec/net-player.md` in snake_case
(`x y z vx vy vz yaw pitch on_ground mode item aiming blocking health alive team teleport`). The settings are `sync.player` of
`onelobby.json` (`OneLobbyConfig`), and it needs `sync.mode: "replication"`. A scene to look at: `clients/gdscript/examples/net_player_demo`
(flat floor, capsules that walk and jump, a colour per team, a name per player; it opens after the menu's "game started").

**The node.** Put a `OneLobbyNetPlayer` under the game's character (`CharacterBody3D`, `CharacterBody2D`, or any `Node3D` / `Node2D`;
2D or 3D follows `sync.player.space`, a parent of the other kind is one clear error). The spawner sets its `peer_id` and binds it.

| on | the node does |
|---|---|
| the machine that owns the player, `"owner"` | each physics frame it reads the parent (global position, `velocity` and `is_on_floor()` of a `CharacterBody`, yaw from `rotation_degrees`) plus the values you set on the node (`pitch`, `mode`, `item`, `aiming`, `blocking`, `health`, `alive`, `team`) and hands them to the layer. You move your character as you always did. `auto_mode` (on by default) derives `mode` (idle, walk, jump, fall) from the movement |
| the machine that owns the player, `"host"` | you call `set_input({...})` each physics frame; the node predicts with your `step_function` (`Callable(state, input, dt) -> state`, the same function on the host and every owner; without one it logs one clear error) and draws the predicted position plus the smoothed correction. Until the host's first state of the player has arrived there is nothing to write: the node leaves the character where the game put it (never the origin) and `set_input` is harmless; then the character starts where the host spawned it |
| every other machine | each rendered frame it writes the smoothed state into the parent (position, yaw; a teleport snaps) and exposes the rest as properties (`pitch`, `mode`, `on_ground`, `item`, `aiming`, `blocking`, `health`, `alive`, `team`, `velocity`). The character stays hidden until its first state has arrived |

| exported property / member | what |
|---|---|
| `peer_id` | the peer this player belongs to (the spawner sets it) |
| `animation_player`, `mode_animations` | path to an `AnimationPlayer`; it plays `mode_animations[mode]` (defaults for idle, walk, run, crouch, jump, fall, swim, climb, fly; a missing animation is skipped silently) |
| `animation_tree`, `animation_params` | path to an `AnimationTree`; each `{value name: parameter path}` of the map is set (`mode`, `speed`, `on_ground`, `aiming`, `blocking`, `alive`, `health`, `item`, `team`) |
| `auto_mode`, `hide_until_first_state` | see above |
| `step_function`, `is_local` | host authority: the step function; true for the player this machine controls |

Signals, one per action event, played at the right tick (a jump lines up with the body that jumps; also for the local player, at
once): `jumped`, `landed(impact)`, `shot(yaw, pitch, view)`, `melee(swing)`, `reloaded`, `used(target)`, `item_switched(slot)`,
`thrown(yaw, pitch, power)`, `hit(by, damage)`, `died(by)`, `respawned`, `emoted(emote)`. Methods the owner calls to start one:
`jump()`, `land(impact)`, `shoot(yaw, pitch)`, `melee_attack(swing)` (`melee` is the signal), `reload()`, `use(target)`,
`switch_item(slot)`, `throw_item(yaw, pitch, power)`, `emote(id)`, `respawn(to)`, `teleport(to)`; the host raises `hit` and `died` with
`hurt(by, damage)` and `kill(by)` (it may start any player's event through that player's node).

```gdscript compile file=net_player_character.gd
extends CharacterBody3D
## A character scene: this body with a OneLobbyNetPlayer child named NetPlayer. Authority "owner": move it as you always did.

@onready var net: OneLobbyNetPlayer = $NetPlayer


func _ready() -> void:
	net.shot.connect(func(yaw: float, pitch: float, _view: int) -> void: print("bang from ", net.peer_id, " at ", yaw, " ", pitch))
	net.jumped.connect(func() -> void: print("jump of ", net.peer_id))
	net.health = 100
	net.team = 1


func _physics_process(delta: float) -> void:
	if not net.is_local:
		return # on the other machines the node moves this character
	velocity.x = Input.get_axis("ui_left", "ui_right") * 5.0
	velocity.z = Input.get_axis("ui_up", "ui_down") * 5.0
	velocity.y = velocity.y - 18.0 * delta if not is_on_floor() else 0.0
	if is_on_floor() and Input.is_action_just_pressed("ui_accept"):
		velocity.y = 6.0
		net.jump() # the others get `jumped` at the right moment
	move_and_slide()
```

Authority `"host"`: the node moves the character, you give it input and a step (one step of your own movement, on a state dictionary):

```gdscript compile file=net_player_host_character.gd
extends CharacterBody3D
## Authority "host": the game gives the node its input each physics frame and a pure step function.

@onready var net: OneLobbyNetPlayer = $NetPlayer


func _ready() -> void:
	net.step_function = Callable(self, "step") # must be deterministic: it also runs on the host


func step(state: Dictionary, input: Dictionary, dt: float) -> Dictionary:
	var out := state.duplicate()
	out["x"] = float(state["x"]) + float(input["move_x"]) * 6.0 * dt
	out["z"] = float(state["z"]) + float(input["move_y"]) * 6.0 * dt
	out["yaw"] = input["yaw"]
	return out


func _physics_process(_delta: float) -> void:
	if net.is_local:
		net.set_input({"move_x": Input.get_axis("ui_left", "ui_right"), "move_y": Input.get_axis("ui_up", "ui_down"), "yaw": rotation_degrees.y, "buttons": {"fire": Input.is_action_pressed("ui_accept")}})
```

**The spawner.** Give `OneLobbyNetPlayerSpawner` the lobby (the menu's `game_started` lobby), the game's `PackedScene` and, optionally, a
spawn point; it makes the layer (`OneLobbyNetPlayers.from_config`), pumps it every frame, adds one character per seated player
(your own at once, marked local so you can attach a camera and input), and frees it when the player leaves:

```gdscript compile file=net_player_game.gd
extends Node3D

@export var character: PackedScene
var spawner: OneLobbyNetPlayerSpawner


func start(lobby: OneLobbyLobby, cfg: OneLobbyConfig) -> void:
	spawner = OneLobbyNetPlayerSpawner.new()
	spawner.scene = character
	spawner.spawn_point = func(peer: int) -> Vector3: return Vector3(float(peer) * 2.0, 1.0, 0.0)
	spawner.player_spawned.connect(func(peer: int, _node: Node, is_local: bool) -> void:
		print("player ", peer, " is here", " (this machine)" if is_local else ""))
	add_child(spawner)
	var players := spawner.start(lobby, cfg) # the layer: players.stats, players.rewound(...), players.host_action(...)
	players.limit_violation.connect(func(peer: int, limit: String) -> void: print(peer, " broke the ", limit, " limit"))
```

A game that wants to do all this itself uses the layer directly (`OneLobbyNetPlayers.from_config(lobby, cfg)`, `pump()` every frame,
`set_local_state` / `set_local_input`, `get_state(peer)`, `send_action`, `on_action`, ...: the table of section 5 with snake_case names;
`get` is `get_state`, `latest` is `latest_state`, `local` is `local_state()`, `players` is `player_ids()`, `action` is `send_action` and
the signal for every action is `action_played`). Where the host draws the other players itself, `get_state(peer)` gives their host
record one tick behind, interpolated (the JS `get` does the same). Authority `"host"` on a client: `local_state()` is an empty
Dictionary (and `get_state` of the local player is null) until the host's first state of your player has arrived; JS `local` is
`undefined` then.

**What is proven, in these words.** Everything on the GDScript side is proven on an in-memory rig (D1 to D9 of
`clients/gdscript/tests/net_player.gd`, the scene-tree test `net_player_node.gd`) and, in CI, by two headless processes of the sample on
one PC (`net-player-test.sh`). Nobody has seen a networked player move on a screen, the smoothing numbers are the plan's and not tuned
by eye, and no real link (Wi-Fi, the internet, a relay) has carried it. To look at it yourself, open two windows (both `--local`, which
keeps every socket on 127.0.0.1):

```
godot --path clients/gdscript res://examples/net_player_demo/main.tscn -- --host --local --name=Sam
godot --path clients/gdscript res://examples/net_player_demo/main.tscn -- --join=127.0.0.1:47810 --local --name=Alex
```

## 11. C# (plain .NET, Godot C#, Unity)

`OneLobby.Replication` has the same layer on the same wire, so a C# peer, a JS peer and a GDScript peer can be in one game:
`NetPlayers` (the layer; no engine type anywhere in it), with `PlayerCodec` / `PlayerWire` (the bytes) under it. **The Unity
`NetPlayer` component and a Godot C# node do not exist yet** (the next lane). Until then a game calls the layer from its own
`MonoBehaviour` or `Node`: pump it every frame, hand it your player each tick, draw the other players from `Get(peer)`, and
make the characters yourself from `PlayerJoined` / `PlayerLeft`. Names are the JS ones in PascalCase; a state is a `PlayerState`
struct (`X Y Z Vx Vy Vz Yaw Pitch OnGround Mode Item Aiming Blocking Health Alive Team Teleport`, doubles for the numbers), an
input is a `NetPlayerInput` struct (`MoveX MoveY Yaw Pitch` and a `PlayerButtons` flags value), event arguments are one `ActionArgs`
struct (the event decides which fields travel), and events are the `PlayerAction` enum. `new PlayerState()` is the default
player (alive, health 100, on the ground); `default(PlayerState)` is all zero, so always use `new`. (The input struct is `NetPlayerInput`: a game often has its own `PlayerInput`, Unity's input system has one.)

Make it from a raw-mode `Lobby` (`NetPlayers.FromConfig(lobby, blueprint)` reads `sync.player` and `sync.tickRate`; `new
NetPlayers(lobby, options)` takes the settings in code) or from a `ReplicationSession` you made (give that one
`new ReplicationConfig(AdaptiveDelay: true)` for smooth remote players; a session the layer makes has it on). Call
`players.Pump()` every frame instead of `session.Pump()`.

| what | C# |
|---|---|
| players in the world | `Players`, events `PlayerJoined(peer)` / `PlayerLeft(peer)` |
| give your player (owner) | `SetLocalState(state)` (the teleport counter in it is ignored: it is the layer's) |
| give your input (host) | `SetLocalInput(input)`; `Step` is `(state, input, dt) => state` and must be deterministic |
| draw a player | `Get(peer)` / `TryGet(peer, out state)`; yours is `Local` (host authority: draw at `Local` + `Smoother.Offset`) |
| newest authoritative state | `Latest(peer)` / `TryGetLatest` (on the host: its own record) |
| events | `Action(PlayerAction.Jump)`, `Action(PlayerAction.Shoot, new ActionArgs { Yaw = 10 })`; the event `OnAction` (every event, filter on `Name`) |
| host only | `HostAction(peer, ...)`, `TeleportPlayer`, `RespawnPlayer`, `TryRewound(peer, view, out state)`, `RewindTick`, `TryStateAt` |
| the local player | `Teleport(state)` / `Teleport(x, y, z)`, `Respawn()`, events `Corrected(state)`, `LimitViolation(peer, kind)` |
| numbers | `Stats`, `BytesPerSecond(peer)`, `Session.InterpolationDelayMs`, `Session.JitterMs` |

Owner authority, a game's own movement (twelve lines):

```csharp compile file=NetPlayerOwner.cs
using OneLobby;
using OneLobby.Replication;

public sealed class CoopGame
{
    private readonly NetPlayers _players;
    public CoopGame(Lobby lobby, Blueprint blueprint)
    {
        _players = NetPlayers.FromConfig(lobby, blueprint);
        _players.OnAction += e => { if (e.Name == PlayerAction.Jump) System.Console.WriteLine("player " + e.Player + " jumped"); };
    }
    public void Frame(PlayerState mine, bool jumped)
    {
        _players.SetLocalState(mine);                       // your own character, as you always moved it
        if (jumped) _players.Action(PlayerAction.Jump);
        _players.Pump();                                    // instead of session.Pump()
    }
    public PlayerState? Draw(int peer) => _players.Get(peer); // null while that player is not in the world
}
```

Host authority, one step function that runs on the host and in your prediction (twelve lines):

```csharp compile file=NetPlayerHost.cs
using OneLobby;
using OneLobby.Replication;

public sealed class ArenaGame
{
    private readonly NetPlayers _players;
    public ArenaGame(Lobby lobby)
    {
        _players = new NetPlayers(lobby, new NetPlayersOptions { Authority = PlayerAuthority.Host, Step = Step });
    }
    private static PlayerState Step(PlayerState s, NetPlayerInput i, double dt) { s.X += i.MoveX * 6 * dt; s.Z += i.MoveY * 6 * dt; s.Yaw = i.Yaw; return s; }
    public void Frame(double moveX, double moveY, double yaw)
    {
        _players.SetLocalInput(new NetPlayerInput { MoveX = moveX, MoveY = moveY, Yaw = yaw }); // sent and stepped once per tick
        _players.Pump();
        var drawn = _players.Local;                         // null until the host's first state of your player has arrived
        if (drawn is PlayerState p) System.Console.WriteLine(p.X + _players.Smoother.Offset.X);
    }
}
```

Behaviour is the other two clients' (spec section 13 lists what an implementer trips on): left-out fields shorten the state, the host
renumbers events it relays, a repeated input does not step and the host quantises after each step, the owner's teleport counter
moves by 1 and the host's by 4, and on the host `Get(peer)` for another player is the host's own record one tick behind,
interpolated through the hit-rewind history. A host-authority owner has no `Local` until the host's first state of it arrives and
sends and steps no input before that. A `Shoot` with `View` 0 gets your render tick x 256.

Things that differ from JS, on purpose: states are structs (no allocation per frame, copied by value), `Local` and `Get` are
`PlayerState?` instead of `undefined`, `OnAction` is one event for every action, `SetLocalState` takes the whole state (JS merges a
patch), and the carry-on, the render delay and the hit rewind use the same numbers. A handler of any layer event that throws does not stop `Pump()`: the other handlers run, the pump finishes, and the first
exception is rethrown at the end of `Pump()` (later ones in the same pump are dropped), as in JS.

**What is proven, in these words.** The C# layer is proven on an in-memory rig with a virtual clock (`NetPlayerTests`,
`NetPlayerHostTests`, `NetPlayerVectorTests` in `clients/dotnet/OneLobby.Replication.Tests`: D1 to D9 and every case of
`spec/vectors/net-player.json`). No two processes and no real link have carried the C# layer, no game engine has run it, nobody
has seen it on a screen, and the smoothing numbers are the plan's and not tuned by eye. The measured numbers are written by the
tests (`dotnet test clients/dotnet/OneLobby.Replication.Tests --logger "console;verbosity=detailed"`).

## Done when

Two peers in a lobby (`players.players` has both on each side), the other peer's `players.get(peer)` follows the owner a short
delay behind and never stands still longer than 250 ms while it moves, and every action you send arrives once on the other
screen: the in-memory tests of `clients/js/packages/client/test/net-player*.test.ts` run exactly that.
