# Recipe: browser JS

Add Host / Join / Browse buttons to a web game with `onelobby`. Works in any bundler or a plain module script.
Snippets tagged `ts compile file=NAME` are type-checked by `docs/check-snippets.mjs` (all snippets of one recipe share a
folder, so they can import each other).

## 1. Install

```
npm install onelobby
```

No bundler: `<script src="https://cdn.jsdelivr.net/npm/onelobby@0.1.0/dist/onelobby.global.min.js">` sets
`window.OneLobby` (so `new OneLobby.OneLobby({...})`), or import the single-file ES module
`https://cdn.jsdelivr.net/npm/onelobby@0.1.0/dist/onelobby.bundle.mjs`. Low-level pieces (codec, chunking,
migration, WebRTC classes) are in `onelobby/internals`; in-memory test doubles in `onelobby/testing`.

### From a clone of this repo (before a release is on npm, or to try unreleased changes)

Build it once, then point your project at the build:

```
git clone https://github.com/ParkerTonra/onelobby
cd onelobby/clients/js && npm ci && npm run build -w packages/client     # writes packages/client/dist
```

Either depend on it with a `file:` path, or bundle with an esbuild alias (no package install in your project):

```
# in your project
npm install file:/path/to/onelobby/clients/js/packages/client
# or, plain-JS project with no package.json
/path/to/onelobby/clients/js/node_modules/.bin/esbuild src/main.js --bundle --format=esm --outfile=dist/app.js   --alias:onelobby=/path/to/onelobby/clients/js/packages/client/dist/index.js
```

Then load the bundle from the page: `<script type="module" src="./dist/app.js"></script>`. A page that only has
`<script type="module" src="./src/main.js">` cannot resolve the bare name `onelobby`, so bundle first.
Lobby URL: the server's WebSocket endpoint is `ws://HOST:8080/ws` (`wss://HOST/ws` behind Caddy).

## Codes and peers

The server returns codes ungrouped (`C5AFX8`); show them grouped (`C5A FX8`) with `formatCode` or by hand. `join` accepts
either form. `lobby.peers` includes the local player and the host, so a two-player lobby has `peers.length === 2` on both sides.

## 2. Settings: the lobby server is not a constant

```ts compile file=settings.ts
export function lobbyServerUrl(): string {
  const params = new URLSearchParams(location.search);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="lobby-server"]')?.content;
  return localStorage.getItem("lobby_server") ?? params.get("lobby") ?? meta ?? "wss://lobby.onelobby.example/ws";
}
```

## 3. Connect: Host, Join, Browse

```ts compile file=net.ts
import { OneLobby, formatCode } from "onelobby";
import type { Lobby, LobbySummary } from "onelobby";
import { lobbyServerUrl } from "./settings";

const kit = new OneLobby({
  gameId: "com.you.yourgame",   // reverse-DNS, unique to your game
  netVersion: "1",              // bump when your command bytes or rules change
  lobbyServer: lobbyServerUrl(),
  mode: "raw",                  // or "lockstep" (see raw-mode.md)
  // displayName: "Ann",        // optional; empty shows as "Player N"
  // readyTimeoutMs: 15000,     // default: a joiner that can't reach the host fails with code "ice_failed"
});

let lobby: Lobby | null = null;

export async function hostLobby(): Promise<string> {
  // visibility defaults to "unlisted" (join by code or link only); "public" also shows it in Browse
  lobby = await kit.host({ name: "My game", maxPlayers: 2, visibility: "public" });
  return formatCode(lobby.code); // the server returns "C5AFX8"; show it grouped: "C5A FX8"
}

export async function joinLobby(code: string): Promise<void> {
  lobby = await kit.join(code); // accepts "7hq4k2" or "7HQ 4K2"; after a reload it takes the old seat back
}

/** After a page reload: back into the lobby this tab was in (rememberSeat), or false. */
export async function resumeLobby(): Promise<boolean> {
  lobby = await kit.resume();
  return lobby !== null;
}

export async function browseLobbies(): Promise<LobbySummary[]> {
  return kit.list();            // public lobbies for this gameId + netVersion
}

export function currentLobby(): Lobby | null { return lobby; }
```

Never make the game's start wait on these. Wrap each call in try/catch, show the error, keep playing offline.

## 4. Buttons

```html
<button id="host">Host lobby</button>
<input id="code" placeholder="Join code"> <button id="join">Join lobby</button>
<button id="browse">Browse</button>
<ul id="lobbies"></ul>
<div id="net-status"></div>
```

```ts compile file=ui.ts
import { codeFromUrl, describeError, shareUrl } from "onelobby";
import { hostLobby, joinLobby, browseLobbies } from "./net";

const status = document.getElementById("net-status")!;
const guard = (fn: () => Promise<void>) => async () => {
  try { await fn(); } catch (e) {
    const f = describeError(e); // plain words for players, e.g. "That lobby is full." plus a hint
    status.textContent = f.hint ? `${f.message} ${f.hint}` : f.message;
  }
};

document.getElementById("host")!.onclick = guard(async () => {
  const code = await hostLobby();
  status.textContent = `Share this code: ${code} or this link: ${shareUrl(code)}`;
});
// Opened from a share link (?join=7HQ-4K2): join straight away.
const linked = codeFromUrl();
if (linked) void guard(async () => { await joinLobby(linked); status.textContent = "Joined."; })();
document.getElementById("join")!.onclick = guard(async () => {
  await joinLobby((document.getElementById("code") as HTMLInputElement).value);
  status.textContent = "Joined.";
});
document.getElementById("browse")!.onclick = guard(async () => {
  const list = document.getElementById("lobbies")!;
  list.replaceChildren(...(await browseLobbies()).map((s) => {
    const li = document.createElement("li");
    li.textContent = `${s.name} (${s.players}/${s.maxPlayers})`;
    li.onclick = guard(async () => { await joinLobby(s.code); });
    return li;
  }));
});
```

## Friendly defaults

- A joiner that cannot reach the host within `readyTimeoutMs` (15 s) stops waiting: `lobby.ready` rejects with code
  `ice_failed`, `kit.on("error")` fires, and the lobby ends with `sessionEnded` reason `"ice_failed"`. Show
  `describeError(e)`; it suggests another network. Half the budget is a relay-only retry when the server has TURN.
- `rememberSeat` (on by default): a reload keeps the player's seat. `kit.rememberedCode` is the lobby to offer
  ("Rejoin 7HQ 4K2?"), `kit.resume()` takes it back. Pass `rememberSeat: false` to always join fresh.
- Test seams (`socketFactory`, `linkFactory`, `clock`, ...) live under `advanced: { ... }`.

## 5. Move bytes

Encode your moves as bytes yourself (`Uint8Array.of(cell)`), then follow `raw-mode.md` (host-authoritative messages) or
`lobby.lockstep.submit` / `nextFrame` (deterministic sim; `AGENTS.md` rule 3).

## Done when

- `tsc --noEmit` passes with the snippets above.
- With a local server (`docs/recipes/self-host.md`) two browser tabs: tab A clicks Host and shows a code; tab B pastes it
  into Join; both see two peers (`lobby.peers.length === 2`).
- Tab B's Browse lists tab A's lobby while it is `public`.
- Opening tab A's share link in tab B joins without typing the code; reloading tab B puts it back in the same seat.
- With the server URL set to a dead address the game still plays offline and Host shows a visible error.
