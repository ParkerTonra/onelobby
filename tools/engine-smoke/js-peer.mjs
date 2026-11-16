// JS engine peer for tools/engine-smoke (see README.md for the shared peer protocol and flags).
// Uses the BUILT client (cd clients/js && npm ci && npm run build) and node-datachannel for WebRTC.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const client = join(root, "clients/js/packages/client/dist");
const req = createRequire(join(root, "clients/js/package.json"));
const { RTCPeerConnection } = req("node-datachannel/polyfill");
const { OneLobby, webRtcLinkFactoryFor, parseTurnLine } = await import(pathToFileURL(join(client, "index.js")).href);
const { hostDirect } = await import(pathToFileURL(join(client, "direct/index.js")).href);
const { ReplicationSession, NetWriter, NetPlayers } = await import(pathToFileURL(join(client, "index.js")).href);
const { NetSimLinkFactory } = await import(pathToFileURL(join(client, "testing.js")).href);

const a = {};
for (const x of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/s.exec(x);
  if (m) a[m[1]] = m[2] ?? "1";
}
const role = a.role, route = a.route, name = a.name ?? "js";
const joiners = Number(a.joiners ?? 2), rounds = Number(a.rounds ?? 3);
const lockstep = a.sync === "lockstep";
const say = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder(), dec = new TextDecoder();
const send = (lobby, to, text, channel = "reliable") => lobby.send(to, enc.encode(text), { channel });
const bcast = (lobby, text, channel = "reliable") => lobby.broadcast(enc.encode(text), { channel });

const giveUp = setTimeout(() => { say(`RESULT FAIL ${name} gave up after ${a.timeout ?? 60} s`); process.exit(1); }, Number(a.timeout ?? 60) * 1000);
const fail = (why) => { say(`RESULT FAIL ${name} ${why}`); process.exit(1); };

// The TURN entry goes through the library's own paste parser, as a settings field would.
const turn = a.turn ? parseTurnLine(a.turn) : null;
const relayOnly = !!turn;
// --scenario=players: fake lag on every link of this peer (the C# NetSimTransport's twin): --lag (one-way ms, both ends wrapped), --jitter, --loss (percent, fast channel), --seed
const baseLinks = webRtcLinkFactoryFor(RTCPeerConnection);
const playersLink = a.scenario === "players" ? new NetSimLinkFactory(baseLinks, { latencyMs: Number(a.lag ?? 50), jitterMs: Number(a.jitter ?? 10), lossPercent: Number(a.loss ?? 2), seed: Number(a.seed ?? 1) }) : baseLinks;
const kit = new OneLobby({
  gameId: "com.onelobby.enginesmoke", netVersion: "1", lobbyServer: a.server ?? "", mode: lockstep ? "lockstep" : "raw", tickRate: 20, hashEveryTicks: 10, displayName: name, rememberSeat: false,
  relayOnly, readyTimeoutMs: 40000, advanced: { linkFactory: playersLink },
});

