// What verify says about a game that keeps its own sync (the `direct` line must not read as "your netcode works"), and which engine it
// prints for a web-kind folder (a Node host is not "web").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

// the Godot process is faked: it answers what a passing two-peer test prints
vi.mock("../src/verify/procs.js", async (orig) => ({ ...(await orig()), run: vi.fn(async () => ({ code: 0, timedOut: false, out: "MULTIPLAYER_OK\nVERIFY_PROBE_OK direct\n" })) }));
const { main } = await import("../src/cli.js");
const { godotChecks } = await import("../src/verify/godot.js");
const { ownNetcodeNote } = await import("../src/verify/core.js");

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-recipeweb-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
const put = (path, text = "") => {
  mkdirSync(join(cwd, path, ".."), { recursive: true });
  writeFileSync(join(cwd, path), text);
};

describe("verify's direct line for a game with its own sync", () => {
  const direct = () => godotChecks().find((c) => c.name === "direct");
  const runDirect = (mode, withTest = true) => {
    if (withTest) put("tests/multiplayer.gd", "# test");
    return direct().run({ dir: cwd, env: {}, godot: { exe: "godot" }, facts: { direct: true, mode } });
  };
  it("raw and replication: the ok line says NOT this game's own netcode and what to do", async () => {
    for (const mode of ["raw", "replication"]) {
      const r = await runDirect(mode);
      expect(r.status).toBe("ok");
      expect(r.detail).toContain(`NOT this game's own netcode (sync.mode ${mode})`);
      expect(r.detail).toContain("run the game's own two-player test and name it in the report");
    }
  });
  it("the bundled-probe branch says it too", async () => {
    const r = await runDirect("raw", false);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("the bundled probe");
    expect(r.detail).toContain("NOT this game's own netcode");
  });
  it("negative control: lockstep (the game plugs into the test) and an unknown mode say nothing of the kind", async () => {
    expect((await runDirect("lockstep")).detail).not.toContain("NOT this game");
    expect((await runDirect(undefined)).detail).not.toContain("NOT this game");
    expect(ownNetcodeNote("lockstep")).toBe("");
    expect(ownNetcodeNote("raw")).toContain("sync.mode raw");
  });
});

describe("verify's header names the engine of a web-kind folder", () => {
  async function verifyHeader(blueprint, glue) {
    put("g/onelobby.json", JSON.stringify(blueprint));
    if (glue) put("g/multiplayer/session.js", "");
    let out = "";
    const io = { stdout: { write: (s) => (out += s) }, stderr: { write: () => {} }, stdin: Readable.from([""]), stdinIsTTY: false, env: {}, cwd, verifyChecks: () => [{ name: "a", run: async () => ({ status: "ok" }) }] };
    await main(["verify", "g", ...(blueprint.json ? ["--json"] : [])], io);
    return out;
  }
  it("a node-browser blueprint prints (node-browser), with no glue file", async () => {
    expect(await verifyHeader({ engine: "node-browser" }, false)).toContain("(node-browser)\n");
  });
  it("negative control: a browser game still prints (web), and --json carries engine next to kind", async () => {
    expect(await verifyHeader({ game: { id: "com.x.y" } }, true)).toContain("(web)\n");
    const json = JSON.parse(await verifyHeader({ engine: "node-browser", json: 1 }, false).catch(() => "{}"));
    expect(json).toMatchObject({ kind: "web", engine: "node-browser" });
  });
});
