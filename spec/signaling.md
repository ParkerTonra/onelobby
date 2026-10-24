# Signaling: behavioural rules (companion to `signaling.schema.json`)

`signaling.schema.json` says what each message looks like. DESIGN s.6, s.7, s.9 and s.12 say what the server does but
leave gaps. This file closes the gaps with one reading each; `conformance/server` tests exactly this reading. Where a
line says **(decision)** it goes beyond DESIGN.md and stream E reports it to the desk.

## Connection

- One WebSocket, text frames, one JSON object per frame. Binary frames: ignored.
- Frame size limit is `limits.maxMsg` from `welcome` (default **16384** bytes, DESIGN s.7). A longer frame makes the
  server close the socket (WS close code 1009, or any close). **(decision)** DESIGN s.12 says 4 KiB; that is not
  enforceable because an SDP offer for three data channels with candidates can pass 4 KiB. `maxMsg` tells clients.
- Invalid JSON, a non-object, or a missing/non-string `t`: `error{bad_request}`, socket stays open.
- Unknown `t`: ignored, no reply. Unknown fields: ignored.
- The first message must be `hello`. Anything else before it: `error{bad_request}`. A second `hello`: `error{bad_request}`.
- `hello.proto` other than `"lk1"`: `error{bad_request, data:{supported:["lk1"]}}`, then close.
- `hello` reply: `welcome` (always). With a valid `resumeToken` see Resume.
- `ping{n}` is answered with `pong{n}` at any time after `hello`. A socket silent for 30 s is closed by the server;
  clients ping every 10 s.
- A socket is in at most one lobby. `create`/`join` while already in one: `error{bad_request}`.

## Names, sanitising

- `hello.name`: control characters (U+0000-U+001F, U+007F-U+009F) and bidi overrides (U+202A-U+202E, U+2066-U+2069)
  removed, then truncated to 24 characters (not rejected). **(decision)**
- `create.name` (lobby name): same, truncated to 48. **(decision)**
- `meta`: not sanitised; more than 16 keys or a key/value over 64 characters, or a non-string value: `bad_request`.

## Lobbies

- `create` fields: `maxPlayers` 2..`limits.maxPlayers` (welcome says 64 by default, hard cap 250), `tickRate` 1..255,
  `visibility`, `mode`, `lateJoin` boolean, `meta`. Anything out of range or mistyped: `bad_request` (data `{field}`).
  `relayOnly` is an additive optional boolean. **(decision)**
- Reply `lobby`: `you = hostId = 1`, `peers` = just the creator, a canonical code (spec/codes.json), a non-empty
  `resumeToken`, `phase:"lobby"`.
- `peerId`s: host 1, then 2, 3, ... in join order. Never reused inside a lobby, even after the peer leaves. A resumed peer
  keeps its id.
- `join{code}`. The server normalises the code (codes.json). Checks in this order:
  1. not a valid code after normalising: `bad_request`
  2. no live lobby with that code and this hello's `gameId`: `unknown_code` (a lobby of another `gameId` is
     indistinguishable from a missing one) **(decision)**
  3. lobby `netVersion` differs: `version_mismatch`, `data:{hostNetVersion, yourNetVersion}`
  4. the peer was kicked from this lobby earlier: `kicked`
  5. `phase:"in_game"` and `lateJoin` false: `in_game`
  6. full: `lobby_full`
  7. `private`: nothing is sent to the joiner yet; the host gets `join_request{peer:{peerId,name}}` (the peerId is
     already assigned). `approve{peerId, ok:true}`: joiner gets `lobby`, everyone else `peer_joined`. `ok:false`: joiner
     gets `error{kicked, data:{reason:"denied"}}` **(decision)**.
  8. otherwise joiner gets `lobby`, everyone already in gets `peer_joined{peer}`.
