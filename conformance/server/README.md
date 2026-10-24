# conformance/server

Drives any onelobby-server over WebSocket. Source of truth: `spec/signaling.schema.json` (every message the server sends is
schema-validated) and `spec/signaling.md` (behaviour).

```
cd conformance && npm install            # one dependency: ws
node server/run.mjs ws://localhost:8080/ws          # functional suite, exit 0 = green, 1 = failures, 2 = cannot connect
```

Options: `--only=<text>` (substring of "group: name"), `--group=hello,create,join,host,list,signal,resume,robustness,policy,http`,
`--game-id=<id>` (default random `conf-xxxxx`; use it if the server has `allowedGameIds`), `--no-health` (skip `GET /healthz`),
`--timeout=<ms>` per test.

## Rate limits (read this)

The per-IP limits (10 creates/min, 60 joins/min, 8 open lobbies) cannot be passed by one machine running ~60 functional
tests. Run in two passes:

1. Functional pass against a server with scaled limits: start it with `ONELOBBY_RATE_SCALE=20` (limits x20), run the command above.
2. Rate-limit pass against a **fresh** server with scale 1: `node server/run.mjs ws://localhost:8080/ws --ratelimit --fresh`.
   Runs only: open-lobby cap, create/min, join/min, signal/s. The create and join tests wait 61 s for the window to
   reset. Defaults assume DESIGN s.12 values; override with `--rate-create= --rate-join= --rate-signal= --max-open=`
   (when the server runs scaled, pass the scaled numbers). `--fresh` additionally asserts the (N+1)th request is the first
   refused.

Other optional tests: `--disallowed-game=<id>` (server has `allowedGameIds` without that id -> `game_not_allowed`),
`--expect-full` (server is at `maxLobbies`/`maxPeers` -> `server_full`), `--slow` (30 s idle timeout, ~35 s).

Tests close their lobbies with `leave` (the 8-open-lobbies cap would otherwise trip), so a clean server stays clean.

## Self-test

`node --test server/selftest.test.mjs` runs the whole suite against `mock-server.mjs`, a ~250 line in-memory reference
written from `spec/signaling.md`. `node server/mock-server.mjs 8080 --scale=20` starts it by hand. Against a server that
does nothing the suite is red (every test times out in a few seconds).
