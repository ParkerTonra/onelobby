# Recipe: shared pause

A pause every player shares: anyone asks, the host decides, everyone hears the answer. Works in every mode (`lockstep`,
`raw`, `OneLobby.Replication`), on server lobbies and direct-IP lobbies, from the moment the game phase starts.
Join a lobby first (`js-web.md`, `dotnet-generic.md`, `godot-csharp.md`, `unity.md`).

Two things to know before the first call. Pause works only in the game phase (`InGame`, after `StartAsync()` / `start()`);
before that the host refuses with `not_in_game`. And a game with an `onelobby.json` has pause **off** unless it says
otherwise: `Request` throws `pause_disabled` until the file has `"session": { "pause": "anyone" }` (or `"host"`). A lobby
made without a blueprint behaves as `anyone`.

OneLobby moves the state and, in `lockstep`, stops the host's frames. Everything else is yours: freezing your sim or time
scale, the pause menu, the "Paused by Ann" banner. The pause is outside the sim, so never put it in a lockstep command or
hash.

## Rules

| Rule | Value |
|---|---|
| Who pauses | Anyone. A blueprint with `session.pause: "host"` makes it host-only for both pausing and resuming; `"off"` makes `request` throw `pause_disabled` |
| Who resumes | The player who paused, or the host. Others are refused with `not_allowed` |
| Pauser leaves | The host inherits the pause: `byPeer` = host, `pauserLeft` = true, told to everyone. No surprise unpause |
| Rate | At most one accepted request per peer per 0.5 s; more are refused with `rate_limited` |
| Phase | Only while the lobby is in game (`InGame`); otherwise refused with `not_in_game`. Going back to the lobby phase clears the pause |
| Late joiner | Gets the current state when its link is up (`peerReady`) |
| Host migration (server lobbies) | The new host takes the state over as is; if the holder is gone it holds the pause (`pauserLeft`) |
| Custom rule | Host: `lobby.pause.policy = (peer, wantPaused) => ...` (JS) / `lobby.Pause.Policy` (C#); phase and rate checks still run first |
| Restart or game over | Host: `lobby.pause.clear()` / `lobby.Pause.Clear()` unpauses at once, skipping policy and rate limit |

`state` is `{ paused, byPeer, pauserLeft }`. `byPeer` is who paused (while paused) or who last resumed.
`canResume` is true when the local player may resume now by the default rules (on a joiner with a custom host policy it is
a hint; a refused request still tells you).

## Lockstep

While paused the host emits no frames, so `nextFrame()` / `TryNextFrame` returns nothing once the frames already sent have
been consumed. On resume the next frame is simply the next tick (no gap, no burst, no hash problem), and commands made
meanwhile ride in it. Joiners do not treat the quiet host as lost, and the host does not drop quiet joiners.

## Raw mode and replication

OneLobby only carries the state. Stop your own sim when `changed` says `paused` (with `OneLobby.Replication`: stop
stepping the host world; clients keep interpolating to the last snapshot, and you may keep sending it).

## JS

```ts compile file=pause.ts
import type { Lobby } from "onelobby";

export function wirePause(lobby: Lobby, banner: HTMLElement, setSimRunning: (running: boolean) => void): void {
  lobby.pause.on("changed", (s) => {
    setSimRunning(!s.paused);                                   // your time scale / loop
    const who = lobby.peers.find((p) => p.peerId === s.byPeer)?.name ?? `Player ${s.byPeer}`;
    banner.textContent = s.paused ? (s.pauserLeft ? `Paused (${who} holds it: the player who paused left)` : `Paused by ${who}`) : "";
  });
  lobby.pause.on("refused", (code) => {                          // "not_in_game" | "rate_limited" | "not_allowed"
    banner.textContent = `Could not do that: ${code}`;
  });
}

// the pause key / button
export function togglePause(lobby: Lobby): void {
  const s = lobby.pause.state;
  if (!s.paused) lobby.pause.request(true);
  else if (lobby.pause.canResume) lobby.pause.request(false);
}

// host only: before a restart or game over
export function beforeRestart(lobby: Lobby): void {
  if (lobby.isHost) lobby.pause.clear();
}
```

## C#

```csharp compile file=Pause.cs
using System;
using System.Linq;
using OneLobby;

public static class PauseWiring
{
    public static void Wire(Lobby lobby, Action<bool> setSimRunning, Action<string> banner)
    {
        lobby.Pause.Changed += s =>
        {
            setSimRunning(!s.Paused);                            // your time scale / loop
            var who = lobby.Peers.FirstOrDefault(p => p.PeerId == s.ByPeer)?.Name ?? "Player " + s.ByPeer;
            banner(s.Paused ? (s.PauserLeft ? $"Paused ({who} holds it: the player who paused left)" : $"Paused by {who}") : "");
        };
        lobby.Pause.Refused += code => banner("Could not do that: " + code);   // not_in_game | rate_limited | not_allowed
    }

    // the pause key / button
    public static void Toggle(Lobby lobby)
    {
        if (!lobby.Pause.State.Paused) lobby.Pause.Request(true);
        else if (lobby.Pause.CanResume) lobby.Pause.Request(false);
    }

    // host only: before a restart or game over
    public static void BeforeRestart(Lobby lobby)
    {
        if (lobby.IsHost) lobby.Pause.Clear();
    }

    // host only: a house rule instead of the default (here: only the host may pause or resume)
    public static void HostOnly(Lobby lobby) => lobby.Pause.Policy = (peer, wantPaused) => peer == lobby.HostPeerId;
}
```

## Done when

Two players are in game. Player 2 presses pause: both screens show "Paused by Player 2" and the sim stops. Player 3 (if
any) cannot resume; the host can. Player 2 leaves while paused: the banner changes to the host holding it. A third player
joining now sees the pause at once. Going back to the lobby clears it.

The wire kinds (`pause_request` 0x70, `pause_state` 0x71, `pause_refuse` 0x72) are in `spec/binary.md`.
