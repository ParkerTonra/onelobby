# Room layer (`room` v1): roster, ready, countdown, spectators, bans

Every lobby has a room layer. It is one host-authoritative state machine that rides on the existing peer links: the lobby
SERVER (or the Direct hub) never sees room traffic and never needs game data. It works the same on server lobbies and on
Direct lobbies (IP codes, Nostr codes, a browser tab as host). A game that never touches `lobby.room` is unchanged.

Status: JS (`lobby.room`) and C# (`lobby.Room`) implement it in 0.7.2; GDScript (`room`) is coming in this release and must match this
file and `spec/vectors/room.json` exactly. Words in **(decision)** go beyond what the design plan fixed.

Contents: 1 model, 2 wire, 3 messages, 4 host rules (names, data, seats, ready, countdown, spectators, roster states,
late join), 5 kick and ban, 6 passwords, 7 hub additions, 8 compatibility, 9 events and API, 10 blueprint keys.

## 1. Model

The host owns one `Room` state; every peer holds a replica.

```
Room   { v:1, rev, state, countdown, settings, players: Entry[] }
state  "lobby" | "countdown" | "started"
Entry  { id: peerId, name, role: "player"|"spectator", seat: int (-1 for a spectator), ready: bool,
         status: "connected"|"reconnecting", data: { key: string }, legacy?: true }
```

- `state` `"started"` is exactly the lobby's `phase` `"in_game"` (signaling `phase`); `"countdown"` is room only and counts
  as the lobby phase for everything else.
- `rev` is a counter, 1 when the room is created, +1 for every `upd`. It lets a replica notice a lost update.
- Status `left` is not stored: a player who is gone leaves `players` and appears once in an `upd.gone` entry and in the
  `playerLeft` event with `status:"left"`. `reconnecting` is a player whose link dropped inside the rejoin window (4.7).
- The host is a player like any other (peer id = host id, seat 0 on a new lobby). `legacy:true` marks a peer that does not
  speak the room layer (8); a legacy peer is shown, never ready, never counted for auto start.
- The room name (`Entry.name`) is the effective display name (4.1). The hub's own peer name (`lobby.peers`, `peerRenamed`)
  stays what the player typed after hub sanitising; games should show the room name.
- A player id (`pid`) is never replicated. Only the host holds it.

### Player id (`pid`)

A random 128-bit value from a CSPRNG, as 32 lower-case hex characters (`^[0-9a-f]{32}$`), generated once per install and
per game id by the client and kept in local storage (browser: `localStorage` key `onelobby.pid.<gameId>`; Node: a file
path the game passes, else memory only, so the id then lasts one process; C#/Unity: a file or PlayerPrefs; Godot:
`user://`). The client sends it in `hello.playerId` (signaling) and in room `join.pid`. It is **not** an account, not a
hardware id, not derived from the machine, the IP or the player's name, and nothing links it across games. Clearing local
storage or reinstalling makes a new id, which is why bans also carry an IP fallback (5.3). Anything that does not match the
pattern is treated as "no id".

## 2. Wire

Room messages are one data-channel frame type, `0x80 room`, on the `reliable` channel:

```
type:u8 = 0x80, route:u16 = 0, then rest = one UTF-8 JSON object { "t": "<message>", ... }
```

- `route` is written as 0 and ignored. Everything flows between the host and one joiner (star); a joiner never sends room
  frames to another joiner.
- Frames over 16384 bytes use the generic oversized-frame chunking (`spec/binary.md`); a roster that large is a rare `snap`.
- A receiver drops (never crashes on) a frame whose body is not UTF-8, not a JSON object, or has no string `t`; and
  ignores an unknown `t` or unknown fields (additive evolution). Numbers are integers; `rev`, `seq`, `ms` fit 32 bits.
- Old clients: `0x80` is an unknown frame type, which every client already ignores (`spec/binary.md`).

Worked frames are in `spec/vectors/room.json` (`frames`).

## 3. Messages

Joiner to host (the host never sends these to anyone but its own handler):

