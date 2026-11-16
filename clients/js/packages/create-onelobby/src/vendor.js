// Vendoring, shared by every engine template: copy an add-on into a project, fetch the native libraries it needs, pin what was
// copied (PIN.json: a SHA-256 per file, so a later `update` / `verify` can tell an untouched add-on from an edited one), keep the
// copied text files LF, and edit .gitignore / .gitattributes between marker lines. Nothing here knows about Godot.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./flags.js";
import { readZip, safeEntryName } from "./zip.js";

export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const packageVersion = () => JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version;

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ---- text normalisation ------------------------------------------------------------------------------------------------

const TEXT_EXT = new Set([".gd", ".tscn", ".tres", ".uid", ".json", ".md", ".cfg", ".txt", ".gdextension", ".import", ".gdignore", ".cs"]);
export const isTextPath = (p) => TEXT_EXT.has(p.slice(p.lastIndexOf(".")).toLowerCase());

/** Vendored text is always LF, whatever the checkout's line endings were, so a hash means the same on every machine. */
export function normalizeBytes(path, buf) {
  if (!isTextPath(path) || !buf.includes(13)) return buf;
  return Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

/** Every file below `dir`: [{ path (posix, relative), content }], sorted by path. */
export function readTree(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const a = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(a).isDirectory()) walk(a, r);
      else out.push({ path: r, content: normalizeBytes(r, readFileSync(a)) });
    }
  };
  walk(dir, "");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---- where the add-on comes from ---------------------------------------------------------------------------------------

/** The add-on bundled in this package by scripts/build.mjs (no network), or null when the package was built without it. */
const packagedAddon = () => join(PKG_ROOT, "vendor", "gdscript-addon");

/** The folder holding the add-on's scripts for `--addon-from <folder>`: a repo checkout, its clients/gdscript folder, or the add-on itself. */
export function resolveAddonFolder(from, cwd = process.cwd()) {
  const base = resolve(cwd, from);
  for (const c of [join(base, "clients/gdscript/addons/onelobby"), join(base, "addons/onelobby"), base]) {
    if (existsSync(join(c, "client.gd"))) return { dir: c, root: base };
  }
  throw new CliError("bad_addon_from", `--addon-from: no OneLobby GDScript add-on in ${base} (looked for clients/gdscript/addons/onelobby, addons/onelobby and the folder itself)`);
}

function gitHead(dir) {
  try {
    const r = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const sha = r.status === 0 ? r.stdout.trim() : "";
    return /^[0-9a-f]{40}$/.test(sha) ? sha : "unknown";
  } catch {
    return "unknown";
  }
}

/** The add-on to vendor: { files: [{ path, content }] (relative to addons/onelobby/), commit }. */
export function addonSource({ addonFrom, cwd } = {}) {
  if (addonFrom !== undefined) {
    const { dir, root } = resolveAddonFolder(addonFrom, cwd);
    return { files: readTree(dir).filter((f) => f.path !== "PIN.json"), commit: gitHead(root), from: "local" };
  }
  const dir = join(packagedAddon(), "onelobby");
  if (!existsSync(join(dir, "client.gd")))
    throw new CliError("addon_missing", 'this create-onelobby has no add-on bundled (run "npm run build" in the package, or pass --addon-from <repo checkout>)');
  const meta = JSON.parse(readFileSync(join(packagedAddon(), "source.json"), "utf8"));
  return { files: readTree(dir).filter((f) => f.path !== "PIN.json"), commit: meta.commit, from: "package" };
}

// ---- the pin file ------------------------------------------------------------------------------------------------------

export const ADDON_DIR = "addons/onelobby";
export const PIN_PATH = `${ADDON_DIR}/PIN.json`;
/** The C# menu's folder (godot-csharp): the only OneLobby source a C# game copies in (the rest comes from NuGet). */
export const MENU_DIR = "addons/onelobby_menu";
/** The C# networked player's folder (godot-csharp, only for a game with `sync.player`): the two [GlobalClass] scripts, vendored and pinned like the menu but in a pin of its own. */
export const NET_PLAYER_DIR = "addons/onelobby_net_player";

const sortKeys = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])])) : o);

