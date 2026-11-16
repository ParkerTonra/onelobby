// `create-onelobby verify`: prove a game's multiplayer on this machine, 127.0.0.1 only, and say so in one verdict line.
//   godot-gdscript: godot, addon-pin, natives, blueprint, direct, nostr, turn, server   (godot.js)
//   web:            blueprint, project-test, nostr, turn                                 (web.js)
// Helpers (a local Nostr relay: built in, relay.js; a local TURN server: npm node-turn, turn.js) are used only while this runs.
// Everything it starts is stopped again, also on a failed check and on Ctrl+C. It writes only inside the game folder
// (.onelobby/, covered by the managed .gitignore block).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { csharpPlanned, detectProject, notAProject, projectDir } from "../project.js";
import { runChecks } from "./core.js";
import { godotChecks, writeProbe } from "./godot.js";
import { killAll } from "./procs.js";
import { webChecks } from "./web.js";

/** `create-onelobby verify [dir] [--into dir] [options]`. Returns the exit code (0 only for VERIFY_OK). */
export async function runVerify({ dir, opts, io }) {
  const target = projectDir({ dir, opts, cwd: io.cwd });
  const found = detectProject(target, { requireBlueprint: true });
  if (found.kind === "godot-csharp") throw csharpPlanned(target);
  if (found.kind === null) throw notAProject(found, "verify");

  const injected = typeof io.verifyChecks === "function"; // a test seam: fake checks, no Godot, no files written
  const checks = injected ? io.verifyChecks(found.kind) : found.kind === "web" ? webChecks() : godotChecks();
  const ctx = { dir: target, opts, env: io.env, services: {}, kind: found.kind };
  const notes = [];
  if (found.kind === "godot-gdscript" && !injected) {
    const ignore = existsSync(join(target, ".gitignore")) ? readFileSync(join(target, ".gitignore"), "utf8") : "";
    if (!/^\.onelobby\/?\s*$/m.test(ignore)) notes.push("the .gitignore does not ignore .onelobby/ (verify's scratch folder); run: npx create-onelobby update (it refreshes the managed block)");
    writeProbe(target);
  }

  const progress = opts.json ? io.stderr : io.stdout;
  const t0 = Date.now();
  progress.write(`create-onelobby verify: ${target} (${found.kind})\n`);
  const pad = Math.max(...checks.map((c) => c.name.length)) + 2;

  const stop = async () => {
    killAll();
    await ctx.services.relay?.close().catch(() => {});
  };
  const onSignal = (code) => async () => {
    await stop();
    process.exit(code);
  };
  const handlers = { SIGINT: onSignal(130), SIGTERM: onSignal(143) };
  const onExit = () => killAll();
  if (!injected) {
    for (const [sig, fn] of Object.entries(handlers)) process.on(sig, fn);
    process.on("exit", onExit);
  }
  let outcome;
  try {
    outcome = await runChecks(checks, ctx, { onLine: (name, text) => progress.write(`${`${name}:`.padEnd(pad)} ${text}\n`) });
  } finally {
    await stop();
    if (!injected) {
      for (const [sig, fn] of Object.entries(handlers)) process.off(sig, fn);
      process.off("exit", onExit);
    }
  }

  const summary = { ok: 0, fail: 0, skipped: 0 };
  for (const r of outcome.results) summary[r.status]++;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (opts.json) {
    io.stdout.write(
      JSON.stringify({
        ok: outcome.ok,
        command: "verify",
        verdict: outcome.verdict,
        kind: found.kind,
        dir: target,
        ...(ctx.godot ? { godot: { exe: ctx.godot.exe, version: ctx.godot.version, from: ctx.godot.from } } : {}),
        checks: outcome.results.map(({ name, status, detail, warning, next, ms }) => ({ name, status, ...(detail ? { detail } : {}), ...(warning ? { warning } : {}), ...(next ? { next } : {}), ms })),
        ...(outcome.firstFailure ? { firstFailure: outcome.firstFailure } : {}),
        summary,
        notes,
        seconds: Number(secs),
      }) + "\n",
    );
  } else {
    for (const n of notes) io.stdout.write(`note: ${n}\n`);
    io.stdout.write(`${summary.ok} ok, ${summary.fail} failed, ${summary.skipped} skipped, ${secs} s\n${outcome.verdict}\n`);
  }
  return outcome.ok ? 0 : 1;
}
