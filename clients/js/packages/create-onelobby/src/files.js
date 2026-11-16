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
export function intoFiles({ blueprint, packageJson }) {
  const files = [
    { path: "onelobby.json", content: json(blueprint) },
    { path: "multiplayer/session.js", content: read("glue", "session.js") },
    { path: "test/multiplayer.mjs", content: conditional(read("glue", "multiplayer-test.mjs"), "into") },
  ];
  // no package.json in the folder: a minimal one; an existing package.json is never edited
  if (packageJson) {
    const pkg = { name: slug(packageJson.dirName) || "onelobby-game", version: "0.1.0", private: true, type: "module", dependencies: { onelobby: packageJson.onelobbyVersion ?? DEFAULT_DEPENDENCY } };
    files.push({ path: "package.json", content: json(pkg) });
  }
  return files;
}

/**
 * The "Next:" lines of a web `--into` run, in the order the work happens. `pkg`: { created, hasOnelobby, isModule } (the folder's
 * package.json as it is after this run).
 */
export function intoNext({ rel, pkg, onelobbyVersion = DEFAULT_DEPENDENCY }) {
  const next = [];
  if (rel !== ".") next.push(`cd ${rel}`);
  if (pkg.created) next.push('npm install   # package.json was missing, so a minimal one was written (private, "type": "module", the onelobby dependency)');
  else {
    if (!pkg.isModule) next.push('your package.json has no "type": "module" and was left as it is: add it (multiplayer/session.js and test/multiplayer.mjs are ES modules)');
    next.push(pkg.hasOnelobby ? "npm install" : `npm install onelobby@${onelobbyVersion}   # your package.json was left as it is and does not list onelobby`);
  }
  next.push(
    "put your game behind step(tick, commands) -> hash, snapshot() -> bytes, restore(tick, bytes) and hash(), and swap it for the stand-in Game in test/multiplayer.mjs",
    'in the page: import { loadBlueprint, makeKit, bindSession } from "./multiplayer/session.js"; const bp = await loadBlueprint(); const kit = makeKit(bp, { displayName }); const lobby = await kit.host() (or await kit.join(code)); const s = bindSession(lobby, kit.blueprint, game) before lobby.start(); call s.pump(performance.now()) every frame and s.send(bytes) when the player acts',
    "node test/multiplayer.mjs   # expect every check to PASS",
    `follow ${RECIPE_URL}`,
  );
  return next;
}

/** The glue file this version writes (templates/glue/session.js), for `update` to compare a project copy with. */
export const glueSession = () => read("glue", "session.js");
