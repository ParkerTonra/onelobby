# Replication protocol, version 1 (inside `raw` payloads)

Normative source: DESIGN s.18. Reference implementation: `clients/dotnet/OneLobby.Replication` (`Protocol.cs`,
`NetBits.cs`, `ReplicationSession.cs`, `Describe.cs`). Other implementations: `clients/js/packages/client/src/replication/` and
`clients/gdscript/addons/onelobby/replication_*.gd`.
Test vectors: `spec/vectors/replication.json` (every implementation must encode them byte for byte and reject the
`invalid` ones; generated from the C# reference, see "Vectors" at the end). This layer changes nothing in the lobby
protocol (`lk1`, `signaling.md`) or the data-channel frames (`binary.md`): each message below is the body of one `raw`
frame (type 0x20), on the channel named here.

Marked **(decision)**: a rule the design left open and this document fixes. Everything not marked is what the C#
reference already did.

## Conventions

- `varuint`: unsigned LEB128 (7 bits per byte, low group first, high bit = more). At most 10 bytes, and the 10th byte
  may only be `0` or `1` (a value must fit 64 bits; otherwise error `varint`). Fields documented as 32-bit
  (`tick`, `back`, `lastInput`, `ack`, `newest`, `seq`) above 2^32 - 1 are errors (`range`). Overlong encodings
  (`80 00` for 0) are accepted.
- `u8`: one byte. No other integer encodings are used.
- Ticks are host sim ticks, 1-based (`0` = none). Input sequence numbers are per client, 1-based (`0` = none).
- Decoders reject a message (drop it, never crash; count it as malformed) on the errors in this table, named exactly
  like this so every implementation and every vector agrees:

| error | when |
|---|---|
| `too_short` | fewer bytes than the layout needs |
| `trailing` | bytes left over after the last field (snapshots and inputs; events and stream events take "the rest" as payload) |
| `varint` | a varuint longer than 64 bits |
| `range` | a 32-bit field above 2^32 - 1 |
| `tick` | snapshot `tick` is 0, or `back > tick` |
| `baseline` | `back = 0` but a baseline is given, or `back > 0` and none is (a decoder is handed the baseline the header names) |
| `id` | a record with `idDelta = 0`, or ids past 2^32 - 1 |
| `op` | record op 3 (reserved) |
| `delta` | op 0 for an id that is not in the baseline |
| `despawn` | op 2 for an id that is not in the baseline |
| `full` | op 1 with `type > 65535`, `owner > 2^31 - 1` or `len > 255` |
| `seq` | input with `n > newest` |
| `stream_0` | stream event with `stream = 0` |
| `seq_0` | stream event with `seq = 0` |

A message whose `version` is not 1 is ignored (counted as malformed, no error name: the receiver does not know the
layout). An unknown `kind` is ignored. A raw payload shorter than 3 bytes or whose first byte is not `0x52` is not
replication.

## Prefix (every message)

| offset | field | value |
|---|---|---|
| 0 | `magic:u8` | `0x52` (`'R'`). A raw payload with any other first byte is not replication: pass it to the game untouched |
| 1 | `version:u8` | `1` |
| 2 | `kind:u8` | `1` snapshot, `2` input, `3` event, `4` stream event |

## kind 1: `snapshot` (host -> one client, `fast`; keyframes on `reliable`)

```
tick:varuint            host tick this world is from (>= 1)
back:varuint            0 = full snapshot; otherwise the baseline is tick - back (must be <= tick)
lastInput:varuint       last input seq of THIS client the host applied before building it (0 = none)
count:varuint           number of records
count x record          sorted by entity id, strictly increasing
```

Record: `head:varuint = (idDelta << 2) | op`, where `idDelta = id - previousRecordId` (the first record uses 0 as the
previous id; `idDelta = 0` is error `id`).

| op | name | body | meaning |
|---|---|---|---|
| 0 | delta | `mask[ceil(len/8)]`, then one byte per set mask bit | entity exists in the baseline with the same type, owner and state length `len`. Bit `k` of the mask (bit `k & 7` of byte `k >> 3`) set = state byte `k` changed; the new bytes follow in increasing `k`. Error `delta` if the id is not in the baseline |
| 1 | full | `type:varuint (<= 65535), owner:varuint (<= 2^31 - 1), len:varuint (<= 255), state[len]` | spawn, or the entity's type/owner/length changed. Replaces the baseline entry if there is one |
| 2 | despawn | (none) | entity removed. Error `despawn` if the id is not in the baseline |
| 3 | reserved | | error `op` |

Decoding: the result world = the baseline's entities, with every record applied; baseline entities without a record
are unchanged. A full snapshot (`back = 0`) has no baseline, so it may contain only op 1 (an op 0 or 2 record then
fails with `delta` or `despawn`). A snapshot may have `count = 0`. A client that does not hold the baseline tick drops
the snapshot silently (it is counted as dropped, not an error); the host will move to a newer baseline as soon as an
ack reaches it.

Encoding (host): walk the new world and the baseline in id order. An id only in the new world: op 1. An id only in the
baseline: op 2. An id in both: op 1 if `type`, `owner` or the state length differ; nothing if the state bytes are
identical; else op 0 with the changed bytes. An entity with an empty state (`len 0`) therefore never has a delta.
`lastInput` is 0 when no input of that client was handed to the game yet.

### Host rules

- **Cadence.** One snapshot per `SnapshotEveryTicks` host ticks (default 1, 30 Hz), at most one per tick. The state of
  each entity is written fresh each time; unchanged state keeps the same bytes. A state over 255 bytes is a bug in the
  game (the host throws).
- **Baselines.** The host keeps the worlds it sent for the last 64 ticks (`HistoryTicks`: a world is dropped when
  `its tick + 64 < the current tick`). It encodes against the newest tick the client acknowledged (`ack` in its
  `input`) if it still has that world; else it sends a full snapshot. A new client (no ack yet) gets full snapshots.
  An `ack` counts only if it is `<=` the host's current tick, `>` the one it holds, `>` the client's resync floor (below)
  and a tick the host sent.
- **Resync.** The game may force a client back to full snapshots (`SendFullSnapshot(peer)`): the stored ack is cleared
  and the floor set to the current tick, so only an ack of a snapshot sent after the call restores deltas.
- **Clients.** A peer becomes a snapshot client when its data link is up (`peerReady`), not when the server announces
  it; before that nothing is sent to it (reliable events are queued by the lobby). It is removed when it leaves, and
  its streams are forgotten.
- Unchanged entities produce no record. Never reuse an entity id within a session (ids start at 1).
- `owner` is a lobby `peerId`; `0` = owned by the host / nobody (AI, doors, pickups).
- Keep a snapshot within one data-channel message (aim for <= 1200 bytes; the reference counts larger ones as
  oversize); the lobby chunks anything above 16 KiB onto `reliable`.

### Keyframes **(decision)**

Deltas on `fast` recover on their own (the host only encodes against ticks the client acked), but a joiner with a
lossy start or a client that lost its state should not wait for luck. So:

- When a client becomes a snapshot client, its next snapshot is a **keyframe**: a full snapshot (`back = 0`) sent on
  `reliable` instead of that tick's fast snapshot.
- Then another keyframe every `KeyframeSeconds` (default 5; `0` = off, no keyframes at all, including on join), at the
  first snapshot tick after the interval ran out, counted on the host's clock.
- A keyframe is an ordinary kind 1 message; it is the snapshot of its tick (no fast snapshot of the same tick is sent to
  that client). A client treats it like any other snapshot: a tick it already holds is ignored, it may arrive after
  newer fast snapshots, and it advances `ack` only if newer.

### Client rules

- Keep the decoded worlds of the last 64 ticks (as baselines and for interpolation): a world is dropped when
  `its tick + 64 < the newest tick`. Ack the newest tick decoded (`ack` in every `input`).
- Snapshots on `fast` may arrive out of order or twice: ignore a tick already held or older than the window (when the
  newest tick is above 64), drop one whose baseline is not held (counted), otherwise decode and insert; only a newer
  tick advances `ack` and `lastInput` (every inserted snapshot feeds the clock estimate).
- Snapshots are accepted only from the host.

### Clock and render time (client)

- `tickMs = 1000 / tickRate` (default 30 Hz, so 33.33 ms); `now` is the lobby's monotonic millisecond clock.
- Offset estimate: for every snapshot that is inserted, `sample = snapshotTick * tickMs - now`. The first sample, or any
  larger one, becomes `offset`; a smaller one pulls it down slowly:
  `offset = max(sample, offset - (now - lastSampleAt) * 0.05)`. (The least delayed packet shows the host clock best.)
  `lastSampleAt` is `now` of the previous sample.
- `ServerTick = (now + offset) / tickMs` (0 until the first snapshot): the estimated current host tick, fractional.
- `RenderTick`: the target is `ServerTick - InterpolationDelayMs / tickMs` (default 100 ms). It is set to the target
  at once on the first estimate or when more than 10 ticks away; otherwise each pump advances it by
  `elapsedMs / tickMs`, then closes 10% of the remaining error, and it never runs backwards.

### Sampling and visibility (client)

- `TrySampleAt(id, tick)`: `a` = the newest held world with `world.tick <= tick` (none: false); the entity must be in
  `a` (else false). If a next held world `b` exists, `tick > a.tick` and the entity is in `b` with the same `type`,
  the state is interpolated with `t = (tick - a.tick) / (b.tick - a.tick)`; otherwise `a`'s state is held, never
  extrapolated. `TrySample` = `TrySampleAt(id, RenderTick)`. `TryGetLatest` = the entity in the newest held world, with
  its tick (not interpolated).
- Visibility is decided at `RenderTick`, in the newest held world with `tick <= RenderTick`: an entity present there and
  not yet reported is reported as spawned; a reported entity absent there, or present with another `type`, is reported
  as despawned (a type change then reports a spawn for the new type). An owner change updates the entity info without
  an event.

## kind 2: `input` (client -> host, `fast`)

```
ack:varuint             newest snapshot tick this client decoded (0 = none)
newest:varuint          sequence number of the first input below (the client's last sequence number, also when n = 0)
n:u8                    number of inputs, newest first: seq newest, newest-1, ... (n <= newest)
n x ( view:varuint      host tick the client was rendering when it made this input, in 1/256 tick (render tick x 256)
      len:varuint
      bytes[len] )      the game's input bytes (<= 1024; decoders do not enforce the limit)
```

- The client sends one `input` per local tick (same rate as the host tick), carrying its last `InputRedundancy`
  (default 4, 1..255) inputs, so one lost packet loses nothing: `SubmitInput` prepends the new input, trims the window to
  `InputRedundancy`, and sends. `view` = `max(0, round(RenderTick * 256))`. To keep the datagram small, older copies are
  left out once the running sum of `len + 6` over the entries so far exceeds 1000 bytes (the newest is always sent).
- With no input to send the client still sends `n = 0` (with `ack` and `newest`) once per tick period, from the first
  snapshot on, so `ack` keeps flowing. (Checked each pump: when `tickMs` ms passed since the last input message.)
- The host ignores inputs with `seq == 0`, `seq <=` the last it handed out, and duplicates. Per client it holds a queue
  ordered by seq. Each `TryGetInput` (one per host tick per client) first drops the oldest queued inputs while more than
  `MaxInputBuffer` (default 4, at least 1) are queued (counted as skipped; the dropped one counts as consumed), then
  hands out the oldest queued input (a gap before it counts the missing numbers as lost) and remembers it; with an empty
  queue it repeats the last handed one (marked repeated, counted) and returns nothing before the first. A client's
  `lastInput` in snapshots is the seq of the last input handed out.
- `view / 256` is the host tick the shooter saw; the host clamps a rewind to `MaxRewindMs` (default 250):
  `min(now, max(now - MaxRewindMs / tickMs, view / 256))`.

## kind 3: `event` (either direction, `reliable` or `fast`)

```
tick:varuint            host: its current tick; client: floor(ServerTick), 0 before its first snapshot
rest                    the game's event bytes
```

Host to one client or each client (never relayed by clients); client to host only. Default channel is `reliable`
(ordered, never lost); `fast` events are not repeated or retransmitted: use them for cosmetic one-offs. On `reliable`
they may arrive before the snapshot of the same tick; a client that wants to show them in sync sets `HoldEventsForTicks`
(default 0 = off): an event whose tick is newer than the newest snapshot waits, arrival order kept, until that snapshot
is in or for at most that many ticks. A host event with `toPeer = 0` goes to every snapshot client and to peers still
joining (the lobby queues reliable sends until their link opens).

## kind 4: `stream event` (either direction, `reliable` only)

```
tick:varuint            as kind 3
stream:u8               1-255 (0 is malformed)
seq:varuint             1, 2, 3, ... per (stream, sender, receiver); 0 is malformed
rest                    the game's event bytes
```

Same routing as kind 3. The receiver delivers each `(sender, stream)` in `seq` order exactly once: a `seq` already
delivered or already waiting is dropped (a duplicate); one past a missing number waits for it; a hole still open after
1000 ms is reported as a gap and skipped (delivery goes on at the first number it holds; the hole's timer restarts when
it moves). Reliable links never trigger either, so both are counted as anomalies. A sender restarts a peer's numbering at
1 when that peer (re)joins; receivers forget a peer's streams when it leaves.
Limits a receiver enforces so a misbehaving sender cannot make it hold events without bound: a kind 4 frame on `fast`,
or with a `seq` more than 4096 past the last delivered one, is malformed and dropped (counted); when more than 64 events
or 256 KiB of payload wait in one `(sender, stream)`, the hole is reported as a gap at once instead of after 1000 ms.
`HoldEventsForTicks` applies to stream events too, after ordering.

## State bits (inside a state, the game's schema)

The bytes of one entity's state are the game's, written by `NetWriter` and read by `NetReader` in the same order.
Implementations should offer the same packing so a JS game can read a C# host:

- Bits are written LSB first: bit `k` of a value written at stream position `p` lands in bit `(p + k) & 7` of byte
  `(p + k) >> 3`. The last byte's unused high bits are zero. State length = `ceil(bits / 8)`, at most 255 bytes (2040 bits).
- `WriteBits(v, n)` writes the low `n` bits of `v`, `1 <= n <= 32` (other `n` is a programming error); bits above `n`
  are discarded.
- Reading past the end yields zero bits for the missing bits and flags an overrun (the flag stays set).
- `bool` 1 bit; `byte` 8; `uint16` 16; `uint32`/`int32` 32 (two's complement); `float` = the 32 IEEE-754 bits of a
  float32 (`-0` and subnormals keep their bits; NaN is not guaranteed to keep its payload).
- `quantized(v, min, max, bits)`, `angle(deg, bits)`, `quaternion(x, y, z, w, b)`: the next section, written as `bits`,
  `bits` and `2 + 3b` bits.

## Quantization

All inputs are float32 values (a JSON vector value is first rounded to float32), all arithmetic is double precision
unless noted, and every output is float32. "Round" = half away from zero (for the non-negative values here: `floor(x)`,
plus 1 when the fraction is `>= 0.5`; not banker's rounding).

- `Float(v, min, max, bits)` (`1 <= bits <= 32`, `max > min`): NaN -> `min`; clamp `v` to `[min, max]`;
  `t = (v - min) / (max - min)` in double; `q = round(t * (2^bits - 1))`. Inverse:
  `float32(min + (max - min) * min(q, 2^bits - 1) / (2^bits - 1))`.
- `Angle(deg, bits)`: `a = deg mod 360` (the remainder keeps the sign of `deg`), `a += 360` if `a < 0`;
  `q = round(a / 360 * 2^bits) mod 2^bits`. Inverse `float32(q * 360 / 2^bits)`. `deg` must be finite.
- `Quaternion(x, y, z, w, b = 9)` smallest-three: `len = sqrt(x*x + y*y + z*z + w*w)` with the products and sums in
  float32 and the root in double; if `len < 1e-6` the input is `(0, 0, 0, 1)`; each component becomes
  `float32(c / len)`; `i` = index of the largest absolute component (the first on ties); `sign` = -1 if that component
  is negative; write `i` in 2 bits, then the other three components in index order as
  `Float(float32(c * sign), -0.70710678f, 0.70710678f, b)`. Inverse: the three are
  `Dequantize(q, -0.70710678f, 0.70710678f, b)`; the largest = `float32(sqrt(max(0, 1 - sum of their squares)))` (squares in
  float32, summed in double); components returned in x, y, z, w order. The result is the quaternion or its negative.

## Debug view **(decision)**

The wire stays binary. Every client offers `describe(bytes[, baseline])`: one replication message as a plain
JSON-able object; the JSON shape below is normative (key order as shown, numbers as JSON integers, bytes as lowercase
hex). `bytes` is the message length. `baseline` is the world the snapshot's `back` names, if known (the vectors give it
as the same world list as in `snapshots`); a delta record cannot be parsed without it, because the mask size comes from
the entity's state length there.

```
{ "kind": "snapshot", "bytes": N, "tick", "back", "baselineTick", "lastInput", "count",
  "records": [ { "id", "op": "full", "type", "owner", "len", "state": hex },
               { "id", "op": "delta", "changed": [byte indexes], "values": hex },
               { "id", "op": "despawn" } ] }
{ "kind": "input", "bytes": N, "ack", "newest", "n", "inputs": [ { "seq", "view256", "len", "hex" } ] }
{ "kind": "event", "bytes": N, "tick", "len", "payload": hex }
{ "kind": "streamEvent", "bytes": N, "tick", "stream", "seq", "len", "payload": hex }
{ "kind": "other", "bytes": N }                                  not replication (first byte not 0x52, or under 3 bytes)
{ "kind": "ignored", "reason": "version", "version": V, "bytes": N }
{ "kind": "unknown", "number": K, "bytes": N }                    a kind other than 1-4
{ "kind": "snapshot" | "input" | "event" | "streamEvent", "bytes": N, "error": "<error name>" }   malformed; no other fields
```

A delta record without a baseline is `{ "id", "op": "delta", "unknown": true }`; it ends the record list and the object
gets `"truncated": true` after `records`. `describe` never throws.

Session switch: a session has a packet log. When on, each replication packet sent or received writes one line to the
net log (the C# reference writes to a callback instead of the lobby's net log):
`rep <out|in> <peerId> <fast|reliable> <json>`, where `peerId` is the receiver for `out` and the sender for `in` and
`json` is `describe` of the message (with the baseline the session knows). At most `PacketLogPerSecond` (default 20) lines
per second; lines over the cap are dropped, not queued. Default off.

## Diagnostics (not on the wire)

A session counts, at least: snapshots sent / full / received / dropped (baseline missing), keyframes sent, largest
snapshot and oversize ones, inputs sent / received / repeated / skipped / lost, events sent / received, stream
duplicates, gaps and out-of-order, and malformed messages. For a net stats overlay it also reports **bytes per second**,
sent and received, each split into snapshots, inputs and events (stream events count as events) and in total, over a
sliding window of the last 1000 ms. Bytes are replication payload bytes (the raw payload, before the 3-byte lobby
header), counted when a message is sent or when a replication message of version 1 and kind 1-4 arrives.

## Versioning

`version` changes only for an incompatible layout. Additive changes (new `kind` values) keep version 1: decoders ignore
unknown kinds. The game's own schema is versioned by the lobby's `netVersion` (bump it when a state layout changes).

## Vectors

`spec/vectors/replication.json` has these groups; all hex is lowercase, a world is `[id, type, owner, stateHex]`:

- `snapshots`: `{name, tick, lastInputSeq, baseline: null | {tick, world}, world, hex, clientHoldsBaseline?}`. Encode
  `world` against `baseline` and compare `hex`; decode `hex` against `baseline` and compare `world`. A case with
  `clientHoldsBaseline: false` is a snapshot against a baseline the receiving client does not hold: the client drops it
  (counted, not an error) and decodes nothing.
- `inputs`: `{name, ack, newestSeq, inputs: [[view256, hex], ...], hex}` (newest first).
- `events`: `{name, tick, payloadHex, hex}`. `streamEvents`: `{name, tick, stream, seq, payloadHex, hex}`.
- `stateBits`: `{name, ops?, bits?, hex, reads, overrun}`. `ops` (write these in order, `repeat` times when given; the
  result is `hex` in `bits` bits), then `reads` (read from `hex` in order; each op repeats `repeat` times; each result
  equals `read`; the reader's overrun flag at the end equals `overrun`). Ops: `bits {v, n}`, `bool`, `byte`, `u16`, `u32`,
  `i32`, `float {v}`, `q {v, min, max, bits}`, `angle {v, bits}`, `quat {v: [x,y,z,w], bits}`. Float reads compare as float32.
- `quantize`: `{name, fn, value, bits, ..., q, back}`: `fn` `float` (`min`, `max`), `angle`, or `quat` (`value` is
  `[x,y,z,w]`, `largest`, `q` is `[a,b,c]`, `back` is `[x,y,z,w]`). A float or angle `value` may be the string `NaN`,
  `Infinity` or `-Infinity`. `back` compares as float32.
- `invalid`: `{name, kind?, baseline, hex, error}`: decoding `hex` (as `kind`, default `snapshot`; `input`, `event`,
  `streamEvent`) fails with `error`. Every error name above appears at least once.
- `describe`: `{name, hex, baseline, json}`: `describe(hex, baseline)` equals `json`.
- `streamReceive`: `{name, arrivals: [{at, stream, seq, bytes}], endAt, expect}`: the receive side of numbered stream events (kind 4). One
  receiver, one sender. Play the arrivals in order on a millisecond clock: at each `t` from 0 to `endAt`, first hand the receiver every
  arrival with `at == t` (a stream event of `bytes` payload bytes, tick 1, on `reliable`), then run its expiry (the gap timer). `expect` is
  what must have happened: `events` in order (`{type: "deliver", at, stream, seq}` or `{type: "gap", at, stream, firstMissing, nextDelivered}`),
  and the counts `duplicates`, `outOfOrder`, `gaps`, `malformed` and the number still `buffered` at the end. Generated by running each case
  through the C# session; the JS and GDScript tests replay them through their sessions (GDScript also on the bare stream buffer).

Regenerate from the reference (repository root; writes the file, then the plain test run checks it):
`ONELOBBY_WRITE_VECTORS=1 dotnet test clients/dotnet/OneLobby.Replication.Tests --artifacts-path .tmp-art --filter VectorFileTests`.