// ---- the lockstep exchange (--sync=lockstep): chat, a shared pause and 60 ticks of a tiny sim; the same flow in all three engine peers.
// The sim is FNV-1a 32 over every frame (tick, then peer id, length and bytes of each command), so equal hashes mean equal frames.
const SYNC_TICKS = 60, CMDS_EACH = 5;
async function syncRun(lobby, isHost, total) {
  const ls = lobby.lockstep;
  let h = 0x811c9dc5, tick = 0, cmds = 0, finalHash = null, finalCmds = 0;
  const fnv = (bytes) => { for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0; };
  const hashes = new Map();
  ls.snapshot = () => { const o = new Uint8Array(8); const v = new DataView(o.buffer); v.setUint32(0, h, true); v.setUint32(4, cmds, true); return o; };
  ls.restore = (t, b) => { const v = new DataView(b.buffer, b.byteOffset); h = v.getUint32(0, true); cmds = v.getUint32(4, true); tick = t; };
  // chat: the host speaks first; everyone answers; everyone must see one line from each of the `total` peers
  const lines = new Map();
  lobby.chat.on("message", (m) => { lines.set(m.peerId, m.text); if (!isHost && m.peerId === lobby.hostPeerId && !lines.has(lobby.localPeerId)) lobby.chat.send(`hi from ${name}`); });
  if (isHost) { await sleep(500); lobby.chat.send(`hi from ${name}`); } // a joiner may still be between ready and its handler
  for (let i = 0; i < 400 && lines.size < total; i++) await sleep(50);
  if (lines.size < total) fail(`chat: lines from ${lines.size}/${total} peers`);
  say(`chat ok lines=${lines.size}`);
  // pause: join1 pauses once at tick 20 and resumes 700 ms later; every peer sees both changes and no ticks in between
  let pausedAt = -1, gap = -1;
  lobby.pause.on("changed", (s) => {
    if (s.paused && pausedAt < 0) pausedAt = ls.lastTick;
    else if (!s.paused && pausedAt >= 0 && gap < 0) gap = ls.lastTick - pausedAt;
  });
  if (isHost) await lobby.start();
  let sent = 0, pauseAsked = false;
  const t0 = Date.now();
  while (finalHash === null) {
    for (let f; (f = ls.nextFrame()); ) {
      const b = [f.tick & 255, (f.tick >> 8) & 255, (f.tick >> 16) & 255, (f.tick >>> 24) & 255];
      fnv(b);
      for (const c of f.commands) { fnv([c.peerId & 255, c.peerId >> 8, c.bytes.length]); fnv(c.bytes); cmds++; }
      tick = f.tick;
      hashes.set(tick, h);
      ls.reportHash(tick, BigInt(h));
      if (tick % 3 === 0 && tick <= CMDS_EACH * 3 && sent < CMDS_EACH) ls.submit(Uint8Array.of(lobby.localPeerId, ++sent));
      if (tick === SYNC_TICKS) { finalHash = h; finalCmds = cmds; }
    }
    if (!pauseAsked && name.startsWith("join1") && tick >= 20) { pauseAsked = true; lobby.pause.request(true); setTimeout(() => lobby.pause.request(false), 700); }
    if (Date.now() - t0 > 40000) fail(`lockstep stalled at tick ${tick}`);
    await sleep(5);
  }
  // keep applying frames until the pause has come and gone (a host or joiner that is quick could finish before it)
  for (let i = 0; i < 300 && gap < 0; i++) { for (let f; (f = ls.nextFrame()); ) tick = f.tick; await sleep(20); }
  if (gap < 0 || gap > 4) fail(`pause: ${gap < 0 ? "never resumed" : `${gap} frames arrived while paused`}`);
  say(`LOCKSTEP tick=${SYNC_TICKS} hash=${finalHash} cmds=${finalCmds} pausegap=${gap}`);
}