| `t` | fields | meaning |
|---|---|---|
| `join` | `v:1`, `pid?`, `role?` ("player" default, or "spectator"), `password?` (string, at most 64 chars), `data?` ({key:string}) | First message after the joiner's `hi`; sent again after each new host link (a rejoin, a host migration). Answered by `snap` or `deny`. `data` is applied key by key; a key that fails validation is skipped, it never fails the join. |
| `set` | `data` ({key:string}) | The sender's own data (4.2). Atomic. Failure: `nack`. |
| `ready` | `ready` (bool) | The sender's ready flag (4.4). Players only. |
| `role` | `role` | Ask to become a spectator or a player (4.6). |
| `req` | `what` ("start" \| "lobby" \| "rematch") | Ask the host; surfaces as the host's `requested` event and changes nothing by itself. |
| `resync` | none | Ask for a fresh `snap`. At most one per second per peer, more are ignored. |

Host to joiners:

| `t` | fields | meaning |
|---|---|---|
| `snap` | `v`, `rev`, `state`, `countdown` (object or null), `settings`, `players` (all entries) | Full room. Sent to a peer whose `join` was admitted, and in answer to `resync`. |
| `upd` | `rev`, `players?` (changed or new entries, whole), `gone?` ([{id, why}]), `state?`, `countdown?` (object or null), `settings?`, `cancel?` (why a countdown ended without a start: `host`, `too_few`, `condition`) | Delta, broadcast to every admitted peer (the new peer gets `snap` instead). A replica applies it only when `rev` is its `rev + 1`; `rev` at or below its own is a duplicate (ignored); a larger gap means it missed one: it sends `resync` and applies nothing until the `snap`. |
| `cd` | `seq`, `left` (ms) | Countdown tick, about once a second (4.5). No `rev`. |
| `deny` | `code`, `reason` | The `join` was refused (4.8). The host then disconnects the peer (5.2). |
| `nack` | `re` ("set" \| "ready" \| "role" \| "req" \| "join"), `code`, `key?` | A request failed; nothing changed. |

`countdown` = `{ seq, total, left }`: `seq` increments per countdown, `total` the length in ms, `left` ms remaining when the
message was sent. `settings` = `{ maxPlayers, spectators, minPlayers, autoStart, autoStartPlayers, countdownMs, lateJoin,
seatDropped, rejoinWindowMs, maxNameLength, data }` where `data` is the merged data declarations (4.2). `why` in `gone` is
`left`, `kicked`, `disconnected` or `timeout` (a role change is an `upd` of the entry, not a `gone`).

`rev` and `upd` entries: the host sends one `upd` per host-side change batch (one call, one inbound message), so
"ready + countdown start" arrive together. The host never sends `snap` or `upd` to a peer before that peer's `join` was
admitted, or to a legacy peer.

Error codes (stable strings; `nack.code`, `deny.code`, thrown `OneLobbyError.code`): `bad_value`, `unknown_key`,
`not_allowed`, `too_large`, `rate_limited`, `wrong_state`, `not_enough_players`, `lobby_full`, `spectators_full`,
`in_game`, `banned`, `bad_password`, `kicked`, `disconnected`, `room_unsupported`, `password_required`.

Rate limit (host, per peer, over `set`, `ready`, `role`, `req`, `join`): at most 10 per second (fixed window); the excess
gets `nack{code:"rate_limited"}` and nothing else.

Constants (all clients): join wait for a legacy decision and for `unsupported` 3000 ms; `cd` interval 1000 ms; `resync`
gap 1000 ms; request rate 10 per second per peer; largest one-way delay used for the countdown 2000 ms; at most 1000 ban
entries; password at most 64 characters; reason at most 120 code points.

## 4. Host rules

### 4.1 Names

The host computes every effective name. Input is the hub's peer name (after the hub's own sanitising and its 24
character cut), re-run on every `peerRenamed`. Steps, in order, on code points:

1. **Strip** every character in U+0000-U+001F, U+007F-U+009F, U+200B-U+200F, U+2028-U+202E, U+2066-U+2069, U+FEFF.
2. **Collapse** each run of whitespace (U+0020, U+00A0, U+1680, U+2000-U+200A, U+202F, U+205F, U+3000) to one U+0020, and
   trim both ends.
