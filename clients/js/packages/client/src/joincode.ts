import { CROCKFORD_ALPHABET } from "./crockford.js";

/**
 * `dc1` join codes (docs/direct-ip.md s.2a, spec/reference/joincode.mjs): a direct-IP host's IPv4 address and port in
 * 11 Crockford characters, shown `6B01-RGFE-P2B`. The code is the address in disguise, so decoding asks nobody.
 * Bits, most significant first: version:2 (0 = IPv4) | ipv4:32 | port:16 | crc:5 (CRC-5, polynomial 0x05, over the 50
 * bits before it). One mistyped character always fails the check.
 */
export const JOIN_CODE_LENGTH = 11;

export type JoinCodeError = "bad_code" | "unknown_version";
export type DecodedJoinCode = { ip: string; port: number } | { room: string } | { error: JoinCodeError };

function crc5(value: bigint, bits: number): number {
  let crc = 0;
  for (let i = bits - 1; i >= 0; i--) {
    const bit = Number((value >> BigInt(i)) & 1n);
    const top = (crc >> 4) & 1;
    crc = (crc << 1) & 0x1f;
    if (top ^ bit) crc ^= 0x05;
  }
  return crc;
}

function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

/** Display form (`6B01-RGFE-P2B`) for an IPv4 address and port 1-65535. Throws on anything else. */
export function encodeJoinCode(ipv4: string, port: number): string {
  const ip = parseIPv4(ipv4);
  if (ip === null) throw new Error(`not an IPv4 address: ${ipv4}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port ${port}`);
  return encodeData((BigInt(ip) << 16n) | BigInt(port)); // version 0
}

function encodeData(data: bigint): string {
  let v = (data << 5n) | BigInt(crc5(data, 50));
  let s = "";
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    s = CROCKFORD_ALPHABET[Number(v & 31n)] + s;
    v >>= 5n;
  }
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/**
 * Version 1 code (a Nostr room, spec/nostr-signaling.md s.1): version:2 = 1 | room:48 | crc:5. `roomHex` is 12 hex
 * digits. The room is only a secret both sides derive keys from.
 */
export function encodeRoomCodeFor(roomHex: string): string {
  if (!/^[0-9a-fA-F]{12}$/.test(roomHex)) throw new Error(`room must be 12 hex digits: ${roomHex}`);
  return encodeData((1n << 48n) | BigInt("0x" + roomHex));
}

/** A new version 1 code with a random 48-bit room from the platform's CSPRNG. */
export function encodeRoomCode(): string {
  const b = new Uint8Array(6);
  globalThis.crypto.getRandomValues(b);
  return encodeRoomCodeFor([...b].map((x) => x.toString(16).padStart(2, "0")).join(""));
}

/** Upper case, spaces and hyphens dropped, i/l -> 1, o -> 0; null unless 11 alphabet characters. */
export function normalizeJoinCode(input: string): string | null {
  const s = input
    .replace(/[ \-]/g, "")
    .replace(/[a-z]/g, (c) => c.toUpperCase())
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (s.length !== JOIN_CODE_LENGTH) return null;
  for (const c of s) if (CROCKFORD_ALPHABET.indexOf(c) < 0) return null;
  return s;
}

export function decodeJoinCode(input: string): DecodedJoinCode {
  const s = normalizeJoinCode(input);
  if (!s) return { error: "bad_code" };
  let v = 0n;
  for (const c of s) v = (v << 5n) | BigInt(CROCKFORD_ALPHABET.indexOf(c));
  const data = v >> 5n;
  if (crc5(data, 50) !== Number(v & 31n)) return { error: "bad_code" };
  const version = data >> 48n;
  if (version === 1n) return { room: (data & 0xffffffffffffn).toString(16).padStart(12, "0") };
  if (version !== 0n) return { error: "unknown_version" };
  const port = Number(data & 0xffffn);
  if (port === 0) return { error: "bad_code" };
  const a = Number((data >> 16n) & 0xffffffffn);
  return { ip: [a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255].join("."), port };
}

/** Shaped like a join code (no dots or colons, 11 alphabet characters): a failed decode is `bad_code`, not a host name. */
export function looksLikeJoinCode(input: string): boolean {
  return !/[.:]/.test(input) && normalizeJoinCode(input) !== null;
}
