// The checks `verify` runs for a web game (onelobby.json plus the web glue).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "../blueprint.js";
import { run } from "./procs.js";
import { blueprintNext, wiringCheck } from "./wiring.js";

const SKIP_WEBRTC =
  "running two JS clients over real WebRTC in Node needs node-datachannel, which a web game does not depend on; tools/engine-smoke in the OneLobby repo covers the JS client on this route";

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
        if (!existsSync(join(ctx.dir, "test/multiplayer.mjs")))
          return { status: "fail", detail: "test/multiplayer.mjs is missing.", next: "Run: npx create-onelobby --into . (it writes the two-player test)." };
        if (!existsSync(join(ctx.dir, "node_modules/onelobby/package.json")))
          return { status: "fail", detail: "the onelobby package is not installed in this folder.", next: "Run: npm install, then rerun." };
        const env = { ...ctx.env };
        delete env.LOBBY_SERVER; // the in-memory path: no server, no browser, no network
        const r = await run(process.execPath, ["test/multiplayer.mjs"], { cwd: ctx.dir, env, timeoutMs: 180000 });
        const passed = (r.out.match(/^PASS /gm) ?? []).length;
        const failed = r.out.split(/\r?\n/).filter((l) => /^FAIL /.test(l));
        if (r.code === 0 && !r.timedOut && failed.length === 0) return { status: "ok", detail: `test/multiplayer.mjs: ${passed} checks passed, in memory (the web game's own two-player test)` };
        return {
          status: "fail",
          detail: `test/multiplayer.mjs failed: ${r.timedOut ? "it did not finish in time" : (failed[0] ?? `exit ${r.code}${r.error ? ` (${r.error})` : ""}`)}.`,
          next: "Run: node test/multiplayer.mjs and read its output.",
        };
      },
    },
    { name: "nostr", async run() { return { status: "skipped", detail: SKIP_WEBRTC }; } },
    { name: "turn", async run() { return { status: "skipped", detail: SKIP_WEBRTC }; } },
  ];
}
