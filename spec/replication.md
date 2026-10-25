# Replication protocol, version 1 (inside `raw` payloads)

Normative source: DESIGN s.18. Reference implementation: `clients/dotnet/OneLobby.Replication` (`Protocol.cs`,
`NetBits.cs`). Test vectors: `spec/vectors/replication.json` (every implementation must encode them byte for byte and
reject the `invalid` ones). This layer changes nothing in the lobby protocol (`lk1`, `signaling.md`) or the data-channel
frames (`binary.md`): each message below is the body of one `raw` frame (type 0x20), on the channel named here.

## Conventions

- `varuint`: unsigned LEB128 (7 bits per byte, low group first, high bit = more). At most 10 bytes; values of 32-bit
  fields above 2^32 - 1 are errors (`range`).
- `u8`: one byte. No other integer encodings are used.
- Ticks are host sim ticks, 1-based (`0` = none). Input sequence numbers are per client, 1-based (`0` = none).
- Decoders reject a message (drop it, never crash) on: fewer bytes than the layout needs (`too_short`), bytes left over
  (`trailing`), and the semantic errors named below. A message with another `version` is ignored.

## Prefix (every message)

| offset | field | value |
|---|---|---|
| 0 | `magic:u8` | `0x52` (`'R'`). A raw payload with any other first byte is not replication: pass it to the game |
| 1 | `version:u8` | `1` |
| 2 | `kind:u8` | `1` snapshot, `2` input, `3` event, `4` stream event |

## kind 1: `snapshot` (host -> one client, `fast`)

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
| 1 | full | `type:varuint (<= 65535), owner:varuint, len:varuint (<= 255), state[len]` | spawn, or the entity's type/owner/length changed. Replaces the baseline entry if there is one |
| 2 | despawn | (none) | entity removed. Error `despawn` if the id is not in the baseline |
| 3 | reserved | | error `op` |

Decoding: the result world = the baseline's entities, with every record applied; baseline entities without a record
are unchanged. A full snapshot (`back = 0`) has no baseline, so it may contain only op 1. A client that does not hold
the baseline tick drops the snapshot silently (it is counted, not an error); the host will move to a newer baseline as
soon as an ack reaches it.

Host rules:
- Encode against the newest tick the client acknowledged (`ack` in its `input`), if the host still has that world (it
  keeps 64 ticks); else send a full snapshot. A new client (no ack yet) gets full snapshots.
- Unchanged entities produce no record. Never reuse an entity id within a session.
- `owner` is a lobby `peerId`; `0` = owned by the host / nobody (AI, doors, pickups).
- Keep a snapshot within one data-channel message (aim for <= 1200 bytes); the lobby chunks anything above 16 KiB onto
  `reliable`.

Client rules:
- Keep the decoded worlds of the last 64 ticks (as baselines and for interpolation). Ack the newest tick decoded.
- Snapshots on `fast` may arrive out of order or twice: insert any tick not yet held and newer than the window; only a
  newer tick advances `ack` and `lastInput`.

## kind 2: `input` (client -> host, `fast`)

```
ack:varuint             newest snapshot tick this client decoded (0 = none)
newest:varuint          sequence number of the first input below (0 when n = 0)
n:u8                    number of inputs, newest first: seq newest, newest-1, ... (n <= newest)
n x ( view:varuint      host tick the client was rendering when it made this input, in 1/256 tick (render tick x 256)
      len:varuint
      bytes[len] )      the game's input bytes (<= 1024)
```

- The client sends one `input` per local tick (same rate as the host tick), carrying its last `InputRedundancy`
  (default 4) inputs, so one lost packet loses nothing. With no input to send it still sends `n = 0` once per tick
  period so `ack` keeps flowing.
- The host ignores inputs with `seq <=` the last it applied and duplicates; it hands the game one input per host tick in
  sequence order, repeats the last when none is due, and drops the oldest queued ones past `MaxInputBuffer` (default 4).
  `ack` is accepted only if it is a tick the host sent and not older than the one it holds.

## kind 3: `event` (either direction, `reliable` or `fast`)

```
tick:varuint            host: its current tick; client: its estimate of the host tick
rest                    the game's event bytes
```

Host to one client or each client (never relayed by clients); client to host only. On `reliable` events are ordered
and never lost; they may arrive before the snapshot of the same tick (a client that wants to show them in sync delays
them until its render tick reaches `tick`).

## kind 4: `stream event` (either direction, `reliable` only)

```
tick:varuint            as kind 3
stream:u8               1-255 (0 is malformed)
seq:varuint             1, 2, 3, ... per (stream, sender, receiver); 0 is malformed
rest                    the game's event bytes
```

Same routing as kind 3. The receiver delivers each `(sender, stream)` in `seq` order exactly once: a `seq` already
delivered or already waiting is dropped (a duplicate); one past a missing number waits for it; a hole still open after
1000 ms is reported as a gap and skipped. Reliable links never trigger either, so both are counted as anomalies. A
sender restarts a peer's numbering at 1 when that peer (re)joins; receivers forget a peer's streams when it leaves.

## State bits (inside a state, the game's schema)

The bytes of one entity's state are the game's, written by `NetWriter` and read by `NetReader` in the same order.
Implementations should offer the same packing so a JS game can read a C# host:

- Bits are written LSB first: bit `k` of a value written at stream position `p` lands in bit `(p + k) & 7` of byte
  `(p + k) >> 3`. The last byte's unused high bits are zero. State length = `ceil(bits / 8)`, at most 255 bytes.
- Reading past the end yields zero bits (and flags an overrun).
- `bool` 1 bit; `byte` 8; `uint16` 16; `uint32`/`int32` 32 (two's complement); `float` = 32 IEEE-754 bits.

## Quantization

- `Float(v, min, max, bits)`: clamp `v` to `[min, max]` (NaN -> min), `q = round((v - min) / (max - min) * (2^bits - 1))`,
  rounding half away from zero, computed in double precision. Inverse: `min + (max - min) * q / (2^bits - 1)`.
- `Angle(deg, bits)`: `a = deg mod 360` in `[0, 360)`; `q = round(a / 360 * 2^bits) mod 2^bits`. Inverse `q * 360 / 2^bits`.
- `Quaternion(x, y, z, w, b = 9)` smallest-three: normalize; `i` = index of the largest absolute component (first on
  ties); if that component is negative negate all four; write `i` in 2 bits, then the other three components in index
  order as `Float(c, -1/sqrt(2), 1/sqrt(2), b)`. Inverse: the largest = `sqrt(max(0, 1 - sum of squares))`. 2 + 3b bits.

## Versioning

`version` changes only for an incompatible layout. Additive changes (new `kind` values) keep version 1: decoders ignore
unknown kinds. The game's own schema is versioned by the lobby's `netVersion` (bump it when a state layout changes).
