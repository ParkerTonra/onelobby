# Diagnostics (`diag` v1): tell the player why a connection failed

Most games hide a failed connection behind "Failed to connect". OneLobby has the facts at every step, so it shows them:
a plain cause and one next step on the failing player's own screen, the same cause as a short line on the screen of the
host the player dialed, a log the player can copy, and a connection check a menu can run before playing. This file is
the contract; JS implements it in 0.7.2. C# and GDScript must match it and `spec/vectors/diagnostics.json` exactly.
Words in **(decision)** go beyond what the design plan (`docs/design/one-shot.md` s.4) fixed.

Contents: 1 privacy, 2 facts and `diagnose`, 3 causes, 4 texts, 5 net log, 6 masking, 7 report to the host, 8 connection
check, 9 how errors carry the cause, 10 platform notes, 11 constants.

## 1. Privacy (hard rules)

1. **Nothing goes to OneLobby or any third party.** The log stays on the player's machine. The only thing that ever
   leaves is the report (7), and only to the host the player dialed, over the signaling path that player already used.
2. **No address, credential or password in the report.** Its fields are fixed and typed (7.1); there is no free text.
   A hub and a host rebuild the report from the known fields and drop everything else.
3. **The exported log is masked by default** (6). `includeAddresses` unmasks IPv4, IPv6 and mDNS names only; TURN
   usernames and credentials, ICE `ufrag`/`pwd` and join passwords are never printed, with or without the switch, and
   the log never stores them in the first place (the masker is a backstop).
4. **The connection check contacts only** the STUN servers the client already uses to connect (or the ones the game
   passes) and the TURN server the player configured. Nothing else.

## 2. Facts and `diagnose`

`diagnose(facts) -> { cause, message, hint, stage }` is a pure function: the same facts give the same output in every
client (`vectors.diagnose`). A client collects the facts as it connects (sources per platform: 10).

```
facts = {
  side:    "joiner" | "host"                 whose view this is
  route:   "server" | "ip" | "nostr"         how the player dialed: lobby server code, typed IP / IP code, Nostr code
  error:   string | null                     the error code that ended the attempt (`ice_failed`, `timeout`,
                                             `version_mismatch`, `connect_failed`, `direct_unreachable`, `no_server`,
                                             `server_closed`, `closed`), null when none
  reached: "none" | "signaling" | "joined" | "offer" | "ice" | "channels"
  elapsedMs: int                             since the attempt began
  versions: { mine, theirs } | null          the two game versions, when a mismatch told them
  relaysUp: bool | null                      route nostr: at least one Nostr relay connected; null otherwise or unknown
  stun:    bool                              a `stun:` or `stuns:` server was in this link's ICE list
  relay:   "none" | "pending" | "ok" | "refused" | "unreachable" | "failed"
  local:   [ "host" | "srflx" | "relay" ]    candidate types this side sent (unique, sorted)
  remote:  [ ... ]                           candidate types this side received
  retried: bool                              the relay-only retry ran
  nat:     "unknown" | "open" | "cone" | "symmetric" | "blocked"   connection check result when known (8)
  heard:   bool | null                       host side: any ICE traffic from this joiner reached the listener (10)
}
```

- `reached`: `none` nothing yet (no socket); `signaling` a socket to the lobby server, host address or Nostr room is
  open; `joined` the lobby accepted the player (`lobby` message) but no link negotiation happened; `offer` an offer
  and answer were exchanged (negotiation began), no candidate pair was ever selected; `ice` a candidate pair was
  selected (ICE connected) but the data channels did not open; `channels` all channels are open but the host never
  answered `hi`.
