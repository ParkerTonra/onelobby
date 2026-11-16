// What gets written. Templates are real files under templates/ with {{placeholders}} and `//#if project|into` blocks.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ONELOBBY_VERSION, SCHEMA_URL } from "./blueprint.js";

const templates = join(dirname(fileURLToPath(import.meta.url)), "../templates");
const read = (...p) => readFileSync(join(templates, ...p), "utf8");

export const RECIPE_URL = "https://github.com/ParkerTonra/onelobby/blob/main/docs/recipes/js-web.md";
export const DEFAULT_DEPENDENCY = `^${ONELOBBY_VERSION}`;

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Replace {{name}} placeholders; unknown names are left alone. */
function fill(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** Keep `//#if <tag>` ... `//#endif` blocks for the chosen tag only, and drop the marker lines. */
function conditional(text, tag) {
  const out = [];
  let keep = true;
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\/\/#(if|endif)\s*(\w*)/);
    if (!m) {
      if (keep) out.push(line);
    } else keep = m[1] === "endif" ? true : m[2] === tag;
  }
  return out.join("\n");
}

export const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const json = (o) => JSON.stringify(o, null, 2) + "\n";

/** All files of a new `web` project: [{ path (posix, relative), content }]. */
export function webProjectFiles({ blueprint, dirName, onelobbyVersion = DEFAULT_DEPENDENCY }) {
  const title = blueprint.game.title ?? dirName;
  const vars = { title: escapeHtml(title), schemaUrl: SCHEMA_URL, recipeUrl: RECIPE_URL, pkgName: slug(dirName) || "onelobby-game" };
  const pkg = JSON.parse(fill(read("web", "package.json"), vars));
  pkg.dependencies.onelobby = onelobbyVersion;
  return [
    { path: "onelobby.json", content: json(blueprint) },
    { path: "package.json", content: json(pkg) },
    { path: "index.html", content: fill(read("web", "index.html"), vars) },
    { path: "src/game.js", content: read("web", "src", "game.js") },
    { path: "src/multiplayer.js", content: read("web", "src", "multiplayer.js") },
    { path: "src/session.js", content: read("glue", "session.js") },
    { path: "scripts/serve.mjs", content: read("web", "scripts", "serve.mjs") },
    { path: "test/multiplayer.mjs", content: conditional(read("glue", "multiplayer-test.mjs"), "project") },
    { path: "AGENTS.md", content: fill(read("web", "AGENTS.md"), vars) },
    { path: ".gitignore", content: read("web", "_gitignore") },
  ];
}

/** The files `--into` adds to an existing project: onelobby.json, multiplayer/ glue and the test. */
export function intoFiles({ blueprint, packageJson, glueName = "session.js", standIn = true, glue = true }) {
  const files = [{ path: "onelobby.json", content: json(blueprint) }];
  if (glue) files.push({ path: `multiplayer/${glueName}`, content: read("glue", "session.js") });
  if (standIn) files.push({ path: "test/multiplayer.mjs", content: fill(conditional(read("glue", "multiplayer-test.mjs"), "into"), { glue: `../multiplayer/${glueName}` }) });
  // no package.json in the folder: a minimal one; an existing package.json is never edited
  if (packageJson) {
    const pkg = { name: slug(packageJson.dirName) || "onelobby-game", version: "0.1.0", private: true, type: "module", dependencies: { onelobby: packageJson.onelobbyVersion ?? DEFAULT_DEPENDENCY } };
    files.push({ path: "package.json", content: json(pkg) });
  }
  return files;
}

/**
 * The "Next:" lines of a web `--into` run, in the order the work happens. `pkg`: { created, hasOnelobby, isModule } (the folder's
 * package.json as it is after this run; `range`: the version range it already lists for onelobby, if any). `glue`: the glue file was written.
 */
