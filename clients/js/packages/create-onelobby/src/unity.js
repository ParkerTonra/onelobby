// The `unity` template: a new Unity 6 project, or `--into` an existing one. Plans first (no writes, no download), then applies.
// A Unity game takes OneLobby as ONE package, `com.onelobby.unity`, by a line in Packages/manifest.json (manifest.js edits it in place);
// the menu is inside the package, so nothing is copied into the game except the blueprint, a test, a build script and (new projects) a boot script.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./flags.js";
import { keepOnelobbyJson } from "./recommend.js";
import { ONELOBBY_VERSION, SCHEMA_URL } from "./blueprint.js";
import { PACKAGE_NAME, addDependencies, newManifest } from "./manifest.js";
import { DEFAULT_DIRECT_PORT } from "./godot.js";
import { applyBlock } from "./vendor.js";
import { pickBlocks, playerFlags, resolveNetPlayer } from "./net-player.js";

const templates = join(dirname(fileURLToPath(import.meta.url)), "../templates/unity");
const read = (...p) => readFileSync(join(templates, ...p), "utf8").replace(/\r\n/g, "\n"); // LF whatever the checkout did

export const UNITY_RECIPE_URL = "https://github.com/ParkerTonra/onelobby/blob/main/docs/recipes/unity.md";
/** The editor version a new project is made for when no Unity is found: the one the package was built and tested with. */
export const DEFAULT_EDITOR = "6000.2.7f2";
/** The oldest editor the package supports (its package.json says "unity": "6000.0"). */
export const MIN_EDITOR = "6000.0";
/** The test framework version a new project asks for when the editor does not say which one it bundles. */
export const DEFAULT_TEST_FRAMEWORK = "1.6.0";
/** The built-in modules the menu and the transport need; a new project lists them, `--into` adds the ones a manifest lacks. */
export const BUILTIN_MODULES = ["imgui", "ui", "uielements", "audio", "jsonserialize", "unitywebrequest", "physics", "imageconversion", "screencapture"];
export const MANIFEST_PATH = "Packages/manifest.json";
export const BLUEPRINT_PATH = "Assets/Resources/onelobby.json";
export const TEST_FILES = ["Assets/OneLobby/Tests/MultiplayerTests.cs", "Assets/OneLobby/Tests/OneLobbyGame.Tests.asmdef"];
/** A game with players in the world (sync.player) also has its own assembly, so the play-mode test can use the game's character. */
export const GAME_ASMDEF = "Assets/Scripts/OneLobbyGame.asmdef";
export const BUILD_FILE = "Assets/OneLobby/Editor/BuildPlayer.cs";
export const TEST_ASSEMBLY = "OneLobbyGame.Tests";
export const BUILD_METHOD = "OneLobbyBuild.Windows";
export const PLAYER_EXE = "Builds/Windows/Game.exe";
export const UNITY_GITIGNORE_LINES = ["/[Ll]ibrary/", "/[Tt]emp/", "/[Ll]ogs/", "/[Uu]serSettings/", "/[Oo]bj/", "/[Bb]uilds/", ".onelobby/", "*.csproj", "*.sln", "*.slnx"];
export const UNITY_GITATTRIBUTES_LINES = ["Assets/OneLobby/** text eol=lf"];

const slugOf = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "game";
const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
const json = (o) => JSON.stringify(o, null, 2) + "\n";
const bytes = (c) => (Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8"));

function targetState(target) {
  if (!existsSync(target)) return "missing";
  return statSync(target).isDirectory() ? (readdirSync(target).length ? "full" : "empty") : "file";
}

// ---- finding the editor ---------------------------------------------------------------------------------------------------

/** `6000.2.7f2` -> [6000, 2, 7, 'f', 2]; null when it is not a Unity version. */
export function parseEditorVersion(text) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+)(?:([abfpc])(\d+))?)?/.exec(String(text ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0), m[4] ?? "f", Number(m[5] ?? 0)] : null;
}

