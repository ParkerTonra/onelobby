// The `wiring` check: a static look, no process started. `verify` proves the routes with its own two peers, so a game whose
// scenes or page never touch OneLobby would still pass them; this check fails until some file of the game does.
//   godot-gdscript, ui.kind drop-in: a scene or script outside addons/ and tests/ names the menu (res://addons/onelobby/menu/menu.tscn, OneLobbyMenu)
//   godot-csharp,   ui.kind drop-in: the same for OneLobbyMenu.tscn / OneLobbyMenu (not OneLobbyNet.cs, which the scaffolder wrote)
//   godot, ui.kind none or generated: a script outside addons/ and tests/ uses the client (OneLobbyClient; not net.gd, the scaffolder's autoload)
//   unity: a .cs file outside Packages/, Library/ and Assets/OneLobby/ (the scaffolder's test and build script) uses OneLobbyMenu, OneLobbyRunner or the client
//   web: a file outside test/ and node_modules/ imports the glue (session.js) or onelobby (not the glue file itself)
// Every project the scaffolder writes passes untouched; a fresh `--into` fails until the game is wired.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WEB_GLUE_PATHS } from "../project.js";

const SKIP_DIRS = new Set(["addons", "tests", "test", "node_modules"]);
const GODOT_FILES = /\.(tscn|gd|cs|tres)$/i;
const UNITY_SKIP = new Set(["Packages", "Library", "Temp", "Logs", "UserSettings", "Builds", "obj", "node_modules"]);
const WEB_FILES = /\.(html?|[cm]?[jt]sx?)$/i;

/** Every file of the game (relative posix paths) that `pattern` accepts, skipping dot folders and `skipDirs`. */
function gameFiles(dir, pattern, skipDirs, rel = "") {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!e.name.startsWith(".") && !skipDirs.has(e.name)) out.push(...gameFiles(dir, pattern, skipDirs, path));
    } else if (e.isFile() && pattern.test(e.name)) out.push(path);
  }
  return out;
}

/** The first file whose text matches `regex`, or undefined. */
const firstMatch = (dir, files, regex) => files.find((f) => regex.test(readFileSync(join(dir, f), "utf8")));

/** The onelobby.json's ui.kind (unreadable or unset: the drop-in menu, the default of both Godot templates). */
function uiKind(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "onelobby.json"), "utf8"))?.ui?.kind ?? "drop-in";
  } catch {
    return "drop-in";
  }
}

export function wiringCheck() {
  return {
    name: "wiring",
    async run(ctx) {
      const dir = ctx.dir;
      if (ctx.kind === "web") {
        const glue = WEB_GLUE_PATHS.find((p) => existsSync(join(dir, ...p.split("/")))) ?? "multiplayer/session.js";
        const files = gameFiles(dir, WEB_FILES, SKIP_DIRS).filter((f) => f !== glue);
        const uses = /["'](?:[^"'\s]*\/)?session\.js["']|["']onelobby(?:\/[^"']*)?["']|onelobby\.(?:global|bundle)/;
        const hit = firstMatch(dir, files, uses);
        if (hit) return { status: "ok", detail: `${hit} imports the OneLobby glue` };
        return {
          status: "fail",
          detail: `no file outside test/ and node_modules/ imports ${glue} or onelobby, so the game never opens a lobby (the routes pass on their own two peers).`,
          next: `Wire the page: import { loadBlueprint, makeKit, bindSession } from "./${glue}" and call them (docs/recipes/js-web.md).`,
        };
      }

      if (ctx.kind === "unity") {
        const files = gameFiles(dir, /\.cs$/i, UNITY_SKIP).filter((f) => !f.startsWith("Assets/OneLobby/"));
        const hit = firstMatch(dir, files, /\b(?:OneLobbyMenu|OneLobbyRunner|LobbyClient)\b/);
        if (hit) return { status: "ok", detail: `${hit} uses the menu or the client` };
        return {
          status: "fail",
          detail: "no script outside Packages/ and Assets/OneLobby/ uses OneLobbyMenu, OneLobbyRunner or the client, so the game never shows a menu or opens a lobby (the routes pass on their own two peers).",
          next: 'Add the menu where your game starts: new GameObject("Menu").AddComponent<OneLobbyMenu>(); with using OneLobby.Unity; and connect its GameStarted event (docs/recipes/menu.md, "Unity").',
        };
      }

      const csharp = ctx.kind === "godot-csharp";
      const files = gameFiles(dir, GODOT_FILES, SKIP_DIRS).filter((f) => f !== "net.gd" && f !== "OneLobbyNet.cs");
      const kind = uiKind(dir);
      if (kind === "drop-in") {
        const regex = csharp ? /\bOneLobbyMenu(?:\.tscn)?\b/ : /addons\/onelobby\/menu\/menu\.tscn|\bOneLobbyMenu\b/;
        if (existsSync(join(dir, "project.godot"))) files.push("project.godot"); // the menu as the main scene or an autoload
        const hit = firstMatch(dir, files, regex);
        if (hit) return { status: "ok", detail: `${hit} uses the drop-in menu` };
        const scene = csharp ? "res://addons/onelobby_menu/OneLobbyMenu.tscn" : "res://addons/onelobby/menu/menu.tscn";
        return {
          status: "fail",
          detail: "no scene or script outside addons/ and tests/ uses the drop-in menu, so the game never shows it (the routes pass on their own two peers).",
          next: `Instance ${scene} in your menu scene and connect ${csharp ? "its GameStarted event" : "its game_started signal"} (docs/recipes/menu.md).`,
        };
      }
      const regex = csharp ? /\b(?:OneLobbyClient|LobbyClient)\b/ : /\bOneLobbyClient\b|\bNet\.client\b/;
      const hit = firstMatch(dir, files, regex);
      if (hit) return { status: "ok", detail: `${hit} uses the client (ui.kind ${kind})` };
      return {
        status: "fail",
        detail: `ui.kind is ${kind} and no script outside addons/ and tests/ uses the client (${csharp ? "LobbyClient" : "OneLobbyClient or the Net autoload"}), so the game never opens a lobby.`,
        next: csharp ? "Create and use the client from your own scripts (docs/recipes/godot-csharp.md)." : "Use the Net autoload's client from your own scripts (docs/recipes/godot-gdscript.md).",
      };
    },
  };
}

/**
 * The next-step text for a blueprint that does not load. A key like "$comment tickRate" (a note given a name of its own) is the
 * one mistake the file's own rule covers, so it gets the rule; `path`: the loader's path, `fallback`: the usual text.
 */
export function blueprintNext(path, fallback) {
  const last = String(path ?? "").split(".").pop();
  if (last.startsWith("$comment") && last !== "$comment")
    return `A note goes in a key named exactly "$comment", one per object ("${last}" is an unknown key): rename it and put the text of all that object's notes in the one "$comment" string.`;
  return fallback;
}
