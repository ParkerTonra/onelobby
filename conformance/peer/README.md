# conformance/peer

A scripted fake host / joiner that speaks the `spec/binary.md` protocol to a client library through an **adapter**, and
checks the bytes on the wire and the game-facing events. The game is gridpaint (`spec/demo-game.md`); expected hashes come
from `spec/vectors/gridpaint.json` and the reference implementation.

```
cd conformance && npm install
node peer/run.mjs --mock                              # harness self-test against the built-in reference mock
node peer/run.mjs --adapter=../clients/js/conformance-adapter.mjs     # in-process JS adapter
node peer/run.mjs --stdio="dotnet run --project ../clients/dotnet/Keepalive.Conformance"   # any language
  --only=<text>  --group=joiner,host,migration  --timeout=<ms>
```
Exit 0 green, 1 failures, 2 adapter would not start. Scenarios whose `needs` the adapter does not list in `capabilities` are skipped.

## What the adapter is

The library under test, wrapped so that its three data channels per remote peer go through the harness instead of WebRTC
(use the library's in-memory / custom transport). The adapter hosts **gridpaint** (the demo game from `spec/demo-game.md`):
it implements the game against the library's public API, so the library does the lockstep, chunking, chat and voice.
The harness plays every remote peer. One adapter instance = one session = one library peer; the harness creates a fresh
adapter per scenario (or calls `stop` then `start`).

Time is real time. The harness uses `tickRate 50`. The library must use real timers (no virtual clock needed).

## Contract (operations the harness calls)

JSON-lines over stdio: one JSON object per line. Request `{"id":N,"op":"...", ...args}`, reply
`{"id":N,"ok":true,"result":{...}}` or `{"id":N,"ok":false,"error":"text"}`. In-process JS adapters instead
`export default function createAdapter()` returning `{ call(op, args) -> Promise<result>, set onevent(handler), dispose() }`
with exactly the same ops and event objects. Bytes are lowercase **hex** strings everywhere. Channels: `"reliable"`, `"fast"`, `"voice"`.

| op | args | result / effect |
|---|---|---|
| `init` | | `{name, capabilities}`; capabilities from `host joiner lockstep raw chat voice migration deflate` |
| `start` | `role:"host"\|"joiner", code, peerId, hostId, peers:[ids], tickRate, hashEvery, mode:"lockstep"\|"raw", chunkSize, name` | Create the session. `code` seeds gridpaint. `peers` = the roster the server would have given (used for migration). `chunkSize` = snapshot chunk body size to use when sending (host); honour it so tests get several chunks. Joiner state before welcome_dc = "not started" |
| `link_open` | `peerId` | The data channels to that peer are open. Joiner opening its host link must now send `hi`; host waits for the peer's `hi`. If the library was told to claim/follow (migration) it continues the protocol |
| `link_close` | `peerId` | Channels to that peer closed (host loss triggers migration in a joiner) |
| `recv` | `from, channel, hex` | A frame arrived from that peer on that channel. Must never throw on malformed bytes |
| `begin` | | Host only: start emitting frames (tick 1 next) at `tickRate` |
| `command` | `x, y` | The game issues `paint x y` (3 bytes `01 x y`) |
| `chat_send` | `text` | `lobby.chat.send` |
| `chat_host_mute` | `peerId, muted` | `hostMute` |
| `voice_send` | `frames:[hex], endOfBurst` | Send one voice packet carrying these Opus frames (already encoded; no codec involved) |
| `raw_send` | `to, hex, channel` | raw mode send; `to` 0 = everyone |
| `hash_at` | `tick` | `{hash: "<decimal u64>"|null}`: the game hash at that tick if retained (retain at least the last 600 ticks) |
| `state` | | `{tick, hash, ...}` current game tick and hash (decimal string) |
| `stop` | | tear down |

## Events (adapter -> harness; no `id`)

| event | fields | when |
|---|---|---|
| `send` | `to, channel, hex` | the library transmits a frame to peer `to` |
| `close` | `peerId` | the library closes its connection to that peer (e.g. dropped for `desync`) |
| `dial` | `peerId` | the library wants a connection to that peer (migration); the harness answers with `link_open` |
| `host_changed` | `hostId, epoch` | game-facing HostChanged |
| `desync` | `tick, hostHash, yourHash` | joiner received `desync` |
| `snapshot_restored` | `tick` | joiner finished restoring a snapshot |
| `peer_dropped` | `peerId, reason` | host dropped a peer (`desync`) |
| `chat` | `peerId, id, ts, text` | chat line (host also reports lines it accepted) |
| `chat_history` | `lines:[{peerId,id,ts,text}]` | joiner received history |
| `chat_rejected` | `id, reason` | `chat_reject` received |
| `voice` | `peerId, seq, flags, frames:[hex]` | voice packet arrived (host also reports packets it forwarded) |
| `raw` | `from, channel, hex` | raw payload delivered to the game |

`ts`/ticks are JSON numbers; hashes are decimal strings. The reference is `mock/adapter.mjs` (in-process) and
`mock/stdio-main.mjs` (the same over stdio); `mock/node.mjs` is a small implementation of both roles to read next to `spec/binary.md`.

## Scenarios

joiner: handshake; goldens at ticks 20/100/400; command relay and "state waits for the frame"; gap -> `snapshot_req`;
stale frames ignored; malformed/unknown frames ignored; desync + deflated multi-chunk snapshot; late join with shuffled and
duplicate chunks; a frame sent as chunks; 3 s silence -> `snapshot_req`; ping/pong; chat (history, in, out, reject); voice
(in, out, wrong channel); raw. migration: lowest peerId dials and claims epoch 1 and replays buffered frames to a follower;
non-lowest waits, then epoch/lower-id arbitration. host: handshake order; frame cadence and empty frames; command ordering
(stable by peerId); late-join snapshot and contiguity; desync x2 resynced, 3rd dropped; `snapshot_req`; chat stamping, history,
limits (burst 3, 256 bytes, mute, control chars); voice routing, 1 KiB cap, 30 packets/s, 8 speakers; raw routing; ping.

Not covered (needs real WebRTC): ICE, DTLS, TURN, actual channel options (ordered/maxRetransmits). Check those in the
stream-C and stream-D end-to-end demos.