/**
 * The WebRTC natives version a game's folder already has, when they are there and this run will not replace them: the `webrtcNative.version`
 * a PIN.json of ours recorded, else "unknown" (natives put there by hand, or by a build with no record). null when there are none, or this run
 * installs them. `pinPaths`: the pin files to ask, in order.
 */
export function existingNativesVersion(target, { present, replacing }, pinPaths = [PIN_PATH]) {
  if (!present || replacing) return null;
  for (const p of pinPaths) {
    try {
      const v = JSON.parse(readFileSync(join(target, ...p.split("/")), "utf8"))?.webrtcNative?.version;
      if (typeof v === "string" && v) return v;
    } catch {
      /* no pin, or not JSON */
    }
  }
  return "unknown";
}

/** The sentence for natives that stay: says when their version is not the pin (null when it is). */
export function nativesDifferLine(found) {
  if (found === null || found === WEBRTC_NATIVE_VERSION) return null;
  return `the WebRTC natives already in addons/godot_webrtc/ stay as they are, but their version is ${found === "unknown" ? "unknown (nothing records it)" : found}, not the pinned ${WEBRTC_NATIVE_VERSION}: rerun with --force to replace them with the pinned release (PIN.json records ${found})`;
}

/** PIN.json for these add-on files, deterministic (sorted keys, LF, trailing newline). */
export function buildPin({ files, commit, version = packageVersion(), webrtcNative = { version: WEBRTC_NATIVE_VERSION, zipSha256: WEBRTC_NATIVE_ZIP_SHA256 } }) {
  const hashes = {};
  for (const f of files) hashes[f.path] = sha256(f.content);
  const pin = {
    createOnelobby: version,
    source: { commit },
    webrtcNative,
    files: hashes,
  };
  return JSON.stringify(sortKeys(pin), null, 2) + "\n";
}

/**
 * The pin's `files` object, checked: every key is joined under addons/onelobby/ and read, hashed or deleted, so a key must be a
 * clean relative path (the same rule the zip reader applies to entry names: forward slashes, no empty, `.` or `..` segment,
 * no drive letter, no leading `/`, no NUL). Throws CliError("bad_pin") naming the first bad key; touches nothing.
 */
export function checkPinFiles(pin, folder = ADDON_DIR) {
  const PIN_PATH = `${folder}/PIN.json`;
  const files = pin?.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) throw new CliError("bad_pin", `${PIN_PATH} has no "files" list; adopt the add-on again with: npx create-onelobby --into . --force`);
  for (const [key, hash] of Object.entries(files)) {
    let ok = !key.endsWith("/");
    if (ok)
      try {
        safeEntryName(key);
      } catch {
        ok = false;
      }
    if (!ok) throw new CliError("bad_pin", `${PIN_PATH} lists ${JSON.stringify(key)}, which is not a plain relative path inside ${folder}/ (no "..", no absolute path, no backslash); nothing was read, written or deleted. Restore the pin from git, or adopt the add-on again with: npx create-onelobby --into . --force`);
    if (typeof hash !== "string") throw new CliError("bad_pin", `${PIN_PATH}: the hash of ${JSON.stringify(key)} is not a string; restore the pin from git`);
  }
  return files;
}

/**
 * Compare a project's add-on with its PIN.json: { ok, pin, edited, missing, added }. `edited`: a pinned file whose bytes
 * (CRLF read as LF) no longer match; `missing`: pinned but gone; `added`: a file in the add-on folder the pin does not list (not one that
 * `tolerate` accepts: the .cs.uid file Godot writes beside a script it imports).
 */
export function verifyPin(projectDir, folder = ADDON_DIR, { tolerate } = {}) {
  const pinFile = join(projectDir, ...folder.split("/"), "PIN.json");
  if (!existsSync(pinFile)) return { ok: false, pin: null, edited: [], missing: [], added: [], error: "no_pin" };
  const pin = JSON.parse(readFileSync(pinFile, "utf8"));
  checkPinFiles(pin, folder); // before any key is joined to a path
  const root = join(projectDir, ...folder.split("/"));
  const edited = [];
  const missing = [];
  for (const [path, hash] of Object.entries(pin.files)) {
    const abs = join(root, ...path.split("/"));
    if (!existsSync(abs)) missing.push(path);
    else if (sha256(normalizeBytes(path, readFileSync(abs))) !== hash) edited.push(path);
  }
  const added = readTree(root)
    .map((f) => f.path)
    .filter((p) => p !== "PIN.json" && !(p in pin.files) && !(tolerate && tolerate.test(p))); // tolerate: files Godot writes by itself (a script's .uid)
  return { ok: !edited.length && !missing.length && !added.length, pin, edited, missing, added };
}

