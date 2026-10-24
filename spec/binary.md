# Data-channel binary protocol (peer to peer)

Normative source: DESIGN s.8, s.9, s.9a, s.9b. This file freezes the byte layout and closes the gaps (marked
**(decision)**). Test vectors: `spec/vectors/frames.json`, `chunking.json`, `invalid.json`. Reference codec:
`spec/reference/codec.mjs`.

## Framing

- Little-endian. One message per data-channel message. **Frame <= 16384 bytes** including the header. A larger payload is
  sent as chunks (below).
- Header, 3 bytes: `type:u8`, `route:u16`.
- Decoders reject (error, drop the frame, never crash): fewer bytes than the layout needs (`too_short`), extra bytes after the
  layout (`trailing`), frame over 16384 bytes (`too_long`), invalid UTF-8 in a text field (`bad_utf8`).
- Unknown `type` ids are ignored (additive evolution); they are not errors.
- Integer widths: `u8 u16 u32` unsigned; `i64` signed two's complement; `u64` unsigned. Ticks, timestamps: `i64`. Hashes: `u64`.
- `bytes[len]` fields have a `u16` length prefix unless noted. `rest` = all remaining bytes of the frame. `text` = `u16` byte length + UTF-8.

## Channels

| name | id | options | frames |
|---|---|---|---|
| `reliable` | 0 | ordered | everything except the rows below |
| `fast` | 1 | unordered, maxRetransmits 0 | `ping`, `pong`, `raw` (unreliable sends) |
| `voice` | 2 | unordered, maxRetransmits 0 | `voice` only. A `voice` frame on another channel is ignored |

## Route

`route = 0`: for the host, or broadcast. A joiner sends to the host with `route` = destination `peerId` (0 = everyone).
The host rewrites `route` to the **source** `peerId` when relaying, and stamps `route = its own peerId` on frames it
originates. A receiver therefore always sees the source in `route`. A joiner cannot forge `route`: the host overwrites it
with the id of the connection the frame arrived on. **(decision)** `cmd`, `hash`, `snapshot_req`, `hi` are always
`route 0` and are addressed to the host.

## Frame types

