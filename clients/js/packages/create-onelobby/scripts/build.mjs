// Vendors the real blueprint loader (parseBlueprint, from the onelobby client's dist) and the schema into ./vendor, so
// create-onelobby has zero runtime dependencies and validates with exactly the code the runtime uses.
// Needs the client built first: `npm run build -w onelobby` (the repo root `npm run build` does that).
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = join(pkg, "../client");
const entry = join(client, "dist/blueprint.js");
if (!existsSync(entry)) throw new Error("build the onelobby client first: npm run build -w onelobby");
mkdirSync(join(pkg, "vendor"), { recursive: true });
await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  outfile: join(pkg, "vendor/blueprint.js"),
  logLevel: "warning",
});
copyFileSync(join(client, "blueprint.schema.json"), join(pkg, "vendor/blueprint.schema.json"));
