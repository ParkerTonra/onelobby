# Recipe: the room layer (names, colours, ready, countdown, spectators, kick and ban)

Every lobby has a room: the roster a lobby screen shows. It gives you what three games each built by hand: per-player data
(colour, avatar, team, seat), a ready toggle, a start countdown, auto start, back to lobby and rematch, spectators, a
"reconnecting" state, a hook for putting a bot in an empty seat, kick and ban with a reason the player sees, bans that
survive the lobby, and passwords on every route. The host owns the truth; everyone else holds a copy and asks the host.
A game that never touches `lobby.room` behaves as before. Spec: `spec/room.md`.

JS, C# and GDScript ship it in 0.7.2 (`lobby.room` in JS and GDScript, `lobby.Room` in C#, the same messages and rules, so
players of all three share a room). The examples are JS first, then the same in C# under "C#" and in GDScript under "GDScript".

## The lobby screen

```ts compile file=lobby-screen.ts
import type { Lobby } from "onelobby";

export function wireRoom(lobby: Lobby, draw: (rows: string[]) => void, setStartEnabled: (on: boolean) => void): void {
  const room = lobby.room;
  const redraw = () => {
    draw(room.entries.map((p) => {
      const tag = p.role === "spectator" ? "watching" : p.status === "reconnecting" ? "reconnecting" : p.ready ? "ready" : "not ready";
      return `${p.name}  seat ${p.seat}  colour ${p.data.color ?? "-"}  ${tag}`;
    }));
    setStartEnabled(lobby.isHost && room.state === "lobby" && room.allReady);
  };
  room.on("changed", redraw);                     // fires after every roster, ready, data and state change
  room.on("countdown", (c) => console.log(`starting in ${Math.ceil(c.remaining() / 1000)}`));
  room.on("countdownCancelled", (why) => console.log(`start cancelled: ${why}`));
  room.on("started", () => console.log("go"));    // the lobby phase is in_game now
  room.on("removed", (r) => alert(r.reason));      // kicked, banned or refused: a plain sentence for the player
  room.on("unsupported", () => console.log("this host is older and has no room layer"));
  redraw();
}

// A player's own calls (the host answers; a refusal arrives as `rejected`)
export function pickMyLook(lobby: Lobby): void {
  lobby.room.setData({ color: "#ff8800", avatar: "3", team: "1" });
  lobby.room.setReady(true);
  lobby.room.on("rejected", (code, what, key) => console.log(`refused ${what}: ${code} ${key ?? ""}`));
}
```

`lobby.room.entries` is the whole roster; `players` is the seated ones by seat, `spectators` the rest. `name` is the
effective name: default `Player N` for an empty one, control and bidi characters stripped, clamped, deduped as `Sam 2`.
`lobby.rename()` still works and goes through the same rules.

## Host: start, countdown, rematch

```ts compile file=host-flow.ts
import type { Lobby } from "onelobby";

export function hostControls(lobby: Lobby): void {
  const room = lobby.room;
  room.on("requested", (peer, what) => {            // a joiner clicked "Start", "Back to lobby" or "Rematch"
    if (what === "start" && room.allReady) room.start();
    if (what === "rematch") room.rematch();
  });
  room.on("seatDropped", (s) => spawnBot(s.seat, s.data)); // the player is gone past the window: a bot takes the seat
  room.on("seatRestored", (s) => removeBot(s.seat));        // the player came back (s.returning): take the bot out
  room.filter = (text, kind) => text.replace(/darn/gi, "****"); // optional word filter for names and chat; nothing by default
}

export function endOfRound(lobby: Lobby): void {
  lobby.room.backToLobby();   // ready flags reset, links and seats stay; or lobby.room.rematch() to go again
}

declare function spawnBot(seat: number, data: Record<string, string>): void;
declare function removeBot(seat: number): void;
```

`start()` runs the countdown (`room.countdownSeconds`, default 3) and then moves the lobby to `in_game` for everyone; the
host's own timer ends it, so nobody starts early. A joiner's `room.countdown.remaining()` is the host's time left minus
half the round trip, so every screen counts down together to within the link's jitter. `cancelCountdown()` stops it.
`room.autoStart` can start it for you: `"all_ready"` or `"players"` (with `autoStartPlayers`).

