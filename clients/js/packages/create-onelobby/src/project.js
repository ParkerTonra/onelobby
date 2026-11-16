// What kind of OneLobby game lives in a folder? Shared by `update` and `verify`.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError } from "./flags.js";
import { isCSharpProject } from "./godot-project.js";

/** Where the web glue lives: a scaffolded project (src/session.js) or an `--into` project (multiplayer/session.js). */
export const WEB_GLUE_PATHS = ["src/session.js", "multiplayer/session.js"];

/** The folder a command works on: the positional directory, else --into, else the current folder. Must exist. */
export function projectDir({ dir, opts, cwd }) {
  if (dir !== undefined && opts.into !== undefined) throw new CliError("bad_flag", "give a directory or --into <dir>, not both");
  const target = resolve(cwd, dir ?? opts.into ?? ".");
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new CliError("no_such_dir", `${target} is not an existing folder`);
  return target;
}

/**
 * `{ kind, dir, glue? }`: kind "godot-gdscript" (project.godot, no .csproj / .sln), "godot-csharp", "web" (onelobby.json and the
 * web glue) or null. `requireBlueprint`: a Godot project also needs onelobby.json (verify needs it, update does not).
 */
export function detectProject(dir, { requireBlueprint = false } = {}) {
  const has = (p) => existsSync(join(dir, ...p.split("/")));
  if (has("project.godot")) {
    if (isCSharpProject(readdirSync(dir))) return { kind: "godot-csharp", dir };
    if (requireBlueprint && !has("onelobby.json")) return { kind: null, dir, why: "project.godot but no onelobby.json" };
    return { kind: "godot-gdscript", dir };
  }
  if (has("onelobby.json")) {
    const glue = WEB_GLUE_PATHS.find(has);
    if (glue) return { kind: "web", dir, glue };
    return { kind: null, dir, why: "onelobby.json but no web glue (src/session.js or multiplayer/session.js)" };
  }
  return { kind: null, dir, why: "no project.godot and no onelobby.json" };
}

/** The error for a folder that is not a OneLobby game create-onelobby knows. */
export const notAProject = (found, command) =>
  new CliError(
    "not_a_project",
    `${found.dir} is not a OneLobby game this version of create-onelobby can ${command} (${found.why}). Run it in a folder made by create-onelobby (a Godot GDScript project with project.godot and onelobby.json, or a web project with onelobby.json and src/session.js), or point it there with --into <dir>.`,
  );

/** A Godot C# project is detected but its template is not built yet. */
export const csharpPlanned = (dir) =>
  new CliError("template_planned", `${dir} is a Godot C# project (a .csproj or .sln sits next to project.godot): the godot-csharp template is planned for v2. Follow docs/recipes/godot-csharp.md for now.`);