3. **Clamp** to `maxNameLength` code points (default 24, at most 24).
4. **Filter**: apply the host's filter hook (4.9) with kind `"name"`, then repeat steps 1-3 on its result. A hook that
   throws counts as no hook.
5. **Default**: an empty result, or exactly `Player` (the stand-in the hub puts for an empty name), becomes `Player N`
   where N = the peer id.
6. **Dedupe**: compare case-insensitively (ASCII letters always; other letters with the language's invariant
   lower-casing; vectors pin ASCII and Latin-1) with the names of every other entry (players, spectators and
   reconnecting ones). If taken, try `Name 2`, `Name 3`, ... and use the first free; the base is cut to
   `max - len(" N")` code points first so the result still fits, and trailing spaces are trimmed after the cut.

An entry keeps its name until its owner renames; nobody is renumbered when another player leaves. Vectors: `names`.

### 4.2 Per-player data

Small string key/value pairs per entry (`data`), replicated to everyone, late joiners included. Keys must be declared:
the built-ins below plus the `room.data` of `onelobby.json` (a declaration of the same key replaces the built-in).

Key format `^[a-z][a-z0-9_]{0,23}$`. A declaration is `{ type, min?, max?, maxLength?, values?, default?, hostOnly? }`:

| type | accepted value (after rule) | stored as |
|---|---|---|
| `string` | strip + collapse + trim as names (steps 1-2), at most `maxLength` code points (default 32, at most 64) | the cleaned string |
| `int` | `^-?[0-9]+$` with no leading zeros and not `-0`, within `min..max` (default 0..255, bounds within +-2147483647) | the same text |
| `enum` | one of `values` (1-16 values, each 1-32 characters) | the value |
| `bool` | `true` or `false` | the value |
| `color` | `#` and six hex digits, either case | lower case |

The empty string means "unset": the key is removed, and a `default` (if declared) applies again only at admission.
`hostOnly:true` keys can be set by the host only. Built-ins: `color` (color), `avatar` (int 0-255, default `"0"`), `team`
(int 0-15, default `"0"`; 0 is "no team"). The host applies each key's `default` when it admits a player.

Validation of one `set` (or one host override): for each key in order, unknown or malformed key `unknown_key`; a
`hostOnly` key from a non-host `not_allowed`; value failing its type `bad_value` (with `key`). The set is atomic: the
first failure rejects all of it. Serialised data of one entry (JSON, UTF-8) over 1024 bytes: `too_large`. The host can
set any key on any player (`room.setData(peerId, ...)`), hostOnly keys included, through the same validation of value
and type. Vectors: `data`.

### 4.3 Seats

A player has a `seat`, an integer `0..maxPlayers-1`; spectators have `-1`. The host assigns it at admission and when a
spectator becomes a player: the seat this `pid` last held, if no connected or reconnecting player holds it now;
otherwise the lowest seat that no connected or reconnecting player holds and that no *other* `pid` remembers; otherwise
the lowest seat nobody holds (a seat remembered by a player who is gone is taken over, the memory of it is forgotten).
The host remembers `pid -> seat` for the whole lobby session, so a player who leaves and joins again, with a new peer id
or after the rejoin window, gets the same seat. A peer without a `pid` (legacy, or no id) gets the lowest free seat and
is not remembered. A seat is not moved while its player stays. Seat memory is host-side only; it is not replicated.
(After a host migration the new host rebuilds seats from the replica; see 8.) Vectors: `seats`.

### 4.4 Ready

`ready` is per player entry, false on admission. Only role `player` entries can be ready (a spectator `ready` is
`nack not_allowed`; a legacy peer cannot). `allReady` (host view): at least one player entry, every non-legacy player
connected and ready. The flag is reset to false for every player by back to lobby (4.7) and when a player becomes a
spectator.

### 4.5 Start, countdown, auto start

State machine, host only: `lobby` -> (`countdown` ->) `started` -> `lobby`.

