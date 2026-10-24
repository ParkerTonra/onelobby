# OneLobby: design

Game-agnostic multiplayer lobbies, transport, voice and text chat for indie games. Every game gets the same two buttons,
**Host lobby** and **Join lobby**; the host's own game is the server; browser and desktop players share a lobby;
everything needed to keep playing after the author is gone ships in this repo.

Status: design, 2026-10-23. No code yet. The protocol in sections 7-9 is frozen for the first build so the work streams
in section 15 can run in parallel. Working name during drafting: lobbykit.

**Name.** `OneLobby` (Parker, 2026-10-24; first drafted as Keepalive). Packages: `onelobby` (npm, unscoped),
`OneLobby.Core` + `OneLobby.Godot` (.NET, namespace `OneLobby`), server binary and image `onelobby-server`. Env vars
are `ONELOBBY_*`; the server still reads the old `KEEPALIVE_*` names for one version. The JS package keeps deprecated
`Keepalive` / `KeepaliveError` aliases for one version. The wire protocol id (`lk1`) never contained the name.

---

## 1. Prior art

Accessibility: none apply to the library itself (it draws nothing). The reference menus in the demos follow three
rules anyway: join codes use the Crockford alphabet so `i`/`l`/`o` typed by mistake still decode ([Crockford](https://www.crockford.com/base32.html));
codes are shown in a large monospace font; nothing in the lobby flow is on a timer.

| Source | Establishes | Backs |
|---|---|---|
| [Godot: high-level multiplayer](https://docs.godotengine.org/en/stable/tutorials/networking/high_level_multiplayer.html) | Browser exports have only WebSockets and WebRTC ("currently offers WebSockets and WebRTC support"); no raw UDP/TCP | s.3 transport |
| [Godot: WebRTC](https://docs.godotengine.org/en/stable/tutorials/networking/webrtc.html) | "Peers connect to a signaling server (for example a WebSocket server)". WebRTC classes are "available automatically in HTML5, but require an external GDExtension plugin on native" | s.3, s.4 |
| [Godot: WebRTCMultiplayerPeer](https://docs.godotengine.org/en/stable/classes/class_webrtcmultiplayerpeer.html) | Mesh, server (id 1) and client modes; the class "will not create offers nor set descriptions, it will only poll them": signaling is yours | s.3 topology |
| [Godot: WebRTCPeerConnection](https://docs.godotengine.org/en/stable/classes/class_webrtcpeerconnection.html) | `create_data_channel` options `ordered`, `maxRetransmits`, `maxPacketLifeTime`, `negotiated`, `id`; "Only one of maxRetransmits and maxPacketLifeTime can be specified" | s.8 channels |
| [webrtc-native](https://github.com/godotengine/webrtc-native) | Builds for `windows`, `linux`, `osx`, `android`, `ios`; Godot 4.1+ uses the GDExtension build; backed by libdatachannel | s.4 Godot client |
| [Godot: exporting for the web](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html) | "Projects written in C# using Godot 4 currently cannot be exported to the web." Threads need `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` | s.5 |
| [Godot blog, 2025-05-09](https://godotengine.org/article/live-from-godotcon-boston-web-dotnet-prototype/) | A C#-on-web prototype works; "we cannot commit to a specific timeline yet"; "we only support invariant mode" | s.5 |
| [MDN: using data channels](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels) | "most modern browsers support sending messages of at least 256 kilobytes"; without `max-message-size` in SDP "a default value of 64 kilobytes is assumed" | s.8 chunking |
| [MDN: connectivity](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity), [RFC 8838](https://www.rfc-editor.org/rfc/rfc8838.html) | A signaling channel is mandatory; trickle ICE exchanges candidates "incrementally" while gathering | s.7 signaling |
| [Twilio: STUN/TURN](https://twilio.com/en-us/stun-turn) | STUN alone works "around 85% of the time"; the rest need a TURN relay | s.10 relay |
| [coturn](https://github.com/coturn/coturn), [turnserver.conf](https://raw.githubusercontent.com/coturn/coturn/master/examples/etc/turnserver.conf) | Free TURN/STUN server, `docker run coturn/coturn`; `use-auth-secret` + `static-auth-secret` = "TURN REST API"; `min-port`/`max-port` default 49152-65535 | s.10, s.13 |
| [draft-uberti-behave-turn-rest](https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest-00) | Time-limited TURN credentials: username = `expiry:userid`, password = base64(HMAC-SHA1(secret, username)) | s.10, s.12 |
| [PeerJS server](https://github.com/peers/peerjs-server) | A signaling server that only brokers: "Data is not proxied through the server"; runs as `npm`, `peerjs --port 9000`, or Docker | s.3 server scope |
| [Chrome: timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88) | Hidden tabs: timers once per second; intensive once-per-minute throttling is skipped for pages using WebRTC; `requestAnimationFrame` pauses when hidden | s.4 browser host |
| [Steam: ISteamMatchmaking](https://partner.steamgames.com/doc/api/ISteamMatchmaking) | "if the current owner leaves, another user in the lobby will become the owner automatically"; lobby types private / friends-only / public / invisible; owner-set key/value metadata; max 250 | s.6, s.9 |
| [Steam networking](https://partner.steamgames.com/doc/features/multiplayer/networking), [GameNetworkingSockets](https://github.com/ValveSoftware/GameNetworkingSockets) | SDR is a relay over Valve's backbone; the open library does ICE P2P with your own signaling and "Steam is not needed" | s.2 vendor adapters |
| [Photon PUN: host migration](https://doc.photonengine.com/pun/v2/gameplay/hostmigration) | Server "assigns another actor in the room as the new Master Client" (lowest actor number); "Photon does not move player properties or cached events" | s.9 host leaves |
| [Photon Fusion: disconnect/reconnect](https://doc.photonengine.com/fusion/v2/technical-samples/fusion-disconnect-reconnect) | Host migration rebuilds the session from a pushed snapshot: "A snapshot must be pushed." | s.9 |
| [Photon: matchmaking checklist](https://doc.photonengine.com/realtime/current/lobby-and-matchmaking/matchmaking-and-lobby) | "Use the same AppId and AppVersion in all clients and builds"; friends "make up a room name and everyone just uses JoinOrCreateRoom"; private rooms are created invisible | s.7 version gate, s.6 codes |
| [Nakama: authoritative multiplayer](https://heroiclabs.com/docs/nakama/concepts/multiplayer/authoritative/) | Match labels "usable via the Match Listing API to filter matches"; Apache-2, Docker; needs a database | s.6 listing, s.13 |
| [Colyseus: room lifecycle](https://docs.colyseus.io/room/lifecycle) | Rooms dispose "when there are no more clients left in the room, and autoDispose is set to true"; `allowReconnection()` on unexpected drop | s.9 lifetimes |
| [Playroom: isHost](https://docs.joinplayroom.com/api-reference/js/isHost) | One boolean gates host-only code | s.4 API |
| [Rune: philosophy](https://developers.rune.ai/docs/how-it-works/philosophy) | Predict-rollback with a server that "will decide which one shot first, and rollback"; deterministic logic in one file | s.3 sync modes |
| [1500 Archers on a 28.8](https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond) | Commands "issued during turn 1000 would be scheduled for execution during turn 1002"; 200 ms turns; desyncs caught with checksums; turn length "weighted so it would quickly rise" with latency; RNG call-count bugs | s.3, s.8 lockstep |
| [GGPO](https://www.ggpo.net/) | Rollback "predict[s] what it expects the remote players to do based on previously seen inputs"; needs "a fully deterministic peer-to-peer engine" with save/restore | s.3 why no rollback in MVP |
| [Factorio wiki: Multiplayer](https://wiki.factorio.com/Multiplayer) | "All instances of the game run full simulations of the entire world"; "only player actions are transferred"; "Players automatically quit game after 3 desyncs"; "Server doesn't stop/slow down the game when some client is too slow"; mod checksums compared on join | s.8 frames, s.9 desync |
| [Gaffer: deterministic lockstep](https://gafferongames.com/post/deterministic_lockstep/) | "Floating point determinism is a complicated subject"; may differ "between debug and release builds" | s.14 Lowkey notes |
| [Crockford Base32](https://www.crockford.com/base32.html) | "10 digits and 22 letters", excluding "I L O U"; decoding maps i/l to 1 and o to 0 | s.6 codes |
| [Stop Killing Games](https://www.stopkillinggames.com/), [Wikipedia](https://en.wikipedia.org/wiki/Stop_Killing_Games) | "If you purchase a good, it shouldn't self-destruct"; acceptable outcomes: "an offline mode or the ability to host private servers"; games left "in a reasonably functional state after discontinuation" | s.2 goals, s.13 |
| [SIPSorcery](https://github.com/sipsorcery-org/sipsorcery) | Pure C# WebRTC exists, under a BSD-3 licence with an added use restriction. Reason the .NET client uses Godot's engine classes instead (s.4) | s.4 |
| [RFC 6716 (Opus)](https://www.rfc-editor.org/rfc/rfc6716.html) | "designed to handle a wide range of interactive audio applications"; 6 to 510 kbit/s; frames of 2.5-60 ms, "20 ms frames are a good choice for most applications" | s.9a voice |
| [Mumble: audio settings](https://www.mumble.info/documentation/user/audio-settings/) | Opus; "Using 20 ms gives a very low delay without the risk of audible audio device driver issues"; transmission modes "Push To Talk" and "Voice Activity" | s.9a |
| [Steam: ISteamUser voice](https://partner.steamgames.com/doc/api/ISteamUser#GetVoice) | Compressed voice "can be transmitted by your application"; poll "once per frame, and at worst no more than four times a second"; decoder "supports any sample rate from 11025 to 48000" | s.9a |
| [Godot: WebRTCPeerConnection](https://docs.godotengine.org/en/stable/classes/class_webrtcpeerconnection.html), [Godot WebRTC report 2](https://godotengine.org/article/godot-webrtc-report2/) | Godot's WebRTC surface is data channels (`create_data_channel`); no media track API in the class reference. Voice therefore travels as Opus frames in a data channel | s.9a |
| [MDN: AudioEncoder (WebCodecs)](https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder) | Browser-native audio encoding; "not Baseline because it does not work in some of the most widely-used browsers"; secure context; available in workers | s.9a browser codec |
| [Godot: recording with microphone](https://docs.godotengine.org/en/stable/tutorials/audio/recording_with_microphone.html) | Mic capture via an audio bus effect; needs "Audio > Driver > Enable Input"; iOS needs the Record session category | s.9a Godot capture |

Unverified items were dropped. Among Us / Jackbox code lengths (6 and 4 characters) rest on press coverage only and are
mentioned as colour, never as a rule.

---

## 2. Goals and non-goals

| Goals | Non-goals (v1) |
|---|---|
| Host lobby / Join lobby in every game, two calls | Accounts, friends lists, presence (games or adapters do that) |
| The host's own game is the server (listen server), no second install | Dedicated headless servers (possible later: a client with no renderer hosts) |
| Browser and desktop peers in one lobby over WebRTC data channels | Video |
| Deterministic lockstep with host-ordered command frames, plus raw messaging for games that bring their own netcode | Rollback/prediction netcode (GGPO-style). Needs save/restore every frame; wrong fit for a 20 TPS management sim |
| Voice chat (Opus over its own data channel: push-to-talk, voice activity, mute, per-player volume) and text chat (lobby and in-game) as first-class channels, never seen by the server | Voice mixing servers (SFU/MCU), recording, moderation services |
| Agent-friendly docs: `AGENTS.md`, `llms.txt`, one recipe per engine, copy-paste examples, so an AI coding agent integrates a game in one session | A hosted docs site with search |
| Stop Killing Games by construction: default server is a setting, server + relay are open source, one binary or `docker compose up`, games run offline | Matchmaking by skill, ranked, anti-cheat |
| No vendor dependency: Steam / Epic / Discord are optional adapters that plug into the same lobby API | Cross-engine RPC or scene replication (Godot's `MultiplayerSynchronizer` and friends stay the game's business) |
| Small: a game integrates in one afternoon; the server runs on a Raspberry Pi | Persistence of lobbies across server restarts |

---

## 3. Architecture

```
 ┌──────────────┐   wss (JSON signaling)   ┌──────────────┐   wss   ┌──────────────┐
 │ Host game    │◄────────────────────────►│   onelobby-server     │◄───────►│ Joiner game  │
 │ (desktop or  │                          │ lobby list   │         │ (browser or  │
 │  browser)    │                          │ codes, ICE   │         │  desktop)    │
 └──────┬───────┘                          └──────────────┘         └──────┬───────┘
        │              WebRTC data channels (DTLS, binary frames)          │
        └──────────────────────────────┬────────────────────────────────────┘
                                       │ when direct fails (~15%, Twilio)
                                ┌──────┴──────┐
                                │   coturn    │  TURN relay, UDP + TCP/TLS 443
                                └─────────────┘
```

| Part | Role | Sees game data? |
|---|---|---|
| `onelobby-server` (signaling + lobby server) | Lobby registry, join codes, public list, game/version gate, SDP/ICE forwarding, hands out STUN/TURN URLs with time-limited credentials, rate limits | Never (PeerJS model: "Data is not proxied") |
| coturn (relay) | Standard TURN. Relays encrypted DTLS packets for peers that cannot connect directly | Encrypted bytes only |
| Client library (`onelobby`, `OneLobby.Core`) | Protocol state machine, lockstep scheduler, chunking, host migration rule, text chat, voice packetization, events | Yes |
| Transport adapter (`OneLobby.Godot`, browser `RTCPeerConnection`) | Opens peer connections and three data channels per peer; audio capture/playback and the Opus codec | Yes |
| Game | Encodes commands to bytes, applies frames, reports state hashes, provides snapshot/restore | Owner |

**Topology: star through the host.** Each joiner holds one WebRTC connection to the host; peer-to-peer messages route
through the host (one `route` byte, s.8). Reasons: one ICE negotiation per joiner (a 4-player lobby is 3, a mesh is 6);
the host is already the authority for frame ordering; browser hosts stay cheap. Godot's `WebRTCMultiplayerPeer` offers the
same server/client shape (id 1 = server). Mesh is a later option for games that want it (s.16).

**Sync modes** (one per lobby, set by the host's config):

| Mode | Who orders | What the library does | Fits |
|---|---|---|---|
| `lockstep` | Host assigns every command to a tick and broadcasts a frame per tick | Frame scheduling, catch-up, state-hash comparison, snapshot-based late join, host migration with no state transfer (every peer has the state) | Deterministic sims (Lowkey: 20 TPS, every action a Command) |
| `raw` | The game | Reliable/fast send, broadcast, routing, events, lobby | Games with their own netcode (host-authoritative arcade games, turn-based) |

Rollback is out (GGPO: needs save/restore each frame and a fully deterministic engine; a management sim at 20 TPS gains
nothing from it). Rune shows the server-decides model works for small web games; `raw` mode covers it.

---

## 4. Client libraries per engine

| Target | Package | Transport | Tests without the engine? |
|---|---|---|---|
| Browser JS/TS | `onelobby` (ESM + types, zero deps) | `RTCPeerConnection` + `WebSocket` (built in) | Yes: in-memory transport, vitest |
| .NET (engine-agnostic) | `OneLobby.Core` (netstandard2.1 + net8.0) | `ITransport` interface, in-memory implementation | Yes: xunit |
| Godot 4.x C# | `OneLobby.Godot` (one `.cs` folder + the webrtc-native addon) | Godot's `WebRtcPeerConnection` / `WebRtcDataChannel` / `WebSocketPeer` engine classes, typed in C#; webrtc-native supplies the native implementation (Godot WebRTC doc) | Through Godot headless only |
| Godot GDScript | later; same wire protocol | same engine classes | |
| Unity / MonoGame C# | later: `OneLobby.Core` + a transport over any .NET WebRTC stack | | |

Why engine classes for Godot and no pure-.NET WebRTC: the one pure C# stack found (SIPSorcery) carries a licence use
restriction that an open framework cannot pass on; Godot's classes are typed in C#, free of that, and identical on a
future web export (s.5). The core/transport split keeps the scheduler and protocol testable under `dotnet test`.

**Browser as host.** A hidden tab clamps timers to once per second (Chrome 88 blog); pages using WebRTC escape the
once-per-minute tier. Consequences: the JS client drives its tick from `setInterval` in a dedicated Worker when
available, with the main thread as fallback; the host demo shows "keep this tab open" while hosting; host migration
(s.9) moves the host role off a peer that stops sending frames for 3 s. `requestAnimationFrame` is never used for
network timing (it pauses when hidden).

---

## 5. Godot 4 C# on the web: verified status and what it means

Verified 2026-10-23: the stable Godot docs say "Projects written in C# using Godot 4 currently cannot be exported to the
web." The Godot blog (2025-05-09) reports a working prototype with "we cannot commit to a specific timeline yet" and
invariant-globalization-only; the engine forum shows no shipped release through 2026-04.

| Consequence | Decision |
|---|---|
| Lowkey cannot run in a browser today | Lowkey's first multiplayer is desktop ⇄ desktop over WebRTC through `onelobby-server` + coturn. Browser cross-play for Lowkey waits on Godot; nothing in this design changes when it arrives (the browser supplies the WebRTC classes Godot already uses) |
| "Browser + desktop in one lobby" must still be proven now | The cross-play proof is the JS demo (browser) with the Godot C# demo (desktop) playing the same deterministic demo game (s.15, stream E's `spec/demo-game.md`) |
| Godot web exports need COOP/COEP headers for threads | `deploy/` ships a Caddy snippet that sets them for any game page it serves |
| Lowkey's sim uses `InvariantGlobalization` already | Matches the prototype's invariant-only constraint; keep it |

---

## 6. Lobbies and join codes

| Rule | Value | Basis |
|---|---|---|
| Code alphabet | Crockford Base32: `0-9` + 22 letters, no `I L O U` | Crockford: avoids 1/0 confusion and "accidental obscenity" |
| Code length | 6 characters (1.07e9 codes). Shown as `7HQ 4K2`, typed with or without the space | Among Us-style six characters; 4 is enough only for a server that serves one game at a time |
| Decoding | Case-insensitive; `i`/`l` → `1`, `o` → `0` | Crockford |
| Who issues | `onelobby-server`, unique among live lobbies on that server, never reused for 24 h | server-side uniqueness (Photon: room names unique per app) |
| Visibility | `public` (listed + joinable by code), `unlisted` (code only), `private` (code only, host approves each join) | Steam lobby types public / friends-only / private; Photon "private rooms are created invisible" |
| Metadata | Host-set key/value strings, ≤ 16 keys, ≤ 64 chars each; the list filters on them | Steam `SetLobbyData` (owner only); Nakama labels filter listing |
| Capacity | `maxPlayers` 2-64 by game config; `onelobby-server` hard cap 250 | Steam cap 250 |
| Lifetime | Closes when the last peer leaves (Colyseus `autoDispose`); phase `in_game` lobbies drop off the public list unless `lateJoin` is on | |
| Reconnect | A dropped peer may rejoin the same lobby with its `resumeToken` within 60 s and keep its `peerId` | Colyseus `allowReconnection` |

Lobby list entry: `code, gameId, netVersion, name, hostName, players/maxPlayers, phase, meta, region (coarse, from the
server's own tag), createdAt`. The list is per `gameId` + `netVersion` (s.7); a game never sees another game's lobbies.

---

## 7. Wire protocol, part 1: signaling (client ⇄ onelobby-server)

Transport: one WebSocket (`wss://`), text frames, one JSON object per frame, ≤ 16 KiB. Protocol id `"lk1"`. Every
message has `t` (type). Unknown types and unknown fields are ignored (additive evolution); a breaking change bumps `lk1`
to `lk2` and the server speaks both for one release.

**Version gate.** `hello` carries `gameId` and `netVersion`. Lobbies are partitioned by both (Photon: same AppId and
AppVersion in all clients). `netVersion` is the game's *compatibility* version, set by the game (Lowkey: its sim/save
version, e.g. `"3"`), independent of build numbers, so a cosmetic patch keeps lobbies compatible. A join with another
`netVersion` fails with `version_mismatch` and the host's value, so the UI can say "host is on 4, you are on 3".

Client → server:

| `t` | Fields | Notes |
|---|---|---|
| `hello` | `proto:"lk1", gameId, netVersion, client:{lib, ver, platform}, name, resumeToken?` | First message. `name` ≤ 24 chars, control chars stripped by the server |
| `create` | `name, maxPlayers, visibility, mode:"lockstep"\|"raw", tickRate, lateJoin:bool, meta{}` | Reply `lobby` with the code; sender becomes host (`peerId` 1) |
| `join` | `code` | Reply `lobby` or `error` |
| `list` | `visibility:"public", meta?{}, limit≤100, cursor?` | Reply `lobbies` |
| `leave` | | |
| `signal` | `to, sdp?{type,sdp}, ice?{candidate,sdpMid,sdpMLineIndex}` | Forwarded verbatim to `to` as `signal{from,...}` (trickle ICE, RFC 8838). Only between members of one lobby |
| `meta` | `meta{}` | Host only; replaces the lobby's metadata |
| `phase` | `phase:"in_game"\|"lobby"` | Host only |
| `kick` | `peerId` | Host only |
| `approve` | `peerId, ok:bool` | Host only, `private` lobbies |
| `ping` | `n` | Reply `pong{n}`; both sides time out after 30 s silence |

Server → client:

| `t` | Fields | Notes |
|---|---|---|
| `welcome` | `peerId? , ice:[{urls[], username?, credential?, ttl?}], serverTime, limits{maxMsg, maxPlayers}` | `ice` is the STUN/TURN list with TURN REST credentials (s.10) |
| `lobby` | `code, gameId, netVersion, hostId, you, mode, tickRate, lateJoin, phase, meta, peers:[{peerId, name, joinedAt}], resumeToken` | Full state, sent on create/join/rejoin |
| `peer_joined` | `peer:{peerId,name}` | To everyone already in |
| `peer_left` | `peerId, reason:"left"\|"kicked"\|"timeout"` | |
| `host_changed` | `hostId` | Server mirror of the peer-side rule (s.9) |
| `join_request` | `peer:{peerId,name}` | To the host of a `private` lobby |
| `lobbies` | `items:[...], cursor?` | |
| `signal` | `from, sdp?, ice?` | |
| `error` | `code, msg, data?` | Codes: `bad_request, unknown_code, lobby_full, in_game, version_mismatch, game_not_allowed, rate_limited, not_host, kicked, server_full` |

**Connection flow** (joiner J, host H):

1. J `hello` → `welcome`. J `join{code}` → `lobby`; H gets `peer_joined`.
2. H creates an `RTCPeerConnection` for J with three data channels (s.8), makes the offer, sends `signal{to:J, sdp}`;
   both trickle `ice`.
3. Data channels open. J sends `hi` (s.8) on the reliable channel; H replies `welcome_dc` then `chat_history`. From here
   the signaling socket is only for roster changes and migration; if `onelobby-server` dies mid-game, the game continues
   (s.9). Chat and voice work from this point on, in the lobby phase and in game.
4. In `lockstep`, if `phase` is already `in_game`: snapshot + catch-up (s.8).

---

## 8. Wire protocol, part 2: data channels (peer ⇄ peer)

Three negotiated channels per connection (Godot and MDN: `negotiated:true` with a fixed `id`):

| Channel | id | Options | Carries |
|---|---|---|---|
| `reliable` | 0 | `ordered:true` | Everything in lockstep mode, control messages, snapshots, text chat, `raw` reliable sends |
| `fast` | 1 | `ordered:false, maxRetransmits:0` | `raw` mode unreliable sends (positions, cosmetics), pings |
| `voice` | 2 | `ordered:false, maxRetransmits:0` | Opus voice packets only, so voice never queues behind a snapshot (s.9a) |

Binary frames; little-endian; one message per frame; **≤ 16 KiB per frame** (MDN: 64 KiB is the SDP default, 256 KiB
in modern browsers; 16 KiB leaves headroom for libdatachannel and older stacks). Bigger payloads use `chunk`.

Header (3 bytes): `type:u8, route:u16` (0 = for the host or broadcast; otherwise the destination `peerId` when sent
to the host, the source `peerId` when received from it: the host rewrites it when relaying).

| type | Name | Body | Direction |
|---|---|---|---|
| 0x01 | `hi` | `proto:u8=1, peerId:u16, lastTick:i64` | joiner → host, after channels open |
| 0x02 | `welcome_dc` | `tick:i64, tickRate:u8, mode:u8, hostId:u16` | host → joiner |
| 0x10 | `cmd` | `seq:u32, len:u16, bytes[len]` | peer → host (lockstep). Game-encoded command |
| 0x11 | `frame` | `tick:i64, n:u16, n × (peerId:u16, len:u16, bytes[len])` | host → all (host included, through its own queue). Commands in `peerId` then arrival order; empty frames are sent too (`n = 0`) |
| 0x12 | `hash` | `tick:i64, hash:u64` | peer → host every `hashEvery` ticks |
| 0x13 | `desync` | `tick:i64, hostHash:u64, yourHash:u64` | host → one peer, before `snapshot` |
| 0x14 | `snapshot_req` | `sinceTick:i64` | joiner/resyncing peer → host |
| 0x15 | `snapshot` | `tick:i64, total:u32, flags:u8 (1 = deflate)` then `chunk`s | host → one peer. Host buffers frames from `tick` on for that peer |
| 0x16 | `chunk` | `id:u32, index:u16, count:u16, bytes[]` | either way; reassembled by the library |
| 0x20 | `raw` | `bytes[]` | `raw` mode payload; `route` as above |
| 0x30 | `ping` / 0x31 `pong` | `n:u32, t:u32` | on `fast` |
| 0x40 | `host_claim` | `epoch:u16, hostId:u16, tick:i64` | migration (s.9) |
| 0x50 | `voice` | `seq:u16, flags:u8 (bit0 = end of talk burst), n:u8, n × (len:u16, opus[len])` | speaker → host → every other peer on `voice`; `route` = speaker (s.9a) |
| 0x60 | `chat` | `id:u32, ts:i64, len:u16, utf8[len]` | sender → host → all on `reliable`; `route` = sender; host stamps `id`/`ts` (s.9b) |
| 0x61 | `chat_history` | `n:u16, n × (peerId:u16, id:u32, ts:i64, len:u16, utf8[len])` | host → joiner, after `welcome_dc` |
| 0x62 | `chat_reject` | `id:u32, reason:u8 (1 = rate, 2 = length, 3 = muted_by_host)` | host → sender |

**Lockstep scheduling** (host-ordered command relay):

| Rule | Value | Basis |
|---|---|---|
| Frame cadence | Host emits `frame(T)` every `1000/tickRate` ms on its own clock; it never waits for a slow peer | Factorio: the server "doesn't stop/slow down the game when some client is too slow" |
| Command placement | A `cmd` goes into the next frame the host has not yet emitted. Nothing is dropped, only delayed | 1500 Archers: inputs scheduled for a later turn (N+2); here the host picks N from arrival |
| Effective input delay | host: 1 tick; joiner: RTT + ≤ 1 tick (≈ 2-4 ticks at 20 TPS on a 60 ms RTT) | 200 ms turns were playable for an RTS (1500 Archers) |
| Local feel | The game may predict its own cosmetic effects (Lowkey already moves the avatar locally and reports `Moved`); state changes wait for the frame | Factorio latency hiding |
| Peer behind | `TryNextFrame` returns frames as fast as the game asks; a peer > 2 frames behind runs ticks without rendering until caught up (cap 10× real time) | Factorio catch-up |
| Peer far behind | > `tickRate × 3` frames behind, or 3 s of no frames from the host (host-side: no `hash` from a peer for 10 s): `snapshot_req` | |
| Hash check | `hash(tick)` every `hashEvery` (default `tickRate`, i.e. once a second). Host compares to its own hash for that tick | 1500 Archers checksums; Factorio desync detection |
| Desync policy | The host is truth. Mismatch → `desync` + `snapshot` to that peer, game gets `Desync` event. Third resync in one session → peer dropped with reason `desync` | Factorio: "quit game after 3 desyncs" |
| Late join | Host sends `snapshot(tick S)` and buffers frames ≥ S for the joiner; joiner restores, then catches up | Factorio map download + catch-up |
| Snapshot size | Chunked, optional deflate; a 5 MB snapshot on a 10 Mbit/s link joins in ~5 s | |

The game owns command encoding: the library carries bytes. Recommended: the game's existing serializer (Lowkey: JSON with
the `$cmd` discriminator, later MessagePack if size matters).

---

## 9. Host leaves, host migration, desync, server loss

| Event | lockstep | raw |
|---|---|---|
| Host leaves cleanly or times out (no frames 3 s, DTLS closed) | New host = lowest `peerId` still connected (Photon: lowest actor number; Steam: automatic owner migration). It sends `host_claim{epoch+1}` to every peer it can reach and `phase`/`host_changed` to `onelobby-server`; others reconnect their WebRTC to it (one ICE round, ~1-3 s). Frames resume from the last frame all survivors agree on (`min(lastTick)`, each peer replays its buffered frames to there). Commands in flight are lost; the game sees `HostChanged` | Lobby ownership migrates the same way; the game gets `HostChanged` and either restores from its own `Snapshot` (if it set one) or ends the session with `host_left`. Photon Fusion needs a pushed snapshot for the same reason; PUN moves no state |
| Two claims (split) | Higher `epoch` wins; equal epoch → lower `peerId` wins. Losing claimant demotes itself | same |
| Joiner leaves | `peer_left`; its pending commands are dropped; the game decides what its avatar does | same |
| `onelobby-server` unreachable mid-game | Game continues on data channels; no new joins; migration still works peer-side (`host_claim`), the server mirror catches up on reconnect | same |
| coturn unreachable | Only relayed peers drop; they reconnect through another ICE round if a path exists | same |
| Desync | s.8 policy | n/a |

Stop Killing Games consequence: a running game depends on no server after the handshake; a lobby server outage costs
only new joins.

---

## 9a. Voice chat

Godot's WebRTC surface is data channels only (no media track API in `WebRTCPeerConnection`), so voice is **Opus frames in
the `voice` data channel**, the same on every platform; browser-to-browser lobbies use the identical path, so one code
path and one relay story.

| Rule | Value | Basis |
|---|---|---|
| Codec | Opus, 48 kHz mono, 20 ms frames, 24 kbit/s default (16-40 configurable), VBR, in-band FEC on | RFC 6716 ("20 ms frames are a good choice"); Mumble 20 ms |
| Packetization | 2 frames per `voice` packet (40 ms, 25 packets/s, ~130 bytes); `seq` for jitter buffer and loss concealment | Steam: poll at most 4 times/s suggests batching; 40 ms keeps latency low |
| Transmission modes | `pushToTalk` (default) and `voiceActivity` (RMS gate with 300 ms hangover); `flags.bit0` marks the end of a burst so receivers flush | Mumble modes |
| Routing | Star through the host like everything else: host forwards each packet to the other peers, no mixing, `route` = speaker. Host upstream = (N-1) × speakers × 26 kbit/s: 4 players all talking ≈ 240 kbit/s | PeerJS/Steam relay model; mixing servers are a non-goal |
| Relay | Same peer connection, so TURN carries voice when it carries the game; relayed voice costs the same as direct | coturn |
| Receive side | 60 ms jitter buffer, Opus PLC on gaps, per-peer gain (0-2.0), local mute per peer, master mute, output to the game's audio bus | |
| Capture | Browser: `getUserMedia` + `AudioWorklet`; encode with WebCodecs `AudioEncoder("opus")` where present, else a WASM libopus build. Godot: mic bus + `AudioEffectCapture` (project setting `audio/driver/enable_input`); encode with a managed Opus port behind an `IVoiceCodec` interface (candidate: Concentus; licence to be verified by stream D) | MDN WebCodecs (not Baseline); Godot mic doc |
| Limits | ≤ 8 concurrent speakers per lobby (host drops the 9th burst with no error); voice packets ≤ 1 KiB; host rate-caps 30 packets/s per peer | |
| Privacy | Voice never touches `onelobby-server`; `relayOnly` lobbies still hide IPs; a joiner's voice is off until the player opts in | |
| Lockstep | Voice is outside the sim: never in a frame, never hashed | |

API additions (both languages; see s.11): `lobby.voice.enabled`, `.mode`, `.pushToTalk(bool down)`, `.muted` (self),
`.setMuted(peerId, bool)`, `.setVolume(peerId, float)`, `.inputLevel`, events `speaking(peerId, bool)`, `voiceError`.

## 9b. Text chat

| Rule | Value |
|---|---|
| Channel | `chat` on `reliable`, sender → host → all; host stamps `id` (monotonic) and `ts`; the server never sees text |
| Scope | Works from the moment data channels open: lobby phase and in-game alike. Late joiners get `chat_history` (last 100 lines) |
| Limits | 256 UTF-8 bytes per message; 5 messages per 5 s per peer, burst of 3; control characters and bidi overrides stripped at the host; `chat_reject` tells the sender why |
| Mute / block | Local mute (`setMuted` also drops that peer's chat); host mute (`lobby.chat.hostMute(peerId, bool)`: the host drops their messages for everyone, `chat_reject 3`); block lists persist only through the game (no accounts) |
| Moderation | Kick stays the host's tool; profanity filtering is the game's choice; the library exposes a `filter: (text) => text` hook |
| System lines | Join/leave/host-change notices are generated locally from roster events, never sent as chat |

API additions: `lobby.chat.send(text)`, `lobby.chat.history`, `lobby.chat.hostMute(peerId, bool)`, event
`chat(peerId, text, id, ts)`, `chatRejected(id, reason)`.

---

## 10. NAT traversal and relay fallback

| Step | What | Basis |
|---|---|---|
| 1 | Host candidates + STUN reflexive candidates; direct path wins ~85% of the time | Twilio |
| 2 | TURN over UDP 3478 | coturn default |
| 3 | TURN over TCP and TLS on 443 for networks that block UDP | coturn `listening-port`/`tls-listening-port`; standard practice |
| creds | `onelobby-server` mints `username = expiry:peerId`, `credential = base64(HMAC-SHA1(secret, username))`, TTL 1 h, sent in `welcome`. coturn runs `use-auth-secret` + `static-auth-secret` with the same secret | draft-uberti-behave-turn-rest; coturn conf |
| policy | `iceTransportPolicy` stays `all`; a lobby can be created `relayOnly` to hide IPs from strangers (public lobbies default on, friends lobbies default off) | Steam SDR's IP-hiding rationale |
| ports | coturn relay range `min-port`/`max-port` narrowed to 49160-49400 in the shipped config (one port per relayed peer) | coturn conf |
| telemetry | `onelobby-server` counts `relayed` vs `direct` from a `path` field each peer reports after ICE completes, so Parker can see the real relay share | Twilio's 15% is a vendor figure; measure |

---

## 11. Game-facing API

### 11.1 C# (`OneLobby.Core`; Godot uses it unchanged plus `new GodotTransport()`)

```csharp
namespace OneLobby;

public enum SyncMode { Lockstep, Raw }
public enum Channel { Reliable, Fast }
public enum Visibility { Public, Unlisted, Private }
public enum LobbyPhase { Lobby, InGame }

public sealed record OneLobbyConfig(
    string GameId,                    // "com.lowkeyindustries.lowkey"
    string NetVersion,                // "3": compatibility version (s.7)
    Uri LobbyServer,                  // from game data; default wss://lobby.onelobby.example
    SyncMode Mode = SyncMode.Lockstep,
    int TickRate = 20,
    int HashEveryTicks = 20,
    string DisplayName = "Player",
    bool RelayOnly = false);

public sealed record LobbyOptions(
    string Name, int MaxPlayers = 4, Visibility Visibility = Visibility.Unlisted,
    bool LateJoin = true, IReadOnlyDictionary<string, string>? Meta = null);

public sealed record LobbySummary(string Code, string Name, string HostName, int Players, int MaxPlayers,
    LobbyPhase Phase, IReadOnlyDictionary<string, string> Meta, string Region, DateTimeOffset CreatedAt);

public sealed record Peer(int PeerId, string Name, int PingMs, bool Relayed);
public readonly record struct Frame(long Tick, IReadOnlyList<(int PeerId, ReadOnlyMemory<byte> Command)> Commands);
public sealed record DesyncInfo(long Tick, ulong HostHash, ulong LocalHash, int ResyncCount);
public sealed record LobbyError(string Code, string Message);

public interface ITransport { /* implemented by OneLobby.Godot and the in-memory test transport */ }

public sealed class LobbyClient : IAsyncDisposable
{
    public LobbyClient(OneLobbyConfig config, ITransport transport);
    public Task<Lobby> HostAsync(LobbyOptions options, CancellationToken ct = default);
    public Task<Lobby> JoinAsync(string code, CancellationToken ct = default);          // accepts "7HQ 4K2", "7hq4k2"
    public Task<Lobby> RejoinAsync(string resumeToken, CancellationToken ct = default); // within 60 s of a drop
    public Task<IReadOnlyList<LobbySummary>> ListAsync(IReadOnlyDictionary<string, string>? metaFilter = null,
                                                       CancellationToken ct = default);
    public event Action<LobbyError>? Error;
}

public sealed class Lobby : IAsyncDisposable
{
    public string Code { get; }
    public int LocalPeerId { get; }
    public int HostPeerId { get; }
    public bool IsHost { get; }
    public LobbyPhase Phase { get; }
    public IReadOnlyList<Peer> Peers { get; }
    public IReadOnlyDictionary<string, string> Meta { get; }
    public string ResumeToken { get; }
    public LockstepSession? Lockstep { get; }               // null in Raw mode
    public VoiceChannel Voice { get; }                      // s.9a
    public TextChat Chat { get; }                           // s.9b

    public Task StartAsync();                               // host: Phase -> InGame
    public Task SetMetaAsync(IReadOnlyDictionary<string, string> meta); // host
    public Task KickAsync(int peerId);                      // host
    public Task ApproveAsync(int peerId, bool ok);          // host, Private lobbies
    public Task LeaveAsync();

    public void Send(int peerId, ReadOnlySpan<byte> payload, Channel channel = Channel.Reliable);
    public void Broadcast(ReadOnlySpan<byte> payload, Channel channel = Channel.Reliable);

    public void Pump();                                     // once per frame; raises events on the calling thread

    public event Action<Peer>? PeerJoined;
    public event Action<Peer, string>? PeerLeft;            // reason: left | kicked | timeout | desync
    public event Action<Peer>? JoinRequested;               // Private lobbies, host only
    public event Action<int>? HostChanged;                  // new host's peerId
    public event Action<LobbyPhase>? PhaseChanged;
    public event Action<int, ReadOnlyMemory<byte>, Channel>? MessageReceived;   // from, payload
    public event Action<string>? SessionEnded;              // host_left (Raw, no Snapshot) | kicked | server_closed
}

public sealed class LockstepSession
{
    public long Tick { get; }                               // last tick handed out by TryNextFrame
    public int FramesBuffered { get; }                      // > 2 means "run without rendering" (catch-up)
    public void Submit(ReadOnlySpan<byte> command);          // my command; host assigns the tick
    public bool TryNextFrame(out Frame frame);              // false = waiting on the host
    public void ReportHash(long tick, ulong hash);          // call every HashEveryTicks
    public Func<byte[]>? Snapshot { get; set; }             // host side: full state (required for LateJoin and resync)
    public Action<long, ReadOnlyMemory<byte>>? Restore { get; set; } // joiner side: load state as of tick
    public event Action<DesyncInfo>? Desync;
}

public enum VoiceMode { PushToTalk, VoiceActivity }

public sealed class VoiceChannel
{
    public bool Enabled { get; set; }                       // off until the player opts in
    public VoiceMode Mode { get; set; }
    public void PushToTalk(bool down);
    public bool Muted { get; set; }                         // my mic
    public void SetMuted(int peerId, bool muted);           // also drops that peer's chat
    public void SetVolume(int peerId, float gain);          // 0..2
    public float InputLevel { get; }                        // 0..1 for a mic meter
    public IVoiceCodec Codec { get; set; }                  // Opus implementation; OneLobby.Godot supplies one
    public IVoiceAudio Audio { get; set; }                  // capture + playback adapter (Godot buses / Web Audio)
    public event Action<int, bool>? Speaking;               // peerId, talking
    public event Action<string>? VoiceError;
}

public sealed record ChatLine(int PeerId, uint Id, long Ts, string Text);

public sealed class TextChat
{
    public void Send(string text);                          // ≤ 256 UTF-8 bytes
    public IReadOnlyList<ChatLine> History { get; }         // last 100
    public void HostMute(int peerId, bool muted);           // host only
    public Func<string, string>? Filter { get; set; }       // game's profanity hook, applied on receive
    public event Action<ChatLine>? Received;
    public event Action<uint, string>? Rejected;            // id, reason: rate | length | muted_by_host
}
```

Game loop, lockstep (Godot `_Process`):

```csharp
lobby.Pump();
while (lobby.Lockstep!.TryNextFrame(out var f))
{
    foreach (var (peer, bytes) in f.Commands) sim.Enqueue(Codec.Decode(bytes, peer), CommandSource.Player);
    sim.Tick();
    if (sim.State.Tick % 20 == 0) lobby.Lockstep.ReportHash(sim.State.Tick, sim.StateHash());
    if (lobby.Lockstep.FramesBuffered <= 2) break;          // render this frame; keep draining when behind
}
```

### 11.2 JS / TypeScript (`onelobby`)

```ts
import { OneLobby } from "onelobby";

const kit = new OneLobby({
  gameId: "dev.example.gridpaint", netVersion: "1",
  lobbyServer: "wss://lobby.onelobby.example",          // a setting; the demo reads it from a <meta> tag
  mode: "lockstep", tickRate: 20, hashEveryTicks: 20, displayName: "Parker", relayOnly: false,
});

const lobby = await kit.host({ name: "Parker's game", maxPlayers: 4, visibility: "public", lateJoin: true, meta: {} });
const lobby = await kit.join("7HQ 4K2");
const lobby = await kit.rejoin(resumeToken);
const list: LobbySummary[] = await kit.list({ meta: { map: "farm" } });

lobby.code; lobby.localPeerId; lobby.hostPeerId; lobby.isHost; lobby.phase; lobby.peers; lobby.meta; lobby.resumeToken;
await lobby.start(); await lobby.setMeta({}); await lobby.kick(peerId); await lobby.approve(peerId, true); await lobby.leave();

lobby.send(peerId, bytes: Uint8Array, { channel: "fast" });
lobby.broadcast(bytes);
lobby.on("peerJoined", (peer) => {}); lobby.on("peerLeft", (peer, reason) => {});
lobby.on("joinRequested", (peer) => {}); lobby.on("hostChanged", (hostId) => {});
lobby.on("phase", (phase) => {}); lobby.on("message", (from, bytes, channel) => {});
lobby.on("sessionEnded", (reason) => {}); kit.on("error", (err) => {});

// lockstep
lobby.lockstep.submit(bytes);
let f: Frame | null; while ((f = lobby.lockstep.nextFrame())) { /* f.tick, f.commands: {peerId, bytes}[] */ }
lobby.lockstep.reportHash(tick, hash: bigint);
lobby.lockstep.snapshot = () => Uint8Array;  lobby.lockstep.restore = (tick, bytes) => {};
lobby.lockstep.on("desync", (info) => {});
lobby.lockstep.framesBuffered;

// voice (s.9a) and text chat (s.9b)
lobby.voice.enabled = true; lobby.voice.mode = "pushToTalk"; lobby.voice.pushToTalk(down);
lobby.voice.muted = false; lobby.voice.setMuted(peerId, true); lobby.voice.setVolume(peerId, 1.5);
lobby.voice.inputLevel; lobby.voice.on("speaking", (peerId, talking) => {}); lobby.voice.on("error", (e) => {});
lobby.chat.send("gg"); lobby.chat.history; lobby.chat.hostMute(peerId, true); lobby.chat.filter = (t) => t;
lobby.chat.on("message", ({ peerId, id, ts, text }) => {}); lobby.chat.on("rejected", (id, reason) => {});
```

No `pump()` in JS: events fire from the event loop. Both APIs are the same shape on purpose so the demos and the
conformance harness read alike.

---

## 12. Security basics

| Threat | Measure |
|---|---|
| Server abuse | Per IP: 10 `create`/min, 60 `join`/min, 20 `signal`/s per peer, 8 open lobbies; per socket 4 KiB max signaling message, 30 s idle timeout; global `maxLobbies`/`maxPeers` from config → `server_full` |
| Relay freeloading | TURN credentials are HMAC-signed with 1 h TTL (draft-uberti); coturn `total-quota` and `user-quota`; bandwidth cap per allocation (`max-bps`) |
| Code guessing | 1.07e9 codes, 60 joins/min/IP, `unlisted`/`private` never listed; `private` needs host approval |
| Hostile peers | The host validates everything a game cares about; the library validates framing only. The sim's own command validation is the anti-cheat for lockstep (Lowkey: `Command.Apply` returns a rejection). The library never executes client data |
| Impersonation | `peerId` is assigned by `onelobby-server` and stamped by the host on relay; a client cannot pick its id or forge `route` |
| Eavesdropping | WebRTC is DTLS-encrypted by spec; signaling is `wss://`; the shipped compose has Caddy with automatic TLS |
| Unwanted games on a public instance | Optional `allowedGameIds` list + per-`gameId` quotas in `onelobby-server` config (taste call 2 decides the default for Parker's instance) |
| Names and metadata | Length caps, control characters stripped, server treats them as opaque strings; profanity policy is the game's |
| Chat spam / voice flooding | Host enforces 5 msgs per 5 s and 256 bytes (`chat_reject`), 30 voice packets/s and ≤ 8 speakers; anything else is dropped silently; host mute and kick for people |
| Harassment | Local mute (voice + text) always available and instant; host mute; block lists live in the game (no accounts in v1) |
| Logging | `onelobby-server` logs lobby events and IP-hashed rate-limit hits; never SDP bodies (they contain addresses) past debug level |

---

## 13. Self-hosting story

| Piece | Form |
|---|---|
| `onelobby-server` | Single-file self-contained .NET build (linux-x64, linux-arm64, win-x64, osx-arm64; Native AOT where it builds), flags or env: `--listen :8080 --turn-urls turn:relay.example:3478,turns:relay.example:443 --turn-secret ... --public-url wss://lobby.example --allowed-games ... --max-lobbies 1000`. `/healthz`, `/metrics` (Prometheus) |
| Relay | Stock `coturn/coturn` image + the shipped `turnserver.conf` (REST auth, narrowed port range, quotas) |
| TLS | Caddy with automatic certificates in front of both (`compose.yaml`); COOP/COEP snippet for serving a Godot web build |
| One command | `git clone … && cp .env.example .env && docker compose up -d` on a 1 vCPU VM or a Raspberry Pi 4 |
| In the game | `lobby_server` is a setting shown under Multiplayer → Advanced with the default pre-filled; Lowkey also takes `--lobby-server=`. Games ship fully playable offline; multiplayer is the only part that touches the network |
| Default instance | Parker hosts `wss://lobby.onelobby.example` (name TBD) with the same images; the domain is the only thing a self-hoster changes |
| Docs | `deploy/RUN_YOUR_OWN.md`: five steps, a port table (8080, 3478 udp/tcp, 443, relay range), a smoke test |
| Agent docs | Root `AGENTS.md` (what the repo is, the API surface in one screen, the rules) and `llms.txt` (links to every recipe and the API reference in plain text); `docs/recipes/{godot-csharp,js-web,dotnet-generic,raw-mode,voice-and-chat,self-host}.md`, each a copy-paste integration under 150 lines with a "done when" check. Plain files, nothing in the protocol |
| Release | Every tag publishes `onelobby-server` binaries + images; the game's "About → Multiplayer" screen links this repo. Satisfies "an offline mode or the ability to host private servers" (SKG) |

Why C# for `onelobby-server` (taste call 1, decided 2026-10-23 by the desk under Parker's go-ahead): .NET 10 is already on
Parker's machine and Go is not; one language across server, `OneLobby.Core` and Lowkey; ASP.NET Core WebSockets +
single-file/AOT publish still give one file to run, and the Docker image is the self-host default.

---

## 14. Lowkey Industries integration notes

What exists today (read 2026-10-23): `Simulation.Enqueue(Command, CommandSource)` queues; `Tick()` applies the pending
batch in order then runs the fixed 20 TPS step; `Save()`/`Load()` round-trip `WorldState` as JSON; `StateHash()` is
FNV-1a over `Save()`; `Command` is `[JsonPolymorphic("$cmd")]`; `Main.Send(Command)` is the one place UI input enters;
the Godot loop accumulates `delta × TicksPerSecond` and calls `Sim.Tick()` per whole tick.

| Change | Where | Why |
|---|---|---|
| `Main.Send` → `lobby.Lockstep.Submit(Codec.Encode(c))` when in a lobby; the tick loop becomes the s.11.1 loop (`TryNextFrame` drives `Sim.Tick()`), so the local player's command also arrives through a frame | `game/Scripts/Main.cs` | Identical order on every peer |
| `Codec`: `System.Text.Json` with the existing `$cmd` polymorphism, UTF-8 bytes; add `PeerId` to the frame-applied command's `CommandSource` context | `game/Scripts/Net/` (new) | Zero new serialization; commands are plain data by design |
| Hash cost: `StateHash()` serializes the whole world; measure at a day-30 save. If > 2 ms, add an incremental FNV over the ordered collections, or hash every 5 s | `src/LowkeyIndustries.Sim` | 20 TPS budget; `BenchmarkTests` already measure sim cost |
| Per-peer players: `WorldState.Player` is one `PlayerState` (cash, location, avatar tile). Co-op needs `Players: List<PlayerState>` keyed by peer, shared business state, `Moved{Peer}` | `src/.../State/WorldState.cs`, `Commands.cs`, every `sim.State.Player` call site | The sim has no notion of "who" yet; this is the real integration work (taste call 3 picks the shape) |
| Determinism audit: the sim already keeps RNG in state and uses ordered collections; add a two-process replay test: same seed, same command log, `StateHash` equal every 20 ticks (desktop ⇄ desktop first) | `tests/` | Gaffer: floating point differs by build; the sim must be checked across machines, Release vs Debug |
| `No fast-forward` rule and `FastForwardUntil`: in a lobby the host's frame clock is the only clock; a sleep is just more frames at 10× | design | Lockstep makes it the natural rule |
| Save/load in co-op: the host's `Save()` is the snapshot; a joiner's `Load()` is `Restore`. Scenario/content mismatch (`PeekScenario`) maps to `netVersion` = `SaveVersion` + scenario id, e.g. `"3-unplug"` | `Simulation.cs` | Reuses what exists |
| Menu: Multiplayer → Host lobby / Join lobby / Browse; join code field with the Crockford decode; settings → `lobby_server` | `game/` UI | Section 6 |
| Voice and chat: push-to-talk key in the input map, a mic meter in the lobby, a chat line in the HUD (code-only UI); voice output on its own audio bus so music ducks | `game/` UI | s.9a, s.9b |
| Web: none until Godot ships C# web export (s.5) | | |

A `netVersion` bump every time `SaveVersion` or the command set changes keeps a patched client from meeting an unpatched
host in a lobby (Photon AppVersion practice).

---

## 15. Work split

Seven streams for Sonnet agents, in parallel, against the frozen protocol (s.7-s.9b). No two streams edit the same files;
root files `README.md`, `LICENSE` (MIT), `.github/` belong to the desk; `AGENTS.md` and `llms.txt` belong to stream G.
`spec/` is the single machine-readable copy of sections 6-9b; only stream E edits it, every stream consumes it. Voice and
chat are protocol (E), JS implementation (C) and .NET implementation (D); they add no stream.

| # | Stream | Owns | Consumes | Provides | Done when |
|---|---|---|---|---|---|
| A | Signaling / lobby server | `server/` (.NET 10 ASP.NET Core minimal app `OneLobby.Server` + `OneLobby.Server.Tests`) | `spec/signaling.schema.json`, `spec/codes.json`, `spec/turn-rest.md` | A `onelobby-server` binary + `ghcr` image; `/healthz`; TURN REST creds | `dotnet test server/` green; `conformance/server` suite (stream E) passes 100%; two `wscat` sessions can create/list/join and exchange a `signal`; 1,000 lobbies / 5,000 sockets on one core in the load script |
| B | Relay + self-host packaging | `deploy/` (`compose.yaml`, `Caddyfile`, `turnserver.conf`, `.env.example`, `RUN_YOUR_OWN.md`, `scripts/smoke.sh`, systemd unit) | Stream A's image name and flags (from DESIGN s.13) | A working `docker compose up` stack | `docker compose config` validates; `scripts/smoke.sh` written for a clean Ubuntu VM (`/healthz` 200 over TLS, `turnutils_uclient` allocation with REST creds minted by `onelobby-server`, TCP 443 TURN with UDP blocked) and run locally when Docker is up; a `scripts/turn-creds-check` proves the server's HMAC creds match coturn's `use-auth-secret` algorithm |
| C | JS client + browser demo | `clients/js/` (`packages/client`, `demo/`) | `spec/*`, `spec/demo-game.md` | `onelobby` ESM + `.d.ts` including `voice` (WebCodecs/WASM Opus, AudioWorklet) and `chat`; `demo/` = gridpaint (s.15.1) with a chat line and push-to-talk | `vitest` with the in-memory transport covers the lockstep scheduler, chunking, Crockford decode, migration rule, chat limits, voice packetization; two tabs on `localhost` host/join via a local `onelobby-server` and play gridpaint 60 s with equal hashes; a third tab late-joins via snapshot and receives `chat_history`; closing the host tab migrates within 5 s; a tone played into tab A's mic input is heard in tab B |
| D | .NET core + Godot client + demo | `clients/dotnet/` (`OneLobby.Core`, `OneLobby.Core.Tests`, `OneLobby.Godot`, `demo-godot/` with webrtc-native addon) | `spec/*`, `spec/demo-game.md` | NuGet-shaped `OneLobby.Core` (incl. `TextChat`, `VoiceChannel`, `IVoiceCodec`), `OneLobby.Godot` (transport, Godot audio capture/playback, Opus codec with a verified-licence managed port) + demo scene | `dotnet test` green (same cases as C against the in-memory transport); two headless Godot instances host/join through a local `onelobby-server` and play gridpaint 60 s with equal hashes; **cross-play**: the Godot demo hosts, stream C's browser demo joins, hashes equal for 60 s, a chat line crosses both ways, a voice test tone from Godot decodes in the browser |
| E | Protocol spec + conformance harness | `spec/` (JSON schemas, binary test vectors incl. `voice`/`chat` frames, `codes.json`, `demo-game.md`), `conformance/` (Node) | DESIGN.md s.6-s.9b only | The frozen spec as files; `conformance/server` (drives any `onelobby-server` over WebSocket: every message, every error code, rate limits); `conformance/peer` (a scripted fake host/joiner that drives any client lib: frames, desync, snapshot, migration, chat limits, voice forwarding) | Vectors round-trip in both C and D's codecs; `conformance/server` red against an empty server, green against stream A; `conformance/peer` runs against C and D |
| F | Lowkey integration notes + spike | `integrations/lowkey/` (notes, `hash-cost.md`, `codec/` sample + test) | `OneLobby.Core` API (s.11.1), Lowkey repo read-only | Exact change list for the Lowkey repo (s.14 expanded to file + line), measured `StateHash()` cost at day 1/15/30 saves, a `Codec` round-trip test over every Lowkey `Command` type | `dotnet test` in `integrations/lowkey/codec` green against a Lowkey build; notes reviewed by the desk (the desk, not stream F, adds any pointer in the Lowkey repo) |
| G | Agent-friendly docs | `AGENTS.md`, `llms.txt`, `examples/tictactoe/` (single-player JS skeleton, no networking), `docs/` (`recipes/`, `api/` generated from C's `.d.ts` and D's XML docs by `docs/build.mjs`) | The public API of C and D (s.11), `deploy/RUN_YOUR_OWN.md` | Plain-file docs an agent reads first: one-screen API surface, the rules (ids not names, bytes not objects, host is truth), six recipes ≤ 150 lines each with a "done when", copy-paste snippets that compile | `docs/build.mjs` regenerates `docs/api/` with no diff on a clean tree; the **agent test**: a fresh Sonnet agent given only `AGENTS.md` and the sentence "add OneLobby raw-mode multiplayer with chat to `examples/tictactoe`" ships a passing `conformance/peer` run in one session without opening `clients/`; every snippet in `docs/recipes/` is extracted and compiled by `docs/check-snippets.mjs` in CI |

### 15.1 Shared demo game: gridpaint (`spec/demo-game.md`, owned by E)

A 16×16 grid; each peer owns a colour; command = `paint x y` (3 bytes); tick 20 TPS; every tick, each painted cell
spreads to one neighbour chosen by an xorshift32 RNG seeded from the lobby code; hash = FNV-1a 64 over the grid bytes.
Small enough to port in an hour in JS and C#, random enough to catch ordering bugs, and the only game the harness needs.

### 15.2 Order

A, B, C, D, E start together against this document; E's files land within the first day so C and D swap their hand-typed
vectors for the real ones; F and G start when D has `OneLobby.Core` compiling and C has its `.d.ts` (G drafts the recipes
from s.11 before that and reconciles). The cross-play "done when" in D plus G's agent test are the MVP exit.

---

## 16. MVP scope vs later

| MVP (this build) | Later |
|---|---|
| `onelobby-server`, coturn config, compose, docs | Prometheus dashboards, multi-region server tags |
| JS + .NET/Godot clients, lockstep + raw | GDScript wrapper, Unity/MonoGame transport, mesh topology |
| Codes, public list, unlisted/private, kick, approve | Invites via platform adapters (Steam / Discord / Epic lobbies as an optional `ILobbyDirectory`) |
| Host migration in lockstep; `raw` with game snapshot | Dedicated headless host (a client with no renderer) |
| Snapshot late join, desync resync | Deterministic replay recording/playback as a library feature |
| Rate limits, TURN REST creds, TLS | Accounts/authentication adapter, allowlisted instances with API keys |
| Text chat with history, local and host mute | Persistent block lists through platform adapters |
| Voice: `voice` channel, Opus 20 ms, PTT + VAD, mute, per-peer volume, JS and Godot codecs | Mesh voice for lobbies > 8 speakers, noise suppression, spatial audio hooks |
| `AGENTS.md`, `llms.txt`, six recipes, generated API reference, snippet CI | Hosted docs site |
| Cross-play demo (browser ⇄ Godot desktop) with chat and a voice tone | Lowkey browser play (waits on Godot C# web export) |

---

## 17. Open questions settled by practice

| Question | Answer | Basis |
|---|---|---|
| Lockstep: wait for slow peers or keep the clock? | Keep the clock; slow peers catch up | Factorio 0.14 |
| Who orders commands? | The host, by arrival into the next unsent frame | 1500 Archers (scheduled turns), simplified |
| Desync: whose state wins? | Host's; resync the other; drop after 3 | Factorio "3 desyncs" |
| Who becomes host when the host leaves? | Lowest remaining `peerId`, automatic | Photon PUN, Steam lobbies |
| Does the framework move state on migration? | Lockstep: no need; raw: only if the game supplies a snapshot | Photon PUN (moves nothing) and Fusion (snapshot required) |
| Mesh or star? | Star through the host; mesh later | Godot server/client mode; fewer ICE rounds |
| Can a lobby outlive its server? | Yes, the running game does | SKG; PeerJS "data is not proxied" |
| Code alphabet and length | Crockford, 6 | Crockford; collision budget |
| How are versions matched? | `gameId` + `netVersion` partition | Photon AppVersion |
| Relay? | coturn with REST credentials; TCP/TLS 443 fallback | coturn, draft-uberti |
| Message size | ≤ 16 KiB, chunk above | MDN 64 KiB default |
| Browser host timing | Worker timer; WebRTC exempts the page from intensive throttling | Chrome 88 blog |
| Pure .NET WebRTC? | No: licence; use Godot engine classes | SIPSorcery licence |
| Voice as media tracks or data? | Opus in a data channel: Godot has no track API; one path everywhere | Godot class reference |
| Voice frame size and rate | 20 ms Opus, 2 per packet, ~24 kbit/s | RFC 6716, Mumble, Steam poll rate |
| Who relays voice? | The host, unmixed, like game data; server never sees it | PeerJS model, non-goal: SFU |
| Chat through the server? | No: host-relayed on `reliable`; history from the host | SKG (no server dependency), privacy |

---

## 18. Taste calls for Parker (3)

**1. Write the lobby server in Go?**
Today: nothing exists. Yes: `onelobby-server` is a Go static binary (one file, cross-compiles to a Raspberry Pi, matches the coturn/Nakama
ecosystem; ~1,500 lines, no game logic). No: C# with `dotnet publish --self-contained -p:PublishSingleFile=true` (one language
across the repo; ~70 MB binary, slower start, ARM builds still fine).
`Default:` Go. **Decided: C#** (Go is not installed; one language across the repo; see s.13).

**2. Should your public lobby server accept any game?**
Today: the design supports both. Yes: any developer can point their game at `lobby.onelobby.example` with no sign-up; per-game quotas
(say 200 lobbies / 2,000 peers each) cap the damage, and the relay bill is yours. No: your instance serves an allowlist (Lowkey +
games you add by hand); others self-host or ask.
`Default:` yes, open with per-game quotas, and the relay set to `relayOnly: false` so most traffic never touches your coturn.

**3. Is Lowkey multiplayer co-op on one business?**
Today: the sim has one `PlayerState`. Yes: every player walks their own avatar around the same business (shared cash, machines, heat,
quests), any player can issue any command; the sim grows a `Players` list and `Moved{Peer}`. No: rival businesses on one map
(separate cash and heat, shared town and Turf), a much larger sim change and a different game.
`Default:` yes, shared-business co-op, 2-4 players.