/** -1, 0 or 1: is Unity version `a` older, equal or newer than `b`? Both must parse. */
export function compareEditors(a, b) {
  const x = parseEditorVersion(a);
  const y = parseEditorVersion(b);
  for (let i = 0; i < 5; i++) {
    const p = i === 3 ? "abpf".indexOf(x[i]) : x[i];
    const q = i === 3 ? "abpf".indexOf(y[i]) : y[i];
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** Is editor version `v` at least the package's minimum (6000.0)? */
export const editorIsNewEnough = (v) => parseEditorVersion(v) !== null && compareEditors(v, MIN_EDITOR) >= 0;

/** The editors the Unity Hub installed in its default folder, newest first: [{ version, exe }]. `env`/`platform`/`list` are test seams. */
export function hubEditors({ env = process.env, platform = process.platform, list } = {}) {
  const base = platform === "win32" ? join(env.ProgramFiles ?? "", "Unity/Hub/Editor") : platform === "darwin" ? "/Applications/Unity/Hub/Editor" : join(env.HOME ?? "", "Unity/Hub/Editor");
  let names = [];
  try {
    names = list ? list(base) : readdirSync(base);
  } catch {
    /* no Hub folder */
  }
  const exe = (v) => (platform === "win32" ? join(base, v, "Editor/Unity.exe") : platform === "darwin" ? join(base, v, "Unity.app/Contents/MacOS/Unity") : join(base, v, "Editor/Unity"));
  return names
    .filter((n) => parseEditorVersion(n) !== null)
    .sort((a, b) => compareEditors(b, a))
    .map((v) => ({ version: v, exe: exe(v) }));
}

const spawnOut = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout : "";
};

/**
 * The version of the editor at `exe`: from the Hub's folder name (.../Editor/<version>/Editor/Unity.exe), else, on Windows, the file's
 * product version ("6000.2.7f2_2b518236b676": the version and its revision). `run(cmd, args)` returns stdout (a test seam).
 * Returns { version, revision? } or null.
 */
export function editorVersionOf(exe, { run = spawnOut, platform = process.platform } = {}) {
  const norm = exe.replace(/\\/g, "/");
  const folder = /\/Hub\/Editor\/(\d+\.\d+\.\d+[abfpc]\d+)\//.exec(norm)?.[1];
  let revision;
  if (platform === "win32" && existsSync(exe)) {
    const out = run("powershell", ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`]).trim();
    const m = /^(\d+\.\d+\.\d+[abfpc]\d+)_([0-9a-f]+)$/.exec(out);
    if (m) {
      revision = m[2];
      return { version: folder ?? m[1], revision };
    }
  }
  return folder ? { version: folder } : null;
}

/** The editor's root folder (the one holding Data/): Windows and Linux `<root>/Unity.exe`, macOS `<app>/Contents/MacOS/Unity`. */
export const editorRoot = (exe) => (/MacOS[\\/]Unity$/.test(exe) ? resolve(dirname(exe), "..") : dirname(exe));

/** The version of the test framework the editor bundles (built-in packages need no registry), or null. */
export function bundledTestFramework(exe) {
  try {
    const p = join(editorRoot(exe), "Data/Resources/PackageManager/BuiltInPackages/com.unity.test-framework/package.json");
    return JSON.parse(readFileSync(p, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Find a Unity editor: `--unity <exe>`, else $UNITY, else the Hub's default folder (the version the project names when it is installed,
 * else the newest). Returns { exe, from: "--unity" | "$UNITY" | "the Unity Hub", version?, revision? } or null.
 * A `--unity` / $UNITY path that does not exist is not silently replaced by another editor: it returns { missing, from }.
 */
export function resolveUnity({ flag, env = {}, wantVersion, platform, list, run, exists = existsSync } = {}) {
  const named = flag !== undefined ? [flag, "--unity"] : env.UNITY ? [env.UNITY, "$UNITY"] : null;
  if (named) {
    if (!exists(named[0])) return { missing: named[0], from: named[1] };
    return { exe: named[0], from: named[1], ...(editorVersionOf(named[0], { run, platform }) ?? {}) };
  }
  const hub = hubEditors({ env, platform, list }).filter((e) => exists(e.exe));
  const pick = hub.find((e) => e.version === wantVersion) ?? hub[0];
  if (!pick) return null;
  return { exe: pick.exe, from: "the Unity Hub", ...(editorVersionOf(pick.exe, { run, platform }) ?? { version: pick.version }) };
}

/**
 * The editor version a new project is made for: the Unity that --unity, $UNITY or the Hub names (6000.0 or newer), else DEFAULT_EDITOR.
 * Why: Unity asks to upgrade a project made for an older editor and refuses one made for a newer one, so a new project follows the editor
 * the person has; with none found, the version the package was tested with is the safe pick.
 */
export function chooseEditor({ opts, env, resolve: find = resolveUnity }) {
  const found = find({ flag: opts.unity, env: env ?? {} });
  if (!found) return { version: DEFAULT_EDITOR, from: "default", why: "no Unity editor found" };
  if (found.missing) return { version: DEFAULT_EDITOR, from: "default", why: `${found.from} names ${found.missing}, which does not exist` };
  if (!found.version || !editorIsNewEnough(found.version)) return { version: DEFAULT_EDITOR, from: "default", why: `${found.exe} is ${found.version ?? "of an unknown version"}, not Unity ${MIN_EDITOR} or newer` };
  return { version: found.version, revision: found.revision, from: found.from, exe: found.exe, testFramework: bundledTestFramework(found.exe) };
}

// ---- the package reference ------------------------------------------------------------------------------------------------

/** The file name the default reference names: the tarball the person puts next to manifest.json (`Add package from tarball` writes the same kind of line). */
export const defaultTarball = (version = ONELOBBY_VERSION) => `${PACKAGE_NAME}-${version}.tgz`;

/** The version in a `com.onelobby.unity-<version>.tgz` file name, or null. */
export const tarballVersion = (name) => new RegExp(`^${PACKAGE_NAME.replace(/\./g, "\\.")}-(\\d+\\.\\d+\\.\\d+[0-9A-Za-z.+-]*)\\.tgz$`).exec(String(name).replace(/\\/g, "/").split("/").pop())?.[1] ?? null;

/**
 * What the manifest's package line says for this run: { value, from: "tarball" | "default", file?, version }.
 * `--package-from <tgz>` writes a `file:` reference (relative to Packages/, which is where Unity resolves it; absolute when the
 * tarball is on another drive). Without it the line names the release's tarball, `file:com.onelobby.unity-<version>.tgz`, in Packages/:
 * the package is not on a registry yet, so the person (or CI) puts the tarball there.
 */
export function packageRef({ opts, target, cwd }) {
  if (opts.packageFrom === undefined) {
    const file = defaultTarball();
    return { value: `file:${file}`, from: "default", version: ONELOBBY_VERSION, file };
  }
  const tgz = resolve(cwd, opts.packageFrom);
  if (!existsSync(tgz) || !statSync(tgz).isFile()) throw new CliError("bad_package_from", `--package-from: ${tgz} is not a file (expected a com.onelobby.unity-<version>.tgz; build one with clients/unity/build-unity-package.sh --pack, or download the unity-dev-package artifact)`);
  if (!/\.(tgz|tar\.gz)$/i.test(tgz)) throw new CliError("bad_package_from", `--package-from: ${tgz} is not a .tgz tarball`);
  const rel = relative(join(target, "Packages"), tgz);
  const path = (!isAbsolute(rel) ? rel : tgz).replace(/\\/g, "/");
  return { value: `file:${path}`, from: "tarball", version: tarballVersion(tgz) ?? ONELOBBY_VERSION, file: tgz };
}

/** The dependencies the OneLobby package needs in a manifest, in the order they are written. */
export function wantedDependencies({ ref, testFramework }) {
  return [
    { name: PACKAGE_NAME, value: ref.value },
    { name: "com.unity.test-framework", value: testFramework ?? DEFAULT_TEST_FRAMEWORK },
    ...BUILTIN_MODULES.map((m) => ({ name: `com.unity.modules.${m}`, value: "1.0.0" })),
  ];
}

// ---- the play entry -------------------------------------------------------------------------------------------------------

/**
 * .olc/<slug>.json: two tasks that build the Windows player (headless, `-quit`) and open it as a host window plus a small joiner window on
 * this PC. The editor comes from $UNITY, else the newest in the Hub's default folder. The flags are the ones the Godot entries pass.
 */
export function olcEntry({ slug, title }) {
  const joiner = `--join=127.0.0.1:${DEFAULT_DIRECT_PORT} --local --name=Joiner`;
  const build = `-batchmode -nographics -quit -projectPath . -logFile .onelobby/build.log -executeMethod ${BUILD_METHOD}`;
  const exe = PLAYER_EXE.replace(/\//g, "\\");
  const ps =
    `$u = if ($env:UNITY) { $env:UNITY } else { Join-Path (Get-ChildItem (Join-Path $env:ProgramFiles 'Unity/Hub/Editor') -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName 'Editor/Unity.exe' }; ` +
    `New-Item -ItemType Directory -Force .onelobby | Out-Null; & $u ${build}; if ($LASTEXITCODE -ne 0) { Write-Host 'the build failed: see .onelobby/build.log (is this project open in the Unity editor?)'; exit 1 }; ` +
    `Start-Process -FilePath .\\${exe} -ArgumentList '--host','--local','--name=Host'; Start-Sleep -Seconds 4; & .\\${exe} -screen-fullscreen 0 -screen-width 640 -screen-height 360 ${joiner}`;
  const sh =
    `U="\${UNITY:-$(ls -d "\$PROGRAMFILES"/Unity/Hub/Editor/*/ | sort | tail -n 1)Editor/Unity.exe}"; ` +
    `mkdir -p .onelobby; "$U" ${build} || { echo 'the build failed: see .onelobby/build.log (is this project open in the Unity editor?)'; exit 1; }; ` +
    `./${PLAYER_EXE} --host --local --name=Host & sleep 4; ./${PLAYER_EXE} -screen-fullscreen 0 -screen-width 640 -screen-height 360 ${joiner}`;
  const entry = (suffix, shell, command) => ({ name: `${slug}-play${suffix}`, label: `${title} - host + joiner${suffix ? ` (${shell})` : ""}`, kind: "task", group: slug, cwd: ".", command, shell, play: true });
  return json({ entries: [entry("", "powershell", ps), entry("-bash", "bash", sh)] });
}

// ---- players in the world (sync.player) ------------------------------------------------------------------------------------

/** The files a game with players in the world gets besides the common ones (new project): { path, content }. `read` reads a template file as LF text. */
export function netPlayerFiles({ authority, space }, read) {
  const flags = playerFlags({ authority, space });
  return [
    { path: "Assets/Scripts/Boot.cs", content: read("net-player", "Boot.cs") },
    { path: "Assets/Scripts/Game.cs", content: pickBlocks(read("net-player", "Game.cs"), flags) },
    { path: "Assets/Scripts/GamePlayer.cs", content: pickBlocks(read("net-player", "GamePlayer.cs"), flags) },
    { path: GAME_ASMDEF, content: read("net-player", "OneLobbyGame.asmdef") },
  ];
}

const TEST_PUMP = "                if (_host != null) _host.Pump(); else _hostClient?.Pump();\n                if (_guest != null) _guest.Pump(); else _guestClient?.Pump();\n";
const TEST_HOLD = "            // --hold=SECONDS:";
const TEST_END = "    }\n}\n";
const ASMDEF_REFS = '"references": ["OneLobby.Unity", "UnityEngine.TestRunner", "UnityEditor.TestRunner"],';
const ASMDEF_PRECOMPILED = '"precompiledReferences": ["nunit.framework.dll", "OneLobby.Core.dll", "OneLobby.Direct.dll"],';

/** Assets/OneLobby/Tests/MultiplayerTests.cs with the player check added, both ways: the joiner's player appears on the host with a position and one jump arrives once, then the same for the host's player on the joiner. */
export function multiplayerWithPlayer(base, part, settings) {
  for (const needle of [TEST_PUMP, TEST_HOLD, TEST_END]) if (!base.includes(needle)) throw new Error("MultiplayerTests.cs: a place for the player check moved");
  const indented = TEST_PUMP.replace(/^/gm, "    ").replace(/ +$/, ""); // the same two lines, one level deeper
  const guarded = "                // while the player spawners run, their layers pump the two lobbies\n                if (!_playerPhase)\n                {\n" + indented + "                }\n";
  const pumped = base.replace(TEST_PUMP, () => guarded);
  const called = pumped.replace(TEST_HOLD, () => `            if (_route == "direct" && !await CheckPlayer(bp)) return;\n${TEST_HOLD}`);
  const end = called.lastIndexOf(TEST_END);
  return called.slice(0, end) + "\n" + pickBlocks(part, playerFlags(settings)).replace(/\n+$/, "") + "\n" + called.slice(end);
}

/** The test's .asmdef of a game with players: it also sees the game's own assembly (the character) and the replication library. */
export function testAsmdefWithPlayer(base) {
  for (const needle of [ASMDEF_REFS, ASMDEF_PRECOMPILED]) if (!base.includes(needle)) throw new Error("OneLobbyGame.Tests.asmdef: a place for the player references moved");
  return base
    .replace(ASMDEF_REFS, () => '"references": ["OneLobby.Unity", "OneLobbyGame", "UnityEngine.TestRunner", "UnityEditor.TestRunner"],')
    .replace(ASMDEF_PRECOMPILED, () => '"precompiledReferences": ["nunit.framework.dll", "OneLobby.Core.dll", "OneLobby.Direct.dll", "OneLobby.Replication.dll"],');
}

/** AGENTS.md of a game with players: the bullets for the game script, the character and the check. */
export function agentsWithPlayer(agents, { authority, space }) {
  const bootEnd = 'Yours to edit. The menu doc: docs/recipes/menu.md in the OneLobby repo ("Unity").\n';
  const bootTail = "  Start your game in that handler; end it on `ReturnedToLobby` or `Left`. It logs";
  const testTail = "host, join by address, one message each way.\n";
  const testRefs = "(it references `OneLobby.Unity` and the package's `OneLobby.Core.dll`\n  and `OneLobby.Direct.dll`)";
  for (const needle of [bootEnd, bootTail, testTail, testRefs]) if (!agents.includes(needle)) throw new Error("AGENTS.md: a place for the player lines moved");
  const what = authority === "host" ? 'the host places every player (`sync.player.authority` "host": `GamePlayer.cs` gives the component `SetInput()` and one pure `Step()`)' : "each player's own PC places its player (`sync.player.authority` \"owner\": `GamePlayer.cs` moves the character as in any single-player game)";
  return agents
    .replace(bootTail, () => "  On `GameStarted` it opens `Game` (below) and ends it on `ReturnedToLobby` or `Left`. It logs")
    .replace(testRefs, () => "(it references `OneLobby.Unity`, `OneLobbyGame` and the package's `OneLobby.Core.dll`,\n  `OneLobby.Direct.dll` and `OneLobby.Replication.dll`)")
    .replace(bootEnd, () =>
      bootEnd +
      [
        `- \`Assets/Scripts/Game.cs\`: the game (${space === "2d" ? "a floor and an orthographic camera" : "a floor, a light and a camera"}, built in code) and an \`OneLobbyNetPlayerSpawner\`: one character per player, created and removed as players come and go. Yours to edit.`,
        `- \`Assets/Scripts/GamePlayer.cs\`: the character (${space === "2d" ? "a square, side-on" : "a capsule"}, made in code) with a \`OneLobbyNetPlayer\` component; ${what}. Arrow keys or WASD move it and space jumps. Yours to edit: \`update\` never rewrites it.`,
        "- `Assets/Scripts/OneLobbyGame.asmdef`: the game's own assembly, so the play-mode test can use `GamePlayer`. Code of yours that the game scripts need goes in this folder or lists `OneLobbyGame` in its references.",
        "",
      ].join("\n"),
    )
    .replace(testTail, () => "host, join by address, one message each way, then the networked player, both ways: the joiner's player appears on the host, follows the joiner, and one jump arrives once, then the host's player does the same on the joiner (`GamePlayer` is used as it is; one `MULTIPLAYER_PLAYER` line each). Two built players run with `--local --autostart` start the match by themselves (no click), walk their player and log a `MULTIPLAYER_PLAYER` line when they see the other's move (`Boot.cs`, `Game.cs`).\n");
}

/** `--into` with players on: the lines that add a spawner (nothing is written into the game's own scenes or scripts). `players`: { authority, space }. */
export function netPlayerLines({ authority, space }) {
  return [
    `players in the world (sync.player is on): add a spawner where your game starts, with your character (an object with a OneLobbyNetPlayer on it${authority === "host" ? ", driven by SetInput() and a step function" : ", moved as you always did"}):`,
    "  var spawner = gameObject.AddComponent<OneLobbyNetPlayerSpawner>(); spawner.Prefab = myCharacter;   // or spawner.Factory = peer => MakeCharacter(peer): code that returns an object with the component",
    `  ${authority === "host" ? "spawner.Step = MyCharacter.Step; // your pure (state, input, dt) => state\n  " : ""}spawner.Begin(lobby, menu.Client!.Blueprint);   // lobby: the menu's GameStarted lobby; one character per player appears and goes by itself (${space === "2d" ? "also spawner.SpawnPoint; positions use x and y" : "optionally spawner.SpawnPoint"}; docs/recipes/net-player.md section 12)`,
    "  (your own .asmdef needs OneLobby.Unity in references and OneLobby.Replication.dll in precompiledReferences)",
  ];
}

// ---- planning -------------------------------------------------------------------------------------------------------------

/** The menu lines a game with its own start-up adds (--into writes no boot script that would put a menu into it). */
export const MENU_LINES = [
  "using OneLobby.Unity;",
  'var menu = new GameObject("Menu").AddComponent<OneLobbyMenu>();   // in your start-up code, once',
  "menu.GameStarted += lobby => { /* start the match; the menu hid itself */ };  menu.ReturnedToLobby += _ => { /* end it */ };  menu.Left += () => { /* end it */ };",
];

/**
 * Work out everything a run would do, writing nothing. Returns
 * { files: [{ path, content, action }], notes, manifest, package, editor, slug } where action is create | update | overwrite | unchanged | skip.
 * Throws before anything is written when the plan cannot work (a manifest it cannot edit, a tarball that is not there).
 */
export function planUnity({ into, target, dirName, blueprint, opts, cwd, editor, netPlayer = null }) {
  const title = blueprint.game.title ?? dirName;
  const slug = slugOf(dirName);
  const abs = (p) => join(target, ...p.split("/"));
  const notes = [];
  const ref = packageRef({ opts, target, cwd });
  const vars = { title: title.replace(/[\r\n]+/g, " "), recipeUrl: UNITY_RECIPE_URL, schemaUrl: SCHEMA_URL, packageRef: ref.value, slug, port: String(DEFAULT_DIRECT_PORT), exe: PLAYER_EXE, testAssembly: TEST_ASSEMBLY, build: BUILD_METHOD };
  const wanted = wantedDependencies({ ref, testFramework: editor.testFramework });

  const files = [];
  let manifestPlan;
  let existingRef = null; // --into: the package line the manifest already has, { value, exists } (exists: null for a non-file: reference)
  if (into) {
    const p = abs(MANIFEST_PATH);
    if (!existsSync(p)) throw new CliError("bad_manifest", `--into: ${target} has no ${MANIFEST_PATH}; open the project in Unity once (it writes that file), then run this again`);
    const text = readFileSync(p, "utf8");
    const r = addDependencies(text, wanted, MANIFEST_PATH);
    const mine = r.present.find((d) => d.name === PACKAGE_NAME);
    if (mine) notes.push(`${MANIFEST_PATH} already references ${PACKAGE_NAME} (${mine.value}); that line was left alone. To move it to this version run: npx create-onelobby update${mine.value.startsWith("file:") ? " --package-from <tarball>" : ""}`);
    manifestPlan = { file: MANIFEST_PATH, content: Buffer.from(r.text, "utf8"), action: r.changed ? "update" : "unchanged", added: r.added, present: r.present };
    if (mine) existingRef = { value: mine.value, exists: mine.value.startsWith("file:") ? existsSync(resolve(target, "Packages", mine.value.slice(5))) : null };
  } else {
    const content = Buffer.from(newManifest(wanted), "utf8");
    manifestPlan = { file: MANIFEST_PATH, content, action: existsSync(abs(MANIFEST_PATH)) ? (readFileSync(abs(MANIFEST_PATH)).equals(content) ? "unchanged" : opts.force ? "overwrite" : "skip") : "create", added: wanted.map((w) => w.name), present: [] };
  }

  const list = [{ path: BLUEPRINT_PATH, content: json(blueprint) }];
  // players in the world (sync.player): a new project gets the game, the character, its assembly and the check; --into only gets the printed lines
  const withPlayers = netPlayer !== null && !into;
  if (!into) {
    const agents = fill(read("AGENTS.md"), vars);
    list.push(
      { path: "ProjectSettings/ProjectVersion.txt", content: `m_EditorVersion: ${editor.version}\n${editor.revision ? `m_EditorVersionWithRevision: ${editor.version} (${editor.revision})\n` : ""}` },
      ...(withPlayers ? netPlayerFiles(netPlayer, read) : [{ path: "Assets/Scripts/Boot.cs", content: read("Boot.cs") }]),
      { path: "AGENTS.md", content: withPlayers ? agentsWithPlayer(agents, netPlayer) : agents },
    );
  }
  list.push(
    { path: "Assets/OneLobby/Tests/MultiplayerTests.cs", content: withPlayers ? multiplayerWithPlayer(read("tests/MultiplayerTests.cs"), read("net-player", "multiplayer_part.cs"), netPlayer) : read("tests/MultiplayerTests.cs") },
    { path: "Assets/OneLobby/Tests/OneLobbyGame.Tests.asmdef", content: withPlayers ? testAsmdefWithPlayer(read("tests/OneLobbyGame.Tests.asmdef")) : read("tests/OneLobbyGame.Tests.asmdef") },
    { path: BUILD_FILE, content: read("editor/BuildPlayer.cs") },
  );
  // the play entry builds OneLobbyBuild.Windows and runs Builds/Windows/Game.exe: right for a new project, a guess for a game that already has its own build
  if (!into) list.push({ path: `.olc/${slug}.json`, content: olcEntry({ slug, title }) });
  for (const f of list) {
    const content = bytes(f.content);
    const p = abs(f.path);
    let action = "create";
    if (existsSync(p)) {
      if (statSync(p).isDirectory()) throw new CliError("exists", `${f.path} is a folder, expected a file`);
      action = readFileSync(p).equals(content) ? "unchanged" : opts.force ? "overwrite" : "skip";
    }
    files.push({ path: f.path, content, action });
  }
  files.push({ path: manifestPlan.file, content: manifestPlan.content, action: manifestPlan.action });

  // .gitignore and .gitattributes: a managed block, replaced in place or appended once
  for (const [path, lines, head] of [
    [".gitignore", UNITY_GITIGNORE_LINES, undefined],
    [".gitattributes", UNITY_GITATTRIBUTES_LINES, into ? undefined : "* text=auto\n"],
  ]) {
    const p = abs(path);
    const there = existsSync(p);
    const before = there ? readFileSync(p, "utf8") : head;
    const after = applyBlock(before, lines);
    files.push({ path, content: Buffer.from(after, "utf8"), action: there ? (after === before ? "unchanged" : "update") : "create" });
  }

  return {
    files,
    notes,
    manifest: { file: manifestPlan.file, added: manifestPlan.added, present: manifestPlan.present },
    package: { value: ref.value, from: ref.from, version: ref.version, existing: existingRef },
    editor,
    slug,
    netPlayer,
  };
}

/** Write a plan: the files that are create / update / overwrite. */
export function applyUnity(plan, { target }) {
  for (const f of plan.files) {
    if (f.action !== "create" && f.action !== "update" && f.action !== "overwrite") continue;
    const p = join(target, ...f.path.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }
}

/** The `next` lines for the printed result. */
export function unityNext({ into, rel, plan, titleFromFolder = false }) {
  const players = plan.netPlayer ?? null;
  const next = [];
  if (rel !== ".") next.push(`cd ${rel}`);
  const existing = plan.package.existing;
  if (existing && existing.exists === false) next.push(`the manifest already references ${existing.value} but no such file is in Packages/: put the tarball there or run: npx create-onelobby update --package-from <tarball>`);
  else if (plan.package.from === "default" && !existing) next.push(`put the package tarball next to the manifest: Packages/${defaultTarball()} (the package is not on a registry yet: build it with clients/unity/build-unity-package.sh --pack, or take the unity-dev-package CI artifact; or rerun with --package-from <tarball>)`);
  if (titleFromFolder) next.push(`game.title in ${BLUEPRINT_PATH} came from the folder name: set the game's own name (edit the file, or pass --title "<name>" on the first run)`);
  if (into) {
    next.push(
      `no .olc entry was written: the one a new project gets builds ${BUILD_METHOD} and runs ${PLAYER_EXE}, which an existing project may not have; point your own entry at the game's own build and add --host --local / --join=127.0.0.1:${DEFAULT_DIRECT_PORT} --local to its command`,
      "add the menu to your start-up code (one line, where your game starts; nothing was added to your scenes or settings):",
      ...MENU_LINES.map((l) => `  ${l}`),
      `the blueprint is ${BLUEPRINT_PATH}: change choices there`,
      ...(players ? netPlayerLines(players) : []),
      `unity-batchmode: Unity -batchmode -nographics -projectPath . -runTests -testPlatform PlayMode -assemblyNames ${TEST_ASSEMBLY} -testResults <abs>/tests.xml -logFile <abs>/tests.log --local   # expect MULTIPLAYER_OK in the log`,
      `build the Windows player: Unity -batchmode -nographics -quit -projectPath . -logFile .onelobby/build.log -executeMethod ${BUILD_METHOD}   # ${PLAYER_EXE}`,
      `try it on this PC only: ${PLAYER_EXE} --host --local --name=Sam   (a second window: --join=127.0.0.1:${DEFAULT_DIRECT_PORT} --local --name=Ann); --local is 127.0.0.1 only, no Nostr, so never run --host without it`,
      `check it: npx create-onelobby verify   # one VERIFY_OK or VERIFY_FAIL line`,
      `follow ${UNITY_RECIPE_URL}`,
    );
  } else {
    next.push(
      `npx create-onelobby verify   # opens the project in batchmode (the first time also imports it), then VERIFY_OK`,
      `play: ${PLAYER_EXE} --host --local --name=Sam   # after building it (see AGENTS.md), or run the .olc entry`,
      `recipe: ${UNITY_RECIPE_URL}`,
    );
  }
  return next;
}

/** The whole unity run after the answers are known. Returns the exit code. `ctx`: { io, opts, blueprint, target, dirName, into, gitInit, recommendation }. */
export async function runUnity(ctx) {
  const { io, opts, blueprint, target, dirName, into } = ctx;
  if (into) {
    if (!existsSync(join(target, "ProjectSettings", "ProjectVersion.txt")) && !(existsSync(join(target, "ProjectSettings")) && existsSync(join(target, "Assets"))))
      throw new CliError("not_unity_project", `--into: ${target} has no ProjectSettings/ProjectVersion.txt; run this inside a Unity project folder (the one holding Assets/ and ProjectSettings/), or drop --into to make a new one`);
  } else {
    const state = targetState(target);
    if (state === "file") throw new CliError("exists", `${target} is a file`);
    if (state === "full" && !opts.force) throw new CliError("dir_not_empty", `${target} is not empty (use --force to write into it anyway)`);
  }
  const editor = chooseEditor({ opts, env: io.env, resolve: io.resolveUnity });
  const netPlayer = resolveNetPlayer({ wanted: ctx.netPlayer === true, blueprint, target, into, force: opts.force, blueprintPath: BLUEPRINT_PATH });
  const plan = planUnity({ into, target, dirName, blueprint, opts, cwd: io.cwd, editor, netPlayer });
  const rel = relative(io.cwd, target) || ".";
  const listed = plan.files.filter((f) => f.action === "create" || f.action === "update" || f.action === "overwrite");
  const skipped = plan.files.filter((f) => f.action === "skip").map((f) => f.path);
  const unchanged = plan.files.filter((f) => f.action === "unchanged").map((f) => f.path);
  const wouldChange = listed.length > 0;
  const next = unityNext({ into, rel, plan, titleFromFolder: blueprint.game.title === dirName });
  const result = {
    ok: true,
    dir: target,
    template: "unity",
    blueprint,
    files: listed.map((f) => f.path),
    skipped,
    unchanged: unchanged.length,
    package: plan.package,
    manifest: plan.manifest,
    ...(into ? {} : { editor: { version: plan.editor.version, from: plan.editor.from } }),
    ...(netPlayer ? { netPlayer } : {}),
    notes: plan.notes,
    changed: wouldChange,
    next,
  };
  const recommendation = ctx.recommendation && keepOnelobbyJson(ctx.recommendation, plan.files.find((f) => f.path === BLUEPRINT_PATH)?.action === "skip");
  if (recommendation) result.recommendation = recommendation.json;
  const fromRec = recommendation ? `\n\n${recommendation.text}` : "";
  const text = (verb) => {
    const out = [];
    if (!wouldChange) out.push(`Nothing changed: ${target} already has everything (${unchanged.length} files unchanged).`);
    else out.push(`${verb} ${target}`, ...listed.map((f) => `  ${f.path}${f.action === "create" ? "" : ` (${f.action})`}`));
    if (plan.manifest.added.length && listed.some((f) => f.path === plan.manifest.file)) out.push(`  ${plan.manifest.file}: dependencies ${into ? "added" : "written"}: ${plan.manifest.added.join(", ")}`);
    if (skipped.length) out.push("Skipped (already exist and differ; use --force to overwrite):", ...skipped.map((p) => `  ${p}`));
    if (!into) out.push(`Unity ${plan.editor.version} (${plan.editor.from === "default" ? `the default: ${plan.editor.why}` : `from the editor at ${plan.editor.from}`}); package ${plan.package.value} (${plan.package.from === "tarball" ? "the tarball named by --package-from" : "the release tarball, to be put in Packages/"}).`);
    for (const n of plan.notes) out.push(`Note: ${n}`);
    return out.join("\n");
  };

  if (opts.dryRun) {
    result.dryRun = true;
    if (opts.json) io.stdout.write(JSON.stringify(result) + "\n");
    else io.stdout.write(`Dry run: nothing written.\n${text(into ? "Would add to" : "Would create")}\n\n${BLUEPRINT_PATH}:\n${JSON.stringify(blueprint, null, 2)}${fromRec}\n\nNext:\n${next.map((n) => `  ${n}`).join("\n")}\n`);
    return 0;
  }

  applyUnity(plan, { target });
  if (!into && !opts.noGit && ctx.gitInit) ctx.gitInit(target);
  if (opts.json) io.stdout.write(JSON.stringify(result) + "\n");
  else io.stdout.write(`${text(into ? "Added to" : "Created")}${fromRec}\n\nNext:\n${next.map((n) => `  ${n}`).join("\n")}\n`);
  return 0;
}
