// A tiny Nostr relay for tests (NIP-01 subset), enough for OneLobby's Nostr signaling (spec/nostr-signaling.md):
//   ["EVENT", ev]           -> ["OK", id, true, ""], then ev goes to every open subscription whose filter matches
//   ["REQ", sub, filter...] -> ["EOSE", sub]; later events matching `kinds`, `#t` and `since` are pushed as ["EVENT", sub, ev]
//   ["CLOSE", sub]          -> forgets the subscription
// Ephemeral like the real thing for kind 20000-29999: nothing is stored, so only live subscribers see an event. The
// sender's own subscription gets the echo too (real relays do, and the checkNostrRelays probe relies on it).
// It does not verify ids or signatures: it is a test double, not a relay to run in public.
//
//   node integration/nostr-test-relay.mjs [port]      # prints "relay ws://127.0.0.1:<port>" and runs until killed
// or: import { startRelay } from "./nostr-test-relay.mjs"; const r = await startRelay(); r.url; await r.close();
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { WebSocketServer } = createRequire(join(resolve(here, ".."), "conformance/package.json"))("ws");

function matches(f, ev) {
  if (Array.isArray(f.kinds) && !f.kinds.includes(ev.kind)) return false;
  if (typeof f.since === "number" && ev.created_at < f.since) return false;
  if (typeof f.until === "number" && ev.created_at > f.until) return false;
  if (Array.isArray(f.ids) && !f.ids.includes(ev.id)) return false;
  if (Array.isArray(f.authors) && !f.authors.includes(ev.pubkey)) return false;
  for (const [k, want] of Object.entries(f)) {
    if (!k.startsWith("#") || !Array.isArray(want)) continue;
    const name = k.slice(1);
    if (!(ev.tags ?? []).some((t) => t[0] === name && want.includes(t[1]))) return false;
  }
  return true;
}

/** Starts a relay on 127.0.0.1 (port 0 = any). Resolves { url, port, events, close() }. */
export async function startRelay(port = 0) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  await new Promise((r) => wss.once("listening", r));
  const subs = new Map(); // socket -> Map(subId -> filters[])
  const stats = { events: 0, connections: 0 };
  wss.on("connection", (ws) => {
    stats.connections++;
    subs.set(ws, new Map());
    ws.on("close", () => subs.delete(ws));
    ws.on("error", () => {});
    ws.on("message", (data) => {
      let m;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!Array.isArray(m)) return;
      if (m[0] === "REQ" && typeof m[1] === "string") {
        subs.get(ws)?.set(m[1], m.slice(2).filter((f) => f && typeof f === "object"));
        ws.send(JSON.stringify(["EOSE", m[1]]));
      } else if (m[0] === "CLOSE") {
        subs.get(ws)?.delete(m[1]);
      } else if (m[0] === "EVENT" && m[1] && typeof m[1].id === "string") {
        const ev = m[1];
        stats.events++;
        ws.send(JSON.stringify(["OK", ev.id, true, ""]));
        for (const [sock, byId] of subs) {
          if (sock.readyState !== 1) continue;
          for (const [subId, filters] of byId) if (filters.some((f) => matches(f, ev))) sock.send(JSON.stringify(["EVENT", subId, ev]));
        }
      }
    });
  });
  const actual = wss.address().port;
  return {
    url: `ws://127.0.0.1:${actual}`,
    port: actual,
    stats,
    close: () =>
      new Promise((r) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => r());
      }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const relay = await startRelay(Number(process.argv[2] ?? 0));
  console.log(`relay ${relay.url}`);
}
