// What gets written. Templates are real files under templates/ with {{placeholders}} and `//#if project|into` blocks.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ONELOBBY_VERSION, SCHEMA_URL } from "./blueprint.js";

const templates = join(dirname(fileURLToPath(import.meta.url)), "../templates");
const read = (...p) => readFileSync(join(templates, ...p), "utf8");

export const RECIPE_URL = "https://github.com/ParkerTonra/onelobby/blob/main/docs/recipes/js-web.md";
export const DEFAULT_DEPENDENCY = `^${ONELOBBY_VERSION}`;

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Replace {{name}} placeholders; unknown names are left alone. */
function fill(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** Keep `//#if <tag>` ... `//#endif` blocks for the chosen tag only, and drop the marker lines. */
function conditional(text, tag) {
  const out = [];
  let keep = true;
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\/\/#(if|endif)\s*(\w*)/);
    if (!m) {
      if (keep) out.push(line);
    } else keep = m[1] === "endif" ? true : m[2] === tag;
  }
  return out.join("\n");
}

export const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const json = (o) => JSON.stringify(o, null, 2) + "\n";

/** All files of a new `web` project: [{ path (posix, relative), content }]. */
export function webProjectFiles({ blueprint, dirName, onelobbyVersion = DEFAULT_DEPENDENCY }) {
  const title = blueprint.game.title ?? dirName;
  const vars = { title: escapeHtml(title), schemaUrl: SCHEMA_URL, recipeUrl: RECIPE_URL, pkgName: slug(dirName) || "onelobby-game" };
  const pkg = JSON.parse(fill(read("web", "package.json"), vars));
  pkg.dependencies.onelobby = onelobbyVersion;
  return [
    { path: "onelobby.json", content: json(blueprint) },
    { path: "package.json", content: json(pkg) },
    { path: "index.html", content: fill(read("web", "index.html"), vars) },
    { path: "src/game.js", content: read("web", "src", "game.js") },
    { path: "src/multiplayer.js", content: read("web", "src", "multiplayer.js") },
    { path: "src/session.js", content: read("glue", "session.js") },
    { path: "scripts/serve.mjs", content: read("web", "scripts", "serve.mjs") },
    { path: "test/multiplayer.mjs", content: conditional(read("glue", "multiplayer-test.mjs"), "project") },
    { path: "AGENTS.md", content: fill(read("web", "AGENTS.md"), vars) },
    { path: ".gitignore", content: read("web", "_gitignore") },
  ];
}

/** The files `--into` adds to an existing project: onelobby.json, multiplayer/ glue and the test. */
export function intoFiles({ blueprint }) {
  return [
    { path: "onelobby.json", content: json(blueprint) },
    { path: "multiplayer/session.js", content: read("glue", "session.js") },
    { path: "test/multiplayer.mjs", content: conditional(read("glue", "multiplayer-test.mjs"), "into") },
  ];
}
