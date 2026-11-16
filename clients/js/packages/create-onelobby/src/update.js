// `create-onelobby update`: bring a game's OneLobby add-on up to the one bundled in this create-onelobby (or --addon-from).
//   godot-gdscript: re-vendor addons/onelobby/ guarded by its PIN.json, refresh the managed .gitignore/.gitattributes blocks and,
//                   when the pinned natives version changed or the folder is gone, the WebRTC natives.
//   web:            the dependency is the `onelobby` npm package, so this only says which install line to run and whether the glue
//                   file differs from this version's; it never runs npm and never rewrites the glue (it is yours to edit).
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CliError } from "./flags.js";
import { ONELOBBY_VERSION } from "./blueprint.js";
import { glueSession } from "./files.js";
import { detectProject, notAProject, projectDir } from "./project.js";
import { buildCommand, selectCsproj } from "./csharp.js";
import { runUpdateUnity } from "./unity-update.js";
import { moveReferences } from "./csproj.js";
import { hasMark, nugetConfig, sourcePath, targetVersion } from "./packages.js";
import {
  CSHARP_GITATTRIBUTES_LINES,
  CSHARP_GITIGNORE_LINES,
  CSHARP_PLAYER_GITATTRIBUTES_LINES,
  NET_PLAYER_DIR,
  NET_PLAYER_TOLERATE,
  netPlayerSource,
  GITATTRIBUTES_LINES,
  GITIGNORE_LINES,
  MENU_DIR,
  menuSource,
  NATIVES_DIR,
  NATIVES_MARKER,
  PIN_PATH,
  WEBRTC_NATIVE_VERSION,
  WEBRTC_NATIVE_ZIP_SHA256,
  addonSource,
  applyBlock,
  buildPin,
  loadNatives,
  packageVersion,
  sha256,
  verifyPin,
} from "./vendor.js";

export const IMPORT_COMMAND = "godot --headless --import --path .";
const ADDON_DIR = "addons/onelobby";

/** What differs between the two vendored folders: where it lives, where it comes from, which blocks it brings. */
const GDSCRIPT = { template: "godot-gdscript", dir: ADDON_DIR, pinPath: PIN_PATH, ignore: GITIGNORE_LINES, attributes: GITATTRIBUTES_LINES, source: (o) => addonSource(o), what: "add-on" };
const CSHARP = { template: "godot-csharp", dir: MENU_DIR, pinPath: `${MENU_DIR}/PIN.json`, ignore: CSHARP_GITIGNORE_LINES, attributes: CSHARP_GITATTRIBUTES_LINES, source: (o) => menuSource(o), what: "menu", csharp: true };
/** The game's networked player folder (a godot-csharp game made with `sync.player`): a pin of its own, the same guard, no natives or blocks of its own (the menu's pass has them). */
const NET_PLAYER_PIN = `${NET_PLAYER_DIR}/PIN.json`;
const NET_PLAYER = { template: "godot-csharp", dir: NET_PLAYER_DIR, pinPath: NET_PLAYER_PIN, ignore: CSHARP_GITIGNORE_LINES, attributes: CSHARP_PLAYER_GITATTRIBUTES_LINES, source: (o) => netPlayerSource(o), what: "networked player add-on", tolerate: NET_PLAYER_TOLERATE, noNatives: true, noBlocks: true };
const short = (sha) => (typeof sha === "string" && sha.length >= 7 ? sha.slice(0, 7) : String(sha ?? "unknown"));

/** The managed blocks of .gitignore and .gitattributes, as { path, content, action }. */
export function blockPlan(target, flavor = GDSCRIPT) {
  return [
    [".gitignore", flavor.ignore],
    [".gitattributes", flavor.attributes],
  ].map(([path, lines]) => {
    const p = join(target, path);
    const before = existsSync(p) ? readFileSync(p, "utf8") : undefined;
    const after = applyBlock(before, lines);
    return { path, content: Buffer.from(after, "utf8"), action: before === undefined ? "create" : after === before ? "unchanged" : "update" };
  });
}

