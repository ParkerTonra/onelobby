// The "Next:" `cd` line: a game outside the working folder gets an absolute path, never a climb of `..`. No Unity, no network.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";
import { cdPath } from "../src/flags.js";

const fwd = (p) => resolve(p).split("\\").join("/");

describe("cdPath", () => {
  it("the working folder itself is '.', a folder below it is relative", () => {
    expect(cdPath(resolve("/a/b"), resolve("/a/b"))).toBe(".");
    expect(cdPath(resolve("/a/b"), resolve("/a/b/game"))).toBe(join("game"));
  });
  it("a folder outside the working folder is the absolute path with forward slashes, quoted when it has a space", () => {
    expect(cdPath(resolve("/a/b/c/d"), resolve("/x/game"))).toBe(fwd("/x/game"));
    expect(cdPath(resolve("/a/b"), resolve("/a/other"))).toBe(fwd("/a/other"));
    expect(cdPath(resolve("/a/b"), resolve("/x/my game"))).toBe(`"${fwd("/x/my game")}"`);
  });
  it("negative control: the old form (relative() alone) climbed with '..'", () => {
    expect(cdPath(resolve("/a/b/c/d"), resolve("/x/game"))).not.toContain("..");
  });
});

describe("Next: lines of a run started outside the game folder", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "create-onelobby-cd-"));
    mkdirSync(join(root, "work", "deep", "er"), { recursive: true });
    mkdirSync(join(root, "game", "ProjectSettings"), { recursive: true });
    mkdirSync(join(root, "game", "Packages"), { recursive: true });
    writeFileSync(join(root, "game", "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.1.5f1\n");
    writeFileSync(join(root, "game", "Packages", "manifest.json"), '{\n  "dependencies": {\n    "com.unity.modules.ui": "1.0.0"\n  }\n}\n');
    mkdirSync(join(root, "work", "webgame"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  async function run(cwd, args) {
    let out = "";
    const io = { stdout: { write: (s) => (out += s) }, stderr: { write: () => {} }, stdin: Readable.from([""]), stdinIsTTY: false, env: {}, cwd, resolveUnity: () => ({ exe: join(root, "none.exe"), version: "6000.1.5f1", from: "$UNITY" }) };
    await main(args, io);
    return JSON.parse(out);
  }
  it("unity --into: the cd line is the absolute game path, no '..'", async () => {
    const r = await run(join(root, "work", "deep", "er"), ["--into", join(root, "game"), "--template", "unity", "--yes", "--json", "--dry-run"]);
    const cd = r.next.find((l) => l.startsWith("cd "));
    expect(cd).toBe(`cd ${fwd(join(root, "game"))}`);
    expect(cd).not.toContain("..");
  });
  it("unity --into from the folder above the game: still the short relative cd", async () => {
    const r = await run(root, ["--into", "game", "--template", "unity", "--yes", "--json", "--dry-run"]);
    expect(r.next.find((l) => l.startsWith("cd "))).toBe("cd game");
  });
  it("web --into a folder outside the working folder: absolute cd", async () => {
    writeFileSync(join(root, "work", "webgame", "index.html"), "<html></html>");
    const r = await run(join(root, "game"), ["--into", join(root, "work", "webgame"), "--template", "web", "--yes", "--json", "--dry-run"]);
    const cd = r.next.find((l) => l.startsWith("cd "));
    expect(cd).toBe(`cd ${fwd(join(root, "work", "webgame"))}`);
  });
});

describe("update from another folder", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "create-onelobby-upd-"));
    mkdirSync(join(root, "game", "ProjectSettings"), { recursive: true });
    mkdirSync(join(root, "game", "Packages"), { recursive: true });
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    writeFileSync(join(root, "game", "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.1.5f1\n");
    writeFileSync(join(root, "game", "Packages", "manifest.json"), '{\n  "dependencies": {\n    "com.onelobby.unity": "file:com.onelobby.unity-0.7.0.tgz"\n  }\n}\n');
    writeFileSync(join(root, "game", "Packages", "com.onelobby.unity-0.8.0.tgz"), "x");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  async function run(cwd, args) {
    let out = "";
    const io = { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (out += s) }, stdin: Readable.from([""]), stdinIsTTY: false, env: {}, cwd };
    await main(args, io);
    return JSON.parse(out);
  }
  it("`update <game folder> --package-from <path from the cwd>` moves the line without cwd being the game", async () => {
    const r = await run(join(root, "elsewhere"), ["update", join(root, "game"), "--package-from", join("..", "game", "Packages", "com.onelobby.unity-0.8.0.tgz"), "--json", "--dry-run"]);
    expect(r.ok).toBe(true);
    expect(r.package.to).toBe("file:com.onelobby.unity-0.8.0.tgz");
  });
  it("negative control: with the cwd as the game and a path relative to the game, the same line moves", async () => {
    const r = await run(join(root, "game"), ["update", "--package-from", "Packages/com.onelobby.unity-0.8.0.tgz", "--json", "--dry-run"]);
    expect(r.package.to).toBe("file:com.onelobby.unity-0.8.0.tgz");
  });
  it("negative control: the same relative path from another folder is a bad_package_from (the path is read from the cwd)", async () => {
    const r = await run(join(root, "elsewhere"), ["update", join(root, "game"), "--package-from", "Packages/com.onelobby.unity-0.8.0.tgz", "--json", "--dry-run"]);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("bad_package_from");
  });
});
