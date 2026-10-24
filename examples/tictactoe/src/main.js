import { newGame, applyMove } from "./game.js";

let state = newGame();
const boardEl = document.getElementById("board");
const statusEl = document.getElementById("status");

function render() {
  boardEl.replaceChildren(...state.cells.map((mark, i) => {
    const b = document.createElement("button");
    b.textContent = mark;
    b.addEventListener("click", () => play(i));
    return b;
  }));
  statusEl.textContent = state.winner === "draw" ? "Draw."
    : state.winner ? `${state.winner} wins.`
    : `${state.turn} to move.`;
}

function play(cell) {
  if (applyMove(state, cell)) render();
}

document.getElementById("reset").addEventListener("click", () => { state = newGame(); render(); });
render();