## Kick, ban, unban

```ts compile file=moderation.ts
import type { Lobby } from "onelobby";

export function moderate(lobby: Lobby, peerId: number): void {
  lobby.room.kick(peerId, { reason: "Please keep it friendly." });          // may rejoin
  lobby.room.ban(peerId, { code: "spam", reason: "Spam in chat." });        // refused from now on, in every lobby you host
  console.log(lobby.room.bans.list());                                      // { id, ip?, name, reason, at }
  lobby.room.unban(lobby.room.bans.list()[0].id!);
}
```

The removed player gets `removed { code, reason }` (also `lobby.removal`) before `sessionEnded`; without a reason they see
a plain default sentence for the code. `lobby.kick(peerId)` is unchanged: it bans the address for this lobby only.

A ban is kept by the host's per-install **player id**: 32 random hex characters made once on each install and kept in
`localStorage` (Node: pass `playerIdFile`; otherwise it lasts one process). It is not an account, a hardware id or tied to the
name or address, and clearing local storage makes a new one, so a ban also stores the address when the host knows it (used
only for clients that sent no id). The ban list is saved in `localStorage` (Node: `banFile: "bans.json"`), per game id,
and the hub also refuses a banned id at `join()` when it supports it. Pass your own store with `advanced.banStore`.

## Password, spectators, late join

```ts compile file=setup.ts
import { OneLobby } from "onelobby";

export async function hostIt(kit: OneLobby) {
  return kit.host({
    name: "Sam's game", maxPlayers: 4, password: "tulip",
    room: { spectators: 4, lateJoin: "spectate", autoStart: "all_ready", countdownSeconds: 3, data: { team: { type: "int", min: 0, max: 2 } } },
  });
}

export async function joinIt(kit: OneLobby, code: string) {
  return kit.join(code, { password: "tulip", role: "spectator", data: { color: "#33aaff" } }); // rejects with bad_password when wrong
}
```

The password works on every route: server lobbies (`host({ password })`), Direct IP and Nostr codes
(`hostDirect`, `hostNostr`), checked by the hub and again by the host's room. A wrong one fails with `bad_password`.
Spectators join as `role: "spectator"`, are not counted in `maxPlayers` (up to the spectator cap) and get no seat; the host can
move anyone with `room.moveTo(peerId, role)`. Late join once the game started is `allow`, `spectate` (only as a spectator) or
`refuse`.

## In onelobby.json

```json
"room": {
  "autoStart": "all_ready", "countdownSeconds": 3, "minPlayers": 2, "spectators": 4, "lateJoin": "spectate",
  "seatDropped": "window", "rejoinWindowSeconds": 60, "passwordRequired": false,
  "data": { "role": { "type": "enum", "values": ["tank", "healer"], "default": "tank" } }
}
```

Built-in per-player keys: `color` (`#rrggbb`), `avatar` (0-255) and `team` (0-15). Declared keys are strings, ints, enums,
bools or colours, validated by the host; a key marked `hostOnly` can only be set by the host.

## C#

`lobby.Room` has the same shape as JS `lobby.room`, in C# style: properties and `Pascal` methods, events instead of `on`, the
same codes as strings. It works on server lobbies, Direct lobbies (IP and Nostr codes) and through `OneLobbyRunner` in Unity.
Events fire inside `lobby.Pump()` (or when a host call changes the room), on the thread that pumps; time comes from the
transport's clock, so tests with `InMemoryNetwork` are deterministic.

