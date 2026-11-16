import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";
import { WEBRTC_NATIVE_VERSION, verifyPin } from "../src/vendor.js";
import { fixtureNativesZip } from "./helpers/zip.js";

let cwd;
const addonDir = (root) => join(root, "clients/gdscript/addons/onelobby");
function writeAddon(root, files) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(addonDir(root), path, ".."), { recursive: true });
    writeFileSync(join(addonDir(root), path), body);
  }
}
const V1 = { "client.gd": "class_name OneLobbyClient\nextends Node\n", "client.gd.uid": "uid://abc\n", "menu/menu.tscn": "[gd_scene format=3]\n", "old.gd": "# goes away\n" };

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-update-"));
  writeAddon(join(cwd, "v1"), V1);
  // v2: client.gd changed, new.gd added, old.gd removed, the rest as it was
  writeAddon(join(cwd, "v2"), { ...V1, "client.gd": "class_name OneLobbyClient\nextends Node\nvar v := 2\n", "new.gd": "# new\n" });
  rmSync(join(addonDir(join(cwd, "v2")), "old.gd"));
  writeFileSync(join(cwd, "natives.zip"), fixtureNativesZip());
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

async function cli(args, { fetch } = {}) {
  let out = "";
  let err = "";
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, stdin: Readable.from([""]), stdinIsTTY: false, env: {}, cwd, fetch };
  const code = await main(args, io);
  return { code, out, err };
}
const j = async (args, opts) => {
  const r = await cli([...args, "--json"], opts);
  return { ...r, json: JSON.parse(r.out) };
};
const at = (...p) => join(cwd, ...p);
const text = (...p) => readFileSync(at(...p), "utf8");
/** Every file under the game with its bytes, to prove "nothing written". */
const snapshot = (dir, rel = "") =>
  Object.fromEntries(
    readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
      const r = `${rel}${e.name}`;
      return e.isDirectory() ? Object.entries(snapshot(dir, `${r}/`)) : [[r, readFileSync(join(dir, r)).toString("hex") + statSync(join(dir, r)).mtimeMs]];
    }),
  );

/** A scaffolded game made from v1 (natives installed from the fixture zip). */
async function game(extra = []) {
  const r = await cli(["game", "--template", "godot-gdscript", "--yes", "--no-git", "--addon-from", "v1", "--webrtc-zip", "natives.zip", ...extra]);
  expect(r.code).toBe(0);
}
const UPDATE = ["update", "game", "--addon-from", "v2", "--no-natives"];

