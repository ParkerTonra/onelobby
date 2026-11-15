# Recipe: a TURN relay for Direct mode

Direct mode (join codes, no lobby server) opens a peer-to-peer link between players. Most home networks work with STUN
alone. A player behind a strict NAT (symmetric or carrier-grade) cannot, and needs a TURN relay to forward the traffic.
OneLobby ships no TURN server and needs no one's account: TURN is bring-your-own, plain standard TURN, so moving to
another provider later is one changed config entry.

Snippets tagged `ts compile` / `csharp compile` are type-checked by `docs/check-snippets.mjs`.

## 1. When you need it

- One side is behind a symmetric or carrier-grade NAT (mobile data, some campus and office networks), and the joiner's
  ready step fails with `ice_failed` and the message "Could not connect to the host. Strict NATs need a relay (TURN), see
  docs/recipes/turn.md; the host can also port-forward."
- With no TURN entry the full ready timeout goes to one STUN-only attempt. With a TURN entry in the ICE list (and
  `relay_only` off) the joiner tries normally for half the timeout, then dials the host once more relay-only for the second
  half. So the relay retry exists only when you configured a TURN server.
- Lobby-server mode (`host` / `join`) gets TURN from the server's `welcome`; this recipe is for Direct mode, where nobody
  hands out ICE servers unless the host or joiner does.

## 2. Config per client

A TURN entry is `{ urls, username, credential }`. A **host** entry is sent to every joiner in `welcome.ice` (and the host
uses it too), so one host entry covers everyone, including older clients. A **joiner** entry is added to the host's list,
for a joiner behind a strict NAT whose host configured nothing. Set it on the host when you can.

### GDScript (Godot, no .NET)

```gdscript
var turn := {"urls": ["turn:turn.example.com:3478"], "username": "USER", "credential": "PASSWORD"}
var lobby := await client.host_direct({"name": "My game", "max_players": 4, "ice_servers": [turn]})   # host
var joined := await client.join_direct(code, {"ice_servers": [turn]})                                  # joiner
client.relay_only = true   # set before host_direct / join_direct: only relay candidates, to test the relay
```

Godot reaches TURN over UDP only (libjuice): list `turn:host:3478` without `?transport=tcp`; `turns:` and tcp URLs are skipped.

### JavaScript (browser or Node)

```ts compile file=turn.ts
import { OneLobby, turnLogin, type IceServer } from "onelobby";
import { hostDirect } from "onelobby/direct";

const turn: IceServer = { urls: ["turn:turn.example.com:3478", "turns:turn.example.com:443?transport=tcp"], username: "USER", credential: "PASSWORD" };

export async function host(): Promise<string> {
  // relayOnly: true here forces the relay (testing); leave it off in production
  const kit = new OneLobby({ gameId: "com.you.game", netVersion: "1", lobbyServer: "ws://unused.invalid/ws", mode: "raw", relayOnly: false });
  const lobby = await hostDirect(kit, { maxPlayers: 4, iceServers: [turn] });
  return lobby.joinCode;
}

export async function join(code: string) {
  const kit = new OneLobby({ gameId: "com.you.game", netVersion: "1", lobbyServer: "ws://unused.invalid/ws", mode: "raw" });
  return kit.joinDirect(code, { iceServers: [turn] });
}

// a coturn shared-secret login (section 4 says where the secret may live)
export const login = (secret: string) => turnLogin(secret, "p1", 3600);
```

### C# (.NET, Godot C#, Unity)

```csharp compile file=TurnNet.cs
using System;
using System.Threading.Tasks;
using OneLobby;
using OneLobby.DataChannel;
using OneLobby.Direct;

public static class TurnNet
{
    static readonly IceServer Turn = new IceServer(new[] { "turn:turn.example.com:3478", "turns:turn.example.com:443?transport=tcp" }, "USER", "PASSWORD");

    // relayOnly: true sends and accepts only relay candidates (OneLobby.DataChannel and Unity); use it to test the relay
    public static LobbyClient NewClient(bool relayOnly = false) =>
        new LobbyClient(new OneLobbyConfig("com.you.yourgame", "1", new Uri("ws://unused.invalid/"), SyncMode.Raw, RelayOnly: relayOnly),
                        new DataChannelTransport());

    public static Task<Lobby> Host(LobbyClient client) =>
        client.HostDirectAsync(new DirectHostOptions { MaxPlayers = 4, IceServers = new[] { Turn } });

    public static Task<Lobby> Join(LobbyClient client, string code) =>
        client.JoinDirectAsync(code, new JoinDirectOptions { IceServers = new[] { Turn } });

    // a coturn shared-secret login (section 4 says where the secret may live)
    public static IceServer Login(string secret)
    {
        var (user, cred) = TurnLogin.Mint(secret, "p1", TimeSpan.FromHours(1));
        return new IceServer(new[] { "turn:turn.example.com:3478" }, user, cred);
    }
}
```

