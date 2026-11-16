// The `godot-csharp` template: a new Godot 4 .NET project, or `--into` an existing Godot C# project. Plans first (no writes, no
// download), then applies. The OneLobby libraries come from NuGet (packages.js); only the menu folder is copied into the game
// (vendor.js), because Godot can only attach a C# script that is a source file of the game's own project.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./flags.js";
import { SCHEMA_URL } from "./blueprint.js";
import { ONELOBBY_PACKAGES, addReferences, inspectCsproj, newCsproj } from "./csproj.js";
import { olcEntry } from "./godot.js";
import { NUGET_CONFIG_MARK, hasMark, nugetConfig, sourcePath, targetVersion } from "./packages.js";
import {
  CSHARP_GITATTRIBUTES_LINES,
  CSHARP_GITIGNORE_LINES,
  MENU_DIR,
  NATIVES_DIR,
  NATIVES_MARKER,
  WEBRTC_NATIVE_VERSION,
  WEBRTC_NATIVE_ZIP_SHA256,
  applyBlock,
  buildPin,
  loadNatives,
  menuSource,
} from "./vendor.js";
import { resolveGodot } from "./verify/godot.js";

const templates = join(dirname(fileURLToPath(import.meta.url)), "../templates/godot-csharp");
const read = (...p) => readFileSync(join(templates, ...p), "utf8").replace(/\r\n/g, "\n"); // LF whatever the checkout did

export const CSHARP_RECIPE_URL = "https://github.com/ParkerTonra/onelobby/blob/main/docs/recipes/godot-csharp.md";
/** The Godot.NET.Sdk version a new project gets when no .NET Godot is found: what the OneLobby packages were built and tested against. */
export const DEFAULT_SDK = "4.5.1";
export const MENU_PIN_PATH = `${MENU_DIR}/PIN.json`;
/** The build command for a project file: the .csproj is named because Godot also writes a .sln beside it, and a bare `dotnet build` refuses to pick one. */
export const buildCommand = (csproj) => `dotnet build ${csproj}`;
export const IMPORT_COMMAND = "godot --headless --import --path .";
export const TEST_COMMAND = "godot --headless --audio-driver Dummy --path . res://tests/MultiplayerTest.tscn";

