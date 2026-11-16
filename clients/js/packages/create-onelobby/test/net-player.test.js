// The networked player in the two Godot templates (sync.player): when a game gets it, what it gets, what update and verify do with it, and
// the proof that a game made without it is exactly what it was before. No network, no Godot, no dotnet.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";
import { answersWantNetPlayer, pickBlocks, playerFlags, resolveNetPlayer } from "../src/net-player.js";
import { NET_PLAYER_DIR, verifyPin } from "../src/vendor.js";
import { hasNetPlayer, playerCheck } from "../src/verify/wiring.js";
import { fixtureNativesZip } from "./helpers/zip.js";

let cwd;
const NET_FILES = { "OneLobbyNetPlayer.cs": "public partial class OneLobbyNetPlayer {}\n", "OneLobbyNetPlayerSpawner.cs": "public partial class OneLobbyNetPlayerSpawner {}\n" };
function writeCheckout(root, netFiles = NET_FILES) {
  const menu = join(root, "clients/dotnet/demo-godot/addons/onelobby_menu");
  mkdirSync(menu, { recursive: true });
  writeFileSync(join(menu, "OneLobbyMenu.cs"), "public partial class OneLobbyMenu {}\n");
  writeFileSync(join(menu, "OneLobbyMenu.cs.uid"), "uid://abc\n");
  writeFileSync(join(menu, "OneLobbyMenu.tscn"), "[gd_scene format=3]\n");
  const net = join(root, "clients/dotnet/demo-godot/addons/onelobby_net_player");
  mkdirSync(net, { recursive: true });
  for (const [name, body] of Object.entries(netFiles)) writeFileSync(join(net, name), body);
}
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-netplayer-"));
  writeCheckout(join(cwd, "checkout"));
  writeCheckout(join(cwd, "checkout2"), { "OneLobbyNetPlayer.cs": "public partial class OneLobbyNetPlayer { int v = 2; }\n", "OneLobbyNetPlayerSpawner.cs": NET_FILES["OneLobbyNetPlayerSpawner.cs"], "Extra.cs": "// new\n" });
  writeFileSync(join(cwd, "natives.zip"), fixtureNativesZip());
  mkdirSync(join(cwd, "feed"));
  for (const id of ["OneLobby.Core", "OneLobby.Godot", "OneLobby.Direct", "OneLobby.Opus", "OneLobby.Replication"]) writeFileSync(join(cwd, `feed/${id}.0.7.2-dev.9.nupkg`), "x");
  mkdirSync(join(cwd, "feed-no-replication"));
  for (const id of ["OneLobby.Core", "OneLobby.Godot", "OneLobby.Direct", "OneLobby.Opus"]) writeFileSync(join(cwd, `feed-no-replication/${id}.0.7.2-dev.9.nupkg`), "x");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const GODOT_ANSWER = "4.7.2.stable.mono.official.ed1daf0bf\n";
