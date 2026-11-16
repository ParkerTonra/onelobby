// `create-onelobby --recommend`: the matcher, the data, the standalone output, the scaffold use and the JSON contract.
// No network, no model, no Godot.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";
import { setPath } from "../src/flags.js";
import { IMPLEMENTED_TEMPLATES } from "../src/blueprint.js";
import { validate } from "../src/blueprint.js";
import { ADVICE, ENGINES, FEATURE_PROOF, SHAPES } from "../src/recommend-data.js";
import { detectEngine, readPlayers, readTickRate, recommend, renderText } from "../src/recommend.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const repo = join(pkg, "../../../..");
const schema = JSON.parse(readFileSync(join(pkg, "vendor/blueprint.schema.json"), "utf8"));

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-recommend-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

async function cli(args, { tty = false, input = [] } = {}) {
  let out = "";
  let err = "";
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, stdin: Readable.from(input), stdinIsTTY: tty, env: {}, cwd };
  const code = await main(args, io);
  return { code, out, err };
}
const json = async (args, opts) => {
  const r = await cli([...args, "--json"], opts);
  return { ...r, json: JSON.parse(r.out) };
};

// ---- the sentences -------------------------------------------------------------------------------------------------------
// [description, shape (null: unknown), sync.mode, lobby.maxPlayers, words that must be among the matched ones (lower case)]
const SENTENCES = [
  // the real-game shapes, in generic words
  ["party minigames for up to 8 on a fixed tick, deterministic", "lockstep", "lockstep", 8, ["party", "minigames", "fixed tick", "deterministic"]],
  ["co-op survival sandbox where the host runs the world", "coop-snapshots", "replication", 4, ["co-op", "sandbox", "host runs the world"]],
  ["4 player wave survival first-person shooter in Unity", "replication", "replication", 4, ["first-person shooter"]],
  ["browser RTS for 2 or 4 players with spectators that already has its own server loop", "own-server", "raw", 4, ["own server loop"]],
  ["online card game", "turn-based", "raw", 4, ["card game"]],
  ["chess", "turn-based", "raw", 2, ["chess"]],
  ["physics racing game in Godot", "replication", "replication", 4, ["physics", "racing"]],
  // a co-op game that already has host-run multiplayer: "not deterministic" and "host authoritative" must not turn it into the competitive shape
  ["Free-roam 3D first-person co-op game in Godot GDScript for up to 4 players: the host runs the world and sends snapshots to joiners, which predict their own actions; not deterministic, frame-driven, 10 Hz sim tick", "coop-snapshots", "replication", 4, ["free-roam", "co-op", "host runs the world"]],
  ["3D co-op game in Godot GDScript for up to 4 players, host authoritative, frame-driven, not deterministic", "coop-snapshots", "replication", 4, ["co-op"]],
  ["co-op game where the host sends snapshots to the joiners", "coop-snapshots", "replication", 4, ["co-op", "host sends snapshots"]],
  ["cooperative first-person game for 3 players, not deterministic", "coop-snapshots", "replication", 3, ["cooperative"]],
  // controls: a competitive word keeps the competitive shape, and "not deterministic" alone still means it
  ["co-op shooter for 4 players, not deterministic", "replication", "replication", 4, ["shooter", "not deterministic"]],
  ["4 player arena game, host authoritative, not deterministic", "replication", "replication", 4, ["not deterministic"]],
  // the rest of section 5, in other words
  ["4 player party minigames in Godot", "lockstep", "lockstep", 4, ["party", "minigames"]],
  ["RTS with a seeded simulation in the browser, 60 Hz", "lockstep", "lockstep", 4, ["rts", "seeded"]],
  ["a deterministic fixed timestep tower defense for up to 6 friends", "lockstep", "lockstep", 6, ["deterministic", "fixed timestep"]],
  ["drawing party game for 8 friends", "lockstep", "lockstep", 8, ["party game"]],
  ["open world sandbox for 2-6 players with 3 spectators in Unity", "coop-snapshots", "replication", 6, ["open world", "sandbox"]],
  ["free roam crafting and survival, cooperative, for 4", "coop-snapshots", "replication", 4, ["free roam", "cooperative"]],
  ["third person shooter with hitscan weapons, 16 players", "replication", "replication", 16, ["third person shooter", "hitscan"]],
  ["battle royale, up to 32 players", "replication", "replication", 32, ["battle royale"]],
  ["1v1 duel brawler", "replication", "replication", 2, ["brawler"]],
  ["turn-based strategy for two players", "turn-based", "raw", 2, ["turn-based"]],
  ["a board game night: poker for six", "turn-based", "raw", 6, ["board game", "poker"]],
  ["tic-tac-toe", "turn-based", "raw", 2, ["tic-tac-toe"]],
  ["our game already has its own backend over a websocket, 6 players", "own-server", "raw", 6, ["own backend", "websocket"]],
  ["it keeps the existing server code", "own-server", "raw", 4, ["existing server"]],
  // a new game: no code to survey, the sentence is all there is (movement words lead to a player world)
  ["a Unity 3D game where 2 to 4 friends run and jump around a small arena together", "replication", "replication", 4, ["run", "jump", "arena"]],
  ["a Godot GDScript 2D side-view platformer, 4 players, 30 tick", "replication", "replication", 4, ["platformer"]],
  ["co-op", "coop-snapshots", "replication", 4, ["co-op"]],
  // near misses
  ["a deterministic shooter", "lockstep", "lockstep", 4, ["deterministic"]], // an explicit determinism claim outweighs the genre word
  ["survival card game", "turn-based", "raw", 4, ["card game"]], // "survival" inside a card game is only a weak word
  ["RTS in Unity with physics", "replication", "replication", 4, ["physics"]], // Unity physics is not deterministic: lockstep is out
  ["a deterministic racing game in Unity", "replication", "replication", 4, ["racing"]], // the same ban, with no "physics" in the words
  ["physics puzzle, deterministic and lockstep", "lockstep", "lockstep", 4, ["deterministic", "lockstep"]], // said deterministic: the physics penalty is lifted
  ["shooter with a turn-based mode", null, undefined, undefined, []], // two shapes equally: unknown, not a guess
  // upper case, extra punctuation
  ["PARTY MINIGAMES!!! for UP TO 8 players... (deterministic)", "lockstep", "lockstep", 8, ["party", "minigames", "deterministic"]],
  ["  Co-Op   Survival,, Sandbox ;; for 4.  ", "coop-snapshots", "replication", 4, ["co-op", "sandbox"]],
  ["BATTLE ROYALE!!! shooter, 16 players, Unity", "replication", "replication", 16, ["battle royale", "shooter"]],
  // unknown is an answer
  ["a puzzle game", null, undefined, undefined, []],
  ["survival", null, undefined, undefined, []], // one weak word
  ["party", null, undefined, undefined, []],
  ["multiplayer", null, undefined, undefined, []],
  ["Ein Kartenspiel fuer vier Spieler online", null, undefined, undefined, []], // not English: no guess
  ["juego de cartas en linea para cuatro", null, undefined, undefined, []],
];

