// --into for a Godot project: the play entry is written only where olc would read it, and a node named Net made at run time is caught.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";
import { repoAbove } from "../src/godot.js";
import { runtimeNodeNamed } from "../src/godot-names.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-olc-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
const put = (rel, body = "") => {
  mkdirSync(join(cwd, rel, ".."), { recursive: true });
  writeFileSync(join(cwd, rel), body);
};
async function run(args) {
  let out = "";
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: () => {} }, stdin: Readable.from([""]), stdinIsTTY: false, env: {}, cwd };
  const code = await main(args, io);
  return { code, json: JSON.parse(out) };
}
const godot = (dir) => put(`${dir}/project.godot`, "config_version=5\n\n[application]\nconfig/name=\"G\"\n");
const ARGS = (dir) => ["--into", dir, "--template", "godot-gdscript", "--yes", "--json", "--dry-run", "--no-natives"];

describe("the play entry and the repository root", () => {
  it("a project in a subfolder of a repository gets no .olc entry, and the Next lines say why", async () => {
    mkdirSync(join(cwd, "repo/.git"), { recursive: true });
    godot("repo/game");
    expect(repoAbove(join(cwd, "repo/game"))).toBe(join(cwd, "repo"));
    const r = await run(ARGS("repo/game"));
    expect(r.json.files.some((f) => f.startsWith(".olc"))).toBe(false);
    expect(r.json.next.join("\n")).toContain("olc reads .olc/ at the repository root");
  });
  it("negative control: a project that is the repository root, or has no repository above it, keeps its entry", async () => {
    mkdirSync(join(cwd, "root/.git"), { recursive: true });
    godot("root");
    godot("loose");
    for (const d of ["root", "loose"]) {
      const r = await run(ARGS(d));
      expect(r.json.files).toContain(".olc/" + d + ".json");
    }
    expect(repoAbove(join(cwd, "root"))).toBeNull();
  });
});

describe("a node named Net made in code", () => {
  it("is found, and --into stops with name_clash naming the file", async () => {
    godot("g");
    put("g/world.gd", 'extends Node\nfunc _ready():\n\tvar n := Node.new()\n\tn.name = "Net"\n\tadd_child(n)\n');
    expect(runtimeNodeNamed(join(cwd, "g"), "Net")).toBe("world.gd");
    const r = await run(ARGS("g"));
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("name_clash");
    expect(r.json.error.message).toContain("world.gd");
    expect(r.json.error.message).toContain("makes a node named Net at run time");
  });
  it("also finds get_node(\"/root/Net\"); negative control: a longer name or none is no clash", async () => {
    godot("g2");
    put("g2/a.gd", 'func f():\n\treturn get_node("/root/Net")\n');
    expect(runtimeNodeNamed(join(cwd, "g2"), "Net")).toBe("a.gd");
    godot("g3");
    put("g3/b.gd", 'func f():\n\tn.name = "Network"\n\treturn get_node("/root/NetService")\n');
    expect(runtimeNodeNamed(join(cwd, "g3"), "Net")).toBeNull();
    expect((await run(ARGS("g3"))).code).toBe(0);
  });
});
