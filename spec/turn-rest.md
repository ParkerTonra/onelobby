# TURN REST credentials

DESIGN s.10, draft-uberti-behave-turn-rest. `keepalive-server` and coturn (`use-auth-secret`, `static-auth-secret=<secret>`)
share one secret.

```
username   = <expiry>:<userId>          expiry = unix time in whole seconds (UTC) when the credential stops being valid
credential = base64( HMAC-SHA1( key = secret (UTF-8 bytes), message = username (UTF-8 bytes) ) )   // standard base64 with padding
ttl        = 3600 seconds              expiry = now + ttl at the moment `welcome` is built
```

- `userId` is an opaque token chosen by the server with no `:` in it. **(decision)** In `welcome` the peer has no lobby
  `peerId` yet (it is assigned on create/join), so DESIGN's `expiry:peerId` becomes `expiry:<connection id>`; any string
  matching `[A-Za-z0-9_-]{1,32}` works. coturn does not interpret it.
- `welcome.ice` contains the STUN entry (no credentials) and the TURN entries with `username`, `credential`, `ttl`:
  `turn:host:3478?transport=udp`, `turn:host:3478?transport=tcp`, `turns:host:443?transport=tcp`.
- The same username/credential pair is valid for every TURN URL of that `welcome`.
- Vectors: `spec/vectors/turn-rest.json` (`vectors[]` = secret, username, expected credential; `mint` = inputs and expected output of
  minting at a fixed time). Reference: `spec/reference/turn.mjs`.
- Check against coturn: `turnutils_uclient -u <username> -w <credential> ...` must authenticate when the clock is
  before `expiry`.
