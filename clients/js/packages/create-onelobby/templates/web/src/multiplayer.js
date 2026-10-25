// The page's multiplayer wiring. Reads onelobby.json at runtime (fetch), so editing the file (say chat.voice) changes
// the controls on the next reload with no rebuild. The game stays playable offline whatever happens to the network.
import { describeError, formatCode, shareUrl, codeFromUrl } from "onelobby";
import { Gridpaint, PALETTE, W, H, paintCmd } from "./game.js";
import { bindSession, features, loadBlueprint, lobbyServerSetting, makeKit, saveLobbyServer } from "./session.js";

const $ = (id) => document.getElementById(id);
const say = (text) => ($("net-status").textContent = text);
const fail = (e) => {
  const f = describeError(e); // plain words for players, e.g. "That lobby is full." plus a hint
  say(f.hint ? `${f.message} ${f.hint}` : f.message);
};
const guard = (fn) => async () => {
  try {
    await fn();
  } catch (e) {
    fail(e);
  }
};

// ---- the game: solo until a lobby starts, then driven by the lobby ---------------------------------------------------
let solo = new Gridpaint("SOLO00");
let session = null; // bindSession(...) while in a lobby
let lobby = null;
let soloLast = performance.now();

const ctx = $("grid").getContext("2d");
function draw(game) {
  const s = $("grid").width / W;
  for (let i = 0; i < W * H; i++) {
    ctx.fillStyle = game.grid[i] ? PALETTE[game.grid[i]] : "#f4f4f4";
    ctx.fillRect((i % W) * s, Math.floor(i / W) * s, s - 1, s - 1);
  }
}

$("grid").addEventListener("pointerdown", (e) => {
  const r = $("grid").getBoundingClientRect();
  const x = Math.floor(((e.clientX - r.left) / r.width) * W);
  const y = Math.floor(((e.clientY - r.top) / r.height) * H);
  if (session && lobby.phase === "in_game") session.send(paintCmd(x, y));
  else if (!lobby) solo.apply(1, paintCmd(x, y));
});

// The last few hundred ticks and their hashes, for the headless test (test/multiplayer.mjs) to compare players.
const trail = new Map();
globalThis.onelobbyDebug = { trail: () => [...trail].map(([t, h]) => [t, String(h)]) };