export function intoNext({ rel, pkg, glueName = "session.js", glue = true, standIn = true, nodeHost = false, mode = "lockstep", titleFromFolder = false, onelobbyVersion = DEFAULT_DEPENDENCY }) {
  const next = [];
  if (rel !== ".") next.push(`cd ${rel}`);
  if (pkg.created) next.push('npm install   # package.json was missing, so a minimal one was written (private, "type": "module", the onelobby dependency)');
  else {
    if (!pkg.isModule && (glue || !nodeHost)) next.push(`your package.json has no "type": "module" and was left as it is (a CommonJS game keeps working): the glue is named multiplayer/${glueName}, and a .mjs file is an ES module whatever the package says; do not add "type": "module"`);
    if (!pkg.hasOnelobby) next.push(`npm install onelobby@${onelobbyVersion}   # your package.json was left as it is and does not list onelobby`);
    else if (pkg.range && pkg.range !== onelobbyVersion)
      next.push(`npm install onelobby@${onelobbyVersion}   # your package.json lists onelobby ${pkg.range} and was left as it is: this moves that line and the lock file to the version this scaffolder targets (OneLobby.fromConfig, hostDirect and describeError need it; an older pin does not have them). Right after a release add --prefer-online if npm answers ETARGET`);
    else next.push("npm install");
  }
  if (nodeHost) next.push(`npm install --save-optional ${NODE_DATACHANNEL}   # WebRTC for the Node host: without it hostDirect cannot link a browser (an existing package.json is never edited, so run this yourself)`);
  if (titleFromFolder) next.push("game.title in onelobby.json came from the folder name: set it to the game's name (--title, or edit the file)");
  if (nodeHost) next.push(...nodeHostNext({ glueName, glue, mode, isModule: pkg.isModule || pkg.created }));
  if (standIn) next.push("put your game behind step(tick, commands) -> hash, snapshot() -> bytes, restore(tick, bytes) and hash(), and swap it for the stand-in Game in test/multiplayer.mjs");
  else if (!nodeHost || mode === "raw") next.push(`sync.mode is ${mode}: your own sync stays, so no lockstep stand-in test was written; \`verify\` skips its project-test and the proof of your netcode is your own two-player test`);
  if (!nodeHost)
    next.push(
      `in the page: import { loadBlueprint, makeKit, bindSession } from "./multiplayer/${glueName}"; const bp = await loadBlueprint(); const kit = makeKit(bp, { displayName }); const lobby = await kit.host() (or await kit.join(code)); const s = bindSession(lobby, kit.blueprint, game) before lobby.start(); call s.pump(performance.now()) every frame and s.send(bytes) when the player acts`,
      'a page with no bundler cannot resolve the bare "onelobby" import in that glue: serve node_modules/onelobby/dist/onelobby.bundle.mjs (one file; require.resolve("onelobby/bundle") in Node) at a URL of your server and put <script type="importmap">{ "imports": { "onelobby": "/onelobby.bundle.js" } }</script> before your module script',
    );
  if (standIn) next.push("node test/multiplayer.mjs   # expect every check to PASS");
  next.push(`follow ${nodeHost ? NODE_BROWSER_RECIPE_URL : RECIPE_URL}`);
  return next;
}

export const NODE_DATACHANNEL = "node-datachannel@^0.33.4";
export const NODE_BROWSER_RECIPE_URL = "https://github.com/ParkerTonra/onelobby/blob/main/docs/recipes/browser-game.md";

