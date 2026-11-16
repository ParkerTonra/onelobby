// The checks `verify` runs for a godot-gdscript game. Everything is loopback (127.0.0.1) and headless (--headless --audio-driver Dummy).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../blueprint.js";
import { NATIVES_MARKER, verifyPin } from "../vendor.js";
import { run } from "./procs.js";
import { startRelay } from "./relay.js";
import { fetchCommand, fetchTurnHelper, findTurnHelper, startTurn } from "./turn.js";
import { blueprintNext, wiringCheck } from "./wiring.js";

const PROBE_SOURCE = fileURLToPath(new URL("../../templates/verify/probe.gd", import.meta.url));
export const PROBE_RES = "res://.onelobby/verify/probe.gd";
const GODOT_FLAGS = ["--headless", "--audio-driver", "Dummy"];
const NO_GODOT = "Pass --godot <path to Godot 4.4+>, set the GODOT environment variable, or put godot on PATH, then rerun.";

/** The Godot executable: --godot, else $GODOT, else `godot` on PATH. Returns { exe, from } or null. */
export function resolveGodot({ flag, env, platform = process.platform, exists = existsSync }) {
  const pick = flag ?? env.GODOT ?? "godot";
  const from = flag !== undefined ? "--godot" : env.GODOT !== undefined ? "$GODOT" : "PATH";
  if (/[\\/]/.test(pick) || isAbsolute(pick)) return exists(pick) ? { exe: resolve(pick), from } : null;
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) if (exists(join(dir, pick + ext))) return { exe: join(dir, pick + ext), from };
  }
  return null;
}

/** The rest of the first line "<tag> ..." in the output, or null. */
export const probeLine = (out, tag) => new RegExp(`^${tag} (.*)$`, "m").exec(out)?.[1]?.trim() ?? null;

const nonEmpty = (p) => existsSync(p) && statSync(p).size > 0;
const lastError = (out) => (out.split(/\r?\n/).filter((l) => /error/i.test(l)).slice(-1)[0] ?? "no error text").trim().slice(0, 160);

