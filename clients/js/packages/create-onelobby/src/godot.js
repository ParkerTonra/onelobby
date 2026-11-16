// The `godot-gdscript` template: a new Godot 4 project, or `--into` an existing GDScript project. Plans first (no writes, no
// download), then applies. The engine-neutral parts (vendoring, pin, blocks, zip) live in vendor.js.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./flags.js";
import { keepOnelobbyJson } from "./recommend.js";
import { SCHEMA_URL } from "./blueprint.js";
import { addAutoload, isCSharpProject } from "./godot-project.js";
import { pickBlocks, playerFlags, resolveNetPlayer } from "./net-player.js";
import {
  GITATTRIBUTES_LINES,
  GITIGNORE_LINES,
  NATIVES_DIR,
  NATIVES_MARKER,
  PIN_PATH,
  WEBRTC_NATIVE_VERSION,
  WEBRTC_NATIVE_ZIP_SHA256,
  addonSource,
  applyBlock,
  buildPin,
  loadNatives,
} from "./vendor.js";

const templates = join(dirname(fileURLToPath(import.meta.url)), "../templates/godot-gdscript");
const read = (...p) => readFileSync(join(templates, ...p), "utf8").replace(/\r\n/g, "\n"); // LF whatever the checkout did

export const GODOT_RECIPE_URL = "https://github.com/ParkerTonra/onelobby/blob/main/docs/recipes/godot-gdscript.md";
export const AUTOLOAD_NAME = "Net";
export const AUTOLOAD_PATH = "res://net.gd";
/** The port a direct host listens on unless told otherwise (OneLobbyDirectHost.DEFAULT_PORT). */
export const DEFAULT_DIRECT_PORT = 47810;

