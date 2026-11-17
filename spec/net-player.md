# Networked player, version 1 (on top of replication)

Status: **JS, GDScript and C#.** The reference implementation is `clients/js/packages/client/src/replication/` (`player-wire.ts`: the
tables as code, `player.ts`: the layer, `helpers.ts`: `Reconciler`, `PredictionSmoother`, `HistoryRing`). The GDScript client has it
too (`clients/gdscript/addons/onelobby/`: `net_player_wire.gd`, `net_player_codec.gd`, `net_players.gd`, `reconciler.gd`,
`prediction_smoother.gd`, `history_ring.gd`, and the Godot node `net_player.gd` with its spawner `net_player_spawner.gd`), built from
this document and `spec/vectors/net-player.json`, which it passes in full. The C# client has it too (`clients/dotnet/OneLobby.Replication/`: `PlayerWire.cs`,
`PlayerCodec.cs`, `NetPlayers.cs`, with `Helpers.cs` for `Reconciler`, `PredictionSmoother` and `HistoryRing`), also built from this document and the vectors,
which it passes in full (`NetPlayerVectorTests`). The Godot C# node and spawner (`clients/dotnet/demo-godot/addons/onelobby_net_player/`) and the Unity component (`OneLobbyNetPlayer` and `OneLobbyNetPlayerSpawner` in `clients/unity/com.onelobby.unity/`, proven on an in-memory network in Play mode and by two built players on one PC) are built on that layer.

**Proven only on an in-memory network with a virtual clock** (`RepRig` in JS, `tests/replication_rig.gd` in GDScript, `Rig` in C#: latency, jitter and
loss on a fake link) and, for the GDScript sample, by two headless processes on one PC (CI). No real link and no real game engine window
have run it, and nobody has seen a networked player move on a screen. The smoothing numbers below are the plan's numbers
(`docs/design/one-shot.md` section 7.2), not tuned by eye.

This layer is a game-side convention over `spec/replication.md`; it adds one message kind (5) and changes nothing about
kinds 1 to 4. A game that does not use it sees no new entity, no new message and the same bytes as before.

Names in the tables are the names every client's API uses (camelCase in JS and C#, snake_case in GDScript).

## 1. What a player is

One replicated entity per **seated** peer (players, not spectators), of the reserved **type id 65535**, owned by that peer
(`owner` = its peer id). Its state bytes are the player preset of section 2 written with `NetWriter`. Type ids 65520 to
65535 are reserved for OneLobby; a game must not use them for its own entities (65535 is the largest id the snapshot
record allows, so it cannot collide with a game that counts up from 1). Layouts of kinds 1 and 2 do not change: in
`"owner"` mode the input message carries the state bytes, in `"host"` mode the input preset bytes (section 3).

The host's layer creates the entity: in `"host"` mode when the peer's link is up (it starts at the game's spawn point, the
origin by default, and the owner starts from that state, section 5.2); in `"owner"` mode when the peer's first state arrives (so nobody sees a player flash at the origin). The
host's own player is written straight into its entity. A peer that leaves loses its entity; a peer that becomes a spectator
loses it too; a spectator never gets one. A late joiner gets everyone through the keyframe.

During the rejoin window a dropped player is **gone**: the lobby reports `peerLeft` at once, the entity is despawned, and a
rejoin (same peer id) creates a new entity with its first state. Nothing remembers its place. Keeping the character
frozen with a "reconnecting" tag (`one-shot.md` section 8, item 3) is not built.

## 2. The state (the player preset)

Fields in wire order, written LSB first like every `NetWriter` state (spec/replication.md "State bits"). `quant(a, b, n)` is
`Quantize.float` over `[a, b]` in `n` bits; `angle(n)` is `Quantize.angle`. `R` is `sync.player.range`, `V` is
`sync.player.velocityRange`. `PB` (position bits) is the smallest `b` in 8..24 with `2^b - 1 >= ceil(2 R / 0.01)`: about 1 cm
a step (R = 300: 16 bits, 0.92 cm; R = 1000: 18 bits; R = 100000: 24 bits, the most).

