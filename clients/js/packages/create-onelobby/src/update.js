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
import { csharpPlanned, detectProject, notAProject, projectDir } from "./project.js";
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
  packageVersion,
  sha256,
  verifyPin,
} from "./vendor.js";

export const IMPORT_COMMAND = "godot --headless --import --path .";
const ADDON_DIR = "addons/onelobby";
const short = (sha) => (typeof sha === "string" && sha.length >= 7 ? sha.slice(0, 7) : String(sha ?? "unknown"));

/** The managed blocks of .gitignore and .gitattributes, as { path, content, action }. */
export function blockPlan(target) {
  return [
    [".gitignore", GITIGNORE_LINES],
    [".gitattributes", GITATTRIBUTES_LINES],
  ].map(([path, lines]) => {
    const p = join(target, path);
    const before = existsSync(p) ? readFileSync(p, "utf8") : undefined;
    const after = applyBlock(before, lines);
    return { path, content: Buffer.from(after, "utf8"), action: before === undefined ? "create" : after === before ? "unchanged" : "update" };
  });
}

/** What a godot-gdscript update would do, writing nothing. Throws no_pin / bad_pin / local_changes when it must not go on. */
export function planUpdate({ target, opts, cwd }) {
  const rel = relative(cwd, target) || ".";
  let pinState;
  try {
    pinState = verifyPin(target);
  } catch (e) {
    throw new CliError("bad_pin", `${PIN_PATH} is not valid JSON (${e.message}); restore it from git, or adopt the add-on again with: npx create-onelobby --into ${rel} --force`);
  }
  if (pinState.error === "no_pin")
    throw new CliError(
      "no_pin",
      `${target} has no ${PIN_PATH}, so update cannot tell its add-on from files you edited. Adopt the project first with: npx create-onelobby --into ${rel}   (it writes the pin; add --force to also replace add-on files that differ)`,
    );
  const pin = pinState.pin;
  if (typeof pin?.files !== "object" || pin.files === null) throw new CliError("bad_pin", `${PIN_PATH} has no "files" list; adopt the add-on again with: npx create-onelobby --into ${rel} --force`);

  const source = addonSource({ addonFrom: opts.addonFrom, cwd });
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
  const blocks = blockPlan(target);

  // natives: the pinned version moved, or the folder is gone
  const present = existsSync(join(target, NATIVES_MARKER));
  const oldNatives = pin.webrtcNative?.version;
  let natives;
  if (opts.noNatives) natives = { status: "skipped", reason: "--no-natives" };
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
  return {
    files,
    removed,
    kept,
    overwritten,
    local,
    blocks,
    natives,
    pinText,
    current: !addonChanged && !blocksChanged && !nativesInstall,
    addon: { from: source.from, commit: source.commit, previousCommit: pin.source?.commit ?? "unknown", createOnelobby: packageVersion(), previousCreateOnelobby: pin.createOnelobby ?? "unknown" },
  };
}

async function applyUpdate(plan, { target, opts, cwd, fetchImpl }) {
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
}

function godotResult({ target, plan, dryRun }) {
  return {
    ok: true,
    command: "update",
    dir: target,
    template: "godot-gdscript",
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
    next: plan.current ? [] : [`${IMPORT_COMMAND}   # new class_names (and a new natives version) need the import`],
  };
}

function godotText(r, plan, verb) {
  if (r.current)
    return `Already current: ${r.dir} has this version's add-on (add-on commit ${short(plan.addon.commit)}) and the managed .gitignore/.gitattributes blocks; ${r.natives.status === "skipped" ? `the WebRTC natives were not checked (${r.natives.reason})` : `the WebRTC natives are at ${r.natives.version}`}. Nothing was written.`;
  const f = r.files;
  const out = [`${verb} ${r.dir}`];
  out.push(
    `  ${ADDON_DIR}/: ${f.changed.length} changed, ${f.added.length} added, ${f.removed.length} removed (add-on commit ${short(plan.addon.previousCommit)} -> ${short(plan.addon.commit)}, ${plan.addon.from === "package" ? `bundled in create-onelobby ${plan.addon.createOnelobby}` : "from --addon-from"})`,
  );
  for (const [label, list] of [["changed", f.changed], ["added", f.added], ["removed", f.removed]]) for (const p of list) out.push(`    ${label.padEnd(8)} ${p}`);
  if (r.overwritten.length) out.push(`  --force overwrote your edits to ${r.overwritten.length} file(s):`, ...r.overwritten.map((p) => `    ${p}`));
  if (r.kept.length) out.push(`  kept ${r.kept.length} file(s) you added (not in this add-on):`, ...r.kept.map((p) => `    ${p}`));
  if (r.pin === "rewritten") out.push(`  ${PIN_PATH} rewritten`);
  for (const b of r.blocks) out.push(`  ${b} (managed block)`);
  const n = r.natives;
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
  if (found.kind === "godot-csharp") throw csharpPlanned(target);
  if (found.kind === null) throw notAProject(found, "update");
  if (found.kind === "web") return updateWeb({ io, opts, found, target });

  const plan = planUpdate({ target, opts, cwd: io.cwd });
  const result = godotResult({ target, plan, dryRun: opts.dryRun });
  const next = result.next.length ? `\nNext:\n  ${result.next.join("\n  ")}\n` : "";
  if (opts.dryRun || plan.current) {
    if (opts.json) io.stdout.write(JSON.stringify(result) + "\n");
    else io.stdout.write(`${opts.dryRun && !plan.current ? "Dry run: nothing written, nothing downloaded.\n" : ""}${godotText(result, plan, "Would update")}\n${next}`);
    return 0;
  }
  await applyUpdate(plan, { target, opts, cwd: io.cwd, fetchImpl: io.fetch });
  if (opts.json) io.stdout.write(JSON.stringify(result) + "\n");
  else io.stdout.write(`${godotText(result, plan, "Updated")}\n${next}`);
  return 0;
}
