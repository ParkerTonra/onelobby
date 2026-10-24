// Last gate before `npm publish` (run by prepublishOnly): refuse to ship placeholder metadata or a missing bundle.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = readFileSync(join(dir, "package.json"), "utf8");
const problems = [];
if (raw.includes("REPLACE-ME")) {
  problems.push('package.json still has "REPLACE-ME" placeholders (homepage, repository, bugs): fill them in or delete those fields.');
}
if (readFileSync(join(dir, "README.md"), "utf8").includes("REPLACE-ME")) {
  problems.push('README.md still has "REPLACE-ME" links: point them at the docs.');
}
for (const f of ["dist/index.js", "dist/index.d.ts", "dist/keepalive.global.js", "dist/keepalive.global.min.js", "dist/keepalive.bundle.mjs", "README.md", "LICENSE"]) {
  if (!existsSync(join(dir, f))) problems.push(`missing ${f}`);
}
const pkg = JSON.parse(raw);
const src = readFileSync(join(dir, "src", "keepalive.ts"), "utf8");
const m = /LIB_VERSION = "([^"]+)"/.exec(src);
if (m && m[1] !== pkg.version) problems.push(`src/keepalive.ts LIB_VERSION is ${m[1]} but package.json version is ${pkg.version}`);
const n = /LIB_NAME = "([^"]+)"/.exec(src);
if (n && n[1] !== pkg.name) console.warn(`note: LIB_NAME is "${n[1]}" but the package is "${pkg.name}" (fine if you renamed the package on purpose)`);
if (problems.length) {
  console.error("prepublish-check failed:\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log(`prepublish-check ok: ${pkg.name}@${pkg.version}`);