```csharp compile file=LobbyScreen.cs
using System;
using System.Collections.Generic;
using OneLobby;

public static class LobbyScreen
{
    public static void Wire(Lobby lobby, Action<List<string>> draw, Action<bool> setStartEnabled)
    {
        var room = lobby.Room;
        void Redraw()
        {
            var rows = new List<string>();
            foreach (var p in room.Entries)
            {
                var tag = p.Role == RoomRole.Spectator ? "watching" : p.Status == RoomStatus.Reconnecting ? "reconnecting" : p.Ready ? "ready" : "not ready";
                rows.Add($"{p.Name}  seat {p.Seat}  colour {(p.Data.TryGetValue("color", out var c) ? c : "-")}  {tag}");
            }
            draw(rows);
            setStartEnabled(lobby.IsHost && room.State == RoomState.Lobby && room.AllReady);
        }
        room.Changed += Redraw;                                   // after every roster, ready, data and state change
        room.CountdownUpdated += c => Console.WriteLine($"starting in {Math.Ceiling(c.RemainingMs / 1000.0)}");
        room.CountdownCancelled += why => Console.WriteLine($"start cancelled: {why}");
        room.Started += () => Console.WriteLine("go");           // the lobby phase is in game now
        room.Removed += r => Console.WriteLine(r.Reason);          // kicked, banned or refused: a plain sentence for the player
        room.Unsupported += () => Console.WriteLine("this host is older and has no room layer");
        Redraw();
    }

    // A player's own calls (the host answers; a refusal arrives as Rejected)
    public static void PickMyLook(Lobby lobby)
    {
        lobby.Room.SetData(new Dictionary<string, string> { ["color"] = "#ff8800", ["avatar"] = "3", ["team"] = "1" });
        lobby.Room.SetReady(true);
        lobby.Room.Rejected += (code, what, key) => Console.WriteLine($"refused {what}: {code} {key}");
    }
}
```

Host side, the same flow:

```csharp compile file=HostFlow.cs
using OneLobby;

public static class HostFlow
{
    public static void HostControls(Lobby lobby)
    {
        var room = lobby.Room;
        room.Requested += (peer, what) =>                         // a joiner clicked "Start", "Back to lobby" or "Rematch"
        {
            if (what == RoomRequest.Start && room.AllReady) room.Start();
            if (what == RoomRequest.Rematch) room.Rematch();
        };
        room.SeatDropped += s => SpawnBot(s.Seat, s.Data);        // the player is gone past the window: a bot takes the seat
        room.SeatRestored += s => RemoveBot(s.Seat);              // the player came back (s.Returning): take the bot out
        room.Filter = (text, kind) => text.Replace("darn", "****"); // optional word filter for names and chat; nothing by default
    }

    public static void EndOfRound(Lobby lobby) => lobby.Room.BackToLobby();   // or lobby.Room.Rematch() to go again

    public static void Moderate(Lobby lobby, int peerId)
    {
        lobby.Room.Kick(peerId, reason: "Please keep it friendly.");            // may rejoin
        lobby.Room.Ban(peerId, code: "spam", reason: "Spam in chat.");          // refused from now on, in every lobby you host
        var first = lobby.Room.Bans.List()[0];                                  // Id, Ip, Name, Reason, Code, At
        lobby.Room.Unban(first.Id!);
    }

    private static void SpawnBot(int seat, System.Collections.Generic.IReadOnlyDictionary<string, string> data) { }
    private static void RemoveBot(int seat) { }
}
```

Setup with a password, spectators and late join, then joining:

```csharp compile file=RoomSetup.cs
using System.Collections.Generic;
using System.Threading.Tasks;
using OneLobby;

public static class RoomSetup
{
    public static Task<Lobby> HostIt(LobbyClient client) => client.HostAsync(new LobbyOptions("Sam's game", 4)
    {
        Password = "tulip",
        Room = new RoomOptions
        {
            Spectators = 4, LateJoin = LateJoinPolicy.Spectate, AutoStart = AutoStartMode.AllReady, CountdownSeconds = 3,
            Data = new Dictionary<string, DataDecl> { ["team"] = new DataDecl(DataType.Int) { Min = 0, Max = 2 } },
        },
    });

    // rejects with OneLobbyException "bad_password" when wrong
    public static Task<Lobby> JoinIt(LobbyClient client, string code) => client.JoinAsync(code, new RoomJoinOptions
    {
        Password = "tulip", Role = RoomRole.Spectator, Data = new Dictionary<string, string> { ["color"] = "#33aaff" },
    });
}
```

`DirectHostOptions.Room` / `.Password` and `JoinDirectOptions.Password` / `.Role` / `.Data` do the same for Direct IP and Nostr
codes; `onelobby.json`'s `room` section fills the defaults (`Blueprint.Room`, applied by `LobbyClient.FromBlueprint`).

