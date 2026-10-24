// Direct-IP smoke in Node (docs/direct-ip.md), the twin of `OneLobby.DataChannel.Smoke host-direct / join-direct`:
// same echo protocol, so a Node host and a .NET joiner (or the other way round) prove the two stacks interoperate.
// Needs a build (npm run build) and node-datachannel (a devDependency of onelobby).
//   node e2e/direct-smoke.mjs host [port] [password|-] [--no-upnp]   prints "join code ...", echoes, exits after "bye"
//   node e2e/direct-smoke.mjs join <code|address> [password]          sends "hello direct" + "fast direct", waits for echoes
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { OneLobby, webRtcLinkFactoryFor } from "../packages/client/dist/index.js";
import { hostDirect } from "../packages/client/dist/direct/index.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const t0 = Date.now();
const say = (s) => console.log(`[${String(Date.now() - t0).padStart(5)} ms] ${s}`);
// --only-typed (join): drop every candidate the host sends, so only the typed address can connect: the joiner on the
// internet whose view of the host's own candidates is private and unreachable (same as the C# smoke flag).
let dropped = 0;
const base = webRtcLinkFactoryFor(RTCPeerConnection);
const linkFactory = !flags.includes("--only-typed") ? base : {
  create(o) {
    const l = base.create(o);
    const handle = l.handleSignal.bind(l);
    l.handleSignal = (s) => {
      if (s.ice) { dropped++; return; }
      return handle(s);
    };
    return l;
  },
};
const kit = new OneLobby({
  gameId: "com.onelobby.directsmoke", netVersion: "1", lobbyServer: "", mode: "raw", displayName: `node ${args[0]}`, rememberSeat: false,
  advanced: { linkFactory },
});
kit.on("error", (e) => say(`kit error ${e.message}`));
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

if (args[0] === "host") {
  const port = Number(args[1] ?? 47810);
  const password = args[2] && args[2] !== "-" ? args[2] : undefined;
  const lobby = await hostDirect(kit, { port, password, maxPlayers: 8, openPort: !flags.includes("--no-upnp") }).catch((e) => {
    say(`FAIL host: ${e.code ?? ""} ${e.message}`);
    process.exit(1);
  });
  say(`addresses ${lobby.directAddresses.join(" ")}`);
  say(`join code ${lobby.joinCode} (${lobby.joinCodeKind}); router: ${lobby.portMapping}`);
  say(`hosting on TCP+UDP ${port}; waiting for joiners (120 s)`);
  lobby.on("peerReady", (p) => say(`peer_ready ${p.peerId} ${p.name}`));
  lobby.on("peerLeft", (p, r) => say(`peer_left ${p.peerId} ${r}`));
  const done = new Promise((resolve) => {
    lobby.on("message", (from, bytes, channel) => {
      const text = dec(bytes);
      say(`got ${channel} ${from} ${text}`);
      if (text === "bye") return resolve(true);
      lobby.send(from, enc(`echo:${text}`), { channel });
    });
    setTimeout(() => resolve(false), 120_000).unref();
  });
  const ok = await done;
  await new Promise((r) => setTimeout(r, 300));
  await lobby.leave();
  say(ok ? "PASS host" : "FAIL host: nobody said bye");
  process.exit(ok ? 0 : 1);
} else if (args[0] === "join" && args[1]) {
  const lobby = await kit.joinDirect(args[1], { password: args[2] }).catch((e) => {
    say(`FAIL join: ${e.code ?? ""} ${e.message}`);
    process.exit(1);
  });
  await lobby.ready.catch((e) => {
    say(`FAIL link to host not open: ${e.message}`);
    process.exit(1);
  });
  say(`ready after ${Date.now() - t0} ms, host ${lobby.hostPeerId}`);
  if (flags.includes("--only-typed")) say(`only-typed: dropped ${dropped} host candidates`);
  let gotReliable = false;
  let gotFast = false;
  let ended = null;
  lobby.on("sessionEnded", (r) => (ended = r));
  lobby.on("message", (from, bytes, channel) => {
    const text = dec(bytes);
    say(`got ${channel} ${from} ${text}`);
    if (text === "echo:hello direct" && channel === "reliable") gotReliable = true;
    if (text === "echo:fast direct" && channel === "fast") gotFast = true;
  });
  lobby.send(lobby.hostPeerId, enc("hello direct"));
  const until = Date.now() + 10_000;
  while (!(gotReliable && gotFast) && Date.now() < until) {
    if (!gotFast) lobby.send(lobby.hostPeerId, enc("fast direct"), { channel: "fast" });
    await new Promise((r) => setTimeout(r, 50));
  }
  lobby.send(lobby.hostPeerId, enc("bye"));
  const endBy = Date.now() + 5000;
  while (ended === null && Date.now() < endBy) await new Promise((r) => setTimeout(r, 20));
  say(`session ended: ${ended ?? "(still open)"}`);
  const ok = gotReliable && gotFast;
  say(ok ? `PASS after ${Date.now() - t0} ms` : `FAIL reliable=${gotReliable} fast=${gotFast}`);
  process.exit(ok ? 0 : 1);
} else {
  console.error("usage: node e2e/direct-smoke.mjs host [port] [password|-] [--no-upnp] | join <code|address> [password]");
  process.exit(2);
}
