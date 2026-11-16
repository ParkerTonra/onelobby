// A tiny zip writer for the tests: stored and deflate entries, any name (including hostile ones).
import { deflateRawSync } from "node:zlib";
import { crc32 } from "../../src/zip.js";

/** entries: [{ name, data?: string|Buffer, deflate?: boolean }]; a name ending in "/" is a folder. */
export function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.from(e.data ?? "");
    const method = e.deflate ? 8 : 0;
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A webrtc-native-shaped zip: addons/webrtc_native/{webrtc_native.gdextension, lib/...}. */
export function fixtureNativesZip() {
  return makeZip([
    { name: "addons/" },
    { name: "addons/webrtc_native/" },
    { name: "addons/webrtc_native/webrtc_native.gdextension", data: '[configuration]\nentry_symbol = "webrtc_extension_init"\n', deflate: true },
    { name: "addons/webrtc_native/LICENSE.webrtc-native", data: "MIT\n" },
    { name: "addons/webrtc_native/lib/libwebrtc_native.windows.template_release.x86_64.dll", data: Buffer.alloc(4096, 7), deflate: true },
  ]);
}
