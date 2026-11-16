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
const { ReplicationSession, NetWriter } = await import(pathToFileURL(join(client, "index.js")).href);

const a = {};
for (const x of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/s.exec(x);
  if (m) a[m[1]] = m[2] ?? "1";
}
const role = a.role, route = a.route, name = a.name ?? "js";
const joiners = Number(a.joiners ?? 2), rounds = Number(a.rounds ?? 3);
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
  gameId: "com.onelobby.enginesmoke", netVersion: "1", lobbyServer: a.server ?? "", mode: "raw", displayName: name, rememberSeat: false,
  relayOnly, readyTimeoutMs: 40000, advanced: { linkFactory: webRtcLinkFactoryFor(RTCPeerConnection) },
});

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

try {
  if (a.scenario === "room") await roomScenario();
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