| # | field | type | bits (3D) | bits (2D) | range | default | left out with |
|---|---|---|---|---|---|---|---|
| 1 | `x` | quant(-R, R, PB) | PB | PB | -R..R | 0 | never |
| 2 | `y` | quant(-R, R, PB) | PB | PB | -R..R | 0 | never (3D: up; 2D: the second axis) |
| 3 | `z` | quant(-R, R, PB) | PB | | -R..R | 0 | never (3D only) |
| 4 | `vx` | quant(-V, V, 10) | 10 | 10 | -V..V per second | 0 | `velocity` |
| 5 | `vy` | quant(-V, V, 10) | 10 | 10 | | 0 | `velocity` |
| 6 | `vz` | quant(-V, V, 10) | 10 | | | 0 | `velocity` (3D only) |
| 7 | `yaw` | angle(12) | 12 | 12 | degrees [0, 360) | 0 | `yaw` (2D: the facing) |
| 8 | `pitch` | quant(-90, 90, 10) | 10 | | degrees | 0 | `pitch` (3D only) |
| 9 | `onGround` | bool | 1 | 1 | | true | `onGround` |
| 10 | `mode` | bits | 4 | 4 | 0 idle, 1 walk, 2 run, 3 crouch, 4 jump, 5 fall, 6 swim, 7 climb, 8 fly; 9 to 15 are the game's | 0 | `mode` |
| 11 | `item` | bits | 4 | 4 | held item or slot 0..15 | 0 | `item` |
| 12 | `aiming` | bool | 1 | 1 | aiming down sights | false | `aiming` |
| 13 | `blocking` | bool | 1 | 1 | | false | `blocking` |
| 14 | `health` | bits | 8 | 8 | 0..255 | 100 | `health` |
| 15 | `alive` | bool | 1 | 1 | | true | `alive` |
| 16 | `team` | bits | 4 | 4 | team or colour 0..15 | 0 | `team` |
| 17 | `teleport` | bits | 3 | 3 | counter, wraps at 8 | 0 | never |
| 18 | `carried` | bool | 1 | 1 | set by the host when this state is the host's carry-on, not a state its owner reached (5.1 step 3, 5.2 step 4) | false | never |

Totals with nothing left out: **128 bits = 16 bytes (3D)**, **92 bits = 12 bytes (2D)**, at the default range (`carried` is the last bit, so the default byte counts did not change; a layout whose bits were a multiple of 8, such as the lean one in the vectors, gains one byte). A field
that is left out is not on the wire (the later fields move up), and a reader sees its default. Quantisation clamps: a value
outside the range travels as the nearest end; 0 is not exactly representable for `pitch` (10 bits over 180 degrees), it
travels as 0.088. Two ends that use different `sync.player` settings cannot read each other: the file is part of the game's
`netVersion`.

Defaults and the layout are in `spec/vectors/net-player.json` (`states`, with `configs`).

### The teleport counter

A small counter in the state (3 bits, wraps). When it differs between two samples the player **snaps** to the newer sample
instead of sliding (the snap happens when render time reaches the newer sample's tick; until then the older sample is
held). It is raised by:

- a respawn and the game's own teleport call (the owner raises it by **1**);
- the host when it puts a player somewhere (a limit refused an owner's move, or the game calls the host's teleport): it
  raises it by **4**, so the two can never be mistaken for each other when an owner teleports in the same moment.

An owner that sees the host's raise takes the host's state (section 5.1, step 6).

## 3. The input preset (`"host"` authority)

The input message of a client carries, per input, these bytes (`spec/replication.md` kind 2 wraps and repeats them):

| # | field | type | bits (3D) | bits (2D) | range |
|---|---|---|---|---|---|
| 1 | `moveX` | quant(-1, 1, 7) | 7 | 7 | strafe right = +1 |
| 2 | `moveY` | quant(-1, 1, 7) | 7 | 7 | forward = +1 (2D: down = +1) |
| 3 | `yaw` | angle(12) | 12 | 12 | degrees |
| 4 | `pitch` | quant(-90, 90, 10) | 10 | | degrees (3D only) |
| 5 | `buttons` | 8 bools in this order: `jump`, `crouch`, `sprint`, `aim`, `block`, `fire`, `use`, `reload` | 8 | 8 | |

3D: 44 bits = 6 bytes. 2D: 34 bits = 5 bytes. The game adds its own buttons or axes by writing its own input next to
this one; that is not in `onelobby.json` yet (section 9).

## 4. Action events

Each event has an id and arguments (written with `NetWriter`, bit-packed, padded to whole bytes; the length is exact, a
different length is rejected). `origin`: who may start it. `owner` events are started by the player's own peer, or by the host
for any player; `host` events only by the host (a client that sends one is refused and counted).

| id | name | origin | arguments (3D), bits | 2D differs | bytes (3D) |
|---|---|---|---|---|---|
| 1 | `jump` | owner | none | | 0 |
| 2 | `land` | owner | `impact` quant(0, 64, 6), the speed it landed at | | 1 |
| 3 | `shoot` | owner | `yaw` angle(12), `pitch` quant(-90, 90, 10): the aim direction; `view` u32: the render tick the shooter was seeing, times 256 | no `pitch` | 7 |
| 4 | `melee` | owner | `swing` 8: the swing id | | 1 |
| 5 | `reload` | owner | none | | 0 |
| 6 | `use` | owner | `target` 16: the game's id of what was used, 0 for none | | 2 |
| 7 | `itemSwitch` | owner | `slot` 4 | | 1 |
| 8 | `throw` | owner | `yaw` angle(12), `pitch` quant(-90, 90, 10), `power` quant(0, 1, 6) | no `pitch` | 4 |
| 9 | `hit` | host | `by` 16: the attacker's peer id, 0 for the world; `damage` 8 | | 3 |
| 10 | `death` | host | `by` 16 | | 2 |
| 11 | `respawn` | owner | none (the position is the state, with a raised teleport counter) | | 0 |
| 12 | `emote` | owner | `emote` 6 | | 1 |