describe("the matcher: sentence -> shape, mode, players, matched words", () => {
  it("has at least 30 sentences", () => expect(SENTENCES.length).toBeGreaterThanOrEqual(30));
  for (const [text, shape, mode, max, words] of SENTENCES) {
    it(`${JSON.stringify(text)} -> ${shape}`, () => {
      const rec = recommend({ description: text });
      expect(rec.shape).toBe(shape);
      if (shape === null) {
        expect(rec.answers).toEqual([]);
        expect(rec.flags).toEqual([]);
        expect(rec.questions.map((q) => q.id)).toContain("shape");
        expect(rec.shapes).toHaveLength(5);
        return;
      }
      const row = (k) => rec.answers.find((r) => r[0] === k)?.[1];
      expect(row("sync.mode")).toBe(mode);
      expect(row("lobby.maxPlayers")).toBe(max);
      const matched = rec.matched.map((m) => m.toLowerCase());
      for (const w of words) expect(matched).toContain(w);
      for (const [, , why] of rec.answers) expect(why.length).toBeGreaterThan(10);
    });
  }

  it("a sentence of movement words leads to a player world, and says so", () => {
    const rec = recommend({ description: "a Unity 3D game where 2 to 4 friends run and jump around a small arena together" });
    expect(rec.shape).toBe("replication");
    expect(rec.fallback).toBe("world");
    expect(rec.answers.find((r) => r[0] === "sync.player.authority")?.[1]).toBe("host");
    expect(rec.answers.find((r) => r[0] === "sync.player.space")).toBeUndefined(); // 3D is the schema default: no row
    expect(rec.notes.join(" ")).toContain("no code to survey");
    expect(rec.questions.map((q) => q.id)).not.toContain("shape");
  });

  it("movement words never override a word that says another kind of game", () => {
    for (const text of ["a turn based puzzle game where you jump", "a deterministic lockstep arena game", "a puzzle platformer", "chess in an arena"]) {
      const rec = recommend({ description: text });
      expect(rec.fallback, text).toBeUndefined();
    }
    expect(recommend({ description: "a puzzle platformer" }).shape).toBeNull();
  });

  it("a game still unknown lists its candidates, best first", () => {
    const rec = recommend({ description: "shooter with a turn-based mode" });
    expect(rec.shape).toBeNull();
    expect(rec.candidates.length).toBeGreaterThan(1);
    expect(rec.candidates[0].score).toBeGreaterThanOrEqual(rec.candidates[1].score);
  });

  it("reads 2D, side view, top-down and platformer as sync.player.space 2d; an explicit 3D wins", () => {
    const space = (d) => recommend({ description: d }).answers.find((r) => r[0] === "sync.player.space")?.[1];
    expect(space("a Godot GDScript 2D side-view platformer, 4 players, 30 tick")).toBe("2d");
    for (const d of ["a 2D arena shooter in Godot", "top-down shooter in Godot", "top down co-op in Unity", "a side scroller brawler", "a platformer where friends run and jump"]) expect(space(d), d).toBe("2d");
    for (const d of ["a 3D platformer in Unity, co-op", "a Unity 3D game where friends run and jump around an arena", "a first person shooter"]) expect(space(d), d).toBeUndefined();
    // a game with no player layer (lockstep, turn based) gets no row: there is no player to place
    expect(space("a 2D deterministic lockstep game")).toBeUndefined();
  });

  it("the 2D row reaches the command: the flags carry --set sync.player.space=2d", () => {
    const rec = recommend({ description: "a Godot GDScript 2D side-view platformer, 4 players, 30 tick" });
    expect(rec.flags.join(" ")).toContain("--set sync.player.space=2d");
    expect(rec.runCommand).toContain("sync.player.space=2d");
  });

  it("an empty or blank description is bad_flag, alone and with a scaffold", async () => {
    for (const args of [["--recommend", ""], ["--recommend", "   "], ["--recommend="], ["g", "--recommend", " "]]) {
      const r = await json(args);
      expect(r.code).toBe(1);
      expect(r.json.error.code).toBe("bad_flag");
    }
    expect((await json(["--recommend"])).json.error.code).toBe("bad_flag"); // no value at all
  });

  it("is deterministic: the same sentence, the same object", () => {
    const a = recommend({ description: "4 player wave survival first-person shooter in Unity" });
    expect(JSON.stringify(recommend({ description: "4 player wave survival first-person shooter in Unity" }))).toBe(JSON.stringify(a));
  });

  it("reads the player count, the tick rate and the engine", () => {
    const p = (s) => readPlayers(s)?.max ?? null;
    expect([p("4 player"), p("2-4 players"), p("2 or 4 players"), p("up to 8"), p("four players"), p("1v1"), p("a duel"), p("for 5"), p("no number")]).toEqual([4, 4, 4, 8, 4, 2, 2, 5, null]);
    expect([p("1 player"), p("200 players")]).toEqual([null, 64]);
    expect([readTickRate("at 60 Hz"), readTickRate("30 ticks per second"), readTickRate("a 20 tick sim"), readTickRate("500 hz"), readTickRate("fast")]).toEqual([60, 30, 20, null, null]);
    const e = (s) => detectEngine(s)?.id ?? null;
    expect([e("in Unity"), e("Godot with C#"), e("GDScript"), e("in Godot"), e("in the browser"), e("MonoGame"), e("on a console")]).toEqual(["unity", "godot-csharp", "godot-gdscript", "godot-gdscript", "web", "dotnet", null]);
  });

  it("spectators only when the description mentions watching; the count when it gives one", () => {
    const sp = (s) => recommend({ description: s }).answers.find((r) => r[0] === "room.spectators")?.[1];
    expect(sp("online card game")).toBeUndefined();
    expect(sp("online card game with spectators")).toBe(4);
    expect(sp("online card game, 10 spectators")).toBe(10);
  });

  it("pause: off for real-time action, anyone for strategy, host when the host runs the world, none for turns", () => {
    const pause = (s) => recommend({ description: s }).answers.find((r) => r[0] === "session.pause")?.[1];
    expect([pause("deterministic party minigames"), pause("deterministic RTS"), pause("4 player shooter"), pause("co-op survival sandbox"), pause("chess")]).toEqual(["off", "anyone", "off", "host", undefined]);
    expect(pause("deterministic RTS where the host runs the world")).toBe("host");
  });

  it("lockstep without the word deterministic asks the determinism question; with it, not", () => {
    const ids = (s) => recommend({ description: s }).questions.map((q) => q.id);
    expect(ids("4 player party minigames in Godot")).toContain("determinism");
    expect(ids("deterministic party minigames in Godot with GDScript at 30 ticks per second for 4 players")).toEqual([]);
    const q = recommend({ description: "party minigames" }).questions.find((x) => x.id === "determinism");
    expect(q.question).toMatch(/fixed tick/);
    expect(q.question).toMatch(/seeded/);
    expect(q.question).toMatch(/wall clock/);
  });

  it("a game that says it is not deterministic never gets lockstep (the determinism question's own words)", () => {
    for (const s of [
      "4 player party minigames in Godot, not deterministic",
      "a non-deterministic party game in Godot with GDScript",
      "nondeterministic rts for 4",
      "party minigames on a fixed tick, but the simulation isn't deterministic",
      "a party game that is not fully deterministic",
    ]) {
      const rec = recommend({ description: s });
      expect(rec.shape, s).not.toBe("lockstep");
      expect(rec.answers.find((r) => r[0] === "sync.mode")?.[1], s).not.toBe("lockstep");
      expect(rec.matched.map((m) => m.toLowerCase()), s).not.toContain("deterministic");
    }
    const rec = recommend({ description: "4 player party minigames in Godot, not deterministic" });
    expect(rec.shape).toBe("replication");
    expect(rec.notes.join(" ")).toMatch(/not deterministic, so lockstep is out/);
    expect(rec.questions.map((q) => q.id)).not.toContain("determinism");
  });

  it("a denied word does not count: no physics, not a shooter, no spectators", () => {
    expect(recommend({ description: "deterministic party game with no physics in Godot" }).notes).toEqual([]);
    expect(recommend({ description: "a card game, not a shooter" }).shape).toBe("turn-based");
    expect(recommend({ description: "online card game with no spectators" }).answers.find((r) => r[0] === "room.spectators")).toBeUndefined();
  });

  it("a number after 'for' that counts something else is not the player count; 'web socket' is not the browser", () => {
    const p = (s) => readPlayers(s)?.max ?? null;
    expect([p("a card game for 3 rounds"), p("for 10 minutes"), p("for 2 teams"), p("for 5"), p("for 6 friends")]).toEqual([null, null, null, 5, 6]);
    const e = (s) => detectEngine(s)?.id ?? null;
    expect([e("its own server loop over a web socket"), e("a web game"), e("web sockets in the browser")]).toEqual([null, "web", "web"]);
  });

  it("never recommends lockstep for Unity physics, even when told it is deterministic", () => {
    for (const s of ["deterministic Unity physics game", "lockstep RTS in Unity with physics", "deterministic ragdoll brawler in Unity", "deterministic racing in Unity"]) expect(recommend({ description: s }).shape).not.toBe("lockstep");
    expect(recommend({ description: "deterministic physics party game in Godot" }).shape).toBe("lockstep"); // only Unity is banned outright
  });
});