/** The C# game's own files: its OneLobby.* package versions, and nuget.config when --packages-from names a local folder. */
function csharpExtras({ target, opts, cwd }) {
  const wanted = targetVersion(opts, cwd);
  const gd = existsSync(join(target, "project.godot")) ? readFileSync(join(target, "project.godot"), "utf8") : "";
  const file = selectCsproj(target, gd);
  const text = readFileSync(join(target, file), "utf8");
  const moved = moveReferences(text, wanted.version, file);
  let nuget = { action: "none" };
  if (wanted.from === "feed") {
    const content = Buffer.from(nugetConfig(sourcePath(target, wanted.dir)), "utf8");
    const p = join(target, "nuget.config");
    const before = existsSync(p) ? readFileSync(p, "utf8") : undefined;
    if (before === undefined) nuget = { action: "create", content };
    else if (before.replace(/\r\n/g, "\n") === content.toString("utf8")) nuget = { action: "unchanged", content };
    else if (hasMark(before) || opts.force) nuget = { action: "update", content };
    else nuget = { action: "skip", content, note: "nuget.config exists and was not written by create-onelobby; left alone (add the folder as a source for OneLobby.* yourself, or rerun with --force)" };
  }
  return {
    csproj: { file, content: Buffer.from(moved.text, "utf8"), changed: moved.changed, moved: moved.moved, skipped: moved.skipped, refs: moved.refs },
    nuget,
    packages: { version: wanted.version, from: wanted.from, ...(wanted.dir ? { folder: wanted.dir.replace(/\\/g, "/") } : {}) },
    changed: moved.changed || nuget.action === "create" || nuget.action === "update",
  };
}

/** What an update would do, writing nothing. Throws no_pin / bad_pin / local_changes when it must not go on. */
export function planUpdate({ target, opts, cwd, flavor = GDSCRIPT }) {
  const { pinPath: PIN_PATH, dir: ADDON_DIR } = flavor;
  const rel = relative(cwd, target) || ".";
  let pinState;
  try {
    pinState = verifyPin(target, ADDON_DIR, { tolerate: flavor.tolerate });
  } catch (e) {
    if (e instanceof CliError) throw e; // a pin key that escapes the add-on folder
    throw new CliError("bad_pin", `${PIN_PATH} is not valid JSON (${e.message}); restore it from git, or adopt the add-on again with: npx create-onelobby --into ${rel} --force`);
  }
  if (pinState.error === "no_pin")
    throw new CliError(
      "no_pin",
      `${target} has no ${PIN_PATH}, so update cannot tell its add-on from files you edited. Adopt the project first with: npx create-onelobby --into ${rel}   (it writes the pin; add --force to also replace add-on files that differ)`,
    );
  const pin = pinState.pin;
  if (typeof pin?.files !== "object" || pin.files === null) throw new CliError("bad_pin", `${PIN_PATH} has no "files" list; adopt the add-on again with: npx create-onelobby --into ${rel} --force`);

  const source = flavor.source({ addonFrom: opts.addonFrom, cwd });
  const wanted = new Map(source.files.map((f) => [f.path, f]));

  const changed = [];
  const added = [];
  const removed = [];
  for (const f of source.files) {
    if (!(f.path in pin.files)) added.push(f.path);
    else if (pin.files[f.path] !== sha256(f.content)) changed.push(f.path);
  }
  for (const path of Object.keys(pin.files)) if (!wanted.has(path)) removed.push(path);

  // files the user touched: stop unless --force; with --force, say what gets overwritten and what stays
  const local = { edited: pinState.edited, missing: pinState.missing, added: pinState.added };
  const touched = local.edited.length + local.missing.length + local.added.length;
  if (touched && !opts.force) {
    const lines = [
      ...local.edited.map((p) => `  edited   ${ADDON_DIR}/${p}`),
      ...local.missing.map((p) => `  missing  ${ADDON_DIR}/${p}`),
      ...local.added.map((p) => `  added    ${ADDON_DIR}/${p}`),
    ];
    throw new CliError(
      "local_changes",
      `the add-on in ${target} no longer matches its ${PIN_PATH}; nothing was changed:\n${lines.join("\n")}\nKeep your edits (copy them out), then rerun with --force: it overwrites the edited files, restores the missing ones and keeps the added ones.`,
      undefined,
      local,
    );
  }
  // --force: an edited or missing file the new add-on leaves as it was still has to be reset to the pinned bytes
  for (const p of [...local.edited, ...local.missing]) if (wanted.has(p) && !changed.includes(p) && !added.includes(p)) changed.push(p);
  // a file the user added that the new add-on also ships is overwritten by it
  for (const p of local.added) if (wanted.has(p) && !added.includes(p) && !changed.includes(p) && !pin.files[p]) added.push(p);
  const overwritten = [...new Set([...local.edited, ...[...local.missing, ...local.added].filter((p) => wanted.has(p))])].sort();
  const kept = local.added.filter((p) => !wanted.has(p));
  changed.sort();
  added.sort();
  removed.sort();

  const files = [...changed.map((path) => ({ path, content: wanted.get(path).content, action: "change" })), ...added.map((path) => ({ path, content: wanted.get(path).content, action: "add" }))];
  const blocks = flavor.noBlocks ? [] : blockPlan(target, flavor);

  // natives: the pinned version moved, or the folder is gone
  const present = existsSync(join(target, NATIVES_MARKER));
  const oldNatives = pin.webrtcNative?.version;
  let natives;
  if (flavor.noNatives) natives = { status: "skipped", reason: "the menu's pass handles them" };
  else if (opts.noNatives) natives = { status: "skipped", reason: "--no-natives" };
  else if (present && oldNatives === WEBRTC_NATIVE_VERSION) natives = { status: "present" };
  else
    natives = {
      status: "install",
      source: opts.webrtcDir ? "dir" : opts.webrtcZip ? "zip" : "download",
      why: !present ? "the natives folder is missing" : `the pinned version moved from ${oldNatives ?? "unknown"} to ${WEBRTC_NATIVE_VERSION}`,
    };
  natives.version = WEBRTC_NATIVE_VERSION;
  natives.zipSha256 = WEBRTC_NATIVE_ZIP_SHA256;
  natives.folder = `${NATIVES_DIR}/`;

  const addonChanged = changed.length + added.length + removed.length > 0;
  const blocksChanged = blocks.some((b) => b.action !== "unchanged");
  const nativesInstall = natives.status === "install";
  // the pin is rewritten when the add-on files change or the natives version it records moves with an install
  const movesNatives = nativesInstall && oldNatives !== WEBRTC_NATIVE_VERSION;
  const pinText =
    addonChanged || movesNatives
      ? buildPin({
          files: source.files,
          commit: addonChanged ? source.commit : (pin.source?.commit ?? source.commit),
          webrtcNative: nativesInstall || oldNatives === undefined ? { version: WEBRTC_NATIVE_VERSION, zipSha256: WEBRTC_NATIVE_ZIP_SHA256 } : pin.webrtcNative,
        })
      : null;
  const extra = flavor.csharp ? csharpExtras({ target, opts, cwd }) : null;
  return {
    files,
    removed,
    kept,
    overwritten,
    local,
    blocks,
    natives,
    pinText,
    ...(extra ? { csproj: extra.csproj, nuget: extra.nuget, packages: extra.packages } : {}),
    current: !addonChanged && !blocksChanged && !nativesInstall && !(extra && extra.changed),
    addon: { from: source.from, commit: source.commit, previousCommit: pin.source?.commit ?? "unknown", createOnelobby: packageVersion(), previousCreateOnelobby: pin.createOnelobby ?? "unknown" },
  };
}

