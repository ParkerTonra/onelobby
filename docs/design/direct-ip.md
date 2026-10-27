# Direct-IP hosting (proof of concept)

Status: design, 2026-10-24. Decided by Parker: OneLobby is the API layer *above* platforms; the first backend that
ships is **direct IP with join codes** (option A, approved by Parker 2026-10-24 ~13:15 PT): the host's game is the
server, and the code is the host's address in disguise, so nobody ever sees or types an IP. No server of anyone's. Steam, EOS, relay, LAN discovery and the hosted `onelobby-server`
directory are parked (s.7). For the PoC this note supersedes DESIGN s.3 (server in every handshake), s.6 (server-issued
codes), s.10 (coturn) and s.13 (docker self-hosting); those sections stay true for the parked hosted backend.

## 1. Prior art

Accessibility: no new rules. The host's address uses the s.1 rules for codes (large monospace) plus a Copy button;
nothing in the flow is on a timer.

| Source | Establishes | Backs |
|---|---|---|
| [Factorio wiki: Multiplayer](https://wiki.factorio.com/Multiplayer) | "Factorio servers use port 34197." "Factorio uses UDP only." Hidden servers: "Clients will have to connect using the server's IP address." "Make sure you configure your router's port forwarding correctly for port 34197." (spot-checked) | s.2 one fixed port, join by IP, forwarding is the host's job |
| [Factorio wiki: Multiplayer](https://wiki.factorio.com/Multiplayer) (visibility) | Server visibility "May be either public, LAN or hidden"; "Factorio's devs keep a list of all public servers that declare themselves to the service"; LAN games: "Join any game that is hosted on your local network" | s.7 later: the visibility model to copy; a public list is a convenience on top, never required |
| [Valheim: dedicated server guide](https://www.valheimgame.com/support/a-guide-to-dedicated-servers/) (crossplay) | Crossplay joins by "the public IP address and port number, a join code or via the server list"; crossplay "Runs the Server on the Crossplay backend (PlayFab)" and "transmits data via a relay server" | s.2a why our codes encode the address instead of copying Valheim's service-backed codes |
| [Crockford Base32](https://www.crockford.com/base32.html) | "Hyphens are ignored during decoding." Its check symbol "encodes the number _modulo_ 37" using "5 additional symbols" (`*~$=U`), which is why `dc1` carries its checksum in a normal character instead | s.2a code format |
| [miniupnp](https://github.com/miniupnp/miniupnp) | miniupnpc is the UPnP IGD client used to open ports on home routers; "NAT-PMP and PCP support was added to MiniUPnPd" | s.2a port mapper |
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
| [CERT VU#357851](https://www.kb.cert.org/vuls/id/357851), [RFC 6887 (PCP)](https://datatracker.ietf.org/doc/html/rfc6887) | Routers that "accept UPnP requests over the WAN"; mitigation "Disable UPnP". PCP "MAP request can be used explicitly to create a dynamic inbound mapping" | s.2a router port-open from inside the home, with a visible toggle |

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
- **One lobby per hub.** The embedded hub runs in single-lobby mode: a `join` without a hub code joins the one lobby.
  The hub's own server-issued codes (DESIGN s.6), the public list and TURN credentials are off; the join code (s.2a)
  carries the address instead.
- **Optional password**, checked by the hub on `join` (Terraria, Valheim, Factorio all offer one, none require one).
- **Host leaves = the session ends.** The hub lives in the host; there is nothing to migrate to. Listen servers in the
  sources behave the same. Lockstep host migration stays a feature of the hosted backend.

## 2a. Join codes (the address in disguise)

Valheim's short codes need PlayFab plus a relay (s.1), a service someone runs. Ours need nothing: the code *is* the
host's address, so a friend pastes it from Discord and the game decodes it locally.

**Format (`dc1`):**

| Bits | Field |
|---|---|
| 2 | version, `00` = IPv4 |
| 32 | IPv4 address |
| 16 | port |
| 5 | CRC-5 over the 50 bits above |

55 bits = **11 Crockford characters**, all from the normal 32-symbol alphabet (Crockford's own mod-37 check symbol
needs `*~$=U`, awkward to paste), shown `K3J7-X9QA-2MT` (grouped 4-4-3, hyphens and spaces ignored,
case-insensitive, i/l → 1, o → 0). The CRC catches any single mistyped character before the joiner waits on a
timeout (`bad_code` at once instead of `direct_unreachable` after 5 s). Version bits leave
room for an IPv6 or swarm-lookup code later without breaking old codes. IPv6 hosts in the PoC show the plain
address instead (an IPv6 code would be ~30 characters).

**Which address goes in the code** (host side, at `HostDirect`):
1. **Router port-open, on by default** (host-menu toggle "Open port automatically"): find the gateway, ask it to
   map TCP and UDP `P` to this PC and report its external IPv4. Try UPnP IGD (SSDP `M-SEARCH` to
   `239.255.255.250:1900`, then `GetExternalIPAddress` + `AddPortMapping`, lease 2 h, renewed while hosting,
   `DeletePortMapping` on stop), then NAT-PMP/PCP on the gateway (RFC 6887 MAP). These are requests from inside the
   home to the player's own router, the normal use; CERT VU#357851 is about routers that accept them *from the WAN*.
2. If mapping works and the external address is public: **internet code** from it.
3. If there is no UPnP/PCP, or the external address is private or carrier-grade NAT (`100.64.0.0/10`): **LAN code**
   from the PC's LAN address, plus the s.4 help text ("friends outside your network need a forwarded port or a virtual
   LAN"). A virtual-LAN address (Tailscale `100.x`, ZeroTier, Hamachi) also encodes fine as a LAN code.

The host cannot test its own internet code from inside (many routers do not hairpin), so the screen says which kind of
code it is ("Internet code" / "Same-network code") rather than claiming it works.

**Mapper:** write a small one in `OneLobby.Hub` (SSDP + two SOAP calls + NAT-PMP, a few hundred lines) instead of a
dependency: Open.NAT and Mono.Nat licences and maintenance are unverified, and miniupnpc is native.

## 3. Game-facing API (additions only)

```csharp
// Host: starts the embedded hub + listener, connects this client in-memory, creates the lobby.
var lobby = await OneLobby.HostDirect(config, new DirectHostOptions { Port = 47810, Password = null, MaxPlayers = 4, OpenPort = true });
lobby.JoinCode;          // "K3J7-X9QA-2MT"
lobby.JoinCodeKind;      // Internet | SameNetwork
lobby.DirectAddresses;   // e.g. ["192.168.1.20:47810"]: for an "Advanced" fold-out only

// Joiner: a join code, or (advanced) "ip", "ip:port", "[v6]:port"; port defaults to config.DirectPort.
var lobby = await OneLobby.JoinDirect(config, "K3J7-X9QA-2MT", password: null);
```

Everything after that is the existing `Lobby` API. Errors map to the existing codes plus `bad_code` (CRC
fails), `direct_unreachable` (no answer on TCP `P` within 5 s) and `bad_password`.

## 4. What the host is told (reference menus)

- "Join code: `K3J7-X9QA-2MT`" in large monospace with Copy, labelled "Internet code" or "Same-network code".
  The joiner's screen has one box: "Paste a join code".
- Same-network code only: "Friends outside your network can't use this code yet. Turn on UPnP on your router, or
  forward TCP and UDP port 47810 to this PC, or use a virtual LAN (Tailscale, ZeroTier, Hamachi)." (Factorio,
  Minecraft, Terraria wikis on forwarding; Stardew on Hamachi.) IPv6 needs the same: home routers block inbound by
  default (RFC 6092).
- The raw address sits under an "Advanced" fold-out, never in the main flow.
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
7. **Join code codec** (`OneLobby.Core`, pure, shared with JS later): encode/decode `dc1`, CRC-5, grouping;
   tests: round-trip, every single-character typo caught, i/l/o folding, version bits rejected when unknown.
8. **Port mapper** (`OneLobby.Hub`): UPnP IGD + NAT-PMP/PCP per s.2a, with a fake gateway in tests; `HostDirect`
   picks the code kind per s.2a and removes mappings on stop.
9. **Smoke test:** host and joiner as two processes on one machine (`127.0.0.1` code), then two LAN machines
   (same-network code), then a joiner on another network with the host's UPnP on (internet code). The third run
   proves both the router mapping and the s.2 candidate rule.
10. **Docs:** a "Host with a join code" recipe in `docs/recipes/` and a README line; the hosted-server docs say "later".

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

Factorio is the model for the whole ladder (Parker: "factorio does everything i want already"): visibility
public / LAN / hidden, and LAN and hidden games keep working with no service at all.

1. LAN game list: the Minecraft pattern (multicast announce every 1.5 s; Mirror and Godot use UDP broadcast).
   Factorio's "Browse LAN games".
2. Optional STUN / relay (see s.8).
3. Steam and EOS backends (directory + transport per s.6).
4. Browser joiners (needs the https-to-`ws://` question tested, likely `wss` with a real certificate).
5. Internet game list of strangers' games, and short codes that work behind any NAT. This is the only rung that needs
   a shared directory. SKG-safe options: a swarm where every running copy holds part of the list (BitTorrent-style
   DHT; Parker is interested, too big for now), or an optional hosted directory (`onelobby-server`, DESIGN
   s.3/6/10/13 as written; Factorio's dev-run list is the precedent). Either way it sits on top of rungs 1 and the
   PoC, never in place of them.

## 8. Taste call (1)

**Should direct IP use no outside servers at all?**
Today: nothing ships. Yes: no STUN or relay, so a friend outside the network connects only after the host forwards the
port or both use a virtual LAN; nothing can ever go offline (Stop Killing Games). No: the PoC also asks a free public
STUN server for the host's public address, so more friends connect without forwarding, but every game then depends on
a server nobody here runs.
`Default:` no outside servers; STUN becomes an opt-in setting in the parked list.

## 9. Build status (2026-10-24, branch `direct-ip/poc`; s.2a and the Node host added the same afternoon)

| Step | State | Where |
|---|---|---|
| 1 Hub library | done; server tests green | `server/OneLobby.Hub` (netstandard2.1 + net8.0), `HubOptions` <- `ServerOptions` |
| 2 Hub options | done, 8 unit tests | `HubOptions.SingleLobby/Password/IssueCodes`, `HubOptions.ForDirect` |
| 3 Listener | done, 5 tests over real TCP | `DirectHubHost` (TcpListener dual-stack, RFC 6455 upgrade, `CreateFromStream`) |
| 4 In-memory socket | done | `clients/dotnet/OneLobby.Direct/HubSignalingSocket.cs` |
| 5 Port pin | done | `PeerLinkOptions.PortRangeBegin/End`; one pinned port turns on libjuice ICE UDP mux, so every peer shares UDP `P` |
| 6 Typed-address candidate | done | `PeerLinkOptions.ExtraRemoteCandidates` (added after the remote description, with its `a=mid`), `NoIceServers` |
| 7 Join code codec | done; C# and TS against shared vectors (all 341 single-character typos caught) | `spec/reference/joincode.mjs`, `spec/vectors/joincode.json`, `OneLobby.Core/JoinCode.cs`, `onelobby` `decodeJoinCode` |
| 8 Port mapper | done; fake-gateway tests (UPnP ok/725/718, NAT-PMP ok/other port, none); not yet seen work on a real router (below) | `OneLobby.Hub/PortMapper.cs`, `onelobby/direct` `PortMapper`; `HostDirectAsync`/`hostDirect` pick the code kind |
| 9 Smoke | run 1 passed (now by code); run 3 emulated on one machine (passed); real two-network run optional | both smokes print `join code ...`; `join-direct <code>`, `--only-typed`, `--no-upnp` |
| 10 Docs | done | `docs/recipes/direct-ip.md` ("host with a join code": C#, Node host, JS join), `docs/recipes/browser-game.md` (a whole browser game hosted from Node: join link, page on the port), AGENTS.md, llms.txt |
| Node host | done (asked for 2026-10-24): TS port of `Hub` + RFC 6455 listener + port mapper; `kit.joinDirect` for Node and browser joiners | `clients/js/packages/client/src/direct/` (`onelobby/direct`), `e2e/direct-smoke.mjs`; `conformance/server/run-ts-hub.mjs` |

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
only the TCP listener reports `port_in_use`. Kicks are per address, so two joiners on one machine (same IP) share a ban. A Nostr joiner's socket address is a key it
chooses, so a kick also bans the remote address of its WebRTC link when the host saw one (not a relayed or mDNS address);
a fresh key from the same address is removed as soon as its link address resolves.
`WebSocket.CreateFromStream` on Unity (s.5 step 3), checked statically against Unity 6000.2.7f2: the .NET Standard
2.1 reference assembly declares it, and the runtime `System.dll` in both the `unityjit` (Mono) and `unityaot`
(IL2CPP) profiles carries it with the `ManagedWebSocket` implementation behind it. Not yet exercised in a Unity player.

Join codes and the Node host (2026-10-24, one Windows machine): .NET host to .NET joiner by same-network code, PASS;
Node host (`e2e/direct-smoke.mjs host`) to .NET joiner (`join-direct <code>`), PASS, host side of the pair on the
pinned UDP port; .NET host to Node joiner with `--only-typed` (4 host candidates dropped, so the code's address is the
only way in), PASS in 486 ms. The TS hub passes `conformance/server` (54 functional, the slow idle test, and the 4-test
rate-limit pass on a fresh scale-1 hub). Vitest: a Node host and two Node joiners over node-datachannel share UDP `P`
(every host candidate is on `P`).

Router on this machine: no UPnP or NAT-PMP answer, so every code was a same-network code. The PC's network is marked
**Public**, where Windows turns off network discovery and drops SSDP replies, and Windows' own UPnP NAT API
(`HNetCfg.NATUPnP`) sees no gateway either; the gateway (10.0.0.1) has no UPnP description on its common ports and does
not answer NAT-PMP. So either UPnP is off on the router or the Public profile hides it; an internet code has not been
seen yet. To check: mark the network Private and run the live test (`ONELOBBY_LIVE_UPNP=1`, then `dotnet test
server/OneLobby.Server.Tests --filter LiveRouter`). PCP proper (RFC 6887) is not implemented; NAT-PMP is, which most
PCP routers also answer.

