// Ships spec/blueprint.schema.json in the package (export "onelobby/blueprint.schema.json"); run by `npm run build`.
// The copy next to package.json is a build artifact (gitignored); the spec file stays the single source.
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(pkgDir, "../../../../spec/blueprint.schema.json");
const dest = join(pkgDir, "blueprint.schema.json");
if (existsSync(src)) copyFileSync(src, dest);
else if (!existsSync(dest)) throw new Error("spec/blueprint.schema.json not found (build from a full clone of the repo)");
