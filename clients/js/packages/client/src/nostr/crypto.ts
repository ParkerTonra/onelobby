/** WebCrypto helpers for Nostr signaling (spec/nostr-signaling.md s.2-3); Node 18+ and every browser have it. */

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto (crypto.subtle) is not available; Nostr signaling needs a secure context or Node 18+");
  return s;
};

const buf = (b: Uint8Array): BufferSource => b as unknown as BufferSource;
const utf8 = new TextEncoder();

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error("bad hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", buf(data)));
}

/** HKDF-SHA256 (RFC 5869) with an ASCII salt and info, `length` bytes. */
export async function hkdf(ikm: Uint8Array, salt: string, info: string, length = 32): Promise<Uint8Array> {
  const key = await subtle().importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(utf8.encode(salt)), info: buf(utf8.encode(info)) }, key, length * 8);
  return new Uint8Array(bits);
}

/** Keys of one room (s.2): `key` encrypts frames, `topic` is the relay-visible tag. */
export interface RoomKeys {
  key: Uint8Array;
  topic: string;
}

/** `normalizedCode` is the 11 normalised code characters (no hyphens, upper case). */
export async function deriveRoomKeys(normalizedCode: string): Promise<RoomKeys> {
  const ikm = utf8.encode(normalizedCode);
  const salt = "onelobby-nostr-v1";
  const [key, topic] = await Promise.all([hkdf(ikm, salt, "key"), hkdf(ikm, salt, "topic")]);
  return { key, topic: toHex(topic) };
}

/** base64( iv(12) || ciphertext || tag(16) ), no associated data. `iv` is fresh random unless a test pins it. */
export async function encryptContent(key: Uint8Array, plaintext: string, iv?: Uint8Array): Promise<string> {
  const k = await subtle().importKey("raw", buf(key), "AES-GCM", false, ["encrypt"]);
  const v = iv ?? globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: buf(v) }, k, buf(utf8.encode(plaintext))));
  return toBase64(concatBytes(v, ct));
}

/** Plain text, or null when the content is not valid base64, too short or fails the GCM tag. */
export async function decryptContent(key: Uint8Array, content: string): Promise<string | null> {
  try {
    const raw = fromBase64(content);
    if (raw.length < 12 + 16) return null;
    const k = await subtle().importKey("raw", buf(key), "AES-GCM", false, ["decrypt"]);
    const pt = await subtle().decrypt({ name: "AES-GCM", iv: buf(raw.subarray(0, 12)) }, k, buf(raw.subarray(12)));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