The player id and the ban list live in an `IKeyValueStore` (`GetItem`, `SetItem`, `RemoveItem`). Defaults: memory only (the id
then lasts one process). Give a file with `OneLobbyConfig.PlayerIdFile` / `BanFile` (the Unity runner does it for you, under
`Application.persistentDataPath`; in Godot use `ProjectSettings.GlobalizePath("user://onelobby-player.json")`), or your own
store with `PlayerIdStore` / `BanStore` (PlayerPrefs, a save file). Differences from JS names: the `countdown` event is
`CountdownUpdated`, the `backToLobby` event is `BackedToLobby`, `supported` is `SupportConfirmed`, and `Room.Supported` is a
`bool?` (null until the host answers).

## GDScript

`lobby.room` is an `OneLobbyRoom` (a `RefCounted`) with the same shape as JS `lobby.room`, in GDScript style: snake_case,
signals instead of `on`, Dictionaries for entries. It works on server lobbies and Direct lobbies (IP and Nostr codes), raw and
lockstep. Signals fire inside the client's per-frame pump (or when a host call changes the room). The API is documented in
the `room.gd` comments; the wire is the one in `spec/room.md`, so GDScript, JS and C# players share a room.

An entry is `{id, name, role, seat, ready, status, data, legacy?}` (`id` is the peer id). A call that can fail returns the
stable error code (`""` when it worked) and also raises it on `client.error`, where JS and C# throw. `room.supported` is
`null` until the host answers (a host is `true` at once; `false` after 3 s with an older host, then `entries()` is the hub
roster). Signals: `changed`, `player_joined`, `player_left(entry, why)`, `player_changed(entry, keys)`, `state_changed`,
`started`, `all_ready_changed`, `countdown_changed(countdown)`, `countdown_cancelled(reason)`, `returned_to_lobby`,
`settings_changed`, `seat_dropped(info)`, `seat_restored(info)`, `requested(peer_id, what)`, `removed(info)`,
`rejected(code, re, key)`, `bans_changed`, `became_supported`, `became_unsupported`.

```gdscript compile file=room_screen.gd
extends Node


func wire_room(lobby: OneLobbyLobby, start_button: Button) -> void:
	var room := lobby.room
	room.changed.connect(func() -> void: _redraw(lobby, start_button))       # after every roster, ready, data and state change
	room.countdown_changed.connect(func(c: Dictionary) -> void: print("starting in ", ceili(float(c["remaining"]) / 1000.0)))
	room.countdown_cancelled.connect(func(why: String) -> void: print("start cancelled: ", why))
	room.started.connect(func() -> void: print("go"))                          # the lobby phase is in_game now
	room.removed.connect(func(info: Dictionary) -> void: print(info["reason"]))   # kicked, banned or refused: a plain sentence
	room.became_unsupported.connect(func() -> void: print("this host is older and has no room layer"))
	room.rejected.connect(func(code: String, what: String, key: String) -> void: print("refused %s: %s %s" % [what, code, key]))
	_redraw(lobby, start_button)


func _redraw(lobby: OneLobbyLobby, start_button: Button) -> void:
	for p: Dictionary in lobby.room.entries():
		var data: Dictionary = p["data"]
		var tag := "watching" if p["role"] == "spectator" else ("reconnecting" if p["status"] == "reconnecting" else ("ready" if p["ready"] else "not ready"))
		print("%s  seat %d  colour %s  %s" % [p["name"], p["seat"], data.get("color", "-"), tag])
	start_button.disabled = not (lobby.is_host and lobby.room.state == "lobby" and lobby.room.all_ready)


# A player's own calls (the host answers; a refusal arrives as `rejected`)
func pick_my_look(lobby: OneLobbyLobby) -> void:
	lobby.room.set_data({"color": "#ff8800", "avatar": "3", "team": "1"})
	lobby.room.set_ready(true)
```

Host side, the same flow:

