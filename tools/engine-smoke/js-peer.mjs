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