Unity: `OneLobbyRunner.HostDirectAsync(new DirectHostOptions { IceServers = ... })` takes the same host options. In
`OneLobby.Godot` (C#) `RelayOnly` still relies on Godot's `iceTransportPolicy`, which webrtc-native ignores, so test the
relay with the GDScript or DataChannel client instead.

`relay_only` / `relayOnly` / `RelayOnly` hides each player's IP from the others (everything goes through the relay), at the
cost of latency. Use it to prove your TURN server works, or as a privacy setting; with no TURN entry a relay-only link
cannot connect and fails as `ice_failed`.

## 3. Where the TURN server comes from

Any standard TURN server works. Two routes.

**Run coturn yourself** (a small VPS with a public IP is enough). A minimal `turnserver.conf` with expiring logins:

```
listening-port=3478
tls-listening-port=443       # TCP/TLS clients (JS and C#; Godot cannot use it); needs cert= and pkey= below
listening-ip=0.0.0.0
external-ip=203.0.113.10     # the server's public IP (behind NAT: public/private)
realm=turn.example.com
fingerprint
use-auth-secret
static-auth-secret=CHANGE-ME-LONG-RANDOM   # e.g. openssl rand -hex 32; never commit the real value
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
min-port=49160
max-port=49400
no-multicast-peers
no-cli
total-quota=100
```

Open on the firewall: 3478 UDP (and TCP), 443 TCP if you enable TLS, and the relay range 49160-49400 UDP (each relayed
player uses one port, so size the range to your concurrent players). Port 443 must be free on that machine.
`deploy/RUN_YOUR_OWN.md` runs coturn next to the lobby server with Docker, using the same secret scheme. Check a login with
`turnutils_uclient`, see `spec/turn-rest.md`.

**Use a hosted TURN provider.** Several companies sell or give TURN access, for example Cloudflare Realtime TURN, Twilio
Network Traversal, Metered, Xirsys and Open Relay. This is a list of options, not a recommendation. Free tiers, limits and
prices change; check each provider's current terms, whether it hands out a fixed username and password or a login you mint
through its API, and what a traffic spike would cost. Because the entry is plain `{urls, username, credential}`, switching
provider later is one config change.

## 4. Expiring logins (do not ship the secret)

A coturn shared secret can mint a login for anyone. Never put a long-lived secret in a game build: whoever unpacks the
build can run traffic through your server at your cost. Instead keep the secret on a small HTTP function you deploy yourself
and let the game ask it for a login that expires (an hour is plenty; the login only has to be valid when the link is set up).

`examples/turn-credentials/worker.js` is a TEMPLATE Cloudflare Worker for that. It holds the secret as an environment
secret (`wrangler secret put TURN_SECRET`; the file has no secret in it), mints `<expiry>:<id>` plus
`base64(HMAC-SHA1(secret, username))` as in `spec/turn-rest.md`, and answers `GET` with
`{ "urls": [...], "username": "...", "credential": "..." }`, which is already an ice server entry. Any other small HTTP
function works the same way. Rate-limit it per client IP (see the comments in the file), keep the TTL short, and set coturn
quotas as a backstop.

```ts compile file=fetch-turn.ts
import type { IceServer } from "onelobby";

export async function fetchTurn(url: string): Promise<IceServer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`turn login failed: ${r.status}`);
  return (await r.json()) as IceServer;
}
```

Fetch it right before `host_direct` / `hostDirect` / `HostDirectAsync` (the host's entry reaches every joiner), and treat a
failure as "no TURN": the game still works for the players who do not need the relay.

A static secret inside the client (`OneLobbyTurn.login`, `turnLogin`, `TurnLogin.Mint`) is fine only for private
playtests among people you trust, or against a server with a spend cap. Rotate the secret afterwards.

## 5. Troubleshooting

- `ice_failed`, "Could not connect to the host. Strict NATs need a relay (TURN), see docs/recipes/turn.md; the host can
  also port-forward." No TURN entry was configured. Add one (section 2), or have the host port-forward its UDP port.
- `ice_failed`, "Could not connect to the host, even through the relay (TURN). Check the relay is reachable (Godot reaches
  TURN over UDP only); the host can also port-forward." A TURN entry exists and the relay retry failed too. Check that the
  login has not expired and the clocks agree (an expired `username` is rejected), `static-auth-secret` matches, 3478 UDP and
  the relay port range are open, `external-ip` is right, and the realm is set.
- Test the relay on purpose: `relay_only` / `relayOnly` / `RelayOnly` on both sides. If that connects, TURN works; if the
  normal attempt still fails, the cause is the direct path, not your relay.
- Godot (GDScript and OneLobby.Godot) reaches TURN over UDP only. `turns:` and `?transport=tcp` entries are skipped, so a
  network that blocks all UDP cannot be helped by any TURN setting in Godot. Offer another route (a lobby server, a
  port-forwarded host) or another network. JS and the DataChannel clients can use `turns:...:443?transport=tcp`.