`hit` is "hit taken": the host raises it for the victim after it judged a shot. Ids 13 to 255 are reserved. A game leaves an
event out with `sync.player.omit` (the name, e.g. `"emote"`); sending or receiving it is then an error.

### 4.1 The message: kind 5, `playerEvents`

Additive to replication version 1 (spec/replication.md "Versioning": an old decoder ignores kind 5). Prefix `52 01 05`.

```
count:u8                1..255 records
count x record
  player:varuint        peer id of the player the event belongs to (> 0)
  seq:varuint           1, 2, 3 ... per player (> 0); see "Exactly once" for whose numbering
  id:u8                 the event id (> 0)
  tick:varuint          host tick it happened (32 bits)
  len:u8                bytes of arguments
  args[len]
```

Decoders reject a message (count it as malformed, never throw) with the replication error names: `too_short`, `trailing`,
`varint`, `range` (a 32-bit field above 2^32 - 1), and the new ones `count_0`, `player_0`, `seq_0`, `event_id` (id 0). An unknown
id above 12 decodes; the layer drops it as unknown. Vectors: `spec/vectors/net-player.json` (`events`, `invalid`).

### 4.2 Exactly once, on time

Routing is the replication rule: a client sends to the host only; the host sends to each other client.

Sender (client to host, host to each other client), for each event:

1. One copy on `reliable` at once (a single record).
2. The same record in the **next 4 ticks'** `fast` messages (`eventRepeats` = 4, one message per tick per peer holding every
   record that still has copies left, at most 1000 bytes).

So one lost datagram costs nothing (the next copy carries it) and a bad run of 4 is covered by the reliable copy, which
cannot be lost. The receiver drops a record it has seen by `(player, seq)` whichever copy came second (a floor plus a set of
seen numbers above it).

`seq` is the **sender's** numbering on the way to the host (per player, from 1: a client numbers its own events), and the
**host's** numbering on the way out (it gives each accepted event the next number of that player and sends it with its own
tick). So a refused event leaves no hole in what the receivers see.

Timing. A client sends `tick` = `floor(serverTick)` (its estimate of the host's current tick). The host **restamps** every
event it accepts with its own tick of arrival, so the event and the state the host wrote on arrival of the same input
carry the same clock. A receiving client holds an event until its `renderTick` reaches the event's `tick`, then plays it, so a
jump lines up with the body that jumps. An event that arrives after its tick was already rendered is played at once and
counted as **late**. The owner plays its own events at once, and the host plays an accepted event on arrival.

## 5. The two authorities

`sync.player.authority`: **`"owner"`** (the default, and what a game that does not say gets) is the player's own PC placing
the player: co-op. **`"host"`** is the host placing the player: competitive. The decision is made by the game type
(`docs/design/one-shot.md` section 5) and can be overruled in `onelobby.json`. Everyone who is not the owner sees the player
the same way in both modes (section 6).

### 5.1 `"owner"` step by step

1. Each client tick the game gives the layer its player's state (`setLocalState`; a partial patch is merged, and the
   teleport counter is the layer's to keep).
2. The layer writes it (section 2) and sends it as the bytes of that tick's input (`submitInput`): it is repeated 4 times and
   acked like any input.
3. The host takes one input per client per tick (`tryGetInput`; a repeated input is no new input) and decodes it. A state of the
   wrong length is dropped and counted (`statesRejected`). A tick with no new input is a **stall** (the input was late or
   lost). The host counts it and carries the player's record on by its own velocity for that tick (`x += vx dt`, `y += vy dt`,
   `z += vz dt` in 3D, clamped to the range, quantised; no limit check, nothing else changes; at most `maxInputBuffer - 1`
   ticks of it, once for every counted stall up to that), so the snapshot does not show the player standing still. On
   the next tick that has an input the host first puts the record back to the last state that really came, then applies the
   new one as in step 4, and while stalls are counted it takes a further input in the same tick, each one applied as one
   tick's move (steps 3 and 4 again), and counts one stall off per further input. A stall is thereby made up, and the queue
   does not keep the tick for good (the session hands over one input a tick, oldest first: without this, every stall added a
   tick to the age of the owner's state until the queue overflowed). Two rules keep the make-up closed, so that a long stall
   leaves no lasting offset: (a) the queue the layer reads may hold `maxInputBuffer + maxCatchUp` inputs, not `maxInputBuffer`
   (the session's own cap drops the oldest input of a longer burst; a dropped input puts the record one tick ahead of its
   schedule for good), and up to `maxInputBuffer + maxCatchUp - 1` stalls are counted; (b) a tick the host's own clock skipped
   after a stall longer than `maxCatchUp` (`spec/replication.md`, the clock keeps its epoch and jumps the tick number) counts as
   one stall, and when the queue runs dry before the count does, the rest of the count is dropped (a record carried on past the
   newest input is a guess, not a delay). The carried record has `carried` set; the host clears it on every state it accepts from the owner (the bit is the host's: an owner's own is ignored). Host authority (5.2) makes up stalls the same way and shows the same carry-on.
4. The host checks it (section 7). If it passes, it becomes the entity's state; the snapshot carries it to everyone else.
5. The owner never applies snapshot state to its own player.
6. Except one case: the snapshot's `lastInput` names the last input the host applied. The owner remembers the teleport counter
   it sent in each input. If the counter in its own entity differs from the one it sent in input `lastInput`, the host put it
   back: the owner takes the host's whole state as its own (event `corrected`) and ignores the inputs still on the way
   (those up to the last it had sent when it noticed).
7. After a refusal the host keeps its last accepted state, raises the counter by 4 and ignores states until the owner shows
   the new counter; then it accepts again.

The host's own player is written straight into its entity each tick. The host can place any player (`teleportPlayer`,
`respawnPlayer`): in this mode that is a correction as in steps 6 and 7.

