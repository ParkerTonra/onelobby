import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";
import { lineText, runChecks, verdictLine } from "../src/verify/core.js";
import { probeLine, resolveGodot } from "../src/verify/godot.js";
import { frameDecoder, startRelay, textFrame } from "../src/verify/relay.js";
import { findTurnHelper, fetchCommand } from "../src/verify/turn.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-verify-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const ok = (detail) => ({ status: "ok", detail });
const fake = (name, result, extra = {}) => ({ name, run: async () => result, ...extra });

async function cli(args, checks) {
  let out = "";
  let err = "";
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, stdin: Readable.from([""]), stdinIsTTY: false, env: {}, cwd, verifyChecks: checks };
  const code = await main(args, io);
  return { code, out, err };
}
const godotGame = () => {
  mkdirSync(join(cwd, "g"));
  writeFileSync(join(cwd, "g/project.godot"), "config_version=5\n");
  writeFileSync(join(cwd, "g/onelobby.json"), "{}");
};

describe("the check runner", () => {
  it("runs checks in order, one line each, then VERIFY_OK", async () => {
    const lines = [];
    const r = await runChecks([fake("a", ok("fine")), fake("b", { status: "skipped", detail: "not needed" }), fake("c", ok())], {}, { onLine: (n, t) => lines.push(`${n} ${t}`) });
    expect(lines).toEqual(["a ok (fine)", "b skipped not needed", "c ok"]);
    expect(r).toMatchObject({ ok: true, verdict: "VERIFY_OK", firstFailure: null });
  });

  it("the verdict names the FIRST failing check with its why and next step", async () => {
    const r = await runChecks([fake("a", ok()), fake("b", { status: "fail", detail: "it broke.", next: "Do this." }), fake("c", { status: "fail", detail: "later." })], {});
    expect(r.ok).toBe(false);
    expect(r.firstFailure).toBe("b");
    expect(r.verdict).toBe("VERIFY_FAIL b: it broke. Do this.");
    expect(r.verdict.split("\n")).toHaveLength(1);
  });

  it("a failed blocking check skips the rest; a failed plain check does not", async () => {
    const ran = [];
    const spy = (name, result, extra) => fake(name, result, { ...extra, run: async () => (ran.push(name), result) });
    const r = await runChecks([spy("x", { status: "fail", detail: "no" }), spy("y", ok()), spy("blk", { status: "fail", detail: "no" }, { blocking: true }), spy("z", ok())], {});
    expect(ran).toEqual(["x", "y", "blk"]);
    expect(r.results.find((c) => c.name === "z")).toMatchObject({ status: "skipped", detail: "needs the blk check, which failed" });
  });

  it("an exception inside a check is that check's FAIL", async () => {
    const r = await runChecks([{ name: "boom", run: async () => { throw new Error("kaput"); } }], {});
    expect(r.verdict).toMatch(/^VERIFY_FAIL boom: the check itself broke \(kaput\)/);
  });

  it("an ok check can carry a warning that is not a failure", () => {
    expect(lineText({ status: "ok", detail: "3 files", warning: "edited: a.gd" })).toBe("ok (3 files) WARNING: edited: a.gd");
    expect(verdictLine([{ name: "a", status: "ok", warning: "w" }])).toBe("VERIFY_OK");
  });
});

describe("verify on a folder", () => {
  it("prints each check line, then the verdict last; exit 0", async () => {
    godotGame();
    const r = await cli(["verify", "g"], () => [fake("one", ok("x")), fake("two", { status: "skipped", detail: "why" })]);
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines[1]).toMatch(/^one:\s+ok \(x\)$/);
    expect(lines[2]).toMatch(/^two:\s+skipped why$/);
    expect(lines.at(-1)).toBe("VERIFY_OK");
  });

  it("a failing check gives VERIFY_FAIL last and exit 1", async () => {
    godotGame();
    const r = await cli(["verify", "g"], () => [fake("one", { status: "fail", detail: "bad.", next: "Fix it." })]);
    expect(r.code).toBe(1);
    expect(r.out.trim().split("\n").at(-1)).toBe("VERIFY_FAIL one: bad. Fix it.");
  });

  it("--json prints one object with the same facts and only that on stdout", async () => {
    godotGame();
    const r = await cli(["verify", "g", "--json"], () => [fake("one", ok("x")), fake("two", { status: "fail", detail: "bad.", next: "Fix it." })]);
    const j = JSON.parse(r.out);
    expect(r.code).toBe(1);
    expect(j).toMatchObject({ ok: false, command: "verify", kind: "godot-gdscript", firstFailure: "two", verdict: "VERIFY_FAIL two: bad. Fix it.", summary: { ok: 1, fail: 1, skipped: 0 } });
    expect(j.checks.map((c) => [c.name, c.status])).toEqual([["one", "ok"], ["two", "fail"]]);
    expect(r.err).toContain("one:");
  });

  it("detects a web game (onelobby.json + the web glue) and --into works", async () => {
    mkdirSync(join(cwd, "w/src"), { recursive: true });
    writeFileSync(join(cwd, "w/onelobby.json"), "{}");
    writeFileSync(join(cwd, "w/src/session.js"), "");
    let kind;
    const r = await cli(["verify", "--into", "w", "--json"], (k) => ((kind = k), [fake("a", ok())]));
    expect(kind).toBe("web");
    expect(JSON.parse(r.out).kind).toBe("web");
  });

  it("anything else is a clear error, exit 1", async () => {
    mkdirSync(join(cwd, "e"));
    const r = await cli(["verify", "e"], () => []);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not a OneLobby game");
    const j = await cli(["verify", "e", "--json"], () => []);
    expect(JSON.parse(j.out).error.code).toBe("not_a_project");
    mkdirSync(join(cwd, "p"));
    writeFileSync(join(cwd, "p/project.godot"), "");
    expect((await cli(["verify", "p", "--json"], () => [])).out).toContain("no onelobby.json");
  });

  it("a Godot C# project runs the checks handed in for its kind", async () => {
    godotGame();
    writeFileSync(join(cwd, "g/g.csproj"), "<Project/>");
    const r = JSON.parse((await cli(["verify", "g", "--json"], (kind) => [fake("kind", ok(kind))])).out);
    expect(r).toMatchObject({ ok: true, kind: "godot-csharp", verdict: "VERIFY_OK" });
  });
});