async function applyUpdate(plan, { target, opts, cwd, fetchImpl, flavor = GDSCRIPT }) {
  const { pinPath: PIN_PATH, dir: ADDON_DIR } = flavor;
  // natives first: a failed download leaves the folder as it was
  const nativeFiles = plan.natives.status === "install" ? await loadNatives({ webrtcZip: opts.webrtcZip, webrtcDir: opts.webrtcDir, cwd, fetchImpl }) : [];
  const put = (path, content) => {
    const p = join(target, ...path.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  const root = join(target, ...ADDON_DIR.split("/"));
  for (const f of plan.files) put(`${ADDON_DIR}/${f.path}`, f.content);
  for (const path of plan.removed) {
    const p = join(root, ...path.split("/"));
    rmSync(p, { force: true });
    // a sub-folder of the add-on that this emptied goes too (rmdir removes only empty folders)
    for (let d = dirname(p); d.length > root.length; d = dirname(d)) {
      try {
        rmdirSync(d);
      } catch {
        break;
      }
    }
  }
  if (plan.pinText) put(PIN_PATH, plan.pinText);
  for (const b of plan.blocks) if (b.action !== "unchanged") put(b.path, b.content);
  for (const f of nativeFiles) put(f.path, f.content);
  if (plan.csproj?.changed) put(plan.csproj.file, plan.csproj.content);
  if (plan.nuget?.action === "create" || plan.nuget?.action === "update") put("nuget.config", plan.nuget.content);
}

function godotResult({ target, plan, dryRun, flavor = GDSCRIPT }) {
  return {
    ok: true,
    command: "update",
    dir: target,
    template: flavor.template,
    current: plan.current,
    changed: !plan.current,
    addon: plan.addon,
    files: {
      changed: plan.files.filter((f) => f.action === "change").map((f) => f.path),
      added: plan.files.filter((f) => f.action === "add").map((f) => f.path),
      removed: plan.removed,
    },
    overwritten: plan.overwritten,
    kept: plan.kept,
    pin: plan.pinText ? "rewritten" : "unchanged",
    blocks: plan.blocks.filter((b) => b.action !== "unchanged").map((b) => b.path),
    natives: {
      status: plan.natives.status,
      version: plan.natives.version,
      zipSha256: plan.natives.zipSha256,
      folder: plan.natives.folder,
      ...(plan.natives.source ? { source: plan.natives.source } : {}),
      ...(plan.natives.why ? { why: plan.natives.why } : {}),
      ...(plan.natives.reason ? { reason: plan.natives.reason } : {}),
    },
    ...(dryRun ? { dryRun: true } : {}),
    ...(flavor.csharp
      ? {
          packages: plan.packages,
          csproj: { file: plan.csproj.file, moved: plan.csproj.moved, skipped: plan.csproj.skipped },
          nugetConfig: plan.nuget.action,
        }
      : {}),
    next: plan.current ? [] : flavor.csharp ? [`${buildCommand(plan.csproj.file)}   # restores the OneLobby packages at the new version and builds the game`, `${IMPORT_COMMAND}   # a new natives version needs the import`] : [`${IMPORT_COMMAND}   # new class_names (and a new natives version) need the import`],
  };
}

function godotText(r, plan, verb, flavor = GDSCRIPT) {
  const { pinPath: PIN_PATH, dir: ADDON_DIR } = flavor;
  if (r.current)
    return `Already current: ${r.dir} has this version's ${flavor.what} (${flavor.what} commit ${short(plan.addon.commit)})${flavor.csharp ? `, the OneLobby package references at ${plan.packages.version}` : ""} and the managed .gitignore/.gitattributes blocks; ${r.natives.status === "skipped" ? `the WebRTC natives were not checked (${r.natives.reason})` : `the WebRTC natives are at ${r.natives.version}`}. Nothing was written.`;
  const f = r.files;
  const out = [`${verb} ${r.dir}`];
  out.push(
    `  ${ADDON_DIR}/: ${f.changed.length} changed, ${f.added.length} added, ${f.removed.length} removed (${flavor.what} commit ${short(plan.addon.previousCommit)} -> ${short(plan.addon.commit)}, ${plan.addon.from === "package" ? `bundled in create-onelobby ${plan.addon.createOnelobby}` : "from --addon-from"})`,
  );
  for (const [label, list] of [["changed", f.changed], ["added", f.added], ["removed", f.removed]]) for (const p of list) out.push(`    ${label.padEnd(8)} ${p}`);
  if (r.overwritten.length) out.push(`  --force overwrote your edits to ${r.overwritten.length} file(s):`, ...r.overwritten.map((p) => `    ${p}`));
  if (r.kept.length) out.push(`  kept ${r.kept.length} file(s) you added (not in this add-on):`, ...r.kept.map((p) => `    ${p}`));
  if (r.pin === "rewritten") out.push(`  ${PIN_PATH} rewritten`);
  if (flavor.csharp) {
    const c = plan.csproj;
    for (const m of c.moved) out.push(`  ${c.file}: ${m.id} ${m.from} -> ${m.to}`);
    for (const k of c.skipped) out.push(`  ${c.file}: ${k.id} left as it is (${k.why})`);
    if (!c.moved.length && !c.skipped.length) out.push(`  ${c.file}: package references already at ${plan.packages.version}`);
    if (plan.nuget.action === "create" || plan.nuget.action === "update") out.push(`  nuget.config (${plan.nuget.action === "create" ? "written" : "refreshed"}: OneLobby.* from ${plan.packages.folder})`);
    if (plan.nuget.action === "skip") out.push(`  nuget.config: ${plan.nuget.note}`);
  }
  for (const b of r.blocks) out.push(`  ${b} (managed block)`);
  const n = r.natives;
  if (flavor.noNatives) return out.join("\n"); // the menu's pass reports them
  if (n.status === "install") out.push(`  ${n.folder} (webrtc-native ${n.version}, from ${n.source === "download" ? "a checked download" : n.source === "zip" ? "--webrtc-zip" : "--webrtc-dir"}; ${n.why})`);
  else if (n.status === "skipped") out.push(`  WebRTC natives not touched (${n.reason}).`);
  else out.push(`  ${n.folder} is already at ${n.version}; natives left as they are.`);
  return out.join("\n");
}

function updateWeb({ io, opts, found, target }) {
  const mine = readFileSync(join(target, ...found.glue.split("/")), "utf8").replace(/\r\n/g, "\n");
  const same = mine === glueSession().replace(/\r\n/g, "\n");
  let declared = null;
  try {
    declared = JSON.parse(readFileSync(join(target, "package.json"), "utf8")).dependencies?.onelobby ?? null;
  } catch {
    /* no package.json (an --into project may keep its dependencies elsewhere) */
  }
  const wanted = `^${ONELOBBY_VERSION}`;
  const install = `npm install onelobby@${wanted}`;
  const result = {
    ok: true,
    command: "update",
    dir: target,
    template: "web",
    changed: false,
    current: declared === wanted && same,
    dependency: { package: "onelobby", wanted, declared },
    install,
    glue: { path: found.glue, state: same ? "identical" : "differs" },
    next: [install],
    ...(opts.dryRun ? { dryRun: true } : {}),
  };
  if (opts.json) io.stdout.write(JSON.stringify(result) + "\n");
  else
    io.stdout.write(
      [
        'A web game takes OneLobby from the npm package "onelobby", so there is no add-on to re-vendor. Nothing was written and npm was not run.',
        `  package.json declares onelobby ${declared ?? "(nothing)"}; this create-onelobby targets ${wanted}.`,
        `  ${found.glue}: ${same ? "identical to this version's glue" : "differs from this version's glue (it is yours to edit, so update never rewrites it; compare it with templates/glue/session.js in the create-onelobby package)"}.`,
        "",
        "Next:",
        `  ${install}`,
        "",
      ].join("\n"),
    );
  return 0;
}

/** `create-onelobby update [dir] [--into dir] [options]`. Returns the exit code. */
export async function runUpdate({ dir, opts, io }) {
  const target = projectDir({ dir, opts, cwd: io.cwd });
  const found = detectProject(target);
  if (found.kind === null) throw notAProject(found, "update");
  if (found.kind === "web") return updateWeb({ io, opts, found, target });
  if (found.kind === "unity") return runUpdateUnity({ target, opts, io });

  // a C# game made with sync.player also has addons/onelobby_net_player/ and a pin of its own: both passes are planned before either is
  // written, so a local change in one of them stops the whole update
  const withPlayer = found.kind === "godot-csharp" && existsSync(join(target, ...NET_PLAYER_PIN.split("/")));
  const flavor = found.kind === "godot-csharp" ? { ...CSHARP, attributes: withPlayer ? CSHARP_PLAYER_GITATTRIBUTES_LINES : CSHARP_GITATTRIBUTES_LINES } : GDSCRIPT;
  const plan = planUpdate({ target, opts, cwd: io.cwd, flavor });
  const playerPlan = withPlayer ? planUpdate({ target, opts, cwd: io.cwd, flavor: NET_PLAYER }) : null;
  const current = plan.current && (playerPlan?.current ?? true);
  const result = godotResult({ target, plan, dryRun: opts.dryRun, flavor });
  const playerResult = playerPlan ? godotResult({ target, plan: playerPlan, dryRun: opts.dryRun, flavor: NET_PLAYER }) : null;
  if (playerResult) {
    result.netPlayer = { current: playerResult.current, addon: playerResult.addon, files: playerResult.files, overwritten: playerResult.overwritten, kept: playerResult.kept, pin: playerResult.pin };
    result.current = current;
    result.changed = !current;
    if (!current && result.next.length === 0) result.next = godotResult({ target, plan: { ...plan, current: false }, dryRun: false, flavor }).next;
  }
  const next = result.next.length ? `\nNext:\n  ${result.next.join("\n  ")}\n` : "";
  const text = (verb) => {
    if (current) return godotText(result, plan, verb, flavor) + (playerPlan ? `\n${NET_PLAYER_DIR}/ is current too (${NET_PLAYER.what} commit ${short(playerPlan.addon.commit)}).` : "");
    return [plan.current ? null : godotText(result, plan, verb, flavor), playerPlan && !playerPlan.current ? godotText(playerResult, playerPlan, verb, NET_PLAYER) : null].filter(Boolean).join("\n");
  };
  if (opts.dryRun || current) {
    if (opts.json) io.stdout.write(JSON.stringify(result) + "\n");
    else io.stdout.write(`${opts.dryRun && !current ? "Dry run: nothing written, nothing downloaded.\n" : ""}${text("Would update")}\n${next}`);
    return 0;
  }
  await applyUpdate(plan, { target, opts, cwd: io.cwd, fetchImpl: io.fetch, flavor });
  if (playerPlan) await applyUpdate(playerPlan, { target, opts, cwd: io.cwd, fetchImpl: io.fetch, flavor: NET_PLAYER });
  if (opts.json) io.stdout.write(JSON.stringify(result) + "\n");
  else io.stdout.write(`${text("Updated")}\n${next}`);
  return 0;
}
