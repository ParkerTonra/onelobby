// `--into` and `update` on a game that already has multiplayer or an older add-on: name clashes, an older add-on replaced whole,
// a mixed add-on caught by verify, and --force keeping onelobby.json. Small made-up fixtures only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";
import { godotChecks } from "../src/verify/godot.js";
import { verifyPin } from "../src/vendor.js";
import { fixtureNativesZip } from "./helpers/zip.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-existing-"));
  const a = join(cwd, "checkout/clients/gdscript/addons/onelobby");
  mkdirSync(join(a, "menu"), { recursive: true });
  writeFileSync(join(a, "client.gd"), "class_name OneLobbyClient\nextends Node\n");
  writeFileSync(join(a, "client.gd.uid"), "uid://abc\n");
  writeFileSync(join(a, "menu/menu.tscn"), "[gd_scene format=3]\n");
  writeFileSync(join(cwd, "natives.zip"), fixtureNativesZip());
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

async function cli(args) {
  let out = "";
  let err = "";
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, stdin: Readable.from([""]), stdinIsTTY: false, env: {}, cwd };
  const code = await main(args, io);
  return { code, out, err };
}
const FROM = ["--addon-from", "checkout", "--webrtc-zip", "natives.zip", "--yes", "--no-git", "--no-natives"];
const j = async (args) => {
  const r = await cli([...args, "--json"]);
  return { ...r, json: JSON.parse(r.out) };
};
const at = (...p) => join(cwd, ...p);
const text = (...p) => readFileSync(at(...p), "utf8");
const tree = (dir, rel = "") =>
  readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`])).sort();
const write = (path, body) => {
  mkdirSync(at(path, ".."), { recursive: true });
  writeFileSync(at(path), body);
};
const game = (files = {}) => {
  write("mine/project.godot", "config_version=5\n");
  write("mine/scene.tscn", "[gd_scene format=3]\n");
  for (const [p, body] of Object.entries(files)) write(`mine/${p}`, body);
};
/** An older add-on, the way a hand copy or an old create-onelobby left it: its own files, a `PIN` file with a commit, no PIN.json. */
const OLD_ADDON = {
  "addons/onelobby/PIN": "33bcf81d0e5b2f6a7c8d9e0f1a2b3c4d5e6f7a8b\n",
  "addons/onelobby/client.gd": "class_name OneLobbyClient\nextends Node\n# the old one\n",
  "addons/onelobby/client.gd.uid": "uid://old\n",
  "addons/onelobby/old_only.gd": "# gone in the new add-on\n",
  "addons/onelobby/old_only.gd.uid": "uid://old2\n",
  "addons/onelobby/menu/old_menu.tscn": "[gd_scene format=3]\n",
};
const NEW_ADDON_TREE = ["addons/onelobby/PIN.json", "addons/onelobby/client.gd", "addons/onelobby/client.gd.uid", "addons/onelobby/menu/menu.tscn"];
const addonTree = (root) => tree(at(root)).filter((p) => p.startsWith("addons/onelobby/"));

describe("--into refuses a name the game already owns", () => {
  it("a game class_name equal to the autoload name Net: name_clash naming both files, nothing written, dry run too", async () => {
    game({ "scripts/net.gd": "class_name Net\nextends RefCounted\n" });
    const before = tree(at("mine"));
    for (const args of [["--dry-run"], []]) {
      const r = await j(["--into", "mine", ...FROM, ...args]);
      expect(r.code).toBe(1);
      expect(r.json.error.code).toBe("name_clash");
      expect(r.json.error.message).toContain("net.gd"); // the file it would write
      expect(r.json.error.message).toContain("scripts/net.gd"); // the game's own
      expect(r.json.error.message).toContain("class_name Net");
      expect(r.json.error.message).toContain("rename");
      expect(r.json.error.details.clashes).toEqual([expect.objectContaining({ name: "Net", gameFile: "scripts/net.gd" })]);
      expect(tree(at("mine"))).toEqual(before);
    }
  });

  it("a game class_name equal to one the add-on adds (OneLobbyClient, outside addons/onelobby/) is refused the same way", async () => {
    game({ "lib/my_client.gd": "class_name OneLobbyClient\nextends Node\n" });
    const r = await j(["--into", "mine", ...FROM]);
    expect(r.json.error.code).toBe("name_clash");
    expect(r.json.error.message).toContain("addons/onelobby/client.gd");
    expect(r.json.error.message).toContain("lib/my_client.gd");
  });

  it("a game autoload with the name of an add-on class is refused too", async () => {
    game({ "project.godot": 'config_version=5\n\n[autoload]\n\nOneLobbyClient="*res://x.gd"\n' });
    const r = await j(["--into", "mine", ...FROM]);
    expect(r.json.error.code).toBe("name_clash");
    expect(r.json.error.message).toContain("project.godot");
  });

  it("negative control: the game's own NetService (the class the old template also declared) is no clash, and net.gd declares no class_name", async () => {
    game({ "net/net_service.gd": "class_name NetService\nextends Node\nfunc _init(a, b) -> void:\n\tpass\n" });
    const r = await j(["--into", "mine", ...FROM]);
    expect(r.code).toBe(0);
    expect(text("mine/net.gd")).not.toMatch(/^class_name/m);
    expect(text("mine/net/net_service.gd")).toContain("class_name NetService");
  });

  it("a rerun is no clash (our own net.gd and the add-on's classes are not the game's)", async () => {
    game();
    expect((await j(["--into", "mine", ...FROM])).code).toBe(0);
    const again = await j(["--into", "mine", ...FROM]);
    expect(again.code).toBe(0);
    expect(again.json.changed).toBe(false);
  });
});

describe("--into replaces an older add-on whole", () => {
  it("legacy PIN file: the dry run says 'add-on <old> -> <new>' and lists every file; the run leaves exactly the new add-on", async () => {
    game(OLD_ADDON);
    const dry = await cli(["--into", "mine", ...FROM, "--dry-run"]);
    expect(dry.out).toMatch(/Add-on: 33bcf81 \(legacy PIN file\) -> [0-9a-z]+ \(create-onelobby [\d.]+\): replaced whole \(2 overwritten, 1 added, 4 removed\)/);
    for (const gone of ["PIN", "old_only.gd", "old_only.gd.uid", "menu/old_menu.tscn"]) expect(dry.out).toContain(`addons/onelobby/${gone} (removed`);
    expect(addonTree("mine")).toContain("addons/onelobby/old_only.gd"); // a dry run writes nothing
    const json = await j(["--into", "mine", ...FROM, "--dry-run"]);
    expect(json.json.addon.replaces).toMatchObject({ kind: "legacy", from: "33bcf81 (legacy PIN file)", created: 1, overwritten: 2 });
    expect(json.json.addon.replaces.removed.sort()).toEqual(["PIN", "menu/old_menu.tscn", "old_only.gd", "old_only.gd.uid"]);

    const r = await j(["--into", "mine", ...FROM]);
    expect(r.code).toBe(0);
    expect(r.json.removed.sort()).toEqual(["addons/onelobby/PIN", "addons/onelobby/menu/old_menu.tscn", "addons/onelobby/old_only.gd", "addons/onelobby/old_only.gd.uid"]);
    expect(addonTree("mine")).toEqual(NEW_ADDON_TREE);
    expect(text("mine/addons/onelobby/client.gd")).not.toContain("the old one");
    expect(verifyPin(at("mine"))).toMatchObject({ ok: true });
    expect((await j(["--into", "mine", ...FROM])).json.changed).toBe(false);
  });

  it("no pin file at all: replaced whole, nothing left of the old files", async () => {
    const { "addons/onelobby/PIN": _pin, ...noPin } = OLD_ADDON;
    game(noPin);
    const dry = await j(["--into", "mine", ...FROM, "--dry-run"]);
    expect(dry.json.addon.replaces).toMatchObject({ kind: "unpinned", from: "unknown (no pin file)" });
    await cli(["--into", "mine", ...FROM]);
    expect(addonTree("mine")).toEqual(NEW_ADDON_TREE);
  });

  it("PIN.json and a legacy PIN together (the mixed state an earlier run made): treated as legacy, replaced whole", async () => {
    game(OLD_ADDON);
    await cli(["--into", "mine", ...FROM]);
    write("mine/addons/onelobby/PIN", "33bcf81\n");
    write("mine/addons/onelobby/old_only.gd", "# came back\n");
    const r = await j(["--into", "mine", ...FROM]);
    expect(r.json.addon.replaces.kind).toBe("legacy");
    expect(addonTree("mine")).toEqual(NEW_ADDON_TREE);
  });

  it("a current PIN.json add-on with an older version in it is replaced with no --force; an edited file stops it and is named", async () => {
    game();
    await cli(["--into", "mine", ...FROM]);
    write("mine/addons/onelobby/menu/menu.tscn", "[gd_scene format=3]\n# my edit\n");
    const stop = await j(["--into", "mine", ...FROM]);
    expect(stop.code).toBe(1);
    expect(stop.json.error.code).toBe("local_changes");
    expect(stop.json.error.message).toContain("addons/onelobby/menu/menu.tscn");
    expect(stop.json.error.message).toContain("--force");
    expect(text("mine/addons/onelobby/menu/menu.tscn")).toContain("my edit");
    const forced = await j(["--into", "mine", ...FROM, "--force"]);
    expect(forced.code).toBe(0);
    expect(forced.json.addon.replaces.edited).toEqual(["menu/menu.tscn"]);
    expect(text("mine/addons/onelobby/menu/menu.tscn")).not.toContain("my edit");
  });

  it("a file the pin does not list (a stray old file) needs --force to be removed, and is named", async () => {
    game();
    await cli(["--into", "mine", ...FROM]);
    write("mine/addons/onelobby/stray.gd", "# old\n");
    const stop = await j(["--into", "mine", ...FROM]);
    expect(stop.json.error.code).toBe("local_changes");
    expect(stop.json.error.message).toContain("addons/onelobby/stray.gd");
    await cli(["--into", "mine", ...FROM, "--force"]);
    expect(addonTree("mine")).toEqual(NEW_ADDON_TREE);
  });

  it("the game's own files are never touched by the replacement", async () => {
    game({ ...OLD_ADDON, "scripts/main.gd": "extends Node\n", "addons/other/plugin.gd": "extends Node\n" });
    await cli(["--into", "mine", ...FROM]);
    expect(text("mine/scripts/main.gd")).toBe("extends Node\n");
    expect(text("mine/addons/other/plugin.gd")).toBe("extends Node\n");
  });

  it("every game file that collides is listed apart (not only under skipped), in the dry run and in the JSON", async () => {
    game({ ...OLD_ADDON, "net.gd": "extends Node # mine\n", "tests/multiplayer.gd": "extends SceneTree # mine\n" });
    const dry = await cli(["--into", "mine", ...FROM, "--dry-run"]);
    expect(dry.out).toContain("Collides with files already in your game:");
    expect(dry.out).toContain("net.gd: differs, left as it is (--force replaces it)");
    expect(dry.out).toContain("tests/multiplayer.gd: differs, left as it is (--force replaces it)");
    const json = await j(["--into", "mine", ...FROM, "--dry-run"]);
    expect(json.json.collisions.map((c) => c.path).sort()).toEqual(["net.gd", "tests/multiplayer.gd"]);
  });
});

describe("--force keeps onelobby.json", () => {
  it("the file with its $comment survives --into --force byte for byte, and says it was kept", async () => {
    game();
    await cli(["--into", "mine", ...FROM]);
    const mine = JSON.parse(text("mine/onelobby.json"));
    mine.sync = { ...mine.sync, $comment: "raw: the game keeps its own snapshot code" };
    writeFileSync(at("mine/onelobby.json"), JSON.stringify(mine, null, 2) + "\n");
    const before = text("mine/onelobby.json");
    const r = await cli(["--into", "mine", ...FROM, "--force", "--max-players", "3"]);
    expect(r.code).toBe(0);
    expect(text("mine/onelobby.json")).toBe(before);
    expect(r.out).toContain("onelobby.json: differs, kept");
  });
});

describe("update on an older add-on", () => {
  const UPDATE = ["update", "mine", "--addon-from", "checkout", "--no-natives"];
  it("a legacy PIN add-on: replaced whole by update, the pin file becomes PIN.json", async () => {
    game(OLD_ADDON);
    const r = await j(UPDATE);
    expect(r.code).toBe(0);
    expect(r.json.files.removed.sort()).toEqual(["PIN", "menu/old_menu.tscn", "old_only.gd", "old_only.gd.uid"]);
    expect(r.json.addon.previousCommit).toBe("33bcf81d0e5b2f6a7c8d9e0f1a2b3c4d5e6f7a8b");
    expect(addonTree("mine")).toEqual(NEW_ADDON_TREE);
    expect(verifyPin(at("mine"))).toMatchObject({ ok: true });
  });

  it("an add-on with no pin at all: replaced whole too (no no_pin refusal)", async () => {
    const { "addons/onelobby/PIN": _pin, ...noPin } = OLD_ADDON;
    game(noPin);
    expect((await j(UPDATE)).code).toBe(0);
    expect(addonTree("mine")).toEqual(NEW_ADDON_TREE);
  });

  it("no add-on folder at all is still no_pin", async () => {
    game();
    expect((await j(UPDATE)).json.error.code).toBe("no_pin");
  });
});

describe("verify: a mixed add-on", () => {
  const addonPin = godotChecks().find((c) => c.name === "addon-pin");
  const run = () => addonPin.run({ dir: at("mine") });

  it("a clean add-on passes (negative control)", async () => {
    game();
    await cli(["--into", "mine", ...FROM]);
    expect((await run()).status).toBe("ok");
  });

  it("an older add-on (a PIN file) fails, naming the fix", async () => {
    game(OLD_ADDON);
    const r = await run();
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("older add-on");
    expect(r.next).toContain("npx create-onelobby --into .");
    expect(r.next).toContain("replaces addons/onelobby/ whole");
  });

  it("old files beside a new PIN.json (the PIN file deleted by hand) fail, naming the files and the fix", async () => {
    game();
    await cli(["--into", "mine", ...FROM]);
    write("mine/addons/onelobby/old_only.gd", "# stale\n");
    const r = await run();
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("old_only.gd");
    expect(r.detail).toContain("mixed");
    expect(r.next).toContain("--into . --force");
  });

  it("a .uid file Godot wrote beside a script is no mix", async () => {
    game();
    await cli(["--into", "mine", ...FROM]);
    write("mine/addons/onelobby/other.gd.uid", "uid://x\n");
    expect((await run()).status).toBe("ok");
  });

  it("an edited file stays a warning only", async () => {
    game();
    await cli(["--into", "mine", ...FROM]);
    write("mine/addons/onelobby/client.gd", "class_name OneLobbyClient\nextends Node\n# edited\n");
    const r = await run();
    expect(r.status).toBe("ok");
    expect(r.warning).toContain("edited");
  });
});

describe("the Next lines fit a scene and a menu built in code", () => {
  it("names both ways, the client before add_child, and the flag switch", async () => {
    game();
    const r = await j(["--into", "mine", ...FROM]);
    const next = r.json.next.join("\n");
    expect(next).toContain("Instantiate Child Scene");
    expect(next).toContain("built in code");
    expect(next).toContain("menu.client = Net.client; layer.add_child(menu)");
    expect(next).toContain("menu.boot_flags = false");
    expect(next).toContain("menu.pump = false");
  });
});

describe("the scaffolded two-peer test and the natives are untouched by all this", () => {
  it("a new project has no add-on replacement line and no collisions", async () => {
    const r = await j(["fresh", "--template", "godot-gdscript", ...FROM]);
    expect(r.code).toBe(0);
    expect(r.json.collisions).toEqual([]);
    expect(r.json.addon.replaces).toBeUndefined();
    expect(existsSync(at("fresh/net.gd"))).toBe(true);
  });
});