// ---- room scenario (--scenario=room): the room layer end to end on one route ----------------------------------------------------
// host: password, countdown 1 s; the good joiner joins with data and says ready, the host starts, the countdown reaches it, the host kicks it with a
// reason it must see. The wrong-password joiner (--wrongpw) must be refused with bad_password.
const ROOM_PW = "smoke-pw";
async function roomScenario() {
  const until = async (cond, what, ms = 30000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) fail(`timed out: ${what}`);
      await sleep(25);
    }
  };
  if (role === "host") {
    const room = { countdownSeconds: 1, minPlayers: 2 };
    let lobby;
    if (route === "server") lobby = await kit.host({ name: "smoke", maxPlayers: 4, password: ROOM_PW, room });
    else lobby = await hostDirect(kit, { port: Number(a.port), bindHost: "127.0.0.1", publicAddress: "127.0.0.1", openPort: false, fallbackPorts: 0, maxPlayers: 4, password: ROOM_PW, room, nostr: false, log: false });
    const typed = route === "typed" ? `127.0.0.1:${a.port}` : "";
    say(`HOST_READY code=${route === "server" ? lobby.code : typed} typed=${typed} ipcode=`);
    await until(() => lobby.room.players.length === 2 && lobby.room.players.every((p) => p.id === lobby.localPeerId || p.ready), "a ready joiner");
    const j = lobby.room.players.find((p) => p.id !== lobby.localPeerId);
    if (j.data.color !== "#ff8800" || j.data.team !== "1") fail(`joiner data was ${JSON.stringify(j.data)}`);
    let started = false;
    lobby.room.on("started", () => { started = true; });
    lobby.room.start();
    await until(() => started, "start");
    say("started");
    lobby.room.kick(j.id, { code: "smoke_kick", reason: "Smoke test: bye" });
    await until(() => lobby.room.players.length === 1, "the kick to remove the joiner");
    await sleep(300);
    await lobby.leave();
    say(`RESULT PASS ${name} room host`);
    process.exit(0);
  }
  if (a.wrongpw) {
    try {
      if (route === "server") await kit.join(a.code, { password: "wrong-pw" });
      else await kit.joinDirect(a.code, { password: "wrong-pw", ...(a.relay ? { nostrRelays: [a.relay] } : {}), stun: [] });
    } catch (e) {
      if (e?.code === "bad_password") { say(`RESULT PASS ${name} refused with bad_password`); process.exit(0); }
      fail(`wrong password gave ${e?.code ?? e}`);
    }
    fail("a wrong password was accepted");
  }
  const jo = { password: ROOM_PW, data: { color: "#ff8800", team: "1" } };
  const lobby = route === "server" ? await kit.join(a.code, jo) : await kit.joinDirect(a.code, { ...jo, ...(a.relay ? { nostrRelays: [a.relay] } : {}), stun: [] });
  let removed = null, started = false, counted = false;
  lobby.room.on("removed", (r) => { removed = r; });
  lobby.room.on("started", () => { started = true; });
  lobby.room.on("countdown", () => { counted = true; });
  await until(() => lobby.room.supported === true && lobby.room.me, "the room snapshot");
  lobby.room.setReady(true);
  await until(() => started, "start");
  if (!counted) fail("no countdown reached the joiner");
  await until(() => removed, "the kick");
  const ok = removed.code === "smoke_kick" && removed.reason === "Smoke test: bye";
  say(ok ? `RESULT PASS ${name} room joiner` : `RESULT FAIL ${name} removal was ${JSON.stringify(removed)}`);
  process.exit(ok ? 0 : 1);
}

