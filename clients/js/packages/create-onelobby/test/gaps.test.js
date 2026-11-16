// --into reads the folder, the wiring check, web --into's package.json and Next lines, the help text, a kept onelobby.json.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";
import { fixtureNativesZip } from "./helpers/zip.js";
import { blueprintNext, wiringCheck } from "../src/verify/wiring.js";
import { runChecks } from "../src/verify/core.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-gaps-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

async function cli(args, { tty = false, input = "" } = {}) {
  let out = "";
  let err = "";
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, stdin: Readable.from([input]), stdinIsTTY: tty, env: {}, cwd };
  const code = await main(args, io);
  return { code, out, err, json: out.trim().startsWith("{") ? JSON.parse(out) : undefined };
}
const at = (...p) => join(cwd, ...p);
const put = (path, text = "") => {
  mkdirSync(join(at(path), ".."), { recursive: true });
  writeFileSync(at(path), text);
};

describe("--into without --template reads the folder", () => {
  it("a Unity project is unity, not web, and a dry run writes nothing", async () => {
    put("u/ProjectSettings/ProjectVersion.txt", "m_EditorVersion: 6000.0.1f1\n");
    put("u/Assets/readme.txt");
    put("u/Packages/manifest.json", '{"dependencies":{}}');
    const r = await cli(["--into", "u", "--yes", "--json", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.json.template).toBe("unity");
    expect(readdirSync(at("u")).sort()).toEqual(["Assets", "Packages", "ProjectSettings"]);
  });

  it("ProjectSettings/ beside Assets/ is unity too, and its .sln does not make it dotnet", async () => {
    put("u2/ProjectSettings/x.asset");
    put("u2/Assets/a.txt");
    put("u2/u2.sln");
    put("u2/Packages/manifest.json", '{"dependencies":{}}');
    expect((await cli(["--into", "u2", "--yes", "--json", "--dry-run"])).json.template).toBe("unity");
  });

  it("a .csproj or .sln with no project.godot is dotnet (template_planned)", async () => {
    put("n/App.csproj", "<Project/>");
    expect((await cli(["--into", "n", "--yes", "--json"])).json.error.message).toContain('template "dotnet"');
  });

  it("a folder with web files is web, and the JSON says engine.from is files", async () => {
    put("w/index.html", "<html></html>");
    const r = await cli(["--into", "w", "--yes", "--json", "--dry-run", "--recommend", "a card game for 2 players"]);
    expect(r.code).toBe(0);
    expect(r.json.template).toBe("web");
    expect(r.json.recommendation.engine).toMatchObject({ id: "web", from: "files" });
  });

  it("a folder that is none of these stops with engine_unknown and names --template; --template web still works", async () => {
    put("e/notes.txt", "x");
    const r = await cli(["--into", "e", "--yes", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("engine_unknown");
    expect(r.json.error.message).toContain("--template");
    expect(existsSync(at("e/onelobby.json"))).toBe(false);
    expect((await cli(["--into", "e", "--template", "web", "--yes", "--json"])).code).toBe(0);
  });

  it("an explicit --template beats the files, and a description that names the engine still picks it", async () => {
    put("u3/ProjectSettings/ProjectVersion.txt", "x");
    expect((await cli(["--into", "u3", "--template", "web", "--yes", "--json", "--dry-run"])).json.template).toBe("web");
    put("e2/notes.txt", "x");
    expect((await cli(["--into", "e2", "--yes", "--json", "--recommend", "co-op survival sandbox in MonoGame"])).json.error.message).toContain('template "dotnet"');
  });

  it("on a terminal an unknown folder asks for the engine", async () => {
    put("e3/notes.txt", "x");
    const r = await cli(["--into", "e3", "--json", "--dry-run", "--game-id", "com.example.e3"], { tty: true, input: "\nweb\n" });
    expect(r.json).toMatchObject({ ok: true, template: "web" });
  });
});

describe("web --into", () => {
  it("writes a minimal package.json when there is none, and lists it", async () => {
    put("w/index.html", "<html></html>");
    const r = await cli(["--into", "w", "--yes", "--json"]);
    expect(r.json.files).toEqual(["onelobby.json", "multiplayer/session.js", "test/multiplayer.mjs", "package.json"]);
    const pkg = JSON.parse(readFileSync(at("w/package.json"), "utf8"));
    expect(pkg).toMatchObject({ private: true, type: "module" });
    expect(pkg.dependencies.onelobby).toMatch(/^\^\d+\.\d+\.\d+/);
  });

  it("never edits an existing package.json; the Next lines say what to add when onelobby is missing", async () => {
    put("w/package.json", '{ "name": "mine" }');
    const r = await cli(["--into", "w", "--yes", "--json"]);
    expect(readFileSync(at("w/package.json"), "utf8")).toBe('{ "name": "mine" }');
    expect(r.json.files).not.toContain("package.json");
    const next = r.json.next.join("\n");
    expect(next).toMatch(/npm install onelobby@\^/);
    expect(next).toContain('"type": "module"');
  });

  it("an existing package.json that lists onelobby gets a plain npm install", async () => {
    put("w/package.json", '{ "type": "module", "dependencies": { "onelobby": "^0.7.0" } }');
    const r = await cli(["--into", "w", "--yes", "--json"]);
    expect(r.json.next).toContain("npm install");
    expect(r.json.next.join("\n")).not.toContain("type");
  });

  it("the Next lines come in the order the work happens and use the glue's real names", async () => {
    const r = await cli(["--into", ".", "--template", "web", "--yes", "--json", "--dry-run"]);
    const next = r.json.next;
    const at_ = (re) => next.findIndex((l) => re.test(l));
    const order = [/^npm install/, /step\(tick, commands\)/, /loadBlueprint\(\).*makeKit\(bp, \{ displayName \}\).*kit\.host\(\).*bindSession\(lobby, kit\.blueprint, game\) before lobby\.start\(\)/, /node test\/multiplayer\.mjs/, /^follow /].map(at_);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const glue = readFileSync(new URL("../templates/glue/session.js", import.meta.url), "utf8");
    for (const name of ["loadBlueprint", "makeKit", "bindSession"]) expect(glue).toContain(`export ${name === "loadBlueprint" ? "async " : ""}function ${name}`);
  });

  it("the glue comments say the rule and do not cite an AGENTS.md the game does not have", () => {
    const glue = readFileSync(new URL("../templates/glue/session.js", import.meta.url), "utf8");
    expect(glue).not.toMatch(/AGENTS\.md/);
  });

  it("stops with exists when onelobby.json is kept, and says the recommendation was not applied", async () => {
    put("w/onelobby.json", "mine");
    const r = await cli(["--into", "w", "--template", "web", "--yes", "--json", "--recommend", "a card game in the browser, 2 players"]);
    expect(r.json.error.code).toBe("exists");
    expect(r.json.error.message).toContain("the recommendation was not applied");
    expect(r.json.error.details.recommendation).toMatchObject({ applied: [], notApplied: expect.stringContaining("kept your onelobby.json") });
  });
});

describe("--help", () => {
  it("names the built templates from the list, godot-csharp included", async () => {
    const r = await cli(["--help"]);
    expect(r.out).toContain('"web", "godot-gdscript", "godot-csharp" and "unity" exist; the rest are planned for v2');
  });
});

describe("a second Godot --into --recommend run", () => {
  const FROM = ["--addon-from", "checkout", "--webrtc-zip", "natives.zip", "--yes", "--no-git"];
  const SENTENCE = "co-op survival game for 4 players in Godot";
  beforeEach(() => {
    const a = at("checkout/clients/gdscript/addons/onelobby");
    mkdirSync(join(a, "menu"), { recursive: true });
    writeFileSync(join(a, "client.gd"), "class_name OneLobbyClient\nextends Node\n");
    writeFileSync(join(a, "client.gd.uid"), "uid://abc\n");
    writeFileSync(join(a, "menu/menu.tscn"), "[gd_scene format=3]\n");
    writeFileSync(at("natives.zip"), fixtureNativesZip());
    put("g/project.godot", 'config_version=5\n\n[application]\n\nconfig/name="G"\n');
  });

  it("keeps the hand-edited onelobby.json and says so in one line and in the JSON", async () => {
    const first = await cli(["--into", "g", ...FROM, "--recommend", SENTENCE, "--json"]);
    expect(first.json.recommendation.applied.length).toBeGreaterThan(0);
    const bp = JSON.parse(readFileSync(at("g/onelobby.json"), "utf8"));
    bp.lobby.maxPlayers = 3;
    writeFileSync(at("g/onelobby.json"), JSON.stringify(bp, null, 2));
    const text = await cli(["--into", "g", ...FROM, "--recommend", SENTENCE]);
    expect(text.out).toContain("kept your onelobby.json; the recommendation was not applied");
    expect(text.out).not.toContain("From the recommendation");
    const again = await cli(["--into", "g", ...FROM, "--recommend", SENTENCE, "--json"]);
    expect(again.json.recommendation).toMatchObject({ applied: [], notApplied: "kept your onelobby.json; the recommendation was not applied" });
    expect(JSON.parse(readFileSync(at("g/onelobby.json"), "utf8")).lobby.maxPlayers).toBe(3);
  });
});

describe("the wiring check", () => {
  const run = async (kind, dir) => (await runChecks([wiringCheck()], { dir, kind })).results[0];
  const bp = (ui) => JSON.stringify({ version: 1, game: { id: "com.example.x" }, ...(ui ? { ui: { kind: ui } } : {}) });

  it("fails a GDScript game that never uses the menu, passes once a scene instances it", async () => {
    put("a/project.godot", "config_version=5\n");
    put("a/onelobby.json", bp());
    put("a/net.gd", "var c = OneLobbyClient.new()\n");
    put("a/addons/onelobby/menu/menu.tscn", "x");
    put("a/tests/multiplayer.gd", "OneLobbyMenu\n");
    const bad = await run("godot-gdscript", at("a"));
    expect(bad.status).toBe("fail");
    expect(bad.next).toContain("res://addons/onelobby/menu/menu.tscn");
    expect(bad.next).toContain("docs/recipes/menu.md");
    put("a/main.tscn", '[ext_resource type="PackedScene" path="res://addons/onelobby/menu/menu.tscn" id="1"]\n');
    expect((await run("godot-gdscript", at("a"))).status).toBe("ok");
  });

  it("a C# game: OneLobbyNet.cs alone is not wiring; a scene that instances OneLobbyMenu.tscn is", async () => {
    put("c/project.godot", "config_version=5\n");
    put("c/onelobby.json", bp());
    put("c/OneLobbyNet.cs", "public static void Wire(OneLobbyMenu menu) {}\n");
    expect((await run("godot-csharp", at("c"))).status).toBe("fail");
    put("c/Main.tscn", 'path="res://addons/onelobby_menu/OneLobbyMenu.tscn"\n');
    expect((await run("godot-csharp", at("c"))).status).toBe("ok");
  });

  it("ui.kind none looks for the client instead, and net.gd (the scaffolder's own) does not count", async () => {
    put("n/project.godot", "config_version=5\n");
    put("n/onelobby.json", bp("none"));
    put("n/net.gd", "var c = OneLobbyClient.new()\n");
    expect((await run("godot-gdscript", at("n"))).status).toBe("fail");
    put("n/game.gd", "func _ready(): Net.client.host()\n");
    expect((await run("godot-gdscript", at("n"))).status).toBe("ok");
  });

  it("web: the glue file and test/ do not count; a page that imports the glue does", async () => {
    put("w/onelobby.json", bp());
    put("w/multiplayer/session.js", 'import { OneLobby } from "onelobby";\n');
    put("w/test/multiplayer.mjs", 'import { makeKit } from "../multiplayer/session.js";\n');
    const bad = await run("web", at("w"));
    expect(bad.status).toBe("fail");
    expect(bad.detail).toContain("multiplayer/session.js");
    put("w/src/main.js", 'import { loadBlueprint } from "../multiplayer/session.js";\n');
    expect((await run("web", at("w"))).status).toBe("ok");
  });

  it("a project this tool writes passes untouched (web, new)", async () => {
    expect((await cli(["site", "--template", "web", "--yes", "--no-install", "--no-git", "--json"])).code).toBe(0);
    expect((await run("web", at("site"))).status).toBe("ok");
  });

  it("a note named '$comment tickRate' gets the rule about the key named exactly $comment", () => {
    expect(blueprintNext("sync.$comment tickRate", "usual")).toContain('named exactly "$comment"');
    expect(blueprintNext("sync.tickRate", "usual")).toBe("usual");
    expect(blueprintNext("$comment", "usual")).toBe("usual");
  });
});
