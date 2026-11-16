// Audit items 19-42 (a Unity game, and a web game whose Node process hosts): the Next lines, the wiring check for a Node host,
// the Unity build file that is not written beside a game's own build, and the "project is open in the editor" verify text.
// Each rule has a negative control. No Unity, no network, nothing listens.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";
import { intoNext, nodeHostNext } from "../src/files.js";
import { findOwnBuild, BUILD_FILE } from "../src/unity.js";
import { runChecks } from "../src/verify/core.js";
import { wiringCheck, NODE_HOST_CALL } from "../src/verify/wiring.js";
import { PROJECT_LOCKED, lastError } from "../src/verify/unity.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-auditbc-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
const at = (...p) => join(cwd, ...p);
const put = (path, text = "") => {
  mkdirSync(join(at(path), ".."), { recursive: true });
  writeFileSync(at(path), text);
};
async function cli(args) {
  let out = "";
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: () => {} }, stdin: Readable.from([""]), stdinIsTTY: false, env: {}, cwd, resolveUnity: () => ({ exe: at("none.exe"), version: "6000.1.5f1", from: "$UNITY" }) };
  const code = await main(args, io);
  return { code, json: JSON.parse(out) };
}

describe("a Node host's Next lines (items 29-35, 39-41)", () => {
  const node = (over = {}) => intoNext({ rel: ".", pkg: { created: false, hasOnelobby: true, isModule: false }, nodeHost: true, standIn: false, mode: "raw", ...over }).join("\n");

  it("the page only joins: joinDirect and asWebSocket, no bindSession page snippet, the browser-game recipe", () => {
    const t = node();
    expect(t).toContain("kit.joinDirect(location.host)");
    expect(t).toContain("lobby.asWebSocket()");
    expect(t).not.toContain("bindSession(lobby");
    expect(t).not.toContain("const lobby = await kit.host()");
    expect(t).toContain("docs/recipes/browser-game.md");
    expect(t).not.toContain("docs/recipes/js-web.md");
  });
  it("negative control: a plain web --into keeps the bindSession page lines and the js-web recipe", () => {
    const t = intoNext({ rel: ".", pkg: { created: false, hasOnelobby: true, isModule: true }, nodeHost: false, standIn: true }).join(" | ");
    expect(t).toContain("bindSession(lobby, kit.blueprint, game)");
    expect(t).toContain("docs/recipes/js-web.md");
    expect(t).not.toContain("joinDirect");
  });
  it("a CommonJS package gets await import() inside an async function, never a require; an ES-module package gets import lines", () => {
    const cjs = node({ pkg: { created: false, hasOnelobby: true, isModule: false } });
    expect(cjs).toContain('await import("onelobby/direct")');
    expect(cjs).toContain("ERR_REQUIRE_ESM");
    expect(cjs).not.toMatch(/require\("onelobby\/direct"\)/);
    const esm = node({ pkg: { created: false, hasOnelobby: true, isModule: true } });
    expect(esm).toContain('import { hostDirect } from "onelobby/direct"');
    expect(esm).not.toContain("ERR_REQUIRE_ESM");
  });
  it("names node-datachannel, the link factory, the port-0 local test, the seat count, origins, the file list and one bundle URL", () => {
    const t = node();
    expect(t).toContain("npm install --save-optional node-datachannel@");
    expect(t).toContain("linkFactory: webRtcLinkFactoryFor(RTCPeerConnection)");
    expect(t).toContain("hostDirect(kit, { local: true, port: 0 })");
    expect(t).not.toContain('bindHost: "127.0.0.1", openPort: false'); // one spelling of the local test
    expect(t).toContain("the Node host holds one seat");
    expect(t).toContain("hosting.allowedOrigins");
    expect(t).toContain("/onelobby.bundle.js");
    expect(t).not.toContain("onelobby.bundle.mjs"); // one spelling of the bundle URL
    expect(t).toContain("no host migration");
    expect(t).toContain("scripts.test");
  });
  it("a replication answer tells the agent to make it raw; raw and lockstep say nothing about it", () => {
    expect(node({ mode: "replication" })).toContain('set sync.mode to "raw"');
    expect(node({ mode: "raw" })).not.toContain('set sync.mode to "raw"');
    expect(node({ mode: "lockstep", standIn: true })).not.toContain('set sync.mode to "raw"');
  });
  it("the same lines come out of the real CLI for a CommonJS folder", async () => {
    put("g/package.json", '{ "name": "g" }');
    const r = await cli(["--into", "g", "--template", "node-browser", "--mode", "raw", "--yes", "--json", "--dry-run"]);
    const next = r.json.next.join("\n");
    expect(next).toContain("npm install --save-optional node-datachannel@");
    expect(next).toContain("kit.joinDirect(location.host)");
    expect(nodeHostNext({ glueName: "session.mjs", mode: "raw", isModule: false }).length).toBeGreaterThan(5);
  });
});

