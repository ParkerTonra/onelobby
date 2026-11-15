# Recipe: the room layer (names, colours, ready, countdown, spectators, kick and ban)

Every lobby has a room: the roster a lobby screen shows. It gives you what three games each built by hand: per-player data
(colour, avatar, team, seat), a ready toggle, a start countdown, auto start, back to lobby and rematch, spectators, a
"reconnecting" state, a hook for putting a bot in an empty seat, kick and ban with a reason the player sees, bans that
survive the lobby, and passwords on every route. The host owns the truth; everyone else holds a copy and asks the host.
A game that never touches `lobby.room` behaves as before. Spec: `spec/room.md`.

JS ships it in 0.7.2. `lobby.Room` in C# and `room` in GDScript are coming in this release with the same messages and rules.

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

## Compatibility

A new client works against an old hub (the host enforces passwords, bans and the spectator split itself) and an old client
works against a new hub or host (it shows up as a `legacy` player, never ready). A joiner of an older host sees
`unsupported` after 3 s and `room.players` lists the hub roster. Nothing throws and no state is invented.
