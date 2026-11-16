// The checks `verify` runs for a web game (onelobby.json plus the web glue).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "../blueprint.js";
import { run } from "./procs.js";
import { blueprintNext, wiringCheck } from "./wiring.js";

/**
 * Does this web project have node-datachannel (the package that gives Node WebRTC)? "installed" (in node_modules), "listed" (in
 * package.json dependencies, devDependencies or optionalDependencies) or null. Read-only; never runs anything.
 */
export function nodeDatachannelIn(dir) {
  if (existsSync(join(dir, "node_modules", "node-datachannel", "package.json"))) return "installed";
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    for (const k of ["dependencies", "devDependencies", "optionalDependencies"]) if (pkg?.[k] && "node-datachannel" in pkg[k]) return "listed";
  } catch {
    /* no package.json, or not JSON: the project does not list it */
  }
  return null;
}

/** The sync.mode in the folder's onelobby.json, or null when it cannot be read (the `blueprint` check reports that). */
export function syncModeOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "onelobby.json"), "utf8"))?.sync?.mode ?? "lockstep";
  } catch {
    return null;
  }
}

/**
 * What a passing test/multiplayer.mjs proved. It always runs OneLobby's lobby, messages and a lockstep-shaped stand-in Game in memory.
 * With sync.mode lockstep the game plugs into that test; with raw or replication the game has its own sync and the test cannot
 * run it, so the line says it proved the stand-in only (VERIFY_OK must not read as "the game's netcode works").
 */
export function projectTestDetail(passed, mode) {
  if (mode === "lockstep" || mode === null) return `test/multiplayer.mjs: ${passed} checks passed, in memory (OneLobby's lobby, messages and the lockstep game bound in this test)`;
  return `test/multiplayer.mjs: ${passed} checks passed, in memory: this proves OneLobby's lobby and messages and the template's stand-in game only, NOT this game's own netcode (sync.mode ${mode}); run the game's own two-player test and name it in the report`;
}

/** The true reason `nostr` and `turn` are skipped for this web project (they are never run: verify starts no JS peers for a web game). */
export function skipReason(dir) {
  const found = nodeDatachannelIn(dir);
  if (found)
    return `node-datachannel is ${found === "installed" ? "installed" : "listed in package.json"} here, so this game can run WebRTC in Node, but verify does not start JS peers for a web game, so this route was not run; the game's own two-peer test over real WebRTC is what proves it (run that test and name it in the report)`;
  return "verify would need two JS clients over real WebRTC in Node, which needs node-datachannel; this folder has none (not in node_modules, not in package.json), so there is nothing to run here, and a browser page brings its own WebRTC; add node-datachannel and give the game its own two-peer test to prove this route";
}

export function webChecks() {
  return [
    {
      name: "blueprint",
      blocking: true,
      async run(ctx) {
        let json;
        try {
          json = JSON.parse(readFileSync(join(ctx.dir, "onelobby.json"), "utf8"));
        } catch (e) {
          return { status: "fail", detail: `onelobby.json is not valid JSON (${e.message}).`, next: "Fix the file (its $schema line lists every key)." };
        }
        try {
          const bp = await validate(json);
          return { status: "ok", detail: `mode ${bp.sync.mode}, direct ${bp.hosting.direct}, server ${bp.hosting.server}` };
        } catch (e) {
          return { status: "fail", detail: `onelobby.json does not load: ${e.message}${e.path ? ` (at ${e.path})` : ""}.`, next: blueprintNext(e.path, `Fix ${e.path ?? "that key"} in onelobby.json (the schema describes it).`) };
        }
      },
    },
    wiringCheck(),
    {
      name: "project-test",
      async run(ctx) {
        if (!existsSync(join(ctx.dir, "test/multiplayer.mjs"))) {
          const mode = syncModeOf(ctx.dir);
          if (mode !== null && mode !== "lockstep")
            return { status: "skipped", detail: `no test/multiplayer.mjs: sync.mode is ${mode}, so the game keeps its own sync and the scaffolder writes no lockstep stand-in test for it; the proof of this game's netcode is its own two-player test (run it and name it in the report)` };
        }
        if (!existsSync(join(ctx.dir, "test/multiplayer.mjs")))
          return { status: "fail", detail: "test/multiplayer.mjs is missing.", next: "Run: npx create-onelobby --into . (it writes the two-player test)." };
        if (!existsSync(join(ctx.dir, "node_modules/onelobby/package.json")))
          return { status: "fail", detail: "the onelobby package is not installed in this folder.", next: "Run: npm install, then rerun." };
        const env = { ...ctx.env };
        delete env.LOBBY_SERVER; // the in-memory path: no server, no browser, no network
        const r = await run(process.execPath, ["test/multiplayer.mjs"], { cwd: ctx.dir, env, timeoutMs: 180000 });
        const passed = (r.out.match(/^PASS /gm) ?? []).length;
        const failed = r.out.split(/\r?\n/).filter((l) => /^FAIL /.test(l));
        if (r.code === 0 && !r.timedOut && failed.length === 0) return { status: "ok", detail: projectTestDetail(passed, syncModeOf(ctx.dir)) };
        return {
          status: "fail",
          detail: `test/multiplayer.mjs failed: ${r.timedOut ? "it did not finish in time" : (failed[0] ?? `exit ${r.code}${r.error ? ` (${r.error})` : ""}`)}.`,
          next: "Run: node test/multiplayer.mjs and read its output.",
        };
      },
    },
    { name: "nostr", async run(ctx) { return { status: "skipped", detail: skipReason(ctx.dir) }; } },
    { name: "turn", async run(ctx) { return { status: "skipped", detail: skipReason(ctx.dir) }; } },
  ];
}
