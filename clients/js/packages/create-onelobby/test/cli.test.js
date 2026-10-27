import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";
import { parseArgs } from "../src/flags.js";
import { deriveGameId } from "../src/blueprint.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-test-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

/** Run the CLI in-process. Installs and git are always skipped by the caller's flags. */
async function cli(args, { env = {}, tty = false, input = "" } = {}) {
  let out = "";
  let err = "";
  const io = {
    stdout: { write: (s) => (out += s) },
    stderr: { write: (s) => (err += s) },
    stdin: Readable.from([input]),
    stdinIsTTY: tty,
    env,
    cwd,
  };
  const code = await main(args, io);
  return { code, out, err };
}
const NO = ["--no-install", "--no-git"];
const json = async (args, opts) => {
  const r = await cli([...args, "--json", "--dry-run"], opts);
  return { ...r, json: JSON.parse(r.out) };
};

describe("flags -> blueprint", () => {
  it("maps every kind of flag to its schema key", async () => {
    const { code, json: j } = await json([
      "g", "--template", "web", "--game-id", "com.acme.ants", "--title", "Ants", "--max-players", "6", "--listed", "--no-late-join",
      "--mode", "raw", "--tick-rate", "30", "--identity", "anonymous", "--voice", "yes", "--chat", "no", "--voice-mode", "voiceActivity",
      "--pause", "host", "--lobby-server", "wss://l.example/ws", "--no-open-port", "--port", "50000", "--steam", "480", "--discord",
      "--ui-entry", "Menu", "--net-version", "3", "--set", "lobby.meta.mode=fast", "--set", "session.readyTimeoutMs=5000",
    ]);
    expect(code).toBe(0);
    const b = j.blueprint;
    expect(b.game).toEqual({ id: "com.acme.ants", netVersion: "3", title: "Ants" });
    expect(b.engine).toBe("web");
    expect(b.lobby).toMatchObject({ maxPlayers: 6, listed: true, lateJoin: false, meta: { mode: "fast" } });
    expect(b.sync).toMatchObject({ mode: "raw", tickRate: 30, hashEveryTicks: 30 });
    expect(b.players.identity).toBe("anonymous");
    expect(b.chat).toEqual({ text: false, voice: true, voiceMode: "voiceActivity" });
    expect(b.session).toMatchObject({ pause: "host", readyTimeoutMs: 5000 });
    expect(b.hosting).toMatchObject({ lobbyServer: "wss://l.example/ws", openPort: false, directPort: 50000, server: true, direct: false });
    expect(b.platforms).toEqual({ steam: { appId: 480 }, epic: false, discord: true });
    expect(b.ui).toMatchObject({ kind: "generated", entry: "Menu" });
  });

  it("parses --flag=value, --no-flag, --voice no and a bare --steam", () => {
    const { given } = parseArgs(["--max-players=8", "--no-join-link", "--voice", "no", "--steam", "--hosting", "both"]);
    expect(given).toEqual([
      ["lobby.maxPlayers", 8], ["lobby.joinLink", false], ["chat.voice", false], ["platforms.steam", true],
      ["hosting.direct", true], ["hosting.server", true],
    ]);
  });

  it("--hosting server sets direct false and server true", async () => {
    const { json: j } = await json(["g", "--yes", "--hosting", "server"]);
    expect(j.blueprint.hosting).toMatchObject({ direct: false, server: true });
  });

  it("--from takes every answer from a file, flags still win", async () => {
    writeFileSync(join(cwd, "in.json"), JSON.stringify({ game: { id: "com.acme.from" }, lobby: { maxPlayers: 8 }, chat: { voice: true } }));
    const { json: j } = await json(["g", "--from", "in.json", "--max-players", "5", "--no-input"]);
    expect(j.blueprint.game.id).toBe("com.acme.from");
    expect(j.blueprint.lobby.maxPlayers).toBe(5);
    expect(j.blueprint.chat.voice).toBe(true);
  });

  it("unknown flags and bad values exit 1", async () => {
    const a = await json(["g", "--nope"]);
    expect(a.code).toBe(1);
    expect(a.json).toMatchObject({ ok: false, error: { code: "bad_flag" } });
    const b = await json(["g", "--yes", "--max-players", "many"]);
    expect(b.json.error.code).toBe("bad_flag");
  });
});

