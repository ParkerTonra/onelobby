// The unity template: a new project, --into, the in-place manifest edit, update, verify with fake checks and the wiring check.
// No network, no Unity, no process started.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { main } from "../src/cli.js";
import { addDependencies, inspectManifest, moveDependency, readDependency } from "../src/manifest.js";
import { chooseEditor, compareEditors, editorIsNewEnough, hubEditors, parseEditorVersion, resolveUnity } from "../src/unity.js";
import { decide } from "../src/unity-update.js";
import { runChecks } from "../src/verify/core.js";
import { exitWarning, lastError, packageHasWindowsLibrary, unityChecks } from "../src/verify/unity.js";
import { tgzNames } from "../src/tar.js";
import { wiringCheck } from "../src/verify/wiring.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-unity-"));
  writeFileSync(join(cwd, "com.onelobby.unity-0.7.9-ci.3.tgz"), "x");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const EDITOR = { exe: join(tmpdir(), "no-such-unity.exe"), version: "6000.1.5f1", from: "$UNITY" }; // a fake editor: nothing is run
async function cli(args, { env = {}, found = EDITOR } = {}) {
  let out = "";
  let err = "";
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, stdin: Readable.from([""]), stdinIsTTY: false, env, cwd, resolveUnity: () => found };
  const code = await main(args, io);
  return { code, out, err };
}
const j = async (args, opts) => {
  const r = await cli([...args, "--json"], opts);
  return { ...r, json: JSON.parse(r.out) };
};
const at = (...p) => join(cwd, ...p);
const text = (...p) => readFileSync(at(...p), "utf8");
const put = (path, body = "") => {
  mkdirSync(join(at(path), ".."), { recursive: true });
  writeFileSync(at(path), body);
};
const tree = (dir, rel = "") => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`])).sort();
const NEW = ["--template", "unity", "--yes", "--no-git", "--package-from", "com.onelobby.unity-0.7.9-ci.3.tgz"];

const NEW_FILES = [
  ".gitattributes", ".gitignore", ".olc/my-game.json", "AGENTS.md", "Assets/OneLobby/Editor/BuildPlayer.cs", "Assets/OneLobby/Tests/MultiplayerTests.cs",
  "Assets/OneLobby/Tests/OneLobbyGame.Tests.asmdef", "Assets/Resources/onelobby.json", "Assets/Scripts/Boot.cs", "Packages/manifest.json", "ProjectSettings/ProjectVersion.txt",
];

describe("unity: a new project", () => {
  it("writes the file plan, a manifest that names the tarball, and the editor's version", async () => {
    const r = await j(["my-game", ...NEW]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, template: "unity", changed: true, skipped: [], package: { from: "tarball" }, editor: { version: "6000.1.5f1", from: "$UNITY" } });
    expect(tree(at("my-game"))).toEqual(NEW_FILES);
    expect(r.json.blueprint).toMatchObject({ engine: "unity", ui: { kind: "drop-in" }, hosting: { direct: true, server: false } });
    expect(text("my-game/Packages/manifest.json")).toBe(`{
  "dependencies": {
    "com.onelobby.unity": "file:../../com.onelobby.unity-0.7.9-ci.3.tgz",
    "com.unity.test-framework": "1.6.0",
    "com.unity.modules.imgui": "1.0.0",
    "com.unity.modules.ui": "1.0.0",
    "com.unity.modules.uielements": "1.0.0",
    "com.unity.modules.audio": "1.0.0",
    "com.unity.modules.jsonserialize": "1.0.0",
    "com.unity.modules.unitywebrequest": "1.0.0",
    "com.unity.modules.physics": "1.0.0",
    "com.unity.modules.imageconversion": "1.0.0",
    "com.unity.modules.screencapture": "1.0.0"
  }
}
`);
    expect(text("my-game/ProjectSettings/ProjectVersion.txt")).toBe("m_EditorVersion: 6000.1.5f1\n");
  });

  it("the boot script adds the menu and connects the three events; the test names its assembly; no scene file is written", async () => {
    await j(["my-game", ...NEW]);
    const boot = text("my-game/Assets/Scripts/Boot.cs");
    expect(boot).toContain("[RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]");
    expect(boot).toContain("AddComponent<OneLobbyMenu>()");
    for (const e of ["GameStarted", "ReturnedToLobby", "Left"]) expect(boot).toContain(`_menu.${e} +=`);
    expect(boot).toContain('_status = "In game: "');
    expect(text("my-game/Assets/OneLobby/Tests/OneLobbyGame.Tests.asmdef")).toContain('"references": ["OneLobby.Unity", "UnityEngine.TestRunner", "UnityEditor.TestRunner"]');
    expect(text("my-game/Assets/OneLobby/Tests/MultiplayerTests.cs")).toContain("MULTIPLAYER_OK");
    expect(tree(at("my-game")).filter((f) => f.endsWith(".unity"))).toEqual([]);
    expect(text("my-game/.gitignore")).toContain("/[Ll]ibrary/");
    expect(text("my-game/.gitignore")).toMatch(/^\.onelobby\/$/m); // the line verify looks for (its scratch folder)
    // the roster line a log can be searched for, and no menu while a play-mode test plays its own scene
    expect(boot).toContain('Debug.Log("Lobby: " + count + " players: "');
    expect(boot).toContain('StartsWith("InitTestScene"');
    expect(text("my-game/.gitattributes")).toMatch(/^\* text=auto\n/);
  });

  it("the play entry builds, then runs host and joiner with --local, in both shells", async () => {
    await j(["my-game", ...NEW]);
    const { entries } = JSON.parse(text("my-game/.olc/my-game.json"));
    expect(entries.map((e) => [e.name, e.shell, e.play])).toEqual([["my-game-play", "powershell", true], ["my-game-play-bash", "bash", true]]);
    for (const e of entries) {
      expect(e.command).toContain("-executeMethod OneLobbyBuild.Windows");
      expect(e.command).toContain(e.shell === "powershell" ? "'--host','--local','--name=Host'" : "--host --local --name=Host");
      expect(e.command).toContain("--local --name=Joiner");
      // the joiner takes no fixed port (another match on the PC may hold it) and nothing waits on the clock
      expect(e.command).not.toMatch(/--join|47810|sleep|Start-Sleep/i);
      expect(e.label).toContain("type the host's code");
      expect(e.command).not.toMatch(/[A-Z]:[\\/]/); // no machine path
    }
    expect(text("my-game/AGENTS.md")).toContain("--host --local --name=Sam");
  });

  it("without --package-from the manifest names the release tarball for Packages/ and says to put it there", async () => {
    const r = await j(["my-game", "--template", "unity", "--yes", "--no-git"]);
    expect(r.json.package).toMatchObject({ value: "file:com.onelobby.unity-0.8.0.tgz", from: "default" });
    expect(r.json.next.join("\n")).toContain("Packages/com.onelobby.unity-0.8.0.tgz");
  });

  it("no editor found: the default version, and the reason is said", async () => {
    const r = await j(["my-game", ...NEW], { found: null });
    expect(r.json.editor).toEqual({ version: "6000.2.7f2", from: "default" });
    expect(text("my-game/ProjectSettings/ProjectVersion.txt")).toBe("m_EditorVersion: 6000.2.7f2\n");
    expect((await cli(["other", ...NEW], { found: null })).out).toContain("no Unity editor found");
  });

  it("--dry-run writes nothing; a missing tarball is a clear error; a non-empty folder is refused", async () => {
    expect((await j(["my-game", ...NEW, "--dry-run"])).json.dryRun).toBe(true);
    expect(existsSync(at("my-game"))).toBe(false);
    expect((await j(["my-game", "--template", "unity", "--yes", "--package-from", "nope.tgz"])).json.error.code).toBe("bad_package_from");
    put("full/x.txt");
    expect((await j(["full", ...NEW])).json.error.code).toBe("dir_not_empty");
  });
});

const MANIFEST = `{
  "dependencies": {
    "com.unity.ide.rider": "3.0.31",
    "com.unity.modules.ui": "1.0.0"
  },
  "scopedRegistries": [{ "name": "x", "url": "https://example.com", "scopes": ["com.x"] }],
  "testables": []
}
`;

describe("unity --into", () => {
  const into = (extra = []) => j(["--into", "game", "--template", "unity", "--yes", "--package-from", "com.onelobby.unity-0.7.9-ci.3.tgz", ...extra]);
  beforeEach(() => {
    put("game/ProjectSettings/ProjectVersion.txt", "m_EditorVersion: 6000.0.30f1\n");
    put("game/Packages/manifest.json", MANIFEST);
    put("game/Assets/Main.cs", "class Main {}\n");
  });

  it("adds the pieces, edits only what it adds in the manifest, and writes no boot script, scene or AGENTS.md", async () => {
    const r = await into();
    expect(r.code).toBe(0);
    expect(r.json.files.sort()).toEqual(["Assets/OneLobby/Editor/BuildPlayer.cs", "Assets/OneLobby/Tests/MultiplayerTests.cs", "Assets/OneLobby/Tests/OneLobbyGame.Tests.asmdef", "Assets/Resources/onelobby.json", "Packages/manifest.json", ".gitignore", ".gitattributes"].sort());
    expect(r.json.files.some((f) => f.startsWith(".olc"))).toBe(false); // an existing project has its own build: no entry that assumes OneLobbyBuild.Windows
    expect(r.json.next.join("\n")).toContain("no .olc entry was written");
    expect(r.json.manifest.added).toEqual(["com.onelobby.unity", "com.unity.test-framework", ...["imgui", "uielements", "audio", "jsonserialize", "unitywebrequest", "physics", "imageconversion", "screencapture"].map((m) => `com.unity.modules.${m}`)]);
    const after = text("game/Packages/manifest.json");
    // every old line is still there, byte for byte, in order
    const old = MANIFEST.split("\n");
    expect(after.split("\n").filter((l) => old.includes(l) || old.includes(l.replace(/,$/, ""))).length).toBeGreaterThanOrEqual(old.length - 1);
    expect(after).toContain('"scopedRegistries": [{ "name": "x", "url": "https://example.com", "scopes": ["com.x"] }],');
    expect(after).toContain('    "com.unity.modules.ui": "1.0.0",\n    "com.onelobby.unity": "file:../../com.onelobby.unity-0.7.9-ci.3.tgz",');
    expect(text("game/ProjectSettings/ProjectVersion.txt")).toBe("m_EditorVersion: 6000.0.30f1\n");
    expect(existsSync(at("game/Assets/Scripts/Boot.cs"))).toBe(false);
    expect(existsSync(at("game/AGENTS.md"))).toBe(false);
    expect(r.json.next.join("\n")).toContain('new GameObject("Menu").AddComponent<OneLobbyMenu>()');
  });

  it("a second run changes nothing", async () => {
    await into();
    const snapshot = tree(at("game")).map((f) => [f, text("game", f)]);
    const again = await into();
    expect(again.json).toMatchObject({ changed: false, files: [] });
    expect(tree(at("game")).map((f) => [f, text("game", f)])).toEqual(snapshot);
  });

  it("a game that already references the package keeps its line, and the run says so", async () => {
    put("game/Packages/manifest.json", MANIFEST.replace('"com.unity.ide.rider"', '"com.onelobby.unity": "0.6.0",\n    "com.unity.ide.rider"'));
    const r = await into();
    expect(readDependency(text("game/Packages/manifest.json"), "com.onelobby.unity")).toBe("0.6.0");
    expect(r.json.notes.join(" ")).toContain("already references com.onelobby.unity 0.6.0, not");
    expect(r.json.notes.join(" ")).toContain("that line was NOT moved");
  });

  it("refuses a manifest it cannot edit, and a project with no manifest, before writing anything", async () => {
    put("game/Packages/manifest.json", '{ "dependencies": ');
    expect((await into()).json.error.code).toBe("bad_manifest");
    expect(existsSync(at("game/Assets/Resources"))).toBe(false);
    rmSync(at("game/Packages"), { recursive: true });
    expect((await into()).json.error.message).toContain("no Packages/manifest.json");
    put("plain/readme.txt");
    expect((await j(["--into", "plain", "--template", "unity", "--yes"])).json.error.code).toBe("not_unity_project");
  });

  it("keeps a blueprint the game already has, and does not touch the game's own files", async () => {
    put("game/Assets/Resources/onelobby.json", '{ "game": { "id": "com.mine.game" } }');
    const r = await into();
    expect(r.json.skipped).toEqual(["Assets/Resources/onelobby.json"]);
    expect(text("game/Assets/Resources/onelobby.json")).toBe('{ "game": { "id": "com.mine.game" } }');
    expect(text("game/Assets/Main.cs")).toBe("class Main {}\n");
  });
});

describe("the manifest edit", () => {
  const wanted = [{ name: "com.onelobby.unity", value: "file:x.tgz" }, { name: "com.unity.modules.ui", value: "1.0.0" }];
  it("adds once, in the last entry's indentation, and keeps everything else", () => {
    const r = addDependencies(MANIFEST, wanted, "m");
    expect(r.added).toEqual(["com.onelobby.unity"]);
    expect(r.present).toEqual([{ name: "com.unity.modules.ui", value: "1.0.0" }]);
    expect(r.text).toBe(MANIFEST.replace('"com.unity.modules.ui": "1.0.0"\n', '"com.unity.modules.ui": "1.0.0",\n    "com.onelobby.unity": "file:x.tgz"\n'));
    expect(addDependencies(r.text, wanted, "m")).toMatchObject({ changed: false, text: r.text });
  });
  it("keeps CRLF and a BOM", () => {
    const crlf = "\ufeff" + MANIFEST.replace(/\n/g, "\r\n");
    const r = addDependencies(crlf, wanted, "m");
    expect(r.text.startsWith("\ufeff{\r\n")).toBe(true);
    expect(r.text).not.toMatch(/[^\r]\n/);
    expect(JSON.parse(r.text.slice(1)).dependencies["com.onelobby.unity"]).toBe("file:x.tgz");
  });
  it("handles an empty and a one-line dependencies object", () => {
    expect(addDependencies('{\n  "dependencies": {}\n}\n', wanted.slice(0, 1), "m").text).toBe('{\n  "dependencies": {\n    "com.onelobby.unity": "file:x.tgz"\n  }\n}\n');
    expect(addDependencies('{"dependencies": {"a": "1"}}', wanted.slice(0, 1), "m").text).toBe('{"dependencies": {"a": "1", "com.onelobby.unity": "file:x.tgz"}}');
  });
  it("refuses what it cannot edit safely", () => {
    for (const bad of ["", "{", "[]", "{}", '{"dependencies": []}', '{"dependencies": {"a": "1", "a": "2"}}', '{"dependencies": {"a": "1"}} x']) expect(() => inspectManifest(bad, "m"), bad).toThrow(/not a manifest this tool can edit safely/);
  });
  it("moves only the value of one dependency, and keeps a file: line it is not asked about", () => {
    const m = MANIFEST.replace('"com.unity.ide.rider": "3.0.31"', '"com.onelobby.unity": "0.6.0"');
    const r = moveDependency(m, "com.onelobby.unity", "0.7.2", "m");
    expect(r).toMatchObject({ changed: true, from: "0.6.0" });
    expect(r.text).toBe(m.replace('"0.6.0"', '"0.7.2"'));
    expect(moveDependency(r.text, "com.onelobby.unity", "0.7.2", "m").changed).toBe(false);
    expect(moveDependency(MANIFEST, "com.onelobby.unity", "0.7.2", "m")).toMatchObject({ changed: false, from: null });
  });
});

describe("unity update", () => {
  const mk = (value) => {
    put("g/ProjectSettings/ProjectVersion.txt", "m_EditorVersion: 6000.0.30f1\n");
    put("g/Packages/manifest.json", `{\n  "dependencies": {\n    "com.onelobby.unity": ${JSON.stringify(value)},\n    "com.unity.modules.ui": "1.0.0"\n  }\n}\n`);
  };
  const upd = (extra = []) => j(["update", "g", ...extra]);

  it("moves a version number to this version, only that value", async () => {
    mk("0.6.0");
    const before = text("g/Packages/manifest.json");
    const r = await upd();
    expect(r.json).toMatchObject({ ok: true, template: "unity", changed: true, package: { from: "0.6.0", to: "0.8.0", action: "move" } });
    expect(text("g/Packages/manifest.json")).toBe(before.replace('"0.6.0"', '"0.8.0"'));
    expect(r.json.next.join(" ")).toContain("open the project in Unity");
  });
  it("--dry-run shows the edit and writes nothing", async () => {
    mk("0.6.0");
    const before = text("g/Packages/manifest.json");
    const r = await cli(["update", "g", "--dry-run"]);
    expect(r.out).toContain("Dry run: nothing written.");
    expect(r.out).toContain("0.6.0 -> 0.8.0");
    expect(text("g/Packages/manifest.json")).toBe(before);
  });
  it("nothing to do when it is current", async () => {
    mk("0.8.0");
    const r = await upd();
    expect(r.json).toMatchObject({ current: true, changed: false, package: { action: "current" } });
  });
  it("leaves a file: line somebody wrote alone, unless --package-from is given", async () => {
    mk("file:C:/somewhere/pkg.tgz");
    const left = await upd();
    expect(left.json.package).toMatchObject({ action: "left" });
    expect(text("g/Packages/manifest.json")).toContain("file:C:/somewhere/pkg.tgz");
    const moved = await upd(["--package-from", "com.onelobby.unity-0.7.9-ci.3.tgz"]);
    expect(moved.json.package).toMatchObject({ action: "move", to: "file:../../com.onelobby.unity-0.7.9-ci.3.tgz" });
  });
  it("moves the line this tool writes (a tarball named after the version beside the manifest) and warns when it is not there", async () => {
    mk("file:com.onelobby.unity-0.6.0.tgz");
    const r = await upd();
    expect(r.json.package).toMatchObject({ action: "move", to: "file:com.onelobby.unity-0.8.0.tgz" });
    expect(r.json.warning).toContain("Packages/com.onelobby.unity-0.8.0.tgz is not there yet");
  });
  it("a project that does not reference the package stops with the command to add it", async () => {
    put("g/ProjectSettings/ProjectVersion.txt", "x");
    put("g/Packages/manifest.json", '{"dependencies":{}}');
    expect((await upd()).json.error.code).toBe("no_package");
  });
  it("decide: the cases in one table", () => {
    const ref = { value: "file:com.onelobby.unity-0.7.2.tgz", file: "com.onelobby.unity-0.7.2.tgz", version: "0.7.2" };
    expect(decide({ current: "git+https://x/y.git", ref, explicit: false }).action).toBe("left");
    expect(decide({ current: "0.7.2", ref, explicit: false }).action).toBe("current");
    expect(decide({ current: "file:other.tgz", ref, explicit: true })).toEqual({ action: "move", to: ref.value });
  });
});

describe("the editor", () => {
  it("reads and orders Unity versions", () => {
    expect(parseEditorVersion("6000.2.7f2")).toEqual([6000, 2, 7, "f", 2]);
    expect(parseEditorVersion("2022.3.1f1")[0]).toBe(2022);
    expect(parseEditorVersion("banana")).toBeNull();
    expect(compareEditors("6000.2.7f2", "6000.2.10f1")).toBe(-1);
    expect(compareEditors("6000.0.0b1", "6000.0.0f1")).toBe(-1);
    expect(editorIsNewEnough("6000.0.1f1")).toBe(true);
    expect(editorIsNewEnough("2022.3.50f1")).toBe(false);
  });
  it("the Hub's folder is searched, newest first, and the version the project names wins when installed", () => {
    const list = () => ["6000.0.30f1", "6000.2.7f2", "junk"];
    const eds = hubEditors({ env: { ProgramFiles: "P" }, platform: "win32", list });
    expect(eds.map((e) => e.version)).toEqual(["6000.2.7f2", "6000.0.30f1"]);
    const exists = () => true;
    expect(resolveUnity({ env: { ProgramFiles: "P" }, platform: "win32", list, exists, run: () => "" }).version).toBe("6000.2.7f2");
    expect(resolveUnity({ env: { ProgramFiles: "P" }, platform: "win32", list, exists, run: () => "", wantVersion: "6000.0.30f1" }).version).toBe("6000.0.30f1");
    expect(resolveUnity({ flag: "nope", env: {}, exists: () => false })).toMatchObject({ missing: "nope", from: "--unity" });
    expect(resolveUnity({ env: { UNITY: "u" }, exists: () => true, run: () => "" }).from).toBe("$UNITY");
  });
  it("chooseEditor falls back to the tested version, and says why", () => {
    expect(chooseEditor({ opts: {}, env: {}, resolve: () => null })).toMatchObject({ version: "6000.2.7f2", from: "default", why: "no Unity editor found" });
    expect(chooseEditor({ opts: {}, env: {}, resolve: () => ({ exe: "e", version: "2022.3.1f1", from: "$UNITY" }) }).why).toContain("not Unity 6000.0 or newer");
  });
});

// ---- verify -------------------------------------------------------------------------------------------------------------

const names = (checks) => checks.map((c) => c.name);
describe("unity verify: the checks", () => {
  it("run in the order of the other engines, and a failed unity or package check blocks the rest", () => {
    const checks = unityChecks();
    expect(names(checks)).toEqual(["unity", "package", "blueprint", "wiring", "direct", "nostr", "turn", "server"]);
    expect(checks.filter((c) => c.blocking).map((c) => c.name)).toEqual(["unity", "package", "blueprint"]);
  });

  const scaffold = async () => {
    await j(["my-game", ...NEW]);
    return at("my-game");
  };
  const ctxFor = (dir, extra = {}) => ({ dir, opts: {}, env: {}, services: {}, kind: "unity", ...extra });

  it("no editor found, and an editor that is too old, fail the first check with the next step", async () => {
    const dir = await scaffold();
    const none = await runChecks(unityChecks(), ctxFor(dir, { resolveUnity: () => null }));
    expect(none.verdict).toMatch(/^VERIFY_FAIL unity: no Unity editor found .*Pass --unity/);
    expect(none.results.slice(1).every((r) => r.status === "skipped")).toBe(true);
    const old = await runChecks(unityChecks(), ctxFor(dir, { resolveUnity: () => ({ exe: "e", version: "2022.3.1f1", from: "--unity" }) }));
    expect(old.verdict).toContain("VERIFY_FAIL unity: Unity 2022.3.1f1 is older than 6000.0");
    const missing = await runChecks(unityChecks(), ctxFor(dir, { opts: { unity: "x" }, resolveUnity: () => ({ missing: "x", from: "--unity" }) }));
    expect(missing.verdict).toContain("--unity names x, which does not exist");
  });

  it("package: a manifest without the package, or a tarball that is not there, fails with the command to fix it", async () => {
    const dir = await scaffold();
    const ok = { resolveUnity: () => ({ exe: "e", version: "6000.2.7f2", from: "$UNITY" }), run: async () => ({ code: 0, out: "" }) };
    writeFileSync(join(dir, "Packages/manifest.json"), '{"dependencies":{}}');
    expect((await runChecks(unityChecks(), ctxFor(dir, ok))).verdict).toContain("VERIFY_FAIL package: Packages/manifest.json does not reference com.onelobby.unity");
    writeFileSync(join(dir, "Packages/manifest.json"), '{"dependencies":{"com.onelobby.unity":"file:com.onelobby.unity-0.7.2.tgz"}}');
    expect((await runChecks(unityChecks(), ctxFor(dir, ok))).verdict).toContain("Packages/com.onelobby.unity-0.7.2.tgz is not there");
  });

  it("every check passes against fake Unity runs; the verdict is VERIFY_OK and each route runs the test with its own arguments", async () => {
    const dir = await scaffold();
    const seen = [];
    writeFileSync(join(dir, "Packages/packages-lock.json"), JSON.stringify({ dependencies: { "com.onelobby.unity": { version: "file:x", source: "local-tarball" } } }));
    const run = async (cmd, args) => {
      seen.push(args);
      const route = args.find((a) => a.startsWith("--route="))?.slice(8);
      const log = args[args.indexOf("-logFile") + 1];
      mkdirSync(join(log, ".."), { recursive: true });
      writeFileSync(log, route ? (route === "config" ? "MULTIPLAYER_OK config sync=lockstep direct=true nostr=true server=false relay_only=false\n" : route === "direct" ? "MULTIPLAYER_OK\n" : `MULTIPLAYER_OK ${route} code=1\n`) : "ok\n");
      return { code: 0, out: "" };
    };
    const ctx = ctxFor(dir, { resolveUnity: () => ({ exe: "unity.exe", version: "6000.2.7f2", from: "$UNITY" }), run, services: { relay: { url: "ws://127.0.0.1:1", stats: { events: 0 }, close: async () => {} } } });
    ctx.services.relay.stats = new Proxy({ events: 0 }, { get: (t, k) => (k === "events" ? t.events++ : t[k]) }); // the fake relay "sees" events on each read
    const out = await runChecks(unityChecks(), ctx);
    const byName = Object.fromEntries(out.results.map((r) => [r.name, r.status]));
    expect(byName).toMatchObject({ unity: "ok", package: "ok", blueprint: "ok", wiring: "ok", direct: "ok", nostr: "ok", turn: "skipped", server: "skipped" });
    expect(out.verdict).toBe("VERIFY_OK");
    const routes = seen.map((a) => a.find((x) => x.startsWith("--route="))).filter(Boolean);
    expect(routes).toEqual(["--route=config", "--route=direct", "--route=nostr"]);
    expect(seen[0]).toEqual(expect.arrayContaining(["-batchmode", "-nographics", "-quit"]));
    expect(seen[1]).toEqual(expect.arrayContaining(["-runTests", "-testPlatform", "PlayMode", "-assemblyNames", "OneLobbyGame.Tests"]));
    for (const a of seen.slice(1)) expect(a).toContain("--local"); // every test run: a menu the game's own start-up opens stays on 127.0.0.1
    expect(seen[0]).not.toContain("--local");
    expect(out.results.filter((r) => r.name === "direct" || r.name === "nostr").some((r) => r.warning)).toBe(false); // exit code 0: nothing to say
  });

  it("a test that passed in a Unity that then ended with a crash code is ok with a warning, not a failure", async () => {
    const dir = await scaffold();
    writeFileSync(join(dir, "Packages/packages-lock.json"), JSON.stringify({ dependencies: { "com.onelobby.unity": { version: "x", source: "local-tarball" } } }));
    const run = async (cmd, args) => {
      const route = args.find((a) => a.startsWith("--route="))?.slice(8);
      const log = args[args.indexOf("-logFile") + 1];
      mkdirSync(join(log, ".."), { recursive: true });
      writeFileSync(log, route ? (route === "config" ? "MULTIPLAYER_OK config sync=raw direct=true nostr=true server=false relay_only=false\n" : route === "direct" ? "MULTIPLAYER_OK\n" : `MULTIPLAYER_OK ${route} code=1\n`) : "ok\n");
      return { code: route === "direct" ? 3221225477 : 0, out: "" };
    };
    const relay = { url: "ws://127.0.0.1:1", stats: new Proxy({ events: 0 }, { get: (t, k) => (k === "events" ? t.events++ : t[k]) }), close: async () => {} };
    const out = await runChecks(unityChecks(), ctxFor(dir, { resolveUnity: () => ({ exe: "unity.exe", version: "6000.2.7f2", from: "$UNITY" }), run, services: { relay } }));
    expect(out.verdict).toBe("VERIFY_OK");
    const direct = out.results.find((r) => r.name === "direct");
    expect(direct).toMatchObject({ status: "ok", warning: exitWarning(3221225477) });
    expect(direct.warning).toContain("exit code 3221225477 (0xC0000005)");
    expect(out.results.find((r) => r.name === "nostr")).not.toHaveProperty("warning");
    expect(exitWarning(1)).toBe("the test passed, then Unity ended with exit code 1 while it closed");
  });

  it("direct: a host the test started that listens beyond 127.0.0.1 fails the check naming the address; loopback passes and says what was seen; an unreadable table is said", async () => {
    const dir = await scaffold();
    writeFileSync(join(dir, "Packages/packages-lock.json"), JSON.stringify({ dependencies: { "com.onelobby.unity": { version: "x", source: "local-tarball" } } }));
    const withSockets = (sockets) => async (cmd, args) => {
      const route = args.find((a) => a.startsWith("--route="))?.slice(8);
      const log = args[args.indexOf("-logFile") + 1];
      mkdirSync(join(log, ".."), { recursive: true });
      writeFileSync(log, route === "config" ? "MULTIPLAYER_OK config sync=raw direct=true nostr=false server=false relay_only=false\n" : route ? "MULTIPLAYER_OK\n" : "ok\n");
      return { code: 0, out: "", ...(route === "direct" ? { sockets } : {}) };
    };
    const ctx = (sockets) => ctxFor(dir, { resolveUnity: () => ({ exe: "unity.exe", version: "6000.2.7f2", from: "$UNITY" }), run: withSockets(sockets) });
    const checks = () => unityChecks().filter((c) => ["unity", "package", "blueprint", "wiring", "direct"].includes(c.name)); // the routes that start a host: direct
    const L = (proto, addr, port) => ({ proto, addr, port, pid: 9 });
    const seen = (listeners, extra = {}) => ({ samples: 5, listeners, wide: listeners.filter((l) => l.addr === "0.0.0.0" || l.addr === "::"), error: null, ...extra });
    const bad = await runChecks(checks(), ctx(seen([L("tcp", "0.0.0.0", 47810), L("udp", "0.0.0.0", 47810), L("tcp", "127.0.0.1", 38000)])));
    expect(bad.verdict).toMatch(/^VERIFY_FAIL direct: .*listened beyond 127\.0\.0\.1: TCP 0\.0\.0\.0:47810 \(pid 9\), UDP 0\.0\.0\.0:47810 \(pid 9\)/);
    const good = await runChecks(checks(), ctx(seen([L("tcp", "127.0.0.1", 38000), L("udp", "127.0.0.1", 38000)])));
    expect(good.verdict).toBe("VERIFY_OK");
    expect(good.results.find((r) => r.name === "direct").detail).toContain("no TCP+UDP host pair beyond 127.0.0.1");
    const blind = await runChecks(checks(), ctx(seen([], { samples: 0, error: "no socket table reader for darwin" })));
    expect(blind.verdict).toBe("VERIFY_OK");
    expect(blind.results.find((r) => r.name === "direct").warning).toContain("bound addresses NOT checked");
  });

  it("a compile error is named by its own line, not by Unity's summary line", () => {
    const log = "x\nAssets\\Scripts\\Boot.cs(19,20): error CS0029: Cannot implicitly convert type 'string' to 'int'\nmore\nScripts have compiler errors.\n";
    expect(lastError(log)).toBe("Assets\\Scripts\\Boot.cs(19,20): error CS0029: Cannot implicitly convert type 'string' to 'int'");
    expect(lastError("a\nScripts have compiler errors.\n")).toBe("Scripts have compiler errors");
    expect(lastError("nothing")).toBe("no error text");
  });

  it("a failing route names the check and the reason; a missing test file fails with the --into command", async () => {
    const dir = await scaffold();
    writeFileSync(join(dir, "Packages/packages-lock.json"), JSON.stringify({ dependencies: { "com.onelobby.unity": { version: "x", source: "local-tarball" } } }));
    const run = async (cmd, args) => {
      const route = args.find((a) => a.startsWith("--route="))?.slice(8);
      const log = args[args.indexOf("-logFile") + 1];
      mkdirSync(join(log, ".."), { recursive: true });
      writeFileSync(log, route === "direct" ? "MULTIPLAYER_FAIL the two peers never linked\n" : route ? "MULTIPLAYER_OK config sync=raw direct=true nostr=false server=false relay_only=false\n" : "ok\n");
      return { code: route === "direct" ? 2 : 0, out: "" };
    };
    const ctx = ctxFor(dir, { resolveUnity: () => ({ exe: "unity.exe", version: "6000.2.7f2", from: "$UNITY" }), run });
    expect((await runChecks(unityChecks(), ctx)).verdict).toMatch(/^VERIFY_FAIL direct: two peers on 127.0.0.1 did not connect: the two peers never linked/);
    rmSync(join(dir, "Assets/OneLobby"), { recursive: true });
    const noTest = await runChecks(unityChecks(), { ...ctx, facts: undefined, services: {} });
    expect(noTest.verdict).toContain("VERIFY_FAIL direct: Assets/OneLobby/Tests/MultiplayerTests.cs / .asmdef is missing");
    expect(noTest.verdict).toContain("npx create-onelobby --into .");
  });
});

// A real .tgz: a ustar header per name (an empty body), so the package check has something to list.
const tgz = (names) => {
  const blocks = names.map((name) => {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write("0000644 ", 100);
    h.write("00000000000 ", 124);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar " + "00", 257);
    h.write(`${[...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}  `, 148);
    return h;
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
};
const LIB = "package/Runtime/Plugins/x86_64/datachannel.dll";

describe("unity verify: the Windows WebRTC library in the package", () => {
  it("lists the names of a tarball", () => {
    expect(tgzNames(tgz(["package/package.json", LIB]))).toEqual(["package/package.json", LIB]);
    expect(tgzNames(tgz([]))).toEqual([]);
  });

  it("packageHasWindowsLibrary: a tarball, a folder, a missing file and one it cannot read", () => {
    const dir = at("game");
    mkdirSync(join(dir, "Packages"), { recursive: true });
    writeFileSync(join(dir, "Packages", "with.tgz"), tgz(["package/package.json", LIB]));
    writeFileSync(join(dir, "Packages", "without.tgz"), tgz(["package/package.json", "package/Runtime/Plugins/x86_64/libdatachannel.so"]));
    writeFileSync(join(dir, "Packages", "junk.tgz"), "x");
    expect(packageHasWindowsLibrary(dir, "file:with.tgz").has).toBe(true);
    expect(packageHasWindowsLibrary(dir, "file:without.tgz").has).toBe(false);
    expect(packageHasWindowsLibrary(dir, "file:junk.tgz").has).toBeNull();
    expect(packageHasWindowsLibrary(dir, "file:gone.tgz").has).toBeNull();
    mkdirSync(join(dir, "pkg/Runtime/Plugins/x86_64"), { recursive: true });
    expect(packageHasWindowsLibrary(dir, `file:${join(dir, "pkg")}`).has).toBe(false);
    writeFileSync(join(dir, "pkg/Runtime/Plugins/x86_64/datachannel.dll"), "x");
    expect(packageHasWindowsLibrary(dir, `file:${join(dir, "pkg")}`).has).toBe(true);
    expect(packageHasWindowsLibrary(dir, "0.7.2").has).toBeNull(); // a registry version Unity has not unpacked
    mkdirSync(join(dir, "Library/PackageCache/com.onelobby.unity@abc/Runtime/Plugins/x86_64"), { recursive: true });
    expect(packageHasWindowsLibrary(dir, "0.7.2").has).toBe(false);
  });

  const scaffold = async () => {
    await j(["my-game", ...NEW]);
    return at("my-game");
  };
  const editor = { resolveUnity: () => ({ exe: "e", version: "6000.2.7f2", from: "$UNITY" }) };

  it("verify fails the package check, before any Unity run, when the tarball has no datachannel.dll, and names the fix", async () => {
    const dir = await scaffold();
    const tarball = "com.onelobby.unity-0.7.9-ci.3.tgz"; // the manifest points at it, one folder above the game
    writeFileSync(at(tarball), tgz(["package/package.json", "package/Runtime/Plugins/OneLobby.Core.dll"]));
    let ran = 0;
    const out = await runChecks(unityChecks(), { dir, opts: {}, env: {}, services: {}, kind: "unity", platform: "win32", ...editor, run: async () => (ran++, { code: 0, out: "" }) });
    expect(ran).toBe(0);
    expect(out.verdict).toContain("VERIFY_FAIL package:");
    expect(out.verdict).toContain("has no Runtime/Plugins/x86_64/datachannel.dll (the Windows WebRTC library)");
    expect(out.verdict).toContain("clients/unity/fetch-natives.sh");
    expect(out.verdict).toContain("clients/unity/build-unity-package.sh --pack");
    expect(out.verdict).toContain(`${JSON.parse(readFileSync(join(dir, "Packages/manifest.json"), "utf8")).dependencies["com.onelobby.unity"].slice(5)} (the path in Packages/manifest.json`);
    expect(out.results.slice(2).every((r) => r.status === "skipped")).toBe(true); // no peers were started
  });

  it("a tarball that has it passes that part and goes on to open the project; another platform is not checked", async () => {
    const dir = await scaffold();
    const tarball = "com.onelobby.unity-0.7.9-ci.3.tgz";
    writeFileSync(at(tarball), tgz(["package/package.json", LIB]));
    writeFileSync(join(dir, "Packages/packages-lock.json"), JSON.stringify({ dependencies: { "com.onelobby.unity": { version: "x", source: "local-tarball" } } }));
    const opened = [];
    const run = async (cmd, args) => (opened.push(args), { code: 0, out: "" });
    const ctx = { dir, opts: {}, env: {}, services: {}, kind: "unity", platform: "win32", ...editor, run };
    const out = await runChecks([unityChecks()[0], unityChecks()[1]], ctx);
    expect(out.results.find((r) => r.name === "package").status).toBe("ok");
    expect(opened.length).toBe(1);
    writeFileSync(at(tarball), tgz(["package/package.json"]));
    const mac = await runChecks([unityChecks()[0], unityChecks()[1]], { ...ctx, platform: "darwin" });
    expect(mac.results.find((r) => r.name === "package").status).toBe("ok");
  });
});

describe("unity verify: the wiring check", () => {
  const wiring = (dir) => wiringCheck().run({ dir, kind: "unity" });
  it("a scaffolder-written project passes untouched; a bare --into fails until the game uses the menu", async () => {
    await j(["my-game", ...NEW]);
    expect((await wiring(at("my-game"))).status).toBe("ok");
    put("game/ProjectSettings/ProjectVersion.txt", "x");
    put("game/Packages/manifest.json", '{"dependencies":{}}');
    put("game/Assets/Main.cs", "class Main { }\n");
    await j(["--into", "game", "--template", "unity", "--yes"]);
    const bare = await wiring(at("game"));
    expect(bare.status).toBe("fail");
    expect(bare.detail).toContain("no script outside Packages/ and Assets/OneLobby/");
    expect(bare.next).toContain("AddComponent<OneLobbyMenu>()");
    put("game/Assets/Main.cs", 'class Main { void Awake() { new GameObject("Menu").AddComponent<OneLobbyMenu>(); } }\n');
    expect((await wiring(at("game"))).status).toBe("ok");
  });
  it("the scaffolder's own test and build files do not count, and neither does the package folder", async () => {
    put("game2/Assets/OneLobby/Tests/MultiplayerTests.cs", "class T { LobbyClient c; }\n");
    put("game2/Library/PackageCache/x/Menu.cs", "class OneLobbyMenu {}\n");
    put("game2/Packages/p/Menu.cs", "class OneLobbyMenu {}\n");
    expect((await wiring(at("game2"))).status).toBe("fail");
  });
  const unityGame = (name, ui = "drop-in") => {
    put(`${name}/Assets/Resources/onelobby.json`, JSON.stringify({ ui: { kind: ui } }));
    return at(name);
  };
  it("a game that only names the runner and the client (its own Setup page, no menu built) fails, and names those files", async () => {
    const dir = unityGame("runner-only");
    put("runner-only/Assets/Net/Session.cs", "using OneLobby.Unity;\nclass Session { OneLobbyRunner runner; LobbyClient client; void Awake() { runner = gameObject.AddComponent<OneLobbyRunner>(); } }\n");
    put("runner-only/Assets/Tests/ProbeTests.cs", "class P { OneLobbyMenu menu; void Make() { /* AddComponent<OneLobbyMenu>() lives in another file */ } }\n");
    const r = await wiring(dir);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("builds the drop-in menu");
    expect(r.detail).toContain("Assets/Net/Session.cs");
    expect(r.detail).toContain("the runner or the client only");
    expect(r.next).toContain("AddComponent<OneLobbyMenu>()");
  });
  it("building the menu counts: AddComponent, AddComponent(typeof(...)), Instantiate<...>, or a scene or prefab that holds the component", async () => {
    for (const [i, code] of ["go.AddComponent<OneLobbyMenu>();", "go.AddComponent(typeof(OneLobbyMenu));", "Instantiate<OneLobbyMenu>(prefab);"].entries()) {
      const dir = unityGame(`builds-${i}`);
      put(`builds-${i}/Assets/Game/Start.cs`, `class Start { void Awake() { ${code} } }\n`);
      const r = await wiring(dir);
      expect(r.status, code).toBe("ok");
      expect(r.detail).toContain("builds the drop-in menu");
    }
    const scene = unityGame("in-scene");
    put("in-scene/Assets/Scenes/Main.unity", "MonoBehaviour:\n  m_Script: {fileID: 11500000, guid: cbe34bd5e4d6f3845943d8e150050af8, type: 3}\n");
    const r = await wiring(scene);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("Assets/Scenes/Main.unity");
    const other = unityGame("other-script");
    put("other-script/Assets/Scenes/Main.unity", "MonoBehaviour:\n  m_Script: {fileID: 11500000, guid: 0123456789abcdef0123456789abcdef, type: 3}\n");
    expect((await wiring(other)).status).toBe("fail");
  });
  it("a mention in a comment is not a built menu", async () => {
    const dir = unityGame("comment-only");
    put("comment-only/Assets/Game/Start.cs", "// go.AddComponent<OneLobbyMenu>();\n/* AddComponent<OneLobbyMenu>() */\nclass Start { }\n");
    expect((await wiring(dir)).status).toBe("fail");
  });
  it("ui.kind none or generated (a game with its own screens on purpose) is satisfied by the runner or the client", async () => {
    const dir = unityGame("own-ui", "none");
    put("own-ui/Assets/Net/Session.cs", "class Session { OneLobbyRunner runner; }\n");
    const r = await wiring(dir);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("ui.kind none");
    expect((await wiring(unityGame("own-ui-bare", "none"))).status).toBe("fail");
  });
});
