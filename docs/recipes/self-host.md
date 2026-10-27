# Recipe: run your own server

> **Later.** The hosted backend (this server: join codes, public list, TURN relay) is parked; the first backend that
> ships is [host by IP](direct-ip.md), with no server at all (docs/design/direct-ip.md s.7). Everything below still works.

You can host the lobby server and relay yourself, on a 1 vCPU VM or a Raspberry Pi 4. Your game never depends on
anyone else's server: the lobby server URL is a setting. The full walkthrough is `deploy/RUN_YOUR_OWN.md`; this is the short version.

## Local, for development

```
dotnet run --project server/OneLobby.Server -- --listen :8080
```

Then run your game with the lobby server set to `ws://127.0.0.1:8080/ws` (Godot: `--lobby-server=ws://127.0.0.1:8080/ws`, not `localhost`; browser:
`?lobby=ws://127.0.0.1:8080/ws` or localStorage `lobby_server`). Two peers on one machine connect directly; no relay needed.
Check it is alive: `curl http://127.0.0.1:8080/healthz`. The WebSocket endpoint is the `/ws` path (the URL games use ends in `/ws`).

## Production

On a Linux box with Docker and a DNS name pointing at it:

```
git clone https://github.com/ParkerTonra/onelobby && cd onelobby/deploy
cp .env.example .env        # set LOBBY_DOMAIN, ACME_EMAIL, TURN_EXTERNAL_IP, TURN_SECRET (openssl rand -hex 32)
docker compose up -d
```

Open these ports: 80/tcp, 443/tcp+udp, 3478/udp+tcp, 5349/tcp, 49160-49400/udp. Port 8080 stays internal.
Caddy fetches the TLS certificate on first start. Players behind strict networks use the coturn relay on the same box.

Compose and the unit pass `--trust-proxy`, so the per-IP limits see each player's real address. The server takes the
rightmost `X-Forwarded-For` entry (the one Caddy appended), because anything further left is written by the client and
could be forged to dodge the limits. If you chain more proxies (a CDN in front of Caddy), set `--trust-proxy-hops 2`
(`ONELOBBY_TRUST_PROXY_HOPS`), one per proxy you run; with fewer entries than that the connection's own address is used.

## Point the game at it

Expose `lobby_server` as a setting (Multiplayer, Advanced) with your default filled in, and pass the same value to
`OneLobbyConfig.LobbyServer` (C#) or `lobbyServer` (JS). Accept a command-line flag or `<meta>` tag override too, so players can
use their own server without rebuilding. Add `--allowed-games com.you.yourgame` on the server to accept only your game.

## Done when

- `curl https://lobby.example.com/healthz` returns 200 over TLS.
- `deploy/scripts/smoke.sh` passes on the machine.
- A game build with `lobby_server=wss://lobby.example.com/ws` hosts a lobby on one network and a phone on mobile data joins
  it by code; with the setting changed back, the game still starts and plays offline.
