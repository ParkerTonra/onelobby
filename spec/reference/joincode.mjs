// Reference `dc1` join code (docs/direct-ip.md s.2a): the direct-IP host's IPv4 address and port in 11 Crockford
// characters, so a friend pastes a code instead of an address and nothing outside the two games is asked.
//
//   bits (MSB first): version:2 (00 = IPv4) | ipv4:32 | port:16 | crc:5   = 55 bits = 11 characters
//   crc = CRC-5, polynomial x^5 + x^2 + 1 (0x05), init 0, no reflection, no final xor, over the 50 bits before it
//   shown grouped 4-4-3 with hyphens: K3J7-X9QA-2MT; input ignores spaces and hyphens, any case, i/l -> 1, o -> 0
//
// Any CRC of degree 5 with an x^0 term catches every burst of 5 bits or fewer, and one mistyped character is such a
// burst, so every single-character typo is caught (the vectors check all 11 x 31 of them for one code).
import { ALPHABET } from './codes.mjs';

export const LENGTH = 11;
export const VERSION_IPV4 = 0;
export const VERSION_ROOM = 1; // Nostr room, spec/nostr-signaling.md s.1

/** CRC-5 (poly 0x05) over the low `bits` bits of `value`, most significant first. */
export function crc5(value, bits) {
  let crc = 0;
  for (let i = bits - 1; i >= 0; i--) {
    const bit = Number((value >> BigInt(i)) & 1n);
    const top = (crc >> 4) & 1;
    crc = (crc << 1) & 0x1f;
    if (top ^ bit) crc ^= 0x05;
  }
  return crc;
}

const ipToInt = (ip) => {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error(`not an IPv4 address: ${ip}`);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
};
const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** Canonical 11-character code (no hyphens) for an IPv4 address and port 1-65535. */
export function encodeRaw(ip, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port ${port}`);
  const data = (BigInt(VERSION_IPV4) << 48n) | (BigInt(ipToInt(ip)) << 16n) | BigInt(port);
  let v = (data << 5n) | BigInt(crc5(data, 50));
  let s = '';
  for (let i = 0; i < LENGTH; i++) { s = ALPHABET[Number(v & 31n)] + s; v >>= 5n; }
  return s;
}

/** Canonical 11-character version-1 code (a Nostr room, spec/nostr-signaling.md s.1) for 12 hex digits. */
export function encodeRoomRaw(roomHex) {
  if (!/^[0-9a-fA-F]{12}$/.test(roomHex)) throw new Error(`room must be 12 hex digits: ${roomHex}`);
  const data = (BigInt(VERSION_ROOM) << 48n) | BigInt('0x' + roomHex);
  let v = (data << 5n) | BigInt(crc5(data, 50));
  let s = '';
  for (let i = 0; i < LENGTH; i++) { s = ALPHABET[Number(v & 31n)] + s; v >>= 5n; }
  return s;
}

/** Display form: K3J7-X9QA-2MT. */
export const group = (raw) => `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
export const encode = (ip, port) => group(encodeRaw(ip, port));

/** Upper case, no spaces or hyphens, i/l -> 1, o -> 0; null if not 11 alphabet characters. */
export function normalize(input) {
  if (typeof input !== 'string') return null;
  const s = input.replace(/[ \-]/g, '').replace(/[a-z]/g, (c) => c.toUpperCase()).replace(/[IL]/g, '1').replace(/O/g, '0');
  if (s.length !== LENGTH) return null;
  for (const c of s) if (!ALPHABET.includes(c)) return null;
  return s;
}

/** { ip, port } or { error: 'bad_code' | 'unknown_version' }. */
export function decode(input) {
  const s = normalize(input);
  if (!s) return { error: 'bad_code' };
  let v = 0n;
  for (const c of s) v = (v << 5n) | BigInt(ALPHABET.indexOf(c));
  const data = v >> 5n;
  if (crc5(data, 50) !== Number(v & 31n)) return { error: 'bad_code' };
  const version = Number(data >> 48n);
  if (version === VERSION_ROOM) return { room: (data & 0xffffffffffffn).toString(16).padStart(12, '0') };
  if (version !== VERSION_IPV4) return { error: 'unknown_version' };
  const port = Number(data & 0xffffn);
  if (port === 0) return { error: 'bad_code' };
  return { ip: intToIp(Number((data >> 16n) & 0xffffffffn)), port };
}
export const encodeRoom = (roomHex) => group(encodeRoomRaw(roomHex));