// ---- replication scenario (--scenario=replication): ReplicationSession end to end on one route; the same flow in the JS and C# peers --------
// The host spawns two entities (e1 host-owned, e2 owned by the joiner) and steps them as a pure function of the host tick (frozen after tick 60),
// despawns e2 at tick 40, sends one stream event to the joiner at tick 10. The joiner submits one input byte per tick, sends one event to the host
// when it first sees an entity, and sends the raw message "bye" once it holds a snapshot of tick >= 66. Both print
// REPL spawned=2 despawned=1 entities=1 events=1 hash=<FNV-1a 32 of e1's id, type, owner and state bytes>; run.mjs requires the two lines equal.
const writeRepl = (w, x, z, yaw, hp) => { w.writeQuantized(x, -256, 256, 16); w.writeQuantized(z, -256, 256, 16); w.writeAngle(yaw, 9); w.writeBits(hp, 7); };
const replState = { read: (r) => ({ x: r.readQuantized(-256, 256, 16), z: r.readQuantized(-256, 256, 16), yaw: r.readAngle(9), hp: r.readBits(7) }), lerp: (p, q, t) => (t < 0.5 ? p : q) };
const e1At = (t) => { const T = Math.min(t, 60); return { x: -100 + 1.5 * T, z: 20, yaw: (T * 7) % 360, hp: 100 - (T % 10) }; };
const e2At = (t) => { const T = Math.min(t, 60); return { x: 50 - 0.5 * T, z: -20, yaw: (T * 3) % 360, hp: 90 }; };
function replHash(owner, s) {
  const w = new NetWriter();
  writeRepl(w, s.x, s.z, s.yaw, s.hp);
  let h = 0x811c9dc5;
  for (const b of [1, 1, owner, ...w.toBytes()]) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h;
}
async function replicationScenario() {
  const until = async (cond, what, ms = 40000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) fail(`timed out: ${what}`);
      await sleep(5);
    }
  };
  if (role === "host") {
    let lobby;
    if (route === "server") lobby = await kit.host({ name: "smoke", maxPlayers: 4 });
    else lobby = await hostDirect(kit, { port: Number(a.port), bindHost: "127.0.0.1", publicAddress: "127.0.0.1", openPort: false, fallbackPorts: 0, maxPlayers: 4, nostr: false, log: false });
    const typed = route === "typed" ? `127.0.0.1:${a.port}` : "";
    say(`HOST_READY code=${route === "server" ? lobby.code : typed} typed=${typed} ipcode=`);
    await until(() => lobby.connectedPeers.length >= 1, "a linked joiner");
    const joiner = lobby.connectedPeers[0];
    const rep = new ReplicationSession(lobby);
    let e1 = e1At(0), e2 = e2At(0), spawned = 0, despawned = 0, events = 0, bye = false, bad = "";
    const id1 = rep.spawn(1, 0, (w) => writeRepl(w, e1.x, e1.z, e1.yaw, e1.hp)); spawned++;
    const id2 = rep.spawn(2, joiner, (w) => writeRepl(w, e2.x, e2.z, e2.yaw, e2.hp)); spawned++;
    rep.on("eventReceived", (_f, _t, p) => { if (dec.decode(p) === "hello-host") events++; else bad = "event " + dec.decode(p); });
    rep.on("otherMessage", (_f, p) => { if (dec.decode(p) === "bye") bye = true; });
    const seqs = [];
    while (!(bye && rep.clock.tick >= 75 && events === 1)) {
      rep.pump();
      while (rep.clock.tryAdvance()) {
        const t = rep.clock.tick;
        e1 = e1At(t); e2 = e2At(t);
        if (t === 10) rep.sendEvent(enc.encode("hello-client"), { to: joiner, stream: 1 });
        if (t === 40) { rep.despawn(id2); despawned++; }
        const f = rep.tryGetInput(joiner);
        if (f && !f.repeated) { seqs.push(f.seq); if (f.bytes.length !== 1 || f.bytes[0] !== (f.seq & 255)) bad = "input bytes of seq " + f.seq; }
        rep.sendSnapshot();
      }
      await sleep(2);
    }
    const contiguous = seqs.length >= 20 && seqs.every((q, i) => i === 0 || q === seqs[i - 1] + 1);
    say(`REPL spawned=${spawned} despawned=${despawned} entities=${rep.hostEntities().length} events=${events} hash=${replHash(0, e1)}`);
    await sleep(300);
    await lobby.leave();
    const ok = contiguous && !bad && rep.stats.malformed === 0;
    say(ok ? `RESULT PASS ${name} replication host` : `RESULT FAIL ${name} inputs ${seqs.length} contiguous=${contiguous} ${bad} malformed=${rep.stats.malformed}`);
    process.exit(ok ? 0 : 1);
  }
  const lobby = route === "server" ? await kit.join(a.code) : await kit.joinDirect(a.code, { ...(a.relay ? { nostrRelays: [a.relay] } : {}), stun: [] });
  await lobby.ready;
  const rep = new ReplicationSession(lobby);
  let spawned = 0, despawned = 0, events = 0, said = false;
  rep.on("entitySpawned", () => { spawned++; if (!said) { said = true; rep.sendEvent(enc.encode("hello-host")); } });
  rep.on("entityDespawned", () => despawned++);
  rep.on("eventDelivered", (e) => { if (dec.decode(e.payload) === "hello-client" && e.stream === 1 && e.seq === 1) events++; });
  const t0 = Date.now();
  while (!(spawned === 2 && despawned === 1 && events === 1 && rep.latestTick >= 66 && rep.lastProcessedInput > 0)) {
    rep.pump();
    while (rep.clock.tryAdvance()) rep.submitInput(Uint8Array.of(rep.clock.tick & 255));
    if (Date.now() - t0 > 40000) fail(`stalled: spawned ${spawned} despawned ${despawned} events ${events} latest ${rep.latestTick}`);
    await sleep(2);
  }
  const latest = rep.tryGetLatest(1, replState);
  say(`REPL spawned=${spawned} despawned=${despawned} entities=${rep.entities.length} events=${events} hash=${replHash(0, latest.state)}`);
  lobby.send(lobby.hostPeerId, enc.encode("bye"));
  await sleep(500);
  await lobby.leave();
  const ok = rep.stats.malformed === 0 && rep.entities.length === 1 && Math.abs(latest.state.x - e1At(60).x) < 0.01;
  say(ok ? `RESULT PASS ${name} replication joiner` : `RESULT FAIL ${name} malformed=${rep.stats.malformed} entities=${rep.entities.length} x=${latest.state.x}`);
  process.exit(ok ? 0 : 1);
}