async function cli(args) {
  let out = "";
  let err = "";
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, stdin: Readable.from([""]), stdinIsTTY: false, env: {}, cwd, godotVersion: () => GODOT_ANSWER };
  const code = await main(args, io);
  return { code, out, err };
}
const j = async (args) => {
  const r = await cli([...args, "--json"]);
  return { ...r, json: JSON.parse(r.out) };
};
const at = (...p) => join(cwd, ...p);
const text = (...p) => readFileSync(at(...p), "utf8");
const tree = (dir, rel = "") => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`])).sort();
const GD = ["--template", "godot-gdscript", "--yes", "--no-git", "--no-natives"];
const CS = ["--template", "godot-csharp", "--yes", "--no-git", "--no-natives", "--addon-from", "checkout", "--packages-from", "feed"];
const PLAYER_OWNER = ["--mode", "replication", "--set", "sync.player.authority=owner"];
const PLAYER_HOST_2D = ["--mode", "replication", "--set", "sync.player.authority=host", "--set", "sync.player.space=2d"];

describe("a game without sync.player is exactly what it was before", () => {
  // fixtures/no-player-golden.json: the SHA-256 of every file the templates write (not the vendored add-ons) for four scaffolds, made with
  // the scaffolder as it was before the networked player existed (commit ea1e5ed of the dev repo). The same four must still match, byte for byte.
  const golden = JSON.parse(readFileSync(new URL("./fixtures/no-player-golden.json", import.meta.url), "utf8"));
  const scenarios = {
    gd: ["--template", "godot-gdscript"],
    "gd-replication": ["--template", "godot-gdscript", "--mode", "replication"],
    cs: ["--template", "godot-csharp", "--packages-from", "feed", "--addon-from", "checkout"],
    "cs-replication": ["--template", "godot-csharp", "--mode", "replication", "--packages-from", "feed", "--addon-from", "checkout"],
  };
  for (const [name, args] of Object.entries(scenarios)) {
    it(`${name}: the same files with the same bytes`, async () => {
      const r = await cli([`${name}/my-game`, ...args, "--yes", "--no-git", "--no-natives"]);
      expect(r.code).toBe(0);
      const root = at(name, "my-game");
      const got = Object.fromEntries(tree(root).filter((p) => !p.startsWith("addons/")).map((p) => [p, createHash("sha256").update(readFileSync(join(root, p))).digest("hex")]));
      expect(got).toEqual(golden[name]);
      expect(existsSync(join(root, "player.tscn"))).toBe(false);
      expect(existsSync(join(root, NET_PLAYER_DIR))).toBe(false);
    });
  }

  it("--yes alone and replication alone do not turn the player on; a sync.player answer does", async () => {
    expect(answersWantNetPlayer({ sync: { mode: "replication" } })).toBe(false);
    expect(answersWantNetPlayer({ sync: { mode: "lockstep", player: { authority: "host" } } })).toBe(false);
    expect(answersWantNetPlayer({ sync: { mode: "replication", player: { authority: "host" } } })).toBe(true);
    const plain = await j(["g1", ...GD, "--mode", "replication", "--dry-run"]);
    expect(plain.json.netPlayer).toBeUndefined();
    expect(plain.json.files).not.toContain("player.tscn");
    expect(plain.json.blueprint.sync.player).toBeDefined(); // the loader fills it either way: the written file cannot tell
  });
});

describe("godot-gdscript with sync.player", () => {
  it("a new project gets the character, the game and a check; the menu opens the game", async () => {
    const r = await j(["my-game", ...GD, ...PLAYER_OWNER]);
    expect(r.code).toBe(0);
    expect(r.json.netPlayer).toEqual({ authority: "owner", space: "3d" });
    for (const p of ["player.tscn", "player.gd", "game.gd", "main.gd", "main.tscn", "tests/multiplayer.gd", "AGENTS.md"]) expect(r.json.files).toContain(p);
    const without = await j(["other", ...GD, "--mode", "replication", "--dry-run"]);
    expect(r.json.files.filter((p) => !without.json.files.includes(p) && !p.startsWith(".olc"))).toEqual(["player.tscn", "player.gd", "game.gd"]);
    expect(text("my-game/main.gd")).toContain("const Game := preload(\"res://game.gd\")");
    expect(text("my-game/main.gd")).toContain("menu.game_started.connect");
    expect(text("my-game/game.gd")).toContain("OneLobbyNetPlayerSpawner.new()");
    expect(text("my-game/game.gd")).toContain("StaticBody3D.new()");
    expect(text("my-game/game.gd")).toContain("Camera3D.new()");
    expect(text("my-game/game.gd")).not.toContain("step_function"); // owner: no step
    expect(text("my-game/player.tscn")).toContain("addons/onelobby/net_player.gd");
    expect(text("my-game/player.tscn")).toContain("CharacterBody3D");
  });

  it("owner authority: the script moves the body and says so; host authority: set_input and a step function and says so", async () => {
    await cli(["o", ...GD, ...PLAYER_OWNER]);
    const owner = text("o/player.gd");
    expect(owner).toContain('Authority "owner"');
    expect(owner).toContain("move_and_slide()");
    expect(owner).toContain("net.jump()");
    expect(owner).not.toContain("net.set_input");
    expect(owner).not.toMatch(/#@/);
    await cli(["h", ...GD, "--mode", "replication", "--set", "sync.player.authority=host"]);
    const host = text("h/player.gd");
    expect(host).toContain('Authority "host"');
    expect(host).toContain("net.set_input(");
    expect(host).toContain("static func step(");
    expect(host).not.toContain("move_and_slide");
    expect(host).not.toMatch(/#@/);
    expect(text("h/game.gd")).toContain("spawner.step_function = PlayerScript.step");
    expect(text("h/AGENTS.md")).toContain('"host"');
  });

  it("2d space writes a CharacterBody2D, a square and a 2d game", async () => {
    await cli(["d", ...GD, ...PLAYER_HOST_2D]);
    expect(text("d/player.tscn")).toContain("CharacterBody2D");
    expect(text("d/player.tscn")).not.toContain("3D");
    expect(text("d/player.gd")).toContain("extends CharacterBody2D");
    expect(text("d/game.gd")).toContain("extends Node2D");
    expect(text("d/game.gd")).toContain("Camera2D.new()");
  });

  it("the generated two-peer test keeps its verdict line and adds the player check before the peers leave", async () => {
    await cli(["t", ...GD, ...PLAYER_OWNER]);
    const t = text("t/tests/multiplayer.gd");
    expect(t).toContain('print("MULTIPLAYER_OK")');
    expect(t.indexOf("_check_player(hl, gl)")).toBeGreaterThan(t.indexOf("wrong message"));
    expect(t.indexOf("_check_player(hl, gl)")).toBeLessThan(t.indexOf("gl.leave()"));
    expect(t).toContain("func _check_player(");
    expect(t).toContain("jumped.connect");
    expect(t).not.toContain("set_input"); // owner: the owner places its own player
    expect(t).not.toMatch(/#@/);
    await cli(["t2", ...GD, ...PLAYER_HOST_2D]);
    const t2 = text("t2/tests/multiplayer.gd");
    expect(t2).toContain("set_input(");
    expect(t2).toContain("Vector2(float(peer) * 80.0");
    expect(t2).toContain("sp.step_function = load(\"res://player.gd\").step");
  });

  it("the recommendation reaches the template: a co-op sentence turns the player on (owner), a lockstep one does not", async () => {
    const coop = await j(["c", ...GD, "--recommend", "co-op survival sandbox for 4", "--dry-run"]);
    expect(coop.json.netPlayer).toEqual({ authority: "owner", space: "3d" });
    expect(coop.json.files).toContain("player.tscn");
    const shooter = await j(["s", ...GD, "--recommend", "4 player shooter with hitscan", "--dry-run"]);
    expect(shooter.json.netPlayer).toEqual({ authority: "host", space: "3d" });
    const party = await j(["p", ...GD, "--recommend", "4 player party minigames", "--dry-run"]);
    expect(party.json.netPlayer).toBeUndefined();
    expect(party.json.files).not.toContain("player.tscn");
  });

  it("a --from file with sync.player turns it on; one without does not", async () => {
    writeFileSync(at("on.json"), JSON.stringify({ game: { id: "com.example.on" }, sync: { mode: "replication", player: { authority: "host", space: "2d" } } }));
    writeFileSync(at("off.json"), JSON.stringify({ game: { id: "com.example.off" }, sync: { mode: "replication" } }));
    expect((await j(["a", ...GD, "--from", "on.json", "--dry-run"])).json.netPlayer).toEqual({ authority: "host", space: "2d" });
    expect((await j(["b", ...GD, "--from", "off.json", "--dry-run"])).json.netPlayer).toBeUndefined();
  });

  it("--into writes no scene into the game: it prints the spawner lines; a second run changes nothing", async () => {
    mkdirSync(at("into"));
    writeFileSync(at("into/project.godot"), 'config_version=5\n\n[application]\n\nconfig/name="Into"\n');
    const r = await j(["--into", "into", ...GD, ...PLAYER_OWNER]);
    expect(r.code).toBe(0);
    expect(r.json.files).not.toContain("player.tscn");
    expect(r.json.files).not.toContain("game.gd");
    expect(existsSync(at("into/player.tscn"))).toBe(false);
    expect(readFileSync(at("into/tests/multiplayer.gd"), "utf8")).not.toContain("_check_player");
    expect(r.json.netPlayer).toEqual({ authority: "owner", space: "3d" });
    expect(r.json.next.join("\n")).toContain("OneLobbyNetPlayerSpawner.new()");
    const again = await j(["--into", "into", ...GD, ...PLAYER_OWNER]);
    expect(again.json.changed).toBe(false);
    // the kept onelobby.json decides: a plain rerun on a game whose file has sync.player still prints the lines
    const plain = await j(["--into", "into", ...GD]);
    expect(plain.json.skipped).toContain("onelobby.json");
    expect(plain.json.netPlayer).toEqual({ authority: "owner", space: "3d" });
  });

  it("update never rewrites the game's own character and game files", async () => {
    await cli(["u", ...GD, ...PLAYER_OWNER]);
    writeFileSync(at("u/player.gd"), "# mine\n");
    writeFileSync(at("u/game.gd"), "# mine too\n");
    const r = await j(["update", "u", "--no-natives"]);
    expect(r.code).toBe(0);
    expect(text("u/player.gd")).toBe("# mine\n");
    expect(text("u/game.gd")).toBe("# mine too\n");
  });
});

describe("godot-csharp with sync.player", () => {
  it("a new project gets the pinned add-on folder, the Replication reference, the character, the game and a check", async () => {
    const r = await j(["my-game", ...CS, ...PLAYER_OWNER]);
    expect(r.code).toBe(0);
    expect(r.json.netPlayer).toMatchObject({ authority: "owner", space: "3d", from: "local" });
    const files = tree(at("my-game"));
    for (const p of ["Player.cs", "Player.tscn", "Game.cs", "Main.cs", "Main.tscn", "addons/onelobby_net_player/OneLobbyNetPlayer.cs", "addons/onelobby_net_player/OneLobbyNetPlayerSpawner.cs", "addons/onelobby_net_player/PIN.json"]) expect(files).toContain(p);
    expect(text("my-game/MyGame.csproj")).toContain('"OneLobby.Replication" Version="0.7.2-dev.9"');
    expect(r.json.csproj.added).toContain("OneLobby.Replication");
    expect(r.json.packages.version).toBe("0.7.2-dev.9");
    expect(text("my-game/.gitattributes")).toContain("addons/onelobby_net_player/** text eol=lf");
    expect(text("my-game/Main.cs")).toContain("_game.Start(lobby, menu.Client!.Blueprint!)");
    expect(text("my-game/Game.cs")).toContain("new OneLobbyNetPlayerSpawner");
    expect(text("my-game/Game.cs")).not.toContain("StepFunction");
    expect(text("my-game/Player.tscn")).toContain("res://addons/onelobby_net_player/OneLobbyNetPlayer.cs");
    expect(text("my-game/tests/MultiplayerTest.cs")).toContain("CheckPlayer(bp)");
    expect(text("my-game/tests/MultiplayerTest.cs")).toContain("if (!_playerPhase) lobby.Pump()");
    expect(text("my-game/tests/MultiplayerTest.cs")).not.toMatch(/\/\/@/);
    expect(text("my-game/tests/MultiplayerTest.cs").trimEnd().endsWith("}")).toBe(true);
    expect(text("my-game/AGENTS.md")).toContain("OneLobby.Replication");
    expect(text("my-game/AGENTS.md")).toContain("`Game.cs`");
  });

  it("the add-on folder is pinned like the menu's, in a pin of its own, and Godot's .uid files are not edits", async () => {
    await cli(["my-game", ...CS, ...PLAYER_OWNER]);
    const v = verifyPin(at("my-game"), NET_PLAYER_DIR, { tolerate: /\.uid$/ });
    expect(v.ok).toBe(true);
    expect(Object.keys(v.pin.files).sort()).toEqual(["OneLobbyNetPlayer.cs", "OneLobbyNetPlayerSpawner.cs"]);
    writeFileSync(at("my-game/addons/onelobby_net_player/OneLobbyNetPlayer.cs.uid"), "uid://zzz\n"); // what Godot writes on import
    expect(verifyPin(at("my-game"), NET_PLAYER_DIR, { tolerate: /\.uid$/ }).ok).toBe(true);
    expect(verifyPin(at("my-game"), NET_PLAYER_DIR).added).toEqual(["OneLobbyNetPlayer.cs.uid"]);
    expect(JSON.parse(text("my-game/addons/onelobby_menu/PIN.json")).files).not.toHaveProperty("OneLobbyNetPlayer.cs");
  });

  it("host authority in 2d: Player.Step, SetInput and a 2d spawn point, and the test holds 'right'", async () => {
    await cli(["h", ...CS, ...PLAYER_HOST_2D]);
    expect(text("h/Player.cs")).toContain("public static PlayerState Step(");
    expect(text("h/Player.cs")).toContain("_net.SetInput(");
    expect(text("h/Player.cs")).not.toContain("MoveAndSlide");
    expect(text("h/Player.cs")).toContain("CharacterBody2D");
    expect(text("h/Game.cs")).toContain("StepFunction = Player.Step");
    expect(text("h/Game.cs")).toContain("SpawnPoint2D");
    expect(text("h/tests/MultiplayerTest.cs")).toContain("NetPlayerInput { MoveX = 1.0 }");
    expect(text("h/tests/MultiplayerTest.cs")).toContain("sp.StepFunction = Player.Step");
    expect(text("h/tests/MultiplayerTest.cs")).toContain("SpawnPoint2D");
  });

  it("--packages-from needs OneLobby.Replication in the folder, but only for a game with the player", async () => {
    const bad = await j(["a", ...CS.slice(0, -1), "feed-no-replication", ...PLAYER_OWNER]);
    expect(bad.code).toBe(1);
    expect(bad.json.error.code).toBe("bad_packages_from");
    expect(bad.json.error.message).toContain("OneLobby.Replication none");
    const fine = await j(["b", ...CS.slice(0, -1), "feed-no-replication", "--dry-run"]);
    expect(fine.code).toBe(0);
    expect(fine.json.csproj.added).not.toContain("OneLobby.Replication");
  });

  it("--into adds the folder, its pin and the reference, writes no scene, and prints the spawner lines", async () => {
    mkdirSync(at("into"));
    writeFileSync(at("into/project.godot"), 'config_version=5\n\n[application]\n\nconfig/name="Into"\n\n[dotnet]\n\nproject/assembly_name="Into"\n');
    writeFileSync(at("into/Into.csproj"), '<Project Sdk="Godot.NET.Sdk/4.5.1">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n');
    const r = await j(["--into", "into", ...CS, ...PLAYER_OWNER]);
    expect(r.code).toBe(0);
    const files = tree(at("into"));
    expect(files).toContain("addons/onelobby_net_player/PIN.json");
    expect(files).not.toContain("Player.cs");
    expect(files).not.toContain("Game.cs");
    expect(text("into/Into.csproj")).toContain("OneLobby.Replication");
    expect(readFileSync(at("into/tests/MultiplayerTest.cs"), "utf8")).not.toContain("CheckPlayer");
    expect(r.json.next.join("\n")).toContain("new OneLobbyNetPlayerSpawner");
    const again = await j(["--into", "into", ...CS, ...PLAYER_OWNER]);
    expect(again.json.changed).toBe(false);
  });
});

describe("update of the pinned C# add-on folder", () => {
  async function made() {
    const r = await cli(["my-game", ...CS, ...PLAYER_OWNER]);
    expect(r.code).toBe(0);
  }
  const UPDATE = ["update", "my-game", "--addon-from", "checkout2", "--packages-from", "feed", "--no-natives"];

  it("re-vendors it (changed, added files), rewrites its pin, and says so", async () => {
    await made();
    const r = await j(UPDATE);
    expect(r.code).toBe(0);
    expect(r.json.netPlayer.files.changed).toEqual(["OneLobbyNetPlayer.cs"]);
    expect(r.json.netPlayer.files.added).toEqual(["Extra.cs"]);
    expect(r.json.netPlayer.pin).toBe("rewritten");
    expect(text("my-game/addons/onelobby_net_player/OneLobbyNetPlayer.cs")).toContain("int v = 2");
    expect(verifyPin(at("my-game"), NET_PLAYER_DIR, { tolerate: /\.uid$/ }).ok).toBe(true);
    const words = await cli(UPDATE);
    expect(words.out).toContain("Already current");
    expect(words.out).toContain("addons/onelobby_net_player/ is current too");
  });

  it("an edited file stops it with local_changes, and nothing is written (not even the menu's pass)", async () => {
    await made();
    writeFileSync(at("my-game/addons/onelobby_net_player/OneLobbyNetPlayer.cs"), "// edited\n");
    const r = await j(UPDATE);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("local_changes");
    expect(r.json.error.message).toContain("addons/onelobby_net_player/OneLobbyNetPlayer.cs");
    expect(text("my-game/addons/onelobby_net_player/OneLobbyNetPlayer.cs")).toBe("// edited\n");
    const forced = await j([...UPDATE, "--force"]);
    expect(forced.code).toBe(0);
    expect(forced.json.netPlayer.overwritten).toEqual(["OneLobbyNetPlayer.cs"]);
    expect(text("my-game/addons/onelobby_net_player/OneLobbyNetPlayer.cs")).toContain("int v = 2");
  });

  it("a game without the folder updates exactly as before (no netPlayer in the result)", async () => {
    await cli(["plain", ...CS]);
    const r = await j(["update", "plain", "--addon-from", "checkout", "--packages-from", "feed", "--no-natives"]);
    expect(r.code).toBe(0);
    expect(r.json.netPlayer).toBeUndefined();
    expect(r.json.current).toBe(true);
  });
});

describe("verify: the player check", () => {
  const ctxFor = (dir, kind) => ({ dir, kind });
  it("is in the list only for a game with the player, and passes on what the scaffolder writes", async () => {
    await cli(["gd", ...GD, ...PLAYER_OWNER]);
    await cli(["plain", ...GD]);
    await cli(["cs", ...CS, ...PLAYER_OWNER]);
    expect(hasNetPlayer(at("gd"), "godot-gdscript")).toBe(true);
    expect(hasNetPlayer(at("plain"), "godot-gdscript")).toBe(false);
    expect(hasNetPlayer(at("cs"), "godot-csharp")).toBe(true);
    expect(hasNetPlayer(at("gd"), "web")).toBe(false);
    expect(await playerCheck().run(ctxFor(at("gd"), "godot-gdscript"))).toMatchObject({ status: "ok" });
    expect(await playerCheck().run(ctxFor(at("cs"), "godot-csharp"))).toMatchObject({ status: "ok" });
  });

  it("fails with a next step when the node is there and nothing spawns it, or the folder is unused", async () => {
    await cli(["gd", ...GD, ...PLAYER_OWNER]);
    writeFileSync(at("gd/game.gd"), "extends Node3D\n");
    const noSpawner = await playerCheck().run(ctxFor(at("gd"), "godot-gdscript"));
    expect(noSpawner.status).toBe("fail");
    expect(noSpawner.detail).toContain("no scene or script outside addons/ and tests/ spawns the characters");
    expect(noSpawner.next).toContain("OneLobbyNetPlayerSpawner");
    await cli(["cs", ...CS, ...PLAYER_OWNER]);
    for (const f of ["Player.tscn", "Player.cs", "Game.cs"]) rmSync(at("cs", f));
    expect(hasNetPlayer(at("cs"), "godot-csharp")).toBe(true);
    const unused = await playerCheck().run(ctxFor(at("cs"), "godot-csharp"));
    expect(unused.status).toBe("fail");
    expect(unused.detail).toContain("addons/onelobby_net_player/ is there but unused");
  });
});

describe("the template tools", () => {
  it("pickBlocks keeps or drops #@ and //@ blocks, nested ones too, and refuses a broken template", () => {
    const t = "a\n#@if owner\nb\n#@end\n#@if host\nc\n#@end\n//@if x\n//@if y\nd\n//@end\ne\n//@end\nf";
    expect(pickBlocks(t, { owner: true, x: true, y: true })).toBe("a\nb\nd\ne\nf");
    expect(pickBlocks(t, { host: true, x: true })).toBe("a\nc\ne\nf");
    expect(pickBlocks(t, {})).toBe("a\nf");
    expect(() => pickBlocks("#@if a\nb", {})).toThrow();
    expect(() => pickBlocks("#@end", {})).toThrow();
    expect(playerFlags({ authority: "host", space: "2d" })).toEqual({ owner: false, host: true, "3d": false, "2d": true });
  });

  it("resolveNetPlayer: replication only; a kept onelobby.json decides", () => {
    const bp = (p) => ({ sync: { mode: p.mode ?? "replication", ...(p.player ? { player: p.player } : {}) } });
    expect(resolveNetPlayer({ wanted: true, blueprint: bp({ player: { authority: "host", space: "2d" } }), target: cwd, into: false })).toEqual({ authority: "host", space: "2d" });
    expect(resolveNetPlayer({ wanted: false, blueprint: bp({ player: {} }), target: cwd, into: false })).toBeNull();
    expect(resolveNetPlayer({ wanted: true, blueprint: bp({ mode: "raw" }), target: cwd, into: false })).toBeNull();
    expect(resolveNetPlayer({ wanted: true, blueprint: bp({ player: {} }), target: cwd, into: false })).toEqual({ authority: "owner", space: "3d" });
  });
});
