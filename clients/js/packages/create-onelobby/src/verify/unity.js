// The checks `verify` runs for a Unity game, in the same order and words as the Godot ones where they apply:
//   unity, package, blueprint, wiring, direct, nostr, turn, server
// Everything is loopback (127.0.0.1) and headless (-batchmode -nographics).
//
// How the routes run inside the game: Unity code only runs inside the game's own project, so the scaffolder writes
// Assets/OneLobby/Tests/MultiplayerTests.cs (a play-mode test with its .asmdef) that takes the route as arguments after Unity's own
// (--route=config|direct|nostr|turn|server, --relay, --turn, --server: Unity ignores arguments it does not know, the test reads them from
// Environment.GetCommandLineArgs), and verify runs that test with `-runTests -testPlatform PlayMode`. Why not -executeMethod: it runs in edit
// mode, and the menu and the transport are meant to run in play mode with a player loop. An --into game gets the same files from
// `npx create-onelobby --into .`; a game that lacks them fails the checks that need them with that command as the next step.
//
// What it writes: .onelobby/ (the Unity logs and test results; gitignored) and what Unity itself writes into the project when it opens it:
// Library/, Temp/, Logs/, UserSettings/, obj/, Packages/packages-lock.json, ProjectSettings/ files, and .meta files beside the assets.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tgzNames } from "../tar.js";
import { validate } from "../blueprint.js";
import { MIN_EDITOR, TEST_ASSEMBLY, TEST_FILES, editorIsNewEnough, resolveUnity } from "../unity.js";
import { PACKAGE_NAME, readDependency } from "../manifest.js";
import { run } from "./procs.js";
import { startRelay } from "./relay.js";
import { fetchCommand, fetchTurnHelper, findTurnHelper, startTurn } from "./turn.js";
import { testLine } from "./csharp.js";
import { blueprintNext, wiringCheck } from "./wiring.js";

const UNITY_FLAGS = ["-batchmode", "-nographics"];
const NO_UNITY = `Pass --unity <path to Unity.exe, 6000.0 or newer>, set the UNITY environment variable, or install an editor with the Unity Hub (its default folder is searched), then rerun.`;
const MISSING_TEST = "Assets/OneLobby/Tests/MultiplayerTests.cs / .asmdef is missing (verify runs its routes through that test: the game's own project is the only place Unity code can run).";
const MISSING_TEST_NEXT = "Run: npx create-onelobby --into . (it writes the test and the build script and changes nothing else).";
const hasTest = (dir) => TEST_FILES.every((f) => existsSync(join(dir, ...f.split("/"))));
const read = (p) => readFileSync(p, "utf8");
const secs = (ms) => (ms / 1000).toFixed(0);
/** The note for a test run that passed and then ended with a non-zero exit code (Windows codes also in hex: 3221225477 is 0xC0000005). */
export const exitWarning = (code) =>
  `the test passed, then Unity ended with exit code ${code}${code > 255 ? ` (0x${code.toString(16).toUpperCase()})` : ""} while it closed${code === 3221225477 ? " (known on Windows after a process used the WebRTC library; the result stands)" : ""}`;

/** Where the Windows WebRTC library sits in the package: without it two peers on Windows never link. */
export const WIN_LIBRARY = "Runtime/Plugins/x86_64/datachannel.dll";
const LIBRARY_NEXT = (shown) =>
  `Use a package that has it: a release tarball or the unity-dev-package CI artifact. In a OneLobby clone: clients/unity/fetch-natives.sh, then clients/unity/build-unity-package.sh --pack, and put the new tarball at ${shown} (docs/recipes/unity.md, "Getting the package").`;

/**
 * Does the game's com.onelobby.unity package hold the Windows WebRTC library? `ref`: the manifest's reference. Returns
 * { has: true|false|null, what } (null: cannot tell, for example a registry package Unity has not unpacked yet).
 * A `file:` tarball is listed, a `file:` folder is looked into, anything else is looked for in Library/PackageCache.
 */
export function packageHasWindowsLibrary(dir, ref) {
  const file = /^file:(.+)$/i.exec(ref)?.[1];
  if (file) {
    const path = isAbsolute(file) ? file : resolve(dir, "Packages", file);
    if (!existsSync(path)) return { has: null, what: file };
    if (statSync(path).isDirectory()) return { has: existsSync(join(path, ...WIN_LIBRARY.split("/"))), what: file };
    try {
      return { has: tgzNames(readFileSync(path)).some((n) => n.endsWith(`/${WIN_LIBRARY}`)), what: file };
    } catch {
      return { has: null, what: file };
    }
  }
  const cache = join(dir, "Library", "PackageCache");
  const hit = existsSync(cache) ? readdirSync(cache).find((d) => d.startsWith("com.onelobby.unity@")) : undefined;
  return hit ? { has: existsSync(join(cache, hit, ...WIN_LIBRARY.split("/"))), what: ref } : { has: null, what: ref };
}

