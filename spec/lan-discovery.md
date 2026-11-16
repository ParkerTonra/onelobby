# LAN discovery (wire version 1)

Status: library built in JS (Node), C# and GDScript, 2026-11-16. Proven only on one machine over 127.0.0.1. Nothing here
has been run on a real network with two machines yet. The menu tab that draws the list is a separate piece of work.

A game on the same local network finds a direct host without a code. It is **opt-in**: off unless `onelobby.json` has
`hosting.lan: true` (needs `hosting.direct`), or the host option `lan` is passed in code. Typing the host's `ip:port`
keeps working in every game. With it off, nothing in this spec runs: no socket, no packet.

## 1. Shape: question and answer, never an announcement

- The **finder** (a player's game that looks for LAN games) sends one small UDP **question** to the network's broadcast
  address from a socket on a port the system picks, and reads the **answers** that come back to that socket.
- A **host** with LAN discovery on listens on one fixed UDP port (default **47840**) and answers each valid question with
  one datagram, sent to the address and port the question came from. A host never sends anything on its own.
- The finder exists only between `start` and `stop`; `stop` closes its socket. The host's answering socket exists only
  while a direct lobby is open and the switch is on. A game that is not hosting and not looking has no socket at all.
- IPv4 only. Broadcast does not exist in IPv6. A player on an IPv6-only network sees an empty list; typing the host's
  address (IPv6 included) works as it does today.

## 2. The datagrams

All numbers are big-endian. Strings are UTF-8, each preceded by one length byte (bytes, not characters). Maximum size of
any datagram, either direction: **512 bytes**; a larger received datagram is dropped unread. A datagram must be consumed
exactly: a trailing byte makes it malformed.

Header (14 bytes, both datagrams):

| offset | size | field |
|---|---|---|
| 0 | 4 | magic `4F 4C 41 4E` ("OLAN") |
| 4 | 1 | wire version, `1` |
| 5 | 1 | type: `1` question, `2` answer |
| 6 | 8 | nonce, random, chosen by the finder, echoed in the answer |

**Question** (15 to 79 bytes): header, then `gameId` (u8 length 1..64, then bytes).

**Answer** (at most 263 bytes): header, then

| size | field |
|---|---|
| 2 | direct port a joiner connects to (1..65535; the TCP port the direct host really listens on) |
| 1 | players now (0..maxPlayers) |
| 1 | maximum players (1..255) |
| 1 | flags: bit 0 = a password is needed; other bits are sent as 0 and ignored |
| 1+n | `gameId` (n 1..64) |
| 1+n | `netVersion` (n 1..32) |
| 1+n | lobby name (n 0..72) |
| 1+n | host player name (n 0..72) |

The answer has **no IP address**. The finder takes the address from where the datagram came from and joins through the
existing join-by-`ip:port` path. The answer's size does not depend on the question's size: it is built from the lobby.

Limits in bytes come from the name rule of the hub: names are cleaned (control characters and bidi overrides removed) and
cut to 24 UTF-16 units, which is at most 72 UTF-8 bytes. A string field must be valid UTF-8 (overlong forms, surrogates
and values above U+10FFFF are invalid). A decoder returns nothing for any datagram that breaks a rule above.
The finder cleans received names again the same way before it hands them to a menu.

`spec/vectors/lan-discovery.json` pins both datagrams as bytes with their decoded fields, and 26 datagrams that must be
dropped (bad magic, other wire version, wrong type, too short, too long, a string over its limit, bad UTF-8, a trailing
byte, port zero, more players than the maximum). `spec/reference/lan-discovery.mjs` is the reference codec; regenerate
with `node spec/reference/gen-lan-discovery.mjs`.

## 3. What a host answers

A host with LAN discovery on, a lobby open and its socket bound answers a datagram only if every check passes, in this
order. A failed check drops the datagram silently and adds 1 to that counter in `stats`:

1. `bad_source`: the source address is loopback (127.0.0.0/8), private (10/8, 172.16/12, 192.168/16) or link-local
   (169.254/16). Anything else is public, shared address space 100.64/10 included, and is never answered.
2. `malformed`: the datagram decodes as a question.
3. `wrong_game`: its game id equals the host's game id (byte for byte).
4. `duplicate`: the same source address and nonce was not already answered in the last 5000 ms. (A finder that asks the
   limited and the directed broadcast address sends two copies of one question; only the first is answered.) The host
   remembers the last 32 pairs.
5. `rate_limited`: per source address at most **3 answers per 1000 ms**, and in total at most **50 answers per 1000 ms**
   (fixed windows). The answer is sent only when both budgets have room.

The answer carries the lobby name, the host player's name, players now and the maximum, the password flag, the direct
port. If no lobby is open yet (the direct host started but the lobby is not created), nothing is answered.

`stats` (a host): `answered`, `bad_source`, `malformed`, `wrong_game`, `duplicate`, `rate_limited`.

## 4. The finder

`start(options)` opens one UDP socket on a system-picked port, with broadcast enabled, and asks at once; then every
**1000 ms**. `askNow()` asks at once. No two questions leave less than **400 ms** apart (a faster `askNow` is held until
then), so a finder stays under the host's 3 per second. Each ask uses a fresh random nonce, sent to every target; the
finder remembers the nonces of the last 8 asks (about 8 seconds) and ignores an answer with any other nonce.

**Targets (where the question goes).** Default: the limited broadcast address `255.255.255.255`, and where the client can
read each network card's netmask (JS and C#; Godot cannot), the directed broadcast address of every card that has a
private or link-local IPv4 address. Reason: on a PC with several cards (a VPN or virtual adapter is common) the system
sends `255.255.255.255` out of one card only, so a host on another card is missed; the directed address of each card
reaches its own network. Both are sent the same question and the host answers it once (the duplicate rule). A test, or a
game started with `--local`, passes its own target list (`127.0.0.1`); the finder then binds `127.0.0.1` and never
enables broadcast. A finder binds `127.0.0.1` exactly when every target is a `127.x.x.x` address, otherwise `0.0.0.0`.

A host that listens on `127.0.0.1` only (`listen_address` / `BindAddress` / `bindHost` = `127.0.0.1`) opens its answering
socket on `127.0.0.1` only; every other host binds `0.0.0.0` so it can receive a broadcast.

The finder keeps an answer only if, in this order: it decodes (`malformed`), its source address is loopback, private or
link-local (`bad_source`), its nonce was sent by this finder (`wrong_nonce`), its game id is the finder's own
(`wrong_game`). An answer with another `netVersion` is kept and marked `sameVersion: false`. Counters in `stats`:
`kept`, `malformed`, `bad_source`, `wrong_nonce`, `wrong_game`.

**Rows.** One row per host, keyed by source address and port number: `address`, `port`, `lobbyName`, `hostName`,
`players`, `maxPlayers`, `hasPassword`, `sameVersion`, `netVersion`, `lastSeenMs`. A new answer from a known host updates
its row in place, so the order is the order in which hosts were first seen (stable). A row is dropped **4000 ms** after
its host last answered. At most 64 rows; answers from more hosts are ignored until a row expires. The list has a changed
signal or callback that fires only when the rows (not just `lastSeenMs`) change. `stop` closes the socket, empties the
list and discards any later datagram.

A finder in a browser cannot open a UDP socket: it reports `status: "browser"` and never throws at import time.

## 5. Failure

If the host's socket cannot be opened (the port is taken, e.g. a second host on the same PC), hosting goes on exactly as
before and the net log gets one line: `LAN discovery is off for this lobby: UDP port 47840 is taken` (or the system's
reason). Two hosts on one PC: the first to start is found; the second runs without LAN discovery and cannot be found by
the finder, but joining it by `ip:port` works. If the finder's socket cannot be opened its `status` is `"socket_failed"`
with a reason, and the list stays empty.

## 6. Constants

| name | value |
|---|---|
| UDP port (host answers on it) | 47840, a host/finder option; every host of one game must use the same one |
| max datagram | 512 bytes (question 79, answer 263 by construction) |
| game id / netVersion / lobby name / host name | 1..64 / 1..32 / 0..72 / 0..72 bytes |
| ask interval / minimum gap | 1000 ms / 400 ms |
| row timeout / row cap | 4000 ms / 64 |
| nonces remembered | last 8 asks |
| host rate | 3 per 1000 ms per source address, 50 per 1000 ms in total |
| duplicate memory | 32 (source, nonce) pairs, 5000 ms |

## 7. Not measured

Whether Windows Firewall shows an "allow this app?" prompt for the finder or the answering host in a shipped game has
not been measured. By design: the finder opens no fixed port and receives only answers to its own questions; a direct
host already listens for direct joins. Nothing here has been seen on a real network with two machines (a real router,
a real broadcast, a real firewall, a network that blocks broadcast between clients).
