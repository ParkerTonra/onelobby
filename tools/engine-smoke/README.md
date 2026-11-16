# engine-smoke

A simulated game per engine client, over every route that client supports. Run it on the final sha before a release.

```
node tools/engine-smoke/run.mjs            # everything: 30 raw cases (about 2 minutes) and 12 lockstep ones
node tools/engine-smoke/run.mjs --cases=js,js+gd+cs --routes=typed,turn --verbose
```

It prints one line per case and ends with `ENGINE_SMOKE_OK` or `ENGINE_SMOKE_FAIL <case:route,...>` (exit 0 / 1).

```
PASS turn   JS host + GDScript + C# joiners    2.5s  TURN: 4 relay allocations, 8 relayed packets
```

## The room scenario

`node tools/engine-smoke/run.mjs --room` (JS, GDScript and C# peers, routes `server` and `typed`, so nine host/joiner pairs on each) runs
the room layer instead of the ping rounds: the host has a password and a 1 s countdown; joiner 1 joins with the password and
data (`color`, `team`), says ready; the host checks the data, starts, the countdown and start reach the joiner, then the host
kicks it with a code and a reason the joiner must read back; joiner 2 uses a wrong password and must be refused with
`bad_password`. The GDScript peer is `clients/gdscript/tests/engine_smoke_peer.gd` with `--scenario=room` (and `--wrongpw`).

## The replication scenario

`node tools/engine-smoke/run.mjs --replication` (JS, GDScript and C# peers, routes `server` and `typed`: every host/joiner pair of the three, nine pairs per route) runs
`ReplicationSession` end to end: the host spawns two entities with a small quantised state, steps them as a function of the host tick (frozen
after tick 60), despawns one at tick 40 and sends the joiner one numbered stream event; the joiner submits one input byte per tick, sends one
event to the host and the raw message `bye`. Both print `REPL spawned=2 despawned=1 entities=1 events=1 hash=<FNV-1a of the final state>`
and `run.mjs` requires the two lines to be equal (the joiner reads the state back through the codec, the host writes it from its own variables).

## The players scenario

`node tools/engine-smoke/run.mjs --players` (JS, GDScript and C# peers, routes `server` and `typed`: every host/joiner pair of the three, nine pairs per route)
runs the networked player layer (`NetPlayers` / `OneLobbyNetPlayers`, `docs/recipes/net-player.md`) between two different engines over a lagging link. `--players=host`
runs the same nine pairs on each route with authority `"host"` (the default, `--players` alone, is authority `"owner"`). Both peers make the layer from the same
settings (3D, range 300, velocity range 32, the 30 Hz session, nothing left out, no limits) and nothing else.

**Fake lag on every peer's link.** Each peer wraps its own transport in the fake network of its client: C# `NetSimTransport`, JS `NetSimLinkFactory`, GDScript
`OneLobbyNetSimTransport` (all three delay, jitter and drop on this peer's sends AND receives; `latency` is half on each, so with both ends wrapped it is
the added one-way time). Flags, with their defaults: `--lag=50` (ms one way), `--jitter=10` (ms: each hop adds up to this, so up to 20 on a link), `--loss=2`
(percent of `fast` frames, each hop: about 4% of the frames of one link; `reliable` frames are only delayed), `--seed=1000` (the host's seed; the joiner's is
one more). Only the data channels are slowed; signaling is not.

**The walk (one rule, written once per language).** The joiner waits until its player is in the world (owner: its own entity is in the snapshot; host: the host's first state
of it has arrived), stands 1.5 s, then walks 6 s (`t` = seconds since the walk start):

- heading `h = 0.75 t` rad, speed 6 m/s: `x = 8 (1 - cos h)`, `z = 8 sin h`, velocity `6 (sin h, cos h)`, yaw `h` in degrees (a circle of 8 m);
- one jump at `t = 2`: `y = 5 s - 7.5 s^2` for `s = t - 2` in `[0, 2/3)`, mode 4 in the air, 1 walking, 0 standing; it stands still from `t = 6`;
- authority `owner`: every loop it gives the layer that state (`setLocalState`). Authority `host`: it gives the input instead: move forward 1 (0 from `t = 6`),
  yaw `h` in degrees, jump pressed for `t` in `[2, 2.1)`; **the step both ends run** (`step(state, input, dt)`): velocity `6 (forward sin yaw + right cos yaw, forward cos yaw - right sin yaw)`
  (right = `moveX`, forward = `moveY`), position += velocity dt; on the ground with jump pressed `vy = 5`; in the air `vy -= 15 dt`, `y += vy dt`, landing at `y <= 0`; yaw = the input's;
  mode 4 in the air, else 1 when moving, else 0;
- `action("jump")` at `t = 2` in both authorities (the one jump each side counts).

After the walk it stands 1 s more, then sends the host its own trace (the layer's local state at every tick of the walk: unix ms, x, y, z) over the lobby as raw
messages (first byte `0x54`, the text `S|t,x,y,z;...` in parts of 20 samples, then `E|<jumps>`). The host records its copy of the joiner (`get(joiner)`, the smoothed state it
would draw) every 20 ms from the start, compares the two paths at the best constant lag (0 to 600 ms in 8 ms steps: the lag where the copy is closest to the joiner on average, which is the render delay plus
the link; the same search as `clients/gdscript/examples/net_player_demo/autotest.gd`) and prints

```
PLAYERS lag=<ms> mean=<m> worst=<m> samples=<n> jumps=<joiner>/<copy>
```

(`samples` = the copy's samples that fall inside the joiner's trace at that lag; `jumps` = the joiner's own jump events / the jump events the host saw for the joiner). `run.mjs` passes a
pair when `mean < 0.15 m`, `worst < 0.45 m` (the D1 bounds of `spec/net-player.md` section 11), `samples >= 100` and `jumps=1/1`, and every peer printed `RESULT PASS`.
The host then tells the joiner it is done and both leave. The two clocks are the same PC's wall clock, so the traces line up in time.

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

Host ports come from slots of 8 just below the system's outgoing-connection range (Linux 32768-60999), each probed (TCP and UDP) before a case
uses it, so a socket left by an earlier peer cannot collide with a host. If a host still fails with `port_in_use`, the run prints
`ss -anp` for those ports (Linux).

Everything binds 127.0.0.1 except the WebRTC ICE sockets of the JS and GDScript peers (their libraries bind every
interface; on Windows that can raise a firewall prompt for node and Godot once). `--loopback` makes the C# peers bind
ICE to 127.0.0.1 as well. The lobby server is started with a dead local STUN entry so nothing leaves the machine.

## The lockstep cases

After the 30 raw cases the run plays the same six engine combinations again in a lockstep lobby (`--sync=lockstep`; `--sync=raw` or
`--sync=lockstep` runs one half), on the `server` and `typed` routes (`--lsroutes=` changes that). Every peer, in its own engine:

1. **Chat.** The host says hello, every joiner answers; each peer must see one line from each of the three players.
2. **Lockstep.** The host calls `start()`; every peer submits 5 commands and applies frames through its own `lockstep` API to a tiny
   sim (FNV-1a 32 over each frame's tick and commands). At tick 60 each peer prints `LOCKSTEP tick=60 hash=... cmds=15`; `run.mjs`
   fails the case unless all three lines are identical (same frames, same hash, all 15 commands).
3. **Shared pause.** The first joiner pauses at tick 20 and resumes 700 ms later; every peer must see both state changes and
   at most 4 frames arrive in between (without the pause 14 would).

## Needs

- Node 24, `cd clients/js && npm ci && npm run build`, `cd conformance && npm install` (for `ws`), `cd tools/engine-smoke && npm ci`
- .NET 8 and 10 SDKs (the peer is net8, the server net10); the libdatachannel native for the C# peer: build it with
  `clients/dotnet/OneLobby.DataChannel/native/build-windows.ps1` (Windows) or `TARGET=linux-x64 build-posix.sh`, which put
  it under `runtimes/` (not committed)
- Godot 4.4+: `GODOT=<path>` (or `--godot=`), and `bash clients/gdscript/fetch-webrtc.sh` then
  `godot --headless --import --path clients/gdscript` once

Flags: `--players[=host]` (with `--lag`, `--jitter`, `--loss`, `--seed`, above), `--engines=js,gd,cs`, `--routes=...`, `--cases=...`, `--repeat=N` (flake hunting), `--timeout=S` (per case, 60),
`--rounds=N`, `--loopback`, `--no-build` (skip the dotnet builds), `--verbose` (all peer output). Last results:
`tools/engine-smoke/.build/last-run.json`.

CI: `.github/workflows/engine-smoke.yml` runs it on every PR and push to main and `ci/**`.

## Findings from the first run (fixed in the commits before this tool, or open)

- A JS Direct host ignored `relayOnly`, and a pinned relay-only link gets no relay candidate under libjuice's UDP mux: fixed
  (`onelobby.ts hostDirectWith`, `direct/index.ts`). C# had the mux half of it: fixed (`DirectHostTransport.Pinned`).
- Open: every C# process (peer or game) that ends with live libdatachannel threads exits with an access violation on Windows
  (exit code 0xC0000005, after a clean `LeaveAsync` and `DisposeAsync`). The library never calls `rtcCleanup()`;
  `--native-cleanup` on the C# peer calls it and the exit code is 0. The smoke reports it as `WARN`, not a failure.
