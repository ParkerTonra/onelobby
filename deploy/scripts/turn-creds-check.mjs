#!/usr/bin/env node
// Mints a TURN REST credential the way onelobby-server does (DESIGN s.10) and checks it.
//   username   = "<expiry unix seconds>:<userId>" (userId = the server connection id)
//   credential = base64(HMAC-SHA1(secret, username))
// Usage:
//   node turn-creds-check.mjs                      self-test + vectors from ../../spec/vectors/turn-rest.json
//   node turn-creds-check.mjs                      self-test + vectors from ../../spec/vectors/turn-rest.json
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

// 3. spec/vectors/turn-rest.json (stream E): fixed vectors plus the fixed-time mint case.
const here = dirname(fileURLToPath(import.meta.url));
const vecPath = join(here, "..", "..", "spec", "vectors", "turn-rest.json");
if (existsSync(vecPath)) {
  const v = JSON.parse(readFileSync(vecPath, "utf8"));
  v.vectors.forEach((x, i) => check(`spec vector ${i} (${x.username})`,
    createHmac("sha1", x.secret).update(x.username).digest("base64"), x.credential));
  const mm = v.mint;
  if (mm) {
    const got = mint(mm.secret, mm.userId, mm.nowSeconds, mm.ttl);
    check("spec mint username", got.username, mm.expectUsername);
    check("spec mint credential", got.credential, mm.expectCredential);
  }
} else {
  console.log("skip spec/vectors/turn-rest.json not found");
}
process.exit(failed ? 1 : 0);