/** The checks for a godot-gdscript game, in order. `ctx`: { dir, opts, env, services, godot (set by the first check), facts (by blueprint) }. */
export function godotChecks() {
  const g = (ctx, extra, o) => run(ctx.godot.exe, [...GODOT_FLAGS, "--path", ctx.dir, ...extra], { cwd: ctx.dir, ...o });
  const probe = (ctx, args, timeoutMs = 100000) => g(ctx, ["-s", PROBE_RES, "--", ...args], { timeoutMs });
  const facts = (ctx) => ctx.facts ?? {};
  const probeResult = (r, route, next) => {
    const ok = probeLine(r.out, "VERIFY_PROBE_OK");
    if (ok?.startsWith(route) && !r.timedOut) return { status: "ok", detail: ok.slice(route.length).trim() || undefined };
    const fail = probeLine(r.out, "VERIFY_PROBE_FAIL");
    const why = r.timedOut ? "the Godot process did not finish in time" : fail ? fail.replace(new RegExp(`^${route} `), "") : `Godot exited ${r.code} without a result line (${lastError(r.out)})`;
    return { status: "fail", detail: why, next };
  };
  const probeByHand = (route, more = "") => `Rerun that route by hand: godot --headless --audio-driver Dummy --path . -s ${PROBE_RES} -- --route=${route}${more}`;

  return [
    {
      name: "godot",
      blocking: true,
      async run(ctx) {
        const found = resolveGodot({ flag: ctx.opts.godot, env: ctx.env });
        if (!found) return { status: "fail", detail: `no Godot executable found (looked at ${ctx.opts.godot !== undefined ? "--godot" : ctx.env.GODOT !== undefined ? "$GODOT" : "godot on PATH"}).`, next: NO_GODOT };
        const v = await run(found.exe, ["--version"], { timeoutMs: 30000 });
        const m = /^(\d+)\.(\d+)[.\w-]*/m.exec(v.out.trim());
        if (v.code !== 0 || !m) return { status: "fail", detail: `${found.exe} did not answer --version like Godot (${(v.error ?? v.out.trim().slice(0, 80)) || "no output"}).`, next: NO_GODOT };
        if (Number(m[1]) < 4 || (Number(m[1]) === 4 && Number(m[2]) < 4)) return { status: "fail", detail: `Godot ${m[0]} is older than 4.4.`, next: "Use Godot 4.4 or newer (--godot, $GODOT or PATH)." };
        ctx.godot = { exe: found.exe, version: v.out.trim().split(/\r?\n/)[0], from: found.from };
        return { status: "ok", detail: `${ctx.godot.version}, from ${found.from}` };
      },
    },
    {
      name: "addon-pin",
      blocking: true,
      async run(ctx) {
        if (!existsSync(join(ctx.dir, "addons/onelobby/client.gd")))
          return { status: "fail", detail: "addons/onelobby/ is missing (no client.gd).", next: "Run: npx create-onelobby --into . (it copies the add-on and writes PIN.json)." };
        if (!existsSync(join(ctx.dir, "addons/onelobby/PIN.json")))
          return { status: "skipped", detail: "addons/onelobby/PIN.json is missing, so the add-on cannot be compared (adopt it with: npx create-onelobby --into .)" };
        let pin;
        try {
          pin = verifyPin(ctx.dir);
        } catch (e) {
          if (e?.code === "bad_pin") return { status: "fail", detail: e.message, next: "Restore it from git, or run: npx create-onelobby --into . --force." };
          return { status: "fail", detail: `addons/onelobby/PIN.json is not valid JSON (${e.message}).`, next: "Restore it from git, or run: npx create-onelobby --into . --force." };
        }
        const bits = [pin.edited.length && `edited: ${pin.edited.join(", ")}`, pin.missing.length && `missing: ${pin.missing.join(", ")}`, pin.added.length && `added: ${pin.added.join(", ")}`].filter(Boolean);
        const count = Object.keys(pin.pin.files ?? {}).length;
        const commit = String(pin.pin.source?.commit ?? "unknown").slice(0, 7);
        if (!bits.length) return { status: "ok", detail: `matches PIN.json: ${count} files, add-on commit ${commit}` };
        return { status: "ok", detail: `${count} pinned files, add-on commit ${commit}`, warning: `the add-on differs from PIN.json (${bits.join("; ")}); only a note, the checks below decide` };
      },
    },
    {
      name: "natives",
      blocking: true,
      async run(ctx) {
        const dir = ctx.dir;
        if (!existsSync(join(dir, NATIVES_MARKER)))
          return { status: "fail", detail: "the WebRTC natives are missing (addons/godot_webrtc/webrtc_native.gdextension).", next: "Run: npx create-onelobby update (it downloads the pinned release; offline, add --webrtc-zip <file>)." };
        const registered = () => {
          const cache = join(dir, ".godot/global_script_class_cache.cfg");
          return nonEmpty(join(dir, ".godot/extension_list.cfg")) && existsSync(cache) && /OneLobbyClient/.test(readFileSync(cache, "utf8"));
        };
        if (registered()) return { status: "ok", detail: "extension registered" };
        // --import can crash on exit after a good import (harmless): the registered files decide, not the exit code
        const r = await g(ctx, ["--import"], { timeoutMs: 240000 });
        if (registered()) return { status: "ok", detail: "extension registered; ran the headless import first" };
        return { status: "fail", detail: `the headless import did not register the WebRTC extension and the add-on classes (${r.timedOut ? "it timed out" : lastError(r.out)}).`, next: "Run: godot --headless --import --path . and read its output." };
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
        // the same file through the game's own GDScript loader, which adds the rules only GDScript has
        const res = probeResult(await probe(ctx, ["--route=config"]), "config", "Fix onelobby.json so the GDScript loader accepts it (the message names the key).");
        if (res.status !== "ok") return { ...res, detail: `the GDScript loader refused onelobby.json: ${res.detail}.` };
        return { status: "ok", detail: `mode ${bp.sync.mode}, direct ${bp.hosting.direct}, nostr ${bp.hosting.nostr}, server ${bp.hosting.server}; loads in JS and in GDScript` };
      },
    },
    wiringCheck(),
    {
      name: "direct",
      async run(ctx) {
        const f = facts(ctx);
        if (!f.direct) return { status: "skipped", detail: "hosting.direct is false in onelobby.json (the game hosts through a lobby server only)" };
        if (existsSync(join(ctx.dir, "tests/multiplayer.gd"))) {
          const r = await g(ctx, ["-s", "res://tests/multiplayer.gd"], { timeoutMs: 120000 });
          if (/^MULTIPLAYER_OK/m.test(r.out) && !r.timedOut) return { status: "ok", detail: "two peers on 127.0.0.1, host and join by code, one message each way: the game's tests/multiplayer.gd" };
          const fail = /^MULTIPLAYER_FAIL (.*)$/m.exec(r.out)?.[1];
          return {
            status: "fail",
            detail: `two peers on 127.0.0.1 did not connect: ${r.timedOut ? "tests/multiplayer.gd did not finish in time" : (fail ?? `no MULTIPLAYER_OK (${lastError(r.out)})`)}.`,
            next: "Run: godot --headless --audio-driver Dummy --path . -s res://tests/multiplayer.gd and read its output; check that nothing blocks Godot on 127.0.0.1.",
          };
        }
        const res = probeResult(await probe(ctx, ["--route=direct"]), "direct", probeByHand("direct"));
        return res.status === "ok" ? { status: "ok", detail: "two peers on 127.0.0.1, host and join by code, one message each way: the bundled probe" } : { ...res, detail: `two peers on 127.0.0.1 did not connect: ${res.detail}.` };
      },
    },
    {
      name: "nostr",
      async run(ctx) {
        const f = facts(ctx);
        if (!f.direct) return { status: "skipped", detail: "hosting.direct is false in onelobby.json" };
        if (!f.nostr) return { status: "skipped", detail: "hosting.nostr is false in onelobby.json (join codes are IP codes, no Nostr relay is involved)" };
        const relay = (ctx.services.relay ??= await startRelay());
        const before = relay.stats.events;
        const res = probeResult(await probe(ctx, ["--route=nostr", `--relay=${relay.url}`]), "nostr", `Check hosting.nostr and hosting.nostrRelays in onelobby.json, and that nothing blocks Godot on 127.0.0.1. ${probeByHand("nostr", " --relay=<a local relay>")}`);
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
        let base = findTurnHelper(ctx.dir);
        if (!base && ctx.opts.fetchHelpers) {
          const got = await fetchTurnHelper(ctx.dir);
          if (!got.ok) return { status: "skipped", detail: `the TURN helper (npm node-turn) could not be fetched (${got.out || "no output"}); offline? When online run: ${fetchCommand(ctx.dir)}` };
          base = findTurnHelper(ctx.dir);
        }
        if (!base) return { status: "skipped", detail: `the local TURN helper (npm node-turn) is not available (run: npx create-onelobby verify --fetch-helpers, or: ${fetchCommand(ctx.dir)})` };
        const turn = await startTurn(base);
        try {
          const relay = f.nostr ? (ctx.services.relay ??= await startRelay()) : null;
          const args = ["--route=turn", `--turn=${turn.line}`, ...(relay ? [`--relay=${relay.url}`] : [])];
          const res = probeResult(await probe(ctx, args), "turn", "The relay-only path failed against a local TURN server: check hosting.relayOnly and the game's TURN settings, and that nothing blocks Godot's UDP on 127.0.0.1.");
          if (res.status !== "ok") return { ...res, detail: `relay-only through a local TURN server on 127.0.0.1 did not connect: ${res.detail}.` };
          if (turn.stats.allocations < 1 || turn.stats.relayed < 1)
            return {
              status: "fail",
              detail: `the peers connected but the TURN server saw ${turn.stats.allocations} allocations and ${turn.stats.relayed} relayed packets, so the relay was not used.`,
              next: "The relay-only setting did not reach the client; check how the game builds its OneLobbyClient (from_config keeps relay_only from the blueprint).",
            };
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
        const wsUrl = `ws://127.0.0.1:${port}${u.pathname.length > 1 ? u.pathname : "/ws"}`;
        const res = probeResult(await probe(ctx, ["--route=server", `--server=${wsUrl}`]), "server", `Check hosting.lobbyServer and netVersion, and the server's log. ${probeByHand("server", " --server=<ws url>")}`);
        return res.status === "ok" ? { status: "ok", detail: `host and join by code through the lobby server at ${wsUrl}` } : { ...res, detail: `the lobby-server route failed: ${res.detail}.` };
      },
    },
  ];
}

/** Put the probe script where Godot can load it: <game>/.onelobby/verify/probe.gd (gitignored scratch inside the game). */
export function writeProbe(dir) {
  const target = join(dir, ".onelobby", "verify");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "probe.gd"), readFileSync(PROBE_SOURCE, "utf8").replace(/\r\n/g, "\n"));
}
