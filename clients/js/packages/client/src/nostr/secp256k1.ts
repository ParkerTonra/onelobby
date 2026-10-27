/**
 * BIP340 Schnorr signatures over secp256k1 with BigInt, so the package keeps zero runtime dependencies. Nostr needs
 * nothing else from the curve: a fresh key pair per session and one signature per event (spec/nostr-signaling.md s.3).
 * Not constant-time; the keys are throw-away session keys and never leave the process.
 */
import { concatBytes, sha256 } from "./crypto.js";

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

type Jac = [bigint, bigint, bigint]; // Jacobian (X, Y, Z); Z = 0 is the point at infinity
const INF: Jac = [0n, 1n, 0n];
const G: Jac = [GX, GY, 1n];

const mod = (a: bigint, m = P): bigint => {
  const r = a % m;
  return r >= 0n ? r : r + m;
};

function pow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

const inv = (a: bigint, m = P): bigint => pow(a, m - 2n, m);

function dbl(p: Jac): Jac {
  const [X, Y, Z] = p;
  if (Z === 0n || Y === 0n) return INF;
  const A = (X * X) % P;
  const B = (Y * Y) % P;
  const C = (B * B) % P;
  const D = mod(2n * ((X + B) * (X + B) - A - C));
  const E = 3n * A;
  const F = (E * E) % P;
  const X3 = mod(F - 2n * D);
  return [X3, mod(E * (D - X3) - 8n * C), mod(2n * Y * Z)];
}

function add(p: Jac, q: Jac): Jac {
  if (p[2] === 0n) return q;
  if (q[2] === 0n) return p;
  const [X1, Y1, Z1] = p;
  const [X2, Y2, Z2] = q;
  const Z1Z1 = (Z1 * Z1) % P;
  const Z2Z2 = (Z2 * Z2) % P;
  const U1 = (X1 * Z2Z2) % P;
  const U2 = (X2 * Z1Z1) % P;
  const S1 = (Y1 * Z2 * Z2Z2) % P;
  const S2 = (Y2 * Z1 * Z1Z1) % P;
  if (U1 === U2) return S1 === S2 ? dbl(p) : INF;
  const H = mod(U2 - U1);
  const I = (4n * H * H) % P;
  const J = (H * I) % P;
  const r = mod(2n * (S2 - S1));
  const V = (U1 * I) % P;
  const X3 = mod(r * r - J - 2n * V);
  const Y3 = mod(r * (V - X3) - 2n * S1 * J);
  const Z3 = mod(((Z1 + Z2) * (Z1 + Z2) - Z1Z1 - Z2Z2) * H);
  return [X3, Y3, Z3];
}

function mul(p: Jac, k: bigint): Jac {
  let r = INF;
  let q = p;
  while (k > 0n) {
    if (k & 1n) r = add(r, q);
    q = dbl(q);
    k >>= 1n;
  }
  return r;
}

function affine(p: Jac): [bigint, bigint] | null {
  if (p[2] === 0n) return null;
  const zi = inv(p[2]);
  const zi2 = (zi * zi) % P;
  return [(p[0] * zi2) % P, (p[1] * zi2 * zi) % P];
}

export const bytesToInt = (b: Uint8Array): bigint => {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
};

export function intToBytes(n: bigint, len = 32): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

async function taggedHash(tag: string, ...msgs: Uint8Array[]): Promise<Uint8Array> {
  const t = await sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(t, t, ...msgs));
}

function liftX(x: bigint): [bigint, bigint] | null {
  if (x >= P) return null;
  const y2 = mod(x * x * x + 7n);
  let y = pow(y2, (P + 1n) / 4n, P);
  if (mod(y * y) !== y2) return null;
  if (y & 1n) y = P - y;
  return [x, y];
}

/** The 32-byte x-only public key for a 32-byte secret key. */
export function schnorrPublicKey(secret: Uint8Array): Uint8Array {
  const d = bytesToInt(secret);
  if (d < 1n || d >= N) throw new Error("secret key out of range");
  const pt = affine(mul(G, d))!;
  return intToBytes(pt[0]);
}

/** A fresh random secret key (valid scalar) from the platform CSPRNG. */
export function randomSecretKey(): Uint8Array {
  for (;;) {
    const b = new Uint8Array(32);
    globalThis.crypto.getRandomValues(b);
    const d = bytesToInt(b);
    if (d >= 1n && d < N) return b;
  }
}

/** BIP340 signature (64 bytes) of a 32-byte message. `aux` is 32 bytes of randomness (default: fresh). */
export async function schnorrSign(msg: Uint8Array, secret: Uint8Array, aux?: Uint8Array): Promise<Uint8Array> {
  const dPrime = bytesToInt(secret);
  if (dPrime < 1n || dPrime >= N) throw new Error("secret key out of range");
  const pt = affine(mul(G, dPrime))!;
  const d = pt[1] & 1n ? N - dPrime : dPrime;
  const px = intToBytes(pt[0]);
  const a = aux ?? globalThis.crypto.getRandomValues(new Uint8Array(32));
  const th = await taggedHash("BIP0340/aux", a);
  const dBytes = intToBytes(d);
  const t = dBytes.map((x, i) => x ^ th[i]);
  const rand = await taggedHash("BIP0340/nonce", t, px, msg);
  const kPrime = bytesToInt(rand) % N;
  if (kPrime === 0n) throw new Error("bad nonce");
  const r = affine(mul(G, kPrime))!;
  const k = r[1] & 1n ? N - kPrime : kPrime;
  const rx = intToBytes(r[0]);
  const e = bytesToInt(await taggedHash("BIP0340/challenge", rx, px, msg)) % N;
  return concatBytes(rx, intToBytes((k + e * d) % N));
}

/** BIP340 verification. */
export async function schnorrVerify(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): Promise<boolean> {
  if (sig.length !== 64 || pub.length !== 32) return false;
  const pt = liftX(bytesToInt(pub));
  if (!pt) return false;
  const r = bytesToInt(sig.subarray(0, 32));
  const s = bytesToInt(sig.subarray(32));
  if (r >= P || s >= N) return false;
  const e = bytesToInt(await taggedHash("BIP0340/challenge", sig.subarray(0, 32), pub, msg)) % N;
  const sG = mul(G, s);
  const eP = mul([pt[0], pt[1], 1n], N - e);
  const R = affine(add(sG, eP));
  return !!R && !(R[1] & 1n) && R[0] === r;
}
