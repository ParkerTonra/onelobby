# Recipe: browser JS

Add Host / Join / Browse buttons to a web game with `@keepalive/client`. Works in any bundler or a plain module script.
Snippets tagged `ts compile file=NAME` are type-checked by `docs/check-snippets.mjs` (all snippets of one recipe share a
folder, so they can import each other).

## 1. Install

```
npm install @keepalive/client
```

## 2. Settings: the lobby server is not a constant

```ts compile file=settings.ts
export function lobbyServerUrl(): string {
  const params = new URLSearchParams(location.search);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="lobby-server"]')?.content;
  return localStorage.getItem("lobby_server") ?? params.get("lobby") ?? meta ?? "wss://lobby.keepalive.example";
}
```

## 3. Connect: Host, Join, Browse

```ts compile file=net.ts
import { Keepalive } from "@keepalive/client";
import type { Lobby, LobbySummary } from "@keepalive/client";
import { lobbyServerUrl } from "./settings";

const kit = new Keepalive({
  gameId: "com.you.yourgame",   // reverse-DNS, unique to your game
  netVersion: "1",              // bump when your command bytes or rules change
  lobbyServer: lobbyServerUrl(),
  mode: "raw",                  // or "lockstep" (see raw-mode.md)
  displayName: "Player",
});

let lobby: Lobby | null = null;

export async function hostLobby(): Promise<string> {
  lobby = await kit.host({ name: "My game", maxPlayers: 2, visibility: "public" });
  return lobby.code;            // show this: "7HQ 4K2"
}

export async function joinLobby(code: string): Promise<void> {
  lobby = await kit.join(code); // accepts "7hq4k2" or "7HQ 4K2"
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
import { hostLobby, joinLobby, browseLobbies } from "./net";

const status = document.getElementById("net-status")!;
const guard = (fn: () => Promise<void>) => async () => {
  try { await fn(); } catch (e) { status.textContent = `Multiplayer unavailable: ${(e as Error).message}`; }
};

document.getElementById("host")!.onclick = guard(async () => {
  status.textContent = `Share this code: ${await hostLobby()}`;
});
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

## 5. Move bytes

Encode your moves as bytes yourself (`Uint8Array.of(cell)`), then follow `raw-mode.md` (host-authoritative messages) or
`lobby.lockstep.submit` / `nextFrame` (deterministic sim; `AGENTS.md` rule 3).

## Done when

- `tsc --noEmit` passes with the snippets above.
- With a local server (`docs/recipes/self-host.md`) two browser tabs: tab A clicks Host and shows a code; tab B pastes it
  into Join; both see two peers (`lobby.peers.length === 2`).
- Tab B's Browse lists tab A's lobby while it is `public`.
- With the server URL set to a dead address the game still plays offline and Host shows a visible error.