// ---- players scenario (--scenario=players): the networked player layer between engines over a lagging link; the same flow in the JS, GDScript and C# peers ----
// THE RULE (README, "The players scenario"; every peer writes it once in its own language):
//   walk (t seconds from the walk start): heading h = 0.75 * t rad, speed 6 m/s: x = 8 (1 - cos h), z = 8 sin h, v = 6 (sin h, cos h), yaw = h in degrees [0, 360);
//   jump at t = 2 s: y = 5 s - 7.5 s^2 for s = t - 2 in [0, 2/3), on the ground otherwise; mode 4 in the air, 1 walking, 0 standing; stand at t >= 6.
//   authority "owner": the joiner gives that state as its own every loop. authority "host": the joiner gives the input moveY 1 (0 from t = 6), yaw = h in
//   degrees, jump pressed for t in [2, 2.1), and both ends run the same step (below). One jump action event at t = 2 in both.
const P_SPEED = 6, P_W = 0.75, P_JUMP_AT = 2, P_JUMP_V = 5, P_GRAV = 15, P_WALK_S = 6, P_SETTLE_MS = 1500, P_HOLD_MS = 1000, P_CHUNK = 20, P_MSG = 0x54;
const pathState = (t) => {
  const tt = Math.min(Math.max(t, 0), P_WALK_S), h = P_W * tt, R = P_SPEED / P_W, s = tt - P_JUMP_AT, air = s >= 0 && s < (2 * P_JUMP_V) / P_GRAV, walking = t >= 0 && t < P_WALK_S;
  return {
    x: R * (1 - Math.cos(h)), z: R * Math.sin(h), y: air ? P_JUMP_V * s - 0.5 * P_GRAV * s * s : 0, vx: walking ? P_SPEED * Math.sin(h) : 0, vz: walking ? P_SPEED * Math.cos(h) : 0,
    vy: air ? P_JUMP_V - P_GRAV * s : 0, yaw: ((h * 180) / Math.PI) % 360, onGround: !air, mode: air ? 4 : walking ? 1 : 0,
  };
};
const pathInput = (t) => ({ moveX: 0, moveY: t >= 0 && t < P_WALK_S ? 1 : 0, yaw: ((P_W * Math.min(Math.max(t, 0), P_WALK_S) * 180) / Math.PI) % 360, buttons: { jump: t >= P_JUMP_AT && t < P_JUMP_AT + 0.1 } });
const playerStep = (s, i, dt) => {
  const yaw = (i.yaw * Math.PI) / 180, vx = P_SPEED * (i.moveY * Math.sin(yaw) + i.moveX * Math.cos(yaw)), vz = P_SPEED * (i.moveY * Math.cos(yaw) - i.moveX * Math.sin(yaw));
  let { y, vy, onGround } = s;
  if (onGround && i.buttons.jump) { vy = P_JUMP_V; onGround = false; }
  if (!onGround) { vy -= P_GRAV * dt; y += vy * dt; if (y <= 0) { y = 0; vy = 0; onGround = true; } }
  return { ...s, x: s.x + vx * dt, z: s.z + vz * dt, y, vx, vz, vy, yaw: i.yaw, onGround, mode: onGround ? (i.moveX !== 0 || i.moveY !== 0 ? 1 : 0) : 4 };
};
// a trace is [[unix ms, x, y, z], ...]; at(): the owner's position at time t by linear interpolation, null outside the trace
function traceAt(path, t) {
  const n = path.length;
  if (n === 0 || t < path[0][0] || t > path[n - 1][0]) return null;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (path[m][0] <= t) lo = m; else hi = m; }
  const p = path[lo], q = path[hi], k = q[0] === p[0] ? 0 : (t - p[0]) / (q[0] - p[0]);
  return [p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k, p[3] + (q[3] - p[3]) * k];
}
// the one constant lag (0 to 600 ms, 8 ms steps) at which the watched path is closest to the owner's on average; then the mean and worst distance there
function comparePaths(owner, watched) {
  let best = { lag: 0, mean: Infinity, max: Infinity, n: 0 };
  for (let lag = 0; lag <= 600; lag += 8) {
    let sum = 0, mx = 0, n = 0;
    for (const w of watched) {
      const o = traceAt(owner, w[0] - lag);
      if (!o) continue;
      const d = Math.hypot(w[1] - o[0], w[2] - o[1], w[3] - o[2]);
      sum += d; mx = Math.max(mx, d); n++;
    }
    if (n > 20 && sum / n < best.mean) best = { lag, mean: sum / n, max: mx, n };
  }
  return best;
}
const fmtTrace = (rows) => rows.map((r) => `${r[0]},${r[1].toFixed(3)},${r[2].toFixed(3)},${r[3].toFixed(3)}`).join(";");
const tmsg = (text) => { const b = enc.encode("T" + text); b[0] = P_MSG; return b; };
async function playersScenario() {
  const authority = a.authority === "host" ? "host" : "owner";
  const t00 = Date.now();
  const until = async (cond, what, ms = 60000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) fail(`timed out: ${what}`);
      await sleep(2);
    }
  };
  const opts = authority === "host" ? { authority, step: playerStep } : { authority };
  if (role === "host") {
    let lobby;
    if (route === "server") lobby = await kit.host({ name: "smoke", maxPlayers: 4 });
    else lobby = await hostDirect(kit, { port: Number(a.port), bindHost: "127.0.0.1", publicAddress: "127.0.0.1", openPort: false, fallbackPorts: 0, maxPlayers: 4, nostr: false, log: false });
    const typed = route === "typed" ? `127.0.0.1:${a.port}` : "";
    say(`HOST_READY code=${route === "server" ? lobby.code : typed} typed=${typed} ipcode=`);
    await until(() => lobby.connectedPeers.length >= 1, "a linked joiner");
    const joiner = lobby.connectedPeers[0];
    const players = new NetPlayers(lobby, opts);
    if (authority === "owner") players.setLocalState({});
    let jumpsCopy = 0, remoteJumps = -1, ended = false;
    const own = [], copy = [];
    players.onAction("jump", (e) => { if (e.player === joiner) jumpsCopy++; });
    players.session.on("otherMessage", (_from, p) => {
      if (p[0] !== P_MSG) return;
      const f = dec.decode(p.subarray(1)).split("|"); // "S|t,x,y,z;t,x,y,z" a part of the trace, "E|<jumps>" the end
      if (f[0] === "S") for (const row of f[1].split(";")) { const c = row.split(",").map(Number); if (c.length === 4) own.push(c); }
      else if (f[0] === "E") { remoteJumps = Number(f[1]); ended = true; }
    });
    let lastCopy = 0;
    while (!ended) {
      players.pump();
      const now = Date.now();
      if (now - lastCopy >= 20) { lastCopy = now; const s = players.get(joiner); if (s) copy.push([now, s.x, s.y, s.z]); }
      if (now - t00 > Number(a.timeout ?? 60) * 1000 - 3000) fail(`timed out: the joiner's trace (${own.length} samples so far, ${copy.length} copies)`);
      await sleep(2);
    }
    const r = comparePaths(own, copy);
    say(`PLAYERS lag=${r.lag} mean=${r.mean.toFixed(3)} worst=${r.max.toFixed(3)} samples=${r.n} jumps=${remoteJumps}/${jumpsCopy}`);
    lobby.send(joiner, tmsg("D"));
    const t1 = Date.now();
    while (Date.now() - t1 < 600) { players.pump(); await sleep(2); }
    await lobby.leave();
    const ok = Number.isFinite(r.mean) && players.session.stats.malformed === 0;
    say(ok ? `RESULT PASS ${name} players host (${authority})` : `RESULT FAIL ${name} players: no comparison or malformed=${players.session.stats.malformed}`);
    process.exit(ok ? 0 : 1);
  }
  const lobby = route === "server" ? await kit.join(a.code) : await kit.joinDirect(a.code, { ...(a.relay ? { nostrRelays: [a.relay] } : {}), stun: [] });
  await lobby.ready;
  const players = new NetPlayers(lobby, opts);
  let jumpsOwn = 0, done = false;
  players.onAction("jump", (e) => { if (e.local) jumpsOwn++; });
  players.session.on("otherMessage", (_from, p) => { if (p[0] === P_MSG && dec.decode(p.subarray(1)) === "D") done = true; });
  const drive = (t) => { if (authority === "owner") players.setLocalState(pathState(t)); else players.setLocalInput(pathInput(t)); };
  drive(-1);
  const own = [];
  let phase = "wait", mark = 0, jumped = false, lastTick = -1;
  while (phase !== "sent") {
    const now = Date.now();
    if (phase === "wait" && (authority === "owner" ? players.players.includes(lobby.localPeerId) : players.local !== undefined)) { phase = "settle"; mark = now; }
    if (phase === "settle" && now - mark >= P_SETTLE_MS) { phase = "walk"; mark = now; }
    const t = phase === "walk" || phase === "hold" ? (now - mark) / 1000 : -1;
    drive(t);
    if (t >= P_JUMP_AT && !jumped) { jumped = true; players.action("jump"); }
    players.pump();
    if (phase === "walk" && players.session.clock.tick !== lastTick) {
      lastTick = players.session.clock.tick;
      const l = players.local;
      if (l) own.push([now, l.x, l.y, l.z]);
    }
    if (phase === "walk" && t >= P_WALK_S) phase = "hold";
    if (phase === "hold" && t >= P_WALK_S + P_HOLD_MS / 1000) {
      for (let i = 0; i < own.length; i += P_CHUNK) lobby.send(lobby.hostPeerId, tmsg("S|" + fmtTrace(own.slice(i, i + P_CHUNK))));
      lobby.send(lobby.hostPeerId, tmsg(`E|${jumpsOwn}`));
      say(`PLAYERS_JOINER samples=${own.length} jumps=${jumpsOwn}`);
      phase = "sent";
    }
    if (now - t00 > 60000 && phase === "wait") fail("the player never came into the world");
    await sleep(2);
  }
  const t1 = Date.now();
  while (!done && Date.now() - t1 < 20000) { players.pump(); await sleep(2); }
  await lobby.leave();
  const ok = done && jumpsOwn === 1 && players.session.stats.malformed === 0;
  say(ok ? `RESULT PASS ${name} players joiner (${authority})` : `RESULT FAIL ${name} players joiner: done=${done} jumps=${jumpsOwn} malformed=${players.session.stats.malformed}`);
  process.exit(ok ? 0 : 1);
}

