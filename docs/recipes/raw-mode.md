# Recipe: raw mode (bring your own netcode)

Use `mode: "raw"` when your game is turn-based or host-authoritative (arcade, card, board games) and you do not want a
deterministic lockstep sim. Keepalive gives you lobbies plus reliable/fast byte messages; you define the protocol.
Connect first with `js-web.md` (or the C# recipes), then add this.

## Pattern: joiners send intents, the host decides, everyone gets the result

One tag byte, then payload. The game owns this layout; Keepalive never looks inside.

| Tag | Direction | Payload | Meaning |
|---|---|---|---|
| 1 `MOVE` | joiner to host | `cell` (1 byte) | "I want to play this cell" |
| 2 `STATE` | host to all | 9 cells (0 empty, 1 X, 2 O), `turn`, `winner` | authoritative state |
| 3 `HELLO` | joiner to host | none | ask for a full `STATE` after joining |

```ts compile file=sync.ts
import type { Lobby } from "@keepalive/client";

export const MOVE = 1, STATE = 2, HELLO = 3;

export interface Game {
  cells: number[];   // 0 empty, 1 X, 2 O
  turn: number;      // 1 or 2
  winner: number;    // 0 none, 1, 2, 3 draw
}
type Apply = (g: Game, cell: number, mark: number) => boolean;

export function encodeState(g: Game): Uint8Array {
  return Uint8Array.from([STATE, ...g.cells, g.turn, g.winner]);
}
export function decodeState(b: Uint8Array): Game {
  return { cells: Array.from(b.subarray(1, 10)), turn: b[10], winner: b[11] };
}

export function wire(lobby: Lobby, game: Game, apply: Apply, render: () => void): void {
  const markOf = (peerId: number) => (peerId === lobby.hostPeerId ? 1 : 2);   // host plays X

  lobby.on("message", (from: number, bytes: Uint8Array) => {
    switch (bytes[0]) {
      case MOVE:   // host only: validate, apply, broadcast
        if (lobby.isHost && bytes.length === 2 && game.turn === markOf(from) && apply(game, bytes[1], markOf(from))) {
          lobby.broadcast(encodeState(game));
          render();
        }
        break;
      case HELLO:
        if (lobby.isHost) lobby.send(from, encodeState(game));
        break;
      case STATE:  // joiner: the host is truth
        if (!lobby.isHost && bytes.length === 12) { Object.assign(game, decodeState(bytes)); render(); }
        break;
    }
  });
  lobby.on("peerJoined", () => { if (lobby.isHost) lobby.broadcast(encodeState(game)); });
  if (!lobby.isHost) lobby.send(lobby.hostPeerId, Uint8Array.of(HELLO));
}

export function playCell(lobby: Lobby, game: Game, cell: number, apply: Apply, render: () => void): void {
  if (lobby.isHost) {
    if (game.turn === 1 && apply(game, cell, 1)) { lobby.broadcast(encodeState(game)); render(); }
  } else {
    lobby.send(lobby.hostPeerId, Uint8Array.of(MOVE, cell));   // do not apply locally; wait for STATE
  }
}
```

C# has the same shape: `lobby.MessageReceived += (from, payload, channel) => ...`, `lobby.Broadcast(bytes)`,
`lobby.Send(peerId, bytes)`, and `lobby.Pump()` once per frame.

## Rules for raw mode

- Joiners never apply their own moves; they wait for the host's `STATE`. That is why there is no desync to debug.
- Validate everything at the host: whose turn, legal cell, payload length. Peers are not trusted.
- `Channel.Reliable` (default) for moves and state. `fast` only for data you can lose (cursor positions).
- `hostChanged` fires if the host leaves. Either end the match (`sessionEnded`) or keep going: the new host already holds
  the last `STATE`. Tell the player which one happened.
- Bump `netVersion` when you change tags or layouts.

## Done when

- The snippet type-checks and two tabs show identical boards after every move, with the joiner's moves accepted only on
  its turn.
- Reloading the joiner's tab and joining the same code shows the current board (the `HELLO` path).
- `conformance/peer` passes against your build (see `conformance/README.md`).
