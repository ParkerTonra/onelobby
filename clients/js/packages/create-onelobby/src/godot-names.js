// Names a game already owns, for `--into`: the global class names (`class_name X`) of its scripts and its autoload names. A script
// `--into` adds under one of those names would fail the game's import ("Too many arguments for new()", "hides an autoload singleton"),
// so the plan looks first and refuses, naming both files.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./flags.js";

/** Folders the scan never enters: the add-ons `--into` itself replaces or installs, and tool folders. A dot folder (.git, .godot, .onelobby, .claude) is skipped too. */
const SKIP = new Set(["addons/onelobby", "addons/godot_webrtc", "node_modules"]);
const CLASS_NAME = /^[ \t]*class_name[ \t]+([A-Za-z_][A-Za-z0-9_]*)/m;

/** Every `class_name` of the game's own scripts: Map(name -> first file, posix, relative to `dir`). `ignore`: files to leave out (the ones this run writes). */
export function gameClassNames(dir, ignore = new Set()) {
  const out = new Map();
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, ...rel.split("/").filter(Boolean)), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIP.has(path) || e.name === "node_modules") continue;
        walk(path);
      } else if (e.isFile() && e.name.endsWith(".gd") && !ignore.has(path)) {
        const name = CLASS_NAME.exec(readFileSync(join(dir, ...path.split("/")), "utf8"))?.[1];
        if (name && !out.has(name)) out.set(name, path);
      }
    }
  };
  walk("");
  return out;
}

/** The `[autoload]` entries of a project.godot text: Map(name -> "res://path" without the leading `*`). */
export function gameAutoloads(projectText) {
  const out = new Map();
  let inSection = false;
  for (const line of projectText.split(/\r?\n/)) {
    if (/^\s*\[[^\]]*\]\s*$/.test(line)) inSection = /^\s*\[autoload\]\s*$/.test(line);
    else if (inSection) {
      const m = line.match(/^\s*([^=;\s][^=]*?)\s*=\s*"\*?(.*)"\s*$/);
      if (m) out.set(m[1], m[2]);
    }
  }
  return out;
}

/** The class names a list of add-on files declares: [{ name, file }] (file as given). */
export function declaredClasses(files, prefix = "") {
  return files
    .filter((f) => f.path.endsWith(".gd"))
    .map((f) => ({ name: CLASS_NAME.exec(Buffer.from(f.content).toString("utf8"))?.[1], file: `${prefix}${f.path}` }))
    .filter((c) => c.name);
}

/**
 * Look for the names `--into` would add in the game. `classes`: [{ name, file }] the scripts it writes declare; `autoload`: { name, file }
 * (the one it registers); `ignore`: the game files this run overwrites (their old class_name does not count). Throws CliError("name_clash")
 * naming both files and the way out, listing every clash at once; returns nothing when there is none. An autoload that already has the name
 * and points elsewhere is left to addAutoload ("autoload_taken").
 */
export function checkNameClashes({ target, classes, autoload, ignore = new Set() }) {
  const project = existsSync(join(target, "project.godot")) ? readFileSync(join(target, "project.godot"), "utf8") : "";
  const own = gameClassNames(target, ignore);
  const autoloads = gameAutoloads(project);
  const clashes = [];
  for (const c of classes) {
    if (own.has(c.name)) clashes.push({ name: c.name, adds: c.file, kind: "class_name", gameFile: own.get(c.name) });
    else if (autoloads.has(c.name)) clashes.push({ name: c.name, adds: c.file, kind: "autoload", gameFile: `project.godot (autoload ${c.name}="${autoloads.get(c.name)}")` });
  }
  if (own.has(autoload.name)) clashes.push({ name: autoload.name, adds: `${autoload.file} (the autoload ${autoload.name})`, kind: "class_name", gameFile: own.get(autoload.name) });
  if (!clashes.length) return;
  const lines = clashes.map((c) => `  ${c.name}: ${c.adds} would take the name, but ${c.gameFile} already ${c.kind === "class_name" ? `declares class_name ${c.name}` : "uses it"}`);
  throw new CliError(
    "name_clash",
    `--into would add names your game already uses, so Godot would refuse to load both; nothing was written:\n${lines.join("\n")}\nWay out: rename the one in your game (its class_name or autoload, and every use of it), then run the same command again.`,
    undefined,
    { clashes },
  );
}
