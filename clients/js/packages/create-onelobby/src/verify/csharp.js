// The checks `verify` runs for a godot-csharp game, in the same order and words as the GDScript ones where they apply:
//   godot, dotnet, menu-pin, natives, blueprint, direct, nostr, turn, server
// Everything is loopback (127.0.0.1) and headless (--headless --audio-driver Dummy).
//
// How the routes run inside the game: a C# game's code only runs from the game's own assembly, and MSBuild leaves folders that
// start with a dot out of the build, so a probe dropped into <game>/.onelobby/ (how the GDScript checks work) would never be
// compiled. So the scaffolder writes tests/MultiplayerTest.cs (+ .tscn), a scene that takes the route as arguments after `--`
// (--route=config|direct|nostr|turn|server, --relay, --turn, --server), and verify runs that scene. An --into game gets the same
// file from `npx create-onelobby --into .`; a game that lacks it fails the checks that need it with that command as the next step.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "../blueprint.js";
import { buildCommand, selectCsproj } from "../csharp.js";
import { MENU_DIR, NATIVES_MARKER, verifyPin } from "../vendor.js";
import { resolveGodot } from "./godot.js";
import { run } from "./procs.js";
import { startRelay } from "./relay.js";
import { fetchCommand, fetchTurnHelper, findTurnHelper, startTurn } from "./turn.js";
import { blueprintNext, wiringCheck } from "./wiring.js";

const GODOT_FLAGS = ["--headless", "--audio-driver", "Dummy"];
export const TEST_SCENE = "res://tests/MultiplayerTest.tscn";
export const TEST_FILES = ["tests/MultiplayerTest.tscn", "tests/MultiplayerTest.cs"];
const NO_GODOT = "Pass --godot <path to the .NET build of Godot 4.5+>, set the GODOT environment variable, or put godot on PATH, then rerun.";
const DOWNLOAD = "https://godotengine.org/download (the .NET build, the one marked \".NET\" or \"mono\")";

const nonEmpty = (p) => existsSync(p);
const lastError = (out) => (out.split(/\r?\n/).filter((l) => /error/i.test(l)).slice(-1)[0] ?? "no error text").trim().replace(/^.*?[\\/]([^\\/]+\.cs\(\d+,\d+\))/, "$1").slice(0, 200);

/** A line `MULTIPLAYER_OK` (direct) or `MULTIPLAYER_OK <route> <detail>` in the test's output: { ok: true, detail } | { ok: false, why } | null. */
export function testLine(out, route) {
  const tag = route === "direct" ? "" : ` ${route}`;
  const ok = new RegExp(`^MULTIPLAYER_OK${tag}(?: ([^\\r\\n]*))?\\s*$`, "m").exec(out);
  if (ok) return { ok: true, detail: (ok[1] ?? "").trim() };
  const fail = new RegExp(`^MULTIPLAYER_FAIL${tag} ([^\\r\\n]*)`, "m").exec(out);
  return fail ? { ok: false, why: fail[1].trim() } : null;
}

const MISSING_TEST = "tests/MultiplayerTest.cs / .tscn is missing (verify runs its routes through that scene: the game's own assembly is the only place C# code can run).";
const MISSING_TEST_NEXT = "Run: npx create-onelobby --into . (it writes the test and changes nothing else), then dotnet build.";
const hasTest = (dir) => TEST_FILES.every((f) => existsSync(join(dir, ...f.split("/"))));