try {
  if (a.scenario === "room") await roomScenario();
  else if (a.scenario === "players") await playersScenario();
  else if (a.scenario === "replication") await replicationScenario();
  else if (role === "host") {
    let lobby, typed = "", code, ipcode = "";
    if (route === "server") {
      lobby = await kit.host({ name: "smoke", maxPlayers: 4 });
      code = lobby.code;
    } else {
      const port = Number(a.port);
      const nostr = route === "typed" || route === "ipcode" ? false : { relays: [a.relay], stun: [] };
      lobby = await hostDirect(kit, {
        port, bindHost: "127.0.0.1", publicAddress: "127.0.0.1", openPort: false, fallbackPorts: 0, maxPlayers: 4,
        nostr, ...(turn ? { iceServers: [turn] } : {}), log: false,
      });
      typed = `127.0.0.1:${port}`;
      ipcode = lobby.directCode;
      code = route === "typed" ? typed : route === "ipcode" ? lobby.directCode : lobby.joinCode;
    }
    say(`HOST_READY code=${code} typed=${typed} ipcode=${ipcode}`);
    const ready = new Set();
    const pong = new Map(), fpong = new Map(), byes = new Set();
    lobby.on("peerReady", (p) => { ready.add(p.peerId); say(`peer_ready ${p.peerId}`); });
    lobby.on("message", (from, bytes, channel) => {
      const [kind, r] = dec.decode(bytes).split("|");
      if (kind === "pong") (pong.get(r) ?? pong.set(r, new Set()).get(r)).add(from);
      else if (kind === "fpong" && channel === "fast") (fpong.get(r) ?? fpong.set(r, new Set()).get(r)).add(from);
      else if (kind === "bye") byes.add(from);
    });
    while (ready.size < joiners) await sleep(50);
    if (lockstep) {
      await syncRun(lobby, true, joiners + 1);
      for (let i = 0; i < 400 && byes.size < joiners; i++) await sleep(50);
      if (byes.size < joiners) fail(`only ${byes.size}/${joiners} joiners said bye`);
      bcast(lobby, "done");
      await sleep(500);
      await lobby.leave();
      say(`RESULT PASS ${name} host lockstep joiners=${joiners}`);
      process.exit(0);
    }
    for (let r = 1; r <= rounds; r++) {
      bcast(lobby, `ping|${r}`);
      while ((pong.get(String(r))?.size ?? 0) < joiners || (fpong.get(String(r))?.size ?? 0) < joiners) {
        bcast(lobby, `fping|${r}`, "fast");
        await sleep(200);
      }
      say(`round ${r} ok`);
    }
    bcast(lobby, "done");
    for (let i = 0; i < 100 && byes.size < joiners; i++) await sleep(100);
    if (byes.size < joiners) fail(`only ${byes.size}/${joiners} joiners said bye`);
    await sleep(300);
    await lobby.leave();
    say(`RESULT PASS ${name} host rounds=${rounds} joiners=${joiners}`);
    process.exit(0);
  } else {
    const jo = { ...(turn ? { iceServers: [turn] } : {}), ...(a.relay ? { nostrRelays: [a.relay] } : {}), stun: [] };
    const lobby = route === "server" ? await kit.join(a.code) : await kit.joinDirect(a.code, jo);
    const seen = new Set(), fseen = new Set();
    let done = false;
    lobby.on("message", (from, bytes, channel) => {
      const [kind, r] = dec.decode(bytes).split("|");
      if (kind === "ping") { seen.add(r); send(lobby, from, `pong|${r}|${name}`); }
      else if (kind === "fping" && channel === "fast") { fseen.add(r); send(lobby, from, `fpong|${r}|${name}`, "fast"); }
      else if (kind === "done") { done = true; send(lobby, from, `bye|${name}`); }
    });
    await lobby.ready;
    say(`ready, host ${lobby.hostPeerId}`);
    if (lockstep) {
      await syncRun(lobby, false, Number(a.peers));
      send(lobby, lobby.hostPeerId, `bye|${name}`);
      while (!done) await sleep(50);
      await sleep(300);
      await lobby.leave();
      say(`RESULT PASS ${name} joiner lockstep`);
      process.exit(0);
    }
    while (!done) await sleep(50);
    await sleep(500);
    await lobby.leave();
    const ok = seen.size === rounds && fseen.size === rounds;
    say(ok ? `RESULT PASS ${name} joiner rounds=${rounds}` : `RESULT FAIL ${name} saw reliable ${seen.size}/${rounds} fast ${fseen.size}/${rounds}`);
    process.exit(ok ? 0 : 1);
  }
} catch (e) {
  fail(`${e?.code ?? ""} ${e?.message ?? e}`);
} finally {
  clearTimeout(giveUp);
}
