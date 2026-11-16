// The `wiring` check: a static look, no process started. `verify` proves the routes with its own two peers, so a game whose
// scenes or page never touch OneLobby would still pass them; this check fails until some file of the game does.
//   godot-gdscript, ui.kind drop-in: a scene or script outside addons/ and tests/ builds the menu: its scene path (res://addons/onelobby/menu/menu.tscn) or OneLobbyMenu.new(.
//     Comments are skipped, and so is a bare mention of the class (a type annotation, "Net.client"): only a file that builds the menu counts.
//   godot-csharp,   ui.kind drop-in: the same for the OneLobbyMenu.tscn path or new OneLobbyMenu( (not OneLobbyNet.cs, which the scaffolder wrote)
//   godot, ui.kind none or generated: a script outside addons/ and tests/ uses the client (OneLobbyClient; not net.gd, the scaffolder's autoload)
//   unity, ui.kind drop-in: a .cs file outside Packages/, Library/ and Assets/OneLobby/ (the scaffolder's test and build script) BUILDS the menu
//     (AddComponent<OneLobbyMenu>(); comments skipped), or a scene or prefab holds the component (found by its script guid): naming the runner or
//     the client alone does not count, as with the Godot menu. ui.kind none or generated: a script uses the runner or the client
//   web: a file outside test/ and node_modules/ imports the glue (session.js) or onelobby (not the glue file itself)
// Every project the scaffolder writes passes untouched; a fresh `--into` fails until the game is wired.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WEB_GLUE_PATHS } from "../project.js";

const SKIP_DIRS = new Set(["addons", "tests", "test", "node_modules"]);
const GODOT_FILES = /\.(tscn|gd|cs|tres)$/i;
const UNITY_SKIP = new Set(["Packages", "Library", "Temp", "Logs", "UserSettings", "Builds", "obj", "node_modules"]);
const WEB_FILES = /\.(html?|[cm]?[jt]sx?)$/i;

// Unity: code that builds the menu (a mention of the class, a field of its type or a using line is not it). The menu's script guid (the package's OneLobbyMenu.cs.meta) names it in a scene or prefab.
const UNITY_MENU_BUILD = /\bAddComponent\s*<\s*OneLobbyMenu\s*>|\bAddComponent\s*\(\s*typeof\s*\(\s*OneLobbyMenu\s*\)|\bInstantiate\s*<\s*OneLobbyMenu\s*>/;
export const UNITY_MENU_GUID = "cbe34bd5e4d6f3845943d8e150050af8";

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

/** Scenes and prefabs under Assets/ (outside Assets/OneLobby/) that hold the OneLobbyMenu component, found by its script guid. */
function unityAssetsWithMenu(dir) {
  const assets = join(dir, "Assets");
  if (!existsSync(assets)) return [];
  return gameFiles(dir, /\.(unity|prefab)$/i, UNITY_SKIP, "Assets").filter((f) => !f.startsWith("Assets/OneLobby/") && readFileSync(join(dir, f), "utf8").includes(`guid: ${UNITY_MENU_GUID}`));
}

/** The first file whose text matches `regex`, or undefined. */
const firstMatch = (dir, files, regex) => files.find((f) => regex.test(readFileSync(join(dir, f), "utf8")));

// `text` of the game file `path` without its comments, so a mention in a comment is not a use: `#` (GDScript; a `#` inside a quoted string
// stays), `//` and block comments (C#), a `;` line (a scene, a .tres or project.godot).
export function withoutComments(path, text) {
  if (/\.(tscn|tres)$|(^|\/)project\.godot$/i.test(path)) return text.replace(/^[ \t]*;.*$/gm, "");
  if (/\.cs$/i.test(path)) {
    const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, "");
    return noBlocks.replace(/^(.*?)\/\/.*$/gm, (whole, head) => (head.split('"').length % 2 === 0 ? whole : head));
  }
  if (!/\.gd$/i.test(path)) return text;
  return text
    .split("\n")
    .map((line) => {
      let quote = "";
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === "\\") i++;
          else if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "#") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** Every file whose text matches `regex` once its comments are taken out, in the order of `files`. */
const codeMatches = (dir, files, regex) => files.filter((f) => regex.test(withoutComments(f, readFileSync(join(dir, f), "utf8"))));

/** Every file whose text matches `regex`, in the order of `files`. */
const allMatches = (dir, files, regex) => files.filter((f) => regex.test(readFileSync(join(dir, f), "utf8")));

/** How many wired files a passing `wiring` line names before it says "and N more". */
export const WIRING_LIST_MAX = 5;

/** The detail of a passing check: one file keeps the plain sentence (`<file> <what>`); several give the count and the first few. */
export function wiringDetail(hits, what) {
  if (hits.length === 1) return `${hits[0]} ${what}`;
  const shown = hits.slice(0, WIRING_LIST_MAX).join(", ");
  const more = hits.length > WIRING_LIST_MAX ? ` and ${hits.length - WIRING_LIST_MAX} more` : "";
  return `${hits.length} files ${what.replace(/^uses\b/, "use").replace(/^imports\b/, "import").replace(/^builds\b/, "build")}: ${shown}${more}`;
}

/** The host call of a Node process that serves pages: a call or an import of hostDirect / hostNostr (a mention in a comment line is not it). */
export const NODE_HOST_CALL = /^(?!\s*(?:\/\/|\*|\/\*)).*\b(?:hostDirect|hostNostr)\b/m;

/** The onelobby.json's engine (unreadable or unset: null). */
function engineOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "onelobby.json"), "utf8"))?.engine ?? null;
  } catch {
    return null;
  }
}

