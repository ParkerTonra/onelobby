// A local TURN server for the engine smoke (pure node, no credentials of any real service): node-turn on 127.0.0.1 with a
// fresh random user/password per run. It relays only between loopback addresses, which is all the smoke needs.
//   import { startTurn } from "./turn-server.mjs";
//   const t = await startTurn();  t.line   // "turn:127.0.0.1:PORT user pass", the text a player would paste
//   t.stats.allocations           // relay allocations made so far (proof that a run really went through the relay)
//   await t.close();
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";

const require = createRequire(import.meta.url);
const Turn = require("node-turn");

// node-turn answers a successful ChannelBind without MESSAGE-INTEGRITY, which RFC 8656 requires and libjuice (Godot's and
// libdatachannel's ICE) rightly ignores: the link then stalls as soon as the client moves from Send indications to channels.
// Sign it like createPermission already does. (Fix lives here, in the test server only; no OneLobby code is involved.)
const ChannelBind = require("node-turn/lib/methods/channelBind.js");
const channelBind = ChannelBind.prototype.channelBind;
ChannelBind.prototype.channelBind = function (msg, reply) {
  const resolve = reply.resolve.bind(reply);
  reply.resolve = () => { reply.addAttribute("software", this.server.software); reply.addAttribute("message-integrity"); resolve(); };
  return channelBind.call(this, msg, reply);
};

function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const s = createSocket("udp4");
    s.once("error", reject);
    s.bind(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// node-turn's Refresh without a LIFETIME attribute re-arms the allocation timer with NaN (Node turns that into 1 ms), which
// deletes the allocation moments after a client refreshed it. Use the allocation's own lifetime instead, as RFC 8656 says.
const Allocation = require("node-turn/lib/allocation.js");
const update = Allocation.prototype.update;
Allocation.prototype.update = function (lifetime) { return update.call(this, lifetime || this.lifetime); };

export async function startTurn() {
  const port = await freeUdpPort();
  const username = "smoke" + randomBytes(3).toString("hex");
  const password = randomBytes(12).toString("hex"); // generated per run, never stored anywhere
  const stats = { allocations: 0, relayed: 0, log: [] };
  const server = new Turn({
    authMech: "long-term",
    credentials: { [username]: password },
    listeningPort: port,
    listeningIps: ["127.0.0.1"],
    relayIps: ["127.0.0.1"],
    minPort: 49152,
    maxPort: 65535,
    debugLevel: "DEBUG", // the debug hook below only counts allocations; nothing is printed
    debug: (level, message) => {
      const m = String(message);
      if (/^Sending .* allocate success/i.test(m)) stats.allocations++; // one per relay allocation a client made
      if (/send indication|channel_bind|channel data/i.test(m)) stats.relayed++; // packets that really went through the relay
      if (stats.log.length < 200 && /allocate|ERROR/i.test(m)) stats.log.push(`${level} ${m}`.slice(0, 200));
    },
  });
  server.start();
  // node-turn also drops ChannelData sent by a client (it only relays Send indications): once libjuice switches an established
  // pair to a bound channel, client -> peer packets vanish and the link stalls. Relay them like RFC 8656 section 12.
  for (const sock of server.network.sockets) {
    sock.prependListener("message", (buf, rinfo) => {
      if (buf.length < 4 || buf[0] < 0x40 || buf[0] > 0x7f) return;
      const alloc = Object.values(server.allocations).find((x) => x.mappedAddress.address === rinfo.address && x.mappedAddress.port === rinfo.port);
      const peer = alloc?.channelBindings[buf.readUInt16BE(0)];
      if (!peer) return;
      stats.relayed++;
      alloc.sockets[0].send(buf.subarray(4, 4 + buf.readUInt16BE(2)), peer.port, peer.address);
    });
  }
  await new Promise((r) => setTimeout(r, 200));
  return {
    port, username, password, stats,
    line: `turn:127.0.0.1:${port} ${username} ${password}`,
    close: async () => { try { server.stop(); } catch { /* already gone */ } },
  };
}
