// Natives already in a game are compared with the pinned version: --into says when they differ, the pin records what is true, verify warns.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";
import { WEBRTC_NATIVE_VERSION, existingNativesVersion, nativesDifferLine } from "../src/vendor.js";
import { godotChecks } from "../src/verify/godot.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-natives-"));
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
  return { code, out, json: out.trim().startsWith("{") ? JSON.parse(out) : undefined };
}
const game = () => {
  put("g/project.godot", 'config_version=5\n\n[application]\nconfig/name="G"\n');
  put("g/addons/godot_webrtc/webrtc_native.gdextension", "[configuration]\n");
};

describe("natives that are already there", () => {
  it("--into says their version is unknown (no record), keeps them, and the pin records 'unknown' rather than the pinned version", async () => {
    game();
    const r = await run(["--into", "g", "--template", "godot-gdscript", "--yes", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json.natives.status).toBe("present");
    expect(r.json.next.join("\n")).toContain("their version is unknown");
    expect(JSON.parse(readFileSync(join(cwd, "g/addons/onelobby/PIN.json"), "utf8")).webrtcNative.version).toBe("unknown");
  });
  it("a recorded older version is named; the pinned one says nothing", async () => {
    game();
    put("g/addons/onelobby/PIN.json", JSON.stringify({ files: {}, webrtcNative: { version: "1.0.0-stable" } }));
    expect(existingNativesVersion(join(cwd, "g"), { present: true, replacing: false })).toBe("1.0.0-stable");
    expect(nativesDifferLine("1.0.0-stable")).toContain("not the pinned " + WEBRTC_NATIVE_VERSION);
    expect(nativesDifferLine(WEBRTC_NATIVE_VERSION)).toBeNull();
    expect(nativesDifferLine(null)).toBeNull();
  });
  it("negative control: --force replaces them (no found version), and a folder with no natives has none to compare", () => {
    game();
    expect(existingNativesVersion(join(cwd, "g"), { present: true, replacing: true })).toBeNull();
    expect(existingNativesVersion(join(cwd, "g"), { present: false, replacing: false })).toBeNull();
  });
  it("verify's natives check warns when the version is unknown or older, and not when it is the pin", async () => {
    game();
    put("g/.godot/extension_list.cfg", "res://addons/godot_webrtc/webrtc_native.gdextension\n");
    put("g/.godot/global_script_class_cache.cfg", "OneLobbyClient\n");
    const natives = godotChecks().find((c) => c.name === "natives");
    const warn = (await natives.run({ dir: join(cwd, "g") })).warning;
    expect(warn).toContain("unknown");
    put("g/addons/onelobby/PIN.json", JSON.stringify({ webrtcNative: { version: WEBRTC_NATIVE_VERSION } }));
    expect((await natives.run({ dir: join(cwd, "g") })).warning).toBeUndefined();
  });
});
