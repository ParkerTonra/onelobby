// A small zip reader on node:zlib (stored and deflate entries only), so the scaffolder needs no unzip tool and no
// dependency. It reads from a Buffer, checks every size and CRC-32, and rejects any entry whose path could land outside the
// folder it is unpacked into (absolute paths, drive letters, `..`, backslashes, NUL, empty names).
import { inflateRawSync } from "node:zlib";
import { CliError } from "./flags.js";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** No entry may unpack to more than this, and the whole archive no more than MAX_TOTAL (webrtc-native is ~37 MB). */
export const MAX_ENTRY = 256 * 1024 * 1024;
export const MAX_TOTAL = 512 * 1024 * 1024;

let table;
export function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

const bad = (why) => new CliError("bad_zip", `not a usable zip file: ${why}`);

/**
 * The safe form of an entry name: forward-slash segments, no `.`/`..`, nothing absolute. Returns { path, dir }.
 * Throws bad_zip for a name that could escape the target folder.
 */
export function safeEntryName(name) {
  if (name === "" || name.includes("\0") || name.includes("\\")) throw bad(`unsafe entry name ${JSON.stringify(name)}`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw bad(`absolute entry name ${JSON.stringify(name)}`);
  const dir = name.endsWith("/");
  const parts = (dir ? name.slice(0, -1) : name).split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw bad(`entry name escapes the folder: ${JSON.stringify(name)}`);
  return { path: parts.join("/"), dir };
}

/** Entries of a zip: [{ name, dir, size, data() -> Buffer }], names already checked by safeEntryName. */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad("no end-of-archive record");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw bad("zip64 archives are not supported");
  if (cdOffset + cdSize > buf.length) throw bad("the central directory is past the end of the file");

  const entries = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw bad("damaged central directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const { path, dir } = safeEntryName(name);
    if (flags & 1) throw bad(`${name} is encrypted`);
    if (usize > MAX_ENTRY) throw bad(`${name} is too large`);
    total += usize;
    if (total > MAX_TOTAL) throw bad("the archive unpacks to too much data");
    entries.push({
      name: path,
      dir,
      size: usize,
      data() {
        if (dir) return Buffer.alloc(0);
        if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw bad(`damaged local header for ${name}`);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        if (start + csize > buf.length) throw bad(`${name} runs past the end of the file`);
        const raw = buf.subarray(start, start + csize);
        let out;
        if (method === 0) out = Buffer.from(raw);
        else if (method === 8) {
          try {
            out = inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
          } catch (e) {
            throw bad(`cannot unpack ${name} (${e.code ?? e.message})`);
          }
        } else throw bad(`${name} uses compression method ${method}; only stored and deflate are supported`);
        if (out.length !== usize) throw bad(`${name} has the wrong size`);
        if (crc32(out) !== crc) throw bad(`${name} fails its CRC-32 check`);
        return out;
      },
    });
  }
  return entries;
}
