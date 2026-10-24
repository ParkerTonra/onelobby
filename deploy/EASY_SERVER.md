# Get a lobby server in five minutes (no coding)

Your game needs a lobby server so players can find each other with a join code. This page gets you one on
[Render](https://render.com), a hosting site with a free plan. You click a button, sign in, and copy an address.
No Linux, no DNS, no ports to open.

What you get: the OneLobby lobby server on a free `https://...onrender.com` address with a certificate. Players connect
to each other directly; the server only introduces them.
What you do not get: a TURN relay (explained below). Most players do not need one. When you do, use
[RUN_YOUR_OWN.md](RUN_YOUR_OWN.md), the advanced path.

## Steps

1. **Click the button.**

   [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ParkerTonra/onelobby)

2. **Sign in or sign up.** Render asks you to log in. GitHub, GitLab, Google or email all work. The free plan does not
   ask for a credit card.
3. **Check the form and click "Deploy Blueprint"** (the button may say "Apply"). Render shows one service named
   `onelobby-server` on the **Free** plan. You can rename it; the name becomes part of your address. Leave everything
   else as it is.
4. **Wait for "Live".** The first build takes a few minutes. Open the service from your Render dashboard and wait until
   the status says **Live**.
5. **Copy your address.** Near the top of the service page is a link like `https://onelobby-server-ab12.onrender.com`.
   Click it: the page should say `onelobby-server lk1, connect over WebSocket`. That means it works.
6. **Give your game the lobby server address.** Take your address, change `https://` to `wss://` and add `/ws`:

   ```
   wss://onelobby-server-ab12.onrender.com/ws
   ```

   Paste that wherever your game or the `<one-lobby>` element asks for the lobby server
   (see [docs/no-code.md](../docs/no-code.md)). Without `/ws` works too; with it is the usual form.

## What it costs

As of 24 October 2026, from [Render's free plan page](https://render.com/docs/free) and
[pricing page](https://render.com/pricing):

- **Free**: $0. 512 MB memory, 0.1 CPU, which is plenty for a lobby server (it only passes small messages).
- **Goes to sleep after 15 minutes with nobody connected.** The next player to arrive wakes it up, which takes about a
  minute. Their first Host or Join may fail or be slow; trying again after a minute works. Players already in a game
  are not affected: the game itself runs between the players, not on the server.
- **750 free hours per month** for your whole account. One server that is always awake uses about 730, so one free
  server fits; two awake all month do not. Sleeping time does not count.
- **Bandwidth**: free services share the account's monthly included outbound bandwidth. A lobby server uses very
  little. With no card on file, going over pauses the server until next month instead of billing you.
- **Paid, no sleeping**: the Starter instance is $7 per month. In the service's **Settings**, change the instance type.

Prices change; check the two links above for today's numbers.

## TURN in one sentence, and when you need it

A TURN relay is a server that passes game traffic between two players whose networks will not let them connect
directly. You need one if some players can never join (the join hangs or times out every time) while others can,
which typically happens on strict office, school or hotel networks and some mobile carriers. A relay has to be
reachable on many ports, which free web hosts like Render do not allow, so it needs a real machine: follow
[RUN_YOUR_OWN.md](RUN_YOUR_OWN.md), then add `ONELOBBY_TURN_URLS` and `ONELOBBY_TURN_SECRET` to this server's
**Environment** tab (or move the lobby server onto that machine too).

## Optional settings

On the service page, open **Environment**, add a variable, and save; Render restarts the server.

| Variable | Example | What it does |
|---|---|---|
| `ONELOBBY_ALLOWED_GAMES` | `com.you.yourgame` | Accept only your game(s), comma-separated. Empty: any game. |
| `ONELOBBY_MAX_LOBBIES` | `200` | Most lobbies open at once (default 1000). |
| `ONELOBBY_REGION` | `us-west` | Short tag shown next to each lobby in the lobby list. |
| `ONELOBBY_TURN_URLS`, `ONELOBBY_TURN_SECRET` | see above | Hand out your TURN relay to players. |

Leave `ONELOBBY_TRUST_PROXY` set to `true`: it lets the server tell players apart behind Render's front door.

Good to know: `/metrics` (server counters, no player data) is public on this setup; the advanced path restricts it.
To update to a newer OneLobby version, open the service and choose **Manual Deploy**, then **Deploy latest commit**.

## Other hosts

Any host that runs a Docker image and allows WebSockets works. Build from the `server/` folder with
`server/Dockerfile`; the server listens on the `PORT` the host gives it (8080 if none) and answers health checks on
`/healthz`. Set `ONELOBBY_TRUST_PROXY=true` when the host puts a proxy in front. As of October 2026:

- [Railway](https://docs.railway.com/reference/pricing/plans): a one-time $5 trial, then a free plan with $1 of credit a
  month or Hobby at $5 a month. Point a new service at the repo with root directory `server`.
- [Fly.io](https://fly.io/pricing): no free plan for new accounts; a small always-on machine is a few dollars a month.
  Set up with the `fly` command-line tool.

This repo ships a one-click file only for Render (`render.yaml` at the repo root).
