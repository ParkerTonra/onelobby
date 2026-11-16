# OneLobby for AI coding agents

OneLobby is an open-source, game-agnostic multiplayer kit: a lobby server (join codes, public list), a TURN relay, and
client libraries (`onelobby` for JS; `OneLobby.Core` + a transport for C#: `OneLobby.Godot`, `OneLobby.DataChannel`
(libdatachannel WebRTC for any .NET app) or the `com.onelobby.unity` package). Peers talk over WebRTC data channels;
the server never sees game data.
Pick a mode: `lockstep` (deterministic sim, host orders commands per tick) or `raw` (you send bytes, you own the netcode).
Real-time host-authoritative games (shooters, physics, AI; anything non-deterministic) use `raw` plus
`OneLobby.Replication` (C#), `ReplicationSession` (JS) or `OneLobbyReplicationSession` (GDScript), same wire: delta snapshots, interpolation, inputs, events (C# also has prediction and lag-compensation helpers).
You do not need to open `clients/`, `server/` or `spec/` to integrate a game. This file plus one recipe is enough.

## API surface (same shape in both languages)

```csharp
// C#: OneLobby.Core + a transport: new DataChannelTransport() (any .NET), new GodotTransport(), Unity: new UnityTransport() or OneLobbyRunner
var client = new LobbyClient(new OneLobbyConfig("com.you.game", "1", new Uri(lobbyServerUrl),
                             SyncMode.Raw, DisplayName: "Ann"), transport);
Lobby lobby = await client.HostAsync(new LobbyOptions("Ann's game", MaxPlayers: 4, Visibility: Visibility.Public));
Lobby lobby = await client.JoinAsync("7HQ 4K2");          // also RejoinAsync(resumeToken)
IReadOnlyList<LobbySummary> list = await client.ListAsync();
client.Pump();                                             // only until you hold a Lobby (Host/Join/List complete here)
lobby.Pump();                                              // then this, every frame; events fire on the calling thread
lobby.Send(peerId, bytes); lobby.Broadcast(bytes);         // Channel.Reliable (default) or Channel.Fast
lobby.MessageReceived += (from, payload, channel) => { };
lobby.PeerJoined / PeerReady / PeerFailed / PeerLeft / HostChanged / PhaseChanged / SessionEnded
lobby.Ready += () => { }; await lobby.ReadyAsync;          // joiner: link to host open (host: at once)
await lobby.StartAsync(); await lobby.KickAsync(id); await lobby.LeaveAsync();   // KickAsync bans; DisconnectAsync(id, code?, reason?) does not
bool sent = await lobby.FlushAsync(TimeSpan.FromSeconds(1));   // before LeaveAsync: last reliable messages leave first (keep pumping)
lobby.Chat.Send("gg"); lobby.Chat.Received += line => { };
lobby.Pause.Request(true); lobby.Pause.State;              // shared pause: { Paused, ByPeer, PauserLeft }; Changed / Refused events
lobby.Pause.CanResume; lobby.Pause.Policy = (peer, wantPaused) => true; lobby.Pause.Clear();   // Policy and Clear: host only
lobby.Room.Entries; lobby.Room.SetData(new Dictionary<string, string> { ["color"] = "#ff8800" }); lobby.Room.SetReady(true);   // roster: Name, Role, Seat, Ready, Status, Data
lobby.Room.Start(); lobby.Room.CancelCountdown(); lobby.Room.BackToLobby(); lobby.Room.Rematch();   // host; CountdownUpdated / Started / BackedToLobby events
lobby.Room.Kick(id, reason: "..."); lobby.Room.Ban(id, reason: "..."); lobby.Room.Unban(playerId);   // the player sees lobby.Removal; bans persist (lobby.Room.Bans)
lobby.Room.SeatDropped += s => { }; lobby.Room.Changed += () => { }; lobby.Room.Filter = (text, kind) => text;   // docs/recipes/room.md
await client.HostAsync(new LobbyOptions("x", 4) { Password = "x", Room = new RoomOptions { Spectators = 2, AutoStart = AutoStartMode.AllReady } });
await client.JoinAsync(code, new RoomJoinOptions { Password = "x", Role = RoomRole.Spectator });
lobby.Voice.Enabled = true; lobby.Voice.PushToTalk(down);
lobby.Voice.ReleaseHangMs = 150; lobby.Voice.MuteAll(true); lobby.Voice.IsMuted(id); lobby.Voice.InputLevel; lobby.Voice.IsTransmitting;
lobby.Lockstep!.Submit(cmd); while (lobby.Lockstep.TryNextFrame(out var f)) { /* f.Tick, f.Commands */ }
lobby.Lockstep.ReportHash(tick, hash); lobby.Lockstep.Snapshot = () => bytes; lobby.Lockstep.Restore = (tick, b) => { };
```

```csharp
// C#: OneLobby.Replication, on a SyncMode.Raw lobby (docs/recipes/replication.md)
var rep = new ReplicationSession(lobby);                   // 30 Hz tick + snapshots, 100 ms interpolation
rep.Pump();                                                // every frame, instead of lobby.Pump()
NetId id = rep.Spawn(typeId, ownerPeerId, entity);         // host; entity : IReplicatedEntity { Write(NetWriter) }
while (rep.Clock.TryAdvance()) { rep.TryGetInput(peer, out InputFrame f); /* sim step */ rep.SendSnapshot(); }   // host
while (rep.Clock.TryAdvance()) rep.SubmitInput(inputBytes);                                                   // client
rep.EntitySpawned / EntityDespawned / EventReceived / HostLost; rep.SendEvent(bytes);
rep.SendEvent(bytes, peer, Channel.Reliable, stream: 3); rep.EventDelivered += e => { /* e.Stream, e.Seq */ }; rep.EventGap += g => { /* g.Stream, g.FirstMissing, g.NextDelivered */ };
rep.TrySample<TState>(id, out var s);                      // client: TState : IReplicatedState<TState>, at rep.RenderTick
rep.RttMs; rep.PeerRttMs(peer); rep.SnapshotAgeMs; rep.InputStatsFor(peer); rep.SendFullSnapshot(peer);   // overlay, resync
new Reconciler<TInput, TState>(start, step); new HistoryRing<T>(ticks, lerp); rep.RewindTick(f);   // prediction, hitscan
new PredictionSmoother().Correct(dx, dy, dz, sequence); smoother.Update(ms); smoother.Offset; NetMath.LerpOrSnap(a, b, t, maxDistance);
```

```ts
// JS replication (docs/recipes/replication.md s.5): const rep = new ReplicationSession(lobby) on a mode "raw" lobby; rep.pump() every frame;
//   host: rep.spawn(type, owner, replicated(schema, () => state)); while (rep.clock.tryAdvance()) { rep.tryGetInput(peer); rep.sendSnapshot(); }
//   client: rep.submitInput(bytes) per tick; rep.trySample(id, schema); rep.on("entitySpawned" | "entityDespawned" | "eventDelivered" | "eventGap" | "hostLost", ...); rep.sendEvent(bytes, { to, stream })
//   rep.trafficRates / rep.stats / rep.describe(bytes) / rep.packetLog = true; keyframe (reliable full snapshot) on join and every 5 s
// JS: onelobby (no pump(): events come from the event loop)
const kit = new OneLobby({ gameId: "com.you.game", netVersion: "1", lobbyServer, mode: "raw", displayName: "Ann" });
const lobby = await kit.host({ name: "Ann's game", maxPlayers: 4, visibility: "public" });
const lobby = await kit.join("7HQ 4K2");                   // also kit.rejoin(resumeToken), kit.resume()
const list = await kit.list();                             // LobbySummary[]
const lobby = await kit.hostNostr({ maxPlayers: 4 });      // host from this browser tab: no Node, no port; lobby.joinCode is a Nostr code
lobby.hostHidden; lobby.on("hostHiddenChanged", (hidden) => {});   // browser host: hidden tabs are throttled, keep it visible
lobby.send(peerId, bytes); lobby.broadcast(bytes);         // { channel: "fast" } optional
lobby.on("message", (from, bytes, channel) => {});
lobby.on("peerJoined" | "peerReady" | "peerLeft" | "hostChanged" | "phase" | "sessionEnded", handler);
lobby.on("peerFailed", (peer, reason) => {});              // host: a joiner never got connected ("a friend could not connect")
lobby.on("ready", () => {}); await lobby.ready;            // joiner: link to host open (host: at once)
await lobby.start(); await lobby.kick(id); await lobby.leave();   // kick bans the address; lobby.disconnect(id, code?, reason?) does not
lobby.chat.send("gg"); lobby.chat.on("message", ({ peerId, text }) => {});
lobby.pause.request(true); lobby.pause.state;              // shared pause: { paused, byPeer, pauserLeft }; "changed" / "refused" events
lobby.pause.canResume; lobby.pause.policy = (peer, wantPaused) => true; lobby.pause.clear();   // policy and clear: host only
lobby.room.entries; lobby.room.setData({ color: "#ff8800", team: "1" }); lobby.room.setReady(true);   // roster: name, role, seat, ready, status, data
lobby.room.start(); lobby.room.cancelCountdown(); lobby.room.backToLobby(); lobby.room.rematch();     // host; "countdown" / "started" / "backToLobby" events
lobby.room.kick(id, { reason }); lobby.room.ban(id, { reason }); lobby.room.unban(playerId);          // reason shown to the player; bans persist (kit.bans)
lobby.room.on("seatDropped" | "seatRestored" | "changed" | "removed" | "requested", handler); lobby.room.filter = (text, kind) => text;   // docs/recipes/room.md
await kit.host({ password: "x", room: { spectators: 2, autoStart: "all_ready" } }); await kit.join(code, { password: "x", role: "spectator" });
const ws = lobby.asWebSocket();                            // joiner: WebSocket-shaped link to the host (text; { binary: true })
lobby.onConnection((conn) => { conn.onmessage = (e) => conn.send(e.data); });   // host: one WebSocket-shaped conn per joiner
lobby.voice.enabled = true; lobby.voice.pushToTalk(down);
lobby.lockstep.submit(cmd); for (let f; (f = lobby.lockstep.nextFrame()); ) { /* f.tick, f.commands */ }
lobby.lockstep.reportHash(tick, hash); lobby.lockstep.snapshot = () => bytes; lobby.lockstep.restore = (tick, b) => {};
```

```gdscript
# Drop-in menu: add res://addons/onelobby/menu/menu.tscn (class OneLobbyMenu), then $Menu.game_started.connect(func(lobby): ...); docs/recipes/menu.md
# Web drop-in: <one-lobby server="https://..." game="my-game"> (onelobby/ui): ready, countdown, kick/ban, host settings, chat, settings, browse; el.texts = {host: "Create game"} rewords; docs/recipes/menu.md "Web"
# Godot C#: copy clients/dotnet/demo-godot/addons/onelobby_menu/ (OneLobbyMenu.cs + .tscn), then menu.GameStarted += lobby => ...; engine-free MenuModel / MenuText are in OneLobby.Core
# GDScript (Godot 4, no .NET): clients/gdscript/addons/onelobby; signals instead of events, Dictionaries {peer_id, name, ping_ms, relayed}
var client := OneLobbyClient.new()                         # a Node: add_child it, it pumps every frame; set client.sync_mode = "lockstep" before host()
client.game_id = "com.you.game"; client.lobby_server = "ws://127.0.0.1:8080/ws"; client.display_name = "Ann"; add_child(client)
var lobby := await client.host({"name": "Ann's game", "max_players": 4, "visibility": "public"})   # null on failure: client.last_error
var lobby := await client.join("7HQ 4K2")                  # also client.rejoin(token), client.host_direct(...) / join_direct(code), client.list()
lobby.send(peer_id, bytes); lobby.broadcast(bytes)         # OneLobbyWire.RELIABLE (default) or OneLobbyWire.FAST
lobby.message_received.connect(func(from: int, bytes: PackedByteArray, channel: int) -> void: pass)
lobby.peer_joined / peer_ready / peer_failed / peer_left / host_changed / phase_changed / session_ended   # signals
lobby.start(); lobby.kick(id); lobby.leave(); await lobby.leave_and_flush()    # kick bans; disconnect_peer(id, code, reason) does not
lobby.chat.send("gg"); lobby.chat.message.connect(func(line: Dictionary) -> void: pass)    # {peer_id, id, ts, text}; rejected(id, reason)
lobby.pause.request(true); lobby.pause.state                # {paused, by_peer, pauser_left}; changed(state) / refused(code) signals
lobby.pause.can_resume; lobby.pause.policy = func(peer: int, want: bool) -> bool: return true; lobby.pause.clear()   # policy and clear: host only
lobby.lockstep.submit(cmd); var f := lobby.lockstep.next_frame()   # f = {tick, commands: [{peer_id, bytes}]}, {} when none
lobby.lockstep.report_hash(f["tick"], hash)                 # a u64 in an int
lobby.lockstep.snapshot = func() -> PackedByteArray: return bytes; lobby.lockstep.restore = func(tick: int, bytes: PackedByteArray) -> void: pass
lobby.room.entries(); lobby.room.set_data({"color": "#ff8800"}); lobby.room.set_ready(true)   # roster: id, name, role, seat, ready, status, data; calls return an error code ("" = ok)
lobby.room.start(); lobby.room.cancel_countdown(); lobby.room.back_to_lobby(); lobby.room.rematch()   # host; countdown_changed / started / returned_to_lobby signals
lobby.room.kick(id, {"reason": "..."}); lobby.room.ban(id, {"reason": "..."}); lobby.room.unban(player_id)   # the player sees lobby.removal; bans persist (lobby.room.bans)
lobby.room.seat_dropped.connect(func(info: Dictionary) -> void: pass); lobby.room.changed.connect(func() -> void: pass); lobby.room.filter = func(text: String, kind: String) -> String: return text   # docs/recipes/room.md
await client.host({"password": "x", "room": {"spectators": 2, "auto_start": "all_ready"}}); await client.join(code, {"password": "x", "role": "spectator"})
# replication (docs/recipes/replication.md s.6): var rep := OneLobbyReplicationSession.new(lobby) on a raw lobby (sync.mode "replication" in onelobby.json gives one); rep.pump() every frame
#   host: rep.spawn(type_id, owner, OneLobbyReplicationSession.replicated(schema, getter)); while rep.clock.try_advance(): rep.try_get_input(peer); rep.send_snapshot()
#   client: rep.submit_input(bytes) per tick; rep.try_sample(id, schema); signals entity_spawned / entity_despawned / event_delivered / event_gap / host_lost; rep.send_event(bytes, to, channel, stream)
```

## Install

```
npm install onelobby
```

Right after a release, npm's local cache can still list only the old versions, so asking for the new one fails with
`ETARGET` even though `npm view` shows it; add `--prefer-online` to the install.

No bundler: `<script src="https://cdn.jsdelivr.net/npm/onelobby@0.7.2/dist/onelobby.global.min.js">` sets
`window.OneLobby` (so `new OneLobby.OneLobby({...})`), or import the single-file ES module
`https://cdn.jsdelivr.net/npm/onelobby@0.7.2/dist/onelobby.bundle.mjs` (`dist/onelobby.bundle.js` is the same module
for static hosts that serve `.mjs` as `text/plain`). Low-level pieces (codec, chunking,
migration, WebRTC classes) are in `onelobby/internals`; in-memory test doubles in `onelobby/testing`.

### From a clone of this repo (before a release is on npm, or to try unreleased changes)

Build it once, then point your project at the build:

```
git clone https://github.com/ParkerTonra/onelobby
cd onelobby/clients/js && npm ci && npm run build -w packages/client     # writes packages/client/dist
```

Either depend on it with a `file:` path, or bundle with an esbuild alias (no package install in your project):

```
# in your project
npm install file:/path/to/onelobby/clients/js/packages/client
# or, plain-JS project with no package.json
/path/to/onelobby/clients/js/node_modules/.bin/esbuild src/main.js --bundle --format=esm --outfile=dist/app.js \
  --alias:onelobby=/path/to/onelobby/clients/js/packages/client/dist/index.js
```

Installing a folder only links it (npm runs no build), so build before every `npm install <folder>` that should pick
up new changes. Installing a folder or a `.tgz` reworks the whole `node_modules` tree and removes any package your
`package.json` does not list, so declare every tool you use (e.g. a browser driver for tests) first. Then load the
bundle from the page: `<script type="module" src="./dist/app.js"></script>`. A page that only has
`<script type="module" src="./src/main.js">` cannot resolve the bare name `onelobby`, so bundle first.
Lobby URL: the server's WebSocket endpoint is `ws://HOST:8080/ws` (`wss://HOST/ws` behind Caddy).

## Codes and peers

The server returns codes ungrouped (`C5AFX8`); show them grouped (`C5A FX8`) with `formatCode` or by hand. `join` accepts
either form. `lobby.peers` includes the local player and the host, so a two-player lobby has `peers.length === 2` on both sides.

Useful fields: `lobby.code`, `localPeerId`, `hostPeerId`, `isHost`, `phase`, `peers`, `meta`, `name`, `resumeToken`.
Full reference (generated): `docs/api/`.

## Friendly defaults (JS)

- `readyTimeoutMs` (default 15000, 0 = wait forever): a joiner that cannot reach the host gives up. `lobby.ready`
  rejects with `OneLobbyError` code `ice_failed`, `kit.on("error")` fires, the lobby is left and `sessionEnded` fires
  with reason `"ice_failed"`. When the server offers TURN, the second half of the budget is one relay-only retry.
- `rememberSeat` (default on where `sessionStorage` exists): after a page reload `kit.join(sameCode)` takes the old
  seat back instead of joining as a new player; `await kit.resume()` does it without a code (null when there is no seat
  or the server dropped it) and `kit.rememberedCode` tells you whether there is one. Forgotten when the session ends.
- Liveness: a silently dead peer surfaces on its own within about 30 s (host: `peerLeft`; joiner: `hostChanged` after
  a migration, or `sessionEnded("host_left")` on a direct lobby). `peerTimeoutMs` (default 0 = that) shortens it using
  OneLobby's own 2 s pings (minimum 6000), so games need no heartbeat of their own.
- Host: `peerFailed(peer, reason)` fires when a joiner leaves before its link opened (its `ice_failed`, a closed tab), or
  `"timeout"` when it is not ready `readyTimeoutMs` after joining (it keeps its seat and may still connect). Once per
  peer, before that `peerLeft`; not for kicks or `disconnect()`. Use it to tell the host "a friend could not connect".
- `rateLimit: { messages, perMs }` on `host()` / `hostDirect()` caps each joiner's incoming raw messages; the excess is
  dropped before `message` fires or is relayed.
- Direct lobbies (no lobby server; `hostDirect` on Node, `kit.hostNostr()` in a browser tab) give a Nostr join code by
  default and an IP code for LAN; they have no host migration (`sessionEnded("host_left")`) and joiners talk only to the
  host. Failure code `direct_unreachable`. Details, startup lines, hub limits: `docs/recipes/direct-ip.md` section 7.
- `kit.hostNostr(options?)` hosts from a browser tab with no Node and no port (`lobby.joinCode` is a Nostr code; keep the
  tab visible, see `lobby.hostHidden`). Recipe: `docs/recipes/browser-game.md` section 6.
- Sockets close with 1000 (you closed), 1001 (the other end left), 4000 (kicked) or 1006 (`timeout`, `ice_failed`);
  `e.reason` is the lobby's reason, and `disconnect(id, code, reason)` / `kick(id, { code, reason })` pass theirs through
  (full table: `docs/recipes/direct-ip.md` section 7). The library version is `LIB_VERSION`.
- `lobby.kick(id)` bans that player's address from the lobby for as long as it lasts (a reload or new tab included).
  To end one connection without the ban (a seat taken over by another tab), use `lobby.disconnect(id, code?, reason?)`:
  the joiner's lobby ends with `sessionEnded("disconnected")` and it may join again. A ban is per address, so a player
  on a new address (another network, a VPN, a phone hotspot) can return; use a lobby password to keep strangers out.
- `asWebSocket()` fires `onopen` on a later task, like a real WebSocket, so a handler assigned after any number of
  `await`s still runs (once). `readyState === 1` also tells you it is open.
- `host()` defaults to `visibility: "unlisted"`: joinable by code or link, not shown by `list()`. Pass `"public"` to list it.
- An empty `displayName` (the default) shows to everyone as `"Player N"`, N being the seat (peer id).
- Test and runtime seams (`socketFactory`, `linkFactory`, `clock`, `wallClock`, `voiceCodec`, `createMic`,
  `createSink`, `storage`) go under `options.advanced`; the old top-level keys still work but are deprecated.

## Friendly defaults (C#)

- `OneLobbyConfig.ReadyTimeout` (default 15 s, `TimeSpan.Zero` = wait forever; set with `config with { ReadyTimeout = ... }`):
  same rules as JS `readyTimeoutMs`. `ReadyAsync` faults with `OneLobbyException` code `ice_failed`, `client.Error`
  fires, the lobby is left and `SessionEnded("ice_failed")` fires; the relay-only retry runs when the server offers
  TURN. Direct-IP joiners get the same timeout (no relay retry: direct IP has no TURN).
- Host: `PeerFailed(peer, reason)` is the same as JS `peerFailed`, with `OneLobbyConfig.ReadyTimeout` (zero = no timeout
  event) as the timer. Fires inside `Pump()`, once per peer, just before that `PeerLeft`.
- Liveness: a silent joiner is dropped after 10 s and a silent host is handled as lost after 8 s;
  `config with { PeerTimeout = TimeSpan.FromSeconds(6) }` sets both (minimum 6 s). `new LobbyOptions(...) { RateLimit =
  new RateLimit(60, 1000) }` (or `DirectHostOptions.RateLimit`) caps each joiner's incoming raw messages like JS `rateLimit`.
  A blueprint sets both from `session.peerTimeoutMs` / `session.rateLimit`, and `chat.voiceMode` sets `Voice.Mode`.
- Unity `OneLobbyRunner` sets `Application.runInBackground = true` from Host/Join until the lobby ends (then restores
  it), so an unfocused window keeps pumping; opt out with `KeepRunningInBackground = false`.
- A peer that leaves on purpose is not cut off: when the server (or a direct host's socket) says it is gone, the lobby
  keeps reading its link until that closes (C#: while frames keep arriving, until 500 ms pass with none, at most 5 s: `Lobby.LeaveGraceMs`, `LeaveMaxMs`), so messages it sent before
  `LeaveAsync` arrive before `PeerLeft` / `HostChanged` / `SessionEnded`. `FlushAsync` makes sure they left its machine.
  The same grace applies when the server times a peer out or its seat is taken over; `KickAsync` / `DisconnectAsync`
  cut it off at once.
- Every C# event (lobby, chat, voice, replication) fires synchronously inside `Pump()` on the calling thread, and
  `ReadyAsync` / `HostAsync` / `JoinAsync` complete there too: pump from the engine's main loop and touch engine APIs
  directly in handlers.
- `ReplicationSession.Clients` (host) holds only peers whose link is up (`PeerReady`); `ClientReady` fires when one
  joins it and its first snapshot is a full one.
- Shared pause (`lobby.Pause` / `lobby.pause`): default policy anyone pauses, the pauser or the host resumes; the host validates, keeps
  the state and tells everyone (late joiners too). Refusals arrive as `Refused` / `"refused"` with `not_in_game`, `rate_limited`
  (0.5 s per peer) or `not_allowed`. The pauser leaving hands the pause to the host (`PauserLeft`). In lockstep the host
  stops its frames while paused. It is outside the sim (rule 8). A blueprint `session.pause` of `off` throws `pause_disabled`,
  `host` makes the default host-only.
- Error codes are constants: `LobbyErrorCodes.LobbyFull` (C#) / `ErrorCodes.LobbyFull` (JS) = `"lobby_full"`,
  `VersionMismatch` = `"version_mismatch"`, `InGame`, `UnknownCode`, `IceFailed`, ... Compare `e.Code` / `e.code` to them.
- Closing a lobby to new players: with `lateJoin: false` joins stop for good at `StartAsync()` / `start()` (joiners get
  `in_game`). To open and close it at will, host with `Visibility.Private` / `visibility: "private"` and answer each
  `JoinRequested` / `"joinRequested"` with `ApproveAsync(peer.PeerId, joinable)` / `approve(peer.peerId, joinable)`;
  a refused joiner gets `kicked` with `data.reason` `"denied"`. Works on onelobby-server and on direct hosts.
- Renaming mid-session: `lobby.RenameAsync("New")` (C#) / `lobby.rename("New")` (JS) / `lobby.rename("New")` (GDScript).
  The hub sanitises it like the start name (at most 24 characters; names need not be unique) and every member, you
  included, gets `PeerRenamed(peer, oldName)` / `"peerRenamed"` / `peer_renamed`; `Peers` shows the new name. One
  rename per second (`rate_limited`); an empty name is `bad_request`; both arrive on the client's error event. A hub
  older than 0.7.0 cannot rename: C# and JS throw `unsupported`, GDScript returns false and emits `error`. A blueprint
  with `players.identity: "anonymous"` refuses it (`identity_anonymous`), and `players.maxNameLength` applies.
- Player-facing helpers: `describeError(e)` gives `{ code, message, hint? }` in plain language for any kit or server
  error; `shareUrl(code)` makes a `?join=7HQ-4K2` link to the current page; `codeFromUrl()` reads it back (or null).
  The same in C# (`Friendly.DescribeError(e)`, `InviteLink.Make(code, baseUrl)` / `InviteLink.Parse(text)`) and GDScript
  (`OneLobbyFriendly.describe_error(client.last_error)`, `OneLobbyInvite.make(code, base_url)` / `.parse(text)`), word for
  word and link for link, tested by `spec/vectors/describe-error.json` and `invite-link.json`.
- Telling the player why (JS, C# and GDScript, `spec/diagnostics.md`; recipe `docs/recipes/diagnostics.md`): a connect
  failure carries `err.diagnosis` = `{ cause, message, hint, stage }` next to its unchanged code, and `describeError(err)`
  returns that sentence and next step (plus `cause`, `stage`). Causes: `nat_blocked`, `relay_refused`, `relay_unreachable`,
  `udp_blocked`, `firewall`, `version_mismatch`, `host_unreachable`, `signaling_unreachable`, `timeout_unknown`. The host's
  `lobby.on("peerDiagnosis", d => d.line)` shows "Sam: strict NAT, no relay set, stopped at the connection check after 15 s."
  for a joiner who could not connect (a small report, never an address; `diagnostics: { reportToHost: false }` turns it
  off). `kit.netLog.export()` is the Copy-logs text (masked; `{ includeAddresses: true }` unmasks addresses only; also
  `save(path)`, `download()`), and `await kit.checkConnection({ iceServers })` returns `{ udp, natType, relay, verdict,
  message }` for a menu. Nothing is sent to OneLobby or any third party. C#: `OneLobbyException.Diagnosis`,
  `Friendly.DescribeError(e).Cause`, `lobby.PeerDiagnosis += d => d.Line`, `client.NetLog.Export()`, `await
  client.CheckConnectionAsync()`, options in `config.Diagnostics`. GDScript: `OneLobbyFriendly.describe_error(client.last_error)`
  has `cause` and `stage`, `lobby.peer_diagnosis` (`info["line"]`), `client.get_net_log().export()`, `await
  client.check_connection()`.

## Integrate a game: the blueprint flow

Every multiplayer choice lives in one file, `onelobby.json`, at the game's root. Schema: `spec/blueprint.schema.json`
(on npm: `onelobby/blueprint.schema.json`). Smallest valid file: `{ "game": { "id": "com.you.game" } }`; every
other key has a default. The library reads the runtime keys itself and enforces the switches, so a hand edit wins
even over code that still calls the API:

```ts
const kit = OneLobby.fromConfig(await (await fetch("./onelobby.json")).json(), { displayName });
const lobby = await kit.host();                            // maxPlayers, visibility, lateJoin, meta from the file
if (kit.blueprint.chat.voice) showVoiceButton();
```

```csharp
var bp = Blueprint.Load("onelobby.json");
var client = LobbyClient.FromBlueprint(bp, new DataChannelTransport(), displayName: "Ann");
Lobby lobby = await client.HostAsync();                    // or HostDirectAsync() from OneLobby.Direct
```

```gdscript
var client := OneLobbyClient.from_config("res://onelobby.json", {"display_name": "Ann"})   # engine "godot-gdscript"; raw or lockstep
add_child(client)                                          # client.config_error is {} unless the file is bad
var lobby := await client.host()                           # from the file; a direct lobby when hosting.server is false
var lobby := await client.join(code)                       # a lobby code to the server, a direct code or "ip:port" to join_direct
```

A bad file throws `bad_config` with the key's path (GDScript never throws: `cfg.error` / `client.config_error` hold `{code, path, rule, message}`; `chat.text` false and `session.pause` "off" make `lobby.chat.send` / `lobby.pause.request` raise the client error `chat_disabled` / `pause_disabled` instead of throwing). Switched-off features throw: `voice_disabled` (`lobby.voice.enabled = true`
with `chat.voice` false), `chat_disabled` (`lobby.chat.send` with `chat.text` false), `listing_disabled` (`list()` with
`hosting.server` false) and `identity_anonymous`. No lobby server address at all (empty `hosting.lobbyServer`, no
`lobbyServer` override) makes `host()` / `join()` fail with `no_server`. Browser wiring with the player's server
setting: `docs/recipes/js-web.md` "With onelobby.json"; two players with no server: `docs/recipes/testing.md` section 3. To integrate an existing game,
follow `.claude/skills/onelobby/SKILL.md` (Claude Code skill `onelobby`; other agents read it as plain steps): survey
the game, propose the file with a `$comment` reason per non-default key, plan the menu entry, build with the engine's
recipe, verify two players headless, report. Design and the reasons behind each key: `docs/design/blueprint.md`.

## Rules

1. **The game owns the command bytes.** OneLobby moves opaque `Uint8Array` / `byte[]`. Encode and decode yourself; pass
   ids and numbers, never display names or object graphs.
2. **The host is truth.** In `raw` mode the host's state wins: joiners send intents, the host validates and broadcasts the
   result. In `lockstep` the host only orders commands; every peer runs the same sim.
3. **Lockstep needs determinism.** Same commands in the same order must give the same state on every peer: in-state RNG
   only (seeded from the lobby code or a lobby field), no wall clock, no unordered iteration, no floats that differ by
   platform. Report a state hash every `HashEveryTicks` ticks; a mismatch raises `Desync`.
4. **Never block on the server.** Games stay fully playable offline. Multiplayer is the only code that touches the
   network, and every lobby call can fail (offline, full, wrong version): show the error, keep the game running.
5. **The lobby server URL is a setting**, not a constant. Default pre-filled, user-editable, overridable by a flag or
   `<meta>` tag. Anyone can self-host (`docs/recipes/self-host.md`).
6. `GameId` + `NetVersion` gate lobbies: bump `NetVersion` whenever your command bytes or rules change.
7. Late join and host migration in lockstep need `Snapshot`/`Restore`. In raw mode, handle `HostChanged` yourself.
   With `OneLobby.Replication` late join is automatic (full snapshot, then deltas); host migration is not supported:
   end the match on `HostLost`. Clients send inputs, never positions; one-off facts (points, kills) go in `SendEvent`.
8. Voice and chat are outside the sim: never put them in a lockstep frame or a hash.

## Recipes (each is copy-paste and ends with a "Done when" check)

- Godot 4 C# (desktop + web): `docs/recipes/godot-csharp.md`
- Godot 4 GDScript, no .NET (desktop; raw and lockstep, chat, pause, room layer): `docs/recipes/godot-gdscript.md`; one command:
  `npx create-onelobby my-game --template godot-gdscript --yes` (or `npx create-onelobby --into <project>`) vendors the add-on and the WebRTC natives, adds the autoload, the menu and a headless two-peer test (`tests/multiplayer.gd` prints `MULTIPLAYER_OK`); `npx create-onelobby verify` is the one test command (last line `VERIFY_OK` or `VERIFY_FAIL <check>: <next step>`), `npx create-onelobby update` re-vendors the add-on
- Unity 6 (desktop + mobile, no WebGL): `docs/recipes/unity.md`
- Browser JS: `docs/recipes/js-web.md`
- Any .NET app (console, MonoGame, bots, tests; real WebRTC via `OneLobby.DataChannel`): `docs/recipes/dotnet-generic.md`
- Raw mode (your own netcode, e.g. turn-based or arcade): `docs/recipes/raw-mode.md`
- Replicated state (host-authoritative real-time: shooters, physics, AI), C#, JS and GDScript: `docs/recipes/replication.md`
- Voice and text chat: `docs/recipes/voice-and-chat.md`
- Shared pause (anyone pauses, the pauser or host resumes; lockstep frames stop; works on direct lobbies): `docs/recipes/pause.md`
- Test two players headless (playwright-core): `docs/recipes/testing.md`
- Host with a join code, no server (.NET desktop, Unity, Node): `docs/recipes/direct-ip.md`. C#: `client.HostDirectAsync` /
  `JoinDirectAsync` / `RejoinDirectAsync(code, token)` from `OneLobby.Direct`; Unity: the same on `OneLobbyRunner`; Node:
  `hostDirect(kit)` from `onelobby/direct`; JS joiners: `kit.joinDirect(code)`, `kit.rejoinDirect(code, token)`.
  `lobby.joinCode` is a Nostr code by default (works with no port forwarded), `lobby.directCode` the IP code for LAN;
  `nostr: false` / blueprint `hosting.nostr: false` is IP codes only (more: section 7 there)
- Browser game whose server is a Node process on the host's PC (join link, page served on 47810, WebSocket-shaped
  adapter): `docs/recipes/browser-game.md`
- Dev console a local tool can reach (`ogc1`: loopback HTTP, token file, off by default): `docs/recipes/game-console.md`
- TURN relay for Direct mode (strict NATs, `ice_failed`; bring your own, coturn or hosted, expiring logins): `docs/recipes/turn.md`
- The player's saved name, relay line (masked), last code and lobby server, with an environment override: `docs/recipes/settings.md`
  (`kit.settings` / `client.Settings` / `client.settings`; applied as defaults, an explicit argument wins; the relay line is never logged)
- Run your own server: `docs/recipes/self-host.md` (the hosted backend; parked behind direct IP for now)

Example target for practice: `examples/tictactoe/` (single player, no networking).
Docs index for tools: `llms.txt`. Design and wire protocol: `DESIGN.md`, `spec/`.
