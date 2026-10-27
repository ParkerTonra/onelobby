// Packs a dev build of the client under its own prerelease version, e.g. 0.6.0-dev.1d4fc17, without touching
// package.json. Every dev tgz needs a distinct version: a consumer that swaps one 0.5.0 tgz for another keeps the old
// lockfile integrity and npm silently installs the cached older build.
//   node scripts/pack-dev.mjs <version> <out-dir>        (run `npm run build` first)
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [version, outDir] = process.argv.slice(2);
if (!version || !outDir) {
  console.error("usage: node scripts/pack-dev.mjs <version> <out-dir>");
  process.exit(1);
}
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const stage = mkdtempSync(join(tmpdir(), "onelobby-pack-"));
try {
  for (const f of [...(pkg.files ?? []), "README.md", "LICENSE", "LICENSE.md"]) {
    try { cpSync(join(pkgDir, f), join(stage, f), { recursive: true }); } catch { /* optional file */ }
  }
  pkg.version = version;
  delete pkg.scripts; // the staged copy is already built
  writeFileSync(join(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  const out = execSync(`npm pack "${stage}" --pack-destination "${resolve(outDir)}"`, { encoding: "utf8" });
  console.log(join(resolve(outDir), out.trim().split("\n").pop()));
} finally {
  rmSync(stage, { recursive: true, force: true });
}