describe("the data", () => {
  it("every engine value of the schema has a row, and nothing else", () => {
    expect(Object.keys(ENGINES).sort()).toEqual([...schema.properties.engine.enum].sort());
  });

  it("every key a shape can propose exists in the schema", () => {
    const has = (dotted) => dotted.split(".").reduce((node, k) => node?.properties?.[k], schema) !== undefined;
    for (const s of SHAPES) {
      for (const text of [`${s.id}`, ...SENTENCES.filter((x) => x[1] === s.id).map((x) => x[0])]) for (const [key] of recommend({ description: `${text} spectators` }).answers) expect(has(key), key).toBe(true);
    }
  });

  it("advice only names shapes and features that exist, and every fixed or feature status is one of the three", () => {
    const ids = new Set(SHAPES.map((s) => s.id));
    for (const a of ADVICE) {
      for (const s of a.shapes) expect(ids.has(s)).toBe(true);
      if (a.status.feature) expect(FEATURE_PROOF[a.status.feature]).toBeTruthy();
      else expect(["built-in", "by-hand"]).toContain(a.status.fixed);
      expect(existsSync(join(repo, a.doc)), a.doc).toBe(true);
    }
  });
});

describe("engine limits: every shape on every engine loads, and no feature is claimed that the engine lacks", () => {
  const SAMPLE = {
    lockstep: "deterministic party minigames for 4",
    "coop-snapshots": "co-op survival sandbox for 4 with spectators",
    replication: "4 player first-person shooter",
    "turn-based": "online card game for 4",
    "own-server": "a game with its own server loop for 4",
  };
  for (const shape of SHAPES.map((s) => s.id)) {
    for (const engine of Object.keys(ENGINES)) {
      it(`${shape} on ${engine}: the answers pass the real loader`, async () => {
        const rec = recommend({ description: SAMPLE[shape], engine: { id: engine, from: "template" } });
        expect(rec.shape).toBe(shape);
        const answers = { game: { id: "com.example.t" }, engine };
        for (const [k, v] of rec.answers) setPath(answers, k, v);
        await validate(answers);
        // a mode the template cannot write is replaced by the nearest one and says so in plain words
        const mode = rec.answers.find((r) => r[0] === "sync.mode")[1];
        expect(ENGINES[engine].modes).toContain(mode);
        for (const l of rec.limits) {
          expect(l.got).toBe(mode);
          expect(l.why).toMatch(/Nearest mode it can write/);
        }
      });
    }
  }

  it("who places a player: the replication shape proposes host, coop-snapshots owner, the others nothing (and only with sync.mode replication)", () => {
    const row = (description, engine) => recommend({ description, engine: { id: engine, from: "template" } }).answers.find((r) => r[0] === "sync.player.authority");
    expect(row("4 player first-person shooter", "godot-csharp")[1]).toBe("host");
    expect(row("a survival sandbox, free roam, co op", "unity")[1]).toBe("owner");
    expect(row("deterministic party minigames", "godot-gdscript")).toBeUndefined();
    expect(row("turn based chess", "dotnet")).toBeUndefined();
    // the web template cannot write replication, so the nearest mode is raw and there is no player key to propose
    expect(row("4 player first-person shooter", "web")).toBeUndefined();
  });

  it("prediction and hit rewind are built in only where the client has them; asWebSocket only in JS", () => {
    for (const [engine, e] of Object.entries(ENGINES)) {
      const rec = recommend({ description: "4 player first-person shooter", engine: { id: engine, from: "template" } });
      const status = (id) => rec.advice.find((a) => a.id === id)?.status;
      expect(status("predict-own-actions")).toBe(e.features.prediction ? "built-in" : "by-hand");
      expect(status("hit-rewind")).toBe(e.features.hitRewind ? "built-in" : "by-hand");
      const own = recommend({ description: "its own server loop", engine: { id: engine, from: "template" } });
      expect(own.advice.find((a) => a.id === "as-websocket").status).toBe(e.features.asWebSocket ? "built-in" : "by-hand");
    }
    expect(Object.entries(ENGINES).filter(([, e]) => e.features.prediction).map(([k]) => k).sort()).toEqual(["dotnet", "godot-csharp", "node-browser", "unity", "web"]);
    expect(Object.entries(ENGINES).filter(([, e]) => e.features.asWebSocket).map(([k]) => k).sort()).toEqual(["node-browser", "web"]);
  });

  it("lockstep never claims the fast-channel input repeat or an adaptive delay is built in", () => {
    for (const engine of Object.keys(ENGINES)) {
      const rec = recommend({ description: "deterministic party minigames", engine: { id: engine, from: "template" } });
      for (const id of ["lockstep-fast-inputs", "adaptive-input-delay"]) expect(rec.advice.find((a) => a.id === id).status).toBe("by-hand");
      expect(rec.advice.find((a) => a.id === "bots-take-seats").status).toBe("built-in");
    }
  });

  it("with no engine, every engine-dependent row is 'depends' and the differences are listed instead of a guess", () => {
    const rec = recommend({ description: "4 player first-person shooter" });
    expect(rec.engine).toMatchObject({ id: null, from: "none" });
    expect(rec.advice.filter((a) => a.status === "depends").map((a) => a.id)).toEqual(["predict-own-actions", "hit-rewind"]);
    expect(rec.answers.some((r) => r[0].startsWith("hosting."))).toBe(false);
    expect(rec.differences.map((d) => d.topic)).toEqual(expect.arrayContaining(["hosting", "sync.mode", "predict-own-actions", "hit-rewind"]));
    expect(rec.questions.map((q) => q.id)).toContain("engine");
    expect(rec.runCommand).toBeNull();
  });

  it("hosting: direct with codes where the engine can listen, a lobby server for a browser page", () => {
    const h = (engine) => Object.fromEntries(recommend({ description: "online card game", engine: { id: engine, from: "template" } }).answers.filter((r) => r[0].startsWith("hosting.")).map((r) => [r[0], r[1]]));
    expect(h("godot-gdscript")).toEqual({ "hosting.direct": true, "hosting.server": false });
    expect(h("unity")).toEqual({ "hosting.direct": true, "hosting.server": false });
    expect(h("web")).toEqual({ "hosting.direct": false, "hosting.server": true });
  });

  it("the engine comes from --template first, then the text, else it is unknown", async () => {
    expect((await json(["--recommend", "card game in Unity", "--template", "godot-gdscript"])).json.engine).toMatchObject({ id: "godot-gdscript", from: "template" });
    expect((await json(["--recommend", "card game in Unity"])).json.engine).toMatchObject({ id: "unity", from: "text", words: ["Unity"] });
    expect((await json(["--recommend", "card game"])).json.engine).toMatchObject({ id: null, from: "none" });
    expect((await json(["--recommend", "card game", "--template", "nope"])).json.error.code).toBe("bad_flag");
  });

  it("a planned template gives the proposal and no command (it would stop with template_planned)", async () => {
    const r = await json(["--recommend", "4 player shooter in MonoGame"]);
    expect(r.code).toBe(0);
    expect(r.json.runCommand).toBeNull();
    expect(r.json.flags).toContain("--mode");
    expect(r.json.notes.join(" ")).toMatch(/template is planned/);
  });
});

