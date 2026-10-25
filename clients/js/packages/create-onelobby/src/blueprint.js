// Turns answers into a validated, fully written onelobby.json. Validation is the real loader (vendor/blueprint.js is
// parseBlueprint bundled from the onelobby client by scripts/build.mjs), so a file written here always loads at runtime.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, getPath, setPath } from "./flags.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The npm version of `onelobby` the generated project depends on and the $schema URL pins (first with fromConfig). */
export const ONELOBBY_VERSION = "0.5.0";
export const SCHEMA_URL = `https://unpkg.com/onelobby@${ONELOBBY_VERSION}/blueprint.schema.json`;
export const TEMPLATES = ["web", "node-browser", "godot-csharp", "unity", "dotnet"];
export const IMPLEMENTED_TEMPLATES = ["web"];

let loader;
async function loadLoader() {
  if (!loader) {
    try {
      loader = await import("../vendor/blueprint.js");
    } catch (e) {
      throw new CliError("internal", `the blueprint loader is missing (${e.message}); run "npm run build" in create-onelobby`);
    }
  }
  return loader;
}

let schemaCache;
/** The schema, for prompt text (each key's description). */
export function loadSchema() {
  schemaCache ??= JSON.parse(readFileSync(join(here, "../vendor/blueprint.schema.json"), "utf8"));
  return schemaCache;
}

/** The schema description of a dotted key, e.g. "lobby.maxPlayers" -> "Seats, host included." */
export function describeKey(dotted) {
  const schema = loadSchema();
  let node = schema;
  for (const k of dotted.split(".")) {
    node = node?.properties?.[k];
  }
  return node?.description ?? dotted;
}

/** Throw a CliError("bad_config", ..., path) for the loader's error. */
function rethrow(e) {
  if (e && e.code === "bad_config") {
    const err = new CliError("bad_config", `${e.message}${e.rule ? ` (rule ${e.rule})` : ""}`, e.path);
    err.rule = e.rule;
    throw err;
  }
  throw e;
}

export async function validate(json) {
  const { parseBlueprint } = await loadLoader();
  try {
    return parseBlueprint(json);
  } catch (e) {
    rethrow(e);
  }
}

const thaw = (o) => JSON.parse(JSON.stringify(o));

/**
 * Template-specific starting answers, applied for keys nobody set. Everything else falls to the loader's defaults.
 * web: gridpaint is a deterministic lockstep game, and the generated page is the "generated" UI kind.
 */
export function templateDefaults(template, { title }) {
  if (template !== "web") return {};
  return {
    game: { title },
    sync: { mode: "lockstep" },
    ui: { kind: "generated", entry: "Main page" },
  };
}

/** Fill `answers` with `defaults` where unset (deep, one level of sections). */
export function withDefaults(answers, defaults) {
  const out = thaw(answers);
  const walk = (src, prefix) => {
    for (const [k, v] of Object.entries(src)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, path);
      else if (getPath(out, path) === undefined) setPath(out, path, v);
    }
  };
  walk(defaults, "");
  return out;
}

/**
 * Validate the answers with the real loader and return the full file to write: every key, `$schema` pinned,
 * defaults filled in.
 */
export async function buildBlueprint(answers) {
  const filled = thaw(await validate(answers));
  const file = { $schema: SCHEMA_URL, ...filled };
  // the written file must load again exactly as the loader sees it
  await validate(file);
  return file;
}

/** `com.example.<slug>` from a folder name; loader rule: [A-Za-z0-9._-]{1,64}. */
export function deriveGameId(dirName) {
  const slug = dirName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const id = `com.example.${slug || "game"}`;
  return id.slice(0, 64).replace(/[-.]+$/, "");
}

export function titleFromDir(dirName) {
  return dirName;
}