- The `lobby` message is the full state. It is also re-sent to **every member** (with that member's own `you`) after the
  host changes `meta` or `phase` **(decision)** so roster, phase and metadata stay in sync with no extra message type.
- `leave`: no reply to the leaver. Others get `peer_left{peerId, reason:"left"}`. If the host left and others remain, the
  new host is the lowest remaining `peerId` and everyone remaining gets `host_changed{hostId, epoch}` right after
  `peer_left` (epoch +1). When the last peer leaves the lobby is closed and its code is retired for 24 h.
- Socket closes without `leave`: others get `peer_left{reason:"timeout"}` immediately (and `host_changed` if it was the
  host) **(decision)**; the peer's slot and token stay reserved for 60 s (Resume). Lobby closes when no peer is connected
  and no slot is reserved.
- Host-only messages from a non-host: `error{not_host}`. `kick` of self, of a non-member, or `approve` for a peer that is
  not pending: `bad_request`.
- `kick{peerId}`: the kicked peer gets `error{kicked}` and is removed (its socket stays open, hello state kept); all
  others (host included) get `peer_left{peerId, reason:"kicked"}`. It cannot rejoin that lobby (`join` -> `kicked`).
- `c_host_changed{hostId, epoch}` (client -> server): the peer-side migration (s.9) tells the server. Accepted if the
  sender's own peerId equals `hostId`, `epoch` is greater than the lobby epoch (0 at creation), the sender is a member.
  The server updates the host and broadcasts `host_changed{hostId, epoch}` to all members (sender included).
  Otherwise ignored, no reply. **(decision)**

## Path telemetry

`path{path:"relayed"|"direct"}` (client -> server, DESIGN s.10): sent once after ICE completes for a peer connection. No
reply, never an error for a valid value; the server counts relayed vs direct. A bad `path` value: `bad_request`.
**(decision)**

## Resume

`hello{resumeToken}` where the token was issued in a `lobby` message, within 60 s of the socket dropping and the lobby still
alive: `welcome{peerId}` (peerId present only here), then `lobby` with the same `you` and current state; the others get
`peer_joined`. A resumed peer is never host again unless it is still the host in the lobby state (it is not, if it
dropped as host; migration already moved on). An unknown or expired token is ignored: plain `welcome` without `peerId`.
A token is single-use for resuming; a fresh `lobby` message carries the new token.

## List

`list{visibility:"public", meta?, limit?, cursor?}`. Reply `lobbies{items, cursor?}`.
- Only lobbies with the same `gameId` and `netVersion` as this hello, `visibility:"public"`, and `phase:"lobby"` (or
  `lateJoin` true), not full-and-closed (full lobbies are still listed).
- `meta` filter: every given key must equal the lobby's value.
- `limit` 1..100, default 50; outside that range: `bad_request`. **(decision)** `cursor` is an opaque string from the
  previous reply; missing `cursor` in the reply means the end. Order: `createdAt` ascending, then code.
- `visibility` other than `"public"`: `bad_request`.
- Entry fields: schema `lobbyEntry`. `players` counts connected + reserved peers. `region` is the server's own tag.

## Signal

`signal{to, sdp?|ice?}` is forwarded to `to` as `signal{from, sdp?, ice?}`, `from` stamped by the server (a client-supplied
`from` is ignored), `sdp`/`ice` forwarded verbatim. `to` must be a connected member of the sender's lobby, not the sender:
else `bad_request`. A signal with neither `sdp` nor `ice`: `bad_request`. Not in a lobby: `bad_request`.

## Rate limits (DESIGN s.12) and error data

| Limit | Default | Error |
|---|---|---|
| `create` per IP | 10 per minute | `rate_limited` |
| `join` per IP (every attempt counts) | 60 per minute | `rate_limited` |
| `signal` per peer | 20 per second | `rate_limited` |
| open lobbies per IP | 8 | `rate_limited`, `data:{reason:"max_lobbies"}` **(decision)** |

`rate_limited` carries `data:{retryAfterMs}`. A rate-limited message is not processed. `server_full` is returned for
`create` and `join` when the global `maxLobbies` / `maxPeers` is reached. `game_not_allowed`: reply to `hello` when the
server has an `allowedGameIds` list and the id is not on it; the server then closes the socket.

**Test mode (decision).** The per-IP limits make a full functional run impossible from one IP, so a server must offer a
way to scale them (stream A: env `KEEPALIVE_RATE_SCALE`, default 1; conformance functional suite is run with 20, the
`--ratelimit` suite with 1 on a fresh server). `conformance/server/README.md` has the exact invocations.

## Error `data` summary

| code | data |
|---|---|
| `version_mismatch` | `{hostNetVersion, yourNetVersion}` |
| `rate_limited` | `{retryAfterMs, reason?}` |
| `kicked` | `{reason?:"denied"}` |
| `bad_request` | `{field?}` or `{supported}` for a bad proto |
