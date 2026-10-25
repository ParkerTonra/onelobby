# Recipe: test multiplayer headless (two browser contexts)

Drive a host and a joiner in one script with `playwright-core` and a system Edge or Chrome (no browser download).
Use it to check the "Done when" lines of the other recipes without clicking.

## 1. Setup

```
npm install --save-dev playwright-core
dotnet run --project /path/to/onelobby/server/OneLobby.Server -- --listen :8080     # lobby server, in another terminal
npx serve -l 5173 .                                                                   # your bundled game, in another terminal
```

Browser paths (`executablePath`; Playwright cannot find system browsers by itself here):

| OS | Edge | Chrome |
|---|---|---|
| Windows | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| macOS | `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| Linux | `/usr/bin/microsoft-edge` | `/usr/bin/google-chrome` |

## 2. Host and join in two contexts

Two contexts are two separate players (own storage, own WebRTC). Use `127.0.0.1`, not `localhost`. The lobby URL ends in `/ws`.

```js
// test-multiplayer.mjs
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.BROWSER ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",          // auto-accept the mic prompt
    "--use-fake-device-for-media-stream",      // a synthetic beep as the microphone
    // "--use-file-for-fake-audio-capture=tone.wav",   // or your own WAV
  ],
});
const url = "http://127.0.0.1:5173/?lobby=" + encodeURIComponent("ws://127.0.0.1:8080/ws");
const newPlayer = async () => {
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  const page = await ctx.newPage();
  page.on("console", (m) => console.log("[page]", m.text()));
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.goto(url);
  return page;
};

const host = await newPlayer();
await host.click("#host");
await host.waitForFunction(() => /code: /i.test(document.getElementById("net-status").textContent));
const code = (await host.textContent("#net-status")).split(": ")[1].replace(/\s/g, "");

const joiner = await newPlayer();
await joiner.fill("#code", code);
await joiner.click("#join");
await joiner.waitForFunction(() => /joined/i.test(document.getElementById("net-status").textContent));

// Play: host clicks cell 0; the joiner must see an X there.
await host.locator("#board button").nth(0).click();
await joiner.waitForFunction(() => document.querySelector("#board button").textContent === "X");
console.log("ok: move crossed from host to joiner");
await browser.close();
```

The selectors (`#host`, `#join`, `#code`, `#net-status`, `#board`) are the ones `js-web.md` section 4 builds; adapt them to your page. For chat, fill your chat input in one
page and `waitForFunction` for the line in the other. Voice needs a real tone: use `--use-file-for-fake-audio-capture`,
hold push-to-talk in one page, and assert your `speaking` indicator in the other.

## 3. In memory: no lobby server, no browser

When no lobby server runs (an agent's sandbox, CI), test your netcode in Node with the doubles from `onelobby/testing`:
an in-memory lobby server and in-memory peer links stand in for the network. Put your game's glue (the file that calls
`fromConfig`, `host`, `join`, `send`) under test the same way by passing it these `advanced` options.

```js
// two-players.test.mjs   (node two-players.test.mjs)
import { OneLobby } from "onelobby";
import { MemoryServer, MemoryNetwork } from "onelobby/testing";

const blueprint = { game: { id: "com.you.game" }, lobby: { maxPlayers: 2 }, sync: { mode: "raw" } };
const server = new MemoryServer();                      // in-memory lobby server
const network = new MemoryNetwork();                    // in-memory peer links (no WebRTC)
const player = (name) => OneLobby.fromConfig(blueprint, {
  displayName: name,
  lobbyServer: "ws://memory/ws",                        // any address; the memory socket ignores it
  advanced: { socketFactory: server.socketFactory, linkFactory: network.factoryFor(name), storage: null },
});

const host = await player("Ann").host();
const joiner = await player("Bob").join(host.code);
await joiner.ready;                                     // joiner's link to the host is open

const got = new Promise((resolve) => host.on("message", (from, bytes) => resolve(bytes[0])));
joiner.send(host.hostPeerId, new Uint8Array([7]));
if ((await got) !== 7) throw new Error("message did not cross");
console.log("ok: peers", host.peers.length, joiner.peers.length, "and a message crossed");

await joiner.leave(); await host.leave();               // leave every lobby, or the process never exits
```

This proves the netcode, not the network: run section 2 against a real server before a release. Chat lines reach every
peer, the sender included (the host echoes each accepted line), so render chat on `message`, not on send.

## 4. Troubleshooting

- Page loads but Host does nothing: open `DevTools` output via the `[page]` console lines; a wrong lobby URL shows
  "Multiplayer unavailable". Check `curl http://127.0.0.1:8080/healthz`.
- `getUserMedia` denied: the context needs `permissions: ["microphone"]` and the fake-ui flag; the page must be
  `http://127.0.0.1` or `https`, not a `file://` URL.
- Headed debugging: set `headless: false` and `slowMo: 200` in `launch`.

## Done when

- `node test-multiplayer.mjs` prints the ok line and exits 0 with the lobby server running.
- With no server: `node two-players.test.mjs` prints its ok line and exits 0.
- Running it with the lobby server stopped makes the host page show "Multiplayer unavailable" and the game still plays.
