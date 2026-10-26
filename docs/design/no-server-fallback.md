# Design note: playing when the router will not open a port (draft, undecided)

Direct-IP hosting needs the host's port reachable: UPnP / NAT-PMP, or a port forwarded by hand. When neither works
(UPnP off, a router that stopped answering, a player who will not forward ports), friends outside the host's network
cannot join. This note weighs a fallback that needs no server of ours.

Both options below share these facts:

- **NAT traversal is WebRTC with public STUN** (e.g. `stun:stun.l.google.com:19302`, `stun:stun.cloudflare.com:3478`):
  each side learns its public address and both send at once to punch through. Works for most home routers; fails on
  symmetric NAT and many carrier-grade NATs (mobile, some ISPs), which need a TURN relay, which is hosting.
- **The joiner's page cannot come from the host** (its port is closed). A browser joiner opens the game from some
  public static address (the game's own site, GitHub Pages, itch.io). Native joiners are unaffected.
- **The host's link to the joiner is the same WebRTC connection used to signal** (no second ICE round), so whatever
  punched through carries the game.

## Measured: how long an ICE agent waits

An agent that has the other side's candidates starts checking at once and gives up when nobody answers:
Chromium (Edge) after **15 s**, libdatachannel (Node host) after **~40 s** (probe 2026-10-26, both on loopback with an
unreachable candidate). Whoever applies the other side's info first must have the other side apply its info within
that window.

## Option A: two codes, pasted by hand (what was asked)

The host sends an invite code, the joiner pastes it and gets a reply code, sends it back, the host pastes it.

- In that order the **joiner** applies first, so the host must paste the reply within **15 s** of the joiner making it.
  Too tight for a chat relay.
- Flipping the order (joiner makes a request code, host pastes it and makes the reply) puts the 40 s window on the
  host. Making it unlimited needs the host to re-create its ICE agent with the same credentials and DTLS certificate
  every 40 s (self-signed certificate generation, libdatachannel's native API). Feasible, but the joiner's own NAT
  mapping can still expire while codes travel (some routers drop idle UDP mappings after 30-60 s).
- Codes are about 110 characters (ICE password and DTLS fingerprint cannot be shortened), one pair per joiner.
- Depends on nothing but STUN.

## Option B: one code, public signaling relays

The join code (short, like today) names a meeting point; host and joiner exchange their WebRTC offer, answer and
candidates through free public relays (Nostr relays or WebTorrent trackers, the approach Trystero uses), encrypted
with a key derived from the code so relays see nothing useful.

- Same UX as a normal join: the host shows one code, the joiner types it. No timing window: both sides are live and
  trickle candidates as they appear.
- Depends on third-party public relays (several, redundant, free) in addition to STUN. If all are down, the fallback
  is down; the direct-IP path is unaffected.
- More code than A's simple variant, much less than A's robust variant.

## Recommendation

B, as an opt-in fallback the host turns on (or that switches on when the code would be same-network only), with A's
request-then-reply order kept as an emergency path only if B's relays prove unreliable.
