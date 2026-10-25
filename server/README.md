# onelobby-server

Lobby and signaling server for OneLobby (protocol `lk1`, DESIGN.md s.6-s.7, s.9-s.10, s.12-s.13; behavioural rules in
`spec/signaling.md`). .NET 10, ASP.NET Core minimal app, one WebSocket endpoint. It never sees game traffic: peers talk over
WebRTC data channels once the handshake is done.

| Path | What |
|---|---|
| `/ws` and `/` | WebSocket upgrade, text frames, one JSON object per frame (so `ws://host:8080` works without a path). A plain `GET /` returns a one-line text hint |
| `/healthz` | `200 ok` |
| `/metrics` | Prometheus text: `onelobby_lobbies`, `onelobby_sockets`, `onelobby_path_total{path="relayed\|direct"}`, `onelobby_messages_total{type}`, `onelobby_errors_total{code}`, `onelobby_rate_limit_hits_total{kind}`, ... |

## Run

```
dotnet run --project OneLobby.Server -- --listen :8080
# or the single-file build
dotnet publish OneLobby.Server -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -o publish
./publish/onelobby-server --listen :8080 --turn-urls turn:relay.example:3478,turns:relay.example:443 --turn-secret ...
```

Other runtimes: `linux-x64`, `linux-arm64`, `osx-arm64`. Docker: `docker build -t onelobby-server .` in this directory
(the deploy stack in `../deploy` runs the image with the flags below).

## Flags and environment

A flag wins over its `ONELOBBY_*` environment variable.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--listen` | `ONELOBBY_LISTEN` | `:8080` | `:port`, `host:port` or a full `http(s)://` URL |
| `--turn-urls` | `ONELOBBY_TURN_URLS` | none | comma list, e.g. `turn:r.example:3478,turns:r.example:443?transport=tcp` |
| `--turn-secret` | `ONELOBBY_TURN_SECRET` | none | coturn `static-auth-secret`; without both flags `welcome.ice` has STUN only |
| `--stun-urls` | `ONELOBBY_STUN_URLS` | `stun:stun.l.google.com:19302` | comma list |
| `--public-url` | `ONELOBBY_PUBLIC_URL` | none | the `wss://` address clients use (informational) |
| `--allowed-games` | `ONELOBBY_ALLOWED_GAMES` | any | comma list of `gameId`; `*` or empty = any. Others get `game_not_allowed` |
| `--max-lobbies` | `ONELOBBY_MAX_LOBBIES` | 1000 | more `create` -> `server_full` |
| `--max-peers` | `ONELOBBY_MAX_PEERS` | 10000 | more sockets -> `server_full` and close |
| `--game-quota id=n` | `ONELOBBY_GAME_QUOTAS=id=n,id=n` | none | max live lobbies for one `gameId` (repeat the flag); over -> `server_full` |
| `--max-players` | `ONELOBBY_MAX_PLAYERS` | 64 | largest `maxPlayers` a lobby may ask for, up to 250; advertised as `limits.maxPlayers` |
| `--region` | `ONELOBBY_REGION` | empty | coarse tag in each lobby list row |
| `--turn-ttl` | `ONELOBBY_TURN_TTL` | 3600 | TURN credential lifetime, seconds |
| `--max-msg` | `ONELOBBY_MAX_MSG` | 16384 | frame size limit; advertised as `limits.maxMsg` |
| `--trust-proxy` | `ONELOBBY_TRUST_PROXY` | off | take the client IP from `X-Forwarded-For` (set it behind Caddy, else every client shares the proxy IP and the per-IP limits) |
| `--trust-proxy-hops n` | `ONELOBBY_TRUST_PROXY_HOPS` | 1 | with `--trust-proxy`: how many proxies you run in front; the client IP is the `X-Forwarded-For` entry that many from the right (what your proxy appended, not what the client claimed) |
| `--rate-scale n` | `ONELOBBY_RATE_SCALE` | 1 | testing only: multiply the per-IP limits (conformance runs with 20) |
| `--disable-ip-limits` | `ONELOBBY_DISABLE_IP_LIMITS` | off | testing only: no per-IP limits (load script) |

## Rules implemented (summary)

- Partition by `gameId` + `netVersion`; a join to another `netVersion` gets `version_mismatch` with both versions.
- Join codes: Crockford base32, 6 chars, unique among live lobbies, never reused for 24 h, CSPRNG; typed input is normalised
  (`spec/codes.json`).
- Visibility `public` (listed), `unlisted` (code only), `private` (host approves each join).
- Resume: a dropped socket keeps its slot and `resumeToken` for 60 s; others hear `peer_left{timeout}` at once and
  `peer_joined` on return; the peer keeps its `peerId`.
- Host mirror: lowest connected `peerId` takes over with `host_changed{hostId, epoch}`; a peer-side claim
  (`host_changed` client message) is accepted with a higher epoch.
- Limits (s.12): per IP 10 `create`/min, 60 `join`/min, 8 open lobbies; per peer 20 `signal`/s; frame cap `maxMsg`;
  30 s idle timeout (clients ping every 10 s); global `maxLobbies`/`maxPeers`; per-`gameId` quotas.
- TURN REST credentials per `welcome`: `username = <expiry>:<connection id>`, `credential = base64(HMAC-SHA1(secret, username))`,
  TTL 1 h (`spec/turn-rest.md`).
- Names: control characters and bidi overrides stripped, truncated (24 for players, 48 for lobbies).
- Path telemetry: a peer may send `{"t":"path","path":"relayed"|"direct"}` after ICE completes; counted in
  `onelobby_path_total`. (Not in the schema yet; an additive message, unknown to older servers and ignored.)
- Logs: lobby events and rate-limit hits with a salted hash of the client IP; SDP bodies are never logged.

## Develop

```
dotnet build              # 0 warnings (TreatWarningsAsErrors)
dotnet test               # unit tests drive Hub with a fake clock; WebSocketTests use real Kestrel on loopback
```

`Hub` is transport-agnostic and takes an `IClock`, a random source and an `ILogger`, so every rule (timeouts, resume
window, 24 h code retirement, rate windows) is tested without sleeping.

Conformance (needs the Node harness in `../conformance/server`):

```
ONELOBBY_RATE_SCALE=20 ./onelobby-server --listen 127.0.0.1:8080 &
node ../conformance/server/run.mjs ws://localhost:8080/ws
```

## Load

```
./onelobby-server --listen 127.0.0.1:8080 --disable-ip-limits --max-lobbies 2000
node load/load.mjs ws://localhost:8080/ws --lobbies 1000 --per-lobby 5 --seconds 20
```

Opens 1,000 lobbies x 5 sockets, then every lobby sends one signal per second through the server and reports echo latency.