```gdscript compile file=room_host.gd
extends Node


func host_controls(lobby: OneLobbyLobby) -> void:
	var room := lobby.room
	room.requested.connect(func(_peer: int, what: String) -> void:         # a joiner clicked "Start", "Back to lobby" or "Rematch"
		if what == "start" and room.all_ready:
			room.start()
		if what == "rematch":
			room.rematch())
	room.seat_dropped.connect(func(info: Dictionary) -> void: print("bot into seat ", info["seat"]))     # the player is gone past the window
	room.seat_restored.connect(func(info: Dictionary) -> void: print("bot out of seat ", info["seat"]))  # it came back (info["returning"])
	room.filter = func(text: String, _kind: String) -> String: return text.replace("darn", "****")   # optional word filter; nothing by default


func end_of_round(lobby: OneLobbyLobby) -> void:
	lobby.room.back_to_lobby()    # ready flags reset, links and seats stay; or lobby.room.rematch() to go again


func moderate(lobby: OneLobbyLobby, peer_id: int) -> void:
	lobby.room.kick(peer_id, {"reason": "Please keep it friendly."})           # may rejoin
	lobby.room.ban(peer_id, {"code": "spam", "reason": "Spam in chat."})       # refused from now on, in every lobby you host
	var bans := lobby.room.bans.list()                                          # [{id, ip?, name, reason, code, at}]
	if not bans.is_empty():
		lobby.room.unban(str((bans[0] as Dictionary)["id"]))
```

Setup with a password, spectators and late join, then joining. `host()`, `host_direct()`, `join()` and `join_direct()` all
take these options:

```gdscript compile file=room_setup.gd
extends Node


func host_it(client: OneLobbyClient) -> OneLobbyLobby:
	return await client.host_direct({
		"name": "Sam's game", "max_players": 4, "password": "tulip",
		"room": {"spectators": 4, "late_join": "spectate", "auto_start": "all_ready", "countdown_seconds": 3,
			"data": {"team": {"type": "int", "min": 0, "max": 2}}},
		"data": {"color": "#ff8800"},                                       # the host's own starting data
	})


func join_it(client: OneLobbyClient, code: String) -> OneLobbyLobby:
	# null with client.last_error["code"] == "bad_password" when the password is wrong
	return await client.join_direct(code, {"password": "tulip", "role": "spectator", "data": {"color": "#33aaff"}})
```

`room` options are the `onelobby.json` keys in snake_case (`auto_start`, `auto_start_players`, `min_players`,
`countdown_seconds`, `spectators`, `late_join`, `seat_dropped`, `rejoin_window_seconds`, `password_required`, `max_name_length`,
`data`); a blueprint's `room` section is the default (`OneLobbyConfig.room_options()`) and your options win, their `data`
declarations merging with the file's. `host()` fails with `password_required` when `room.passwordRequired` is true and no
password is given. A joiner's `data` and `role` go in its `join`; `rejoin()` brings none.

The player id (32 hex characters, made once per install and game) and the ban list live in an `OneLobbyStore`
(`get_item`, `set_item`, `remove_item`). `client.store` defaults to the file `user://onelobby.json`; set
`OneLobbyStore.memory()` (nothing kept), `OneLobbyStore.file("user://mine.json")` or your own subclass before `host()` / `join()`.
`client.player_id()` is the id and `client.bans()` the list (`lobby.room.bans`: `list()`, `add()`, `remove()`, `clear()`).

GDScript specifics:

- The Direct hub in `hub.gd` has no spectator slots and no ban list: a Direct host gets `max_players + spectators` as its
  capacity and its room does the split, the ban check and a second password check itself (spec section 8, "new client, old hub"); a
  banned or wrong-password joiner is told by a `deny` frame. A server lobby on a hub with the `room` feature uses the hub's checks too.
- A ban stores the player id. The address fallback needs the link's remote address, which Godot's WebRTC does not expose, so the
  stock link leaves `OLLink.remote_address` empty and an address-only ban is not enforced (a custom transport can fill it in; the
  lobby polls it every 500 ms and re-checks the list when it appears).
- Godot strings cannot hold U+0000: its JSON parser turns it into U+FFFD, so the name and text rules strip U+FFFD as well.
- Tests: `tests/room_vectors.gd` (every case of `spec/vectors/room.json`), `tests/room.gd` (real peers on loopback plus stand-in
  peers for the host rules) and `tools/engine-smoke/run.mjs --room` against JS and C# peers.

## Compatibility

A new client works against an old hub (the host enforces passwords, bans and the spectator split itself) and an old client
works against a new hub or host (it shows up as a `legacy` player, never ready). A joiner of an older host sees
`unsupported` after 3 s and `room.players` lists the hub roster. Nothing throws and no state is invented.
