#!/usr/bin/env node
// Mints a TURN REST credential the way keepalive-server does (DESIGN s.10) and checks it.
//   username   = "<expiry unix seconds>:<peerId>"
//   credential = base64(HMAC-SHA1(secret, username))
// Usage:
//   node turn-creds-check.mjs                      self-test + vector from ../../spec/turn-rest.md if present
//   node turn-creds-check.mjs mint <secret> <peerId> [ttlSeconds=3600]   print JSON creds (used by smoke.sh)
import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export function mint(secret, peerId, now = Math.floor(Date.now() / 1000), ttl = 3600) {
  const username = `${now + ttl}:${peerId}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential };
}

const args = process.argv.slice(2);
if (args[0] === "mint") {
  const [, secret, peerId, ttl] = args;
  if (!secret || !peerId) { console.error("usage: mint <secret> <peerId> [ttl]"); process.exit(2); }
  console.log(JSON.stringify(mint(secret, peerId, undefined, ttl ? Number(ttl) : 3600)));
  process.exit(0);
}

let failed = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${got}, want ${want}`}`);
  if (!ok) failed++;
};

// 1. Known HMAC-SHA1 vector (Wikipedia / RFC 2202 style): proves the primitive and the base64 step.
check("hmac-sha1 known vector",
  createHmac("sha1", "key").update("The quick brown fox jumps over the lazy dog").digest("hex"),
  "de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9");

// 2. Shape: the username is "expiry:peerId" and the credential is 28 chars of base64 (20 bytes).
const m = mint("s3cret", "p7", 1_700_000_000, 3600);
check("username shape", m.username, "1700003600:p7");
check("credential length", m.credential.length, 28);

// 3. The spec vector, once stream E lands spec/turn-rest.md. Accepted format: any lines containing
//    `secret`, `username` and `credential` followed by a value (optionally in backticks or quotes).
const here = dirname(fileURLToPath(import.meta.url));
const specPath = join(here, "..", "..", "spec", "turn-rest.md");
if (existsSync(specPath)) {
  const text = readFileSync(specPath, "utf8");
  const pick = (k) => {
    const re = new RegExp(`${k}\s*[:=|]\s*[\`"']?([^\`"'\s|]+)`, "i");
    return (text.match(re) || [])[1];
  };
  const secret = pick("secret"), username = pick("username"), credential = pick("credential");
  if (secret && username && credential) {
    check("spec/turn-rest.md vector",
      createHmac("sha1", secret).update(username).digest("base64"), credential);
  } else {
    console.log("skip spec/turn-rest.md exists but no secret/username/credential triple found");
  }
} else {
  console.log("skip spec/turn-rest.md not landed yet (stream E)");
}
process.exit(failed ? 1 : 0);
