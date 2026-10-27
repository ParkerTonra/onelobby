# Recipe: host with a join code (no server)

The host's game is the server, like Terraria "Host & Play" or Minecraft "Open to LAN": it runs the lobby hub in-process
and listens on one port, **47810** by default (TCP for signaling, UDP for the game). It asks the home router to open that
port (UPnP, then NAT-PMP) and shows a **join code** such as `6B01-RGFE-P2B`. Friends paste the code. The code *is* the
host's address in disguise, decoded by the joiner's game, so nobody runs a lobby server and nothing can go offline.
Design and sources: [docs/direct-ip.md](../direct-ip.md) (s.2a for codes and the router).

Hosts: .NET desktop through `OneLobby.DataChannel` (any .NET app), **Unity** desktop (`com.onelobby.unity` 0.2.0+:
`OneLobbyRunner.HostDirectAsync` / `JoinDirectAsync`, see the [Unity recipe](unity.md)), and **Node** through `onelobby/direct`
(a Node game server). Joiners: .NET (`JoinDirectAsync`), Node or a browser page (`kit.joinDirect`). All of them speak the
same protocol, so they mix. Godot hosts come later. Snippets tagged `csharp compile` are compiled by
`docs/check-snippets.mjs`.

## 1. .NET: reference

From a clone of this repo (not on NuGet yet), reference three projects:

```
dotnet add reference path/to/onelobby/clients/dotnet/OneLobby.Core/OneLobby.Core.csproj
dotnet add reference path/to/onelobby/clients/dotnet/OneLobby.DataChannel/OneLobby.DataChannel.csproj
dotnet add reference path/to/onelobby/clients/dotnet/OneLobby.Direct/OneLobby.Direct.csproj
```

`OneLobby.DataChannel` needs its native library built once (`clients/dotnet/OneLobby.DataChannel/native/build-windows.ps1`
or `build-posix.sh`), see the [.NET recipe](dotnet-generic.md).

## 2. .NET: host and join

```csharp compile file=DirectNet.cs
using System;
using System.Threading.Tasks;
using OneLobby;
using OneLobby.DataChannel;
using OneLobby.Direct;

public sealed class DirectNet
{
    readonly LobbyClient _client;
    public Lobby? Lobby { get; private set; }
    public string Status { get; private set; } = "";

    // port is a game setting (default 47810); the router is asked to open this one number, TCP and UDP.
    public DirectNet(string displayName, int port = DirectLobby.DefaultPort)
    {
        var config = new OneLobbyConfig("com.you.yourgame", "1", new Uri("ws://unused.invalid/"),
                                         SyncMode.Raw, DisplayName: displayName, DirectPort: port);
        _client = new LobbyClient(config, new DataChannelTransport());
    }

    /// <summary>Call every frame: pumps the lobby, or the client until the lobby exists.</summary>
    public void Pump() { if (Lobby != null) Lobby.Pump(); else _client.Pump(); }

    /// <summary>Hosts; returns the label for the host screen, e.g. "Internet code: 6B01-RGFE-P2B".</summary>
    public async Task<string> HostAsync(bool openPort = true, string? password = null)
    {
        try
        {
            // a few seconds when the router does not answer: show "Starting..." meanwhile
            Lobby = await _client.HostDirectAsync(new DirectHostOptions { Password = password, MaxPlayers = 4, OpenPort = openPort });
            Lobby.SessionEnded += reason => { Status = "Session ended: " + reason; Lobby = null; };
            return Lobby.JoinCodeKind switch
            {
                JoinCodeKind.Nostr => "Code (works through any router): " + Lobby.JoinCode, // Lobby.DirectCode keeps the IP code
                JoinCodeKind.Internet => "Internet code: " + Lobby.JoinCode,
                JoinCodeKind.SameNetwork => "Same-network code: " + Lobby.JoinCode,
                _ => "Your address: " + string.Join(", ", Lobby.DirectAddresses),
            };
        }
        catch (OneLobbyException e) { Status = Describe(e); return ""; }
    }

    /// <summary>A join code from the host's screen, or (advanced) an address like 192.168.1.20:47810.</summary>
    public async Task<bool> JoinAsync(string code, string? password = null)
    {
        try
        {
            Lobby = await _client.JoinDirectAsync(code, password);
            Lobby.SessionEnded += reason => { Status = reason == "host_left" ? "The host closed the game." : "Session ended: " + reason; Lobby = null; };
            return true;
        }
        catch (OneLobbyException e) { Status = Describe(e); return false; }
    }

    static string Describe(OneLobbyException e) => e.Code switch
    {
        "bad_code" => "That code has a typo. Check it against the host's screen.",
        "unknown_version" => "That code is from a newer version of the game.",
        "direct_unreachable" => "No answer from the host. Same-network codes only work at the host's place; for an internet code the host's router must allow it.",
        "bad_password" => "Wrong password.",
        "bad_address" => "That is not a join code or an address.",
        "port_in_use" => "Ports 47810-47819 are busy or reserved by Windows: is another copy of the game hosting?",
        "version_mismatch" => "You and the host run different versions of the game.",
        "lobby_full" => "The game is full.",
        _ => "Multiplayer unavailable: " + e.Message,
    };
}
```

