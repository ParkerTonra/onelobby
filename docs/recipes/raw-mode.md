# Recipe: raw mode (bring your own netcode)

Use `mode: "raw"` when your game is turn-based or host-authoritative (arcade, card, board games) and you do not want a
deterministic lockstep sim. Keepalive gives you lobbies plus reliable/fast byte messages; you define the protocol.
Connect first with `js-web.md` (or the C# recipes), then add this.

## Pattern: joiners send intents, the host decides, everyone gets the result

One tag byte, then payload. The game owns this layout; Keepalive never looks inside.

| Tag | Direction | Payload | Meaning |
|---|---|---|---|
| 1 `MOVE` | joiner to host | `cell` (1 byte) | "I want to play this cell" |
| 2 `STATE` | host to one or all | 9 cells, `turn`, `winner` (1 byte each) | authoritative state |

**Mapping your state to bytes.** Keepalive moves bytes; your state is strings and objects. Keep a small table from each
value to a number and back, and never send names or JSON text for something that has an id. Here the example game's
`"X" | "O" | ""` cells and `"" | "X" | "O" | "draw"` winner become `0..3` in the code below.

**Send initial state on `peerReady`, not `peerJoined`.** `peerJoined` fires when the player enters the roster, before the
data channel to them is open. Reliable sends made before then are not lost: they are queued and flushed in order once the
link opens (`fast` sends are dropped). Waiting for `peerReady` (host side: the link to that peer is open) still matters
here, because the state you send should be the state at the moment they can receive it, not a stale copy from earlier.
A joiner's own `ready` event (or `await lobby.ready`) means its link to the host is open.

```ts compile file=sync.ts
import type { Lobby } from "@keepalive/client";

export const MOVE = 1, STATE = 2;

// The game's own state (strings), as in examples/tictactoe/src/game.js.
export interface Game {
  cells: string[];   // "", "X", "O"
  turn: string;      // "X" | "O"
  winner: string;    // "" | "X" | "O" | "draw"
}
type Apply = (g: Game, cell: number) => boolean;

const SYMBOLS = ["", "X", "O", "draw"];            // index = the byte on the wire
const toByte = (v: string) => Math.max(0, SYMBOLS.indexOf(v));
const fromByte = (n: number) => SYMBOLS[n] ?? "";

export function encodeState(g: Game): Uint8Array {
  return Uint8Array.from([STATE, ...g.cells.map(toByte), toByte(g.turn), toByte(g.winner)]);
}
export function decodeState(b: Uint8Array): Game {
  return { cells: Array.from(b.subarray(1, 10), fromByte), turn: fromByte(b[10]), winner: fromByte(b[11]) };
}

export function wire(lobby: Lobby, game: Game, apply: Apply, render: () => void): void {
  const markOf = (peerId: number) => (peerId === lobby.hostPeerId ? "X" : "O");   // host plays X

  lobby.on("message", (from: number, bytes: Uint8Array) => {
    if (bytes[0] === MOVE) {            // host only: validate, apply, broadcast
      if (lobby.isHost && bytes.length === 2 && game.turn === markOf(from) && apply(game, bytes[1])) {
        lobby.broadcast(encodeState(game));
        render();
      }
    } else if (bytes[0] === STATE) {    // joiner: the host is truth
      if (!lobby.isHost && bytes.length === 12) { Object.assign(game, decodeState(bytes)); render(); }
    }
  });
  // Host: give each newcomer the current state as soon as their channel is open.
  lobby.on("peerReady", (peer) => { if (lobby.isHost) lobby.send(peer.peerId, encodeState(game)); });
}

export function playCell(lobby: Lobby, game: Game, cell: number, apply: Apply, render: () => void): void {
  if (lobby.isHost) {
    if (game.turn === "X" && apply(game, cell)) { lobby.broadcast(encodeState(game)); render(); }
  } else {
    lobby.send(lobby.hostPeerId, Uint8Array.of(MOVE, cell));   // do not apply locally; wait for STATE
  }
}
```

C# has the same shape (`lobby.PeerReady += peer => ...` for the initial state): `lobby.MessageReceived += (from, payload, channel) => ...`, `lobby.Broadcast(bytes)`,
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
- A joiner who connects mid-game shows the current board straight away (the `peerReady` path).
- `conformance/peer` passes against your build (see `conformance/peer/README.md`).
