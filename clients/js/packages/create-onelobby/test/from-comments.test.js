// --from keeps the $comment keys of the file it reads (the loader drops them; they hold the reasons).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { carryComments } from "../src/blueprint.js";
import { main } from "../src/cli.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-from-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
async function run(args) {
  let out = "";
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: () => {} }, stdin: Readable.from([""]), stdinIsTTY: false, env: {}, cwd };
  const code = await main(args, io);
  return { code, out };
}

describe("--from keeps $comment", () => {
  it("top-level and section comments survive into the written onelobby.json, and the file still loads", async () => {
    mkdirSync(join(cwd, "g"));
    writeFileSync(join(cwd, "g/package.json"), '{"type":"module"}');
    writeFileSync(join(cwd, "from.json"), JSON.stringify({ $comment: "why this file", game: { id: "com.example.x" }, lobby: { $comment: "4 seats: the map has 4 spawns", maxPlayers: 4 }, sync: { mode: "raw" } }));
    const r = await run(["--into", "g", "--template", "web", "--from", "from.json", "--yes", "--json"]);
    expect(r.code).toBe(0);
    const written = JSON.parse(readFileSync(join(cwd, "g/onelobby.json"), "utf8"));
    expect(written.$comment).toBe("why this file");
    expect(written.lobby.$comment).toBe("4 seats: the map has 4 spawns");
    expect(Object.keys(written)[0]).toBe("$schema");
    const again = await run(["verify", "--into", "g", "--json"]); // the file with comments loads
    expect(JSON.parse(again.out).checks.find((c) => c.name === "blueprint").status).toBe("ok");
  });
  it("negative control: without --from there is no $comment, and carryComments skips sections the file lacks", async () => {
    mkdirSync(join(cwd, "h"));
    await run(["--into", "h", "--template", "web", "--yes", "--game-id", "com.example.h", "--json"]);
    expect(readFileSync(join(cwd, "h/onelobby.json"), "utf8")).not.toContain("$comment");
    const file = { a: { b: 1 } };
    carryComments(file, { $comment: "top", missing: { $comment: "x" }, a: { $comment: "in a" } });
    expect(file).toEqual({ $comment: "top", a: { $comment: "in a", b: 1 } });
    expect(Object.keys(file)).toEqual(["$comment", "a"]);
  });
});