`HostDirectAsync` and `JoinDirectAsync` complete inside `Pump()`, like `HostAsync`. `HostDirectAsync` waits for the
router (up to about 4 s when nothing answers). Everything after that is the normal `Lobby` API (`Send`, `Broadcast`,
`MessageReceived`, `Lockstep`, `Chat`, `Voice`). Rules that differ from the hosted server:

- `lobby.Code` is empty and `ListAsync` returns nothing. `lobby.JoinCode` is the invitation.
- When the host leaves, the session ends for everyone (`SessionEnded("host_left")`). No host migration.
- Browser pages may only open the signaling socket from an origin the host expects. The host accepts a handshake with no
  `Origin` (every native client: .NET, Unity, Node), an `Origin` equal to the request's `Host` (the page the host serves
  itself, s.4b) and any loopback origin (`http://localhost`, `127.0.0.1`, `[::1]`, any port); anything else gets
  `403`. A web game hosted somewhere else that joins players to a direct host lists its origin:
  `new DirectHostOptions { AllowedOrigins = new[] { "https://play.example" } }` (Unity: the same options object to
  `runner.HostDirectAsync`; JS/Node: `hostDirect(kit, { allowedOrigins: ["https://play.example"] })`). Exact match;
  `"*"` allows every origin, which lets any web page the host visits probe the host's network, so only for testing.
- A joiner whose peer link does not open within `OneLobbyConfig.ReadyTimeout` (15 s) gives up like on the hosted
  server: `ReadyAsync` throws code `ice_failed` and `SessionEnded("ice_failed")` fires (no relay retry: no TURN here).
- No STUN or TURN: the game only ever talks to the other players and the player's own router.
- A joiner that drops or restarts takes its seat back within 60 s with `client.RejoinDirectAsync(code, resumeToken)`
  (Unity: `runner.RejoinDirectAsync`; JS: `kit.rejoinDirect(code, resumeToken)`): same peer id, the host sees
  `PeerJoined` for it again. Save `lobby.ResumeToken` after every join (it changes on each resume). A seat that is gone
  fails with `invalid_token` (`LobbyErrorCodes.InvalidToken`): offer a plain join then.
- Unity's `OneLobbyRunner.HostDirectAsync` (0.2.2+) logs one line with the port it bound (after any busy-port fallback), the
  code and the router mapping: `OneLobby: direct host listening on TCP+UDP :47811 (47810 busy); code ... (SameNetwork); port mapping off`.
  Other .NET hosts can build the same from `JoinCode.TryDecode(lobby.JoinCode, ...)` and `lobby.PortMapping`.
- To see the router mapping removed when the host quits (0.3.0+), pass a log hook:
  `new DirectHostOptions { PortMapping = new PortMapperOptions { Log = Debug.Log } }` (JS/Node:
  `hostDirect(kit, { portMapping: { log: console.log } })`). It gets one line per mapping kind:
  `direct host mapping deleted port=47810 protocols=TCP,UDP mapping=UPnP`. Left out, nothing is logged.
