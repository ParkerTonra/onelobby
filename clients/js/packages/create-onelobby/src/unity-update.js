// `create-onelobby update` for a Unity game: move the value of the com.onelobby.unity line of Packages/manifest.json to this version, and
// nothing else (no test, script or setting is rewritten: they are the game's once written). Print what to do in Unity.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./flags.js";
import { MANIFEST_PATH, defaultTarball, packageRef, tarballVersion } from "./unity.js";
import { PACKAGE_NAME, moveDependency, readDependency } from "./manifest.js";

/** What would happen to the current value: { action: "move" | "current" | "left", to?, why? }. */
export function decide({ current, ref, explicit }) {
  if (explicit) return current === ref.value ? { action: "current" } : { action: "move", to: ref.value };
  const own = /^file:(com\.onelobby\.unity-[^/\\]+\.tgz)$/.exec(current); // the line this tool writes: a tarball named after the version, next to the manifest
  if (own && tarballVersion(own[1]) !== null) return own[1] === ref.file ? { action: "current" } : { action: "move", to: ref.value };
  if (current.startsWith("file:")) return { action: "left", why: "it is a file: reference somebody wrote (a path or another tarball); pass --package-from <tarball> to move it" };
  if (/^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(current)) return current === ref.version ? { action: "current" } : { action: "move", to: ref.version };
  return { action: "left", why: `it is ${current}, not a version number or a file: reference this tool wrote; edit it yourself` };
}

/** `create-onelobby update` on a Unity game. Returns the exit code. */
export function runUpdateUnity({ target, opts, io }) {
  const manifestPath = join(target, ...MANIFEST_PATH.split("/"));
  if (!existsSync(manifestPath)) throw new CliError("bad_manifest", `${target} has no ${MANIFEST_PATH}; open the project in Unity once (it writes that file)`);
  const text = readFileSync(manifestPath, "utf8");
  const current = readDependency(text, PACKAGE_NAME, MANIFEST_PATH);
  if (current === null)
    throw new CliError("no_package", `${MANIFEST_PATH} does not reference ${PACKAGE_NAME}, so there is nothing to update. Add it with: npx create-onelobby --into .${opts.packageFrom === undefined ? "" : ` --package-from ${opts.packageFrom}`}`);
  const ref = packageRef({ opts, target, cwd: io.cwd });
  const d = decide({ current, ref, explicit: opts.packageFrom !== undefined });
  const to = d.action === "move" ? d.to : current;
  let out = { text, changed: false, from: current };
  if (d.action === "move") out = moveDependency(text, PACKAGE_NAME, to, MANIFEST_PATH);
  const missingFile = /^file:(?!.*[/\\])(.+\.tgz)$/.exec(to)?.[1];
  const warning = missingFile && !existsSync(join(target, "Packages", missingFile)) ? `Packages/${missingFile} is not there yet: put the tarball there (clients/unity/build-unity-package.sh --pack, or the unity-dev-package CI artifact), or rerun with --package-from <tarball>` : undefined;
  const next = out.changed || d.action === "left" ? [`open the project in Unity (or run: npx create-onelobby verify): Unity resolves ${PACKAGE_NAME} again on its next start and rewrites Packages/packages-lock.json; commit both files`, ...(warning ? [warning] : [])] : warning ? [warning] : [];
  const result = {
    ok: true,
    command: "update",
    dir: target,
    template: "unity",
    current: d.action === "current",
    changed: out.changed,
    package: { name: PACKAGE_NAME, from: current, to, action: d.action, ...(d.why ? { why: d.why } : {}) },
    manifest: MANIFEST_PATH,
    ...(opts.dryRun ? { dryRun: true } : {}),
    ...(warning ? { warning } : {}),
    next,
  };
  if (out.changed && !opts.dryRun) writeFileSync(manifestPath, out.text);
  if (opts.json) io.stdout.write(JSON.stringify(result) + "\n");
  else {
    const line =
      d.action === "move" ? `${opts.dryRun ? "Would move" : "Moved"} ${PACKAGE_NAME} in ${MANIFEST_PATH}: ${current} -> ${to}`
      : d.action === "current" ? `Already current: ${MANIFEST_PATH} references ${PACKAGE_NAME} ${current}. Nothing was written.`
      : `Left alone: ${MANIFEST_PATH} references ${PACKAGE_NAME} ${current}; ${d.why}. Nothing was written.`;
    io.stdout.write(`${opts.dryRun && d.action === "move" ? "Dry run: nothing written.\n" : ""}${line}\n${next.length ? `\nNext:\n  ${next.join("\n  ")}\n` : ""}`);
  }
  return 0;
}

export { defaultTarball };
