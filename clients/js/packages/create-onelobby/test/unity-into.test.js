// unity --into on an existing project: the tarball line, game.title and the play entry. No Unity, no network.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-unityinto-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
const put = (rel, body = "") => {
  mkdirSync(join(cwd, rel, ".."), { recursive: true });
  writeFileSync(join(cwd, rel), body);
};
async function run(args) {
  let out = "";
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: () => {} }, stdin: Readable.from([""]), stdinIsTTY: false, env: {}, cwd, resolveUnity: () => ({ exe: join(cwd, "none.exe"), version: "6000.1.5f1", from: "$UNITY" }) };
  const code = await main(args, io);
  return { code, json: JSON.parse(out) };
}
const manifest = (line) => `{\n  "dependencies": {\n${line}    "com.unity.modules.ui": "1.0.0"\n  }\n}\n`;
const INTO = ["--into", "mygame", "--template", "unity", "--yes", "--json", "--dry-run"];

describe("unity --into Next lines", () => {
  beforeEach(() => put("mygame/ProjectSettings/ProjectVersion.txt", "m_EditorVersion: 6000.1.5f1\n"));

  it("a manifest that already points at an existing tarball gets no 'put the tarball' line", async () => {
    put("mygame/Packages/manifest.json", manifest('    "com.onelobby.unity": "file:com.onelobby.unity-0.7.2.tgz",\n'));
    put("mygame/Packages/com.onelobby.unity-0.7.2.tgz", "x");
    const next = (await run(INTO)).json.next.join("\n");
    expect(next).not.toContain("put the package tarball");
    expect(next).not.toContain("no such file");
  });
  it("a manifest line whose tarball is missing says exactly that", async () => {
    put("mygame/Packages/manifest.json", manifest('    "com.onelobby.unity": "file:com.onelobby.unity-0.7.2.tgz",\n'));
    expect((await run(INTO)).json.next.join("\n")).toContain("no such file is in Packages/");
  });
  it("negative control: a manifest with no OneLobby line still gets the tarball line", async () => {
    put("mygame/Packages/manifest.json", manifest(""));
    expect((await run(INTO)).json.next.join("\n")).toContain("put the package tarball next to the manifest");
  });
  it("says game.title came from the folder name, and not when --title was given; no .olc entry for an existing project", async () => {
    put("mygame/Packages/manifest.json", manifest(""));
    const r = await run(INTO);
    expect(r.json.next.join("\n")).toContain("game.title");
    expect(r.json.files.some((f) => f.startsWith(".olc"))).toBe(false);
    const named = await run([...INTO, "--title", "My Game"]);
    expect(named.json.next.join("\n")).not.toContain("came from the folder name");
  });
  it("negative control: a new project still gets its .olc entry", async () => {
    const r = await run(["fresh", "--template", "unity", "--yes", "--json", "--dry-run"]);
    expect(r.json.files).toContain(".olc/fresh.json");
  });
});
