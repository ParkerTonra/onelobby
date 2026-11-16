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
  it("node-datachannel installed counts too", () => {
    put("node_modules/node-datachannel/package.json", "{}");
    expect(nodeDatachannelIn(dir)).toBe("installed");
    expect(skipReason(dir)).toContain("is installed here");
  });
});
