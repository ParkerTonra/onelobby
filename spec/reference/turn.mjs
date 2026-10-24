// TURN REST credentials (draft-uberti-behave-turn-rest; DESIGN s.10). See spec/turn-rest.md.
import { createHmac } from 'node:crypto';

export function credential(secret, username) {
  return createHmac('sha1', secret).update(username).digest('base64');
}

// userId must not contain ':'. expiry is unix seconds.
export function mint(secret, userId, nowSeconds, ttl = 3600) {
  const username = `${nowSeconds + ttl}:${userId}`;
  return { username, credential: credential(secret, username), ttl };
}
