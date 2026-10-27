/**
 * Small synchronous SHA-1 / HMAC-SHA1 and CSPRNG helpers for the signaling hub, so it runs in a browser tab as well as
 * in Node (WebCrypto's digests are async and the hub is sync). SHA-1 is used only for the TURN credential
 * (`base64(HMAC-SHA1(secret, "expiry:connId"))`, coturn's REST scheme) and for hashing client addresses in log lines.
 */

const enc = new TextEncoder();

export function sha1(data: Uint8Array): Uint8Array {
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const len = data.length;
  const padded = new Uint8Array((((len + 8) >> 6) << 6) + 64);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor((len * 8) / 0x100000000));
  dv.setUint32(padded.length - 4, (len * 8) >>> 0);
  const w = new Uint32Array(80);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 5; i++) odv.setUint32(i * 4, h[i] >>> 0);
  return out;
}

export function hmacSha1(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = key.length > 64 ? sha1(key) : key;
  const ipad = new Uint8Array(64 + msg.length);
  const opad = new Uint8Array(84);
  for (let i = 0; i < 64; i++) {
    const kb = i < k.length ? k[i] : 0;
    ipad[i] = kb ^ 0x36;
    opad[i] = kb ^ 0x5c;
  }
  ipad.set(msg, 64);
  opad.set(sha1(ipad), 64);
  return sha1(opad);
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function toBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** `base64(HMAC-SHA1(secret, username))`, the TURN REST credential. */
export function turnCredential(secret: string, username: string): string {
  return toBase64(hmacSha1(enc.encode(secret), enc.encode(username)));
}

/** First 8 hex chars of SHA-1 over `text`: a short stable tag for log lines (not a security feature). */
export function shortHash(text: string): string {
  return toHex(sha1(enc.encode(text))).slice(0, 8);
}

/** `n` random bytes as lowercase hex, from the platform CSPRNG. */
export function randomHex(n: number): string {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(n)));
}

/** Uniform integer in [0, n) from the platform CSPRNG (rejection sampling, no modulo bias). */
export function randomBelow(n: number): number {
  const range = 0x100000000;
  const limit = range - (range % n);
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}
