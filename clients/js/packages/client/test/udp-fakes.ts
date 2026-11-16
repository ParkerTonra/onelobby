/**
 * Tiny UDP responders for the diagnostics tests, all bound to 127.0.0.1 (nothing leaves the machine):
 * a STUN server that reports whatever mapped address the test says, and a TURN server that takes or rejects a login.
 */
import { createSocket, type Socket } from "node:dgram";
import { createHash, createHmac } from "node:crypto";
import { stunBindingResponse } from "../src/connection-check.js";

export interface Fake {
  port: number;
  /** Requests received. */
  seen: number;
  close(): Promise<void>;
}

/**
 * A STUN server. `map(source)` is the address it reports back: omit it to reflect the sender's real address (an open
 * network), return a fixed address to play a NAT. `silent` answers nothing (UDP blocked, or the server is down).
 */
export function fakeStun(o: { map?: (src: { ip: string; port: number }) => { ip: string; port: number }; silent?: boolean } = {}): Promise<Fake> {
  const sock: Socket = createSocket("udp4");
  const fake: Fake = { port: 0, seen: 0, close: () => new Promise((r) => sock.close(() => r())) };
  sock.on("message", (m, rinfo) => {
    fake.seen++;
    if (o.silent || m.length < 20 || m.readUInt16BE(0) !== 0x0001) return;
    const mapped = o.map ? o.map({ ip: rinfo.address, port: rinfo.port }) : { ip: rinfo.address, port: rinfo.port };
    sock.send(stunBindingResponse(m.subarray(8, 20), mapped.ip, mapped.port), rinfo.port, rinfo.address);
  });
  return new Promise((resolve) =>
    sock.bind(0, "127.0.0.1", () => {
      fake.port = sock.address().port;
      resolve(fake);
    }),
  );
}

const REALM = "fake.realm";
const NONCE = Buffer.from("0123456789abcdef");

function attr(type: number, value: Buffer): Buffer {
  const pad = (4 - (value.length % 4)) % 4;
  const b = Buffer.alloc(4 + value.length + pad);
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(value.length, 2);
  value.copy(b, 4);
  return b;
}

function message(type: number, tid: Buffer, ...attrs: Buffer[]): Buffer {
  const body = Buffer.concat(attrs);
  const h = Buffer.alloc(20);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(body.length, 2);
  h.writeUInt32BE(0x2112a442, 4);
  tid.copy(h, 8);
  return Buffer.concat([h, body]);
}

/**
 * A TURN server (UDP, long-term credentials, Allocate only). A login that matches `user` / `password` gets a success
 * response unless `reject`; anything else gets 401 again, as a real server answers a wrong login. `silent` answers nothing.
 */
export function fakeTurn(o: { user: string; password: string; reject?: boolean; silent?: boolean }): Promise<Fake> {
  const sock: Socket = createSocket("udp4");
  const fake: Fake = { port: 0, seen: 0, close: () => new Promise((r) => sock.close(() => r())) };
  const unauthorized = (tid: Buffer) =>
    message(0x0113, tid, attr(0x0009, Buffer.from([0, 0, 4, 1, ...Buffer.from("Unauthorized")])), attr(0x0014, Buffer.from(REALM)), attr(0x0015, NONCE));
  sock.on("message", (m, rinfo) => {
    fake.seen++;
    if (o.silent || m.length < 20 || m.readUInt16BE(0) !== 0x0003) return;
    const tid = Buffer.from(m.subarray(8, 20));
    const send = (b: Buffer) => sock.send(b, rinfo.port, rinfo.address);
    // find USERNAME and MESSAGE-INTEGRITY
    let user: string | null = null;
    let miAt = -1;
    for (let at = 20; at + 4 <= m.length; ) {
      const t = m.readUInt16BE(at);
      const l = m.readUInt16BE(at + 2);
      if (t === 0x0006) user = m.subarray(at + 4, at + 4 + l).toString();
      if (t === 0x0008) miAt = at;
      at += 4 + ((l + 3) & ~3);
    }
    if (miAt < 0) return send(unauthorized(tid));
    const key = createHash("md5").update(`${o.user}:${REALM}:${o.password}`).digest();
    const mac = createHmac("sha1", key).update(m.subarray(0, miAt)).digest();
    const good = user === o.user && mac.equals(m.subarray(miAt + 4, miAt + 24));
    if (!good || o.reject) return send(unauthorized(tid));
    send(message(0x0103, tid, attr(0x0016, Buffer.from([0, 1, 0x30, 0x39, 0x21, 0x12, 0xa4, 0x42 ^ 0x7f]))));
  });
  return new Promise((resolve) =>
    sock.bind(0, "127.0.0.1", () => {
      fake.port = sock.address().port;
      resolve(fake);
    }),
  );
}
