# Run your own Keepalive server

You get a lobby server, a relay for players behind strict networks, and automatic HTTPS, on one small machine.
A 1 vCPU / 1 GB VM or a Raspberry Pi 4 is enough.

## Five steps

1. **Get a machine and a name.** Any Linux box with a public IP and Docker (with the compose plugin). Point a DNS
   record (for example `lobby.example.com`) at it.
2. **Open the ports** in the machine's firewall and your cloud's security group (table below).
3. **Configure.** From this `deploy/` directory:
   ```
   cp .env.example .env
   ```
   Edit `.env`: set `LOBBY_DOMAIN`, `ACME_EMAIL`, `TURN_EXTERNAL_IP` (your public IP), and a fresh secret with
   `openssl rand -hex 32` for `TURN_SECRET`.
4. **Start it.**
   ```
   docker compose up -d
   ```
   Caddy fetches a certificate on first start (give it a minute; ports 80 and 443 must be reachable).
5. **Point your game at it.** Set the game's `lobby_server` to `wss://lobby.example.com`.

## Ports

| Port | Protocol | Who | What |
|---|---|---|---|
| 80 | TCP | Caddy | Certificate challenge and redirect to HTTPS |
| 443 | TCP (and UDP) | Caddy | `wss://` lobby signaling, `/healthz`, optional Godot web build |
| 3478 | UDP and TCP | coturn | TURN relay |
| 5349 | TCP | coturn | TURN over TLS (`turns:`), for networks that only allow TCP |
| 49160-49400 | UDP | coturn | Relay range, one port per relayed player |
| 8080 | TCP | keepalive-server | Internal only. Not published to the internet |

TURN over TLS is on 5349 by default because Caddy owns 443. If you want `turns:` on 443 as well (some hotel and office
networks allow nothing else), give the machine two public IPs. Bind Caddy to one with `ports: "IP1:443:443"` in
`compose.yaml`, set `TURN_TLS_PORT=443` and `listening-ip=IP2` for coturn. Most games are fine without this.

## Smoke test

On the machine (an Ubuntu VM is the tested target), as root so it can block UDP for the TCP/TLS checks:

```
sudo deploy/scripts/smoke.sh
```

It checks that `https://<your domain>/healthz` answers 200 with a valid certificate, that a TURN allocation works over
UDP, and that allocations still work over TCP and TLS with UDP to the relay blocked. Every line starts with `ok` or `FAIL`.

To check only the credential maths (no server needed): `node deploy/scripts/turn-creds-check.mjs`.

## Running without Docker

Download the `keepalive-server` binary for your platform from the releases page, then follow the comments at the top of
`keepalive-server.service` (a systemd unit). Install coturn from your package manager, copy `turnserver.conf` to
`/etc/turnserver.conf`, and pass the secret, realm, external IP and certificate on the coturn command line as
`compose.yaml` does. You still want Caddy (or nginx) in front for TLS.

## Raspberry Pi notes

- Use a 64-bit OS (Raspberry Pi OS 64-bit or Ubuntu). The images and the `linux-arm64` binary are 64-bit only.
- Run from an SSD or a good SD card; Caddy writes certificates and logs.
- The relay is the heavy part. The default cap is 1 MB/s per player and 200 allocations total, which a Pi 4 on gigabit
  Ethernet handles. On Wi-Fi or a slow uplink lower `max-bps` and `total-quota` in `turnserver.conf`.
- Home connection: forward the ports in the table to the Pi on your router, set `TURN_EXTERNAL_IP` to your public IP,
  and use a dynamic DNS name for `LOBBY_DOMAIN` if your IP changes (update `TURN_EXTERNAL_IP` when it does and run
  `docker compose up -d`).

## Good to know

- `--trust-proxy` is already set in compose and the unit, so per-IP limits see each player's real address behind Caddy.
- `TURN_SECRET` must be the same for `keepalive-server` and coturn; compose passes one value to both.
- Players' relay traffic is capped (`total-quota`, `user-quota`, `max-bps`) and cannot reach private addresses
  (`denied-peer-ip` in `turnserver.conf`), so the relay cannot be used to probe your home network.
- coturn reads the certificate Caddy obtained. If `turns:` fails right after first start, wait for Caddy to finish
  getting its certificate and run `docker compose restart coturn`.
- Serving a Godot web build: put the exported files in `deploy/game-web/`, set `GAME_DOMAIN` in `.env` to a real name
  that points at the machine. The Caddyfile adds the `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`
  headers Godot needs.
- Update: `docker compose pull && docker compose up -d`.