describe("--yes and --no-input", () => {
  it("--yes derives com.example.<folder> and writes the full file", async () => {
    const { json: j } = await json(["My Cool Game", "--yes", "--no-input"]);
    expect(j.blueprint.game).toEqual({ id: "com.example.my-cool-game", netVersion: "1", title: "My Cool Game" });
    expect(j.blueprint.$schema).toBe("https://unpkg.com/onelobby@0.6.0/blueprint.schema.json");
    expect(j.blueprint).toMatchObject({ version: 1, engine: "web", sync: { mode: "lockstep" }, chat: { text: true, voice: false } });
    for (const k of ["hosting", "lobby", "sync", "players", "chat", "session", "platforms", "ui"]) expect(j.blueprint).toHaveProperty(k);
  });

  it("--no-input without --yes and no game id is an error naming game.id", async () => {
    const r = await json(["g", "--no-input"]);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, error: { code: "missing_answer", path: "game.id" } });
  });

  it("a non-TTY stdin never prompts: same error", async () => {
    const r = await cli(["g", "--dry-run"], { tty: false });
    expect(r.code).toBe(1);
    expect(r.err).toContain("game id is required");
  });

  it("CI=true implies --no-input even on a TTY", async () => {
    const r = await cli(["g", "--dry-run", "--json"], { tty: true, env: { CI: "true" }, input: "com.acme.x\n" });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).error.path).toBe("game.id");
    const ok = await cli(["g", "--dry-run", "--json", "--yes"], { tty: true, env: { CI: "true" } });
    expect(ok.code).toBe(0);
  });

  it("with no folder, --no-input is an error and --yes picks my-onelobby-game", async () => {
    expect((await json(["--no-input", "--game-id", "com.a.b"])).json.error.path).toBe("dir");
    expect((await json(["--yes"])).json.blueprint.game.id).toBe("com.example.my-onelobby-game");
  });
});

describe("prompts (TTY, no --yes)", () => {
  it("asks in schema order with the schema descriptions, empty answers keep defaults", async () => {
    // game.id, game.title, lobbyServer, maxPlayers, listed, (approveJoins skipped: listed), password ... then defaults
    const answers = ["com.acme.asked", "", "wss://s.example/ws", "6", "y", "", "", "", "", "", "", "", "y", "", "", "", ""];
    const r = await cli(["g", "--dry-run", "--json"], { tty: true, input: answers.join("\n") + "\n" });
    expect(r.code).toBe(0);
    const prompts = r.err; // with --json the questions go to stderr, stdout stays one object
    expect(prompts).toContain("Reverse-DNS id. Lobbies only match players of the same game.");
    expect(prompts).toContain("Seats, host included.");
    expect(prompts.indexOf("Reverse-DNS id")).toBeLessThan(prompts.indexOf("Seats, host included."));
    expect(prompts).not.toContain("The host approves each joiner"); // listed was yes
    const b = JSON.parse(r.out);
    expect(b.blueprint.game.id).toBe("com.acme.asked");
    expect(b.blueprint.game.title).toBe("g");
    expect(b.blueprint.lobby).toMatchObject({ maxPlayers: 6, listed: true });
    expect(b.blueprint.hosting.lobbyServer).toBe("wss://s.example/ws");
  });
});

describe("--dry-run and --json", () => {
  it("--dry-run writes nothing and prints the plan and onelobby.json", async () => {
    const r = await cli(["proj", "--yes", "--dry-run", ...NO]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Dry run: nothing written");
    expect(r.out).toContain("onelobby.json");
    expect(r.out).toContain('"id": "com.example.proj"');
    expect(existsSync(join(cwd, "proj"))).toBe(false);
  });

  it("--json prints exactly one object with the documented keys", async () => {
    const r = await cli(["proj", "--yes", "--json", ...NO]);
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toHaveLength(1);
    const j = JSON.parse(r.out);
    expect(Object.keys(j)).toEqual(["ok", "dir", "template", "blueprint", "files", "next"]);
    expect(j.ok).toBe(true);
    expect(j.template).toBe("web");
    expect(j.dir).toBe(join(cwd, "proj"));
    expect(j.files).toEqual(expect.arrayContaining(["onelobby.json", "package.json", "index.html", "src/game.js", "src/multiplayer.js", "test/multiplayer.mjs", "AGENTS.md", ".gitignore"]));
    expect(j.next).toEqual(expect.arrayContaining(["npm install", "npm start", "npm test"]));
    expect(existsSync(join(cwd, "proj", "onelobby.json"))).toBe(true);
  });

  it("--json errors are { ok:false, error:{code,message,path?} } and nothing else", async () => {
    const r = await cli(["proj", "--yes", "--json", "--hosting", "both", ...NO]);
    expect(r.code).toBe(1);
    expect(r.out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "bad_config", path: "hosting.direct" } });
    expect(r.err).toBe("");
  });
});