describe("update: a godot-gdscript game with an untouched add-on", () => {
  it("replaces it file by file, lists changed, added and removed, and rewrites the pin", async () => {
    await game();
    const r = await j(UPDATE);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, command: "update", template: "godot-gdscript", current: false, changed: true, pin: "rewritten" });
    expect(r.json.files).toEqual({ changed: ["client.gd"], added: ["new.gd"], removed: ["old.gd"] });
    expect(text("game/addons/onelobby/client.gd")).toContain("var v := 2");
    expect(text("game/addons/onelobby/new.gd")).toBe("# new\n");
    expect(existsSync(at("game/addons/onelobby/old.gd"))).toBe(false);
    expect(verifyPin(at("game"))).toMatchObject({ ok: true });
    expect(Object.keys(JSON.parse(text("game/addons/onelobby/PIN.json")).files).sort()).toEqual(["client.gd", "client.gd.uid", "menu/menu.tscn", "new.gd"]);
    expect(r.json.next[0]).toContain("godot --headless --import --path .");
  });

  it("in words: lists each file under its verb and ends with the import command", async () => {
    await game();
    const r = await cli(UPDATE);
    expect(r.out).toMatch(/Updated .*game/);
    expect(r.out).toMatch(/1 changed, 1 added, 1 removed/);
    expect(r.out).toMatch(/changed\s+client\.gd/);
    expect(r.out).toMatch(/added\s+new\.gd/);
    expect(r.out).toMatch(/removed\s+old\.gd/);
    expect(r.out).toContain("godot --headless --import --path .");
  });

  it("removes a sub-folder the removal emptied, and touches nothing outside addons/onelobby/ but the managed blocks", async () => {
    await game();
    writeFileSync(at("game/main.gd"), "# mine\n");
    const before = snapshot(at("game"));
    // v3: the menu folder is gone entirely
    writeAddon(at("v3"), { "client.gd": V1["client.gd"], "client.gd.uid": V1["client.gd.uid"] });
    const r = await j(["update", "game", "--addon-from", "v3", "--no-natives"]);
    expect(r.json.files.removed.sort()).toEqual(["menu/menu.tscn", "old.gd"]);
    expect(existsSync(at("game/addons/onelobby/menu"))).toBe(false);
    const after = snapshot(at("game"));
    for (const [path, v] of Object.entries(before)) if (!path.startsWith("addons/onelobby/")) expect(after[path], path).toBe(v);
  });

  it("--dry-run lists the same things and writes nothing", async () => {
    await game();
    const before = snapshot(at("game"));
    const r = await j([...UPDATE, "--dry-run"]);
    expect(r.json).toMatchObject({ dryRun: true, current: false });
    expect(r.json.files).toEqual({ changed: ["client.gd"], added: ["new.gd"], removed: ["old.gd"] });
    expect(snapshot(at("game"))).toEqual(before);
    const words = await cli([...UPDATE, "--dry-run"]);
    expect(words.out).toContain("Dry run: nothing written, nothing downloaded.");
    expect(snapshot(at("game"))).toEqual(before);
  });

  it("works from inside the game (no directory) and with --into", async () => {
    await game();
    const a = await j(["update", "--into", "game", "--addon-from", "v2", "--no-natives", "--dry-run"]);
    expect(a.json.files.added).toEqual(["new.gd"]);
    const both = await j(["update", "game", "--into", "game", "--addon-from", "v2", "--no-natives"]);
    expect(both.json.error.code).toBe("bad_flag");
  });
});

describe("update: already current", () => {
  it("says so, exits 0 and writes nothing", async () => {
    await game();
    await cli(UPDATE);
    const before = snapshot(at("game"));
    const r = await cli(UPDATE);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Already current/);
    expect(r.out).toContain("Nothing was written");
    expect(snapshot(at("game"))).toEqual(before);
    const json = await j(UPDATE);
    expect(json.json).toMatchObject({ ok: true, current: true, changed: false, pin: "unchanged", next: [] });
  });
});

describe("update: local changes stop it (exit 1) unless --force", () => {
  it("an edited file", async () => {
    await game();
    writeFileSync(at("game/addons/onelobby/client.gd.uid"), "uid://mine\n");
    const before = snapshot(at("game"));
    const r = await j(UPDATE);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("local_changes");
    expect(r.json.error.message).toMatch(/edited\s+addons\/onelobby\/client\.gd\.uid/);
    expect(r.json.error.details).toEqual({ edited: ["client.gd.uid"], missing: [], added: [] });
    expect(snapshot(at("game"))).toEqual(before);
    const words = await cli(UPDATE);
    expect(words.code).toBe(1);
    expect(words.err).toContain("edited   addons/onelobby/client.gd.uid");
  });

  it("an added file", async () => {
    await game();
    writeFileSync(at("game/addons/onelobby/mine.gd"), "# mine\n");
    const r = await j(UPDATE);
    expect(r.code).toBe(1);
    expect(r.json.error.details.added).toEqual(["mine.gd"]);
  });

  it("a missing file", async () => {
    await game();
    rmSync(at("game/addons/onelobby/client.gd.uid"));
    const r = await j(UPDATE);
    expect(r.code).toBe(1);
    expect(r.json.error.details.missing).toEqual(["client.gd.uid"]);
  });

  it("--force overwrites edits, restores the missing, keeps what you added, and says what it did", async () => {
    await game();
    writeFileSync(at("game/addons/onelobby/client.gd.uid"), "uid://mine\n");
    rmSync(at("game/addons/onelobby/menu/menu.tscn"));
    writeFileSync(at("game/addons/onelobby/mine.gd"), "# mine\n");
    const r = await j([...UPDATE, "--force"]);
    expect(r.code).toBe(0);
    expect(r.json.overwritten).toEqual(["client.gd.uid", "menu/menu.tscn"]);
    expect(r.json.kept).toEqual(["mine.gd"]);
    expect(text("game/addons/onelobby/client.gd.uid")).toBe("uid://abc\n");
    expect(text("game/addons/onelobby/menu/menu.tscn")).toBe("[gd_scene format=3]\n");
    expect(text("game/addons/onelobby/mine.gd")).toBe("# mine\n");
    const words = await cli([...UPDATE, "--force"]);
    expect(words.out).not.toContain("overwrote"); // second run: nothing left to overwrite
  });

  it("--force in words names the overwritten files", async () => {
    await game();
    writeFileSync(at("game/addons/onelobby/client.gd.uid"), "uid://mine\n");
    const r = await cli([...UPDATE, "--force"]);
    expect(r.out).toContain("--force overwrote your edits to 1 file(s)");
    expect(r.out).toContain("client.gd.uid");
  });
});

