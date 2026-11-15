// TEMPLATE: a Cloudflare Worker that hands out short-lived coturn logins. You deploy it yourself; OneLobby runs nothing.
// The shared secret lives only here (an environment secret), never in the game build. The algorithm is
// spec/turn-rest.md: username = "<expiry>:<userId>", credential = base64(HMAC-SHA1(secret, username)).
//
// Setup (any account of yours; the same code runs on other small HTTP functions with WebCrypto):
//   1. In coturn: use-auth-secret and static-auth-secret=<the same value> (see docs/recipes/turn.md).
//   2. wrangler secret put TURN_SECRET        (paste the value; never put it in a file or a commit)
//   3. In wrangler.toml [vars]: TURN_URLS = "turn:turn.example.com:3478"  (comma separated)
//      Optional: ALLOWED_ORIGIN = "https://your-game.example" (browser games), TTL_SECONDS = "3600".
//   4. wrangler deploy, then have the game GET the Worker URL and pass the result as an ice server entry.
//
// Rate limiting: anyone who can reach this URL can mint logins, and every login can relay traffic through your TURN
// server. Put a rate limit in front of it (Cloudflare rate limiting rules or the Workers rate limiting binding, per
// client IP), keep the TTL short, and watch relay bandwidth on the TURN server (coturn: total-quota, user-quota,
// bps-capacity).

const enc = new TextEncoder();

async function credential(secret, username) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(username)));
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin);
}

export default {
  async fetch(request, env) {
    const headers = {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, "access-control-allow-methods": "GET" } });
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    if (!env.TURN_SECRET || !env.TURN_URLS) return new Response(JSON.stringify({ error: "not configured" }), { status: 500, headers });

    const ttl = Math.min(Math.max(parseInt(env.TTL_SECONDS || "3600", 10) || 3600, 60), 86400);
    const userId = crypto.randomUUID().replaceAll("-", "").slice(0, 16); // opaque, no ":" in it
    const username = `${Math.floor(Date.now() / 1000) + ttl}:${userId}`;
    const urls = env.TURN_URLS.split(",").map((u) => u.trim()).filter(Boolean);
    return new Response(JSON.stringify({ urls, username, credential: await credential(env.TURN_SECRET, username) }), { headers });
  },
};
