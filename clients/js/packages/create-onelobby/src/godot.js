// The `godot-gdscript` template: a new Godot 4 project, or `--into` an existing GDScript project. Plans first (no writes, no
// download), then applies. The engine-neutral parts (vendoring, pin, blocks, zip) live in vendor.js.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./flags.js";
import { SCHEMA_URL } from "./blueprint.js";
import { addAutoload } from "./godot-project.js";
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
export function olcEntry({ slug, title }) {
  const joiner = `--join=127.0.0.1:${DEFAULT_DIRECT_PORT} --local --name=Joiner`;
  const ps = `$g = if ($env:GODOT) { $env:GODOT } else { 'godot' }; Start-Process -FilePath $g -ArgumentList '--path','.','--','--host','--local','--name=Host'; Start-Sleep -Seconds 4; & $g --path . --resolution 640x360 -- ${joiner}`;
  const sh = `G="\${GODOT:-godot}"; "$G" --path . -- --host --local --name=Host & sleep 4; "$G" --path . --resolution 640x360 -- ${joiner}`;
  const entry = (suffix, shell, command) => ({ name: `${slug}-play${suffix}`, label: `${title} - host + joiner${suffix ? ` (${shell})` : ""}`, kind: "task", group: slug, cwd: ".", command, shell, play: true });
  return json({ entries: [entry("", "powershell", ps), entry("-bash", "bash", sh)] });
}

/** Does the folder hold a Godot C# project (a .csproj or .sln next to project.godot)? */
export const isCSharpProject = (dir) => readdirSync(dir).some((n) => /\.(csproj|sln)$/i.test(n));

function targetState(target) {
  if (!existsSync(target)) return "missing";
  return statSync(target).isDirectory() ? (readdirSync(target).length ? "full" : "empty") : "file";
}

/**
 * Work out everything a run would do, writing nothing. Returns
 * { files: [{ path, content, action }], natives: { status, ... }, notes, projectGodot? } where action is
 * create | update | overwrite | unchanged | skip. Throws before anything is written when the plan cannot work.
 */
export function planGodot({ into, target, dirName, blueprint, opts, cwd }) {
  const addon = addonSource({ addonFrom: opts.addonFrom, cwd });
  const title = blueprint.game.title ?? dirName;
  const slug = slugOf(dirName);
  const vars = { title: quoteGd(title), mdTitle: title, recipeUrl: GODOT_RECIPE_URL, webrtcVersion: WEBRTC_NATIVE_VERSION, schemaUrl: SCHEMA_URL };

  const wanted = [{ path: "onelobby.json", content: json(blueprint) }];
  if (!into) {
    wanted.push(
      { path: "project.godot", content: fill(read("_project.godot"), vars) },
      { path: "main.tscn", content: read("main.tscn") },
      { path: "main.gd", content: read("main.gd") },
      { path: "AGENTS.md", content: fill(read("AGENTS.md"), { ...vars, title: title.replace(/[\r\n]+/g, " ") }) },
    );
  }
  wanted.push({ path: "net.gd", content: fill(read("net.gd"), vars) }, { path: "tests/multiplayer.gd", content: read("tests/multiplayer.gd") });
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
  return { files, natives, notes, addon: { commit: addon.commit, from: addon.from }, slug };
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

/** The `next` lines for the printed result. */
export function godotNext({ into, rel, plan }) {
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
      "try it: godot --path . -- --host --name=Sam   (a second window: -- --join=<code> --name=Ann)",
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
    if (isCSharpProject(target))
      throw new CliError("template_planned", `${target} is a Godot C# project (a .csproj or .sln sits next to project.godot): the godot-csharp template is planned for v2. Follow docs/recipes/godot-csharp.md for now.`);
  } else {
    const state = targetState(target);
    if (state === "file") throw new CliError("exists", `${target} is a file`);
    if (state === "full" && !opts.force) throw new CliError("dir_not_empty", `${target} is not empty (use --force to write into it anyway)`);
  }
  const plan = planGodot({ into, target, dirName, blueprint, opts, cwd: io.cwd });
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
    notes: plan.notes,
    changed: wouldChange,
    next,
  };
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
    else io.stdout.write(`Dry run: nothing written, nothing downloaded.\n${text(into ? "Would add to" : "Would create")}\n\nonelobby.json:\n${JSON.stringify(blueprint, null, 2)}\n\nNext:\n${next.map((n) => `  ${n}`).join("\n")}\n`);
    return 0;
  }

  await applyGodot(plan, { target, opts, cwd: io.cwd, fetchImpl: io.fetch });
  if (!into && !opts.noGit && ctx.gitInit) ctx.gitInit(target);
  if (opts.json) io.stdout.write(JSON.stringify(result) + "\n");
  else io.stdout.write(`${text(into ? "Added to" : "Created")}\n\nNext:\n${next.map((n) => `  ${n}`).join("\n")}\n`);
  return 0;
}