### 5.2 `"host"` step by step

1. The game supplies a **step function** `step(state, input, dt) -> state` (`dt` = 1 / `tickRate` seconds) and the same
   function runs on the host and in every owner's prediction. It must be deterministic given its arguments.
2. **The owner has no local state until the host's first state of its own player has arrived** (JS: `local` is `undefined`;
   GDScript: `local_state()` returns an empty Dictionary and `get_state` of the local player is null). That state is where the
   host spawned the player; the owner's predictor starts from it, so the owner never reads a position at the origin and the
   first state is no correction: no snap, no `corrected` event. Inputs the game gives before that are neither sent nor stepped.
   (The Godot node writes nothing into its character before then.)
3. Each client tick the owner makes an input (`setLocalInput`), sends it (section 3), and applies `step` to its own state at
   once (prediction; `Reconciler.predict` with the sequence number `submitInput` returned).
4. The host takes one input per client per tick and steps that player once (`state = quantise(step(state, input, dt))`). A
   repeated input (nothing new arrived) does **not** step: the owner has predicted exactly the inputs it sent, so the state
   after input N is the same on both sides. Each repeated input is a counted stall as in 5.1 step 3: the next ticks that have an input
   step one further input for each stall counted (only while inputs are queued, never more than were counted), so the player's
   sim does not stay a tick behind its input for good. The sim is untouched on a stalled tick, but what the host **shows** is not
   a plateau: for each stall counted (at most `maxInputBuffer - 1` ticks, as in 5.1 step 3) it shows the sim carried on by its own
   velocity (`x += vx dt` and so on, clamped, quantised) with `carried` set, in its record (section 8), in the snapshot and in its
   own draw of the player; a game with `velocity` left out is not carried on. The carry-on is never assigned back to the sim: the
   next tick that steps shows the sim itself (`carried` clear). A turn during a stall shows one tick of the old direction to
   the other screens.
5. The snapshot carries the state and `lastInput`. For every snapshot whose own state has `carried` clear the owner calls
   `Reconciler.reconcile(state, lastInput)`: it starts from the host's state and replays the inputs the host has not seen. A
   state with `carried` set is the host's guess for the other screens (the host applied none of the owner's inputs that tick, so
   `lastInput` has not moved and the state is "after input k" again at the next stepped tick): the owner skips it, no correction.
6. The difference between the state before and after is a correction: `PredictionSmoother.correct(dx, dy, dz, teleport)`. The
   drawn position is the predicted position plus the smoother's `offset`, which decays to zero in **100 ms**. A correction
   longer than **2.0** on the ground plane, longer than **0.5** vertically, or with a changed teleport counter **snaps** (offset
   cleared). For 2D the plane is x, y and there is no vertical part.
7. The host quantises after every step so both sides replay from the same bytes.

Host mode needs the game's movement to be a function of (state, input, dt) only. A game whose movement uses the engine's
physics (a `CharacterBody`, a `CharacterController`) must wrap one step of it: that is what the Godot node and the Unity
component will do in the next lanes.

## 6. Smooth remote players

A client draws every other player from the snapshots it holds (`trySampleAt`), never from a raw packet.

- **Render delay.** The session option `adaptiveDelay` (default **off**; the layer turns it on) replaces the fixed 100 ms.
  `delay = clamp(2 I + 4 J, 2 I, 250 ms)` where `I` = snapshot interval (`1000 / tickRate x snapshotEveryTicks`, 33.3 ms at
  the default) and `J` = smoothed arrival jitter. **Lower bound 2 I (66.7 ms at the default), upper bound 250 ms.** `J` is the
  mean deviation of `(arrival gap) - (tick gap x tickMs)` over snapshots that advance the newest tick: it rises by a quarter of
  the difference at once and falls by 1/32. The delay moves towards its target by a fraction `elapsed / 100 ms` when it must
  grow and by at most 20 ms per second when it may shrink. It starts at `interpolationDelayMs` (100). Render time never runs
  backwards. See spec/replication.md "Clock and render time".
