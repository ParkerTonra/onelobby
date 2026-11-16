// A Node process that hosts and serves the page (engine node-browser): the recommender names it, --into writes the blueprint and the glue
// that fit (no lockstep stand-in for a raw game), the web template still refuses hosting.direct, verify skips a missing stand-in test honestly.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";
import { detectEngine, recommend } from "../src/recommend.js";
import { webChecks } from "../src/verify/web.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-nodebrowser-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
async function cli(args) {
  let out = "";
  let err = "";
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, stdin: Readable.from([""]), stdinIsTTY: false, env: {}, cwd };
  const code = await main(args, io);
  return { code, out, err, json: out.trim().startsWith("{") ? JSON.parse(out) : undefined };
}
const at = (...p) => join(cwd, ...p);
const put = (path, text = "") => {
  mkdirSync(join(at(path), ".."), { recursive: true });
  writeFileSync(at(path), text);
};
const SENTENCE = "browser ant game, a Node server runs the match loop for up to 8 players and the host's node process serves the page";

describe("the recommender can say \"a Node process hosts\"", () => {
  it("a Node server / host sentence is engine node-browser with hosting.direct true", () => {
    expect(detectEngine("a Node.js server hosts the match").id).toBe("node-browser");
    const rec = recommend({ description: SENTENCE });
    expect(rec.engine.id).toBe("node-browser");
    const rows = Object.fromEntries(rec.answers.map((r) => [r[0], r[1]]));
    expect(rows["hosting.direct"]).toBe(true);
    expect(rows["hosting.server"]).toBe(false);
    expect(rows["lobby.maxPlayers"]).toBe(8);
    expect(rec.runCommand).toContain("--into .");
    expect(rec.runCommand).toContain("--template node-browser");
  });
  it("negative control: the same game with no Node word stays a browser game (direct false), and a Godot node sentence stays Godot", () => {
    const web = recommend({ description: "browser ant game for up to 8 players, the host runs the match" });
    expect(web.engine.id).toBe("web");
    expect(Object.fromEntries(web.answers.map((r) => [r[0], r[1]]))["hosting.direct"]).toBe(false);
    expect(detectEngine("a Godot game where each scene node moves").id).toBe("godot-gdscript");
    expect(detectEngine("a browser node graph editor")?.id).toBe("web");
  });
});

describe("--into --template node-browser", () => {
  it("a raw game gets the blueprint and the glue, no lockstep stand-in, and a CommonJS package keeps working (.mjs glue)", async () => {
    put("g/package.json", '{ "name": "g", "main": "server.js" }');
    const r = await cli(["--into", "g", "--template", "node-browser", "--mode", "raw", "--yes", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json.files).toEqual(["onelobby.json", "multiplayer/session.mjs"]);
    expect(r.json.blueprint).toMatchObject({ engine: "node-browser", hosting: { direct: true, server: false }, sync: { mode: "raw" } });
    expect(existsSync(at("g/test/multiplayer.mjs"))).toBe(false);
    const next = r.json.next.join("\n");
    expect(next).toContain("a Node process hosts this game");
    expect(next).toContain("kit.blueprint");
    expect(next).toContain('bindHost: "127.0.0.1"');
    expect(next).toContain("no lockstep stand-in test was written");
    expect(next).toContain("importmap");
    expect(next).toContain("game.title");
    expect(next).not.toContain("node test/multiplayer.mjs");
    expect(readFileSync(at("g/package.json"), "utf8")).toBe('{ "name": "g", "main": "server.js" }');
  });
  it("a lockstep game still gets the stand-in test", async () => {
    put("g/package.json", '{ "type": "module" }');
    const r = await cli(["--into", "g", "--template", "node-browser", "--mode", "lockstep", "--yes", "--json"]);
    expect(r.json.files).toEqual(["onelobby.json", "multiplayer/session.js", "test/multiplayer.mjs"]);
  });
  it("the recommendation's blueprint loads: --recommend with --into writes direct true", async () => {
    put("g/package.json", "{}");
    const r = await cli(["--into", "g", "--recommend", SENTENCE, "--yes", "--json", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.json.template).toBe("node-browser");
    expect(r.json.blueprint.hosting.direct).toBe(true);
    expect(r.json.blueprint.lobby.maxPlayers).toBe(8);
  });
  it("without --into it says so (a Node game already has its server) and names what to run", async () => {
    const r = await cli(["x", "--template", "node-browser", "--yes", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("unsupported");
    expect(r.json.error.message).toContain("--into");
    expect(r.json.error.message).toContain('"node-browser"');
  });
  it("negative control: the web template still refuses hosting.direct", async () => {
    put("w/package.json", "{}");
    const r = await cli(["--into", "w", "--template", "web", "--hosting", "direct", "--yes", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("bad_config");
  });
});

describe("verify for a node-browser game with no stand-in test", () => {
  const check = (name) => webChecks().find((c) => c.name === name);
  it("a raw game: project-test is skipped with the reason, not failed", async () => {
    put("onelobby.json", JSON.stringify({ sync: { mode: "raw" } }));
    const r = await check("project-test").run({ dir: cwd, env: {} });
    expect(r.status).toBe("skipped");
    expect(r.detail).toContain("sync.mode is raw");
    expect(r.detail).toContain("its own two-player test");
  });
  it("negative control: a lockstep game with the test missing still fails", async () => {
    put("onelobby.json", JSON.stringify({ sync: { mode: "lockstep" } }));
    const r = await check("project-test").run({ dir: cwd, env: {} });
    expect(r.status).toBe("fail");
  });
});