| id | name | body | notes |
|---|---|---|---|
| 0x01 | `hi` | `proto:u8=1, peerId:u16, lastTick:i64` | joiner -> host on `reliable` after the channels open. `lastTick` = last tick whose frame the joiner applied; **-1 = no state** (fresh joiner) |
| 0x02 | `welcome_dc` | `tick:i64, tickRate:u8, mode:u8, hostId:u16` | host -> joiner. `tick` = host's last emitted frame. `mode`: **1 = lockstep, 2 = raw** (0 reserved) **(decision)** |
| 0x10 | `cmd` | `seq:u32, len:u16, bytes[len]` | joiner (and host's own queue) -> host. `seq` per sender, starts at 1, +1 each command |
| 0x11 | `frame` | `tick:i64, n:u16, n x (peerId:u16, len:u16, bytes[len])` | host -> everyone. Ticks strictly consecutive (+1). `n = 0` frames are sent |
| 0x12 | `hash` | `tick:i64, hash:u64` | peer -> host, for each tick `T` with `T % hashEvery == 0` (T > 0) after applying frame `T` |
| 0x13 | `desync` | `tick:i64, hostHash:u64, yourHash:u64` | host -> one peer; immediately followed by a snapshot (below) |
| 0x14 | `snapshot_req` | `sinceTick:i64` | peer -> host. `sinceTick` = last tick the peer has (-1 = none) |
| 0x15 | `snapshot` | `tick:i64, total:u32, flags:u8` | header; the chunks follow (below) |
| 0x16 | `chunk` | `id:u32, index:u16, count:u16, rest` | either direction |
| 0x20 | `raw` | `rest` | `raw` mode payload |
| 0x30 | `ping` | `n:u32, t:u32` | on `fast`. `t` = sender's monotonic ms (mod 2^32) |
| 0x31 | `pong` | `n:u32, t:u32` | echo of the ping's `n` and `t`, `route 0` **(decision)** |
| 0x40 | `host_claim` | `epoch:u16, hostId:u16, tick:i64` | on `reliable`, to every reachable peer. `tick` = claimant's last applied tick |
| 0x50 | `voice` | `seq:u16, flags:u8, n:u8, n x (len:u16, opus[len])` | on `voice` |
| 0x60 | `chat` | `id:u32, ts:i64, len:u16, utf8[len]` | on `reliable` |
| 0x61 | `chat_history` | `n:u16, n x (peerId:u16, id:u32, ts:i64, len:u16, utf8[len])` | host -> joiner |
| 0x62 | `chat_reject` | `id:u32, reason:u8` | host -> sender. 1 rate, 2 length, 3 muted_by_host |

## Handshake and late join (lockstep)

1. Channels open. Joiner -> host: `hi`. Host replies, in this order: `welcome_dc`, `chat_history` (n may be 0).
2. If `welcome_dc.tick > 0` (a game is already running) and the lobby is lockstep: the host then sends `snapshot` +
   chunks (state after applying frame `tick`), then frames `tick+1, tick+2, ...` with no gap. **(decision)** If
   `welcome_dc.tick == 0` the joiner starts from the game's initial state and frames `1, 2, ...` follow directly.
3. The joiner discards any frame with `tick <=` its current tick and, on a gap (`frame.tick > current+1`), sends
   `snapshot_req{current}`.

Ticks: tick `T` is the state after applying frame `T`; the initial state is tick 0 and has no frame. `hash(T)` is the game
hash of the state at tick `T`.

## Snapshot and chunks

- Sender emits the `snapshot` header, then one chunk set (all chunks have the same `id`), on `reliable`, contiguous (nothing
  else is sent to that peer in between, including buffered frames). The receiver binds the **next chunk id seen after a
  `snapshot` header** to that snapshot. **(decision)**
- Payload bytes are the game's snapshot. `flags` bit0 = payload is deflated: **zlib stream (RFC 1950)**, what browser
  `CompressionStream("deflate")` and .NET `ZLibStream` produce **(decision)**. `total` = byte length of the payload as sent
  (after deflate), i.e. the sum of the chunk bodies. A receiver that gets a different sum drops the snapshot and
  re-requests.
- Chunk: `index < count`, `count >= 1`, same `count` and `id` across a set. Sender default chunk body 16000 bytes (max 16373 so
  the frame stays <= 16384). Receivers accept any order, ignore duplicates, and cap one reassembly at 64 MiB.
  An empty payload is one chunk with an empty body.
- **Large non-snapshot frames**: a sender may chunk any frame bigger than 16384 bytes: the reassembled bytes are one complete
  inner frame (header included) which the receiver then decodes and dispatches as if it had arrived whole. This applies
  when no snapshot header is pending. **(decision)**
- Receiving a snapshot: restore state to `tick`, ignore frames `<= tick`, continue with `tick+1`.

## Lockstep rules the harness checks

- Host emits frame `T+1` every `1000/tickRate` ms, never waits for peers; commands arrive -> placed in the next frame not
  yet emitted. Order inside one frame (DESIGN: "peerId then arrival order"): sorted by `peerId` ascending, stable, so one
  peer's own commands keep their arrival order. The host's own commands (peerId = host id) are in the same queue.
  **(decision: stable sort by peerId)**
- Hash check: host compares a peer's `hash(T)` with its own `hash(T)`. Mismatch -> `desync{T, hostHash, yourHash}` + a snapshot of the
  host's state at its **current** tick (not at `T`), then frames continue from `current+1`. The 1st and 2nd mismatch
  of a peer in a session are resynced; the **3rd** drops the peer (host closes that connection and signals `desync` to
  its game; there is no wire message). `snapshot_req` is answered with a snapshot without `desync` and does not count.
- A peer with no frames for 3 s sends `snapshot_req`; the host drops a peer it has had no `hash` from for 10 s.
- Hash reporting: a peer sends `hash` when `T % hashEvery == 0`; `hashEvery` defaults to `tickRate` and is a local setting
  (the host compares whenever it has both hashes).

## Migration (s.9)

- Host lost (no frames 3 s or channel closed): the lowest `peerId` among connected peers claims: it sends
  `host_claim{epoch+1, ownId, lastAppliedTick}` to every reachable peer and tells the server (`host_changed`).
- Arbitration: higher `epoch` wins; equal `epoch`: lower `hostId` wins. A claimant that receives a better claim demotes
  itself and follows the winner. Followers (re)connect to the winner ("dial") and send `hi{lastTick}`.
- The new host resumes `frame` emission at `min(lastTick of survivors) + 1`, replaying buffered frames to peers that are
  behind; the game sees `HostChanged`. Frames of the old epoch with a tick it already has are ignored.

## Chat (s.9b)

- Sender: `chat{id=client counter (>=1, +1 each), ts=0, text}` on `reliable`, `route 0`. **(decision: client id echoes in
  `chat_reject`)**
- Host checks in this order: host-muted sender -> `chat_reject 3`; text over 256 UTF-8 bytes (before stripping) ->
  `chat_reject 2`; rate: token bucket, capacity 3, refill 1 per second (= 5 per 5 s, burst of 3); empty bucket -> `chat_reject 1`.
  A reject does not spend a token. Then strip control characters (U+0000-U+001F, U+007F-U+009F) and bidi overrides
  (U+202A-U+202E, U+2066-U+2069); if nothing is left the message is dropped silently. **(decision on empty)**
- Accepted: host assigns `id` = next value of a per-lobby counter starting at 1 (monotonic, never reset by migration if the
  claimant continues from the max id it has seen) and `ts` = host Unix ms, and sends `chat{id, ts, text}` with
  `route = sender` to **every peer including the sender**; the host's own UI receives it too.
- `chat_history`: after `welcome_dc`, last <= 100 lines, oldest first. Lines carry `peerId` of the author.
- Local mute drops the text at the receiver; `hostMute` is host-side state keyed by `peerId`.

## Voice (s.9a)

- Speaker -> host: `voice{seq, flags, packets}` on `voice`, `route 0`. `seq` increments by 1 per packet per speaker (wraps at
  65536). Packets: normally 2 x 20 ms Opus frames (`n = 2`); `n` may be 0..255 in the format, hosts forward whatever is
  valid. `flags` bit0 = end of talk burst.
- Host -> every peer except the speaker: same body, `route = speaker`. The host's own voice goes to everyone. No mixing.
- Host drops silently: frame over **1024 bytes**; more than **30 packets/s** from one peer (sliding 1 s window); a packet from
  a 9th concurrent speaker. A speaker is "active" from its first packet until a packet with `flags` bit0 or 500 ms of
  silence. **(decision on silence)**
- Voice is never in a frame, never hashed.

## Raw mode

`raw{bytes}` on `reliable` (reliable send) or `fast` (unreliable). Joiner -> host with `route = dest` (0 = all others and the host's
app); the host forwards to `dest` (or to everyone except the sender for 0) with `route = source`, on the same channel.
No ticks, no frames, no hashes. `welcome_dc.mode = 2`; no snapshot unless the game supplies one.
