# Recipe: tell the player why a connection failed

A failed connection should not read "Failed to connect". OneLobby knows how far the attempt got and what the network did, so
a failure carries a plain cause and one next step, the host sees the same cause for the player who could not join, and a
log is one click away. The contract is `spec/diagnostics.md` (JS now; C# and GDScript follow it).

Nothing is sent to OneLobby or any third party. The log stays on the player's machine; the only thing that leaves is a small
report (a cause code, a stage, how long, whether a relay was set; never an address) to the host the player dialed.

Snippets tagged `ts compile` are type-checked by `docs/check-snippets.mjs`.

## 1. The error screen with Copy logs

```ts compile file=error-screen.ts
import { OneLobby, describeError } from "onelobby";

declare const kit: OneLobby;
declare function show(text: string, hint?: string): void; // your UI

export async function joinWithReasons(code: string) {
  try {
    return await kit.join(code); // or kit.joinDirect(code); a lobby's `ready` rejects with the same kind of error
  } catch (e) {
    const why = describeError(e); // { code: "ice_failed", cause: "nat_blocked", message, hint, stage }
    show(why.message, why.hint); // "Your network blocks direct connections (strict NAT) and no relay is set."
    return null;
  }
}

export const copyLogs = () => navigator.clipboard.writeText(kit.netLog.export());        // addresses masked
export const saveLogs = () => kit.netLog.download("my-game-netlog.txt");                  // browsers; Node: await kit.netLog.save(path)
```

`error.diagnosis` is `{ cause, message, hint, stage }`; the error `code` is unchanged (`ice_failed`, `timeout`,
`version_mismatch`, `connect_failed`, `direct_unreachable`), so code that tests it keeps working. A lobby's `ready` promise
and the kit's `error` event carry the same.

| cause | what the player reads |
|---|---|
| `nat_blocked` | Your network blocks direct connections (strict NAT) and no relay is set. |
| `relay_refused` | The relay rejected the login. |
| `relay_unreachable` | The relay could not be used: it did not answer. |
| `udp_blocked` | Your network blocks UDP, the kind of traffic games use to connect. |
| `firewall` | A firewall may be blocking the game on the host's computer. |
| `version_mismatch` | You have version 1.4, the host has 1.5. |
| `host_unreachable` | The host did not answer. |
| `signaling_unreachable` | Could not reach the lobby server or any relay that introduces players. |
| `timeout_unknown` | The connection did not finish. It stopped at the connection check after 15 s. |

## 2. The host sees it too

```ts compile file=host-sees.ts
import type { Lobby } from "onelobby";

declare function toast(text: string): void; // your UI

export function watchFailedJoins(lobby: Lobby) {
  lobby.on("peerDiagnosis", (d) => {
    toast(d.line);        // "Sam: strict NAT, no relay set, stopped at the connection check after 15 s."
    console.log(d.message, d.hint, d.cause, d.candidateTypes); // the sentence Sam saw, and what the host can do about it
  });
}
```

It arrives over the signaling path (lobby server, the Direct hub, or the Nostr room), so it works exactly when the direct
link did not. Turn it off with `diagnostics: { reportToHost: false }`; an older hub or host just ignores it.

## 3. The connection check

Run it from a menu button; the library never runs it by itself. It asks two STUN servers from one socket (so a NAT that maps
by destination shows two ports), and tries the player's relay login.

```ts compile file=check.ts
import type { OneLobby, IceServer } from "onelobby";

declare const kit: OneLobby;
declare const relay: IceServer | undefined; // the player's pasted relay line, if any

export async function runCheck(): Promise<string> {
  const r = await kit.checkConnection(relay ? { iceServers: [relay] } : {});
  // r = { udp: "ok", natType: "symmetric", relay: "none", verdict: "likely_fail", message }
  return r.message; // "Direct connections: likely to fail. A relay is recommended."
}
```

The result also feeds later diagnoses (a failure after a `symmetric` check says `nat_blocked` with certainty). Browsers use
one `RTCPeerConnection` instead and cannot see their own address, so they never report `open`.

## 4. The log

`kit.netLog` is a ring buffer (500 entries; `diagnostics: { logSize }`) of connection steps with timings: signaling, hello and
welcome, offers and answers, candidate types, ICE and channel states, the chosen route, retries, errors with codes, the
client, protocol and platform. `export()` masks IPv4, IPv6 and mDNS names; `export({ includeAddresses: true })` unmasks
those only. TURN logins, ICE secrets and join passwords are never printed, and never stored.

In Node, set `diagnostics: { logPath: "logs/net.log" }` and the log is written on exit and when the process dies from an
uncaught error. In a browser the log lives in memory; a reload keeps the last session in `sessionStorage`
(`kit.netLog.exportLastSession()`).

For the pure pieces (tests, other engines), `diagnose(facts)` is exported: the same facts give the same answer in every client.
