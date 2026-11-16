// create-onelobby: scaffold a OneLobby game (docs/design/blueprint.md s.6).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, USAGE, getPath, parseArgs, setPath } from "./flags.js";
import {
  IMPLEMENTED_TEMPLATES,
  ONELOBBY_VERSION,
  TEMPLATES,
  buildBlueprint,
  deriveGameId,
  templateDefaults,
  withDefaults,
} from "./blueprint.js";
import { RECIPE_URL, intoFiles, webProjectFiles } from "./files.js";
import { isCSharpProject } from "./godot-project.js";
import { runGodot } from "./godot.js";
import { detectEngine, recommend, renderApplied, renderText } from "./recommend.js";
import { askOne, createPrompter, questions } from "./prompt.js";
import { runUpdate } from "./update.js";
import { runVerify } from "./verify/index.js";

const here = dirname(fileURLToPath(import.meta.url));
/** The hand recipe for each template that is not built yet. */
const PLANNED_RECIPES = { "godot-csharp": "godot-csharp.md", unity: "unity.md", dotnet: "dotnet-generic.md", "node-browser": "js-web.md" };

function defaultIo() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    stdinIsTTY: !!process.stdin.isTTY,
    env: process.env,
    cwd: process.cwd(),
  };
}

const isCi = (env) => env.CI === "true" || env.CI === "1";

/** Entry point: returns the exit code. Never throws. */
export async function main(argv, io = defaultIo()) {
  const wantJson = argv.some((a) => a === "--json" || a === "--json=true");
  try {
    return await run(argv, io);
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError("internal", e?.message ?? String(e));
    if (wantJson) io.stdout.write(JSON.stringify({ ok: false, error: { code: err.code, message: err.message, ...(err.path !== undefined ? { path: err.path } : {}), ...(err.details !== undefined ? { details: err.details } : {}) } }) + "\n");
    else io.stderr.write(`create-onelobby: ${err.message}${err.path ? ` (at ${err.path})` : ""}\n`);
    return 1;
  }
}

