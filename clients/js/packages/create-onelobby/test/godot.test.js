import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";
import { verifyPin } from "../src/vendor.js";
import { fixtureNativesZip, makeZip } from "./helpers/zip.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-godot-"));
  // a small stand-in for a OneLobby checkout, so these tests do not depend on the repo's add-on
  const a = join(cwd, "checkout/clients/gdscript/addons/onelobby");
  mkdirSync(join(a, "menu"), { recursive: true });
  writeFileSync(join(a, "client.gd"), "class_name OneLobbyClient\nextends Node\n");
  writeFileSync(join(a, "client.gd.uid"), "uid://abc\n");
  writeFileSync(join(a, "menu/menu.tscn"), "[gd_scene format=3]\n");
  writeFileSync(join(cwd, "natives.zip"), fixtureNativesZip());
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

async function cli(args, { fetch, env = {} } = {}) {
  let out = "";
  let err = "";
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, stdin: Readable.from([""]), stdinIsTTY: false, env, cwd, fetch };
  const code = await main(args, io);
  return { code, out, err };
}
const FROM = ["--addon-from", "checkout", "--webrtc-zip", "natives.zip", "--yes", "--no-git"];
const j = async (args, opts) => {
  const r = await cli([...args, "--json"], opts);
  return { ...r, json: JSON.parse(r.out) };
};
const at = (...p) => join(cwd, ...p);
const text = (...p) => readFileSync(at(...p), "utf8");
const tree = (dir, rel = "") =>
  readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`])).sort();

const NEW_FILES = [
  ".gitattributes", ".gitignore", ".olc/game.json", "AGENTS.md", "addons/onelobby/PIN.json", "addons/onelobby/client.gd", "addons/onelobby/client.gd.uid",
  "addons/onelobby/menu/menu.tscn", "main.gd", "main.tscn", "net.gd", "onelobby.json", "project.godot", "tests/multiplayer.gd",
];
const NATIVE_FILES = [
  "addons/godot_webrtc/LICENSE.webrtc-native",
  "addons/godot_webrtc/lib/libwebrtc_native.windows.template_release.x86_64.dll",
  "addons/godot_webrtc/webrtc_native.gdextension",
];

describe("godot-gdscript: a new project", () => {
  it("--dry-run --json lists the files, writes nothing and downloads nothing", async () => {
    let fetched = 0;
    const r = await j(["game", "--template", "godot-gdscript", "--yes", "--addon-from", "checkout", "--dry-run"], { fetch: async () => (fetched++, null) });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, dryRun: true, template: "godot-gdscript", changed: true, skipped: [] });
    expect([...r.json.files].sort()).toEqual(NEW_FILES);
    expect(r.json.natives).toMatchObject({ status: "install", source: "download", version: "1.2.2-stable", folder: "addons/godot_webrtc/" });
    expect(r.json.blueprint).toMatchObject({ engine: "godot-gdscript", ui: { kind: "drop-in" }, hosting: { direct: true, server: false } });
    expect(existsSync(at("game"))).toBe(false);
    expect(fetched).toBe(0);
    expect(r.out.trim().split("\n")).toHaveLength(1);
  });

  it("--dry-run without --json prints the plan in words", async () => {
    const r = await cli(["game", "--template", "godot-gdscript", "--yes", "--addon-from", "checkout", "--dry-run"]);
    expect(r.out).toContain("Dry run: nothing written, nothing downloaded.");
    expect(r.out).toContain("net.gd");
    expect(r.out).toContain("addons/godot_webrtc/");
    expect(existsSync(at("game"))).toBe(false);
  });

  it("writes the project, the add-on, the pin and the natives", async () => {
    const r = await j(["game", "--template", "godot-gdscript", ...FROM]);
    expect(r.code).toBe(0);
    expect(tree(at("game"))).toEqual([...NEW_FILES, ...NATIVE_FILES].sort());
    const p = text("game/project.godot");
    expect(p).toContain('config/name="game"');
    expect(p).toContain('run/main_scene="res://main.tscn"');
    expect(p).toContain('Net="*res://net.gd"');
    const bp = JSON.parse(text("game/onelobby.json"));
    expect(bp).toMatchObject({ engine: "godot-gdscript", game: { id: "com.example.game", title: "game" }, ui: { kind: "drop-in" } });
    expect(text("game/.gitignore")).toContain("addons/godot_webrtc/\n.godot/");
    expect(text("game/.gitattributes")).toContain("addons/onelobby/** text eol=lf");
    expect(text("game/tests/multiplayer.gd")).toContain("MULTIPLAYER_OK");
    expect(text("game/AGENTS.md")).toContain("-s res://tests/multiplayer.gd");
    expect(text("game/AGENTS.md")).not.toContain("{{");
    expect(text("game/main.tscn")).toContain("boot_flags = false");
    expect(verifyPin(at("game"))).toMatchObject({ ok: true });
    expect(JSON.parse(text("game/addons/onelobby/PIN.json")).files).toHaveProperty("menu/menu.tscn");
  });

  it("the olc entry has a powershell and a bash task that read $GODOT", async () => {
    await cli(["game", "--template", "godot-gdscript", ...FROM, "--no-natives"]);
    const olc = JSON.parse(text("game/.olc/game.json"));
    expect(olc.entries.map((e) => [e.name, e.shell, e.kind, e.group, e.cwd, e.play])).toEqual([
      ["game-play", "powershell", "task", "game", ".", true],
      ["game-play-bash", "bash", "task", "game", ".", true],
    ]);
    expect(olc.entries[0].command).toContain("$env:GODOT");
    expect(olc.entries[1].command).toContain("${GODOT:-godot}");
    expect(olc.entries[0].label).toContain("host + joiner");
  });

  it("--no-natives skips them, says so and prints the command that fetches them later", async () => {
    const r = await cli(["game", "--template", "godot-gdscript", ...FROM, "--no-natives"]);
    expect(existsSync(at("game/addons/godot_webrtc"))).toBe(false);
    expect(r.out).toContain("WebRTC natives not installed (--no-natives).");
    expect(r.out).toContain("npx create-onelobby --into . --template godot-gdscript");
  });

  it("the hand-written files keep their LF endings and carry no placeholder", async () => {
    await cli(["My Game", "--template", "godot-gdscript", ...FROM, "--no-natives"]);
    for (const f of ["net.gd", "main.gd", "main.tscn", "project.godot", "tests/multiplayer.gd", "AGENTS.md"]) {
      const t = text("My Game", f);
      expect(t, f).not.toContain("\r");
      expect(t, f).not.toMatch(/\{\{\w+\}\}/);
    }
    expect(text("My Game/project.godot")).toContain('config/name="My Game"');
  });

  it("refuses a non-empty folder without --force", async () => {
    mkdirSync(at("game"));
    writeFileSync(at("game/x.txt"), "x");
    const r = await j(["game", "--template", "godot-gdscript", ...FROM]);
    expect(r.json.error.code).toBe("dir_not_empty");
  });

  it("needs --addon-from to exist, and a bad one is bad_addon_from", async () => {
    const r = await j(["game", "--template", "godot-gdscript", "--yes", "--no-git", "--no-natives", "--addon-from", "nowhere"]);
    expect(r.json.error.code).toBe("bad_addon_from");
    expect(existsSync(at("game"))).toBe(false);
  });

  it("uses the add-on bundled in the package when --addon-from is not given", async () => {
    const r = await j(["game", "--template", "godot-gdscript", "--yes", "--no-git", "--no-natives", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.json.addon.from).toBe("package");
    expect(r.json.files).toContain("addons/onelobby/menu/menu.tscn");
    expect(r.json.files).toContain("addons/onelobby/client.gd");
  });

  it("ui kinds other than drop-in are refused", async () => {
    const r = await j(["game", "--template", "godot-gdscript", "--yes", "--ui", "generated", "--dry-run"]);
    expect(r.json.error).toMatchObject({ code: "unsupported", path: "ui.kind" });
  });

  it.each(["lockstep", "raw", "replication"])("--mode %s is written as asked (net.gd builds the client from the file, whatever the mode)", async (mode) => {
    const r = await j(["game", "--template", "godot-gdscript", ...FROM, "--mode", mode]);
    expect(r.code).toBe(0);
    expect(JSON.parse(text("game/onelobby.json")).sync.mode).toBe(mode);
  });
});

describe("godot-gdscript: the natives", () => {
  it("a zip with a path-escaping entry is refused and nothing is written", async () => {
    writeFileSync(at("evil.zip"), makeZip([{ name: "addons/w/webrtc_native.gdextension", data: "x" }, { name: "../../escape.txt", data: "boo" }]));
    const r = await j(["game", "--template", "godot-gdscript", "--yes", "--no-git", "--addon-from", "checkout", "--webrtc-zip", "evil.zip"]);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("bad_zip");
    expect(existsSync(at("game"))).toBe(false);
    expect(existsSync(join(cwd, "..", "escape.txt"))).toBe(false);
  });

  it("an unreadable --webrtc-zip is bad_webrtc", async () => {
    const r = await j(["game", "--template", "godot-gdscript", "--yes", "--no-git", "--addon-from", "checkout", "--webrtc-zip", "nope.zip"]);
    expect(r.json.error.code).toBe("bad_webrtc");
  });

  it("a download whose SHA-256 is not the pinned one installs nothing", async () => {
    const zip = fixtureNativesZip();
    const fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) });
    const r = await j(["game", "--template", "godot-gdscript", "--yes", "--no-git", "--addon-from", "checkout"], { fetch });
    expect(r.json.error.code).toBe("bad_download");
    expect(existsSync(at("game"))).toBe(false);
  });

  it("a failed download is download_failed and names the offline options", async () => {
    const r = await j(["game", "--template", "godot-gdscript", "--yes", "--no-git", "--addon-from", "checkout"], { fetch: async () => ({ ok: false, status: 503 }) });
    expect(r.json.error.code).toBe("download_failed");
    expect(r.json.error.message).toContain("--webrtc-zip");
  });

  it("--webrtc-dir copies an unpacked add-on folder", async () => {
    mkdirSync(at("unpacked/lib"), { recursive: true });
    writeFileSync(at("unpacked/webrtc_native.gdextension"), "[configuration]\n");
    writeFileSync(at("unpacked/lib/a.dll"), Buffer.from([1, 2, 3]));
    const r = await j(["game", "--template", "godot-gdscript", "--yes", "--no-git", "--addon-from", "checkout", "--webrtc-dir", "unpacked"]);
    expect(r.code).toBe(0);
    expect(r.json.natives).toMatchObject({ status: "install", source: "dir" });
    expect([...readFileSync(at("game/addons/godot_webrtc/lib/a.dll"))]).toEqual([1, 2, 3]);
  });
});

describe("godot-gdscript: --into", () => {
  const godotProject = (name = "mine", extra = "") => {
    mkdirSync(at(name), { recursive: true });
    writeFileSync(at(name, "project.godot"), `config_version=5\n\n[application]\n\nconfig/name="Mine"\nrun/main_scene="res://scene.tscn"\n${extra}`);
    writeFileSync(at(name, "scene.tscn"), "[gd_scene format=3]\n");
  };
  const INTO_FILES = [
    ".gitattributes", ".gitignore", ".olc/mine.json", "addons/onelobby/PIN.json", "addons/onelobby/client.gd", "addons/onelobby/client.gd.uid",
    "addons/onelobby/menu/menu.tscn", "net.gd", "onelobby.json", "project.godot", "tests/multiplayer.gd",
  ];

  it("adds the add-on, natives, autoload and test; leaves the main scene and the rest of project.godot alone", async () => {
    godotProject();
    const before = text("mine/project.godot");
    const r = await j(["--into", "mine", ...FROM]);
    expect(r.code).toBe(0);
    expect([...r.json.files].sort()).toEqual(INTO_FILES);
    expect(tree(at("mine"))).toEqual([...INTO_FILES, ...NATIVE_FILES, "scene.tscn"].sort());
    expect(text("mine/project.godot")).toBe(`${before}\n[autoload]\n\nNet="*res://net.gd"\n`);
    expect(text("mine/scene.tscn")).toBe("[gd_scene format=3]\n");
    expect(JSON.parse(text("mine/onelobby.json")).engine).toBe("godot-gdscript");
    expect(r.json.next.join("\n")).toContain("Instantiate Child Scene > res://addons/onelobby/menu/menu.tscn");
    expect(r.json.next.join("\n")).toContain("docs/recipes/godot-gdscript.md");
  });

  it("a second run changes nothing and says so", async () => {
    godotProject();
    await cli(["--into", "mine", ...FROM]);
    const snapshot = tree(at("mine")).map((f) => [f, readFileSync(at("mine", f)).toString("hex")]);
    const again = await cli(["--into", "mine", ...FROM]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("Nothing changed");
    expect(tree(at("mine")).map((f) => [f, readFileSync(at("mine", f)).toString("hex")])).toEqual(snapshot);
    const js = await j(["--into", "mine", "--addon-from", "checkout", "--yes", "--webrtc-zip", "natives.zip", "--dry-run"]);
    expect(js.json).toMatchObject({ changed: false, files: [], skipped: [], natives: { status: "present" } });
  });

  it("a rerun after --no-natives installs just the natives", async () => {
    godotProject();
    await cli(["--into", "mine", ...FROM, "--no-natives"]);
    expect(existsSync(at("mine/addons/godot_webrtc"))).toBe(false);
    const r = await j(["--into", "mine", ...FROM]);
    expect(r.json.files).toEqual([]);
    expect(r.json.natives.status).toBe("install");
    expect(existsSync(at("mine/addons/godot_webrtc/webrtc_native.gdextension"))).toBe(true);
  });

  it("works on a CRLF project.godot and keeps it CRLF", async () => {
    mkdirSync(at("mine"));
    writeFileSync(at("mine/project.godot"), 'config_version=5\r\n\r\n[autoload]\r\n\r\nGlobals="*res://globals.gd"\r\n\r\n[display]\r\nx=1\r\n');
    await cli(["--into", "mine", ...FROM, "--no-natives"]);
    expect(text("mine/project.godot")).toBe('config_version=5\r\n\r\n[autoload]\r\n\r\nGlobals="*res://globals.gd"\r\nNet="*res://net.gd"\r\n\r\n[display]\r\nx=1\r\n');
  });

  it("merges into an existing .gitignore and .gitattributes without touching their lines", async () => {
    godotProject();
    writeFileSync(at("mine/.gitignore"), "export/\n");
    writeFileSync(at("mine/.gitattributes"), "*.png binary\n");
    await cli(["--into", "mine", ...FROM, "--no-natives"]);
    expect(text("mine/.gitignore").startsWith("export/\n\n# >>> onelobby")).toBe(true);
    expect(text("mine/.gitattributes").startsWith("*.png binary\n\n# >>> onelobby")).toBe(true);
    expect(text("mine/.gitignore")).toContain("addons/godot_webrtc/");
  });

  it("never overwrites an existing file without --force, and lists each one it skipped", async () => {
    godotProject();
    writeFileSync(at("mine/onelobby.json"), "mine");
    writeFileSync(at("mine/tests/../net.gd"), "extends Node # my own net\n");
    const r = await j(["--into", "mine", ...FROM, "--no-natives"]);
    expect(r.code).toBe(0);
    expect(r.json.skipped.sort()).toEqual(["net.gd", "onelobby.json"]);
    expect(text("mine/onelobby.json")).toBe("mine");
    expect(text("mine/net.gd")).toBe("extends Node # my own net\n");
    expect(text("mine/project.godot")).not.toContain("[autoload]"); // their net.gd, so no autoload was added
    expect(r.json.notes.join(" ")).toContain("net.gd already exists");
    const human = await cli(["--into", "mine", ...FROM, "--no-natives"]);
    expect(human.out).toContain("Skipped (already exist and differ; use --force to overwrite):");
    const forced = await j(["--into", "mine", ...FROM, "--no-natives", "--force"]);
    expect(forced.json.skipped).toEqual([]);
    expect(JSON.parse(text("mine/onelobby.json")).version).toBe(1);
    expect(text("mine/project.godot")).toContain('Net="*res://net.gd"');
  });

  it("an autoload called Net that points elsewhere is autoload_taken and nothing is written", async () => {
    godotProject("mine", '\n[autoload]\n\nNet="*res://other.gd"\n');
    const r = await j(["--into", "mine", ...FROM]);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("autoload_taken");
    expect(tree(at("mine"))).toEqual(["project.godot", "scene.tscn"]);
  });

  it("a Godot C# project (a .csproj or .sln next to project.godot) is template_planned and names the recipe", async () => {
    for (const marker of ["Game.csproj", "Game.sln"]) {
      godotProject("cs");
      writeFileSync(at("cs", marker), "<Project/>");
      for (const args of [["--into", "cs", "--yes"], ["--into", "cs", "--template", "godot-gdscript", "--yes"]]) {
        const r = await j([...args, "--no-natives", "--addon-from", "checkout"]);
        expect(r.code).toBe(1);
        expect(r.json.error.code).toBe("template_planned");
        expect(r.json.error.message).toContain("docs/recipes/godot-csharp.md");
      }
      expect(tree(at("cs"))).toEqual([marker, "project.godot", "scene.tscn"]);
      rmSync(at("cs"), { recursive: true });
    }
  });

  it("a folder with no project.godot is not_godot_project", async () => {
    mkdirSync(at("plain"));
    const r = await j(["--into", "plain", "--template", "godot-gdscript", "--yes", "--no-natives", "--addon-from", "checkout"]);
    expect(r.json.error.code).toBe("not_godot_project");
  });

  it("--dry-run writes nothing and downloads nothing", async () => {
    godotProject();
    let fetched = 0;
    const before = tree(at("mine"));
    const r = await j(["--into", "mine", "--yes", "--addon-from", "checkout", "--dry-run"], { fetch: async () => (fetched++, null) });
    expect(r.json).toMatchObject({ ok: true, dryRun: true, changed: true });
    expect(r.json.files).toContain("project.godot");
    expect(tree(at("mine"))).toEqual(before);
    expect(fetched).toBe(0);
  });

  it("the web --into still works in a folder without project.godot", async () => {
    mkdirSync(at("web"));
    const r = await j(["--into", "web", "--yes"]);
    expect(r.json.files).toEqual(["onelobby.json", "multiplayer/session.js", "test/multiplayer.mjs"]);
  });
});

describe("templates still planned", () => {
  for (const t of ["godot-csharp", "unity"]) {
    it(`${t} is template_planned and the message no longer claims only web exists`, async () => {
      const r = await j(["g", "--template", t, "--yes", "--no-git"]);
      expect(r.code).toBe(1);
      expect(r.json.error.code).toBe("template_planned");
      expect(r.json.error.message).toContain("planned for v2");
      expect(r.json.error.message).toContain('"web" and "godot-gdscript"');
      expect(r.json.error.message).not.toContain("only");
    });
  }
});