describe("a new project", () => {
  it("writes the web template; every JSON file is valid and onelobby.json matches the dry run", async () => {
    const r = await cli(["proj", "--yes", "--onelobby-version", "file:../client", ...NO]);
    expect(r.code).toBe(0);
    const bp = JSON.parse(readFileSync(join(cwd, "proj/onelobby.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(cwd, "proj/package.json"), "utf8"));
    expect(pkg).toMatchObject({ name: "proj", type: "module", dependencies: { onelobby: "file:../client" }, scripts: { start: expect.any(String), test: expect.any(String) } });
    expect(bp.game.id).toBe("com.example.proj");
    const agents = readFileSync(join(cwd, "proj/AGENTS.md"), "utf8");
    expect(agents.trim().split("\n")).toHaveLength(3);
    expect(agents).toContain("https://unpkg.com/onelobby@0.6.0/blueprint.schema.json");
    expect(readFileSync(join(cwd, "proj/test/multiplayer.mjs"), "utf8")).not.toContain("//#");
    expect(readFileSync(join(cwd, "proj/test/multiplayer.mjs"), "utf8")).toContain("realServer");
    expect(readFileSync(join(cwd, "proj/.gitignore"), "utf8")).toContain("node_modules");
  });

  it("defaults the dependency to ^0.6.0", async () => {
    await cli(["proj", "--yes", ...NO]);
    expect(JSON.parse(readFileSync(join(cwd, "proj/package.json"), "utf8")).dependencies.onelobby).toBe("^0.6.0");
  });

  it("refuses a non-empty folder without --force", async () => {
    mkdirSync(join(cwd, "full"));
    writeFileSync(join(cwd, "full", "a.txt"), "x");
    const r = await json(["full", "--yes"]);
    expect(r.json.error.code).toBe("dir_not_empty");
  });
});

describe("invalid combinations exit 1 with the loader's path and rule", () => {
  const bad = async (args) => (await json(["g", "--yes", ...args])).json;
  it("web cannot host direct", async () => {
    const j = await bad(["--hosting", "direct"]);
    expect(j.ok).toBe(false);
    expect(j.error).toMatchObject({ code: "bad_config", path: "hosting.direct" });
    expect(j.error.message).toContain("direct_needs_listener");
  });
  it("listed with approve-joins", async () => {
    expect((await bad(["--listed", "--approve-joins"])).error).toMatchObject({ path: "lobby" });
  });
  it("replication on web", async () => {
    expect((await bad(["--mode", "replication"])).error).toMatchObject({ path: "sync.mode" });
  });
  it("out-of-range value via --set", async () => {
    expect((await bad(["--set", "lobby.maxPlayers=1"])).error).toMatchObject({ code: "bad_config", path: "lobby.maxPlayers" });
  });
  it("a bad game id", async () => {
    expect((await bad(["--game-id", "not valid!"])).error).toMatchObject({ path: "game.id" });
  });
  it("the web template only writes the generated UI", async () => {
    expect((await bad(["--ui", "drop-in"])).error).toMatchObject({ code: "unsupported", path: "ui.kind" });
  });
});

describe("--into", () => {
  it("writes only onelobby.json, multiplayer/ and the test", async () => {
    mkdirSync(join(cwd, "game"));
    writeFileSync(join(cwd, "game", "package.json"), "{}");
    const r = await cli(["--into", "game", "--yes", "--json"]);
    const j = JSON.parse(r.out);
    expect(j.files).toEqual(["onelobby.json", "multiplayer/session.js", "test/multiplayer.mjs"]);
    expect(readFileSync(join(cwd, "game/package.json"), "utf8")).toBe("{}");
    expect(existsSync(join(cwd, "game/index.html"))).toBe(false);
    expect(readFileSync(join(cwd, "game/test/multiplayer.mjs"), "utf8")).toContain("../multiplayer/session.js");
    expect(j.blueprint.game.id).toBe(deriveGameId("game"));
  });

  it("never overwrites an existing file unless --force", async () => {
    mkdirSync(join(cwd, "game"));
    writeFileSync(join(cwd, "game", "onelobby.json"), "mine");
    const r = await json(["--into", "game", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toMatchObject({ code: "exists" });
    expect(r.json.error.message).toContain("onelobby.json");
    expect(readFileSync(join(cwd, "game/onelobby.json"), "utf8")).toBe("mine");
    expect(existsSync(join(cwd, "game/multiplayer"))).toBe(false); // nothing partial
    const forced = await cli(["--into", "game", "--yes", "--force"]);
    expect(forced.code).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, "game/onelobby.json"), "utf8")).version).toBe(1);
  });

  it("needs an existing folder", async () => {
    expect((await json(["--into", "nope", "--yes"])).json.error.code).toBe("no_such_dir");
  });
});

describe("templates", () => {
  for (const t of ["node-browser", "godot-csharp", "unity", "dotnet"]) {
    it(`${t} exits 1 with a planned-for-v2 message`, async () => {
      const r = await cli(["g", "--template", t, "--yes", ...NO]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("planned for v2");
      expect(existsSync(join(cwd, "g"))).toBe(false);
      const j = JSON.parse((await cli(["g", "--template", t, "--yes", "--json", ...NO])).out);
      expect(j).toMatchObject({ ok: false, error: { code: "template_planned" } });
    });
  }
  it("an unknown template is a bad flag", async () => {
    expect(JSON.parse((await cli(["g", "--template", "cobol", "--json"])).out).error.code).toBe("bad_flag");
  });
});

describe("help", () => {
  it("--help prints usage and exits 0", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--dry-run");
  });
});

describe("package.json", () => {
  it("keeps its bin entry when packed (npm 11 drops a bin path that starts with ./)", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.bin["create-onelobby"]).toBe("bin/create-onelobby.js");
  });
});