function frame(now) {
  if (session) {
    session.pump(now);
    trail.set(session.game.tick, session.hash);
    if (trail.size > 400) trail.delete(trail.keys().next().value);
    draw(session.game);
    $("status").textContent = `tick ${session.game.tick}  ${session.desyncs ? "DESYNC" : "in sync"}  players ${lobby.peers.length}`;
  } else {
    while (now - soloLast >= 50) {
      soloLast += 50;
      solo.step(solo.tick + 1, []);
    }
    draw(solo);
    $("status").textContent = lobby ? "waiting for the host to start" : "offline: playing alone";
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- multiplayer -----------------------------------------------------------------------------------------------------
let blueprintJson = null;
let bp = null; // kit.blueprint: the validated file with every default filled in
let feat = null;

function refresh() {
  $("start").hidden = !(lobby && lobby.isHost && lobby.phase === "lobby");
  $("leave").hidden = !lobby;
  $("host").disabled = $("join").disabled = !!lobby;
  $("chat").hidden = !(lobby && feat.chat);
  $("voice").hidden = !(lobby && feat.voice);
}

function chatLine(text) {
  const d = document.createElement("div");
  d.textContent = text;
  $("chat-log").append(d);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
}

function enter(l, kit) {
  lobby = l;
  session = bindSession(l, kit.blueprint, new Gridpaint(l.code));
  const code = formatCode(l.code);
  say(`Lobby code: ${code}` + (feat.joinLink ? `  link: ${shareUrl(l.code)}` : ""));
  l.on("phase", refresh);
  l.on("hostChanged", refresh);
  l.on("peerJoined", (p) => chatLine(`${p.name} joined`));
  l.on("peerLeft", (p) => chatLine(`${p.name} left`));
  l.on("sessionEnded", (why) => {
    say(`The session ended (${why}). Playing alone again.`);
    lobby = null;
    session = null;
    trail.clear();
    refresh();
  });
  if (feat.chat) {
    l.chat.on("message", (m) => chatLine(`${l.peer(m.peerId)?.name ?? m.peerId}: ${m.text}`));
    l.chat.on("history", (lines) => lines.forEach((m) => chatLine(`${l.peer(m.peerId)?.name ?? m.peerId}: ${m.text}`)));
  }
  refresh();
}

async function connect(action) {
  const server = $("server").value.trim();
  if (feat.server && !server) throw new Error("Type the lobby server address first (for example ws://127.0.0.1:8080/ws).");
  saveLobbyServer(server === (blueprintJson.hosting?.lobbyServer ?? "") ? "" : server);
  const kit = makeKit(blueprintJson, { displayName: feat.nameBox ? $("name").value.trim() : "", lobbyServer: server });
  kit.on("error", fail);
  enter(await action(kit), kit);
}

async function init() {
  try {
    blueprintJson = await loadBlueprint("./onelobby.json");
    const probe = makeKit(blueprintJson); // validates the file; kit.blueprint has every default filled in
    bp = probe.blueprint;
    feat = features(bp);
  } catch (e) {
    $("net").hidden = false;
    say(`Multiplayer unavailable: ${e.message ?? e}. You can still play alone.`);
    for (const id of ["host", "join", "code", "name", "server"]) $(id).disabled = true;
    return;
  }
  $("net").hidden = false;
  $("name-row").hidden = !feat.nameBox;
  $("server-row").hidden = !feat.server;
  $("name").maxLength = bp.players.maxNameLength;
  $("server").value = lobbyServerSetting(blueprintJson);
  $("browse").hidden = !feat.browse;
  $("voice").hidden = $("chat").hidden = $("start").hidden = $("leave").hidden = true;

  $("host").onclick = guard(() => connect((kit) => kit.host()));
  $("join").onclick = guard(() => connect((kit) => kit.join($("code").value)));
  $("start").onclick = guard(async () => lobby.start());
  $("leave").onclick = guard(async () => {
    const l = lobby;
    lobby = session = null;
    refresh();
    say("Left the lobby. Playing alone.");
    await l.leave();
  });
  $("browse").onclick = guard(async () => {
    const server = $("server").value.trim();
    const kit = makeKit(blueprintJson, { lobbyServer: server });
    const list = await kit.list();
    $("lobbies").replaceChildren(
      ...(list.length ? list : [{ name: "No public lobbies right now.", code: "" }]).map((s) => {
        const li = document.createElement("li");
        li.textContent = s.code ? `${s.name} (${s.players}/${s.maxPlayers})` : s.name;
        if (s.code) li.onclick = guard(() => connect((k) => k.join(s.code)));
        return li;
      }),
    );
  });
  $("chat-form").onsubmit = (e) => {
    e.preventDefault();
    const text = $("chat-input").value.trim();
    if (text && lobby) {
      try {
        lobby.chat.send(text);
      } catch (err) {
        fail(err);
      }
      $("chat-input").value = "";
    }
  };
  // Voice: needs chat.voice in onelobby.json (the library refuses it otherwise, even if this button were shown).
  const talk = (down) => {
    if (!lobby) return;
    try {
      lobby.voice.enabled = true;
      lobby.voice.pushToTalk(down);
    } catch (err) {
      fail(err);
    }
  };
  $("voice").onpointerdown = () => talk(true);
  $("voice").onpointerup = $("voice").onpointerleave = () => talk(false);

  // Opened from a share link (?join=7HQ-4K2): join straight away. Otherwise offer to take the old seat back.
  const linked = codeFromUrl();
  if (linked && $("server").value) {
    $("code").value = linked;
    guard(() => connect((kit) => kit.join(linked)))();
  }
  refresh();
}

init();