/** The Next lines that are only true for a Node process that hosts and serves browser pages (engine node-browser). */
export function nodeHostNext({ glueName, glue = true, mode, isModule }) {
  const lines = [
    `a Node process hosts this game and every page only JOINS it: the page never hosts, ${glue ? `so multiplayer/${glueName} (bindSession, kit.host, kit.join) is used only by test/multiplayer.mjs, never by the game: the glue is for a game whose page hosts` : "so no glue file was written (bindSession, kit.host and kit.join are for a game whose page hosts)"}. The flow is browser-game.md sections 3 and 4. hostDirect takes seats, late join, port, openPort, nostr and allowed origins from kit.blueprint (an option you pass wins)`,
  ];
  if (mode !== "raw" && mode !== "lockstep")
    lines.push(`sync.mode is ${mode}, but pages talk through asWebSocket() with the game's own messages: set sync.mode to "raw" in onelobby.json (or pass --mode raw on the first run): replication would replace the game's own sync`);
  lines.push(
    isModule
      ? 'in the Node process: import { OneLobby, webRtcLinkFactoryFor } from "onelobby"; import { hostDirect } from "onelobby/direct"; import { RTCPeerConnection } from "node-datachannel/polyfill"; const kit = OneLobby.fromConfig(JSON.parse(readFileSync("onelobby.json", "utf8")), { advanced: { linkFactory: webRtcLinkFactoryFor(RTCPeerConnection) } }); const lobby = await hostDirect(kit, { http: page }); lobby.onConnection((conn) => { /* the old WebSocket handler: conn.onmessage, conn.send, conn.onclose */ })'
      : 'in the Node process (your package is CommonJS and onelobby is ES-module only, so require("onelobby") fails with ERR_REQUIRE_ESM before Node 22.12): inside an async function (CommonJS has no top-level await) const { OneLobby, webRtcLinkFactoryFor } = await import("onelobby"); const { hostDirect } = await import("onelobby/direct"); const { RTCPeerConnection } = await import("node-datachannel/polyfill"); const kit = OneLobby.fromConfig(JSON.parse(fs.readFileSync("onelobby.json", "utf8")), { advanced: { linkFactory: webRtcLinkFactoryFor(RTCPeerConnection) } }); const lobby = await hostDirect(kit, { http: page }); lobby.onConnection((conn) => { /* the old WebSocket handler: conn.onmessage, conn.send, conn.onclose */ })',
    `in the page: import { OneLobby } from "/onelobby.bundle.js"; const kit = OneLobby.fromConfig(await (await fetch("/onelobby.json")).json(), { displayName }) (second argument: displayName?: string, lobbyServer?: string, rememberSeat?: boolean, advanced?: { linkFactory, socketFactory, clock, wallClock, storage, ... }; a page needs none of them); const lobby = await kit.joinDirect(location.host); await lobby.ready; const ws = lobby.asWebSocket(): the game's own message code runs on ws unchanged. No import map is needed`,
    `serve the page from hostDirect itself, from memory: page(path) must return { type, body } for / (the page), /onelobby.bundle.js (readFileSync(require.resolve("onelobby/bundle")): one spelling, one file), /onelobby.json when the page fetches it, and every script and asset of the game. hostDirect answers its own port (hosting.directPort, 47810 by default; a kit built with fromConfig has no fallback, so a busy port fails unless you pass fallbackPorts: 9 to hostDirect), so a page still served from the game's old http port gets 403 on the WebSocket upgrade: serve it from hostDirect, or list its origin in hosting.allowedOrigins. The page must be plain http, not https`,
    "lobby.maxPlayers is the whole lobby and the Node host holds one seat: one lobby is the whole server, so set it to the most browsers connected at once plus one (the recipe uses 64), not to a match size",
    "no host migration: when the Node process stops every page gets onclose with code 1001 and reason host_left; keep the game's own redial loop (lobby.rejoin and resume_token are for Lobby pages, not asWebSocket)",
    'to test on this PC only: hostDirect(kit, { local: true, port: 0 }) (local sets bindHost "127.0.0.1", openPort false and nostr false, so no router, no Nostr, no STUN; port 0 takes any free port, read it from lobby.directAddresses[0], so another run on the PC never collides). Your own two-peer test joins with kit.joinDirect("127.0.0.1:<port>"), needs node-datachannel in the test too (docs/recipes/testing.md section 4 has a minimal one), and must import the game without starting its server: a server.js that listens when it is loaded needs the listen call split out. Add it to package.json scripts.test yourself',
  );
  return lines;
}

/** The glue file this version writes (templates/glue/session.js), for `update` to compare a project copy with. */
export const glueSession = () => read("glue", "session.js");
