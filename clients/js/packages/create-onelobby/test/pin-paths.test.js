// A PIN.json key that leaves addons/onelobby/ (review of `update` / `verify`). No network, no Godot.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";
import { sha256, verifyPin } from "../src/vendor.js";
import { godotChecks } from "../src/verify/godot.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-safety-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

async function cli(args) {
  let out = "";
  let err = "";
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, stdin: Readable.from([""]), stdinIsTTY: false, env: {}, cwd };
  const code = await main(args, io);
  return { code, out, err };
}
const snapshot = (dir, rel = "") =>
  Object.fromEntries(
    readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
      const r = `${rel}${e.name}`;
      return e.isDirectory() ? Object.entries(snapshot(dir, `${r}/`)) : [[r, readFileSync(join(dir, r)).toString("hex") + statSync(join(dir, r)).mtimeMs]];
    }),
  );

const BAD_KEYS = ["../outside.txt", "/abs", "a\\b", "C:/x", "a/../../outside.txt", "a//b", "./x", "x\0y"];
const CLIENT = "class_name OneLobbyClient\nextends Node\n";

/** A game whose pin lists the client and one hostile key; a real file sits where `../outside.txt` points. */
function hostileGame(key) {
  const g = join(cwd, "game");
  rmSync(g, { recursive: true, force: true });
  mkdirSync(join(g, "addons/onelobby"), { recursive: true });
  writeFileSync(join(g, "project.godot"), "config_version=5\n");
  writeFileSync(join(g, "onelobby.json"), "{}");
  writeFileSync(join(g, "addons/onelobby/client.gd"), CLIENT);
  writeFileSync(join(g, "addons/outside.txt"), "precious\n");
  const files = { "client.gd": sha256(Buffer.from(CLIENT)), [key]: sha256(Buffer.from("precious\n")) };
  writeFileSync(join(g, "addons/onelobby/PIN.json"), JSON.stringify({ createOnelobby: "0.0.0", source: { commit: "x" }, webrtcNative: { version: "x" }, files }, null, 2));
  mkdirSync(join(cwd, "v2/clients/gdscript/addons/onelobby"), { recursive: true });
  writeFileSync(join(cwd, "v2/clients/gdscript/addons/onelobby/client.gd"), CLIENT + "var v := 2\n");
  return g;
}

describe("a PIN.json key that leaves addons/onelobby/", () => {
  for (const key of BAD_KEYS) {
    const shown = JSON.stringify(key);
    for (const extra of [[], ["--force"], ["--dry-run"], ["--json"], ["--force", "--json"]]) {
      it(`update ${extra.join(" ")} refuses ${shown} with bad_pin and touches nothing`, async () => {
        const g = hostileGame(key);
        const before = snapshot(g);
        const r = await cli(["update", "game", "--addon-from", "v2", "--no-natives", ...extra]);
        expect(r.code).toBe(1);
        if (extra.includes("--json")) {
          const e = JSON.parse(r.out).error;
          expect(e.code).toBe("bad_pin");
          expect(e.message).toContain(JSON.stringify(key));
        } else expect(r.err).toContain(JSON.stringify(key));
        expect(snapshot(g)).toEqual(before);
        expect(readFileSync(join(g, "addons/outside.txt"), "utf8")).toBe("precious\n");
      });
    }
    it(`verifyPin throws bad_pin for ${shown} and the addon-pin check FAILs instead of throwing`, async () => {
      const g = hostileGame(key);
      expect(() => verifyPin(g)).toThrowError(expect.objectContaining({ code: "bad_pin" }));
      const check = godotChecks().find((c) => c.name === "addon-pin");
      const r = await check.run({ dir: g });
      expect(r.status).toBe("fail");
      expect(r.detail).toContain("not a plain relative path");
      expect(readFileSync(join(g, "addons/outside.txt"), "utf8")).toBe("precious\n");
    });
  }

  it("a clean nested key is still fine", () => {
    const g = hostileGame("menu/menu.tscn");
    mkdirSync(join(g, "addons/onelobby/menu"));
    writeFileSync(join(g, "addons/onelobby/menu/menu.tscn"), "precious\n");
    expect(verifyPin(g).missing).toEqual([]);
  });
});
