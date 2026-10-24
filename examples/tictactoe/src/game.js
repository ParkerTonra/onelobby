// Pure game logic: no DOM, no networking. A move is { cell: 0..8 } and the mark is decided by whose turn it is.

export const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export function newGame() {
  return { cells: Array(9).fill(""), turn: "X", winner: "", moves: 0 };
}

export function winnerOf(cells) {
  for (const [a, b, c] of LINES) {
    if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) return cells[a];
  }
  return cells.every(Boolean) ? "draw" : "";
}

// Returns true if the move was legal and applied.
export function applyMove(state, cell) {
  if (state.winner || !Number.isInteger(cell) || cell < 0 || cell > 8 || state.cells[cell]) return false;
  state.cells[cell] = state.turn;
  state.moves++;
  state.winner = winnerOf(state.cells);
  state.turn = state.turn === "X" ? "O" : "X";
  return true;
}