- **Interpolation.** Numbers (`x y z vx vy vz`) blend linearly; `yaw` turns on the **shortest arc**; `pitch` is linear. Fields
  that are not numbers or are discrete (`mode`, `item`, `health`, `team`, the flags) are taken from the **older** sample, never
  blended. If the two samples' `teleport` differ, the older one is held until render time reaches the newer one's tick.
- **On the host.** The host has no snapshots of its own, so a remote player is drawn from the host's own record of it (the
  `HistoryRing` of section 8), **one tick behind** (`tick - 1 + alpha`, `alpha` the fraction of the way to the next tick),
  interpolated as above: a teleport between two records holds the older one until the newer one's tick (the snap), and a
  player with a single record is held at it. The host's own player is its own state, not delayed. The record is the **shown** state of 5.1 step 3 and 5.2 step 4, so the host draws a stalled player carried on like every other screen does.
- **Carry-on.** Past the newest snapshot the session holds and never extrapolates. The layer carries a player on by its
  velocity: `position + velocity x min(overshoot, 250 ms)`, then holds. The overshoot is `(renderTick - latestTick) x tickMs`. A
  game with `velocity` left out is not carried on.

## 7. The host's limits

Basic protection from glitches and cheats. **Not an anti-cheat**: a cheater who stays under the limits is not stopped, and
nothing here hides one player's data from another. A limit that is not set in `sync.player.limits` is not checked.

Owner authority, for each state the host accepts (`d` = distance from the last accepted state, `dt` = seconds of host ticks
since it, at least one tick):

| limit | refused when |
|---|---|
| `maxSpeed` | `d > maxSpeed x dt x 1.25 + 2 x positionStep` (25% tolerance for packets bunching up) |
| `maxStep` | `d > maxStep` |
| a teleport | the owner raised the counter (it is an honest respawn or portal) but another owner teleport was accepted less than **1000 ms** ago |

An **honest teleport** passes when limits are set: the owner raises its counter (by 1) in the state, and the host skips the
speed and step checks for that one update, at most once per second. (A cheater can do the same once a second; this is the
price of letting a portal through without a game-side hook.) When a state is refused the host keeps its last accepted
state, raises the counter by 4, answers with it in the next snapshots and ignores the owner until it shows the new counter
(section 5.1).

Events (both authorities), on the first copy the host sees of each event:

| limit | |
|---|---|
| `minShotIntervalMs` | `shoot`: refused when the gap to the player's previous accepted `shoot` is under `0.9 x min - one tick`, measured in the sender's claimed ticks (clamped to between 15 ticks before and one tick after the host's tick) |
| `minMeleeIntervalMs` | the same for `melee` |

An event over its limit is **dropped and counted** (`actionsRateLimited`): the host's game never sees it and it is never
relayed. Also refused and counted (`actionsRejected`): a `host` event from a client, an event of another player, an event
the blueprint leaves out, and arguments of the wrong length.

Host authority needs no speed or step limit: the host steps the player itself.

A limit `maxJump`, the distance of "how far a player may jump in one step", is `maxStep`.

## 8. Hit rewind

The host's layer records every player's state each host tick (a `HistoryRing`, 64 ticks). `shoot` carries `view`, the render
tick (x 256) the shooter was seeing. `rewound(peer, view)` answers where that player was then, clamped by the session's
existing `rewindTick` (`maxRewindMs`, default **250 ms**). The game decides what a hit is and raises `hit` and `death`
itself (`hostAction`).

**How old a shooter's view is.** When a shot reaches the host, the world the shooter saw is older than the host's tick by the
shooter's render delay (section 6: `clamp(2 I + 4 J, 2 I, 250 ms)`, so anywhere between two snapshot intervals, 66.7 ms at the
default, and the 250 ms cap) plus the trip of the snapshots from the host to the shooter (one way) plus the trip of the shot
to the host (one way): `age = render delay + 2 x one way`.

**What the default covers.** The default `maxRewindMs` of 250 ms therefore covers about 60 ms one way and leaves almost no
room. On the test link of section 11 with 60 ms one way and 20 ms jitter the render delay is about 110 to 140 ms and the view
230 to 260 ms old, so 0 to 20 ms of room: some shots are past the limit (in the tests 2 to 14 of 30, depending on the random
stream). Do not change the default for this; a link slower than 60 ms one way needs a higher limit.

**A shot past the limit.** It is judged at the oldest state the limit allows (`rewindTick` clamps to `now - maxRewindMs`), not
where the shooter saw the target, so its error is the target's speed times the time past the limit: it grows with the target's
speed (in the tests, up to 0.13 m for a target at up to 9.6 m/s, while every shot inside the limit was within 0.006 m).