describe("update: no PIN.json", () => {
  it("is a clear error that names --into", async () => {
    await game();
    rmSync(at("game/addons/onelobby/PIN.json"));
    const r = await j(UPDATE);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("no_pin");
    expect(r.json.error.message).toContain("--into");
  });

  it("an unreadable PIN.json is bad_pin", async () => {
    await game();
    writeFileSync(at("game/addons/onelobby/PIN.json"), "{ nope");
    expect((await j(UPDATE)).json.error.code).toBe("bad_pin");
  });
});

describe("update: the natives", () => {
  it("left alone when the pinned version matches and the folder is there", async () => {
    await game();
    const r = await j(["update", "game", "--addon-from", "v2", "--webrtc-zip", "natives.zip"]);
    expect(r.json.natives).toMatchObject({ status: "present", version: WEBRTC_NATIVE_VERSION });
  });

  it("reinstalled when the folder is missing", async () => {
    await game();
    rmSync(at("game/addons/godot_webrtc"), { recursive: true });
    const r = await j(["update", "game", "--addon-from", "v1", "--webrtc-zip", "natives.zip"]);
    expect(r.json).toMatchObject({ current: false, natives: { status: "install", source: "zip", why: "the natives folder is missing" } });
    expect(existsSync(at("game/addons/godot_webrtc/webrtc_native.gdextension"))).toBe(true);
    expect(r.json.files).toEqual({ changed: [], added: [], removed: [] });
  });

  it("reinstalled when the version in the pin is not this version's, and the pin records the new one", async () => {
    await game();
    const pin = JSON.parse(text("game/addons/onelobby/PIN.json"));
    pin.webrtcNative.version = "0.0.1-old";
    writeFileSync(at("game/addons/onelobby/PIN.json"), JSON.stringify(pin, null, 2) + "\n");
    const r = await j(["update", "game", "--addon-from", "v1", "--webrtc-dir", "game/addons/godot_webrtc"]);
    expect(r.json.natives).toMatchObject({ status: "install", source: "dir" });
    expect(r.json.natives.why).toContain("0.0.1-old");
    expect(JSON.parse(text("game/addons/onelobby/PIN.json")).webrtcNative.version).toBe(WEBRTC_NATIVE_VERSION);
  });

  it("--no-natives keeps the old pin's natives record and says so", async () => {
    await game();
    const pin = JSON.parse(text("game/addons/onelobby/PIN.json"));
    pin.webrtcNative.version = "0.0.1-old";
    writeFileSync(at("game/addons/onelobby/PIN.json"), JSON.stringify(pin, null, 2) + "\n");
    const r = await j(["update", "game", "--addon-from", "v2", "--no-natives"]);
    expect(r.json.natives).toMatchObject({ status: "skipped", reason: "--no-natives" });
    expect(JSON.parse(text("game/addons/onelobby/PIN.json")).webrtcNative.version).toBe("0.0.1-old");
    const words = await cli(["update", "game", "--addon-from", "v2", "--no-natives"]);
    expect(words.out).toContain("natives were not checked (--no-natives)");
  });

  it("a download goes through the checked path (no network in this test: a failing fetch is download_failed and nothing changes)", async () => {
    await game();
    rmSync(at("game/addons/godot_webrtc"), { recursive: true });
    const before = snapshot(at("game"));
    const r = await j(["update", "game", "--addon-from", "v2"], { fetch: async () => { throw new Error("offline"); } });
    expect(r.json.error.code).toBe("download_failed");
    expect(snapshot(at("game"))).toEqual(before);
  });

  it("a dry run downloads nothing", async () => {
    await game();
    rmSync(at("game/addons/godot_webrtc"), { recursive: true });
    let fetched = 0;
    const r = await j(["update", "game", "--addon-from", "v1", "--dry-run"], { fetch: async () => (fetched++, null) });
    expect(r.json.natives.status).toBe("install");
    expect(fetched).toBe(0);
  });
});

