/**
 * TURN logins in the coturn shared-secret scheme (spec/turn-rest.md, vectors in spec/vectors/turn-rest.json): for a TURN
 * server that hands out logins this way, mint one per session instead of storing a fixed password:
 *
 *     const login = turnLogin(secret, "p1", 6 * 3600);
 *     const lobby = await hostDirect(kit, { iceServers: [{ urls: "turn:turn.example.com:3478", ...login }] });
 *
 * The secret ships inside your game, so anyone with the build can mint logins: use a server whose secret you may share, or
 * one with a spend cap.
 */
import { turnCredential } from "./direct/sha1.js";
import type { IceServer } from "./transport.js";

export { turnCredential };

/** `{ username, credential }` valid for `ttlSeconds` from `nowSeconds` (default: the clock). Any `:` is dropped from `userId`. */
export function turnLogin(secret: string, userId: string, ttlSeconds: number, nowSeconds: number = Math.floor(Date.now() / 1000)): { username: string; credential: string } {
  const username = `${nowSeconds + ttlSeconds}:${userId.replaceAll(":", "")}`;
  return { username, credential: turnCredential(secret, username) };
}

const ICE_URL = /^(stuns?|turns?):[^\s?]+(\?\S*)?$/i;

/**
 * Turn what a player pastes into a "my TURN relay" settings field into one `iceServers` entry. Format: the URL, the
 * username, the credential, split on any whitespace (`turn:relay.example.com:3478 alice s3cret`), or a JSON object
 * `{ "urls": ..., "username": ..., "credential": ... }`. `turn:`/`turns:` need both username and credential; `stun:`/`stuns:`
 * need none. Throws an Error whose message is fit to show the player. Vectors: spec/vectors/turn-paste.json.
 *
 *     const entry = parseTurnLine(settings.turn);               // never commit what the player typed
 *     await hostDirect(kit, { iceServers: [...hostTurn, entry] });
 */
export function parseTurnLine(text: string): IceServer {
  const t = String(text ?? "").trim();
  if (t === "") throw new Error("Paste a relay as: turn:host:3478 username credential");
  let urls: string[], username: string | undefined, credential: string | undefined;
  if (t.startsWith("{")) {
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      throw new Error("That is not valid JSON. Paste a relay as: turn:host:3478 username credential");
    }
    const u = o?.urls;
    urls = typeof u === "string" ? [u] : Array.isArray(u) ? u.map(String) : [];
    username = typeof o?.username === "string" && o.username !== "" ? o.username : undefined;
    credential = typeof o?.credential === "string" && o.credential !== "" ? o.credential : undefined;
    if (urls.length === 0) throw new Error('The JSON needs "urls" (a turn: or stun: URL, or a list of them).');
  } else {
    const parts = t.split(/\s+/);
    if (parts.length > 3) throw new Error("Too many parts. Use: URL username credential (the credential cannot contain spaces).");
    username = parts[1];
    credential = parts[2];
    urls = [parts[0]];
  }
  for (const u of urls) if (!ICE_URL.test(u)) throw new Error(`"${u}" is not a stun:, stuns:, turn: or turns: URL (for example turn:relay.example.com:3478).`);
  if (urls.some((u) => /^turns?:/i.test(u)) && (!username || !credential))
    throw new Error("A turn: relay needs a username and a credential after the URL: turn:host:3478 username credential");
  const out: IceServer = { urls };
  if (username) out.username = username;
  if (credential) out.credential = credential;
  return out;
}
