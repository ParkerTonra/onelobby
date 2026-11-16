// The command line of `verify --fetch-helpers` (review of `update` / `verify`): no shell ever parses the game folder. No network.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCommand, fetchTurnHelper, helperDir, npmCommand } from "../src/verify/turn.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-fetch-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("verify --fetch-helpers builds no shell command line", () => {
  const awkward = () => join(cwd, "a & b (c) %d% ^e");
  for (const platform of ["win32", "linux"]) {
    it(`${platform}: the folder arrives as ONE argument to node running npm's own script, no cmd.exe, no shell`, async () => {
      const dir = awkward();
      mkdirSync(dir);
      const calls = [];
      const runImpl = async (file, args, opts) => (calls.push({ file, args, opts }), { code: 0, out: "added 1 package" });
      const execPath = platform === "win32" ? "C:\\node\\node.exe" : "/usr/bin/node";
      const exists = (p) => p.replace(/\\/g, "/").endsWith("npm/bin/npm-cli.js");
      await fetchTurnHelper(dir, { runImpl, platform, execPath, env: {}, exists });
      expect(calls).toHaveLength(1);
      const { file, args, opts } = calls[0];
      expect(file).toBe(execPath);
      expect(file.toLowerCase()).not.toContain("cmd");
      expect(args[0].replace(/\\/g, "/")).toMatch(/npm\/bin\/npm-cli\.js$/);
      expect(args.slice(1)).toEqual(["install", "--prefix", helperDir(dir), "node-turn@0.0.6", "--no-audit", "--no-fund", "--ignore-scripts"]);
      expect(args.filter((a) => a === helperDir(dir))).toHaveLength(1); // the whole path, unsplit and unquoted
      expect(args).not.toContain("/c");
      expect(opts.shell).toBeUndefined();
    });
  }

  it("$npm_execpath is used when it names npm-cli.js, and ignored when it names something else", () => {
    const exists = () => true;
    expect(npmCommand(["x"], { platform: "win32", execPath: "N", env: { npm_execpath: "C:\\n\\npm-cli.js" }, exists })).toEqual(["N", ["C:\\n\\npm-cli.js", "x"]]);
    expect(npmCommand(["x"], { platform: "linux", execPath: "/n/bin/node", env: { npm_execpath: "/y/yarn.js" }, exists })).toEqual(["/n/bin/node", ["/n/bin/../lib/node_modules/npm/bin/npm-cli.js", "x"]]);
  });

  it("no npm script found: Windows says so and prints the command (nothing is run), elsewhere npm is spawned directly", async () => {
    const calls = [];
    const runImpl = async (...a) => (calls.push(a), { code: 0, out: "" });
    const none = () => false;
    const r = await fetchTurnHelper(awkward(), { runImpl, platform: "win32", execPath: "C:\\n\\node.exe", env: {}, exists: none });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("run it yourself");
    expect(calls).toHaveLength(0);
    expect(npmCommand(["i"], { platform: "linux", execPath: "/n/node", env: {}, exists: none })).toEqual(["npm", ["i"]]);
  });

  it("the printed command quotes the folder for the shell it is printed for", () => {
    const dir = awkward();
    const posix = fetchCommand(dir, "linux");
    expect(posix).toContain(`'${helperDir(dir)}'`);
    expect(fetchCommand("/x/it's here", "linux")).toContain(`'${helperDir("/x/it's here").replace(/'/g, "'\\''")}'`);
    const plain = join(cwd, "a & b (c)");
    expect(fetchCommand(plain, "win32")).toContain(`--prefix "${helperDir(plain)}" `);
    // cmd.exe cannot quote a % or a " inside a path: the line is the relative one, run in the game folder
    const win = fetchCommand(dir, "win32");
    expect(win).toContain(`--prefix ${join(".onelobby", "helpers")} `);
    expect(win).not.toContain("%d%");
    for (const c of [posix, win]) expect(c).toMatch(/node-turn@0\.0\.6 --no-audit --no-fund --ignore-scripts$/);
  });
});
