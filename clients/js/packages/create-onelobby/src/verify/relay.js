// A tiny Nostr relay for `verify`: pure node (node:http and node:crypto, no `ws`), bound to 127.0.0.1 only, any free port.
// It speaks the NIP-01 subset OneLobby's Nostr signaling uses (spec/nostr-signaling.md), like integration/nostr-test-relay.mjs:
//   ["EVENT", ev]           -> ["OK", id, true, ""], then ev goes to every open subscription whose filter matches
//   ["REQ", sub, filter...] -> ["EOSE", sub]; later events matching kinds, #t, since ... arrive as ["EVENT", sub, ev]
//   ["CLOSE", sub]          -> forgets the subscription
// Events are ephemeral (nothing is stored) and ids and signatures are not checked: a test double, never a relay to expose.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One server-to-client text frame (unmasked). */
export function textFrame(text) {
  const body = Buffer.from(text, "utf8");
  const n = body.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, body]);
}

/**
 * Incremental decoder of client-to-server frames: `push(chunk)` returns the messages that completed
 * ({ op: "text"|"close"|"ping"|"pong", data: Buffer }). Handles masking, 16/64-bit lengths and fragmented text.
 */
export function frameDecoder() {
  let buf = Buffer.alloc(0);
  let frag = [];
  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const out = [];
      for (;;) {
        if (buf.length < 2) break;
        const fin = (buf[0] & 0x80) !== 0;
        const op = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let at = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          at = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          at = 10;
        }
        const need = at + (masked ? 4 : 0) + len;
        if (buf.length < need) break;
        let data = Buffer.from(buf.subarray(at + (masked ? 4 : 0), need));
        if (masked) {
          const key = buf.subarray(at, at + 4);
          for (let i = 0; i < data.length; i++) data[i] ^= key[i & 3];
        }
        buf = buf.subarray(need);
        if (op === 0x8) out.push({ op: "close", data });
        else if (op === 0x9) out.push({ op: "ping", data });
        else if (op === 0xa) out.push({ op: "pong", data });
        else if (op === 0x1 || op === 0x2 || op === 0x0) {
          frag.push(data);
          if (fin) {
            out.push({ op: "text", data: Buffer.concat(frag) });
            frag = [];
          }
        }
      }
      return out;
    },
  };
}

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

/** Start the relay on 127.0.0.1 (port 0 = any free one). Resolves { url, port, stats, close() }. */
export async function startRelay(port = 0) {
  const subs = new Map(); // socket -> Map(subId -> filters[])
  const stats = { events: 0, connections: 0 };
  const server = createServer((_req, res) => {
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("this is a WebSocket relay\n");
  });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    stats.connections++;
    subs.set(socket, new Map());
    const dec = frameDecoder();
    const send = (arr) => {
      if (!socket.destroyed && socket.writable) socket.write(textFrame(JSON.stringify(arr)));
    };
    socket.on("error", () => {});
    socket.on("close", () => subs.delete(socket));
    socket.on("data", (chunk) => {
      for (const m of dec.push(chunk)) {
        if (m.op === "close") {
          socket.end(Buffer.from([0x88, 0x00]));
          return;
        }
        if (m.op === "ping") {
          socket.write(Buffer.concat([Buffer.from([0x8a, m.data.length]), m.data]));
          continue;
        }
        if (m.op !== "text") continue;
        let msg;
        try {
          msg = JSON.parse(m.data.toString("utf8"));
        } catch {
          continue;
        }
        if (!Array.isArray(msg)) continue;
        if (msg[0] === "REQ" && typeof msg[1] === "string") {
          subs.get(socket)?.set(msg[1], msg.slice(2).filter((f) => f && typeof f === "object"));
          send(["EOSE", msg[1]]);
        } else if (msg[0] === "CLOSE") {
          subs.get(socket)?.delete(msg[1]);
        } else if (msg[0] === "EVENT" && msg[1] && typeof msg[1].id === "string") {
          const ev = msg[1];
          stats.events++;
          send(["OK", ev.id, true, ""]);
          for (const [sock, byId] of subs) {
            if (sock.destroyed || !sock.writable) continue;
            for (const [subId, filters] of byId) if (filters.some((f) => matches(f, ev))) sock.write(textFrame(JSON.stringify(["EVENT", subId, ev])));
          }
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actual = server.address().port;
  return {
    url: `ws://127.0.0.1:${actual}`,
    port: actual,
    stats,
    close: () =>
      new Promise((resolve) => {
        for (const s of subs.keys()) s.destroy();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
