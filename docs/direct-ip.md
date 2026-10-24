# Direct-IP hosting (proof of concept)

Status: design, 2026-10-24. Decided by Parker: OneLobby is the API layer *above* platforms; the first backend that
ships is **direct IP**, with no server of anyone's. Steam, EOS, relay, LAN discovery and the hosted `onelobby-server`
directory are parked (s.7). For the PoC this note supersedes DESIGN s.3 (server in every handshake), s.6 (server-issued
codes), s.10 (coturn) and s.13 (docker self-hosting); those sections stay true for the parked hosted backend.

## 1. Prior art

Accessibility: no new rules. The host's address uses the s.1 rules for codes (large monospace) plus a Copy button;
nothing in the flow is on a timer.

| Source | Establishes | Backs |
|---|---|---|
| [Factorio wiki: Multiplayer](https://wiki.factorio.com/Multiplayer) | "Factorio servers use port 34197." "Factorio uses UDP only." Hidden servers: "Clients will have to connect using the server's IP address." "Make sure you configure your router's port forwarding correctly for port 34197." (spot-checked) | s.2 one fixed port, join by IP, forwarding is the host's job |
| [Terraria wiki: server guide](https://terraria.wiki.gg/wiki/Guide:Setting_up_a_Terraria_server) | Menu "Multiplayer" then "Host & Play"; join via "Multiplayer->Join via IP->...Type in the IP"; "enter a password (or leave blank...)"; port "7777" by default | s.2 menu shape, optional password |
| [Valheim: dedicated server guide](https://www.valheimgame.com/support/a-guide-to-dedicated-servers/) | Hidden servers are "only joinable via the 'Join IP'-button"; "Valheim uses the specified Port AND specified Port+1"; `-password` | s.2 port pair, password |
| [Stardew Valley wiki: Multiplayer](https://wiki.stardewvalley.net/Multiplayer) | "By default, the server uses UDP port 24642." Join "Via IP address." "This may require an open firewall port or virtual LAN service like Hamachi." | s.4 virtual-LAN fallback |
| [Minecraft wiki: Multiplayer](https://minecraft.wiki/w/Multiplayer), [server.properties](https://minecraft.wiki/w/Server.properties) | Open to LAN: "The port is automatically shown on the chat"; LAN worlds multicast to `224.0.2.60:4445` "every 1.5 seconds"; a server port "must be forwarded if the server is hosted in a network using NAT" | s.3 show the address, s.7 LAN discovery |
| [Steamworks: multiplayer](https://partner.steamgames.com/doc/features/multiplayer) | "Matchmaking and lobbies do not provide networking features"; networking is Steam P2P, game servers, or the engine's own (spot-checked) | s.6 directory and transport are separate seams |
| [Mirror: transports](https://mirror-networking.gitbook.io/docs/transports/) | "kcp2k is the new default Transport"; FizzySteamworks ("Steam P2P"), EOS ("Epic's free relay"); Multiplexer handles "clients on different transports concurrently" | s.6 swappable backends |
| [FishNet: transports](https://fish-networking.gitbook.io/docs/fishnet-building-blocks/transports) | "Tugboat is the default transport"; Multipass lets servers "utilize multiple transports at once" | s.6 |
| [Godot: MultiplayerPeer](https://docs.godotengine.org/en/stable/classes/class_multiplayerpeer.html) | "This class interface can abstract most types of network layers, topologies and libraries" | s.6 |
| [Unreal: Online Subsystem](https://dev.epicgames.com/documentation/en-us/unreal-engine/online-subsystem-in-unreal-engine) | Switching platforms: "the only changes developers need to make are configuration adjustments for each supported service"; Sessions is its own interface | s.6 backend is config, not game code |
| [Godot demo: webrtc_signaling](https://github.com/godotengine/godot-demo-projects/tree/master/networking/webrtc_signaling) | "The `server` folder contains the signaling server implementation written in GDScript": signaling can live inside a game | s.2 host runs the hub |
| [libdatachannel](https://github.com/paullouisageneau/libdatachannel) | "WebSocket protocol (RFC6455), client and server side"; "WebSocket is the protocol of choice for WebRTC signaling"; OneLobby's natives build with `NO_WEBSOCKET`, so s.5 step 3 stays managed | s.5 step 3 |
| [RFC 8445 (ICE)](https://datatracker.ietf.org/doc/html/rfc8445) | Host candidates have "a transport address obtained directly from a local interface"; no STUN/TURN is needed to offer them | s.2 no ICE servers |
| [RFC 6092](https://datatracker.ietf.org/doc/html/rfc6092) | IPv6 home routers: "transport layer traffic is not forwarded into the interior network" by default | s.4 IPv6 does not remove forwarding |
| [CERT VU#357851](https://www.kb.cert.org/vuls/id/357851), [RFC 6887 (PCP)](https://datatracker.ietf.org/doc/html/rfc6887) | Routers that "accept UPnP requests over the WAN"; mitigation "Disable UPnP". PCP "MAP request can be used explicitly to create a dynamic inbound mapping" | s.7 auto port-open is later and opt-in |

Not verified, kept out of the rules: whether a browser page served over https may open `ws://` to a raw IP (MDN's
mixed-content and WebSocket pages are silent), the exact Windows Firewall first-run behaviour (third-party source
only), Unreal's `OnlineSubsystemNull` page (no body on fetch).

## 2. The shape

The host's game is a **listen server**, as in Terraria "Host & Play", Minecraft "Open to LAN" and Valheim/Factorio
join-by-IP. There is no third party:

```
 Host game process                                   Joiner game
 ┌───────────────────────────────────────┐          ┌──────────────┐
 │ LobbyClient ──in-memory──► Hub (lk1)  │◄── ws ───│ LobbyClient  │  TCP P: signaling (same lk1 JSON)
 │                         ▲ WS listener │          │              │
 │ PeerLinks  (ICE bound to UDP P) ◄─────┼── UDP ───┤ PeerLink     │  UDP P: WebRTC data channels
 └───────────────────────────────────────┘          └──────────────┘
```

- **The hub moves into the host.** The same `Hub` that runs `onelobby-server` today runs in-process on the host, so
  the wire protocol (DESIGN s.7, s.8), lockstep, replication, chat and voice are unchanged. Godot's own WebRTC demo
  puts signaling in a game the same way.
- **One port number, both protocols.** Signaling listens on TCP `P`; the host's peer links bind ICE to UDP `P`
  (`PortRangeBegin = PortRangeEnd = P`). The host forwards one number, like Factorio's 34197 or Valheim's pair. `P` is
  a game setting (`directPort`), library default **47810**.
- **No ICE servers.** Host candidates only (RFC 8445). Joiners need no forwarding: they dial out.
- **The typed address is a candidate.** The joiner knows the address it typed, so its peer link adds `ip:P udp` as a
  remote host candidate. Without it a joiner on the internet only learns the host's private LAN address. The host
  learns the joiner's public mapping as a peer-reflexive candidate from the incoming checks. *To be proven by the
  smoke test (s.5 step 7); it follows from ICE but nothing above states it for this setup.*
- **One lobby per hub.** The embedded hub runs in single-lobby mode: a `join` without a code joins the one lobby, so
  joiners type only the address. Codes, the public list and TURN credentials are off.
- **Optional password**, checked by the hub on `join` (Terraria, Valheim, Factorio all offer one, none require one).
- **Host leaves = the session ends.** The hub lives in the host; there is nothing to migrate to. Listen servers in the
  sources behave the same. Lockstep host migration stays a feature of the hosted backend.

## 3. Game-facing API (additions only)

```csharp
// OneLobby.Direct, extension methods on LobbyClient (complete inside Pump, like HostAsync).
var client = new LobbyClient(config, new DataChannelTransport());   // config.DirectPort defaults to 47810

// Host: starts the embedded hub + listener, connects this client in-memory, creates the lobby.
var lobby = await client.HostDirectAsync(new DirectHostOptions { Port = 47810, Password = null, MaxPlayers = 4 });
lobby.DirectAddresses;   // e.g. ["192.168.1.20:47810"]: every non-loopback IPv4/IPv6 interface, for the UI

// Joiner: "ip", "ip:port", "[v6]:port"; port defaults to config.DirectPort.
var lobby = await client.JoinDirectAsync("203.0.113.7:47810", password: null);
```

Everything after that is the existing `Lobby` API. Errors map to the existing codes plus `direct_unreachable`
(no answer on TCP `P` within 5 s), `bad_password`, `bad_address` and `port_in_use` (host). Joiners end with
`SessionEnded("host_left")` when the host goes.

## 4. What the host is told (reference menus)

- "Your address: `192.168.1.20:47810`" with Copy. Friends on the same network use it as is.
- "Friends outside your network: forward TCP and UDP port 47810 on your router to this PC, then give them your
  public IP with the port, or use a virtual LAN (Tailscale, ZeroTier, Hamachi) and give them that address." (Factorio,
  Minecraft, Terraria wikis on forwarding; Stardew on Hamachi.) IPv6 needs the same: home routers block inbound by
  default (RFC 6092).
- "If Windows asks, allow access on Private networks." The game cannot see the answer, so the text stays on the host
  screen until someone joins.

## 5. Build list for today (keepalive session)

1. **`OneLobby.Hub` library** (netstandard2.1 + net8.0): move `Hub`, `Model`, `Crockford`, `Text`, `Clock`, `Metrics`,
   `ServerOptions` (the parts `Hub` reads) out of `OneLobby.Server`; the server references it. Server tests stay green.
2. **Hub options:** `SingleLobby`, `Password`, `IssueCodes = false`, `TurnUrls` empty. Unit tests for join-without-code,
   bad password, second lobby refused.
3. **Listener (managed, no native change):** `OneLobby.Hub` gets `DirectHubHost`: `TcpListener` on `P`, a minimal
   HTTP/1.1 upgrade (check `Upgrade: websocket`, answer `Sec-WebSocket-Accept` per RFC 6455), then
   `WebSocket.CreateFromStream(stream, isServer: true, ...)`; each socket bridges to `Hub.Connect/Receive/Disconnect`,
   and `Hub.Tick` runs from `Pump`. Not libdatachannel's WebSocket server: the shipped natives are built with
   `NO_WEBSOCKET` (`native/build-*.{sh,ps1}`), and rebuilding them is out of today's scope. Not `HttpListener`: on
   Windows a non-localhost prefix needs a URL ACL (admin). Confirm `CreateFromStream` on Unity's Mono profile before
   claiming Unity.
4. **In-memory socket:** `HubSignalingSocket : ISignalingSocket` so the host's own `LobbyClient` talks to its hub with
   no network.
5. **Port pin:** `PeerLinkOptions` gains `PortRangeBegin/End`; the host sets both to `P`.
6. **Typed-address candidate:** `PeerLinkOptions` gains `ExtraRemoteCandidates`; `JoinDirect` fills it from the address.
7. **Smoke test:** host and joiner as two processes on one machine (`127.0.0.1`), then on two LAN machines, then one
   joiner through a forwarded port. The third run is what proves the s.2 candidate rule.
8. **Docs:** a "Host by IP" recipe in `docs/recipes/` and a README line; the hosted-server docs say "later".

Scope: .NET / Unity through `OneLobby.DataChannel`, desktop. Godot (`GodotTransport`, needs a Godot `TCPServer` +
`WebSocketPeer` listener) and browsers are after the PoC.

## 6. Seams kept for later backends

- **Where the hub lives** is the only thing direct IP changes: in the host (direct) or on a server (hosted
  `onelobby-server`). `LobbyClient` already takes the hub as a `Uri` (`ITransport.ConnectSignaling`).
- **Directory vs transport**, as Steamworks splits them ("lobbies do not provide networking"): a later
  `ILobbyDirectory` (Steam lobbies, EOS lobbies, the hosted list) only answers "where is the host"; the transport
  (`ITransport`: DataChannel, Steam Networking Sockets, EOS P2P) carries the bytes. Same pattern as Mirror/FishNet
  transports and Unreal's config-selected subsystem.

## 7. Parked (later, in this order)

1. LAN discovery: the Minecraft pattern (multicast announce every 1.5 s; Mirror and Godot use UDP broadcast).
2. Optional STUN / relay (see s.8).
3. Steam and EOS backends (directory + transport per s.6).
4. UPnP / PCP auto port-open, opt-in only (CERT VU#357851).
5. Browser joiners (needs the https-to-`ws://` question tested, likely `wss` with a real certificate).
6. The hosted `onelobby-server` directory with codes, list and TURN (DESIGN s.3/6/10/13 as written).

## 8. Taste call (1)

**Should direct IP use no outside servers at all?**
Today: nothing ships. Yes: no STUN or relay, so a friend outside the network connects only after the host forwards the
port or both use a virtual LAN; nothing can ever go offline (Stop Killing Games). No: the PoC also asks a free public
STUN server for the host's public address, so more friends connect without forwarding, but every game then depends on
a server nobody here runs.
`Default:` no outside servers; STUN becomes an opt-in setting in the parked list.

## 9. Build status (2026-10-24, branch `direct-ip/poc`)

| Step | State | Where |
|---|---|---|
| 1 Hub library | done; server tests green | `server/OneLobby.Hub` (netstandard2.1 + net8.0), `HubOptions` <- `ServerOptions` |
| 2 Hub options | done, 8 unit tests | `HubOptions.SingleLobby/Password/IssueCodes`, `HubOptions.ForDirect` |
| 3 Listener | done, 5 tests over real TCP | `DirectHubHost` (TcpListener dual-stack, RFC 6455 upgrade, `CreateFromStream`) |
| 4 In-memory socket | done | `clients/dotnet/OneLobby.Direct/HubSignalingSocket.cs` |
| 5 Port pin | done | `PeerLinkOptions.PortRangeBegin/End`; one pinned port turns on libjuice ICE UDP mux, so every peer shares UDP `P` |
| 6 Typed-address candidate | done | `PeerLinkOptions.ExtraRemoteCandidates` (added after the remote description, with its `a=mid`), `NoIceServers` |
| 7 Smoke | run 1 passed; run 3 emulated on one machine (passed); real two-network run optional | `OneLobby.DataChannel.Smoke host-direct` / `join-direct` print the selected ICE pair |
| 8 Docs | done | `docs/recipes/direct-ip.md`, README, AGENTS.md, llms.txt, spec/signaling.md, self-host "later" |

Smoke run 1 (one Windows machine, two processes): `join-direct 127.0.0.1` and `join-direct <LAN IPv4>` both PASS, link
open in about 200 ms, host side of the selected pair on UDP 47810, joiner ends with `host_left`. In-process live test:
host + two joiners, both host-side pairs on the pinned port (the mux works). On one machine ICE picks a global IPv6
host candidate, so the typed-address candidate is not what connects there: **runs 2 (two LAN machines) and 3 (one
joiner through a forwarded port) are still owed, and run 3 is what proves the s.2 candidate rule.** Its evidence is the
joiner's `pair ... remote[...]` line showing the typed public address.

Run 3 emulated (2026-10-24, one machine, no second network): `join-direct <LAN IPv4> --only-typed` drops every
candidate the host offers (4 of them), so the typed address is the joiner's only way in, as for a joiner on the
internet whose view of the host's own candidates is private and unreachable. Native Windows joiner: PASS, joiner
`remote[a=candidate:1 1 UDP 2122317823 10.0.0.188 47810 typ host]` (the typed line), host learns the joiner as
`prflx`. Linux joiner in a Docker container (behind Docker's NAT, `mcr.microsoft.com/dotnet/runtime:8.0` +
`libdatachannel.so`): PASS in 588 ms, joiner `local[... typ prflx]` (its NAT-mapped address) and the same typed
remote; Windows host to Linux joiner also works. That proves the s.2 rule. Not covered: a real router's port forward
and an internet path; those are standard NAT behaviour for a static forward and remain an optional by-hand check.

Found while building: libjuice binds `P` with address reuse, so a second process can bind UDP `P` without an error;
only the TCP listener reports `port_in_use`. Kicks are per address, so two joiners on one machine (same IP) share a ban.
`WebSocket.CreateFromStream` on Unity (s.5 step 3), checked statically against Unity 6000.2.7f2: the .NET Standard
2.1 reference assembly declares it, and the runtime `System.dll` in both the `unityjit` (Mono) and `unityaot`
(IL2CPP) profiles carries it with the `ManagedWebSocket` implementation behind it. Not yet exercised in a Unity player.
