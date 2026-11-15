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

export { turnCredential };

/** `{ username, credential }` valid for `ttlSeconds` from `nowSeconds` (default: the clock). Any `:` is dropped from `userId`. */
export function turnLogin(secret: string, userId: string, ttlSeconds: number, nowSeconds: number = Math.floor(Date.now() / 1000)): { username: string; credential: string } {
  const username = `${nowSeconds + ttlSeconds}:${userId.replaceAll(":", "")}`;
  return { username, credential: turnCredential(secret, username) };
}
