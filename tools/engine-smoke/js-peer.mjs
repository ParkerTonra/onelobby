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
const kit = new OneLobby({
  gameId: "com.onelobby.enginesmoke", netVersion: "1", lobbyServer: a.server ?? "", mode: lockstep ? "lockstep" : "raw", tickRate: 20, hashEveryTicks: 10, displayName: name, rememberSeat: false,
  relayOnly, readyTimeoutMs: 40000, advanced: { linkFactory: webRtcLinkFactoryFor(RTCPeerConnection) },
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

try {
  if (role === "host") {
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