describe("the wiring check for a Node host (item 38)", () => {
  const run = async (dir) => (await runChecks([wiringCheck()], { dir, kind: "web" })).results[0];
  const nodeBp = JSON.stringify({ version: 1, game: { id: "com.example.x" }, engine: "node-browser", hosting: { direct: true, server: false } });

  it("fails a server that only imports onelobby and never calls hostDirect, and says which file to fix", async () => {
    put("a/onelobby.json", nodeBp);
    put("a/server.js", 'const o = require("onelobby"); // not used yet\n');
    const r = await run(at("a"));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("no file outside test/ and node_modules/ calls hostDirect or hostNostr");
    expect(r.detail).toContain("server.js");
    expect(r.next).toContain("hostDirect");
  });
  it("a comment that mentions hostDirect does not count", async () => {
    put("a/onelobby.json", nodeBp);
    put("a/server.js", "// TODO: call hostDirect here\n/* hostDirect */\n * hostNostr\n");
    expect((await run(at("a"))).status).toBe("fail");
    expect(NODE_HOST_CALL.test("  // hostDirect")).toBe(false);
  });
  it("passes once the host file calls hostDirect (CommonJS dynamic import, or an ES import), naming that file", async () => {
    put("a/onelobby.json", nodeBp);
    put("a/server.js", 'async function start() { const { hostDirect } = await import("onelobby/direct"); return hostDirect(kit, { http }); }\n');
    const r = await run(at("a"));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("server.js");
    put("b/onelobby.json", nodeBp);
    put("b/host.mjs", 'import { hostNostr } from "onelobby/direct";\nawait hostNostr(kit);\n');
    expect((await run(at("b"))).status).toBe("ok");
  });
  it("the page glue alone does not wire a node-browser game", async () => {
    put("a/onelobby.json", nodeBp);
    put("a/public/index.html", '<script type="module">import { makeKit } from "../multiplayer/session.mjs";</script>');
    expect((await run(at("a"))).status).toBe("fail");
  });
  it("negative control: a plain web game (no engine node-browser) still passes on an import of the glue or onelobby", async () => {
    put("w/onelobby.json", JSON.stringify({ version: 1, game: { id: "com.example.x" } }));
    put("w/main.js", 'import { OneLobby } from "onelobby";\n');
    expect((await run(at("w"))).status).toBe("ok");
  });
});

describe("a Unity game with its own player build (item 21)", () => {
  const manifest = '{\n  "dependencies": {\n    "com.unity.modules.ui": "1.0.0"\n  }\n}\n';
  const INTO = ["--into", "mygame", "--template", "unity", "--yes", "--json", "--dry-run", "--title", "My Game"];
  beforeEach(() => {
    put("mygame/ProjectSettings/ProjectVersion.txt", "m_EditorVersion: 6000.1.5f1\n");
    put("mygame/Packages/manifest.json", manifest);
  });

  it("findOwnBuild finds a BuildPipeline.BuildPlayer call outside Assets/OneLobby and nowhere else", () => {
    put("mygame/Assets/Editor/Ship.cs", "class Ship { static void Go() { UnityEditor.BuildPipeline.BuildPlayer(o); } }");
    expect(findOwnBuild(at("mygame"))).toBe("Assets/Editor/Ship.cs");
  });
  it("negative control: the scaffolder's own build file does not count, nor a script that only says the word", () => {
    put("mygame/Assets/OneLobby/Editor/BuildPlayer.cs", "BuildPipeline.BuildPlayer(x)");
    put("mygame/Assets/Scripts/Notes.cs", "// we never call BuildPlayer ourselves\n");
    expect(findOwnBuild(at("mygame"))).toBeUndefined();
  });
  it("with its own build: no BuildPlayer.cs, a note, and Next lines that do not name OneLobbyBuild.Windows as the build", async () => {
    put("mygame/Assets/Editor/Ship.cs", "class Ship { static void Go() { BuildPipeline.BuildPlayer(o); } }");
    const r = await cli(INTO);
    expect(r.json.files).not.toContain(BUILD_FILE);
    expect(r.json.notes.join("\n")).toContain("Assets/Editor/Ship.cs already calls BuildPipeline.BuildPlayer");
    const next = r.json.next.join("\n");
    expect(next).toContain("the game builds its own player (Assets/Editor/Ship.cs)");
    expect(next).not.toContain("build the Windows player:");
    expect(next).toContain("<your player exe>");
  });
  it("negative control: with no build of its own it gets BuildPlayer.cs and the build line", async () => {
    const r = await cli(INTO);
    expect(r.json.files).toContain(BUILD_FILE);
    const next = r.json.next.join("\n");
    expect(next).toContain("build the Windows player:");
    expect(next).toContain("builds the scenes enabled in File > Build Profiles");
    expect(existsSync(at("mygame", BUILD_FILE))).toBe(false); // dry run wrote nothing
  });
  it("the Unity Next lines answer items 19, 20, 22, 23, 27, 28 in one place", async () => {
    const next = (await cli(INTO)).json.next.join("\n");
    expect(next).toContain("Unity has no --autostart");
    expect(next).toContain("menu.StartOnHost = true");
    expect(next).toContain("menu.BeforeHost");
    expect(next).toContain('room.autoStart to "players"');
    expect(next).toContain("menu.BootFlags = false");
    expect(next).toContain("add OneLobbyRunner yourself FIRST");
    expect(next).toContain("the game's own PlayMode assembly is a separate run");
    expect(next).toContain("the editor must be closed");
    expect(next).toContain("lobby.joinLink");
  });
});

describe("a project the editor holds open (item 23)", () => {
  it("Unity's own words are recognised and the text names the lock file and the fix", () => {
    const log = "Multiple Unity instances cannot open the same project.\n";
    expect(PROJECT_LOCKED.test(log)).toBe(true);
    const text = lastError(log);
    expect(text).toContain("already open in another Unity");
    expect(text).toContain("Temp/UnityLockfile");
  });
  it("negative control: an unrelated error keeps its own line", () => {
    expect(PROJECT_LOCKED.test("Unable to resolve com.onelobby.unity")).toBe(false);
    expect(lastError("x\nUnable to resolve com.onelobby.unity\n")).toBe("Unable to resolve com.onelobby.unity");
  });
});