**Slower links.** Set `maxRewindMs` (a session setting: `session: { maxRewindMs }` in JS, `"session": {"max_rewind_ms": ...}` in
GDScript) to the render delay cap plus twice the one-way time the game supports, for instance 400 ms for the 60 ms link above (the
tests find every shot within 0.1 m with it). It can go up to the history the host keeps: `historyTicks` host ticks (default 64;
a view up to 63 ticks back is answered, which is about 2.1 s at 30 Hz), and a ring of that size is what limits it; an older view
answers nothing (`rewound` returns undefined, null in GDScript), so raise `historyTicks` of the session too to go beyond. A
higher limit also lets a laggy shooter hit where the target was longer ago.

## 9. `sync.player` in `onelobby.json`

See `docs/design/blueprint.md` section 4e. Keys: `authority`, `space`, `range`, `velocityRange`, `limits`
(`maxSpeed`, `maxStep`, `minShotIntervalMs`, `minMeleeIntervalMs`), `omit`. Needs `sync.mode: "replication"` (rule
`player_needs_replication`). A game's **own extra fields and events** are not in the file: only leaving the preset's out
is. A game that needs its own state next to the player sends it as its own entity, or its own events with `sendEvent`.

## 10. Numbers in one place

| what | value |
|---|---|
| reserved type id | 65535 |
| state size, default range | 16 bytes (3D), 12 bytes (2D) |
| input preset size | 6 bytes (3D), 5 bytes (2D) |
| position step | about 1 cm (`PB` bits) |
| event repeats | 4 `fast` ticks + 1 `reliable` |
| render delay | `clamp(2 I + 4 J, 2 I, 250 ms)`; fixed 100 ms when the option is off |
| carry-on cap | 250 ms |
| correction blend | 100 ms; snap past 2.0 horizontal, 0.5 vertical, or a changed teleport counter |
| owner / host teleport step | +1 / +4 (mod 8) |
| speed tolerance | 25% + 2 position steps |
| teleport rate with limits | one per 1000 ms |
| rate tolerance | 0.9 x the interval - one tick |
| rewind | the session's `maxRewindMs` (250) |
| per-player bytes per second | at most 3500 up and 1500 down per client link (measured section 11) |

## 11. Tests and measured numbers

