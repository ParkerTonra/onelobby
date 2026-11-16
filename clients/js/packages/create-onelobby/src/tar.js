// Just enough tar to list a .tgz (the Unity package): file names only, no extraction. No dependency: node:zlib and the 512-byte headers.
import { gunzipSync } from "node:zlib";

const text = (buf, from, to) => {
  const end = buf.indexOf(0, from);
  return buf.toString("utf8", from, end >= 0 && end < to ? end : to);
};

/** The member names of a gzipped tar (a Buffer): ustar prefixes, GNU long names ("L") and pax "path=" records are followed. */
export function tgzNames(file) {
  const tar = gunzipSync(file);
  const names = [];
  let longName = null;
  let off = 0;
  while (off + 512 <= tar.length && tar[off] !== 0) { // a zero block ends the archive
    const head = off;
    const size = parseInt(text(tar, head + 124, head + 136).trim() || "0", 8);
    const type = String.fromCharCode(tar[head + 156] || 48);
    const body = tar.subarray(head + 512, head + 512 + size);
    off = head + 512 + Math.ceil(size / 512) * 512;
    if (type === "L") longName = text(body, 0, body.length);
    else if (type === "x") longName = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1] ?? longName;
    else if (type !== "g") {
      const prefix = text(tar, head + 345, head + 500);
      names.push(longName ?? (prefix ? `${prefix}/${text(tar, head, head + 100)}` : text(tar, head, head + 100)));
      longName = null;
    }
  }
  return names;
}
