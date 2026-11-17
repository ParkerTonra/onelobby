// verify for a web game: what project-test says it proved, and the true reason nostr and turn are skipped. No network, no browser.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeDatachannelIn, projectTestDetail, skipReason, syncModeOf, webChecks } from "../src/verify/web.js";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "create-onelobby-verifyweb-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const put = (rel, body) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
};
const check = (name) => webChecks().find((c) => c.name === name);
const game = (mode) => {
  put("onelobby.json", JSON.stringify({ sync: { mode } }));
  put("node_modules/onelobby/package.json", "{}");
  put("test/multiplayer.mjs", 'console.log("PASS one");\nconsole.log("PASS two");\n');
};

describe("project-test says what it proved", () => {
  it("raw: the stand-in only, not the game's netcode", async () => {
    game("raw");
    const r = await check("project-test").run({ dir, env: process.env });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("2 checks passed");
    expect(r.detail).toContain("NOT this game's own netcode (sync.mode raw)");
  });
  it("replication says the same", () => {
    expect(projectTestDetail(3, "replication")).toContain("NOT this game's own netcode (sync.mode replication)");
  });
  it("negative control: lockstep does not carry the warning", async () => {
    game("lockstep");
    const r = await check("project-test").run({ dir, env: process.env });
    expect(r.status).toBe("ok");
    expect(r.detail).not.toContain("NOT");
    expect(r.detail).toContain("lockstep game bound in this test");
  });
  it("syncModeOf reads the mode, and null when the file is unreadable", () => {
    put("onelobby.json", JSON.stringify({ sync: { mode: "raw" } }));
    expect(syncModeOf(dir)).toBe("raw");
    put("onelobby.json", "{nope");
    expect(syncModeOf(dir)).toBeNull();
  });
});

describe("nostr and turn skip reasons are true for this folder", () => {
  it("no node-datachannel anywhere: says so, and that a browser page has WebRTC of its own", async () => {
    put("package.json", JSON.stringify({ dependencies: { onelobby: "^1" } }));
    expect(nodeDatachannelIn(dir)).toBeNull();
    const r = await check("nostr").run({ dir });
    expect(r.status).toBe("skipped");
    expect(r.detail).toContain("this folder has none");
    expect(r.detail).not.toContain("does not depend on");
  });
  it("node-datachannel listed in optionalDependencies: the reason does not say the game lacks it", async () => {
    put("package.json", JSON.stringify({ optionalDependencies: { "node-datachannel": "^0.33.4" } }));
    expect(nodeDatachannelIn(dir)).toBe("listed");
    for (const name of ["nostr", "turn"]) {
      const r = await check(name).run({ dir });
      expect(r.status).toBe("skipped");
      expect(r.detail).toContain("listed in package.json");
      expect(r.detail).toContain("verify does not start JS peers for a web game");
      expect(r.detail).not.toContain("this folder has none");
    }
  });
  it("names the real game kind: a node-browser game is not called a web game", async () => {
    put("package.json", JSON.stringify({ optionalDependencies: { "node-datachannel": "^0.33.4" } }));
    put("onelobby.json", JSON.stringify({ engine: "node-browser" }));
    for (const name of ["nostr", "turn"]) {
      const r = await check(name).run({ dir });
      expect(r.detail).toContain("verify does not start JS peers for a Node game that hosts its pages");
      expect(r.detail).not.toContain("for a web game");
    }
    put("onelobby.json", JSON.stringify({ engine: "web" }));
    expect(skipReason(dir)).toContain("for a web game");
  });
  it("node-datachannel installed counts too", () => {
    put("node_modules/node-datachannel/package.json", "{}");
    expect(nodeDatachannelIn(dir)).toBe("installed");
    expect(skipReason(dir)).toContain("is installed here");
  });
});

describe("a web or Node game: the passing run says it saw no listening address", () => {
  const run = async (opts = { json: true }) => {
    let out = "";
    const io = { stdout: { write: (s) => (out += s) }, stderr: { write: () => {} }, env: process.env, cwd: dir };
    const { runVerify } = await import("../src/verify/index.js");
    const code = await runVerify({ dir, opts, io });
    return { code, out };
  };
  it("the note names the one thing to do instead, in the JSON and in the text", async () => {
    put("onelobby.json", JSON.stringify({ version: 1, game: { id: "dev.example.x", netVersion: "1" }, engine: "node-browser", hosting: { direct: true, server: false }, sync: { mode: "raw" } }));
    put("server.js", 'const { hostDirect } = await import("onelobby/direct");\n');
    const r = await run();
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.notes.join(" ")).toContain("verify starts no host for a web or Node game, so no listening address was checked");
    expect(j.notes.join(" ")).toContain("hostDirect(kit, { local: true, port: 0 })");
    const text = await run({});
    expect(text.out).toContain("note: verify starts no host for a web or Node game");
  });
});