- `relay` describes the allocation on this link's TURN entry, `none` when no TURN entry is in the ICE list. `ok` a
  relay candidate was gathered; `refused` the TURN server answered and rejected the login (401/403/437/441, or the
  browser's `icecandidateerror` 401 / 403); `unreachable` it never answered (no reply, browser error 701);
  `failed` gathering finished without a relay candidate and the client cannot tell which of the two it was (the honest
  fallback: 10); `pending` gathering is not finished.
- Candidate types come from the signaling traffic: parse `typ host|srflx|relay` out of every candidate line this side
  sent and received (`ice` signals, whose text may start with `a=` or not, and `a=candidate:` lines in SDP). `prflx` is
  counted as `srflx`.

**Stage** (the step that failed, `stage`), from `reached`:

| reached | stage |
|---|---|
| `none` | `signaling` |
| `signaling` | `join` |
| `joined` | `offer` |
| `offer` | `ice` |
| `ice` | `channels` |
| `channels` | `handshake` |

**Rules**, first match wins. `T` is the cause, and its sentence is built by 4.

1. `error` is `version_mismatch`: `version_mismatch`.
2. `reached` is `none` or `signaling`, and `error` is `direct_unreachable`, `connect_failed`, `no_server`,
   `server_closed` or `closed`:
   `route` `server`: `signaling_unreachable`. `route` `nostr`: `signaling_unreachable` when `relaysUp` is `false`, else
   `host_unreachable`. `route` `ip`: `host_unreachable`.
3. `error` is `ice_failed` or `timeout` (the negotiation did not finish). Let `negotiated` = `reached` is `offer`.
   1. `relay` is `refused`: `relay_refused`. `relay` is `unreachable` or `failed`: `relay_unreachable`.
   2. `negotiated`, `relay` is `none`, `nat` is `blocked`: `udp_blocked`.
   3. `negotiated`, `relay` is `none`, `stun` is true, `local` is not empty and has no `srflx`: `udp_blocked` (this
      client gathered candidates, asked a STUN server, and nothing came back; with no candidates at all it cannot tell).
   4. `negotiated`, `relay` is `none`, `nat` is `symmetric`: `nat_blocked`.
   5. `side` `host`, `negotiated`, `relay` is `none`, `heard` is `false`: `firewall`.
   6. `side` `joiner`, `negotiated`, `relay` is `none`, `local` and `remote` both non-empty: `nat_blocked`.
4. Anything else: `timeout_unknown`.

**Honest limits (decision).** Without a connection check a client cannot tell `udp_blocked` from `nat_blocked` when it
used no STUN server (rule 3.3 needs `stun`), so a link that had no STUN answers `nat_blocked` whenever candidates went
both ways and nothing connected; the extra fact that separates them is the connection check's `nat` (`blocked` vs
`symmetric`). A host cannot tell `firewall` from a joiner-side NAT problem unless `heard` is known; with `heard` null the
host side answers `timeout_unknown` (rule 3.6 is joiner-only); the host normally shows the joiner's own report instead. Browsers cannot tell
`refused` from `unreachable` for a TURN server on old stacks: `failed` then stands for both and the sentence for
`relay_unreachable` names both possibilities (4).

## 3. Causes