describe("godot-csharp is a built template", () => {
  it("the ENGINES table says built exactly for the templates the scaffolder writes", () => {
    expect(Object.entries(ENGINES).filter(([, e]) => e.template === "built").map(([k]) => k).sort()).toEqual([...IMPLEMENTED_TEMPLATES].sort());
    expect(ENGINES["godot-csharp"].template).toBe("built");
  });

  it("a proposal for a C# game carries a real run command that names the template, and no 'planned' note", async () => {
    const r = await json(["--recommend", "4 player shooter in Godot with C#"]);
    expect(r.json.engine).toMatchObject({ id: "godot-csharp", template: "built" });
    expect(r.json.runCommand).toMatch(/^npx create-onelobby my-game --template godot-csharp .*--yes$/);
    expect(r.json.notes.join(" ")).not.toMatch(/template is planned/);
    expect(r.out ?? "").not.toMatch(/planned, not built/);
  });

  it("fills a scaffold run on the template, and keeps the dropped list when a flag replaced sync.mode", async () => {
    const r = await json(["g", "--template", "godot-csharp", "--recommend", "4 player party minigames", "--mode", "raw", "--yes", "--dry-run", "--no-natives"]);
    expect(r.code).toBe(0);
    expect(r.json.template).toBe("godot-csharp");
    expect(r.json.blueprint).toMatchObject({ engine: "godot-csharp", sync: { mode: "raw" }, lobby: { maxPlayers: 4 } });
    expect(r.json.recommendation.dropped.map((d) => d.key).sort()).toEqual(["sync.hashEveryTicks", "sync.tickRate"]);
    expect(r.json.recommendation.engine).toMatchObject({ id: "godot-csharp", from: "template" });
    const byText = await json(["g", "--recommend", "co-op survival sandbox in Godot with C#", "--yes", "--dry-run", "--no-natives"]);
    expect(byText.json.template).toBe("godot-csharp");
  });
});