function readFromFile(file, cwd) {
  let text;
  try {
    text = readFileSync(resolve(cwd, file), "utf8");
  } catch (e) {
    throw new CliError("bad_from", `--from: cannot read ${file} (${e.code ?? e.message})`);
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch (e) {
    throw new CliError("bad_from", `--from: ${file} is not valid JSON (${e.message})`);
  }
}

function targetState(target) {
  if (!existsSync(target)) return "missing";
  return statSync(target).isDirectory() ? (readdirSync(target).length ? "full" : "empty") : "file";
}

function run_(cmd, args, cwd, io) {
  // The child's stdout goes to our stderr, so --json output stays one object. On Windows npm is a .cmd file: go through cmd.exe.
  const [file, fileArgs] = process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", [cmd, ...args].join(" ")]] : [cmd, args];
  return spawnSync(file, fileArgs, { cwd, stdio: ["ignore", 2, 2] }).status === 0;
}

/** Every dotted key a --from file sets (the leaves of its sections). */
function flatKeys(obj, prefix = "") {
  return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? flatKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
}

/** The default a prompt shows when the recommendation has a value for its key. */
function recommendedDefault(q, rows) {
  if (q.type === "hosting") {
    const d = rows.get("hosting.direct")?.[1];
    const s = rows.get("hosting.server")?.[1];
    return d === undefined || s === undefined ? undefined : d && s ? "both" : d ? "direct" : "server";
  }
  return rows.get(q.key)?.[1];
}

/** `create-onelobby --recommend "<text>"` with no folder: print the proposal, write nothing. */
function recommendAlone({ opts, io }) {
  let engine;
  if (opts.template !== undefined) {
    if (!TEMPLATES.includes(opts.template)) throw new CliError("bad_flag", `--template: unknown template "${opts.template}". Choose one of: ${TEMPLATES.join(", ")}.`);
    engine = { id: opts.template, from: "template" };
  }
  const rec = recommend({ description: opts.recommend, engine });
  if (opts.json) io.stdout.write(JSON.stringify(rec) + "\n");
  else io.stdout.write(renderText(rec));
  return 0;
}

/** Commands that act on an existing game, named first: `create-onelobby update`, `create-onelobby verify`. (A folder called "update" needs ./update.) */
const COMMANDS = { update: runUpdate, verify: runVerify };

export async function run(argv, io) {
  const command = Object.hasOwn(COMMANDS, argv[0]) ? argv[0] : undefined;
  const { dir, opts, given } = parseArgs(command ? argv.slice(1) : argv);
  if (opts.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  if (opts.version) {
    io.stdout.write(JSON.parse(readFileSync(join(here, "../package.json"), "utf8")).version + "\n");
    return 0;
  }

  if (command && opts.recommend !== undefined) throw new CliError("bad_flag", "--recommend belongs to create-onelobby itself (alone, or with a folder or --into), not to update or verify");
  if (command) return await COMMANDS[command]({ dir, opts, io });
  if (opts.recommend !== undefined && dir === undefined && opts.into === undefined) return recommendAlone({ opts, io });

  const fromFile = opts.from ? readFromFile(opts.from, io.cwd) : undefined;
  // --into a folder with a project.godot and no --template: a Godot project (C# when a .csproj / .sln sits beside it)
  const intoDir = opts.into !== undefined ? resolve(io.cwd, opts.into) : undefined;
  const godotInto = intoDir !== undefined && existsSync(join(intoDir, "project.godot"));
  let template = opts.template ?? fromFile?.engine ?? (godotInto ? (isCSharpProject(readdirSync(intoDir)) ? "godot-csharp" : "godot-gdscript") : undefined);
  let engineFrom = template === undefined ? undefined : "template";
  const checkTemplate = () => {
    if (!TEMPLATES.includes(template)) throw new CliError("bad_flag", `--template: unknown template "${template}". Choose one of: ${TEMPLATES.join(", ")}.`);
    if (!IMPLEMENTED_TEMPLATES.includes(template))
      throw new CliError(
        "template_planned",
        `template "${template}" is planned for v2; this release builds ${IMPLEMENTED_TEMPLATES.map((t) => `"${t}"`).join(" and ")}. Use the onelobby agent skill or the recipe docs/recipes/${PLANNED_RECIPES[template]} for now.`,
      );
  };
  if (template !== undefined) checkTemplate();
  if (opts.recommend !== undefined) recommend({ description: opts.recommend }); // an empty description is bad_flag before anything is asked

  const interactive = io.stdinIsTTY && !opts.yes && !opts.noInput && !isCi(io.env);
  const prompter = interactive ? createPrompter(io.stdin, opts.json ? io.stderr : io.stdout) : null;
  try {
    // ---- the game in one line (--recommend, or one first question on a terminal) ----
    let description = opts.recommend;
    if (description === undefined && interactive) description = await prompter.ask("Describe your game in one line (Enter to skip)");
    if (template === undefined) {
      const named = description ? detectEngine(description) : null;
      template = named?.id ?? "web";
      engineFrom = named ? "text" : "default";
      checkTemplate();
    }
    const rec = description ? recommend({ description, engine: engineFrom === "text" ? undefined : { id: template, from: engineFrom } }) : null;
    const recRows = new Map(rec ? rec.answers.map((r) => [r[0], r]) : []);

    // ---- where ----
    let target;
    if (opts.into !== undefined) {
      target = resolve(io.cwd, opts.into);
      if (dir !== undefined) throw new CliError("bad_flag", "give a directory or --into <dir>, not both");
      if (!existsSync(target) || !statSync(target).isDirectory()) throw new CliError("no_such_dir", `--into: ${target} is not an existing folder`);
    } else {
      let name = dir;
      if (name === undefined) {
        if (interactive) name = (await prompter.ask("Project name", "my-onelobby-game")) ?? "my-onelobby-game";
        else if (opts.yes) name = "my-onelobby-game";
        else throw new CliError("missing_answer", "no project folder given: pass a directory (create-onelobby my-game) or use --yes", "dir");
      }
      target = resolve(io.cwd, name);
    }
    const dirName = basename(target);

    // ---- answers: --from file, then flags, then (interactive) questions, then defaults ----
    let answers = fromFile ? JSON.parse(JSON.stringify(fromFile)) : {};
    answers.engine = template;
    for (const [key, value] of given) setPath(answers, key, value);

    const fromKeys = new Set(fromFile ? flatKeys(fromFile) : []);
    const flagKeys = new Set(given.map(([k]) => k));
    if (interactive) {
      for (const q of questions(template)) {
        if (q.when && !q.when(answers)) continue;
        const already = q.type === "hosting" ? getPath(answers, "hosting.direct") !== undefined || getPath(answers, "hosting.server") !== undefined : getPath(answers, q.key) !== undefined;
        if (already) continue;
        const def = q.key === "game.id" ? deriveGameId(dirName) : q.key === "game.title" ? dirName : (recommendedDefault(q, recRows) ?? q.def);
        const v = await askOne(prompter, { ...q, def }, opts.json ? io.stderr : io.stdout);
        const value = v === undefined ? (q.key === "game.id" || q.key === "game.title" ? def : undefined) : v;
        if (value === undefined) continue;
        if (q.type === "hosting") {
          setPath(answers, "hosting.direct", value !== "server");
          setPath(answers, "hosting.server", value !== "direct");
        } else setPath(answers, q.key, value);
      }
    }

    // the recommendation fills what no flag, --set, --from or answer gave; the built-in defaults come after it
    // when the sync mode it proposed was replaced, the other sync.* values it proposed were chosen for that mode: they are left out
    const applied = [];
    const overridden = [];
    const dropped = [];
    const modeRow = recRows.get("sync.mode");
    const haveMode = getPath(answers, "sync.mode");
    const modeReplaced = modeRow !== undefined && haveMode !== undefined && haveMode !== modeRow[1];
    for (const row of recRows.values()) {
      const [key, value] = row;
      const have = getPath(answers, key);
      if (have === undefined) {
        if (modeReplaced && key.startsWith("sync.")) {
          dropped.push({ key, recommended: value, why: `it was proposed for sync.mode ${modeRow[1]}, and sync.mode is ${haveMode}` });
          continue;
        }
        setPath(answers, key, value);
        applied.push(row);
      } else if (JSON.stringify(have) !== JSON.stringify(value)) overridden.push({ key, value: have, recommended: value, by: flagKeys.has(key) ? "a flag" : fromKeys.has(key) ? "--from" : "your answer" });
    }
    const recommendation = rec
      ? {
          json: { description: rec.description, shape: rec.shape, matched: rec.matched, engine: rec.engine, applied, overridden, dropped, limits: rec.limits, questions: rec.questions, notes: rec.notes },
          text: renderApplied(applied, overridden, rec.shape, dropped),
        }
      : undefined;

    if (getPath(answers, "game.id") === undefined) {
      if (opts.yes) setPath(answers, "game.id", deriveGameId(dirName));
      else throw new CliError("missing_answer", "the game id is required: pass --game-id com.you.game (or --yes to use com.example.<folder-name>)", "game.id");
    }
    answers = withDefaults(answers, templateDefaults(template, { title: dirName.slice(0, 64) }));

    const wantUi = template === "godot-gdscript" ? "drop-in" : "generated";
    if (getPath(answers, "ui.kind") !== wantUi)
      throw new CliError("unsupported", `template ${template} writes the ${wantUi} UI (ui.kind "${wantUi}"); ui.kind "${getPath(answers, "ui.kind")}" is not supported by the scaffolder yet`, "ui.kind");

    // the web sample game is lockstep or raw (host broadcasts its state); it has no ReplicationSession, so a replication blueprint would be a lie
    if (template === "web" && getPath(answers, "sync.mode") === "replication")
      throw new CliError("unsupported", 'template web writes the lockstep and raw sample game (sync.mode "lockstep" or "raw"); sync.mode "replication" needs a ReplicationSession the web template does not write yet (see docs/recipes/replication.md)', "sync.mode");

    // ---- validate with the real loader ----
    const blueprint = await buildBlueprint(answers);

    if (template === "godot-gdscript") {
      const gitInit = (dir) => {
        if (!run_("git", ["init", "-q"], dir, io)) io.stderr.write("create-onelobby: git init failed; continuing without a repository\n");
      };
      return await runGodot({ io, opts, blueprint, target, dirName, into: opts.into !== undefined, gitInit, recommendation });
    }

    // ---- plan ----
    const files = opts.into !== undefined ? intoFiles({ blueprint }) : webProjectFiles({ blueprint, dirName, onelobbyVersion: opts.onelobbyVersion });
    const into = opts.into !== undefined;
    if (!into) {
      const state = targetState(target);
      if (state === "file") throw new CliError("exists", `${target} is a file`);
      if (state === "full" && !opts.force) throw new CliError("dir_not_empty", `${target} is not empty (use --force to write into it anyway)`);
    } else {
      const clash = files.filter((f) => existsSync(join(target, f.path))).map((f) => f.path);
      if (clash.length && !opts.force) throw new CliError("exists", `would overwrite existing files: ${clash.join(", ")} (use --force to overwrite them)`);
    }

    const rel = relative(io.cwd, target) || ".";
    const willInstall = !into && !opts.noInstall && !opts.dryRun;
    const next = [];
    if (!into) {
      if (rel !== ".") next.push(`cd ${rel}`);
      if (!willInstall) next.push("npm install");
      next.push("npm start", "npm test");
      if (blueprint.hosting.server && !blueprint.hosting.lobbyServer) next.push("set hosting.lobbyServer in onelobby.json (or open the page with ?lobby=ws://HOST:8080/ws)");
    } else {
      next.push(
        `npm install onelobby@^${ONELOBBY_VERSION}`,
        'in your game: import { loadBlueprint, makeKit, bindSession } from "./multiplayer/session.js" (OneLobby.fromConfig + a lockstep/raw binding)',
        `follow ${RECIPE_URL}`,
        "node test/multiplayer.mjs",
      );
    }

    const result = { ok: true, dir: target, template, blueprint, files: files.map((f) => f.path), next };
    if (recommendation) result.recommendation = recommendation.json;
    const fromRec = recommendation ? `\n\n${recommendation.text}` : "";
    if (opts.dryRun) result.dryRun = true;

    if (opts.dryRun) {
      if (opts.json) io.stdout.write(JSON.stringify(result) + "\n");
      else {
        io.stdout.write(`Dry run: nothing written.\n${into ? "Would add to" : "Would create"} ${target}:\n${files.map((f) => `  ${f.path}`).join("\n")}\n\nonelobby.json:\n${JSON.stringify(blueprint, null, 2)}${fromRec}\n\nNext:\n${next.map((n) => `  ${n}`).join("\n")}\n`);
      }
      return 0;
    }

    // ---- write ----
    for (const f of files) {
      const p = join(target, ...f.path.split("/"));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.content);
    }
    if (!into) {
      if (!opts.noGit && !run_("git", ["init", "-q"], target, io)) io.stderr.write("create-onelobby: git init failed; continuing without a repository\n");
      if (willInstall && !run_("npm", ["install"], target, io)) {
        io.stderr.write("create-onelobby: npm install failed; run it yourself in the new folder\n");
        result.next.splice(result.next.indexOf("npm start"), 0, "npm install");
      }
    }
    if (opts.json) io.stdout.write(JSON.stringify(result) + "\n");
    else io.stdout.write(`${into ? "Added to" : "Created"} ${target}\n${files.map((f) => `  ${f.path}`).join("\n")}${fromRec}\n\nNext:\n${result.next.map((n) => `  ${n}`).join("\n")}\n`);
    return 0;
  } finally {
    prompter?.close();
  }
}