const slugOf = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "game";
const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
const json = (o) => JSON.stringify(o, null, 2) + "\n";
const quoteGd = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const bytes = (c) => (Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8"));

/** `my-game` -> `MyGame`: a C# identifier for the assembly and the namespace. */
export function identifierOf(s) {
  const id = s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  return id === "" ? "Game" : /^\d/.test(id) ? `Game${id}` : id;
}

function targetState(target) {
  if (!existsSync(target)) return "missing";
  return statSync(target).isDirectory() ? (readdirSync(target).length ? "full" : "empty") : "file";
}

/**
 * The Godot.NET.Sdk version for a new project: the version of the .NET Godot that --godot, $GODOT or PATH names (a stable build,
 * 4.5 or newer), else DEFAULT_SDK. `run(exe)` returns the output of `exe --version` (a test seam).
 * Why: the editor refuses a game whose GodotSharp is not its own major.minor, so the SDK follows the Godot the person has; with none
 * found, the version the packages were tested against is the safe pick.
 */
export function chooseSdk({ opts, env, run = defaultVersion }) {
  const found = resolveGodot({ flag: opts.godot, env: env ?? {} });
  if (!found) return { version: DEFAULT_SDK, from: "default", why: "no Godot found" };
  const out = run(found.exe);
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?\.stable\.mono\b/m.exec(out ?? "");
  if (!m) return { version: DEFAULT_SDK, from: "default", why: `${found.from} is not a stable .NET build of Godot` };
  if (Number(m[1]) < 4 || (Number(m[1]) === 4 && Number(m[2]) < 5)) return { version: DEFAULT_SDK, from: "default", why: `Godot ${m[1]}.${m[2]} is older than 4.5` };
  return { version: `${m[1]}.${m[2]}.${m[3] ?? "0"}`, from: found.from, exe: found.exe };
}
const defaultVersion = (exe) => {
  const r = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 30000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout : "";
};

/** Which .csproj an existing project builds: the only one, else the one project.godot names. Throws bad_csproj. */
export function selectCsproj(dir, projectGodotText = "") {
  const names = readdirSync(dir);
  const csprojs = names.filter((n) => /\.csproj$/i.test(n)).sort();
  if (csprojs.length === 1) return csprojs[0];
  if (csprojs.length === 0)
    throw new CliError(
      "bad_csproj",
      `${dir} has ${names.some((n) => /\.sln$/i.test(n)) ? "a .sln" : "no .csproj"} but no .csproj next to project.godot (the OneLobby packages are added to that file). In Godot: Project > Tools > C# > Create C# solution, then run this again.`,
    );
  const asm = /^project\/assembly_name\s*=\s*"([^"]+)"/m.exec(projectGodotText)?.[1] ?? /^config\/name\s*=\s*"([^"]+)"/m.exec(projectGodotText)?.[1];
  const wanted = asm ? csprojs.find((n) => n.toLowerCase() === `${asm}.csproj`.toLowerCase() || n.toLowerCase() === `${asm.replace(/[^A-Za-z0-9_.-]/g, "_")}.csproj`.toLowerCase()) : undefined;
  if (wanted) return wanted;
  throw new CliError("bad_csproj", `${dir} has several .csproj files (${csprojs.join(", ")}) and project.godot does not say which one is the game's (dotnet/project/assembly_name); nothing was changed`);
}

/** Central package management would reject a Version attribute: refuse before editing. */
function checkNoCentralPackages(dir, file) {
  for (let d = dir, prev = null; d !== prev; prev = d, d = dirname(d)) {
    const p = join(d, "Directory.Packages.props");
    if (existsSync(p) && /ManagePackageVersionsCentrally\s*>\s*true/i.test(readFileSync(p, "utf8")))
      throw new CliError("bad_csproj", `${file} is built with central package management (${p}); add the OneLobby packages there by hand (docs/recipes/godot-csharp.md, section 1); nothing was changed`);
  }
}

/**
 * Work out everything a run would do, writing nothing. Returns
 * { files: [{ path, content, action }], natives, notes, csproj, packages, menu, sdk, slug } where action is
 * create | update | overwrite | unchanged | skip. Throws before anything is written when the plan cannot work.
 */
export function planCSharp({ into, target, dirName, blueprint, opts, cwd, sdk }) {
  const menu = menuSource({ addonFrom: opts.addonFrom, cwd });
  const feed = targetVersion(opts, cwd);
  const title = blueprint.game.title ?? dirName;
  const slug = slugOf(dirName);
  const abs = (p) => join(target, ...p.split("/"));
  const notes = [];

  let assembly = identifierOf(dirName);
  let ns = assembly;
  let csprojName = `${assembly}.csproj`;
  let csprojPlan = null;
  const refs = ONELOBBY_PACKAGES.map((id) => ({ id, version: feed.version }));
  if (into) {
    const gd = readFileSync(abs("project.godot"), "utf8");
    csprojName = selectCsproj(target, gd);
    const text = readFileSync(abs(csprojName), "utf8");
    checkNoCentralPackages(target, csprojName);
    const info = inspectCsproj(text, csprojName);
    const prop = (n) => {
      const el = info.nodes.find((x) => x.name === n && !x.selfClose);
      return el ? info.masked.slice(el.openEnd, el.closeStart).trim() : null;
    };
    assembly = prop("AssemblyName") ?? csprojName.replace(/\.csproj$/i, "");
    ns = identifierOf(prop("RootNamespace") ?? assembly);
    const r = addReferences(text, refs, csprojName);
    for (const p of r.present) if (p.version !== feed.version) notes.push(`${csprojName} already has ${p.id} ${p.version ?? "(no version)"}; this version is ${feed.version}. Run: npx create-onelobby update`);
    csprojPlan = { file: csprojName, content: Buffer.from(r.text, "utf8"), action: r.changed ? "update" : "unchanged", added: r.added, present: r.present };
  }

  const vars = {
    title: quoteGd(title),
    mdTitle: title,
    recipeUrl: CSHARP_RECIPE_URL,
    webrtcVersion: WEBRTC_NATIVE_VERSION,
    schemaUrl: SCHEMA_URL,
    assembly,
    ns,
    audio: blueprint.chat?.voice ? "\n[audio]\n\ndriver/enable_input=true\n" : "",
    packagesVersion: feed.version,
    csproj: csprojName,
    feedNote: feed.from === "feed" ? `, from the local folder named in nuget.config` : "",
  };

  const wanted = [{ path: "onelobby.json", content: json(blueprint) }];
  if (!into) {
    wanted.push(
      { path: "project.godot", content: fill(read("_project.godot"), vars) },
      { path: csprojName, content: newCsproj({ sdkVersion: sdk.version, assembly, rootNamespace: ns, refs }) },
      { path: "Main.tscn", content: read("Main.tscn") },
      { path: "Main.cs", content: fill(read("Main.cs"), vars) },
      { path: "AGENTS.md", content: fill(read("AGENTS.md"), { ...vars, title: title.replace(/[\r\n]+/g, " ") }) },
    );
  }
  wanted.push(
    { path: "OneLobbyNet.cs", content: fill(read("OneLobbyNet.cs"), vars) },
    { path: "tests/MultiplayerTest.cs", content: fill(read("tests/MultiplayerTest.cs"), vars) },
    { path: "tests/MultiplayerTest.tscn", content: read("tests/MultiplayerTest.tscn") },
  );
  for (const f of menu.files) wanted.push({ path: `${MENU_DIR}/${f.path}`, content: f.content });
  wanted.push({ path: MENU_PIN_PATH, content: buildPin({ files: menu.files, commit: menu.commit }) });
  wanted.push({ path: `.olc/${slug}.json`, content: olcEntry({ slug, title, build: `${buildCommand(csprojName)} -nologo -v q` }) });

  const files = [];
  const plan = (path, content, exists, same) => {
    let action = "create";
    if (exists) action = same ? "unchanged" : opts.force ? "overwrite" : "skip";
    files.push({ path, content, action });
  };
  for (const f of wanted) {
    const content = bytes(f.content);
    const p = abs(f.path);
    if (existsSync(p) && statSync(p).isDirectory()) throw new CliError("exists", `${f.path} is a folder, expected a file`);
    plan(f.path, content, existsSync(p), existsSync(p) && readFileSync(p).equals(content));
  }
  if (csprojPlan) files.push({ path: csprojPlan.file, content: csprojPlan.content, action: csprojPlan.action });

  // nuget.config: only for a local feed; one this tool wrote is replaced, one that is the game's own is left alone
  if (feed.from === "feed") {
    const content = Buffer.from(nugetConfig(sourcePath(target, feed.dir)), "utf8");
    const p = abs("nuget.config");
    const there = existsSync(p);
    const before = there ? readFileSync(p, "utf8") : "";
    if (!there) files.push({ path: "nuget.config", content, action: "create" });
    else if (before.replace(/\r\n/g, "\n") === content.toString("utf8")) files.push({ path: "nuget.config", content, action: "unchanged" });
    else if (hasMark(before) || opts.force) files.push({ path: "nuget.config", content, action: hasMark(before) ? "update" : "overwrite" });
    else {
      files.push({ path: "nuget.config", content, action: "skip" });
      notes.push(`nuget.config already exists and was not written by create-onelobby, so it was left alone; add the folder ${feed.dir.replace(/\\/g, "/")} as a package source for OneLobby.* yourself, or rerun with --force`);
    }
  }

  // .gitignore and .gitattributes: a managed block, replaced in place or appended once
  for (const [path, lines, head] of [
    [".gitignore", CSHARP_GITIGNORE_LINES, undefined],
    [".gitattributes", CSHARP_GITATTRIBUTES_LINES, into ? undefined : "* text=auto\n"],
  ]) {
    const p = abs(path);
    const there = existsSync(p);
    const before = there ? readFileSync(p, "utf8") : head;
    const after = applyBlock(before, lines);
    files.push({ path, content: Buffer.from(after, "utf8"), action: there ? (after === before ? "unchanged" : "update") : "create" });
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

  return {
    files,
    natives,
    notes,
    csproj: csprojPlan ? { file: csprojPlan.file, added: csprojPlan.added, present: csprojPlan.present } : { file: csprojName, added: refs.map((r) => r.id), present: [] },
    packages: { version: feed.version, from: feed.from, ...(feed.dir ? { folder: feed.dir.replace(/\\/g, "/") } : {}) },
    menu: { commit: menu.commit, from: menu.from },
    sdk,
    slug,
    assembly,
  };
}

/** Write a plan: the files that are create / update / overwrite, then the natives. */
export async function applyCSharp(plan, { target, opts, cwd, fetchImpl }) {
  let nativeFiles = [];
  if (plan.natives.status === "install") nativeFiles = await loadNatives({ webrtcZip: opts.webrtcZip, webrtcDir: opts.webrtcDir, cwd, fetchImpl }); // first: a failed download leaves the folder as it was
  const put = (path, content) => {
    const p = join(target, ...path.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  for (const f of plan.files) if (f.action === "create" || f.action === "update" || f.action === "overwrite") put(f.path, f.content);
  for (const f of nativeFiles) put(f.path, f.content);
}

/** The `next` lines for the printed result. */
export function csharpNext({ into, rel, plan }) {
  const next = [];
  if (rel !== ".") next.push(`cd ${rel}`);
  if (plan.natives.status === "skipped") next.push("fetch the WebRTC natives (not installed yet): npx create-onelobby update   (changes nothing else)");
  next.push(`${buildCommand(plan.csproj.file)}   # restores the OneLobby packages and builds the game`);
  next.push(`${IMPORT_COMMAND}   # once${plan.natives.status === "skipped" ? " (and again after the natives are in)" : ""}: registers the WebRTC extension`);
  next.push(`${TEST_COMMAND}   # expect MULTIPLAYER_OK`);
  if (into) {
    next.push(
      "add the menu to your main scene: Scene > Instantiate Child Scene > res://addons/onelobby_menu/OneLobbyMenu.tscn, and turn its Boot Flags off in the inspector (the wiring below applies them)",
      "in that scene's script, after the menu's _Ready (the parent's _Ready is): OneLobbyNet.Wire(menu, OS.GetCmdlineUserArgs());  menu.Model!.ApplyBootFlags(OS.GetCmdlineUserArgs());",
      "connect it: menu.GameStarted += lobby => ...;  menu.ReturnedToLobby += lobby => ...;  menu.Left += () => ...;",
      "try it: godot --path . -- --host --name=Sam   (a second window: -- --join=<code> --name=Ann)",
      `follow ${CSHARP_RECIPE_URL}`,
    );
  } else {
    next.push("godot --path . -- --host --local --name=Sam   # play: see AGENTS.md (or run the .olc entry)", `recipe: ${CSHARP_RECIPE_URL}`);
  }
  return next;
}

/** The whole godot-csharp run after the answers are known. Returns the exit code. `ctx`: { io, opts, blueprint, target, dirName, into, gitInit, recommendation }. */
export async function runCSharp(ctx) {
  const { io, opts, blueprint, target, dirName, into } = ctx;
  if (into) {
    if (!existsSync(join(target, "project.godot"))) throw new CliError("not_godot_project", `--into: ${target} has no project.godot; run this inside a Godot 4 project folder, or drop --into to make a new one`);
    if (!readdirSync(target).some((n) => /\.(csproj|sln)$/i.test(n)))
      throw new CliError("not_csharp_project", `--into: ${target} is a Godot project without C# (no .csproj or .sln next to project.godot). In Godot: Project > Tools > C# > Create C# solution, then run this again; or use --template godot-gdscript for a GDScript game.`);
  } else {
    const state = targetState(target);
    if (state === "file") throw new CliError("exists", `${target} is a file`);
    if (state === "full" && !opts.force) throw new CliError("dir_not_empty", `${target} is not empty (use --force to write into it anyway)`);
  }
  const sdk = into ? { version: "from the project's own .csproj", from: "project" } : chooseSdk({ opts, env: io.env, run: io.godotVersion });
  const plan = planCSharp({ into, target, dirName, blueprint, opts, cwd: io.cwd, sdk });
  const rel = relative(io.cwd, target) || ".";
  const listed = plan.files.filter((f) => f.action === "create" || f.action === "update" || f.action === "overwrite");
  const skipped = plan.files.filter((f) => f.action === "skip").map((f) => f.path);
  const unchanged = plan.files.filter((f) => f.action === "unchanged").map((f) => f.path);
  const natives = plan.natives;
  const wouldChange = listed.length > 0 || natives.status === "install";
  const next = csharpNext({ into, rel, plan });
  const result = {
    ok: true,
    dir: target,
    template: "godot-csharp",
    blueprint,
    files: listed.map((f) => f.path),
    skipped,
    unchanged: unchanged.length,
    natives: { status: natives.status, version: natives.version, zipSha256: natives.zipSha256, folder: natives.folder, ...(natives.source ? { source: natives.source } : {}), ...(natives.reason ? { reason: natives.reason } : {}) },
    menu: plan.menu,
    packages: plan.packages,
    csproj: plan.csproj,
    ...(into ? {} : { sdk: { version: plan.sdk.version, from: plan.sdk.from } }),
    notes: plan.notes,
    changed: wouldChange,
    next,
  };
  if (ctx.recommendation) result.recommendation = ctx.recommendation.json;
  const fromRec = ctx.recommendation ? `\n\n${ctx.recommendation.text}` : "";
  const text = (verb) => {
    const out = [];
    if (!wouldChange) out.push(`Nothing changed: ${target} already has everything (${unchanged.length} files unchanged).`);
    else out.push(`${verb} ${target}`, ...listed.map((f) => `  ${f.path}${f.action === "create" ? "" : ` (${f.action})`}`));
    if (plan.csproj.added.length) out.push(`  ${plan.csproj.file}: package references ${into ? "added" : "written"}: ${plan.csproj.added.map((id) => `${id} ${plan.packages.version}`).join(", ")}`);
    if (natives.status === "install") out.push(`  ${natives.folder} (webrtc-native ${natives.version}, from ${natives.source === "download" ? "a checked download" : natives.source === "zip" ? "--webrtc-zip" : "--webrtc-dir"})`);
    if (natives.status === "skipped") out.push("WebRTC natives not installed (--no-natives).");
    if (natives.status === "present") out.push(`${natives.folder} is already there; natives left as they are.`);
    if (skipped.length) out.push("Skipped (already exist and differ; use --force to overwrite):", ...skipped.map((p) => `  ${p}`));
    if (!into) out.push(`Godot.NET.Sdk ${plan.sdk.version} (${plan.sdk.from === "default" ? `the default: ${plan.sdk.why}` : `from the Godot at ${plan.sdk.from}`}); packages ${plan.packages.version} (${plan.packages.from === "feed" ? `local folder ${plan.packages.folder}` : "the public registry"}).`);
    for (const n of plan.notes) out.push(`Note: ${n}`);
    return out.join("\n");
  };

  if (opts.dryRun) {
    result.dryRun = true;
    if (opts.json) io.stdout.write(JSON.stringify(result) + "\n");
    else io.stdout.write(`Dry run: nothing written, nothing downloaded.\n${text(into ? "Would add to" : "Would create")}\n\nonelobby.json:\n${JSON.stringify(blueprint, null, 2)}${fromRec}\n\nNext:\n${next.map((n) => `  ${n}`).join("\n")}\n`);
    return 0;
  }

  await applyCSharp(plan, { target, opts, cwd: io.cwd, fetchImpl: io.fetch });
  if (!into && !opts.noGit && ctx.gitInit) ctx.gitInit(target);
  if (opts.json) io.stdout.write(JSON.stringify(result) + "\n");
  else io.stdout.write(`${text(into ? "Added to" : "Created")}${fromRec}\n\nNext:\n${next.map((n) => `  ${n}`).join("\n")}\n`);
  return 0;
}

export { NUGET_CONFIG_MARK };
