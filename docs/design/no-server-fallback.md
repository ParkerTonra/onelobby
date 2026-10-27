# Design note: playing when the router will not open a port (decided: Option B, Nostr relays)

Direct-IP hosting needs the host's port reachable: UPnP / NAT-PMP, or a port forwarded by hand. When neither works
(UPnP off, a router that stopped answering, a player who will not forward ports), friends outside the host's network
cannot join. This note weighed a fallback that needs no server of ours, and records what was built.

**Decision (designer, 2026-10-26):** Option B. A direct host hands out a Nostr code (a `dc1` version 1 code) by default;
joiners reach the host through public Nostr relays and then connect over WebRTC with public STUN. The wire protocol is
`spec/nostr-signaling.md`; settings are `hosting.nostr` / `hosting.nostrRelays` (blueprint) and the `nostr` option of
`hostDirect` / `HostDirectAsync`. Option A stays an emergency path only if the relays prove unreliable.

Both options share these facts:

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

## Option A: two codes, pasted by hand (not built)

The host sends an invite code, the joiner pastes it and gets a reply code, sends it back, the host pastes it.

- In that order the **joiner** applies first, so the host must paste the reply within **15 s** of the joiner making it.
  Too tight for a chat relay.
- Flipping the order (joiner makes a request code, host pastes it and makes the reply) puts the 40 s window on the
  host. Making it unlimited needs the host to re-create its ICE agent with the same credentials and DTLS certificate
  every 40 s (self-signed certificate generation, libdatachannel's native API). Feasible, but the joiner's own NAT
  mapping can still expire while codes travel (some routers drop idle UDP mappings after 30-60 s).
- Codes are about 110 characters (ICE password and DTLS fingerprint cannot be shortened), one pair per joiner.
- Depends on nothing but STUN.

## Option B: one code, public signaling relays (built)

The join code (short, like today) names a meeting point; host and joiner exchange the signaling protocol through free
public Nostr relays, encrypted with a key derived from the code so relays see nothing useful.

- Same UX as a normal join: the host shows one code, the joiner types it. No timing window: both sides are live and
  trickle candidates as they appear.
- Depends on third-party public relays (several, redundant, free) in addition to STUN. If all are down, the fallback
  is down; the IP code is unaffected.
- It is the existing signaling socket carried over relays, so the lobby, the hub and the WebRTC code are unchanged, and
  an IP joiner and a Nostr joiner sit in the same lobby.

What the relays see: a random key per session, the topic (a hash of the code), timestamps, sizes. Never the code, the
hub messages, SDP or addresses. Anonymous: no account, no login, no personal information leaves the machine.

### Order the host offers things

1. The Nostr code is always available (default on) and is the `joinCode`.
2. UPnP / NAT-PMP keeps running in the background; a mapping makes the IP code an `internet` code and, because the
   host pins its peer links to the direct UDP port, also gives Nostr joiners a reachable candidate (hard NATs).
3. A manual forward (`publicAddress`) wins for the IP code the same way. The IP code is `lobby.directCode`.
4. `nostr: false` (or `hosting.nostr: false`) turns Nostr off; `joinCode === directCode` as before.

### Relay probe, 2026-10-26

`checkNostrRelays` (connect, subscribe, publish one kind 25050 event under a random topic with a random key, see it
echoed), from a home connection in the Pacific time zone, anonymous. Ok means accepted and echoed.

| relay | result |
|---|---|
| wss://nos.lol | ok, 1.1 s |
| wss://relay.primal.net | ok, 1.1 s |
| wss://nostr-pub.wellorder.net | ok, 0.5 s |
| wss://nostr.oxtr.dev | ok, 1.1 s |
| wss://nostr.bitcoiner.social | ok, 0.5 s |
| wss://relay.nostr.net | ok, 1.5 s |
| wss://nostr.sathoarder.com | ok, 1.2 s |
| wss://nostr-01.yakihonne.com | ok, 2.2 s (not kept: one per operator is enough) |
| wss://nostr.data.haus | ok, 2.2 s (not kept) |
| wss://relay.damus.io | refused: "banned: too many rate-limit violations" (an address ban at probe time, not a policy against the kind) |
| wss://nostr.mom | connection failed |
| wss://relay.nostr.band | timeout |
| wss://offchain.pub | refused: not in web of trust |
| wss://relay.snort.social | timeout |
| wss://nostr.wine | refused: paid relay (expected) |
| wss://relay.nostr.bg | connection failed |
| wss://relay.noswhere.com | refused: "no one was listening" (mute) |
| wss://nostr.einundzwanzig.space | refused: NIP-05 needed |
| wss://relay.nostrplebs.com | refused: NIP-05 needed |
| wss://relay.coinos.io | refused: kind 25050 not allowed |
| wss://relay.current.fyi, relay.0xchat.com, strfry.iris.to, relay.orangepill.dev, relay.mostr.pub, nostr-relay.nokotaro.com, relay.stoner.com | connection failed |
| wss://relay.nsec.app, yabu.me | timeout |

The default list is the seven that passed first. A live run through all seven (host, joiner, one message over a real
WebRTC link) joined in about 0.5 s. Relays come and go: when a blueprint is created, the `onelobby` skill runs
`checkNostrRelays` again and writes the working ones to `hosting.nostrRelays`.

## Browser host (built)

With signaling on public relays the host no longer needs a listening port, so a browser tab can host: `kit.hostNostr()` runs
the same hub in the page (the host's own socket is the in-memory `LocalHubSocket`) and a `NostrHostBridge` on the relays.
There is no IP code and no router request, so the only fallback is the relay list: no relay in 10 s rejects with
`direct_unreachable`. Links use STUN only, so a strict-NAT pair fails with `ice_failed` as above; those games need a Node or
native host. Hidden tabs are throttled by the browser, so the lobby reports `hostHidden` rather than hiding the problem.
Recipe: `docs/recipes/browser-game.md` section 6.