describe("update: the managed blocks", () => {
  it("refreshes a stale .gitignore block and counts as a change", async () => {
    await game();
    const old = text("game/.gitignore").replace("\n.onelobby/", "");
    writeFileSync(at("game/.gitignore"), "node_modules/\n" + old);
    const r = await j(["update", "game", "--addon-from", "v1", "--no-natives"]);
    expect(r.json).toMatchObject({ current: false, blocks: [".gitignore"], files: { changed: [], added: [], removed: [] } });
    expect(text("game/.gitignore")).toContain(".onelobby/");
    expect(text("game/.gitignore").startsWith("node_modules/\n")).toBe(true);
  });
});

describe("update: other folders", () => {
  it("a web game: prints the npm line and the glue state, writes nothing", async () => {
    await cli(["web", "--yes", "--no-git", "--no-install"]);
    const before = snapshot(at("web"));
    const r = await j(["update", "web"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, template: "web", changed: false, glue: { path: "src/session.js", state: "identical" } });
    expect(r.json.install).toMatch(/^npm install onelobby@\^\d+\.\d+\.\d+$/);
    expect(snapshot(at("web"))).toEqual(before);
    writeFileSync(at("web/src/session.js"), "// mine\n");
    const words = await cli(["update", "web"]);
    expect(words.out).toContain("differs from this version's glue");
    expect(words.out).toContain("npm install onelobby@^");
    expect(text("web/src/session.js")).toBe("// mine\n");
  });

  it("a web --into game uses multiplayer/session.js", async () => {
    mkdirSync(at("into"));
    await cli(["--into", "into", "--yes"]);
    const r = await j(["update", "into"]);
    expect(r.json.glue).toEqual({ path: "multiplayer/session.js", state: "identical" });
  });

  it("a Godot C# project is template_planned", async () => {
    mkdirSync(at("cs"));
    writeFileSync(at("cs/project.godot"), "config_version=5\n");
    writeFileSync(at("cs/cs.csproj"), "<Project/>");
    expect((await j(["update", "cs"])).json.error.code).toBe("template_planned");
  });

  it("a folder that is no game is not_a_project; a missing folder is no_such_dir", async () => {
    mkdirSync(at("empty"));
    const r = await j(["update", "empty"]);
    expect(r.json.error.code).toBe("not_a_project");
    expect((await j(["update", "nope"])).json.error.code).toBe("no_such_dir");
  });

  it("scaffolding into a folder called update still works with ./update", async () => {
    const r = await cli(["./update", "--yes", "--no-git", "--no-install", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Dry run");
  });
});