- `start()` (the host's call; a joiner's `req start` only raises the host's `requested` event): needs state `lobby`,
  else `wrong_state`; needs at least `minPlayers` connected player entries, else `not_enough_players`. With
  `countdownMs > 0` it enters `countdown`; with 0 it goes straight to `started`.
- `countdown`: `total = countdownMs`. The host sends `upd{state:"countdown", countdown}` at the start, then `cd{seq, left}`
  about once a second, and at the end `upd{state:"started", countdown:null}` and the lobby phase `in_game` (signaling
  `phase`, plus lockstep start). The start is therefore the host's decision at its own timer end; a joiner never starts
  by its own timer.
- Cancel: the host's `cancelCountdown()` (reason `host`); fewer than `minPlayers` connected players (`too_few`); for a
  countdown that auto start began, the auto-start condition no longer holding (`condition`). It sends
  `upd{state:"lobby", countdown:null, cancel:reason}`. `countdownCancelled` fires with the reason on every peer.
- **Auto start** (host evaluates after every roster, ready and settings change, and on each tick, only in state `lobby`):
  `shouldAutoStart` (vectors `autoStart`). Mode `all_ready`: at least `max(minPlayers,1)` eligible players, every eligible
  player ready, and no player reconnecting. Mode `players`: at least `max(autoStartPlayers, minPlayers)` eligible
  players. Eligible = role `player`, status `connected`, not legacy. Mode `off`: never. When true the host runs
  `start()`. After back to lobby (4.7) auto start stays off until the next change of the roster or of a ready flag, so
  `players` mode does not restart a match at once.

**Time base (decision).** Only host-relative timing exists, and it is enough: `left` is measured on the host at the
instant it sends. A receiver sets `deadline = receivedAt + left - oneWay`, in its own `clock.now()` base, where
`oneWay = clamp(rtt / 2, 0, 2000)` and `rtt` is the receiver's latest ping round trip to the host in ms (0 when none was
measured). `remaining(now) = max(0, deadline - now)`. Every `cd` and `upd` carrying `countdown` replaces the deadline, so
error does not accumulate. All peers agree to within the difference of their one-way delays (tens of ms on a normal
link); wall clocks are never compared. A game that needs one agreed instant for its own first tick waits for `started`.
Vectors: `countdown`.

### 4.6 Spectators and roles

`role` is `player` or `spectator`. `settings.maxPlayers` limits entries with role `player` (reconnecting ones included);
`settings.spectators` limits entries with role `spectator`; `0` means spectating is off. Spectators never get a seat, are
never ready, and are not counted for auto start. On a server lobby the hub capacity is `maxPlayers + spectators` (7), the
room splits it.

- A joiner asks for a role in `join.role`. A `role` request changes it later: player to spectator when spectator
  capacity allows (`spectators_full`); spectator to player when player capacity allows (`lobby_full`) and late join
  allows it (4.8, `in_game`).
- The host can move anyone with `room.moveTo(peerId, role)`; the same capacity rules apply and a failure throws.
- Moving to spectator: seat -1, `ready` false. Moving to player: seat per 4.3.

### 4.7 Roster states, rejoin, seat dropped, back to lobby

- **Connected to reconnecting.** An admitted peer that disappears from the hub with reason `timeout` (socket or link
  lost; the hub keeps its slot for its own resume window) becomes `reconnecting` for `rejoinWindowMs` (default 60000;
  0 = never, remove at once). It keeps its entry, seat, data and ready flag. The peer, resuming with the same peer id,
  or joining again with the same `pid` under a new peer id, goes back to `connected` after its `join` (a new peer id
  replaces the old entry; the old one is dropped without a `seatDropped`; the new entry starts fresh: not ready, data from its own
  `join`, the seat from the seat memory, 4.3).
- **Reconnecting to left.** At the end of the window the entry is removed (`gone why:"timeout"`).
- **Left at once.** Reasons `left`, `kicked`, `disconnected` remove the entry immediately.
- **Seat dropped (hook).** For an entry with role `player` that is removed, the host raises `seatDropped
  { seat, peerId, name, data, reason, afterWindow }` so the game can put a bot in the seat. `seatDropped` setting
  `window` (default): at removal. `immediate`: at the moment the entry becomes `reconnecting` (`reason:"disconnected"`,
  `afterWindow:false`) and not again at removal. A player who takes a seat back raises `seatRestored { seat, peerId, name,
  returning }` (`returning` true for the same `pid`) so the game removes the bot. Spectators never raise either.