A stable table. `code` never changes once released; a client that meets an unknown code (a newer host's report) shows
the `timeout_unknown` text.

| code | facts that select it | host-side meaning |
|---|---|---|
| `nat_blocked` | negotiation began, no relay set, candidates both ways, no pair (strict or symmetric NAT) | the player's NAT blocks direct links |
| `relay_refused` | a relay was set and its login was rejected | the player's relay line is wrong or expired |
| `relay_unreachable` | a relay was set and never answered (or the client cannot tell why it failed) | the relay is down or blocked |
| `udp_blocked` | no relay, and no reflexive candidate came back from STUN, or the check said `blocked` | the player's network blocks UDP |
| `firewall` | host side: negotiation began and nothing from the joiner ever reached the listener | the host's firewall blocks the game |
| `version_mismatch` | the hub refused the join for a different `netVersion` | the two game versions differ |
| `host_unreachable` | the typed IP / port or code did not answer | the host is offline or the code is stale |
| `signaling_unreachable` | no lobby server, or no Nostr relay, could be reached | the player is offline or the service is down |
| `timeout_unknown` | fallback: none of the above, still says how far it got | unknown; the log has the details |

## 4. Texts

Each cause has: `message` (what happened, one sentence), `hint` (the one concrete next step, for the failing player),
`hostHint` (the same for the host), `short` (a third-person fragment for the host's line). Placeholders in `{braces}`.
Exact strings are in `vectors.causes`; a client copies them, it does not reword them.

| code | message | hint | short |
|---|---|---|---|
| `nat_blocked` | Your network blocks direct connections (strict NAT) and no relay is set. | Paste a relay line in the game's settings, ask the host for one, or try another network such as a phone hotspot. | strict NAT, no relay set |
| `relay_refused` | The relay rejected the login. | Check the relay line in the settings; it may have been typed wrong or expired. | the relay rejected the login |
| `relay_unreachable` | The relay could not be used: it did not answer. | Check the relay line for typos and that the relay is online; some networks block relays. | the relay did not answer |
| `udp_blocked` | Your network blocks UDP, the kind of traffic games use to connect. | Try another network, such as a phone hotspot, or a relay that can be reached from this network. | UDP blocked |
| `firewall` | A firewall may be blocking the game on the host's computer: nothing from the player ever reached it. | Allow the game in the firewall (on Windows, tick Private networks when asked), then try again. | nothing reached the host (firewall?) |
| `version_mismatch` | You have version {mine}, the host has {theirs}. | Update the game on the older side, then try again. | different game version |
| `host_unreachable` | The host did not answer. | Check the code or address, and that the host is online with the game open. | the host did not answer |
| `signaling_unreachable` | Could not reach the lobby server or any relay that introduces players. | Check your internet connection; if it works elsewhere, try again in a few minutes. | no lobby server or relay reachable |
| `timeout_unknown` | The connection did not finish. It stopped at {stage_text} after {elapsed}. | Try again. If it keeps happening, copy the log and send it to the host. | unknown cause |

- `version_mismatch` without both versions (a report carries none): the message is `You and the host have different
  versions of the game.`
- `stage_text` by stage: `signaling` reaching the lobby; `join` joining the lobby; `offer` waiting for the host to start
  the connection; `ice` the connection check; `channels` opening the game connection; `handshake` the final hello with the
  host.
- `elapsed`: `under 1 s` below 1000 ms, else the seconds rounded to nearest (halves up), then ` s` (`15 s`).
- **Host line:** `{name}: {short}, stopped at {stage_text} after {elapsed}.` (`Sam: strict NAT, no relay set, stopped at
  the connection check after 15 s.`). `name` is the roster name the host already shows for that player.
- `hostHint` strings and the full table of exact text are in the vectors.

## 5. Net log

A ring buffer of connection steps; default capacity 500 entries (a game may set 50 to 5000). When full, the oldest
entry is dropped; `seq` keeps counting, so a reader sees how many were dropped.

```
Entry { seq: int (from 1, never reused), t: int (ms, monotonic, since the log was created), kind, text, addr?, code? }
```

- `t` comes from a monotonic clock, never the wall clock.
- `text` is at most 200 characters (longer is cut) and holds no address, credential or password; an address that belongs
  to the step goes in `addr` (kept in memory only so that `includeAddresses` can print it).
- `kind` is one of: `sig` signaling open/close, hello, welcome, join, leave; `lobby` roster and host changes; `sdp` an
  offer or answer sent or received; `cand` a candidate type sent or received; `ice` ICE gathering and connection state
  changes; `chan` channel open and close; `route` the chosen route (`direct`, `relay`); `retry` a retry (the relay-only
  redial); `error` an error with its code (`code` set); `diag` a diagnosis made, a report sent or received; `info`
  anything else (the client, protocol and platform lines at start, ICE server kinds, version pair).
- What a client SHOULD record: signaling open and close; hello and welcome (feature names); the lobby join; every
  offer and answer; candidate types only (`cand out srflx`, `cand in relay`); ICE and channel state changes; the chosen
  route; retries; every error with its code; the diagnosis; client version, protocol (`lk1`) and platform string.

**Export** (`netLog.export({ includeAddresses })`): LF line endings, UTF-8, header then one line per entry, oldest first.

```
# onelobby netlog v1
# client onelobby-js 0.7.2 protocol lk1 platform node
# entries 4 dropped 0
# addresses masked
#1 +0ms info client onelobby-js 0.7.2
#2 +12ms sig open route=server
#3 +40ms cand out srflx
#4 +15012ms error ice_failed
```

- Header line 3: `# entries <kept> dropped <dropped>`; line 4: `# addresses masked` or `# addresses included`.
- Entry line: `#<seq> +<t>ms <kind> <text>`, then ` addr=<addr>` only when `includeAddresses` and `addr` is set.
- Every entry line goes through the masker (6) before printing, whatever the switch says about addresses. The three
  header lines are not masked (they hold no address; a four-part version string would otherwise look like one).

**Persistence (decision).** Where a client has a file system and a log path is configured, the buffer is written to that
path (the export, masked, plus nothing else) when the process exits normally, and when it dies from an uncaught error,
and on demand (`save`). Where there is no file system (browsers) the buffer lives in memory, and a `pagehide`
handler stores the entries in session storage so a reload can still export the last session's log. Writing the log
never changes how a crash behaves (a handler observes the error, it does not swallow it).

## 6. Masking

`mask(text, includeAddresses)` applies, in this order, to a line of text:

1. **Credentials, always:**
   - `username=`, `credential=`, `password=`, `pwd=`, `token=`, `secret=` (also `"key":"value"` JSON form for those
     names): the value, up to the next whitespace, comma, `"` or end, becomes `<hidden>`.
   - `a=ice-ufrag:` and `a=ice-pwd:` values become `<hidden>`.
   - A TURN line `turn:` or `turns:` URL followed by two more whitespace-separated words (the paste format
     `url user credential`): the two words become `<hidden> <hidden>`.
2. **Addresses, unless `includeAddresses`:**
   - IPv6: a bracketed `[...]` form, with an optional `:port`, or a bare run of 2 to 8 groups of 0-4 hex digits
     separated by `:` that contains `::` or has exactly 8 groups; becomes `<ip6>`. (`12:30:45` is a time, not an
     address.)
   - mDNS names `<hex and dashes>.local`, such as `8f1c9a2e-52d0-4b0e-9a55-2c7b1fd7a1b0.local`: `<mdns>`.
   - IPv4 `a.b.c.d` (each part 0-255), with an optional `:port`: `<ip4>`.
3. An address already inside a masked span is not matched twice.

Vectors: `vectors.mask` (input, expected masked, expected with addresses).

## 7. Report to the host

When a joiner's link to the host fails, the signaling path still works (the lobby server's WebSocket, the Direct hub's
WebSocket, or the Nostr room). The joiner uses it to tell the host what went wrong, once, before it leaves.

### 7.1 The report

```
report = { cause, stage, elapsedMs, relaySet, natType?, candidateTypes: { local, remote }, clientVersion }
```

| field | type |
|---|---|
| `cause` | `^[a-z][a-z0-9_]{0,31}$` (a known cause code; a host shows unknown ones as `timeout_unknown`) |
| `stage` | `^[a-z][a-z0-9_]{0,31}$` |
| `elapsedMs` | integer 0 to 3600000 |
| `relaySet` | boolean: a relay was in the joiner's ICE list |
| `natType` | optional: `open`, `cone`, `symmetric` or `blocked`, the joiner's connection check result if it ran one |
| `candidateTypes` | `{ local: [..], remote: [..] }`, each at most 3 unique values from `host`, `srflx`, `relay` |
| `clientVersion` | `^[A-Za-z0-9._+-]{1,32}$`, the client library's version |

No other field is allowed. There is no address, name, text or credential anywhere in it. `vectors.report` has valid and
invalid reports.

### 7.2 Messages (signaling `lk1`, additive)

- Joiner to hub: `{ "t": "diag", "report": { ... } }`. The hub rebuilds the report from the known fields (anything
  else is dropped), and forwards to the lobby's **host only**: `{ "t": "diag", "from": <peerId>, "report": { ... } }` with
  `from` stamped by the hub (a client-supplied `from` is ignored). It sends no reply on success.
- Errors: not in a lobby (pending approval counts as not in), or the sender is the host: `bad_request` (field `report`);
  the frame over 1024 bytes, a missing or invalid `report`: `bad_request` (field `report`); more than 3 reports per
  60 s from one peer: `rate_limited{retryAfterMs}`, nothing forwarded. The limit is checked before the forward.
- **Capability:** a hub that handles `diag` lists `"diag"` in `welcome.features`. A client sends nothing to a hub
  without it (an old hub ignores the unknown type, so the report would only be lost). A host that does not know `diag`
  ignores the forwarded message (unknown `t`, `signaling.md`).
- The three signaling paths carry it unchanged: the lobby server, a Direct hub over its WebSocket, and a Nostr room
  (the Direct hub behind the Nostr socket carries the same `lk1` texts; nothing Nostr-specific).
- The joiner sends it right before its `leave` when it gives up, and only when `diagnostics.reportToHost` is on
  (default on). The host also ignores a report from a peer id that is not in its roster, and keeps at most one report
  per peer per 10 s.

### 7.3 What the host gets

An event `peerDiagnosis` with: the peer, its roster `name`, `cause`, `stage`, `elapsedMs`, `relaySet`, `natType`,
`candidateTypes`, `clientVersion`, the **same `message`** the joiner saw (built from `cause`, `stage` and `elapsedMs` by 4),
the `hostHint`, and the one-line `line` (the host line, 4). The host's log also gets a `diag` entry.

## 8. Connection check

`checkConnection(options?) -> CheckResult`:

```
CheckResult = { udp: "ok" | "blocked" | "unknown", natType: "open" | "cone" | "symmetric" | "unknown",
                relay: "ok" | "refused" | "unreachable" | "unknown" | "none", verdict, message }
```

When it runs is the game's or menu's choice: the library only exposes the call and never runs it on its own. Defaults:
STUN servers = the ones the client already uses to connect (`stun:stun.l.google.com:19302`,
`stun:stun.cloudflare.com:3478`); the TURN entry = the player's configured relay; both can be passed in. Nothing else is
contacted.

**Measuring `udp` and `natType`** (at least two STUN servers; one answer is enough for `udp`):

- *Preferred, where a client can open its own UDP socket (Node, Godot `PacketPeerUDP`, .NET `UdpClient`):* bind one UDP
  socket, send an RFC 5389 Binding Request to each STUN server from that same socket (transaction id: 12 random bytes;
  retransmit once after 500 ms; 1500 ms per server), and read `XOR-MAPPED-ADDRESS` (`0x0020`, else `MAPPED-ADDRESS`
  `0x0001`) from each answer. `vectors.stun` pins the request and response bytes.
- *Browsers:* one `RTCPeerConnection` with both STUN servers; collect the `srflx` candidates until gathering ends. Two
  servers that see the same mapped port give one `srflx` candidate (the browser merges them): `cone`. Two `srflx`
  candidates with different ports: `symmetric`. No `srflx` at all: `blocked`. A browser cannot see its own address
  (mDNS), so it never reports `open`.
- Classification (`vectors.classify`): no answer from any server: `udp` `blocked`, `natType` `unknown`. One answer:
  `udp` `ok`, `natType` `unknown`. Two or more answers: any difference in port or address: `symmetric`; all the same, and
  equal to the socket's own local address and port: `open`; all the same: `cone`. `udp` `unknown` is for a client that
  could not run the test at all (no socket API).
- "No server answered" cannot tell UDP blocked from STUN servers being down; the message says "or the test servers could
  not be reached" and the check is best read with two independent servers.

**Measuring `relay`:** no TURN entry: `none`. With one:

- *Raw UDP:* a TURN `Allocate` (RFC 5766): send it without credentials, expect `401` with `REALM` and `NONCE`, send it
  again with `USERNAME`, `REALM`, `NONCE` and `MESSAGE-INTEGRITY` (HMAC-SHA1 keyed by `MD5(username:realm:credential)`).
  A success response (`0x0103`) is `ok`. An error response (`401` again, `403`, `438`, `441`) is `refused`. No answer
  within 1500 ms is `unreachable`. A `turns:` URL or a TCP transport cannot be tested this way: `unknown`.
- *Browsers:* a relay candidate appears with the configured TURN: `ok`; `icecandidateerror` 401 or 403: `refused`; 701 or
  no candidate in 4 s: `unreachable`.

**Verdict** from `{udp, natType, relay}` (`vectors.check`), first match wins:

| conditions | verdict | message |
|---|---|---|
| `relay` `refused` | `relay_refused` | The relay rejected the login. Check the relay line; it may have expired. |
| `relay` `unreachable` | `relay_unreachable` | The relay did not answer. Check the relay line and your network. |
| `udp` `blocked`, `relay` `ok` | `relay_works` | Direct connections will fail, but your relay works. |
| `udp` `blocked` | `blocked` | Direct connections: will fail. Your network blocks UDP (or the test servers could not be reached). A relay or another network is needed. |
| `natType` `symmetric`, `relay` `ok` | `relay_works` | Direct connections may fail, but your relay works. |
| `natType` `symmetric` | `likely_fail` | Direct connections: likely to fail. A relay is recommended. |
| `natType` `open` or `cone` | `good` | Direct connections: likely to work. |
| otherwise | `unknown` | Could not tell how your network handles direct connections. |

The result's `natType` and `udp` feed the next `diagnose` as `nat` (`blocked` when `udp` is `blocked`, else `natType`).
A report carries it as `natType`.

## 9. How errors carry the cause

A new error **code** is not added for causes. The existing codes (`ice_failed`, `timeout`, `version_mismatch`,
`connect_failed`, `direct_unreachable`, `server_closed`, `closed`) stay what they are; the failure also carries the
diagnosis as data (`no_server` keeps its own exact text: "this game has no lobby server address yet" is already the
cause):
`{ cause, message, hint, stage }`. JS: `OneLobbyError.diagnosis`; `describeError(err)` then returns the diagnosis'
`message` and `hint` (and `cause`, `stage`) instead of the generic text for that code. A game that ignores diagnostics
behaves as before apart from better error text.

## 10. Platform notes (where the facts come from)

| fact | JS (browser) | JS (Node, libdatachannel) | C# / GDScript (libdatachannel) |
|---|---|---|---|
| candidate types | from signaling text | same | same |
| `relay` | relay candidate seen: `ok`; `icecandidateerror` 401/403: `refused`, 701: `unreachable`; gathering done and none: `failed` | relay candidate seen: `ok`; gathering done (`failed`) or still going (`pending`) at the deadline with none: a raw TURN probe says `refused` / `unreachable` (else `failed` / `pending`) | same as Node; a raw probe over a UDP socket |
| `stun` | the ICE list | same | same |
| `heard` | candidate-pair stats `requestsReceived` | not exposed: null | not exposed: null |
| `nat` | connection check | connection check | connection check |
| `reached` `ice` | `connectionState` `connected` | same | the native ICE state |

Browsers cannot see their own addresses (mDNS), so `open` is never reported there, and `heard` and the exact `refused` /
`unreachable` split depend on the browser's stats and `icecandidateerror`. A client that cannot measure a fact reports
its unknown value (`relay` `failed`, `heard` null, `nat` `unknown`) and the rules above fall back as written.

## 11. Constants

| name | value |
|---|---|
| log capacity default / min / max | 500 / 50 / 5000 |
| entry text limit | 200 characters |
| report frame limit | 1024 bytes |
| reports per peer at a hub | 3 per 60 s |
| host keeps per peer | 1 per 10 s |
| check: per STUN server | 1500 ms (one retransmit at 500 ms) |
| check: TURN probe | 1500 ms |
| check: whole | 8000 ms |
