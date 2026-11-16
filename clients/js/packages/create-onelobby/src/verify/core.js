// The check runner behind `verify`, with no knowledge of Godot or the web: it runs checks in order, prints one line per check,
// then ONE verdict line. Checks are plain objects, so the unit tests drive it with fake runners.
//   check  = { name, blocking?: true, run(ctx) -> result }
//   result = { status: "ok" | "fail" | "skipped", detail?: string, warning?: string, next?: string }
// A failed `blocking` check makes every later check "skipped" (it needs that one); other failures do not stop the run.

/** The text of one check line: "ok (...)", "FAIL <why>" or "skipped <why>". */
export function lineText(r) {
  if (r.status === "ok") return `ok${r.detail ? ` (${r.detail})` : ""}${r.warning ? ` WARNING: ${r.warning}` : ""}`;
  if (r.status === "fail") return `FAIL ${r.detail ?? "failed"}`;
  return `skipped ${r.detail ?? ""}`.trimEnd();
}

/**
 * What a passing `direct` check does NOT prove, for a game that keeps its own sync (sync.mode raw or replication): the scaffolder's
 * two-peer test links two peers and sends one message each way, it never runs the game's own sessions. "" for lockstep (the
 * game plugs into that test) and for an unknown mode. Appended to the check's ok detail so VERIFY_OK cannot read as "the netcode works".
 */
export function ownNetcodeNote(mode) {
  if (mode !== "raw" && mode !== "replication") return "";
  return `; this proves OneLobby's lobby and messages only, NOT this game's own netcode (sync.mode ${mode}): run the game's own two-player test and name it in the report`;
}

/** The one last line: VERIFY_OK, or VERIFY_FAIL <first failing check>: <why and the next step>. */
export function verdictLine(results) {
  const first = results.find((r) => r.status === "fail");
  if (!first) return "VERIFY_OK";
  const sentence = [first.detail, first.next].filter(Boolean).join(" ");
  return `VERIFY_FAIL ${first.name}: ${sentence}`.replace(/\s+/g, " ").trim();
}

/**
 * Run `checks` in order. `onLine(name, text)` is called as each finishes. Returns
 * { ok, verdict, firstFailure, results: [{ name, status, detail?, warning?, next?, ms }] } and never throws
 * (an exception inside a check is that check's FAIL).
 */
export async function runChecks(checks, ctx, { onLine = () => {}, now = Date.now } = {}) {
  const results = [];
  let blockedBy = null;
  for (const check of checks) {
    const t0 = now();
    let r;
    if (blockedBy) r = { status: "skipped", detail: `needs the ${blockedBy} check, which failed` };
    else {
      try {
        r = await check.run(ctx);
      } catch (e) {
        r = { status: "fail", detail: `the check itself broke (${e?.message ?? e}).`, next: "This is a bug in create-onelobby verify: rerun it, and report it with this line." };
      }
    }
    if (r.status === "fail" && check.blocking && !blockedBy) blockedBy = check.name;
    const done = { name: check.name, ...r, ms: now() - t0 };
    results.push(done);
    onLine(check.name, lineText(done));
  }
  const first = results.find((r) => r.status === "fail");
  return { ok: !first, verdict: verdictLine(results), firstFailure: first?.name ?? null, results };
}
