// Editing a Godot project.godot in place: register one autoload and keep every other byte of the file.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./flags.js";

/**
 * Register `name="*path"` in the `[autoload]` section of a project.godot text.
 * Returns { text, changed }. Keeps the file's line endings and everything outside the one line it adds.
 *  - no `[autoload]` section: one is appended at the end;
 *  - a section: the line goes BEFORE its first entry, so OneLobby's Net (which makes `Net.client` in its own `_ready`) loads before the game's own autoloads
 *    that read it (Godot loads autoloads in file order);
 *  - the entry already there (also as a `uid://` path, when `resolveUid` maps it to the same file): nothing changes;
 *  - the name taken by another path: throws autoload_taken.
 */
export function addAutoload(text, name, path, { resolveUid } = {}) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const wanted = `*${path}`;
  const parts = text.split(/(\r\n|\n)/); // line, separator, line, separator ...: every byte outside the added line stays as it was
  const lines = parts.filter((_, i) => i % 2 === 0);
  const header = (l) => /^\s*\[[^\]]*\]\s*$/.test(l);
  const start = lines.findIndex((l) => /^\s*\[autoload\]\s*$/.test(l));

  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++)
      if (header(lines[i])) {
        end = i;
        break;
      }
    let lastEntry = start;
    let firstEntry = -1;
    for (let i = start + 1; i < end; i++) {
      const m = lines[i].match(/^\s*([^=;\s][^=]*?)\s*=\s*"(.*)"\s*$/);
      if (lines[i].trim() !== "" && !lines[i].trim().startsWith(";")) {
        lastEntry = i;
        if (firstEntry < 0) firstEntry = i;
      }
      if (m && m[1] === name) {
        const value = m[2];
        // an enabled autoload (leading *) of the same file, written as its path or as the file's uid://
        const target = value.replace(/^\*/, "");
        const samePath = target === path || (target.startsWith("uid://") && resolveUid?.(target) === path);
        if (value.startsWith("*") && samePath) return { text, changed: false };
        throw new CliError("autoload_taken", `project.godot already has an autoload named ${name} that points at ${value.replace(/^\*/, "")}, not ${path}; rename the game's autoload (and every use of it: Net.x calls, \"/root/${name}\", get_node(\"${name}\"), scene and script paths), or remove it: there is no flag to give OneLobby's another name`, `autoload.${name}`);
      }
    }
    const add = `${name}="${wanted}"`;
    if (firstEntry >= 0) {
      parts.splice(2 * firstEntry, 0, add, parts[2 * firstEntry - 1] ?? eol);
      return { text: parts.join(""), changed: true };
    }
    const sep = parts[2 * lastEntry + 1];
    if (sep === undefined) parts.splice(2 * lastEntry + 1, 0, eol, add); // the section runs to the end of a file with no final line break
    else parts.splice(2 * lastEntry + 2, 0, add, sep);
    return { text: parts.join(""), changed: true };
  }

  // no section: append one, after a blank line, and end the file with a line break
  const body = text === "" || text.endsWith("\n") ? text : text + eol;
  const gap = body === "" || body.endsWith(eol + eol) ? "" : eol;
  return { text: `${body}${gap}[autoload]${eol}${eol}${name}="${wanted}"${eol}`, changed: true };
}

/** Does this folder hold a Godot C# project (a .csproj or .sln next to project.godot)? `names`: the folder's file names. */
export const isCSharpProject = (names) => names.some((n) => /\.(csproj|sln)$/i.test(n));

const WEB_FILE = /\.(html?|[cm]?[jt]s)$/i;

/** Is there a web file (.html, .js, .mjs, .ts, ...) or a package.json in `dir`, or one or two folders down (not node_modules or dot folders)? */
function holdsWebFiles(dir, depth = 0) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && (e.name === "package.json" || WEB_FILE.test(e.name))) return true;
    if (e.isDirectory() && depth < 2 && e.name !== "node_modules" && !e.name.startsWith(".") && holdsWebFiles(join(dir, e.name), depth + 1)) return true;
  }
  return false;
}

/**
 * What `--into <dir>` can tell from the files alone, with no --template: `{ engine, web }`. `engine` is "godot-gdscript" / "godot-csharp"
 * (project.godot), "unity" (ProjectSettings/ProjectVersion.txt, or ProjectSettings/ beside Assets/), "dotnet" (a .csproj / .sln and no
 * project.godot) or null; `web`: the folder holds web files. Nothing found: both falsy (the caller must not guess web).
 */
export function sniffFolder(dir) {
  const names = readdirSync(dir);
  const isDir = (n) => existsSync(join(dir, n)) && statSync(join(dir, n)).isDirectory();
  if (names.includes("project.godot")) return { engine: isCSharpProject(names) ? "godot-csharp" : "godot-gdscript", web: false };
  if (existsSync(join(dir, "ProjectSettings", "ProjectVersion.txt")) || (isDir("ProjectSettings") && isDir("Assets"))) return { engine: "unity", web: false };
  if (isCSharpProject(names)) return { engine: "dotnet", web: false };
  return { engine: null, web: holdsWebFiles(dir) };
}