const slugOf = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "game";
const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
const json = (o) => JSON.stringify(o, null, 2) + "\n";
const quoteGd = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const bytes = (c) => (Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8"));

/** .olc/<slug>.json: two tasks that open the game as a host window plus a small joiner window on this PC (Godot from $GODOT). */
export function olcEntry({ slug, title, build = false }) {
  const joiner = `--join=127.0.0.1:${DEFAULT_DIRECT_PORT} --local --name=Joiner`;
  const psBuild = build ? `${build}; if ($LASTEXITCODE -ne 0) { exit 1 }; ` : ""; // build: a command line (godot-csharp builds first)
  const shBuild = build ? `${build} || exit 1; ` : "";
  const ps = `${psBuild}$g = if ($env:GODOT) { $env:GODOT } else { 'godot' }; Start-Process -FilePath $g -ArgumentList '--path','.','--','--host','--local','--name=Host'; Start-Sleep -Seconds 4; & $g --path . --resolution 640x360 -- ${joiner}`;
  const sh = `${shBuild}G="\${GODOT:-godot}"; "$G" --path . -- --host --local --name=Host & sleep 4; "$G" --path . --resolution 640x360 -- ${joiner}`;
  const entry = (suffix, shell, command) => ({ name: `${slug}-play${suffix}`, label: `${title} - host + joiner${suffix ? ` (${shell})` : ""}`, kind: "task", group: slug, cwd: ".", command, shell, play: true });
  return json({ entries: [entry("", "powershell", ps), entry("-bash", "bash", sh)] });
}

/** The two lines of the generated test that call the player check, and where they go (before the peers leave). */
const TEST_LEAVE = "\tgl.leave()\n\thl.leave()\n";
const TEST_PLAYER_CALL = "\tif not await _check_player(hl, gl):\n\t\treturn\n";
/** The AGENTS.md bullet about the main scene, which a game with players words differently. */
const AGENTS_MAIN_BULLET = "- `main.tscn` / `main.gd`: the drop-in menu (`addons/onelobby/menu/menu.tscn`) plus a label that shows the roster on `game_started`.\n  Start your game in the `game_started` handler; end it on `returned_to_lobby` or `left`. The menu doc: docs/recipes/menu.md in the OneLobby repo.\n";

/** The files a game with players in the world gets besides the common ones (new project): { path, content }. `read` reads a template file as LF text. */
export function netPlayerFiles({ authority, space }, read) {
  const flags = playerFlags({ authority, space });
  const dim = space === "2d" ? "2d" : "3d";
  return [
    { path: "main.tscn", content: read("net-player", "main.tscn") },
    { path: "main.gd", content: read("net-player", "main.gd") },
    { path: "player.tscn", content: read("net-player", `player_${dim}.tscn`) },
    { path: "player.gd", content: pickBlocks(read("net-player", `player_${dim}.gd`), flags) },
    { path: "game.gd", content: pickBlocks(read("net-player", `game_${dim}.gd`), flags) },
  ];
}

/** tests/multiplayer.gd with the player check added: the joiner's player appears on the host with a position, and one jump arrives once. */
export function multiplayerWithPlayer(base, part, settings) {
  if (!base.includes(TEST_LEAVE)) throw new Error("tests/multiplayer.gd: the place for the player check moved");
  return base.replace(TEST_LEAVE, TEST_PLAYER_CALL + TEST_LEAVE) + pickBlocks(part, playerFlags(settings));
}

/** AGENTS.md of a game with players: the bullets for the character, the game script and the check. */
export function agentsWithPlayer(agents, { authority, space }) {
  if (!agents.includes(AGENTS_MAIN_BULLET)) throw new Error("AGENTS.md: the main-scene bullet moved");
  const what = authority === "host" ? 'the host places every player (`sync.player.authority` "host": `player.gd` gives the node `set_input()` and one pure `step()`)' : "each player's own PC places its player (`sync.player.authority` \"owner\": `player.gd` moves the body as in any single-player game)";
  const withBullets = agents.replace(
    AGENTS_MAIN_BULLET,
    [
      "- `main.tscn` / `main.gd`: the drop-in menu (`addons/onelobby/menu/menu.tscn`); on `game_started` it opens `game.gd`, and frees it on `returned_to_lobby` or `left`. The menu doc: docs/recipes/menu.md in the OneLobby repo.",
      `- \`game.gd\`: the game (${space === "2d" ? "a floor and a camera" : "a floor, a light and a camera"}) and an \`OneLobbyNetPlayerSpawner\`: one character per player, created and removed as players come and go. Yours to edit.`,
      `- \`player.tscn\` / \`player.gd\`: the character (${space === "2d" ? "a square, side-on" : "a capsule"}) with a \`OneLobbyNetPlayer\` child; ${what}. Arrow keys or WASD move it and space jumps. Yours to edit: \`update\` never rewrites them.`,
      "",
    ].join("\n"),
  );
  const tail = "host, join by code, one message each way.\n";
  if (!withBullets.includes(tail)) throw new Error("AGENTS.md: the test bullet moved");
  return withBullets.replace(tail, "host, join by code, one message each way, then the networked player: the joiner's player appears on the host, follows the joiner, and one jump arrives once (`player.tscn` is used as it is).\n");
}

function targetState(target) {
  if (!existsSync(target)) return "missing";
  return statSync(target).isDirectory() ? (readdirSync(target).length ? "full" : "empty") : "file";
}

/**
 * Work out everything a run would do, writing nothing. Returns
 * { files: [{ path, content, action }], natives: { status, ... }, notes, projectGodot? } where action is
 * create | update | overwrite | unchanged | skip. Throws before anything is written when the plan cannot work.
 */
export function planGodot({ into, target, dirName, blueprint, opts, cwd, netPlayer = null }) {
  const addon = addonSource({ addonFrom: opts.addonFrom, cwd });
  const title = blueprint.game.title ?? dirName;
  const slug = slugOf(dirName);
  const vars = { title: quoteGd(title), mdTitle: title, recipeUrl: GODOT_RECIPE_URL, webrtcVersion: WEBRTC_NATIVE_VERSION, schemaUrl: SCHEMA_URL };

  const wanted = [{ path: "onelobby.json", content: json(blueprint) }];
  // players in the world (sync.player): a new project gets the character, the game and the check; --into only gets the printed lines
  const withPlayers = netPlayer !== null && !into;
  if (!into) {
    const agents = fill(read("AGENTS.md"), { ...vars, title: title.replace(/[\r\n]+/g, " ") });
    wanted.push(
      { path: "project.godot", content: fill(read("_project.godot"), vars) },
      ...(withPlayers ? netPlayerFiles(netPlayer, read) : [{ path: "main.tscn", content: read("main.tscn") }, { path: "main.gd", content: read("main.gd") }]),
      { path: "AGENTS.md", content: withPlayers ? agentsWithPlayer(agents, netPlayer) : agents },
    );
  }
  const multiplayerTest = read("tests/multiplayer.gd");
  wanted.push(
    { path: "net.gd", content: fill(read("net.gd"), vars) },
    { path: "tests/multiplayer.gd", content: withPlayers ? multiplayerWithPlayer(multiplayerTest, read("net-player", "multiplayer_part.gd"), netPlayer) : multiplayerTest },
  );
  for (const f of addon.files) wanted.push({ path: `addons/onelobby/${f.path}`, content: f.content });
  wanted.push({ path: PIN_PATH, content: buildPin({ files: addon.files, commit: addon.commit }) });
  wanted.push({ path: `.olc/${slug}.json`, content: olcEntry({ slug, title }) });

  const files = [];
  const notes = [];
  const abs = (p) => join(target, ...p.split("/"));
  for (const f of wanted) {
    const content = bytes(f.content);
    const p = abs(f.path);
    let action = "create";
    if (existsSync(p)) {
      if (statSync(p).isDirectory()) throw new CliError("exists", `${f.path} is a folder, expected a file`);
      action = readFileSync(p).equals(content) ? "unchanged" : opts.force ? "overwrite" : "skip";
    }
    files.push({ path: f.path, content, action });
  }

  // .gitignore and .gitattributes: a managed block, replaced in place or appended once
  for (const [path, lines, head] of [
    [".gitignore", GITIGNORE_LINES, undefined],
    [".gitattributes", GITATTRIBUTES_LINES, into ? undefined : "* text=auto\n"],
  ]) {
    const p = abs(path);
    const before = existsSync(p) ? readFileSync(p, "utf8") : head;
    const after = applyBlock(before, lines);
    const there = existsSync(p);
    files.push({ path, content: Buffer.from(after, "utf8"), action: there ? (after === before ? "unchanged" : "update") : "create" });
  }

  // project.godot: register the autoload in place (a new project's template already has it)
  if (into) {
    const p = abs("project.godot");
    const text = readFileSync(p, "utf8");
    const netPlan = files.find((f) => f.path === "net.gd");
    if (netPlan.action === "skip") {
      notes.push("net.gd already exists and differs, so it was left alone and project.godot was not touched; register your own autoload, or rerun with --force");
    } else {
      const resolveUid = (uid) => {
        const u = abs("net.gd.uid");
        return existsSync(u) && readFileSync(u, "utf8").trim() === uid ? AUTOLOAD_PATH : undefined;
      };
      const r = addAutoload(text, AUTOLOAD_NAME, AUTOLOAD_PATH, { resolveUid });
      files.push({ path: "project.godot", content: Buffer.from(r.text, "utf8"), action: r.changed ? "update" : "unchanged" });
    }
  }

  // natives
  const present = existsSync(abs(NATIVES_MARKER));
  let natives;
  if (opts.noNatives) natives = { status: "skipped", reason: "--no-natives" };
  else if (present && !opts.force) natives = { status: "present" };
  else natives = { status: "install", source: opts.webrtcDir ? "dir" : opts.webrtcZip ? "zip" : "download" };
  natives.version = WEBRTC_NATIVE_VERSION;
  natives.zipSha256 = WEBRTC_NATIVE_ZIP_SHA256;
  natives.folder = `${NATIVES_DIR}/`;
  return { files, natives, notes, addon: { commit: addon.commit, from: addon.from }, slug, netPlayer };
}

/** Write a plan: the files that are create / update / overwrite, then the natives. Returns { written, natives }. */
export async function applyGodot(plan, { target, opts, cwd, fetchImpl }) {
  // natives first: a failed download leaves the folder as it was
  let nativeFiles = [];
  if (plan.natives.status === "install") nativeFiles = await loadNatives({ webrtcZip: opts.webrtcZip, webrtcDir: opts.webrtcDir, cwd, fetchImpl });
  const written = [];
  const put = (path, content) => {
    const p = join(target, ...path.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  for (const f of plan.files) {
    if (f.action === "create" || f.action === "update" || f.action === "overwrite") {
      put(f.path, f.content);
      written.push(f.path);
    }
  }
  for (const f of nativeFiles) put(f.path, f.content);
  return { written, nativeFiles: nativeFiles.length };
}

/** `--into` with players on: the lines that add a spawner (nothing is written into the game's own scenes). `players`: { authority, space }. */
export function netPlayerLines({ authority, space }) {
  const body = space === "2d" ? "a CharacterBody2D" : "a CharacterBody3D";
  return [
    `players in the world (sync.player is on): add a spawner where your game starts, with your character scene (a scene whose root is ${body} with a OneLobbyNetPlayer child, ${authority === "host" ? "driven by set_input() and a step function" : "moved as you always did"}):`,
    '  var spawner := OneLobbyNetPlayerSpawner.new(); spawner.scene = preload("res://my_player.tscn"); add_child(spawner); spawner.start(lobby, OneLobbyConfig.load_file())   # lobby: the menu\'s game_started lobby; one character per player appears and goes by itself',
    `  (${authority === "host" ? 'authority "host": also set spawner.step_function = your pure step(state, input, dt) before spawner.start; ' : ""}docs/recipes/net-player.md section 10)`,
  ];
}

/** The `next` lines for the printed result. */
export function godotNext({ into, rel, plan }) {
  const players = plan.netPlayer ?? null;
  const next = [];
  if (rel !== ".") next.push(`cd ${rel}`);
  if (plan.natives.status === "skipped")
    next.push(`fetch the WebRTC natives (not installed yet): npx create-onelobby --into . --template godot-gdscript   (changes nothing else)`);
  next.push(`godot --headless --import --path .   # once${plan.natives.status === "skipped" ? " (and again after the natives are in)" : ""}: registers the WebRTC extension and the add-on's classes`);
  next.push("godot --headless --audio-driver Dummy --path . -s res://tests/multiplayer.gd   # expect MULTIPLAYER_OK");
  if (into) {
    next.push(
      "add the menu to your main scene: Scene > Instantiate Child Scene > res://addons/onelobby/menu/menu.tscn",
      "connect it: $Menu.game_started.connect(func(lobby): ...); $Menu.returned_to_lobby.connect(func(lobby): ...); $Menu.left.connect(func(): ...)",
      "try it on this PC only: godot --path . -- --host --local --name=Sam   (a second window: -- --join=127.0.0.1:47810 --local --name=Ann); the menu reads --local itself (127.0.0.1 only, no Nostr), so never run --host without it",
      ...(players ? netPlayerLines(players) : []),
      `follow ${GODOT_RECIPE_URL}`,
    );
  } else {
    next.push("godot --path . -- --host --local --name=Sam   # play: see AGENTS.md (or run the .olc entry)", `recipe: ${GODOT_RECIPE_URL}`);
  }
  return next;
}

/**
 * The whole godot-gdscript run after the answers are known. Returns the exit code.
 * `ctx`: { io, opts, blueprint, target, dirName, into, gitInit }.
 */
export async function runGodot(ctx) {
  const { io, opts, blueprint, target, dirName, into } = ctx;
  if (into) {
    if (!existsSync(join(target, "project.godot"))) throw new CliError("not_godot_project", `--into: ${target} has no project.godot; run this inside a Godot 4 project folder, or drop --into to make a new one`);
    if (isCSharpProject(readdirSync(target)))
      throw new CliError("wrong_template", `${target} is a Godot C# project (a .csproj or .sln sits next to project.godot), not a GDScript one: drop --template godot-gdscript (or use --template godot-csharp).`);
  } else {
    const state = targetState(target);
    if (state === "file") throw new CliError("exists", `${target} is a file`);
    if (state === "full" && !opts.force) throw new CliError("dir_not_empty", `${target} is not empty (use --force to write into it anyway)`);
  }
  const netPlayer = resolveNetPlayer({ wanted: ctx.netPlayer === true, blueprint, target, into, force: opts.force });
  const plan = planGodot({ into, target, dirName, blueprint, opts, cwd: io.cwd, netPlayer });
  const rel = relative(io.cwd, target) || ".";
  const listed = plan.files.filter((f) => f.action === "create" || f.action === "update" || f.action === "overwrite");
  const skipped = plan.files.filter((f) => f.action === "skip").map((f) => f.path);
  const unchanged = plan.files.filter((f) => f.action === "unchanged").map((f) => f.path);
  const natives = plan.natives;
  const wouldChange = listed.length > 0 || natives.status === "install";
  const next = godotNext({ into, rel, plan });
  const result = {
    ok: true,
    dir: target,
    template: "godot-gdscript",
    blueprint,
    files: listed.map((f) => f.path),
    skipped,
    unchanged: unchanged.length,
    natives: { status: natives.status, version: natives.version, zipSha256: natives.zipSha256, folder: natives.folder, ...(natives.source ? { source: natives.source } : {}), ...(natives.reason ? { reason: natives.reason } : {}) },
    addon: plan.addon,
    ...(netPlayer ? { netPlayer } : {}),
    notes: plan.notes,
    changed: wouldChange,
    next,
  };
  const recommendation = ctx.recommendation && keepOnelobbyJson(ctx.recommendation, plan.files.find((f) => f.path === "onelobby.json")?.action === "skip");
  if (recommendation) result.recommendation = recommendation.json;
  const fromRec = recommendation ? `\n\n${recommendation.text}` : "";
  const text = (verb) => {
    const out = [];
    if (!wouldChange) out.push(`Nothing changed: ${target} already has everything (${unchanged.length} files unchanged).`);
    else out.push(`${verb} ${target}`, ...listed.map((f) => `  ${f.path}${f.action === "create" ? "" : ` (${f.action})`}`));
    if (natives.status === "install") out.push(`  ${natives.folder} (webrtc-native ${natives.version}, from ${natives.source === "download" ? "a checked download" : natives.source === "zip" ? "--webrtc-zip" : "--webrtc-dir"})`);
    if (natives.status === "skipped") out.push("WebRTC natives not installed (--no-natives).");
    if (natives.status === "present") out.push(`${natives.folder} is already there; natives left as they are.`);
    if (skipped.length) out.push(`Skipped (already exist and differ; use --force to overwrite):`, ...skipped.map((p) => `  ${p}`));
    for (const n of plan.notes) out.push(`Note: ${n}`);
    return out.join("\n");
  };

  if (opts.dryRun) {
    result.dryRun = true;
    if (opts.json) io.stdout.write(JSON.stringify(result) + "\n");
    else io.stdout.write(`Dry run: nothing written, nothing downloaded.\n${text(into ? "Would add to" : "Would create")}\n\nonelobby.json:\n${JSON.stringify(blueprint, null, 2)}${fromRec}\n\nNext:\n${next.map((n) => `  ${n}`).join("\n")}\n`);
    return 0;
  }

  await applyGodot(plan, { target, opts, cwd: io.cwd, fetchImpl: io.fetch });
  if (!into && !opts.noGit && ctx.gitInit) ctx.gitInit(target);
  if (opts.json) io.stdout.write(JSON.stringify(result) + "\n");
  else io.stdout.write(`${text(into ? "Added to" : "Created")}${fromRec}\n\nNext:\n${next.map((n) => `  ${n}`).join("\n")}\n`);
  return 0;
}
