// The JS side of integration/nostr-interop.mjs: hosts or joins a raw-mode direct lobby with a Nostr code, the same
// protocol as the .NET peer (clients/dotnet/OneLobby.DataChannel.Smoke host-direct / join-direct). Uses the BUILT client
// (cd clients/js && npm run build) and node-datachannel for WebRTC.
//   node integration/nostr-interop-peer.mjs host [--port N] [--relays url,url] [--stun none|url,url] [--wait S]
//   node integration/nostr-interop-peer.mjs join <code> [--relays url,url] [--stun none|url,url]
// Without --relays the library's default relays are used (real, public ones). `--stun none` = no ICE servers (loopback).
// Prints "join code <code> (<kind>)" (host), "got <channel> <from> <text>", and PASS / FAIL. Exit 0 on PASS.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const client = join(root, "clients/js/packages/client/dist");
const req = createRequire(join(root, "clients/js/package.json"));
const { RTCPeerConnection } = req("node-datachannel/polyfill");
const { OneLobby, webRtcLinkFactoryFor } = await import(pathToFileURL(join(client, "index.js")).href);
const { hostDirect } = await import(pathToFileURL(join(client, "direct/index.js")).href);

const args = process.argv.slice(2);
const mode = args.shift();
const opt = (name, d) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : d;
};
const relays = opt("relays", "") ? opt("relays").split(",") : undefined;
const stunArg = opt("stun", "");
const stun = stunArg === "none" ? [] : stunArg ? stunArg.split(",") : undefined;
const say = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const dec = new TextDecoder();
const kit = (name) =>
  new OneLobby({
    gameId: "com.onelobby.directsmoke", netVersion: "1", lobbyServer: "", mode: "raw", displayName: name, rememberSeat: false,
    advanced: { linkFactory: webRtcLinkFactoryFor(RTCPeerConnection) },
  });
const giveUp = setTimeout(() => { say("FAIL gave up after 60 s"); process.exit(1); }, 60_000);

try {
  if (mode === "host") {
    const port = Number(opt("port", 47810));
    const host = await hostDirect(kit("JS host"), {
      port, openPort: false, fallbackPorts: 0, maxPlayers: 4,
      nostr: { ...(relays ? { relays } : {}), ...(stun ? { stun } : {}) }, log: say,
    });
    say(`join code ${host.joinCode} (${host.joinCodeKind}); ip code ${host.directCode} (${host.directCodeKind})`);
    let bye = false;
    host.on("peerReady", (p) => say(`peer_ready ${p.peerId} ${p.name}`));
    host.on("message", (from, bytes, channel) => {
      const text = dec.decode(bytes);
      say(`got ${channel} ${from} ${text}`);
      if (text === "bye") bye = true;
      else host.send(from, enc.encode("echo:" + text), { channel });
    });
    const waitS = Number(opt("wait", 50));
    for (let i = 0; i < waitS * 10 && !bye; i++) await sleep(100);
    await sleep(300);
    await host.leave();
    say(bye ? "PASS host" : "FAIL host: nobody said bye");
    process.exit(bye ? 0 : 1);
  } else if (mode === "join") {
    const code = args.shift();
    const lobby = await kit("JS joiner").joinDirect(code, { ...(relays ? { nostrRelays: relays } : {}), ...(stun ? { stun } : {}) });
    await lobby.ready;
    say(`ready, host ${lobby.hostPeerId}`);
    const got = { reliable: false, fast: false };
    lobby.on("message", (from, bytes, channel) => {
      const text = dec.decode(bytes);
      say(`got ${channel} ${from} ${text}`);
      if (text === "echo:hello direct" && channel === "reliable") got.reliable = true;
      if (text === "echo:fast direct" && channel === "fast") got.fast = true;
    });
    lobby.send(lobby.hostPeerId, enc.encode("hello direct"));
    for (let i = 0; i < 100 && !(got.reliable && got.fast); i++) {
      if (!got.fast) lobby.send(lobby.hostPeerId, enc.encode("fast direct"), { channel: "fast" });
      await sleep(100);
    }
    lobby.send(lobby.hostPeerId, enc.encode("bye"));
    await sleep(500);
    await lobby.leave();
    const ok = got.reliable && got.fast;
    say(ok ? "PASS" : `FAIL reliable=${got.reliable} fast=${got.fast}`);
    process.exit(ok ? 0 : 1);
  } else {
    say("usage: host [--port N] ... | join <code> ...");
    process.exit(2);
  }
} catch (e) {
  say(`FAIL ${e?.code ?? ""} ${e?.message ?? e}`);
  process.exit(1);
} finally {
  clearTimeout(giveUp);
}