/** The checks for a godot-csharp game, in order. `ctx`: { dir, opts, env, services, godot, csproj, facts }. */
export function csharpChecks() {
  const exec = (ctx, ...a) => (ctx.run ?? run)(...a); // ctx.run: a test seam (fake processes)
  const g = (ctx, extra, o) => exec(ctx, ctx.godot.exe, [...GODOT_FLAGS, "--path", ctx.dir, ...extra], { cwd: ctx.dir, ...o });
  const facts = (ctx) => ctx.facts ?? {};
  const routeByHand = (route, more = "") => `Rerun that route by hand: dotnet build, then godot --headless --audio-driver Dummy --path . ${TEST_SCENE} -- --route=${route}${more}`;
  const runRoute = async (ctx, route, args, timeoutMs = 100000) => {
    const r = await g(ctx, [TEST_SCENE, "--", `--route=${route}`, ...args], { timeoutMs });
    return { r, line: testLine(r.out, route) };
  };
  const routeResult = ({ r, line }, next) => {
    if (line?.ok && !r.timedOut) return { status: "ok", detail: line.detail || undefined };
    const why = r.timedOut ? "the Godot process did not finish in time" : line ? line.why : `Godot exited ${r.code} without a result line (${lastError(r.out)})`;
    return { status: "fail", detail: why, next };
  };
  const needTest = (ctx) => (hasTest(ctx.dir) ? null : { status: "fail", detail: MISSING_TEST, next: MISSING_TEST_NEXT });

  return [
    {
      name: "godot",
      blocking: true,
      async run(ctx) {
        const found = resolveGodot({ flag: ctx.opts.godot, env: ctx.env });
        if (!found) return { status: "fail", detail: `no Godot executable found (looked at ${ctx.opts.godot !== undefined ? "--godot" : ctx.env.GODOT !== undefined ? "$GODOT" : "godot on PATH"}).`, next: NO_GODOT };
        const v = await exec(ctx, found.exe, ["--version"], { timeoutMs: 30000 });
        const text = v.out.trim().split(/\r?\n/).find((l) => /^\d+\.\d+/.test(l)) ?? v.out.trim().split(/\r?\n/)[0] ?? "";
        const m = /^(\d+)\.(\d+)[.\w-]*/.exec(text);
        if (v.code !== 0 || !m) return { status: "fail", detail: `${found.exe} did not answer --version like Godot (${(v.error ?? v.out.trim().slice(0, 80)) || "no output"}).`, next: NO_GODOT };
        if (Number(m[1]) < 4 || (Number(m[1]) === 4 && Number(m[2]) < 5)) return { status: "fail", detail: `Godot ${m[1]}.${m[2]} is older than 4.5 (OneLobby.Godot builds against GodotSharp 4.5).`, next: "Use the .NET build of Godot 4.5 or newer (--godot, $GODOT or PATH)." };
        if (!/\.mono\b/.test(text))
          return {
            status: "fail",
            detail: `${found.exe} is the standard build of Godot (${text}): it cannot run C# code.`,
            next: `Download the .NET build of the same version from ${DOWNLOAD} (on Windows Godot_v${m[1]}.${m[2]}${m[0].split(".").length > 2 ? `.${m[0].split(".")[2]}` : ""}-stable_mono_win64.zip, and use its _console.exe), then pass it with --godot, $GODOT or PATH.`,
          };
        ctx.godot = { exe: found.exe, version: text, from: found.from, major: Number(m[1]), minor: Number(m[2]) };
        let warning;
        try {
          const csproj = selectCsproj(ctx.dir, readFileSync(join(ctx.dir, "project.godot"), "utf8"));
          const sdk = /Godot\.NET\.Sdk\/(\d+)\.(\d+)/.exec(readFileSync(join(ctx.dir, csproj), "utf8"));
          if (sdk && (Number(sdk[1]) !== ctx.godot.major || Number(sdk[2]) !== ctx.godot.minor))
            warning = `${csproj} uses Godot.NET.Sdk ${sdk[1]}.${sdk[2]} and this Godot is ${ctx.godot.major}.${ctx.godot.minor}; the editor may refuse a game built against another version's GodotSharp`;
        } catch {
          /* the dotnet check says what is wrong with the project file */
        }
        return { status: "ok", detail: `${ctx.godot.version}, .NET build, from ${found.from}`, ...(warning ? { warning } : {}) };
      },
    },
    {
      name: "dotnet",
      blocking: true,
      async run(ctx) {
        const v = await exec(ctx, "dotnet", ["--version"], { timeoutMs: 60000, cwd: ctx.dir });
        const sdk = /^(\d+)\.(\d+)\.\d+[\w.+-]*/m.exec(v.out);
        if (v.code !== 0 || !sdk) return { status: "fail", detail: `no .NET SDK answers "dotnet --version" (${(v.error ?? v.out.trim().slice(0, 80)) || "no output"}).`, next: "Install the .NET 8 SDK or newer (https://dotnet.microsoft.com/download) and rerun." };
        if (Number(sdk[1]) < 8) return { status: "fail", detail: `the .NET SDK is ${sdk[0]}; Godot 4.5 and the OneLobby packages need 8 or newer.`, next: "Install the .NET 8 SDK or newer and rerun." };
        let csproj;
        try {
          csproj = selectCsproj(ctx.dir, readFileSync(join(ctx.dir, "project.godot"), "utf8"));
        } catch (e) {
          return { status: "fail", detail: e.message, next: "Create the C# solution in Godot (Project > Tools > C# > Create C# solution), then run: npx create-onelobby --into ." };
        }
        ctx.csproj = csproj;
        const t0 = Date.now();
        // the .csproj is named: a Godot project folder holds both a .csproj and a .sln, and `dotnet build` alone refuses to pick one
        const b = await exec(ctx, "dotnet", ["build", csproj, "-nologo", "-v", "q"], { cwd: ctx.dir, timeoutMs: 420000 });
        if (b.code === 0 && !b.timedOut) return { status: "ok", detail: `dotnet ${sdk[0]}; ${csproj} builds in ${((Date.now() - t0) / 1000).toFixed(0)} s` };
        const registry = /NU1101|NU1102|NU1301/.test(b.out) && /OneLobby\./.test(b.out);
        return {
          status: "fail",
          detail: `${buildCommand(csproj)} failed: ${b.timedOut ? "it did not finish in time" : lastError(b.out)}.`,
          next: registry
            ? "The OneLobby packages are not on the public registry yet: point the game at a folder of .nupkg files with: npx create-onelobby update --packages-from <folder>."
            : `Run: ${buildCommand(csproj)} and read its output.`,
        };
      },
    },
    {
      name: "menu-pin",
      blocking: true,
      async run(ctx) {
        if (!existsSync(join(ctx.dir, MENU_DIR, "OneLobbyMenu.cs")))
          return { status: "fail", detail: `${MENU_DIR}/ is missing (no OneLobbyMenu.cs).`, next: "Run: npx create-onelobby --into . (it copies the menu and writes PIN.json)." };
        if (!existsSync(join(ctx.dir, MENU_DIR, "PIN.json")))
          return { status: "skipped", detail: `${MENU_DIR}/PIN.json is missing, so the menu cannot be compared (adopt it with: npx create-onelobby --into .)` };
        let pin;
        try {
          pin = verifyPin(ctx.dir, MENU_DIR);
        } catch (e) {
          if (e?.code === "bad_pin") return { status: "fail", detail: e.message, next: "Restore it from git, or run: npx create-onelobby --into . --force." };
          return { status: "fail", detail: `${MENU_DIR}/PIN.json is not valid JSON (${e.message}).`, next: "Restore it from git, or run: npx create-onelobby --into . --force." };
        }
        const bits = [pin.edited.length && `edited: ${pin.edited.join(", ")}`, pin.missing.length && `missing: ${pin.missing.join(", ")}`, pin.added.length && `added: ${pin.added.join(", ")}`].filter(Boolean);
        const count = Object.keys(pin.pin.files ?? {}).length;
        const commit = String(pin.pin.source?.commit ?? "unknown").slice(0, 7);
        if (!bits.length) return { status: "ok", detail: `matches PIN.json: ${count} files, menu commit ${commit}` };
        return { status: "ok", detail: `${count} pinned files, menu commit ${commit}`, warning: `the menu differs from PIN.json (${bits.join("; ")}); only a note, the checks below decide` };
      },
    },
    {
      name: "natives",
      blocking: true,
      async run(ctx) {
        const dir = ctx.dir;
        if (!existsSync(join(dir, NATIVES_MARKER)))
          return { status: "fail", detail: "the WebRTC natives are missing (addons/godot_webrtc/webrtc_native.gdextension).", next: "Run: npx create-onelobby update (it downloads the pinned release; offline, add --webrtc-zip <file>)." };
        const registered = () => nonEmpty(join(dir, ".godot/extension_list.cfg")) && /webrtc/i.test(readFileSync(join(dir, ".godot/extension_list.cfg"), "utf8"));
        if (registered()) return { status: "ok", detail: "extension registered" };
        // --import can crash on exit after a good import (harmless): the registered files decide, not the exit code
        const r = await g(ctx, ["--import"], { timeoutMs: 240000 });
        if (registered()) return { status: "ok", detail: "extension registered; ran the headless import first" };
        return { status: "fail", detail: `the headless import did not register the WebRTC extension (${r.timedOut ? "it timed out" : lastError(r.out)}).`, next: "Run: godot --headless --audio-driver Dummy --import --path . and read its output." };
      },
    },
    {
      name: "blueprint",
      blocking: true,
      async run(ctx) {
        let json;
        try {
          json = JSON.parse(readFileSync(join(ctx.dir, "onelobby.json"), "utf8"));
        } catch (e) {
          return { status: "fail", detail: `onelobby.json is not valid JSON (${e.message}).`, next: "Fix the file (its $schema line lists every key)." };
        }
        let bp;
        try {
          bp = await validate(json);
        } catch (e) {
          return { status: "fail", detail: `onelobby.json does not load: ${e.message}${e.path ? ` (at ${e.path})` : ""}.`, next: blueprintNext(e.path, `Fix ${e.path ?? "that key"} in onelobby.json (the schema describes it).`) };
        }
        ctx.facts = { direct: bp.hosting.direct, nostr: bp.hosting.nostr, server: bp.hosting.server, relayOnly: bp.hosting.relayOnly, mode: bp.sync.mode };
        const base = `mode ${bp.sync.mode}, direct ${bp.hosting.direct}, nostr ${bp.hosting.nostr}, server ${bp.hosting.server}`;
        if (!hasTest(ctx.dir)) return { status: "ok", detail: `${base}; loads in JS`, warning: `the C# loader was not run (${MISSING_TEST}) ${MISSING_TEST_NEXT}` };
        // the same file through the game's own C# loader (Blueprint.Parse), which adds the rules only C# has
        const res = routeResult(await runRoute(ctx, "config", []), "Fix onelobby.json so the C# loader accepts it (the message names the key).");
        if (res.status !== "ok") return { ...res, detail: `the C# loader refused onelobby.json: ${res.detail}.` };
        return { status: "ok", detail: `${base}; loads in JS and in C#` };
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
        const res = routeResult(await runRoute(ctx, "direct", [], 120000), `Run: dotnet build, then godot --headless --audio-driver Dummy --path . ${TEST_SCENE} and read its output; check that nothing blocks Godot on 127.0.0.1.`);
        return res.status === "ok" ? { status: "ok", detail: "two peers on 127.0.0.1, host and join by address, one message each way: the game's tests/MultiplayerTest.cs" } : { ...res, detail: `two peers on 127.0.0.1 did not connect: ${res.detail}.` };
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
        const res = routeResult(await runRoute(ctx, "nostr", [`--relay=${relay.url}`]), `Check hosting.nostr and hosting.nostrRelays in onelobby.json, and that nothing blocks Godot on 127.0.0.1. ${routeByHand("nostr", " --relay=<a local relay>")}`);
        if (res.status !== "ok") return { ...res, detail: `two peers through a local Nostr relay on 127.0.0.1 did not connect: ${res.detail}.` };
        if (relay.stats.events <= before)
          return { status: "fail", detail: "the peers connected but the local Nostr relay saw no signaling events, so the Nostr path was not used.", next: "Check that hosting.nostr is on and the game does not pin hosting.nostrRelays elsewhere." };
        return { status: "ok", detail: `two peers through a local Nostr relay on ${relay.url.replace("ws://", "")}: ${relay.stats.events - before} signaling events` };
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
          const res = routeResult(await runRoute(ctx, "turn", args), "The relay-only path failed against a local TURN server: check hosting.relayOnly and the game's TURN settings, and that nothing blocks Godot's UDP on 127.0.0.1.");
          if (res.status !== "ok") return { ...res, detail: `relay-only through a local TURN server on 127.0.0.1 did not connect: ${res.detail}.` };
          // the Godot process has already exited: this server may still be reading its last packets
          for (let i = 0; i < 30 && (turn.stats.allocations < 1 || turn.stats.relayed < 1); i++) await new Promise((r) => setTimeout(r, 100));
          if (turn.stats.allocations < 1 || turn.stats.relayed < 1) {
            return {
              status: "fail",
              detail: `the peers connected, but the TURN server saw ${turn.stats.allocations} allocations and ${turn.stats.relayed} relayed packets, so the relay was not used: the game's links are not relay-only (players' addresses are exposed to each other).`,
              next: "Check that the game builds its transport with new GodotTransport() from a current OneLobby.Godot package (update it: dotnet add package OneLobby.Godot) and that no other transport or hand-made WebRTC link carries the game's traffic. " + routeByHand("turn", " --turn=<login line>"),
            };
          }
          return { status: "ok", detail: `relay-only through a local TURN server on 127.0.0.1:${turn.port}, login pasted as one line: ${turn.stats.allocations} allocations, ${turn.stats.relayed} relayed packets` };
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
        if (url === undefined)
          return { status: "skipped", detail: "hosting.server is true but no --server http://127.0.0.1:<port> was given (verify never starts the lobby server; start one on this machine and pass its address)" };
        let u;
        try {
          u = new URL(url.replace(/^ws/, "http"));
        } catch {
          return { status: "fail", detail: `--server ${url} is not a URL.`, next: "Pass something like --server http://127.0.0.1:8080" };
        }
        if (u.hostname !== "127.0.0.1") return { status: "fail", detail: `--server ${url} is not on 127.0.0.1; verify only talks to this machine.`, next: "Start the lobby server on 127.0.0.1 and pass that address." };
        const port = u.port || "80";
        try {
          const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (e) {
          return { status: "fail", detail: `no lobby server answers at http://127.0.0.1:${port}/healthz (${e?.cause?.code ?? e?.message}).`, next: "Start it (for example: dotnet run --project server/OneLobby.Server -- --listen 127.0.0.1:8080) and rerun." };
        }
        const missing = needTest(ctx);
        if (missing) return missing;
        const wsUrl = `ws://127.0.0.1:${port}${u.pathname.length > 1 ? u.pathname : "/ws"}`;
        const res = routeResult(await runRoute(ctx, "server", [`--server=${wsUrl}`]), `Check hosting.lobbyServer and netVersion, and the server's log. ${routeByHand("server", " --server=<ws url>")}`);
        return res.status === "ok" ? { status: "ok", detail: `host and join by code through the lobby server at ${wsUrl}` } : { ...res, detail: `the lobby-server route failed: ${res.detail}.` };
      },
    },
  ];
}
