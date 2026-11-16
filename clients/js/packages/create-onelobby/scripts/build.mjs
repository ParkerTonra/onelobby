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

// The GDScript add-on, bundled so `npm create onelobby` needs no network for the scripts (the godot-gdscript template copies
// vendor/gdscript-addon/onelobby/ into the game and pins it). source.json records the repo commit it was built from.
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const repo = join(pkg, "../../../..");
const addon = join(repo, "clients/gdscript/addons/onelobby");
if (!existsSync(join(addon, "client.gd"))) throw new Error(`the GDScript add-on is missing at ${addon}`);
const outDir = join(pkg, "vendor/gdscript-addon");
rmSync(outDir, { recursive: true, force: true });
cpSync(addon, join(outDir, "onelobby"), { recursive: true });
const head = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const commit = head.status === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : "unknown";
writeFileSync(join(outDir, "source.json"), JSON.stringify({ commit }, null, 2) + "\n");

// The Godot C# menu (OneLobbyMenu.cs and .tscn), bundled for the godot-csharp template (the rest of a C# game comes from NuGet).
const menu = join(repo, "clients/dotnet/demo-godot/addons/onelobby_menu");
if (!existsSync(join(menu, "OneLobbyMenu.cs"))) throw new Error(`the Godot C# menu is missing at ${menu}`);
const menuOut = join(pkg, "vendor/csharp-menu");
rmSync(menuOut, { recursive: true, force: true });
cpSync(menu, join(menuOut, "onelobby_menu"), { recursive: true });
writeFileSync(join(menuOut, "source.json"), JSON.stringify({ commit }, null, 2) + "\n");
