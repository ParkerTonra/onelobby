# engine-smoke

A simulated game per engine client, over every route that client supports. Run it on the final sha before a release.

```
node tools/engine-smoke/run.mjs            # everything: 30 cases, about 2 minutes
node tools/engine-smoke/run.mjs --cases=js,js+gd+cs --routes=typed,turn --verbose
```

It prints one line per case and ends with `ENGINE_SMOKE_OK` or `ENGINE_SMOKE_FAIL <case:route,...>` (exit 0 / 1).

```
PASS turn   JS host + GDScript + C# joiners    2.5s  TURN: 4 relay allocations, 8 relayed packets
```

## What a case is

One host and two joiners, each its own process, play three rounds on one route: the host sends `ping|r` (reliable) and
`fping|r` (fast, repeated until answered) to everyone, every joiner answers `pong|r` / `fpong|r`; then the host sends
`done`, each joiner says `bye` and leaves, the host leaves. Every peer prints `RESULT PASS ...` or `RESULT FAIL ...`; a
case passes when all three print PASS (and, for `turn`, the TURN server saw relay allocations and relayed packets).

| Engine | Client under test | Peer |
| --- | --- | --- |
| `js` | `clients/js` (built `dist`), node-datachannel for WebRTC | `js-peer.mjs` |
| `gd` | `clients/gdscript` addon in headless Godot, webrtc-native | `clients/gdscript/tests/engine_smoke_peer.gd` |
| `cs` | `OneLobby.Core` + `OneLobby.Direct` over `OneLobby.DataChannel` (libdatachannel): the transport Unity uses | `csharp-peer/` |

Unity itself is not run: there is no headless Unity here, so C# over DataChannel stands in for it. `OneLobby.Godot`
(C# in Godot) is not covered either.

Cases: each engine alone (`js`, `gd`, `cs`: host and both joiners that engine), then each engine as host with the
other two as joiners (`js+gd+cs` = a JS host with a GDScript and a C# joiner, which also exercises the JS host's
re-offer after a link dies before it opens). `--cases=js,gd+cs` picks cases: `host` alone, or `host+joinerA[+joinerB]`
(one joiner engine means two joiners of it).

| Route | How the joiners find the host |
| --- | --- |
| `server` | lobby server, `--listen 127.0.0.1:<port>`, join by its 6-character code |
| `nostr` | Direct (no server), signaling over a local Nostr test relay (`integration/nostr-test-relay.mjs`), Nostr code |
| `typed` | Direct, `127.0.0.1:<port>` typed as the address |
| `ipcode` | Direct, the host's IP join code (`127.0.0.1` inside) |
| `turn` | Direct over the Nostr relay, relay-only, TURN entry pasted as one line |

`turn`: a local TURN server (`turn-server.mjs`: npm `node-turn` on 127.0.0.1, a fresh random user and password each
run, nothing real) gives the line `turn:127.0.0.1:<port> <user> <password>`. Every peer feeds it through its client's own
paste parser (JS `parseTurnLine`, C# `TurnLogin.Parse`, GDScript `OneLobbyTurn.parse_line`) into `iceServers` and turns
`relayOnly` on; the case fails unless the TURN server saw allocations and relayed packets. node-turn needed three
fixes to talk to libjuice (see `turn-server.mjs`: sign ChannelBind replies, relay ChannelData from clients, do not
kill an allocation on a Refresh without LIFETIME). They are in the test server only.

Everything binds 127.0.0.1 except the WebRTC ICE sockets of the JS and GDScript peers (their libraries bind every
interface; on Windows that can raise a firewall prompt for node and Godot once). `--loopback` makes the C# peers bind
ICE to 127.0.0.1 as well. The lobby server is started with a dead local STUN entry so nothing leaves the machine.

## Needs

- Node 24, `cd clients/js && npm ci && npm run build`, `cd conformance && npm install` (for `ws`), `cd tools/engine-smoke && npm ci`
- .NET 8 and 10 SDKs (the peer is net8, the server net10); the libdatachannel native for the C# peer: build it with
  `clients/dotnet/OneLobby.DataChannel/native/build-windows.ps1` (Windows) or `TARGET=linux-x64 build-posix.sh`, which put
  it under `runtimes/` (not committed)
- Godot 4.4+: `GODOT=<path>` (or `--godot=`), and `bash clients/gdscript/fetch-webrtc.sh` then
  `godot --headless --import --path clients/gdscript` once

Flags: `--engines=js,gd,cs`, `--routes=...`, `--cases=...`, `--repeat=N` (flake hunting), `--timeout=S` (per case, 60),
`--rounds=N`, `--loopback`, `--no-build` (skip the dotnet builds), `--verbose` (all peer output). Last results:
`tools/engine-smoke/.build/last-run.json`.

CI: `.github/workflows/engine-smoke.yml` runs it on every PR and push to main and `ci/**`.

## Findings from the first run (fixed in the commits before this tool, or open)

- A JS Direct host ignored `relayOnly`, and a pinned relay-only link gets no relay candidate under libjuice's UDP mux: fixed
  (`onelobby.ts hostDirectWith`, `direct/index.ts`). C# had the mux half of it: fixed (`DirectHostTransport.Pinned`).
- Open: every C# process (peer or game) that ends with live libdatachannel threads exits with an access violation on Windows
  (exit code 0xC0000005, after a clean `LeaveAsync` and `DisposeAsync`). The library never calls `rtcCleanup()`;
  `--native-cleanup` on the C# peer calls it and the exit code is 0. The smoke reports it as `WARN`, not a failure.
