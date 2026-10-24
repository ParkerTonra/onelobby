# Recipe: run your own server

You can host the lobby server and relay yourself, on a 1 vCPU VM or a Raspberry Pi 4. Your game never depends on
anyone else's server: the lobby server URL is a setting. The full walkthrough is `deploy/RUN_YOUR_OWN.md`; this is the short version.

## Local, for development

```
dotnet run --project server/Keepalive.Server -- --listen :8080
```

Then run your game with the lobby server set to `ws://localhost:8080` (Godot: `--lobby-server=ws://127.0.0.1:8080`, not `localhost`; browser:
`?lobby=ws://localhost:8080` or localStorage `lobby_server`). Two peers on one machine connect directly; no relay needed.
Check it is alive: `curl http://localhost:8080/healthz`.

## Production

On a Linux box with Docker and a DNS name pointing at it:

```
git clone https://github.com/ParkerTonra/keepalive && cd keepalive/deploy
cp .env.example .env        # set LOBBY_DOMAIN, ACME_EMAIL, TURN_EXTERNAL_IP, TURN_SECRET (openssl rand -hex 32)
docker compose up -d
```

Open these ports: 80/tcp, 443/tcp+udp, 3478/udp+tcp, 5349/tcp, 49160-49400/udp. Port 8080 stays internal.
Caddy fetches the TLS certificate on first start. Players behind strict networks use the coturn relay on the same box.

## Point the game at it

Expose `lobby_server` as a setting (Multiplayer, Advanced) with your default filled in, and pass the same value to
`KeepaliveConfig.LobbyServer` (C#) or `lobbyServer` (JS). Accept a command-line flag or `<meta>` tag override too, so players can
use their own server without rebuilding. Add `--allowed-games com.you.yourgame` on the server to accept only your game.

## Done when

- `curl https://lobby.example.com/healthz` returns 200 over TLS.
- `deploy/scripts/smoke.sh` passes on the machine.
- A game build with `lobby_server=wss://lobby.example.com` hosts a lobby on one network and a phone on mobile data joins
  it by code; with the setting changed back, the game still starts and plays offline.