describe("finding Godot", () => {
  const exists = (set) => (p) => set.includes(p.replace(/\\/g, "/"));
  it("--godot wins, then $GODOT, then PATH", () => {
    const have = exists(["/a/godot", "/b/godot", "/bin/godot"]);
    expect(resolveGodot({ flag: "/a/godot", env: { GODOT: "/b/godot" }, exists: have, platform: "linux" })).toMatchObject({ from: "--godot" });
    expect(resolveGodot({ env: { GODOT: "/b/godot" }, exists: have, platform: "linux" })).toMatchObject({ from: "$GODOT" });
    expect(resolveGodot({ env: { PATH: ["/x", "/bin"].join(delimiter) }, exists: have, platform: "linux" })).toMatchObject({ from: "PATH" });
  });
  it("nothing found is null (the check then names the three ways)", () => {
    expect(resolveGodot({ flag: "/nope/godot", env: {}, exists: exists([]), platform: "linux" })).toBeNull();
    expect(resolveGodot({ env: { PATH: "/x" }, exists: exists([]), platform: "linux" })).toBeNull();
  });
  it("reads the probe's result line", () => {
    expect(probeLine("noise\nVERIFY_PROBE_OK direct code=abc\n", "VERIFY_PROBE_OK")).toBe("direct code=abc");
    expect(probeLine("noise", "VERIFY_PROBE_OK")).toBeNull();
  });
});

describe("the TURN helper lookup", () => {
  it("is found in the game's node_modules or in .onelobby/helpers, else null, and the fetch command names the cache", () => {
    mkdirSync(join(cwd, "g"));
    expect(findTurnHelper(join(cwd, "g"))).toBeNull();
    mkdirSync(join(cwd, "g/.onelobby/helpers/node_modules/node-turn"), { recursive: true });
    writeFileSync(join(cwd, "g/.onelobby/helpers/node_modules/node-turn/package.json"), "{}");
    expect(findTurnHelper(join(cwd, "g"))).toContain("helpers");
    expect(fetchCommand(join(cwd, "g"))).toContain("node-turn@");
  });
});

describe("the built-in Nostr relay", () => {
  it("decodes masked, fragmented and long frames", () => {
    const mask = (payload, op = 0x1, fin = true) => {
      const key = Buffer.from([1, 2, 3, 4]);
      const body = Buffer.from(payload);
      const head = body.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | body.length]) : Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | 126, body.length >> 8, body.length & 255]);
      return Buffer.concat([head, key, Buffer.from(body.map((b, i) => b ^ key[i & 3]))]);
    };
    const d = frameDecoder();
    expect(d.push(mask("hello"))[0].data.toString()).toBe("hello");
    expect(d.push(Buffer.concat([mask("he", 0x1, false), mask("llo", 0x0, true)])).map((m) => m.data.toString())).toEqual(["hello"]);
    const big = "x".repeat(300);
    const split = mask(big);
    expect(d.push(split.subarray(0, 10))).toEqual([]);
    expect(d.push(split.subarray(10))[0].data.toString()).toBe(big);
    expect(textFrame("hi")).toEqual(Buffer.from([0x81, 2, 104, 105]));
  });

  it.skipIf(typeof WebSocket === "undefined")("relays an event to a matching subscription on 127.0.0.1 and stops cleanly", async () => {
    const relay = await startRelay();
    expect(relay.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    const open = (ws) => new Promise((res) => ws.addEventListener("open", res));
    const a = new WebSocket(relay.url);
    const b = new WebSocket(relay.url);
    await Promise.all([open(a), open(b)]);
    const got = [];
    b.addEventListener("message", (m) => got.push(JSON.parse(m.data)));
    b.send(JSON.stringify(["REQ", "s1", { kinds: [20000], "#t": ["room"] }]));
    await new Promise((r) => setTimeout(r, 100));
    a.send(JSON.stringify(["EVENT", { id: "e1", kind: 20000, created_at: 1, pubkey: "p", tags: [["t", "room"]], content: "x" }]));
    a.send(JSON.stringify(["EVENT", { id: "e2", kind: 20000, created_at: 1, pubkey: "p", tags: [["t", "other"]], content: "y" }]));
    await new Promise((r) => setTimeout(r, 200));
    expect(got[0]).toEqual(["EOSE", "s1"]);
    expect(got.filter((m) => m[0] === "EVENT").map((m) => m[2].id)).toEqual(["e1"]);
    expect(relay.stats.events).toBe(2);
    a.close();
    b.close();
    await relay.close();
  });
});