describe("alone: writes nothing, needs no folder", () => {
  it("prints the shape, matched words, table, advice, questions and a command, and leaves the folder empty", async () => {
    const r = await cli(["--recommend", "4 player party minigames in Godot"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Game shape: lockstep/);
    expect(r.out).toMatch(/matched: "party", "minigames"/);
    expect(r.out).toMatch(/sync\.mode\s+lockstep\s+every peer runs the same fixed-tick simulation/);
    expect(r.out).toMatch(/\[by-hand\] Send inputs on the fast channel/);
    expect(r.out).toMatch(/Open questions/);
    expect(r.out).toMatch(/npx create-onelobby my-game --template godot-gdscript --hosting direct --mode lockstep --tick-rate 20 --set sync.hashEveryTicks=60 --max-players 4 --pause off --yes/);
    expect(readdirSync(cwd)).toEqual([]);
    expect(r.err).toBe("");
  });

  it("unknown: no table, the five shapes, the questions, exit 0", async () => {
    const r = await cli(["--recommend", "Ein Kartenspiel fuer vier Spieler online"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Game shape: unknown/);
    for (const s of SHAPES) expect(r.out).toContain(s.id);
    expect(r.out).not.toMatch(/Proposal \(blueprint key/);
    expect(r.out).toMatch(/What kind of game is it/);
  });

  it("the command it prints is a real command: every flag in it exists and the dry run it makes loads", async () => {
    for (const [text] of SENTENCES.filter((s) => s[1] && s[1] !== "replication")) {
      const rec = recommend({ description: text, engine: { id: "godot-gdscript", from: "template" } });
      const args = rec.runCommand.split(" ").slice(2).filter((a) => a !== "--yes");
      const r = await json([...args.map((a) => a.replace(/^"|"$/g, "")), "--dry-run", "--no-natives", "--yes"]);
      expect(r.json.ok, `${text}: ${r.out}`).toBe(true);
    }
  });
});

describe("with a scaffold run", () => {
  const dry = (extra, tpl = ["--template", "godot-gdscript"]) => json(["g", ...tpl, "--yes", "--dry-run", "--no-natives", ...extra]);

  it("the recommendation beats the built-in defaults", async () => {
    const r = await json(["g", "--template", "web", "--recommend", "online card game for 6", "--yes", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.json.blueprint.sync.mode).toBe("raw"); // the web default is lockstep
    expect(r.json.blueprint.lobby.maxPlayers).toBe(6);
    expect(r.json.recommendation.shape).toBe("turn-based");
    expect(r.json.recommendation.applied.map((a) => a[0])).toEqual(expect.arrayContaining(["sync.mode", "lobby.maxPlayers"]));
    for (const [, , why] of r.json.recommendation.applied) expect(why.length).toBeGreaterThan(10);
  });

  it("explicit flags and --set beat the recommendation", async () => {
    const r = await dry(["--recommend", "co-op survival sandbox for 4", "--max-players", "7", "--set", "sync.tickRate=25"]);
    expect(r.json.blueprint.lobby.maxPlayers).toBe(7);
    expect(r.json.blueprint.sync.tickRate).toBe(25);
    expect(r.json.blueprint.sync.mode).toBe("replication"); // not given: from the recommendation
    expect(r.json.recommendation.applied.map((a) => a[0])).not.toContain("lobby.maxPlayers");
    expect(r.json.recommendation.overridden).toEqual(
      expect.arrayContaining([
        { key: "lobby.maxPlayers", value: 7, recommended: 4, by: "a flag" },
        { key: "sync.tickRate", value: 25, recommended: 15, by: "a flag" },
      ]),
    );
  });

  it("--from beats the recommendation, and flags beat --from", async () => {
    writeFileSync(join(cwd, "b.json"), JSON.stringify({ game: { id: "com.example.b" }, sync: { mode: "raw", tickRate: 12 }, lobby: { maxPlayers: 3 } }));
    const r = await dry(["--recommend", "co-op survival sandbox for 4", "--from", "b.json", "--tick-rate", "30"]);
    expect(r.json.blueprint.sync).toMatchObject({ mode: "raw", tickRate: 30 });
    expect(r.json.blueprint.lobby.maxPlayers).toBe(3);
    expect(r.json.recommendation.overridden.map((o) => `${o.key}:${o.by}`).sort()).toEqual(["lobby.maxPlayers:--from", "sync.mode:--from", "sync.tickRate:a flag"]);
    expect(r.json.recommendation.applied.map((a) => a[0])).toEqual(expect.arrayContaining(["session.pause", "hosting.direct"]));
  });

  it("a replaced sync.mode leaves out the other sync values that were proposed for the recommended mode", async () => {
    const r = await dry(["--recommend", "4 player party minigames", "--mode", "raw"]);
    expect(r.code).toBe(0);
    expect(r.json.blueprint.sync.mode).toBe("raw");
    expect(r.json.recommendation.applied.map((a) => a[0]).filter((k) => k.startsWith("sync."))).toEqual([]);
    expect(r.json.recommendation.dropped.map((d) => d.key).sort()).toEqual(["sync.hashEveryTicks", "sync.tickRate"]);
    expect(r.json.recommendation.dropped[0].why).toMatch(/proposed for sync\.mode lockstep, and sync\.mode is raw/);
    expect(r.json.recommendation.overridden).toEqual([{ key: "sync.mode", value: "raw", recommended: "lockstep", by: "a flag" }]);
    expect(r.json.recommendation.applied.map((a) => a[0])).toEqual(expect.arrayContaining(["lobby.maxPlayers", "session.pause"])); // not sync: still applied
    const same = await dry(["--recommend", "4 player party minigames", "--mode", "lockstep"]);
    expect(same.json.recommendation.dropped).toEqual([]);
    expect(same.json.recommendation.applied.map((a) => a[0])).toEqual(expect.arrayContaining(["sync.tickRate", "sync.hashEveryTicks"]));
    const text = await cli(["g", "--template", "godot-gdscript", "--yes", "--dry-run", "--no-natives", "--recommend", "4 player party minigames", "--mode", "raw"]);
    expect(text.out).toMatch(/left out sync\.tickRate = 20: it was proposed for sync\.mode lockstep/);
  });

  it("--dry-run --json lists the keys that came from the recommendation with their reasons, and writes nothing", async () => {
    const r = await dry(["--recommend", "4 player wave survival first-person shooter"]);
    expect(r.json.dryRun).toBe(true);
    expect(r.json.recommendation).toMatchObject({ shape: "replication", matched: ["first-person shooter"] });
    expect(Object.fromEntries(r.json.recommendation.applied.map(([k, v]) => [k, v]))).toMatchObject({ "sync.mode": "replication", "sync.tickRate": 30, "lobby.maxPlayers": 4, "session.pause": "off" });
    expect(r.json.recommendation.applied.every((a) => a.length === 3 && typeof a[2] === "string")).toBe(true);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("the text output names the keys and repeats each one's why", async () => {
    const r = await cli(["g", "--template", "godot-gdscript", "--recommend", "co-op survival sandbox for 4", "--max-players", "6", "--yes", "--dry-run", "--no-natives"]);
    expect(r.out).toMatch(/From the recommendation \(coop-snapshots\):/);
    expect(r.out).toMatch(/sync\.mode\s+replication\s+the host runs the world and sends binary delta snapshots/);
    expect(r.out).toMatch(/kept lobby\.maxPlayers = 6 from a flag \(the recommendation said 4\)/);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("a recommendation the template cannot write gives the plain sentence and the nearest mode, not an error", async () => {
    const r = await json(["g", "--template", "web", "--recommend", "4 player first-person shooter", "--yes", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.json.blueprint.sync.mode).toBe("raw");
    expect(r.json.recommendation.limits).toHaveLength(1);
    expect(r.json.recommendation.limits[0]).toMatchObject({ key: "sync.mode", wanted: "replication", got: "raw" });
    expect(r.json.recommendation.limits[0].why).toMatch(/web template writes the lockstep and raw sample game only/);
    const text = await cli(["g", "--template", "web", "--recommend", "4 player first-person shooter", "--yes", "--dry-run"]);
    expect(text.out).toMatch(/the template cannot write replication yet/);
    // asking for the refused mode by hand is still the scaffolder's own error
    expect((await json(["g", "--template", "web", "--mode", "replication", "--yes", "--dry-run"])).json.error.code).toBe("unsupported");
  });

  it("every shape scaffolds in a dry run on the templates built today (the same list as ENGINES)", async () => {
    for (const [shape, text] of [["lockstep", "deterministic party minigames"], ["coop-snapshots", "co-op survival sandbox"], ["replication", "first-person shooter"], ["turn-based", "chess"], ["own-server", "its own server loop"]]) {
      for (const tpl of ["web", "godot-gdscript", "godot-csharp"]) {
        const r = await json(["g", "--template", tpl, "--recommend", text, "--yes", "--dry-run", "--no-natives"]);
        expect(r.code, `${shape} on ${tpl}: ${r.out}`).toBe(0);
        expect(r.json.recommendation.shape).toBe(shape);
      }
    }
  });

  it("a description that names a built engine picks the template when none was given; a planned one stops as template_planned", async () => {
    const g = await json(["g", "--recommend", "co-op survival sandbox in Godot", "--yes", "--dry-run", "--no-natives"]);
    expect(g.json.template).toBe("godot-gdscript");
    expect(g.json.recommendation.engine).toMatchObject({ from: "text" });
    expect((await json(["g", "--recommend", "co-op survival sandbox in MonoGame", "--yes", "--dry-run"])).json.error.code).toBe("template_planned");
    const plain = await json(["g", "--recommend", "online card game", "--yes", "--dry-run"]);
    expect(plain.json.template).toBe("web");
    expect(plain.json.recommendation.engine).toMatchObject({ id: "web", from: "default" });
  });

  it("really writes the project with the recommended blueprint (--into a web folder)", async () => {
    mkdirSync(join(cwd, "p"));
    const r = await json(["--into", "p", "--template", "web", "--recommend", "chess", "--yes"]);
    expect(r.code).toBe(0);
    const bp = JSON.parse(readFileSync(join(cwd, "p/onelobby.json"), "utf8"));
    expect(bp.sync.mode).toBe("raw");
    expect(bp.lobby.maxPlayers).toBe(2);
  });

  it("update and verify do not take --recommend", async () => {
    expect((await json(["update", "--recommend", "x"])).json.error.code).toBe("bad_flag");
  });
});

describe("on a terminal", () => {
  const prompts = (out) => out.split("\n").filter((l) => /\[|\(/.test(l));
  it("asks ONE first question for the description and shows the recommended values as the later defaults", async () => {
    const r = await cli(["--template", "web", "--dry-run"], { tty: true, input: ["online card game for 6\n", "my-game\n"] });
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toMatch(/^Describe your game in one line \(Enter to skip\): Project name/);
    expect(r.out).toMatch(/Max players.*|Seats, host included\. \(6\)/);
    expect(r.out).toMatch(/\[lockstep\/raw\] \(raw\)/); // the sync.mode prompt now defaults to the recommendation
    expect(r.out).toMatch(/From the recommendation \(turn-based\)/);
    expect(prompts(r.out).length).toBeGreaterThan(3);
  });

  it("Enter on a later prompt takes the recommended value; typing one wins", async () => {
    // description, project name, game id, title, (hosting is not asked for web) lobby server, max players typed 5, then Enters
    const input = ["online card game for 6\n", "g\n", "com.example.g\n", "\n", "\n", "5\n"];
    const r = await json(["--template", "web", "--dry-run"], { tty: true, input });
    expect(r.json.blueprint.lobby.maxPlayers).toBe(5);
    expect(r.json.blueprint.sync.mode).toBe("raw");
    expect(r.json.recommendation.overridden).toEqual(expect.arrayContaining([{ key: "lobby.maxPlayers", value: 5, recommended: 6, by: "your answer" }]));
  });

  it("Enter to skip the description: no recommendation, nothing changes", async () => {
    const r = await json(["--template", "web", "--dry-run"], { tty: true, input: ["\n", "g\n", "com.example.g\n"] });
    expect(r.json.recommendation).toBeUndefined();
    expect(r.json.blueprint.sync.mode).toBe("lockstep");
  });

  it("--recommend on a terminal skips the description question; --yes and --no-input never ask", async () => {
    const asked = await cli(["g", "--template", "web", "--recommend", "chess", "--dry-run"], { tty: true, input: ["com.example.g\n"] });
    expect(asked.out).not.toMatch(/Describe your game/);
    for (const flag of ["--yes", "--no-input"]) {
      const r = await cli(["g", "--template", "web", "--dry-run", "--game-id", "com.example.g", flag], { tty: true, input: [] });
      expect(r.out).not.toMatch(/Describe your game/);
    }
  });
});

describe("the JSON contract", () => {
  const SAMPLE = "4 player party minigames in Godot";
  const expected = JSON.parse(readFileSync(join(here, "fixtures/recommend-party.json"), "utf8"));

  it("is one object, and its full shape for one sentence is pinned", async () => {
    const r = await cli(["--recommend", SAMPLE, "--json"]);
    expect(r.out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(r.out)).toEqual(expected);
  });

  it("every field the README documents is present, and every field present is documented", async () => {
    const readme = readFileSync(join(pkg, "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("#### JSON fields"));
    const rows = [...section.slice(0, section.indexOf("\n#", 5) > 0 ? section.indexOf("\n#", 5) : undefined).matchAll(/^\| `([\w.]+)` \|/gm)].map((m) => m[1]);
    expect(rows.length).toBeGreaterThan(10);
    const samples = [
      JSON.parse((await cli(["--recommend", SAMPLE, "--json"])).out),
      JSON.parse((await cli(["--recommend", "a puzzle game", "--json"])).out),
      JSON.parse((await cli(["--recommend", "4 player first-person shooter", "--json"])).out), // no engine: differences
    ];
    const paths = (o, prefix = "") => Object.entries(o).flatMap(([k, v]) => [`${prefix}${k}`, ...(v && typeof v === "object" && !Array.isArray(v) ? paths(v, `${prefix}${k}.`) : [])]);
    const present = new Set(samples.flatMap((s) => paths(s)));
    for (const row of rows) expect(present.has(row), `documented but never present: ${row}`).toBe(true);
    for (const p of present) expect(rows.includes(p), `present but not documented: ${p}`).toBe(true);
    // answers and advice rows keep their shape
    for (const s of samples) for (const a of s.answers) expect([a.length, typeof a[0], typeof a[2]]).toEqual([3, "string", "string"]);
    for (const a of samples[0].advice) expect(Object.keys(a).sort()).toEqual(["doc", "how", "id", "status", "text", "why"]);
    for (const q of samples[0].questions) expect(Object.keys(q).sort()).toEqual(["add", "id", "question"]);
  });

  it("the scaffold run's recommendation block has the documented fields", async () => {
    const r = await json(["g", "--template", "godot-gdscript", "--recommend", SAMPLE, "--max-players", "6", "--yes", "--dry-run", "--no-natives"]);
    expect(Object.keys(r.json.recommendation).sort()).toEqual(["applied", "description", "dropped", "engine", "limits", "matched", "notes", "overridden", "questions", "shape"]);
  });
});

describe("the doc and the data cannot diverge", () => {
  const oneShot = readFileSync(join(repo, "docs/design/one-shot.md"), "utf8");
  const sec5 = oneShot.slice(oneShot.indexOf("## 5. Architecture recommendation"), oneShot.indexOf("## 6. Proof"));
  it("every shape id of the data is a row id in one-shot.md section 5, and every row id is a shape", () => {
    const ids = [...sec5.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]);
    expect(ids).toEqual(SHAPES.map((s) => s.id));
  });
  it("the README lists the same five ids", () => {
    const readme = readFileSync(join(pkg, "README.md"), "utf8");
    for (const s of SHAPES) expect(readme).toContain(`\`${s.id}\``);
  });
  it("the text output of every shape mentions its id", () => {
    for (const [text, shape] of SENTENCES.filter((s) => s[1])) expect(renderText(recommend({ description: text }))).toContain(`Game shape: ${shape}`);
  });
});