// ---- an add-on that is already in the game ---------------------------------------------------------------------------

/** The pin an older create-onelobby (or a hand copy) left: a file `PIN` holding the add-on's commit, not `PIN.json`. */
export const LEGACY_PIN = "PIN";
const short7 = (sha) => (typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : "unknown");

/**
 * What `addons/onelobby/` of a game holds now: `kind` is "none" (no folder, or an empty one), "pinned" (a PIN.json), "legacy" (an older
 * `PIN` file, with or without a PIN.json beside it: that is a mixed add-on, so the PIN.json is not trusted) or "unpinned" (files, no pin).
 * `label` names the version ("33bcf81 (legacy PIN file)"), `files` is every file below the folder ({ path, content }, LF text), and a pinned
 * add-on also carries `pin`, `edited`, `missing` and `added` (see verifyPin). Throws CliError("bad_pin") for a PIN.json that cannot be read.
 */
export function installedAddon(projectDir, folder = ADDON_DIR) {
  const root = join(projectDir, ...folder.split("/"));
  if (!existsSync(root) || !statSync(root).isDirectory()) return { kind: "none", label: "none", files: [] };
  const files = readTree(root);
  if (!files.length) return { kind: "none", label: "none", files };
  const text = (name) => files.find((f) => f.path === name)?.content.toString("utf8");
  const legacy = text(LEGACY_PIN);
  if (legacy !== undefined) return { kind: "legacy", label: `${short7(legacy.trim().split(/\s+/)[0])} (legacy PIN file)`, files };
  if (text("PIN.json") !== undefined) {
    let state;
    try {
      state = verifyPin(projectDir, folder);
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError("bad_pin", `${folder}/PIN.json is not valid JSON (${e.message}); restore it from git, or delete it and the add-on files and run: npx create-onelobby --into .`);
    }
    const v = state.pin?.createOnelobby;
    return { kind: "pinned", label: `${short7(state.pin?.source?.commit)} (create-onelobby ${typeof v === "string" ? v : "unknown"})`, files, ...state };
  }
  return { kind: "unpinned", label: "unknown (no pin file)", files };
}

/**
 * The add-on of a game that has no PIN.json it can trust (a legacy `PIN` file, or no pin at all), as a pin of its own files' hashes so
 * `update` can treat every file as unedited and replace the folder whole: { pin, label } or null (no add-on, or a PIN.json: use verifyPin).
 */
export function olderAddonPin(projectDir, folder = ADDON_DIR) {
  const old = installedAddonLoose(projectDir, folder);
  if (old.kind !== "legacy" && old.kind !== "unpinned") return null;
  const files = {};
  for (const f of old.files) files[f.path] = sha256(f.content);
  const commit = old.kind === "legacy" ? (old.files.find((f) => f.path === LEGACY_PIN).content.toString("utf8").trim().split(/s+/)[0] ?? "unknown") : "unknown";
  return { pin: { createOnelobby: "unknown", source: { commit }, files }, label: old.label };
}

/** installedAddon without reading a PIN.json (kind "pinned" is reported as such, nothing verified). */
function installedAddonLoose(projectDir, folder) {
  const root = join(projectDir, ...folder.split("/"));
  if (!existsSync(root) || !statSync(root).isDirectory()) return { kind: "none", files: [] };
  const files = readTree(root);
  if (!files.length) return { kind: "none", files };
  const legacy = files.find((f) => f.path === LEGACY_PIN);
  if (legacy) return { kind: "legacy", label: `${short7(legacy.content.toString("utf8").trim().split(/s+/)[0])} (legacy PIN file)`, files };
  if (files.some((f) => f.path === "PIN.json")) return { kind: "pinned", files };
  return { kind: "unpinned", label: "unknown (no pin file)", files };
}

