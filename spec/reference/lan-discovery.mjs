// Reference LAN discovery codec (spec/lan-discovery.md). Two datagrams, both start with the same 14 bytes:
//   "OLAN" | version u8 (1) | type u8 (1 question, 2 answer) | nonce 8 bytes
// question: header | gameIdLen u8 | gameId
// answer:   header | port u16 BE | players u8 | maxPlayers u8 | flags u8 | then four strings, each u8 length + UTF-8:
//           gameId, netVersion, lobbyName, hostName
export const MAGIC = [0x4f, 0x4c, 0x41, 0x4e];
export const VERSION = 1;
export const TYPE_QUESTION = 1;
export const TYPE_ANSWER = 2;
export const MAX_DATAGRAM = 512;
export const DEFAULT_PORT = 47840;
export const LIMITS = { gameId: [1, 64], netVersion: [1, 32], lobbyName: [0, 72], hostName: [0, 72] };
export const FLAG_PASSWORD = 1;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

const header = (type, nonce) => {
  if (nonce.length !== 8) throw new Error("nonce is 8 bytes");
  return [...MAGIC, VERSION, type, ...nonce];
};
const str = (s, [min, max]) => {
  const b = enc.encode(s);
  if (b.length < min || b.length > max) throw new Error(`string length ${b.length} outside ${min}..${max}`);
  return [b.length, ...b];
};

export function encodeQuestion(nonce, gameId) {
  return Uint8Array.from([...header(TYPE_QUESTION, nonce), ...str(gameId, LIMITS.gameId)]);
}

export function encodeAnswer(a) {
  if (!(a.port >= 1 && a.port <= 65535)) throw new Error("port");
  if (!(a.maxPlayers >= 1 && a.maxPlayers <= 255 && a.players >= 0 && a.players <= a.maxPlayers)) throw new Error("players");
  return Uint8Array.from([
    ...header(TYPE_ANSWER, a.nonce),
    a.port >> 8, a.port & 255, a.players, a.maxPlayers, a.password ? FLAG_PASSWORD : 0,
    ...str(a.gameId, LIMITS.gameId), ...str(a.netVersion, LIMITS.netVersion),
    ...str(a.lobbyName, LIMITS.lobbyName), ...str(a.hostName, LIMITS.hostName),
  ]);
}

const readHeader = (b, type) => {
  if (b.length < 14 || b.length > MAX_DATAGRAM) return null;
  for (let i = 0; i < 4; i++) if (b[i] !== MAGIC[i]) return null;
  if (b[4] !== VERSION || b[5] !== type) return null;
  return b.slice(6, 14);
};
const readStr = (b, at, [min, max]) => {
  if (at >= b.length) return null;
  const n = b[at];
  if (n < min || n > max || at + 1 + n > b.length) return null;
  let s;
  try { s = dec.decode(b.slice(at + 1, at + 1 + n)); } catch { return null; }
  return { s, next: at + 1 + n };
};

/** {nonce, gameId} or null. */
export function decodeQuestion(b) {
  const nonce = readHeader(b, TYPE_QUESTION);
  if (!nonce) return null;
  const g = readStr(b, 14, LIMITS.gameId);
  if (!g || g.next !== b.length) return null;
  return { nonce, gameId: g.s };
}

/** {nonce, port, players, maxPlayers, password, gameId, netVersion, lobbyName, hostName} or null. */
export function decodeAnswer(b) {
  const nonce = readHeader(b, TYPE_ANSWER);
  if (!nonce || b.length < 19) return null;
  const port = (b[14] << 8) | b[15];
  const players = b[16];
  const maxPlayers = b[17];
  const flags = b[18];
  if (port < 1 || maxPlayers < 1 || players > maxPlayers) return null;
  let at = 19;
  const out = [];
  for (const k of ["gameId", "netVersion", "lobbyName", "hostName"]) {
    const r = readStr(b, at, LIMITS[k]);
    if (!r) return null;
    out.push(r.s);
    at = r.next;
  }
  if (at !== b.length) return null;
  return { nonce, port, players, maxPlayers, password: (flags & FLAG_PASSWORD) !== 0, gameId: out[0], netVersion: out[1], lobbyName: out[2], hostName: out[3] };
}

/** "loopback" | "private" | "link_local" | null (null = public or not IPv4). Host rule and finder rule share it. */
export function sourceClass(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  if (p[0] === 127) return "loopback";
  if (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)) return "private";
  if (p[0] === 169 && p[1] === 254) return "link_local";
  return null;
}