- **Back to lobby / rematch** (host only): from `started` or `countdown`, one `upd` sets `state:"lobby"`, `countdown:null`
  and every player `ready:false`, sends the signaling `phase` `lobby`, and the game's lockstep session is reset (idle,
  tick 0). Links, roster, seats, data, names and bans are untouched; reconnecting entries stay. `rematch()` is
  `backToLobby()` followed by `start()` (the countdown applies). Both fire `backToLobby` on every peer when `state`
  changes to `lobby` from another state.

### 4.8 Late join policy and admission order

`settings.lateJoin`: `allow` (a joiner during `started` gets the role it asked for), `spectate` (it can only spectate:
the role is forced to `spectator`), `refuse` (`in_game`). The host runs these checks on `join`, in this order, the first
to fail ends it with a `deny` (and the peer is removed, 5.2); vectors `admission`:

1. `banned`: the `pid` or the link address matches the ban list (5.3).
2. `bad_password`: the host has a password and `join.password` differs (6).
3. state `started` and policy `refuse`: `in_game`. State `started` and policy `spectate`: role becomes `spectator`.
4. role `player` and player entries at `maxPlayers`: `lobby_full`; role `spectator` and spectators at the cap
   (including cap 0): `spectators_full`.
5. admit.

A `join` from a peer that already has an entry (same peer id: a link re-established, or a new host after migration) skips
checks 2-4 when its `pid` is the entry's (or the entry has none) and only re-binds: status `connected`, `pid` recorded.
A late `address` match (the link's remote address becomes known after `join`) re-runs check 1 and removes the peer with
`banned`.

### 4.9 Filter hook

`room.filter` is a host-side callback `(text, kind) => string` with `kind` `"name"` or `"chat"`. Nothing is filtered by
default. For names see 4.1 step 4. For chat the host applies it to the sanitised text before it stamps and broadcasts the
line; an empty result drops the line like an empty message; a hook that throws counts as no hook. It runs on the host only;
joiners cannot see or change it (the older receiver-side `chat.filter` still exists and is a separate, local thing).

## 5. Kick and ban

### 5.1 Reasons

A removal carries a stable `code` (`^[a-z][a-z0-9_]{0,31}$`) and a free-text `reason` (at most 120 characters, after
stripping control and bidi characters). An empty reason becomes the default sentence of its code (vectors
`defaultReasons`). The removed player sees `removed { code, reason, ban }` (the `room` event `removed`; also
`lobby.removal`) before its `sessionEnded`. A host's declined join request has code `denied` ("The host did not let you in."). The reason is plain text for the player, never a stack or an address. When a `deny` frame and the signaling kick notice both reach
the joiner, the `deny`'s code and reason are the removal (an old hub drops the kick's `code`), so a joiner reads the frames its
host already sent before it ends the session on the kick notice.

### 5.2 How it travels

The host removes a peer with the existing signaling `kick`, extended with an optional `code` (additive):
`kick{ peerId, ban?, closeCode?, closeReason?, code? }`. The hub passes it on in `error{kicked, data:{ ban?, closeCode?,
closeReason?, code? }}` to the removed peer. `closeReason` carries the free text, so an old client or an old hub that
drops `code` still shows the sentence. A refused `join` (4.8) is `deny` on the data channel plus this kick with
`ban:false`. `lobby.kick(peerId)` is unchanged: it bans the address for this lobby only.

