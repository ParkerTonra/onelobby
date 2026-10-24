import { Keepalive, Gridpaint, paintCmd, PALETTE, GRID_W, formatCode } from "/lib/index.js";

const $ = (id) => document.getElementById(id);
const server = document.querySelector('meta[name="keepalive-lobby-server"]').content;
$("name").value = "player" + Math.floor(Math.random() * 90 + 10);

const kit = new Keepalive({
  gameId: "gridpaint",
  netVersion: "1",
  lobbyServer: server,
  mode: "lockstep",
  tickRate: 20,
  hashEveryTicks: 20,
  displayName: $("name").value,
});
kit.on("error", (e) => log("error: " + e.message));

let lobby = null;
let game = null;
let lastHash = 0n;
let sync = "-";
let loop = 0;
const hashes = new Map();

function log(line) {
  const el = $("log");
  const d = document.createElement("div");
  d.textContent = line;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}

function bind(l) {
  lobby = l;
  game = new Gridpaint(l.code);
  l.lockstep.snapshot = () => game.snapshot();
  l.lockstep.restore = (tick, bytes) => {
    game.restore(tick, bytes);
    log("restored snapshot at tick " + tick);
  };
  l.lockstep.on("desync", (d) => {
    sync = "DESYNC at tick " + d.tick + " (resyncing)";
  });
  l.on("peerJoined", (p) => log(`${p.name} joined`));
  l.on("peerLeft", (p, why) => log(`${p.name} left (${why})`));
  l.on("hostChanged", (h) => {
    log("host is now peer " + h);
    refresh();
  });
  l.on("phase", (p) => {
    log("phase: " + p);
    refresh();
  });
  l.on("sessionEnded", (why) => {
    log("session ended: " + why);
    unbind();
  });
  l.chat.on("message", (m) => log(`${l.peer(m.peerId)?.name ?? m.peerId}: ${m.text}`));
  l.chat.on("rejected", (_id, why) => log("chat rejected: " + why));
  l.voice.on("speaking", (id, t) => {
    speaking[t ? "add" : "delete"](id);
    $("speaking").textContent = speaking.size ? "speaking: " + [...speaking].map((i) => l.peer(i)?.name ?? i).join(", ") : "";
  });
  l.voice.on("error", (e) => log("voice: " + e.message));
  l.chat.on("history", (lines) => { for (const m of lines) log(`${l.peer(m.peerId)?.name ?? m.peerId}: ${m.text}`); });
  $("chat").disabled = false;
  $("leave").disabled = false;
  $("host").disabled = $("join").disabled = true;
  clearInterval(loop);
  loop = setInterval(pump, 25);
  refresh();
  log("in lobby " + formatCode(l.code));
}
const speaking = new Set();

function unbind() {
  clearInterval(loop);
  lobby = null;
  $("chat").disabled = true;
  $("leave").disabled = true;
  $("start").disabled = true;
  $("host").disabled = $("join").disabled = false;
  $("hostnote").hidden = true;
  $("info").textContent = "Not in a lobby.";
}

function refresh() {
  if (!lobby) return;
  $("hostnote").hidden = !lobby.isHost;
  $("start").disabled = !(lobby.isHost && lobby.phase === "lobby");
  $("info").textContent = `Code ${formatCode(lobby.code)}  |  you are peer ${lobby.localPeerId}  |  host: ${lobby.hostPeerId}  |  ${lobby.phase}  |  players: ${lobby.peers.map((p) => p.name).join(", ")}`;
}

// The game loop: apply every frame the library hands out, report hashes, draw.
function pump() {
  if (!lobby) return;
  let f;
  while ((f = lobby.lockstep.nextFrame())) {
    lastHash = game.step(f.tick, f.commands);
    hashes.set(f.tick, lastHash);
    lobby.lockstep.reportHash(f.tick, lastHash);
    if (f.tick % 20 === 0 && !sync.startsWith("DESYNC")) sync = "in sync";
  }
  if (sync.startsWith("DESYNC") && !lobby.lockstep.framesBuffered) sync = "in sync";
  draw();
  $("status").innerHTML = `tick ${game.tick}  hash ${lastHash.toString(16).padStart(16, "0")}  <span class="${sync === "in sync" ? "ok" : "bad"}">${sync}</span>  rtt ${lobby.rtt} ms`;
  $("meter").firstElementChild.style.width = Math.min(100, lobby.voice.inputLevel * 400) + "%";
}

const ctx = $("grid").getContext("2d");
function draw() {
  const s = $("grid").width / GRID_W;
  for (let i = 0; i < 256; i++) {
    ctx.fillStyle = game.grid[i] ? PALETTE[game.grid[i]] : "#f4f4f4";
    ctx.fillRect((i % GRID_W) * s, Math.floor(i / GRID_W) * s, s - 1, s - 1);
  }
}
$("grid").addEventListener("pointerdown", (e) => {
  if (!lobby || lobby.phase !== "in_game") return;
  const r = $("grid").getBoundingClientRect();
  const x = Math.floor(((e.clientX - r.left) / r.width) * GRID_W);
  const y = Math.floor(((e.clientY - r.top) / r.height) * GRID_W);
  lobby.lockstep.submit(paintCmd(x, y));
});

const fail = (e) => log("error: " + (e.message ?? e));
$("host").onclick = async () => {
  kit.options.displayName = $("name").value;
  try {
    bind(await kit.host({ name: $("name").value + "'s game", maxPlayers: 8, visibility: "public", lateJoin: true }));
  } catch (e) { fail(e); }
};
$("join").onclick = async () => {
  kit.options.displayName = $("name").value;
  try {
    bind(await kit.join($("code").value));
  } catch (e) { fail(e); }
};
$("browse-btn").onclick = async () => {
  try {
    const items = await kit.list();
    const ul = $("browse");
    ul.replaceChildren();
    if (!items.length) ul.textContent = "No public lobbies.";
    for (const it of items) {
      const li = document.createElement("li");
      li.textContent = `${formatCode(it.code)}  ${it.name}  (${it.players}/${it.maxPlayers}, ${it.phase})`;
      li.onclick = () => { $("code").value = it.code; };
      ul.appendChild(li);
    }
  } catch (e) { fail(e); }
};
$("start").onclick = () => lobby?.start();
$("leave").onclick = async () => { await lobby?.leave(); };
$("chat").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.value.trim()) {
    lobby.chat.send(e.target.value);
    e.target.value = "";
  }
  e.stopPropagation();
});
$("mic").onclick = () => {
  if (!lobby) return log("join a lobby first");
  lobby.voice.enabled = !lobby.voice.enabled;
  $("mic").textContent = lobby.voice.enabled ? "Disable voice" : "Enable voice";
};
addEventListener("keydown", (e) => { if (e.key.toLowerCase() === "v" && !e.repeat) lobby?.voice.pushToTalk(true); });
addEventListener("keyup", (e) => { if (e.key.toLowerCase() === "v") lobby?.voice.pushToTalk(false); });

// Test hook for automation.
window.__ka = { get lobby() { return lobby; }, get game() { return game; }, hashes, speaking };