- A direct host looks like onelobby-server from outside: its port answers `GET /healthz` (`ok`) and `GET /metrics`
  (Prometheus text, same names, but loopback callers only, since the port faces the internet), so the OneLobby Console and
  scripts treat every hub shape alike. `GET /joininfo` answers `{ joinCode, joinCodeKind, joinUrl, port }` (404 until the host has a
  code; `joinUrl` is null on a C# host, which serves no page). JS/Node `hostDirect` prints the same startup line as above to `console.log`
  (`lobby.directHostLog`; pass `log: (line) => ...` to redirect it or `log: false` to silence it). Every hub prints
  `OneLobby: <server|direct host> listening on <TCP|TCP+UDP> :<port>; ...`.

**C#: Nostr codes.** `DirectHostOptions.Nostr` (default on) makes `lobby.JoinCode` a version 1 code
(`JoinCodeKind.Nostr`) that joins through any router over public Nostr relays, and `lobby.DirectCode` /
`lobby.DirectCodeKind` keep the IP-address code. `new DirectHostOptions { Nostr = new NostrOptions { Enabled = false } }` turns it off;
`NostrOptions.Relays` and `NostrOptions.Stun` replace the default relay and STUN lists (from a blueprint: `hosting.nostr`,
`hosting.nostrRelays`). With no relay reachable the host keeps the IP code as `JoinCode` and logs `; nostr: no relay
reachable`; when one answers later `JoinCodeChanged` fires. `JoinDirectAsync(code)` / `RejoinDirectAsync(code, token)` take either kind
of code; `JoinDirectAsync(code, password, new NostrOptions { Relays = ... })` picks the relays for a version 1 code (a client built
from a blueprint uses its `hosting.nostrRelays`). With Nostr on, peer links use the public STUN servers. `GET /joininfo` adds
`directCode` and `directCodeKind` (`joinCode` is the Nostr code while it works). A relay-only joiner that cannot connect fails with `direct_unreachable` after 15 s.

## 3. Node: host from a game server

```
npm install onelobby node-datachannel          # node-datachannel = WebRTC for Node (libdatachannel)
```

```js
import { OneLobby, webRtcLinkFactoryFor } from "onelobby";
import { hostDirect } from "onelobby/direct";
import { RTCPeerConnection } from "node-datachannel/polyfill";

const kit = new OneLobby({
  gameId: "com.you.yourgame", netVersion: "1", lobbyServer: "", mode: "raw", displayName: "Server",
  advanced: { linkFactory: webRtcLinkFactoryFor(RTCPeerConnection) },
});
const lobby = await hostDirect(kit, { maxPlayers: 8, openPort: true });   // 47810, or the next free port up to 47819; else port_in_use
console.log(lobby.joinCodeKind === "internet" ? "Internet code:" : "Same-network code:", lobby.joinCode);
lobby.on("message", (from, bytes, channel) => { /* the host is truth: validate, then broadcast */ });
// lobby.leave() closes the listener and removes the router mapping; joiners get sessionEnded("host_left")
// the router may answer later (still booting, UPnP switched back on): the code then turns "internet" by itself
lobby.on("joinCodeChanged", (code, kind) => console.log("New", kind, "code:", code, lobby.joinUrl ?? ""));
```

When no mapping lands, the host asks the router again after 30 s, doubling up to 5 minutes, until it answers or the
host quits (`portMapping: { retryMs }`; C#: `PortMapperOptions.RetryMs`, 0 = never, and `Lobby.JoinCodeChanged` fires inside `Pump()`); each new code prints the startup line again. A player who forwarded
TCP and UDP 47810 by hand passes the public address, and the router is not asked:
`hostDirect(kit, { publicAddress: "203.0.113.7" })`, or the environment variable `ONELOBBY_PUBLIC_IP=203.0.113.7`. The
code is then an internet one with `portMapping` "manual" ("manual (ONELOBBY_PUBLIC_IP)" when it came from the variable, so a stray variable shows in the startup line). C# is the same: `DirectHostOptions.PublicAddress` (a hostname fails
with `bad_address`); the router is then asked only if `OpenPort` is set to true explicitly.

`hostDirect` runs the TypeScript port of the hub (`onelobby/direct`'s `SignalingHub`, held to the same
`conformance/server` suite as the C# one) behind a dependency-free WebSocket listener, binds every peer link to UDP
47810 (libdatachannel's ICE UDP mux) and asks the router to forward both. Lower-level pieces: `DirectHubHost` (hub +
listener, `connectLocal()`, `openPort()`), `PortMapper`, `SignalingHub`. A browser cannot host: it cannot listen on a
port.

## 4. JS: join (Node or a browser page)

```js
const lobby = await kit.joinDirect("6B01-RGFE-P2B", { password });   // or "192.168.1.20:47810"
await lobby.ready;
lobby.on("sessionEnded", (reason) => { if (reason === "host_left") showMessage("The host closed the game."); });
```

Errors (`OneLobbyError.code`): `bad_code` (a typo, at once), `unknown_version`, `bad_address`, `direct_unreachable`
(no answer within 5 s, `connectTimeoutMs`), `bad_password`, plus the usual `lobby_full`, `version_mismatch`, `in_game`.
In Node, give the kit `advanced.linkFactory: webRtcLinkFactoryFor(RTCPeerConnection)` as above. A browser page uses its
own WebRTC, but it must be served over plain `http` (an `https` page may not open `ws://` to an address; s.7 of the
design). `decodeJoinCode` / `looksLikeJoinCode` validate a "Paste a join code" box as the player types.

## 4b. Node host: a join link for browsers

A browser player shouldn't need a game page from anywhere else: the host serves its own on the same port. Give
`hostDirect` an `http` handler; plain `GET`s that are not WebSocket upgrades go to it, and the lobby gets a `joinUrl`
(`http://<the code's address>:47810/`) to share. The page joins `location.host`, which is the host's address, so it
needs no code at all. Plain `http` is what makes this work (an `https` page may not open `ws://` to an address).

```js
import { readFileSync } from "node:fs";
const bundle = readFileSync("node_modules/onelobby/dist/onelobby.bundle.mjs");
const page = `<!doctype html><meta charset="utf-8"><p id="s">Connecting...</p><script type="module">
  import { OneLobby } from "/onelobby.bundle.mjs";
  const kit = new OneLobby({ gameId: "com.you.yourgame", netVersion: "1", lobbyServer: "", mode: "raw" });
  const lobby = await kit.joinDirect(location.host);
  await lobby.ready; document.getElementById("s").textContent = "Joined!";   // ...then start your game
</script>`;
const lobby = await hostDirect(kit, {
  port: 47810,
  http: (path) => path === "/" ? { type: "text/html; charset=utf-8", body: page }
    : path === "/onelobby.bundle.mjs" ? { type: "text/javascript; charset=utf-8", body: bundle } : null,
});
console.log("Send this link:", lobby.joinUrl);
```

The handler gets the path without the query and returns `{ status?, type, body, headers? }` or null (404). Replies
carry `Cache-Control: no-store` unless `headers` sets its own (e.g. `{ "Cache-Control": "max-age=3600" }` for a big
static file). Serve only fixed paths from memory, never files by path.

A page should show the link to share from the host, not its own address: a host who opened the page at a LAN or
`localhost` address would otherwise share a link nobody outside can open. The port answers `GET /joininfo` with
`{ joinCode, joinCodeKind, joinUrl, port }`, and `directJoinInfo()` from `onelobby` fetches it:

```js
import { directJoinInfo } from "onelobby";
const info = await directJoinInfo();   // null when this page is not served by a direct host
if (info?.joinUrl) shareBox.value = info.joinUrl;   // ask again later: it turns "internet" if the router answers late
``` A game that already has its own web server can do the same on that server: what
matters is that the page comes from the host's address over `http`. A whole game built this way:
[browser-game.md](browser-game.md). Smoke: `node e2e/direct-smoke.mjs
host 47810 --page --wait=600` prints `join page http://...`; opening it shows "It works!" and the host prints `PASS
host`. .NET hosts do not serve pages yet.

## 5. What to tell the host (put this on the host screen)

- "Join code: `6B01-RGFE-P2B`" in large monospace with a Copy button, labelled **Internet code** or **Same-network
  code** (`JoinCodeKind`). The joiner's screen has one box: "Paste a join code". The host cannot test an internet code
  from inside its own network (many routers do not loop back), so say which kind it is rather than "it works".
- Same-network code only: "Friends outside your network can't use this code yet. Turn on UPnP on your router, or
  forward TCP and UDP port 47810 to this PC, or use a virtual LAN (Tailscale, ZeroTier, Hamachi)." A virtual-LAN
  address also makes a working code.
- A toggle "Open port automatically" (`OpenPort` / `openPort`, default on).
- The raw addresses (`DirectAddresses` / `directAddresses`) under an "Advanced" fold-out, never in the main flow.
- "If Windows asks, allow access on Private networks." Keep this text on screen until someone joins: the game cannot see
  the answer. On a network Windows calls **Public**, the firewall also drops the router's UPnP answer, so the code is a
  same-network one; switching the network to Private (Settings > Network) fixes both.

## 6. Shipping: the firewall

Windows Firewall rules belong to a program file, not a port. The program that hosts is the one that needs inbound
access: your game's exe for a .NET or Unity host, `node.exe` for a Node host. Players never need Node unless the game
itself runs on Node.

- **First run.** The first time an exe listens, Windows asks "Allow access?", ticked for the current network type. One
  click on a Private network is enough. Windows asks once per exe: if the player answered on a Public network (or said
  no), the rule only covers Public (or blocks), and joiners from outside are dropped with no new prompt. Tell them to
  fix it under Windows Security > Firewall > Allow an app.
- **Installer.** Installers already run as admin, so they can add the rule up front and the player never sees a
  prompt. For example (NSIS, Inno Setup, WiX all run commands like this):
  `netsh advfirewall firewall add rule name="Your Game" dir=in action=allow program="C:\Program Files\Your Game\game.exe" profile=private`.
  Remove it on uninstall (`netsh advfirewall firewall delete rule name="Your Game"`).
- **Router.** Separate from the firewall: `OpenPort` asks the router to forward 47810 (UPnP, NAT-PMP). With UPnP off,
  the host forwards TCP and UDP 47810 by hand, as most PC games ask (Factorio documents its UDP port the same way).
- **Dev machines.** Node often has an old Public-only rule from its installer's first prompt. A Private allow for
  `node.exe` (admin PowerShell: `New-NetFirewallRule -DisplayName "Node.js (Private)" -Direction Inbound -Action Allow
  -Profile Private -Program "C:\Program Files\nodejs\node.exe"`) lets a Node host be reached from outside.

## Done when

1. Build the smoke tools: `dotnet build clients/dotnet/OneLobby.DataChannel.Smoke -c Release`, and in `clients/js`
   `npm ci && npm run build`.
2. In one terminal: `OneLobby.DataChannel.Smoke host-direct 47810` (or `node e2e/direct-smoke.mjs host 47810` in
   `clients/js`) prints `join code ... (Internet|SameNetwork)` and what the router said.
3. In another (same machine, or another PC on the network): `OneLobby.DataChannel.Smoke join-direct <code>` (or
   `node e2e/direct-smoke.mjs join <code>`) prints `PASS`, and the host prints `PASS host`. Any host with any joiner.
4. From outside the network with an internet code: `join-direct <code>` passes, and the joiner's `pair` line shows the
   public address as `remote[...]`. No second network? `join-direct <code> --only-typed` (both smokes) drops every
   candidate the host offers, so the code's address is the only way in; it passes with that address as `remote[...]`.