- `room.kick(peerId, { code?, reason? })`: remove, may rejoin (`ban:false`; default `code` `kicked`).
- `room.ban(peerId, { code?, reason? })`: remove and ban for good (5.3) (default `code` `banned`). The kick goes out
  with `ban:false`: the persistent list (and the hub's `bans` id set) does the banning, so `unban` can lift it. The
  removed player's `removed.ban` is true when the code is `banned`. Banning an address for this lobby only is
  `lobby.kick(peerId)`, unchanged.

### 5.3 The ban list

Host-side, survives the lobby, per game id. Entry `{ id?, ip?, name?, reason?, code?, at }`: `id` a `pid`, `ip` a
normalised address (lower case; an IPv4-mapped IPv6 `::ffff:a.b.c.d` becomes `a.b.c.d`), `name` the name at ban time,
`at` unix ms. At most 1000 entries (the oldest is dropped).

**Match (decision).** An entry matches a candidate `{ id?, ip? }` when `entry.id` and `candidate.id` are both set and
equal; or when `entry.ip` and `candidate.ip` are both set and equal AND at least one of `entry.id`, `candidate.id` is
absent. So the IP is a fallback for peers without an id (a client that never sent one, or a ban made without one); two
different valid ids behind one address are never the same player. Vectors: `bans`.

`room.ban` stores `id` (the player's `pid`) and `ip` (the link's remote address when known; never a loopback address,
never a relay's). The check runs on every route, on the host, when `join` arrives and when a link's address becomes
known. Hubs also refuse early (7) so a banned player's `join()` fails at once.

Storage is pluggable: a `BanStore { load(): string | null, save(text: string): void }` over one JSON text
`{ "v":1, "bans":[Entry...] }` under the key `onelobby.bans.<gameId>`. JS defaults: `localStorage` where it exists, else a
JSON file when the game gives a path (`banFile`), else memory. Unban: `room.unban({id?|ip?})` or by index; `room.bans.list()`,
`add`, `remove`, `clear`; `bansChanged` fires. A corrupt or unreadable store loads as empty and is not overwritten until the
next change.

## 6. Passwords

Every route supports one (the `password` option of `host()`, `hostDirect()`, `hostNostr()`). A wrong or
missing password has the stable code `bad_password`:

- **Server lobby**: `create.password` (at most 64 chars; empty = none). `join.password` must equal it, else the hub answers
  `error{bad_password}` (so `join()` rejects). `list` entries carry `hasPassword:true`.
- **Direct lobby** (IP, Nostr, browser host): the Direct hub's existing `join.password` check (the hub option), unchanged.
- **Every route, host side**: the host's room layer also checks `join.password` on the data channel (4.8), so a hub that
  does not know passwords (an old server) is still protected; the joiner then ends with `sessionEnded` and the kit's
  `error` event `bad_password`. A joiner sends the password it has in both places. Compare in constant time; the
  password is never logged, never replicated, never in `snap`.
- The blueprint key `room.passwordRequired: true` makes `host()` throw `password_required` when no password is given.

## 7. Hub additions (additive; every old message is unchanged)

- `welcome.features` contains `"room"` when the hub understands all of the below.
- `hello.playerId?` (the `pid`): the hub keeps it on the session. Not stored beyond the lobby; not logged.
- `create.password?`, `create.spectators?` (integer 0..250; capacity is `maxPlayers + spectators`, at most 250 else
  `bad_request{field:"spectators"}`); `lobby.spectators` echoes it. `lobby.maxPlayers` stays the player count.
- `join.password?`: see 6. The hub's join check order is unknown_code, bad_password, version_mismatch, kicked (address),
  banned (pid), in_game, lobby_full, then the private-lobby approval (`spec/signaling.md`).
- `bans{ ids:[pid...] }` (host only, at most 256 ids, each `^[0-9a-f]{32}$`; replaces the lobby's set): a later `join`
  whose `hello.playerId` is in it gets `error{banned}`. `not_host` for a non-host.
- `kick.code?`: see 5.2.
- Error codes `bad_password` and `banned` join the schema's `errorCode`.

A host sends `bans` once after `create` (when the list is not empty) and whenever the list changes.

## 8. Compatibility

- **New client, old hub** (no `"room"` feature): everything above that is peer to peer works. `create.password` and
  `create.spectators` are ignored by the hub, so the host (a) enforces the password itself (4.8, 6), (b) creates the lobby
  with `maxPlayers + spectators` as the capacity and enforces the split itself (so the lobby list shows the larger
  number), (c) kicks a banned `pid` after it joined. Nothing throws.
- **Old client, new hub**: it sends none of the new fields and ignores the new ones. A password lobby answers its `join`
  with `bad_password` and a banned address with `kicked` as before (clean, stable failure).
- **New joiner, old host** (no room layer): the host ignores frame `0x80` and sends no `snap`. A joiner that has not
  received `snap` or `deny` `3000` ms after its link opened sets `room.supported = false` and fires `unsupported`.
  `room.players` then lists the hub roster (all role `player`, `ready:false`, `seat:-1`, `legacy` not set); mutating
  calls throw `OneLobbyError("room_unsupported")`. No room state is ever invented, so nothing can desync.
- **Old joiner, new host**: its frames are the usual ones; no `join` arrives within `3000` ms of its `hi`, so the host
  admits it as a `legacy` player: default name rules, lowest free seat, never ready, no room frames sent to it. A game that
  needs readiness must require the room layer (a joiner without it shows as `legacy`).
- **Version**: `v` is 1. A `join.v` above the host's is answered with the host's `v` and the host's behaviour; a
  host or joiner ignores fields and messages it does not know. A change that old receivers cannot ignore needs `v` 2 and a
  capability in `join`/`snap`, never a silent change.
- **Host migration** (server lobbies): the new host builds its room from its replica (entries, rev, state), marks every
  other entry `reconnecting` (no `pid` is known), and rebinds each as that peer's new `join` arrives; entries that do not
  re-join inside the rejoin window are removed. Seat memory and the ban list are the new host's own (the ban list from its
  local store); a started countdown is cancelled (`reason:"host"`).

## 9. Events and API (JS names; C# and GDScript follow their conventions)

`lobby.room`:

- State: `state`, `supported`, `players` (role player), `spectators`, `entries`, `me`, `player(id)`, `settings`,
  `countdown` (`{ seq, total, deadline, remaining() }` or null), `allReady`, `rev`.
- Player calls: `setData(values)`, `setReady(bool)`, `setRole(role)`, `request(what)`.
- Host calls: `setData(peerId, values)`, `moveTo(peerId, role)`, `start()`, `cancelCountdown()`, `backToLobby()`,
  `rematch()`, `kick(peerId, opts)`, `ban(peerId, opts)`, `unban(idOrIp)`, `bans`, `filter`, `configure(partialSettings)`
  (changes `autoStart`, `autoStartPlayers`, `minPlayers`, `countdownMs`, `lateJoin`, `seatDropped`, `rejoinWindowMs` and
  broadcasts them in an `upd.settings`; the player and spectator caps are fixed when the lobby is created).
- Events: `changed` (any replica change), `playerJoined`, `playerLeft`, `playerChanged(entry, keys)`, `stateChanged`,
  `allReadyChanged`, `countdown`, `countdownCancelled(reason)`, `backToLobby`, `seatDropped`, `seatRestored`, `requested`,
  `removed`, `rejected(code, re)`, `bansChanged`, `supported`, `unsupported`.

## 10. Blueprint keys (`room` section of `onelobby.json`, `spec/blueprint.schema.json`)

`autoStart` (`off` default, `all_ready`, `players`), `autoStartPlayers` (2-64, default 2), `minPlayers` (1-64, default 1),
`countdownSeconds` (0-60, default 3), `spectators` (cap, 0-64, default 0), `lateJoin` (`allow`, `spectate`, `refuse`;
default `allow` when `lobby.lateJoin` is true, else `refuse`), `seatDropped` (`window` default, `immediate`),
`rejoinWindowSeconds` (0-600, default 60), `passwordRequired` (default false), `data` (declarations, 4.2, at most 16).
Cross rules: `late_join_conflict` (`lobby.lateJoin` false with `room.lateJoin` allow or spectate; true with refuse),
`min_exceeds_max` (`room.minPlayers` over `lobby.maxPlayers`), `autostart_exceeds_players` (`room.autoStartPlayers` over
`lobby.maxPlayers`, only when `autoStart` is `players`). Vectors: `spec/vectors/blueprint.json` lists `roomValid` and
`roomInvalid` (the same shape as `valid` and `invalid`; the C# and GDScript loaders read them when they gain the section).