/** The onelobby.json's ui.kind (unreadable or unset: the drop-in menu, the default of both Godot templates). */
function uiKind(dir, file = "onelobby.json") {
  try {
    return JSON.parse(readFileSync(join(dir, ...file.split("/")), "utf8"))?.ui?.kind ?? "drop-in";
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
        if (engineOf(dir) === "node-browser") {
          // a Node process hosts and the pages only join: the thing to find is the HOST file that opens the lobby, not any file that mentions "onelobby"
          const hosts = allMatches(dir, files, NODE_HOST_CALL);
          if (hosts.length) return { status: "ok", detail: wiringDetail(hosts, "opens the lobby (hostDirect or hostNostr)") };
          const mentions = allMatches(dir, files, /["']onelobby(?:\/[^"']*)?["']/);
          return {
            status: "fail",
            detail: `engine node-browser: no file outside test/ and node_modules/ calls hostDirect or hostNostr, so the Node process never opens a lobby for the pages${mentions.length ? ` (${mentions.slice(0, WIRING_LIST_MAX).join(", ")} mention onelobby only)` : ""} (the routes pass on their own two peers).`,
            next: 'In the Node file that serves the page: get hostDirect from "onelobby/direct" (a CommonJS file: const { hostDirect } = await import("onelobby/direct") inside an async function), build the kit with OneLobby.fromConfig and call hostDirect(kit, { http: page }); the page joins with kit.joinDirect(location.host) (docs/recipes/browser-game.md sections 3 and 4).',
          };
        }
        const uses = /["'](?:[^"'\s]*\/)?session\.m?js["']|["']onelobby(?:\/[^"']*)?["']|onelobby\.(?:global|bundle)/;
        const hits = allMatches(dir, files, uses);
        if (hits.length) return { status: "ok", detail: wiringDetail(hits, "imports the OneLobby glue") };
        return {
          status: "fail",
          detail: `no file outside test/ and node_modules/ imports ${glue} or onelobby, so the game never opens a lobby (the routes pass on their own two peers).`,
          next: `Wire the page: import { loadBlueprint, makeKit, bindSession } from "./${glue}" and call them (docs/recipes/js-web.md).`,
        };
      }

      if (ctx.kind === "unity") {
        const files = gameFiles(dir, /\.cs$/i, UNITY_SKIP).filter((f) => !f.startsWith("Assets/OneLobby/"));
        const kind = uiKind(dir, "Assets/Resources/onelobby.json");
        if (kind === "drop-in") {
          // the menu must be BUILT: added by code (AddComponent<OneLobbyMenu>) or put on a GameObject in a scene or prefab; naming the runner or the client alone is not a menu
          const hits = [...codeMatches(dir, files, UNITY_MENU_BUILD), ...unityAssetsWithMenu(dir)];
          if (hits.length) return { status: "ok", detail: wiringDetail(hits, "builds the drop-in menu") };
          const clientOnly = allMatches(dir, files, /\b(?:OneLobbyRunner|LobbyClient)\b/);
          return {
            status: "fail",
            detail: `no script outside Packages/ and Assets/OneLobby/ builds the drop-in menu (AddComponent<OneLobbyMenu>(), or a scene or prefab with the component; a comment, the runner or the client alone does not count), so the game never shows it${clientOnly.length ? ` (${clientOnly.slice(0, WIRING_LIST_MAX).join(", ")}${clientOnly.length > WIRING_LIST_MAX ? ` and ${clientOnly.length - WIRING_LIST_MAX} more` : ""} mention${clientOnly.length === 1 ? "s" : ""} the runner or the client only)` : ""} (the routes pass on their own two peers).`,
            next: 'Add the menu where your game starts: var go = new GameObject("Menu"); go.SetActive(false); var menu = go.AddComponent<OneLobbyMenu>(); (set Runner, BootFlags, StartOnHost, ...) go.SetActive(true); with using OneLobby.Unity; and connect its GameStarted event (docs/recipes/unity.md, "--into a game that already has its own multiplayer", step 2; docs/recipes/menu.md, "Unity"). A game with no menu on purpose sets ui.kind to "none" in onelobby.json.',
          };
        }
        const hits = allMatches(dir, files, /\b(?:OneLobbyMenu|OneLobbyRunner|LobbyClient)\b/);
        if (hits.length) return { status: "ok", detail: wiringDetail(hits, `uses the client (ui.kind ${kind})`) };
        return {
          status: "fail",
          detail: `ui.kind is ${kind} and no script outside Packages/ and Assets/OneLobby/ uses OneLobbyRunner or the client, so the game never opens a lobby.`,
          next: "Create and use the runner or the client from your own scripts (docs/recipes/unity.md).",
        };
      }

      const csharp = ctx.kind === "godot-csharp";
      const files = gameFiles(dir, GODOT_FILES, SKIP_DIRS).filter((f) => f !== "net.gd" && f !== "OneLobbyNet.cs");
      const kind = uiKind(dir);
      if (kind === "drop-in") {
        const regex = csharp ? /OneLobbyMenu\.tscn|\bnew\s+OneLobbyMenu\s*\(/ : /addons\/onelobby\/menu\/menu\.tscn|\bOneLobbyMenu\.new\s*\(/;
        if (existsSync(join(dir, "project.godot"))) files.push("project.godot"); // the menu as the main scene or an autoload
        const hits = codeMatches(dir, files, regex);
        if (hits.length) return { status: "ok", detail: wiringDetail(hits, "builds the drop-in menu") };
        const scene = csharp ? "res://addons/onelobby_menu/OneLobbyMenu.tscn" : "res://addons/onelobby/menu/menu.tscn";
        return {
          status: "fail",
          detail: "no scene or script outside addons/ and tests/ builds the drop-in menu (its scene path or OneLobbyMenu.new; a comment, a type annotation or the client alone does not count), so the game never shows it (the routes pass on their own two peers).",
          next: `Instance ${scene} in your menu scene and connect ${csharp ? "its GameStarted event" : "its game_started signal"} (docs/recipes/menu.md).`,
        };
      }
      const regex = csharp ? /\b(?:OneLobbyClient|LobbyClient)\b/ : /\bOneLobbyClient\b|\bNet\.client\b/;
      const hits = allMatches(dir, files, regex);
      if (hits.length) return { status: "ok", detail: wiringDetail(hits, `uses the client (ui.kind ${kind})`) };
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

// ---- the `player` check: a game with the networked player (a pure file check, like `wiring`) ----------------------------------------
// It is in the list only when the game has the networked player: a scene or script outside addons/ and tests/ names the node, or (godot-csharp)
// addons/onelobby_net_player/ is there; unity: a .cs file outside Packages/, Library/ and Assets/OneLobby/ adds the OneLobbyNetPlayer component. Then it needs both halves: a character scene with the OneLobbyNetPlayer node, and something that
// spawns one character per player (the spawner or the layer). It proves nothing about the link: the `direct` check's test does that.
// the node: a scene that has it (its script is a resource of the scene) or code that makes one; a mention in a comment is not the node
const NODE_REGEX = {
  gd: /addons\/onelobby\/net_player\.gd|\bOneLobbyNetPlayer\.new\(/,
  cs: /addons\/onelobby_net_player\/OneLobbyNetPlayer\.cs|\bnew\s+OneLobbyNetPlayer\b(?!Spawner)/,
};
const SPAWN_REGEX = { gd: /\bOneLobbyNetPlayerSpawner\b|\bOneLobbyNetPlayers\b/, cs: /\bOneLobbyNetPlayerSpawner\b|\bNetPlayers\b/ };
// Unity: code that adds the component (a scene or prefab names it by script id, not by name, so only code is looked at; a mention in a comment is not it)
const UNITY_NODE_REGEX = /\bAddComponent\s*<\s*OneLobbyNetPlayer\s*>|\bAddComponent\s*\(\s*typeof\s*\(\s*OneLobbyNetPlayer\s*\)|\bRequireComponent\s*\(\s*typeof\s*\(\s*OneLobbyNetPlayer\s*\)/;
const unityFiles = (dir) => gameFiles(dir, /\.cs$/i, UNITY_SKIP).filter((f) => !f.startsWith("Assets/OneLobby/"));

/** True when this game has the networked player (see above). */
export function hasNetPlayer(dir, kind) {
  if (kind === "unity") return firstMatch(dir, unityFiles(dir), UNITY_NODE_REGEX) !== undefined;
  if (kind !== "godot-gdscript" && kind !== "godot-csharp") return false;
  const csharp = kind === "godot-csharp";
  if (csharp && existsSync(join(dir, "addons/onelobby_net_player/PIN.json"))) return true;
  const files = gameFiles(dir, GODOT_FILES, SKIP_DIRS);
  return firstMatch(dir, files, NODE_REGEX[csharp ? "cs" : "gd"]) !== undefined;
}

export function playerCheck() {
  return {
    name: "player",
    async run(ctx) {
      const dir = ctx.dir;
      if (ctx.kind === "unity") return unityPlayerCheck(dir);
      const csharp = ctx.kind === "godot-csharp";
      const files = gameFiles(dir, GODOT_FILES, SKIP_DIRS);
      const node = firstMatch(dir, files, NODE_REGEX[csharp ? "cs" : "gd"]);
      const spawn = firstMatch(dir, files, SPAWN_REGEX[csharp ? "cs" : "gd"]);
      if (node && spawn) return { status: "ok", detail: `${node} has the OneLobbyNetPlayer node, ${spawn} spawns the characters` };
      const recipe = csharp ? "docs/recipes/net-player.md section 10b" : "docs/recipes/net-player.md section 10";
      if (node)
        return {
          status: "fail",
          detail: `${node} has a OneLobbyNetPlayer node but no scene or script outside addons/ and tests/ spawns the characters (no OneLobbyNetPlayerSpawner or ${csharp ? "NetPlayers" : "OneLobbyNetPlayers"}), so no player appears in the world.`,
          next: `Add a spawner where your game starts: ${csharp ? 'new OneLobbyNetPlayerSpawner { Scene = ... }, AddChild, then Start(lobby, blueprint)' : "OneLobbyNetPlayerSpawner.new() with scene set, add_child, then start(lobby, config)"} (${recipe}).`,
        };
      return {
        status: "fail",
        detail: `no scene or script outside addons/ and tests/ has a OneLobbyNetPlayer node${spawn ? "" : " or a spawner"}, so no player appears in the world (${csharp ? "addons/onelobby_net_player/ is there but unused" : "the game spawns characters without the node"}).`,
        next: `Put a OneLobbyNetPlayer node under your character scene and spawn it with OneLobbyNetPlayerSpawner (${recipe}).`,
      };
    },
  };
}

/** The same check for a Unity game: the component is added by a script and a script spawns the characters. */
function unityPlayerCheck(dir) {
  const files = unityFiles(dir);
  const node = firstMatch(dir, files, UNITY_NODE_REGEX);
  const spawn = firstMatch(dir, files, SPAWN_REGEX.cs);
  if (node && spawn) return { status: "ok", detail: `${node} has the OneLobbyNetPlayer component, ${spawn} spawns the characters` };
  const recipe = "docs/recipes/net-player.md section 12";
  if (node)
    return {
      status: "fail",
      detail: `${node} has a OneLobbyNetPlayer component but no script outside Packages/ and Assets/OneLobby/ spawns the characters (no OneLobbyNetPlayerSpawner or NetPlayers), so no player appears in the world.`,
      next: `Add a spawner where your game starts: gameObject.AddComponent<OneLobbyNetPlayerSpawner>() with Factory or Prefab set, then Begin(lobby, blueprint) (${recipe}).`,
    };
  return {
    status: "fail",
    detail: `no script outside Packages/ and Assets/OneLobby/ adds a OneLobbyNetPlayer component${spawn ? "" : " or a spawner"}, so no player appears in the world.`,
    next: `Put a OneLobbyNetPlayer component on your character and spawn it with OneLobbyNetPlayerSpawner (${recipe}).`,
  };
}