/** The line of a Unity log that names the error: the first compiler error (`Assets/x.cs(3,4): error CS...`), else the last line that names one; shortened. */
export function lastError(log) {
  const all = log.split(/\r?\n/);
  const compiler = all.find((l) => /error CS\d+/.test(l));
  const lines = all.filter((l) => /^error |Exception:|An error occurred|Scripts have compiler errors|Unable to resolve|Failed to resolve/i.test(l));
  return (compiler ?? lines.slice(-1)[0] ?? "no error text").trim().replace(/\.$/, "").slice(0, 220);
}

/** The project's editor version from ProjectSettings/ProjectVersion.txt, or undefined. */
export function projectEditorVersion(dir) {
  try {
    return /^m_EditorVersion:\s*(\S+)/m.exec(read(join(dir, "ProjectSettings", "ProjectVersion.txt")))?.[1];
  } catch {
    return undefined;
  }
}

/** The checks for a Unity game, in order. `ctx`: { dir, opts, env, services, unity, facts, run? }. */
export function unityChecks() {
  const exec = (ctx, ...a) => (ctx.run ?? run)(...a); // ctx.run: a test seam (fake processes)
  const logDir = (ctx) => {
    mkdirSync(join(ctx.dir, ".onelobby"), { recursive: true });
    return join(ctx.dir, ".onelobby");
  };
  const facts = (ctx) => ctx.facts ?? {};
  const logText = (path) => (existsSync(path) ? read(path) : "");
  /** One headless Unity run on the game's project; resolves { r, log }. The log goes to an absolute path (a relative one lands in the project). */
  const u = async (ctx, name, extra, o) => {
    const log = join(logDir(ctx), `unity-${name}.log`);
    const r = await exec(ctx, ctx.unity.exe, [...UNITY_FLAGS, "-projectPath", ctx.dir, "-logFile", log, ...extra], { cwd: ctx.dir, ...o });
    return { r, log: ctx.readLog ? ctx.readLog(log) : logText(log) };
  };
  const routeByHand = (route, more = "") => `Rerun that route by hand: Unity -batchmode -nographics -projectPath . -runTests -testPlatform PlayMode -assemblyNames ${TEST_ASSEMBLY} -testResults <abs>.xml -logFile <abs>.log --local --route=${route}${more}`;
  // `--local` rides along on every test run: a menu the game's own start-up opens while the test plays reads it and stays on 127.0.0.1
  // (no connection check against the internet). The test's own two clients are loopback-only whatever the flags say.
  const runRoute = async (ctx, route, args, timeoutMs = 300000) => {
    const results = join(logDir(ctx), `tests-${route}.xml`);
    const { r, log } = await u(ctx, route, ["-runTests", "-testPlatform", "PlayMode", "-assemblyNames", TEST_ASSEMBLY, "-testResults", results, "--local", `--route=${route}`, ...args], { timeoutMs });
    return { r, log, line: testLine(log, route) };
  };
  const routeResult = ({ r, log, line }, next) => {
    // the result line decides. Unity's exit code is only reported: on Windows a process that used the WebRTC library ends with 0xC0000005 while it
    // closes (tools/engine-smoke/README.md, "Findings": the library's threads are still alive), after the test passed and its results file was written
    if (line?.ok && !r.timedOut) return { status: "ok", detail: line.detail || undefined, ...(r.code ? { warning: exitWarning(r.code) } : {}) };
    const why = r.timedOut ? "the Unity process did not finish in time" : line ? line.why : `Unity exited ${r.code} without a result line (${lastError(log)})`;
    return { status: "fail", detail: why, next };
  };
  const warn = (res) => (res.warning ? { warning: res.warning } : {});
  const needTest = (ctx) => (hasTest(ctx.dir) ? null : { status: "fail", detail: MISSING_TEST, next: MISSING_TEST_NEXT });

  return [
    {
      name: "unity",
      blocking: true,
      async run(ctx) {
        const want = projectEditorVersion(ctx.dir);
        const found = (ctx.resolveUnity ?? resolveUnity)({ flag: ctx.opts.unity, env: ctx.env, wantVersion: want });
        if (!found) return { status: "fail", detail: "no Unity editor found (looked at --unity, $UNITY and the Unity Hub's default folder).", next: NO_UNITY };
        if (found.missing) return { status: "fail", detail: `${found.from} names ${found.missing}, which does not exist.`, next: NO_UNITY };
        if (!found.version) return { status: "fail", detail: `${found.exe} is a file, but its version cannot be read.`, next: NO_UNITY };
        if (!editorIsNewEnough(found.version)) return { status: "fail", detail: `Unity ${found.version} is older than ${MIN_EDITOR}, which com.onelobby.unity needs.`, next: `Use Unity ${MIN_EDITOR} or newer (--unity, $UNITY or the Hub).` };
        ctx.unity = { exe: found.exe, version: found.version, from: found.from };
        const warning = want && want !== found.version ? `the project was last saved with Unity ${want} and this editor is ${found.version}; Unity may upgrade the project files (commit the result) or warn` : undefined;
        return { status: "ok", detail: `Unity ${found.version}, from ${found.from}`, ...(warning ? { warning } : {}) };
      },
    },
    {
      name: "package",
      blocking: true,
      async run(ctx) {
        const manifest = join(ctx.dir, "Packages", "manifest.json");
        if (!existsSync(manifest)) return { status: "fail", detail: "Packages/manifest.json is missing.", next: "Open the project in Unity once, then run: npx create-onelobby --into ." };
        let ref;
        try {
          ref = readDependency(read(manifest), PACKAGE_NAME, "Packages/manifest.json");
        } catch (e) {
          return { status: "fail", detail: e.message, next: "Fix Packages/manifest.json (it must be valid JSON with a dependencies object)." };
        }
        if (ref === null) return { status: "fail", detail: `Packages/manifest.json does not reference ${PACKAGE_NAME}.`, next: "Run: npx create-onelobby --into . (add --package-from <tarball> until the package is released)." };
        const file = /^file:(.+\.(?:tgz|tar\.gz))$/i.exec(ref)?.[1];
        if (file && !/^[a-z]:|^[/\\]/i.test(file) && !existsSync(join(ctx.dir, "Packages", file)))
          return { status: "fail", detail: `Packages/manifest.json references ${ref}, but Packages/${file} is not there.`, next: `Put the tarball there (clients/unity/build-unity-package.sh --pack, or the unity-dev-package CI artifact), or run: npx create-onelobby update --package-from <tarball>.` };
        // before the minutes of opening the project: a tarball (or folder) with no Windows WebRTC library can only fail later as "never linked"
        const winOnly = (ctx.platform ?? process.platform) === "win32";
        const before = winOnly && file ? packageHasWindowsLibrary(ctx.dir, ref) : null;
        if (before?.has === false)
          return { status: "fail", detail: `${before.what} has no ${WIN_LIBRARY} (the Windows WebRTC library): on Windows the two peers would never link.`, next: LIBRARY_NEXT(`Packages/${file}`) };
        const t0 = Date.now();
        const { r, log } = await u(ctx, "import", ["-quit"], { timeoutMs: 900000 });
        const lock = join(ctx.dir, "Packages", "packages-lock.json");
        let resolved = null;
        try {
          resolved = JSON.parse(read(lock)).dependencies?.[PACKAGE_NAME] ?? null;
        } catch {
          /* no lock: Unity did not get as far as resolving */
        }
        const compile = /error CS\d+/.test(log);
        const after = winOnly && !file && resolved ? packageHasWindowsLibrary(ctx.dir, ref) : null;
        if (after?.has === false)
          return { status: "fail", detail: `the package Unity resolved (${after.what}) has no ${WIN_LIBRARY} (the Windows WebRTC library): on Windows the two peers would never link.`, next: LIBRARY_NEXT("Packages/ (a file: tarball in Packages/manifest.json)") };
        if (r.code === 0 && !r.timedOut && resolved && !compile)
          return { status: "ok", detail: `${ref}; Unity resolved ${PACKAGE_NAME}${resolved.version && resolved.version !== ref ? ` ${resolved.version}` : ""} (${resolved.source ?? "unknown source"}) and opened the project in ${secs(Date.now() - t0)} s` };
        const registry = /Unable to resolve|Failed to resolve|An error occurred while resolving packages/i.test(log) || !resolved;
        return {
          status: "fail",
          detail: `Unity ${r.timedOut ? "did not finish opening the project in time" : `exited ${r.code}`}${resolved ? "" : " without resolving the package"}${compile ? " with script errors" : ""}: ${lastError(log)}.`,
          next: compile ? "Fix the compile errors named in .onelobby/unity-import.log (a game script that references OneLobby from its own .asmdef must list \"OneLobby.Unity\")." : registry ? `Check that ${ref} points at a real tarball and read .onelobby/unity-import.log; is this project open in the Unity editor already?` : "Read .onelobby/unity-import.log.",
        };
      },
    },
    {
      name: "blueprint",
      blocking: true,
      async run(ctx) {
        let json;
        try {
          json = JSON.parse(read(join(ctx.dir, "Assets", "Resources", "onelobby.json")));
        } catch (e) {
          return { status: "fail", detail: `Assets/Resources/onelobby.json is not valid JSON (${e.message}).`, next: "Fix the file (its $schema line lists every key)." };
        }
        let bp;
        try {
          bp = await validate(json);
        } catch (e) {
          return { status: "fail", detail: `onelobby.json does not load: ${e.message}${e.path ? ` (at ${e.path})` : ""}.`, next: blueprintNext(e.path, `Fix ${e.path ?? "that key"} in Assets/Resources/onelobby.json (the schema describes it).`) };
        }
        ctx.facts = { direct: bp.hosting.direct, nostr: bp.hosting.nostr, server: bp.hosting.server, relayOnly: bp.hosting.relayOnly, mode: bp.sync.mode };
        const base = `mode ${bp.sync.mode}, direct ${bp.hosting.direct}, nostr ${bp.hosting.nostr}, server ${bp.hosting.server}`;
        if (!hasTest(ctx.dir)) return { status: "ok", detail: `${base}; loads in JS`, warning: `the C# loader was not run (${MISSING_TEST}) ${MISSING_TEST_NEXT}` };
        // the same file through the game's own C# loader (Blueprint.Parse), which adds the rules only C# has
        const res = routeResult(await runRoute(ctx, "config", []), "Fix onelobby.json so the C# loader accepts it (the message names the key).");
        if (res.status !== "ok") return { ...res, detail: `the C# loader refused onelobby.json: ${res.detail}.` };
        return { status: "ok", detail: `${base}; loads in JS and in C#`, ...warn(res) };
      },
    },
    wiringCheck(),
    {
      name: "direct",
      async run(ctx) {
        const f = facts(ctx);
        if (!f.direct) return { status: "skipped", detail: "hosting.direct is false in onelobby.json (the game hosts through a lobby server only)" };
        const missing = needTest(ctx);
        if (missing) return missing;
        const res = routeResult(await runRoute(ctx, "direct", []), `Run the test by hand (${routeByHand("direct")}) and read its log; check that nothing blocks Unity on 127.0.0.1.`);
        return res.status === "ok" ? { status: "ok", detail: "two peers on 127.0.0.1, host and join by address, one message each way: the game's MultiplayerTests", ...warn(res) } : { ...res, detail: `two peers on 127.0.0.1 did not connect: ${res.detail}.` };
      },
    },
    {
      name: "nostr",
      async run(ctx) {
        const f = facts(ctx);
        if (!f.direct) return { status: "skipped", detail: "hosting.direct is false in onelobby.json" };
        if (!f.nostr) return { status: "skipped", detail: "hosting.nostr is false in onelobby.json (join codes are IP codes, no Nostr relay is involved)" };
        const missing = needTest(ctx);
        if (missing) return missing;
        const relay = (ctx.services.relay ??= await startRelay());
        const before = relay.stats.events;
        const res = routeResult(await runRoute(ctx, "nostr", [`--relay=${relay.url}`]), `Check hosting.nostr and hosting.nostrRelays in onelobby.json, and that nothing blocks Unity on 127.0.0.1. ${routeByHand("nostr", " --relay=<a local relay>")}`);
        if (res.status !== "ok") return { ...res, detail: `two peers through a local Nostr relay on 127.0.0.1 did not connect: ${res.detail}.` };
        if (relay.stats.events <= before) return { status: "fail", detail: "the peers connected but the local Nostr relay saw no signaling events, so the Nostr path was not used.", next: "Check that hosting.nostr is on and the game does not pin hosting.nostrRelays elsewhere." };
        return { status: "ok", detail: `two peers through a local Nostr relay on ${relay.url.replace("ws://", "")}: ${relay.stats.events - before} signaling events`, ...warn(res) };
      },
    },
    {
      name: "turn",
      async run(ctx) {
        const f = facts(ctx);
        if (!f.direct) return { status: "skipped", detail: "hosting.direct is false in onelobby.json" };
        const missing = needTest(ctx);
        let base = findTurnHelper(ctx.dir);
        if (!base && ctx.opts.fetchHelpers) {
          const got = await fetchTurnHelper(ctx.dir);
          if (!got.ok) return { status: "skipped", detail: `the TURN helper (npm node-turn) could not be fetched (${got.out || "no output"}); offline? When online run: ${fetchCommand(ctx.dir)}` };
          base = findTurnHelper(ctx.dir);
        }
        if (!base) return { status: "skipped", detail: `the local TURN helper (npm node-turn) is not available (run: npx create-onelobby verify --fetch-helpers, or: ${fetchCommand(ctx.dir)})` };
        if (missing) return missing;
        const turn = await startTurn(base);
        try {
          const relay = f.nostr ? (ctx.services.relay ??= await startRelay()) : null;
          const args = [`--turn=${turn.line}`, ...(relay ? [`--relay=${relay.url}`] : [])];
          const res = routeResult(await runRoute(ctx, "turn", args), "The relay-only path failed against a local TURN server: check hosting.relayOnly and the game's TURN settings, and that nothing blocks Unity's UDP on 127.0.0.1.");
          if (res.status !== "ok") return { ...res, detail: `relay-only through a local TURN server on 127.0.0.1 did not connect: ${res.detail}.` };
          // the Unity process has already exited: this server may still be reading its last packets
          for (let i = 0; i < 30 && (turn.stats.allocations < 1 || turn.stats.relayed < 1); i++) await new Promise((r) => setTimeout(r, 100));
          if (turn.stats.allocations < 1 || turn.stats.relayed < 1) {
            return {
              status: "fail",
              detail: `the peers connected, but the TURN server saw ${turn.stats.allocations} allocations and ${turn.stats.relayed} relayed packets, so the relay was not used: the game's links are not relay-only (players' addresses are exposed to each other).`,
              next: "Check that the game builds its client over UnityTransport from a current com.onelobby.unity (run: npx create-onelobby update) and that no other transport carries the game's traffic. " + routeByHand("turn", " --turn=<login line>"),
            };
          }
          return { status: "ok", detail: `relay-only through a local TURN server on 127.0.0.1:${turn.port}, login pasted as one line: ${turn.stats.allocations} allocations, ${turn.stats.relayed} relayed packets`, ...warn(res) };
        } finally {
          await turn.close();
        }
      },
    },
    {
      name: "server",
      async run(ctx) {
        const f = facts(ctx);
        if (!f.server) return { status: "skipped", detail: "hosting.server is false in onelobby.json (the game does not use a lobby server)" };
        const url = ctx.opts.server;
        if (url === undefined) return { status: "skipped", detail: "hosting.server is true but no --server http://127.0.0.1:<port> was given (verify never starts the lobby server; start one on this machine and pass its address)" };
        let uu;
        try {
          uu = new URL(url.replace(/^ws/, "http"));
        } catch {
          return { status: "fail", detail: `--server ${url} is not a URL.`, next: "Pass something like --server http://127.0.0.1:8080" };
        }
        if (uu.hostname !== "127.0.0.1") return { status: "fail", detail: `--server ${url} is not on 127.0.0.1; verify only talks to this machine.`, next: "Start the lobby server on 127.0.0.1 and pass that address." };
        const port = uu.port || "80";
        try {
          const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (e) {
          return { status: "fail", detail: `no lobby server answers at http://127.0.0.1:${port}/healthz (${e?.cause?.code ?? e?.message}).`, next: "Start it (for example: dotnet run --project server/OneLobby.Server -- --listen 127.0.0.1:8080) and rerun." };
        }
        const missing = needTest(ctx);
        if (missing) return missing;
        const wsUrl = `ws://127.0.0.1:${port}${uu.pathname.length > 1 ? uu.pathname : "/ws"}`;
        const res = routeResult(await runRoute(ctx, "server", [`--server=${wsUrl}`]), `Check hosting.lobbyServer and netVersion, and the server's log. ${routeByHand("server", " --server=<ws url>")}`);
        return res.status === "ok" ? { status: "ok", detail: `host and join by code through the lobby server at ${wsUrl}`, ...warn(res) } : { ...res, detail: `the lobby-server route failed: ${res.detail}.` };
      },
    },
  ];
}
