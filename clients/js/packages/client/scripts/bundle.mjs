// Single-file bundles from src/global.ts (run after tsc; `npm run build` does both):
//   dist/keepalive.global.js      IIFE, sets window.Keepalive (plain <script src>, works from file:// too)
//   dist/keepalive.global.min.js  same, minified
//   dist/keepalive.bundle.mjs     one ES module (import from a CDN URL without a bundler)
// Each gets a .map. Prints raw / min+gzip sizes.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const entry = join(pkgDir, "src", "global.ts");
const dist = join(pkgDir, "dist");
const banner = { js: `/*! ${pkg.name} ${pkg.version} | ${pkg.license} license */` };
const common = { entryPoints: [entry], bundle: true, sourcemap: true, target: "es2022", platform: "browser", banner, logLevel: "warning", legalComments: "none" };

const outputs = [
  { outfile: join(dist, "keepalive.global.js"), format: "iife", globalName: "Keepalive", minify: false },
  { outfile: join(dist, "keepalive.global.min.js"), format: "iife", globalName: "Keepalive", minify: true },
  { outfile: join(dist, "keepalive.bundle.mjs"), format: "esm", minify: true },
];
for (const o of outputs) await build({ ...common, ...o });

for (const o of outputs) {
  const buf = readFileSync(o.outfile);
  const kb = (n) => (n / 1024).toFixed(1) + " KB";
  console.log(`${o.outfile.slice(pkgDir.length + 1).padEnd(30)} ${kb(buf.length).padStart(9)}  gzip ${kb(gzipSync(buf).length)}`);
}