/** The label of the add-on a run brings, in the same form as installedAddon's. */
export const incomingAddonLabel = (commit) => `${short7(commit)} (create-onelobby ${packageVersion()})`;

/**
 * Replace a game's add-on whole with `source` (addonSource()): returns what a run would do, writing nothing.
 * { kind, from, to, create, overwrite, unchanged, remove, edited, unlisted }: paths relative to the add-on folder, PIN.json not included
 * (the caller writes the new pin). `remove` is every file of the old add-on the new one does not have, a legacy `PIN` file included, so an
 * old copy never stays beside the new files. A pinned add-on whose files were edited, or that holds files its pin does not list, stops
 * with CliError("local_changes") naming each, unless `force`; a legacy or unpinned add-on has no hashes to tell edits from the old copy, so it
 * is replaced (git has the old files).
 */
export function planAddonReplace({ target, source, force = false, folder = ADDON_DIR }) {
  const old = installedAddon(target, folder);
  const wanted = new Map(source.files.map((f) => [f.path, f.content]));
  const have = new Map(old.files.map((f) => [f.path, f.content]));
  const create = [];
  const overwrite = [];
  const unchanged = [];
  for (const [path, content] of wanted) {
    if (!have.has(path)) create.push(path);
    else if (have.get(path).equals(content)) unchanged.push(path);
    else overwrite.push(path);
  }
  const remove = [...have.keys()].filter((p) => p !== "PIN.json" && !wanted.has(p));
  const edited = old.kind === "pinned" ? old.edited.filter((p) => !wanted.has(p) || overwrite.includes(p)) : [];
  const unlisted = old.kind === "pinned" ? old.added.filter((p) => remove.includes(p)) : [];
  if ((edited.length || unlisted.length) && !force) {
    const lines = [...edited.map((p) => `  edited   ${folder}/${p}`), ...unlisted.map((p) => `  unlisted ${folder}/${p} (not in its PIN.json)`)];
    throw new CliError(
      "local_changes",
      `the add-on in ${target} no longer matches its ${folder}/PIN.json; nothing was changed:\n${lines.join("\n")}\nKeep your edits (copy them out), then rerun with --force: it replaces the add-on whole (edited files overwritten, unlisted files removed).`,
      undefined,
      { edited, unlisted },
    );
  }
  return { kind: old.kind, from: old.label, to: incomingAddonLabel(source.commit), create: create.sort(), overwrite: overwrite.sort(), unchanged: unchanged.sort(), remove: remove.sort(), edited, unlisted };
}

// ---- natives: Godot's WebRTC GDExtension -------------------------------------------------------------------------------

export const WEBRTC_NATIVE_VERSION = "1.2.2-stable";
/** SHA-256 of godot-extension-webrtc_native.zip of that release (the zip is never committed). */
export const WEBRTC_NATIVE_ZIP_SHA256 = "98e9446921740d995bd9ca1be48798dc3c2ceed51e044a25ce18b3cff11f56e5";
export const webrtcUrl = (version = WEBRTC_NATIVE_VERSION) => `https://github.com/godotengine/webrtc-native/releases/download/${version}/godot-extension-webrtc_native.zip`;
export const NATIVES_DIR = "addons/godot_webrtc";
export const NATIVES_MARKER = `${NATIVES_DIR}/webrtc_native.gdextension`;