`clients/js/packages/client/test/net-player*.test.ts` on `RepRig`: a host and two clients (A moves, B watches) at **100 ms
one-way latency, 20 ms jitter, 3% loss on `fast`** (the fake network's `dropFast`), a fixed seed, 16 ms frames, once for each
authority. Bounds the tests hold the layer to: D1, over the seeds 1, 2, 7 and 8 (the seed draws the loss and the jitter) and for each
authority: the mean error under 0.15 m and the 99th percentile of the per-frame error under 0.40 m for each seed, and the worst
frame over all seeds under 0.45 m (the two paths are compared at the one constant lag, 0 to 600 ms in 8 ms steps, where they are
closest on average; that lag is the sum of the two links and the render delay; the error of a frame is the distance between the
watched path and the owner's path at that lag); D1b the same scene with no jitter and owner authority, seeds 4, 10 and 13: worst
error under 0.25 m; D1c one runner hitch (the owner, then the host, stops for 4, 5 or 7 ticks in the middle of a 20 s walk, no loss, jitter 20 ms, both authorities, seeds 1, 2, 7 and 8): the host's own record of the walker against the walker's own path holds the D1 bounds (mean under 0.15 m, worst frame under 0.45 m) and the lag fitted after the hitch (from 2 s after it) is the lag fitted before it, within 16 ms; D1d (host authority, no random loss, seeds 1, 2, 7 and 8) at 10, 13 and 16 s every fast frame is dropped for 3 ticks, so the host sees 3 stalled ticks each time and loses no input (the inputs come back by redundancy): the host's record of the walker holds the D1 bounds; D1e the same scene judged from the watcher's screen (B's view of the walker) with the D1 bounds; in that scene the owner is never corrected (`stats.corrections` 0, the smoother never snaps, its offset stays under 0.02 m) and the host's record equals the newest snapshot state B holds, tick for tick, to the position quantum, stalled ticks included; D2 never still longer than 250 ms; D3 every one of 235 jumps, shoots and melees exactly once at the host and at
the watcher, on-time ones played within 2 ticks after their tick, also at 30% loss; D4 the budget above; D8 a shot whose view is within the rewind limit is judged within 0.1 m of where the shooter saw the target
(at least half of the 30 shots are within it), every shot within 0.3 m, and with `maxRewindMs` 400 on the same link every shot
within 0.1 m. The measured numbers
of the last run are in the PR description of the change that added this file. The three clients hold the same numbers (the
seed's draws differ between the rigs, so a seed is not the same run in each).

### What packet loss does to a watched player

A watched player is the owner's state three hops later: the owner to the host, the host's snapshot to the watcher, and the
watcher's render delay. D1 compares the watched path with the owner's at one constant lag, so anything that changes the age of
what the watcher draws during the run shows as error: at a speed of 9.6 m/s one tick (33.3 ms) is 0.32 m. Measured on the JS
rig (loss 3% on `fast`, 16 seeds, 20 s each), the large errors were not the moment of a loss but a change of age that a loss
left behind. Cause: the host takes one input per tick, oldest first, from a queue. A tick on which the queue was empty (the
input was lost or late) takes nothing and the record of the owner stands still for that tick; the lost input arrives a tick
later inside the next packet (each packet repeats the last four), the queue then holds two, and the host still takes one a
tick, so the queue keeps the tick for good. Each such stall made the owner's state one tick (33 ms) older on every screen,
and only a queue overflow (more than `maxInputBuffer` waiting) gave ticks back. In one seed (loss 3%, jitter 20 ms) the age of
the owner's state at the host rose from 128 ms to 208 ms in 6 s after two stalls, and the error against the best constant lag
was 0.77 m.
A lost snapshot to the watcher left no step: the watcher interpolates over the gap and the chord error of a 12 m circle is
under 0.01 m. Host authority has the same queue and the same stall; its path moves at 6 m/s, so a tick is 0.2 m there.

Since the change in 5.1 step 3 (owner authority), measured on the same 16 seeds, per link, the worst frame over the seeds
(before, after), the largest 99th percentile (before, after) and the largest mean (before, after):

| link | authority | worst | 99th percentile | mean |
|---|---|---|---|---|
| loss 3%, jitter 0 | owner | 0.48, 0.17 m | 0.45, 0.15 m | 0.148, 0.061 m |
| loss 3%, jitter 20 ms | owner | 0.77, 0.29 m | 0.58, 0.23 m | 0.160, 0.075 m |
| loss 0, jitter 20 ms | owner | 0.27, 0.27 m | 0.21, 0.21 m | 0.068, 0.068 m |
| loss 3%, jitter 0 | host | 0.39 m, unchanged | 0.34 m | 0.100 m |
| loss 3%, jitter 20 ms | host | 0.36 m, unchanged | 0.32 m | 0.114 m |
| loss 0, jitter 20 ms | host | 0.16 m, unchanged | 0.14 m | 0.045 m |

What is left: with jitter alone and no loss, owner authority is about 0.27 m at the worst (not loss; the cause is not investigated
here), and host authority still has the queue growth, for the reason below. What a game maker can set: nothing in
the layer needs setting for owner authority. For host authority the stall can be hidden only by a deeper standing queue, which
costs one tick of age per tick of depth for every player on every screen: `session: { maxInputBuffer }` is the cap, not the
depth. At 10% loss the owner's worst frame is 0.34 m (0.62 m before; jitter 0, 16 seeds, 6%: 0.18 and 0.49 m); the carry-on makes up at
most `maxInputBuffer` stalls.

How host authority carries on. In `"host"` authority one state of the player has three readers: the owner reconciles against it (the snapshot
carries `lastInput`, which does not move on a stalled tick, and `Reconciler.reconcile(state, lastInput)` assumes the state is the sim after
input `lastInput`), every watcher interpolates it, and the host's own record of it answers `get` and `rewound`. A stalled tick that stands still
shows to the watchers (and to the record) as a plateau and then a double step: 0.15 to 0.60 m in one frame on D1d. Carrying the record only (a
second, shown record next to an unchanged snapshot) fixed the record and broke D8: the snapshot and the record then differed by the stall step.
Carrying the sim itself on (`step(state, lastInput)`, then a second input later) makes every screen smooth, but the owner then reconciles from a
state ahead of its ack by the carried ticks: its own path jumps 0.41 to 0.62 m in one frame (0.21 m without it) and the D1 worst error rises to
0.49 m. So the host keeps both: the sim `state` (never assigned the carry-on) and a **shown** state, the same for the snapshot, the record,
`latest` and the host's own draw, with the `carried` bit (field 18) telling the owner which snapshots to skip. The next stepped tick the bit is
clear and the state is the sim, exactly "after input k" as before, so the owner's correction stays zero. Measured on this rig (worst frame, before,
after): D1d 0.605 to 0.061 m (JS), 0.508 to 0.057 m (C#), 0.605 to 0.061 m (GDScript); D1e, the watcher's view, 0.607 to 0.134 m (JS), 0.600 to
0.141 m (C#), 0.618 to 0.154 m (GDScript). Accepted costs: the state is one bit longer (one byte more only where the bits were a multiple of 8); on
a frozen owner every screen shows the player carried on up to `maxInputBuffer - 1` ticks ahead, then the make-up closes it (owner authority
already does the same); a turn during a stall shows one tick of the old direction to the others; a game with `velocity` left out gets no
carry-on.

## 12. Vectors

`spec/vectors/net-player.json`: `configs` (the settings that shape the wire), `states` (encode `state` for `config` to `hex`,
decode `hex` to `decoded`, `bits`; `carried_walking` and `lean_carried` have `carried` set), `inputs`, `args` (one event's arguments), `events` (kind 5 messages) and `invalid` (decoding
must fail with `error`; `length` for a state, input or arguments of the wrong length). Compare decoded floats with a tolerance
of 1e-5.

They are generated from the JS client. Regenerate (from `clients/js/packages/client`, after `npm ci` in `clients/js`):

```
ONELOBBY_WRITE_VECTORS=1 ../../node_modules/.bin/vitest run test/net-player-vectors.test.ts
```

then run the same command without the variable: the plain run only reads the file and checks it.

## 13. What a second implementer will trip on

- `Quantize.float` takes its input as a float32 (round every value to float32 first, `spec/replication.md` "Quantization"), then rounds half away
  from zero in double precision and clamps; `pitch` and `moveX` have even step counts, so 0
  does not round-trip exactly.
- Left-out fields shorten the state and move the later ones up: the layout depends on the settings, and both ends must agree.
- `carried` is the host's bit, the last one in the state, never omittable. The host sets it on a state it carried on, and clears it on every owner
  state it accepts (an owner's own is ignored). Reconciling against a carried state wobbles the owner's path by one tick's step on each
  stall: the owner skips it. In host authority the record, the snapshot, `latest`, `stateAt`, `rewound` and the host's own `get` of a remote
  player are all the shown state; the sim `state` is never assigned a carried state.
- The host numbers relayed events itself (section 4.2); the sender's numbers are only for the first hop.
- In `"host"` mode a repeated input must not step, and the host must quantise after each step.
- The teleport counter of the owner is the owner's to keep: a game that overwrites it each tick with its own value breaks the
  correction (the layer's `setLocalState` keeps it).
- The host draws the other players from its own history, one tick behind and interpolated (section 6, "On the host"); a client's
  snapshot sampler has nothing for them there. A layer that returns nothing for a remote player on the host is wrong.
- In `"host"` mode the owner has no local state until the host's first state of its own player arrives (section 5.2, step 2): do
  not start the predictor from the default state, do not send or step inputs before it, and expect no snap and no `corrected` from
  that first state.
- A spectator must not keep a character: a joiner's roster says "player" for its own peer until the host's room snapshot arrives,
  and the layer never announces a local spectator, so a spawner that made the local character at once looks at the roster on
  every tick, takes the character back when it says spectator and makes it again when it says player.
- A spawner that has no step function must leave the node's alone: a character that set its own step in `_ready` / `_Ready` / `Awake`
  loses it if the spawner assigns "none" after adding the character (the GDScript and Godot C# spawners did).
- A host in `"host"` mode with no step function reports it **once** (JS and C#: one exception from the first `pump()` / `Pump()`
  that needed the step, thrown after everything else in that pump has run; GDScript: one `push_error`), keeps pumping what does
  not need the step (roster, snapshots, events), does not move the players that need it, and works as soon as the step is set,
  with no restart. Throwing on every tick is wrong.
- A second layer or session made on a lobby that is already playing: the new session holds no snapshot and sends `ack` 0. A host
  that follows `spec/replication.md` "Resync" treats an `input` with `ack` 0 from a client whose stored ack is above 0 as "this
  client holds no baseline" and sends it a full snapshot at once (and starts that client's input numbers over, so the new
  session's inputs from 1 are applied in `"host"` authority); the layer then sees the other players within about a round trip
  (measured on the rig of section 11, 100 ms one way: 11 ticks in owner authority including the render delay, against about 38
  before). An old host keeps the wait: it holds the first session's ack, encodes against a baseline the new session does not
  have, and only after 64 ticks falls back to a full snapshot (about 2 s, at most the 5 s keyframe). Two limits. A layer sends
  nothing until it has something to send: with `"host"` authority the layer sends no input before it holds its own state (the
  host's first snapshot with its player), so it stays silent, the host never sees `ack` 0, and the wait stays for that layer
  (measured: 35 to 41 ticks); a game that must not wait there can call `SendFullSnapshot(peer)` on the host when it sees the
  new session's peer start over, or make the session submit an input at once. And a session that starts within 500 ms of the
  first ack of the one before it is not recognised (the rule in `spec/replication.md` keeps a late packet of the old session from
  being taken for a new one).
- Owner authority, stalls (section 5.1, step 3): the carried-on record is not a state the owner sent. Put the record back to the last
  real state before every new input is applied (the speed and step limits compare with that, not with the carried state), drop it
  when the host places the player (`teleportPlayer`), count a stall only when the session says "repeated" and not when it has
  never had an input from that client, and do not carry a record on while it waits for a teleport counter. Taking a further
  input in the same tick makes the session's `inputsRepeated` count rise by the failed tries; do not read it as stalls.
- Time stamps: `tick` in the message is host ticks; `view` is the render tick x 256 as an unsigned 32-bit number.
