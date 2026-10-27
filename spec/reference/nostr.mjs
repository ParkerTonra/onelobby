// Reference crypto for Nostr signaling (spec/nostr-signaling.md s.2-3), on node:crypto. Schnorr signing is not in
// node:crypto; the BIP340 official vectors (bitcoin/bips bip-0340/test-vectors.csv, rows 0-3) are listed below and the
// clients check their own signer against them.
import { createHash, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';

const SALT = 'onelobby-nostr-v1';

/** { key, topic } hex for the 11 normalised code characters. */
export function deriveKeys(normalizedCode) {
  const ikm = Buffer.from(normalizedCode, 'ascii');
  const k = (info) => Buffer.from(hkdfSync('sha256', ikm, Buffer.from(SALT, 'ascii'), Buffer.from(info, 'ascii'), 32));
  return { key: k('key').toString('hex'), topic: k('topic').toString('hex') };
}

/** base64( iv || ciphertext || tag ), no AAD. */
export function encrypt(keyHex, plaintext, ivHex) {
  const iv = Buffer.from(ivHex, 'hex');
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

export function decrypt(keyHex, content) {
  const raw = Buffer.from(content, 'base64');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
}

/** NIP-01 event id (hex). */
export function eventId(pubkey, createdAt, kind, tags, content) {
  return createHash('sha256').update(JSON.stringify([0, pubkey, createdAt, kind, tags, content]), 'utf8').digest('hex');
}

export const BIP340 = [
  {
    index: 0,
    secretKey: '0000000000000000000000000000000000000000000000000000000000000003',
    publicKey: 'F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9',
    auxRand: '0000000000000000000000000000000000000000000000000000000000000000',
    message: '0000000000000000000000000000000000000000000000000000000000000000',
    signature: 'E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0',
  },
  {
    index: 1,
    secretKey: 'B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF',
    publicKey: 'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
    auxRand: '0000000000000000000000000000000000000000000000000000000000000001',
    message: '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89',
    signature: '6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A',
  },
  {
    index: 2,
    secretKey: 'C90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B14E5C9',
    publicKey: 'DD308AFEC5777E13121FA72B9CC1B7CC0139715309B086C960E18FD969774EB8',
    auxRand: 'C87AA53824B4D7AE2EB035A2B5BBBCCC080E76CDC6D1692C4B0B62D798E6D906',
    message: '7E2D58D8B3BCDF1ABADEC7829054F90DDA9805AAB56C77333024B9D0A508B75C',
    signature: '5831AAEED7B44BB74E5EAB94BA9D4294C49BCF2A60728D8B4C200F50DD313C1BAB745879A5AD954A72C45A91C3A51D3C7ADEA98D82F8481E0E1E03674A6F3FB7',
  },
];