/** The files of an unpacked webrtc-native add-on under `addons/godot_webrtc/`: the folder that holds the .gdextension file, renamed (same layout as fetch-webrtc.sh). */
export function nativesFromZip(buf) {
  const entries = readZip(buf).filter((e) => !e.dir);
  const marker = entries.find((e) => e.name.endsWith(".gdextension"));
  if (!marker) throw new CliError("bad_zip", "the webrtc-native zip has no .gdextension file");
  const prefix = marker.name.includes("/") ? marker.name.slice(0, marker.name.lastIndexOf("/") + 1) : "";
  return entries
    .filter((e) => e.name.startsWith(prefix))
    .map((e) => ({ path: `${NATIVES_DIR}/${e.name.slice(prefix.length)}`, content: e.data() }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The same from an already unpacked folder (the one that holds webrtc_native.gdextension). */
export function nativesFromDir(dir) {
  if (!existsSync(dir) || !readdirSync(dir).some((n) => n.endsWith(".gdextension")))
    throw new CliError("bad_webrtc", `--webrtc-dir: ${dir} is not an unpacked webrtc-native folder (no .gdextension file in it)`);
  return readTree(dir).map((f) => ({ path: `${NATIVES_DIR}/${f.path}`, content: readFileSync(join(dir, ...f.path.split("/"))) }));
}

/** Download the pinned zip anonymously and check its SHA-256. `fetchImpl` is injectable for tests. */
export async function downloadNatives({ fetchImpl = globalThis.fetch, url = webrtcUrl(), sha = WEBRTC_NATIVE_ZIP_SHA256 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: "follow" });
  } catch (e) {
    throw new CliError("download_failed", `could not download ${url} (${e?.cause?.code ?? e?.message ?? e}). Use --webrtc-zip <file> offline, or --no-natives and fetch them later`);
  }
  if (!res.ok) throw new CliError("download_failed", `could not download ${url} (HTTP ${res.status}). Use --webrtc-zip <file> offline, or --no-natives and fetch them later`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== sha) throw new CliError("bad_download", `the download of ${url} has SHA-256 ${got}, not the pinned ${sha}; nothing was installed`);
  return buf;
}

/** The native files to install for the options: from --webrtc-zip, --webrtc-dir or a checked download. */
export async function loadNatives({ webrtcZip, webrtcDir, cwd = process.cwd(), fetchImpl }) {
  if (webrtcDir !== undefined) return nativesFromDir(resolve(cwd, webrtcDir));
  if (webrtcZip !== undefined) {
    let buf;
    try {
      buf = readFileSync(resolve(cwd, webrtcZip));
    } catch (e) {
      throw new CliError("bad_webrtc", `--webrtc-zip: cannot read ${webrtcZip} (${e.code ?? e.message})`);
    }
    return nativesFromZip(buf);
  }
  return nativesFromZip(await downloadNatives({ fetchImpl }));
}

// ---- .gitignore / .gitattributes blocks --------------------------------------------------------------------------------

export const BLOCK_BEGIN = "# >>> onelobby (managed by create-onelobby) >>>";
export const BLOCK_END = "# <<< onelobby <<<";

/**
 * `existing` with the managed block set to `lines`: replaced in place when the marker lines are there, else appended
 * (after a blank line) once. Never duplicated; the file's own line endings are kept. `existing` undefined: just the block.
 */
export function applyBlock(existing, lines) {
  const eol = existing !== undefined && existing.includes("\r\n") ? "\r\n" : "\n";
  const block = [BLOCK_BEGIN, ...lines, BLOCK_END].join(eol) + eol;
  if (existing === undefined || existing === "") return block;
  const at = existing.indexOf(BLOCK_BEGIN);
  const end = at < 0 ? -1 : existing.indexOf(BLOCK_END, at);
  if (at >= 0 && end >= 0) {
    let stop = end + BLOCK_END.length;
    if (existing.startsWith("\r\n", stop)) stop += 2;
    else if (existing[stop] === "\n") stop += 1;
    return existing.slice(0, at) + block + existing.slice(stop);
  }
  const body = existing.endsWith("\n") ? existing : existing + eol;
  return body + eol + block;
}

/** The managed lines for each engine-neutral file. `.gitignore`: what a fresh clone regenerates; `.gitattributes`: keep the add-on LF. */
export const GITIGNORE_LINES = ["addons/godot_webrtc/", ".godot/", ".onelobby/"]; // .onelobby/: scratch and helper cache of `create-onelobby verify`
export const GITATTRIBUTES_LINES = ["addons/onelobby/** text eol=lf"];

// ---- godot-csharp: the menu folder and its managed blocks ---------------------------------------------------------------

/** The managed lines for a Godot C# game: the same as GDScript plus what `dotnet build` regenerates. */
export const CSHARP_GITIGNORE_LINES = [...GITIGNORE_LINES, "bin/", "obj/"];
export const CSHARP_GITATTRIBUTES_LINES = [`${MENU_DIR}/** text eol=lf`];
/** The same for a game with the networked player folder too. */
export const CSHARP_PLAYER_GITATTRIBUTES_LINES = [...CSHARP_GITATTRIBUTES_LINES, `${NET_PLAYER_DIR}/** text eol=lf`];
/** Godot writes `<Script>.cs.uid` beside every script it imports; the net player folder is vendored without them, so a pin check must not call them edits. */
export const NET_PLAYER_TOLERATE = /\.uid$/;

/** The menu bundled in this package by scripts/build.mjs, or absent when the package was built without it. */
const packagedMenu = () => join(PKG_ROOT, "vendor", "csharp-menu");

/** The folder holding OneLobbyMenu.cs for `--addon-from <folder>`: a repo checkout, the demo project, the project that has it, or the folder itself. */
export function resolveMenuFolder(from, cwd = process.cwd()) {
  const base = resolve(cwd, from);
  for (const c of [join(base, "clients/dotnet/demo-godot/addons/onelobby_menu"), join(base, "demo-godot/addons/onelobby_menu"), join(base, "addons/onelobby_menu"), base]) {
    if (existsSync(join(c, "OneLobbyMenu.cs"))) return { dir: c, root: base };
  }
  throw new CliError("bad_addon_from", `--addon-from: no OneLobbyMenu.cs in ${base} (looked for clients/dotnet/demo-godot/addons/onelobby_menu, addons/onelobby_menu and the folder itself)`);
}

/** The C# menu to vendor: { files: [{ path, content }] (relative to addons/onelobby_menu/), commit, from }. */
export function menuSource({ addonFrom, cwd } = {}) {
  if (addonFrom !== undefined) {
    const { dir, root } = resolveMenuFolder(addonFrom, cwd);
    return { files: readTree(dir).filter((f) => f.path !== "PIN.json"), commit: gitHead(root), from: "local" };
  }
  const dir = join(packagedMenu(), "onelobby_menu");
  if (!existsSync(join(dir, "OneLobbyMenu.cs")))
    throw new CliError("addon_missing", 'this create-onelobby has no C# menu bundled (run "npm run build" in the package, or pass --addon-from <repo checkout>)');
  const meta = JSON.parse(readFileSync(join(packagedMenu(), "source.json"), "utf8"));
  return { files: readTree(dir).filter((f) => f.path !== "PIN.json"), commit: meta.commit, from: "package" };
}

/** The folder holding OneLobbyNetPlayer.cs for `--addon-from <folder>`: a repo checkout, the demo project, the project that has it, or the folder itself. */
export function resolveNetPlayerFolder(from, cwd = process.cwd()) {
  const base = resolve(cwd, from);
  for (const c of [join(base, "clients/dotnet/demo-godot/addons/onelobby_net_player"), join(base, "demo-godot/addons/onelobby_net_player"), join(base, "addons/onelobby_net_player"), base]) {
    if (existsSync(join(c, "OneLobbyNetPlayer.cs"))) return { dir: c, root: base };
  }
  throw new CliError("bad_addon_from", `--addon-from: no OneLobbyNetPlayer.cs in ${base} (looked for clients/dotnet/demo-godot/addons/onelobby_net_player, addons/onelobby_net_player and the folder itself)`);
}

const packagedNetPlayer = () => join(PKG_ROOT, "vendor", "csharp-net-player");

/** The C# networked player folder to vendor: { files: [{ path, content }] (relative to addons/onelobby_net_player/), commit, from }. */
export function netPlayerSource({ addonFrom, cwd } = {}) {
  if (addonFrom !== undefined) {
    const { dir, root } = resolveNetPlayerFolder(addonFrom, cwd);
    return { files: readTree(dir).filter((f) => f.path !== "PIN.json" && !NET_PLAYER_TOLERATE.test(f.path)), commit: gitHead(root), from: "local" };
  }
  const dir = join(packagedNetPlayer(), "onelobby_net_player");
  if (!existsSync(join(dir, "OneLobbyNetPlayer.cs")))
    throw new CliError("addon_missing", 'this create-onelobby has no C# networked player bundled (run "npm run build" in the package, or pass --addon-from <repo checkout>)');
  const meta = JSON.parse(readFileSync(join(packagedNetPlayer(), "source.json"), "utf8"));
  return { files: readTree(dir).filter((f) => f.path !== "PIN.json" && !NET_PLAYER_TOLERATE.test(f.path)), commit: meta.commit, from: "package" };
}
