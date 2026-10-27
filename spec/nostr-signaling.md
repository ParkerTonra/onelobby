# Nostr signaling for direct hosts (`dc1` version 1 codes)

A direct host whose port the internet cannot reach (UPnP off, nothing forwarded) still takes joiners: the joiner's
signaling socket runs over free public Nostr relays instead of a TCP connection to the host. Everything above the
socket (the hub protocol in `signaling.md`, WebRTC offer/answer/candidates, the lobby) is unchanged, so a Nostr
joiner and an IP joiner sit in the same lobby. Relays only ever see encrypted blobs under a random-looking topic.
Design and reasons: `docs/design/no-server-fallback.md`.

## 1. The code

Same `dc1` alphabet, length, grouping and CRC-5 as `joincode.md` / `spec/reference/joincode.mjs`, version field 1:

```
version:2 = 1 | room:48 (random, CSPRNG) | crc:5 over the 50 bits before it
```

Display `XXXX-XXXX-XXX`, normalisation as for version 0. A decoder returns `{ room }` (12 hex digits) for version 1,
`{ ip, port }` for version 0, `unknown_version` for 2 and 3. A host draws a new room each time it hosts.

## 2. Keys

`ikm` = the 11 normalised code characters as ASCII, `salt` = ASCII `onelobby-nostr-v1`.

- `key` = HKDF-SHA256(ikm, salt, info = `key`, 32 bytes): AES-256-GCM key.
- `topic` = lower-case hex of HKDF-SHA256(ikm, salt, info = `topic`, 32 bytes).

## 3. Nostr events

Each side makes a fresh secp256k1 key pair per session (never reused, never the player's identity). Events follow
NIP-01: `id` = SHA-256 of `[0, pubkey, created_at, kind, tags, content]` serialised without whitespace, `sig` = BIP340
Schnorr over `id`.

- `kind` 25050 (ephemeral range: relays forward and do not store).
- `tags` `[["t", topic]]`.
- `content` = base64 (standard, padded) of `iv (12 random bytes) || AES-256-GCM ciphertext || tag (16 bytes)`,
  no associated data. Plaintext: the frame in s.4 as UTF-8 JSON.
- Subscription on every relay: `["REQ", <sub id>, { "kinds": [25050], "#t": [topic], "since": <now - 30> }]`.

Publish every event to every relay in the list (s.6); receivers dedupe by event `id`. Receivers do not need to check
`sig` (relays do; the GCM tag is what authenticates). Drop events whose content fails to decrypt or parse, whose
`from` is your own pubkey, or whose `created_at` is more than 120 s old.

## 4. Frames

```json
{ "v": 1, "type": "open" | "data" | "beat" | "close", "from": "<sender pubkey hex>", "to": "<recipient pubkey hex or empty>",
  "seq": 1, "ack": 0, "msgs": ["<hub protocol text>", ...], "reason": "..." }
```

- `from` must equal the event's `pubkey`; frames that disagree are dropped.
- **open.** The joiner sends `open` with `to` empty every 2 s until the host answers, giving up after 15 s
  (`connect_failed`). The host answers each `open` from a new pubkey with an `open` addressed to it (repeat answers
  for repeat opens) and connects a hub session for it with address `nostr:<first 16 hex of the joiner pubkey>`.
  The joiner's socket is open (`onopen`) on the host's first `open` addressed to it; it then talks only to that pubkey.
  A host that is full or closing still answers, then sends `close`.
- **data.** `msgs` are hub protocol texts in order. `seq` counts data frames per direction from 1. `ack` is the
  highest `seq` received with nothing missing before it. Receivers deliver in `seq` order, drop duplicates and hold
  at most 64 out-of-order frames. Senders resend every unacknowledged frame 3 s after its last send, at most 5 times,
  then close the socket (code 1006, reason `timeout`). Queue sends for 30 ms and pack them into one frame; keep a
  frame's content under 32 KiB (split `msgs` over several frames).
- **Outbound queue (hardening).** A link holds at most 128 frames and 256 KiB of unacknowledged or queued outbound
  hub texts together; a text that would exceed either is dropped (the link stays open). Relays rate-limit publishes, so
  an unbounded queue only turns into dead resends.
- **New sessions (hardening).** A host accepts at most 8 new joiner pubkeys per 10 s per lobby; excess `open`s are
  ignored, not answered. The joiner repeats `open` every 2 s inside its 15 s budget, so it is let in when the window
  frees. Repeat `open`s from a pubkey already attached are always answered.
- **Bans (hardening).** Kicking a Nostr joiner bans its pubkey and, when the host's WebRTC link to it has a known
  remote address (selected candidate pair, not relayed, not an mDNS name), that IP too. When a later joiner's link
  resolves to a banned IP the host removes it as kicked. A link whose address is unknown cannot be matched.
- **beat.** Sent when nothing else went to that peer for 10 s; carries `ack`. A side that hears nothing from its
  peer for 30 s closes the socket (1006, `timeout`).
- **close.** Sent once on close with an optional `reason`; the receiver closes its socket with that reason (1000).
- Keep-alive `ping` / `pong` hub messages never cross Nostr: the joiner's socket answers its own outgoing `ping` with
  a local `pong`, and the host bridge drops the hub's `pong`s; any frame from a joiner counts as activity for the hub.

## 5. WebRTC

Both sides use public STUN (`stun:stun.l.google.com:19302`, `stun:stun.cloudflare.com:3478`; a setting) and no
extra remote candidate. The host still pins its peer links to the direct UDP port, so a working router mapping
(UPnP or a manual forward) also gives Nostr joiners a reachable candidate. Symmetric NAT on both sides fails as
`ice_failed`; the fix is a forwarded port.

## 6. Relays

A list of `wss://` URLs: the blueprint's `hosting.nostrRelays`, else the library default. Use them all at once,
reconnect each with backoff (1 s doubling to 30 s), and treat the transport as up while at least one relay is
connected. A relay answering `["OK", id, false, ...]` or `["CLOSED", ...]` is skipped for the session. No relay
reachable within 10 s: `connect_failed` for joiners, and the host reports `nostr: no relay reachable` in its log
line and keeps hosting by IP.
