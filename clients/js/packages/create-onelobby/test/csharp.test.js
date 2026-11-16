// The godot-csharp template: a new project, --into, update, verify with fake checks. No network, no Godot, no dotnet.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../src/cli.js";
import { chooseSdk, identifierOf } from "../src/csharp.js";
import { MENU_DIR, buildPin, sha256, verifyPin } from "../src/vendor.js";
import { csharpChecks, testLine } from "../src/verify/csharp.js";
import { runChecks } from "../src/verify/core.js";
import { fixtureNativesZip } from "./helpers/zip.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-onelobby-cs-"));
  // a small stand-in for a OneLobby checkout, so these tests do not depend on the repo's menu
  const a = join(cwd, "checkout/clients/dotnet/demo-godot/addons/onelobby_menu");
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "OneLobbyMenu.cs"), "public partial class OneLobbyMenu {}\n");
  writeFileSync(join(a, "OneLobbyMenu.cs.uid"), "uid://abc\n");
  writeFileSync(join(a, "OneLobbyMenu.tscn"), "[gd_scene format=3]\n");
  writeFileSync(join(cwd, "natives.zip"), fixtureNativesZip());
  mkdirSync(join(cwd, "feed"));
  for (const id of ["OneLobby.Core", "OneLobby.Godot", "OneLobby.Direct", "OneLobby.Opus"]) writeFileSync(join(cwd, `feed/${id}.0.7.2-dev.9.nupkg`), "x");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const GODOT_ANSWER = "4.7.2.stable.mono.official.ed1daf0bf\n";
async function cli(args, { godotVersion = () => GODOT_ANSWER, env = {}, fetch } = {}) {
  let out = "";
  let err = "";
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, stdin: Readable.from([""]), stdinIsTTY: false, env, cwd, fetch, godotVersion };
  const code = await main(args, io);
  return { code, out, err };
}
const j = async (args, opts) => {
  const r = await cli([...args, "--json"], opts);
  return { ...r, json: JSON.parse(r.out) };
};
const at = (...p) => join(cwd, ...p);
const text = (...p) => readFileSync(at(...p), "utf8");
const tree = (dir, rel = "") => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`])).sort();
const FROM = ["--addon-from", "checkout", "--webrtc-zip", "natives.zip", "--packages-from", "feed", "--yes", "--no-git"];
const GODOT_FLAG = ["--godot", process.execPath]; // any existing file: the version comes from the test seam

const NEW_FILES = [
  ".gitattributes", ".gitignore", ".olc/my-game.json", "AGENTS.md", "Main.cs", "Main.tscn", "MyGame.csproj", "OneLobbyNet.cs", "addons/onelobby_menu/OneLobbyMenu.cs",
  "addons/onelobby_menu/OneLobbyMenu.cs.uid", "addons/onelobby_menu/OneLobbyMenu.tscn", "addons/onelobby_menu/PIN.json", "nuget.config", "onelobby.json", "project.godot",
  "tests/MultiplayerTest.cs", "tests/MultiplayerTest.tscn",
];
const NATIVE_FILES = ["addons/godot_webrtc/LICENSE.webrtc-native", "addons/godot_webrtc/lib/libwebrtc_native.windows.template_release.x86_64.dll", "addons/godot_webrtc/webrtc_native.gdextension"];

describe("godot-csharp: a new project", () => {
  it("--dry-run --json lists the files, writes nothing and downloads nothing", async () => {
    let fetched = 0;
    const r = await j(["my-game", "--template", "godot-csharp", ...FROM, "--dry-run"], { fetch: async () => (fetched++, null) });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, dryRun: true, template: "godot-csharp", changed: true, skipped: [], packages: { version: "0.7.2-dev.9", from: "feed" } });
    expect([...r.json.files].sort()).toEqual(NEW_FILES);
    expect(r.json.blueprint).toMatchObject({ engine: "godot-csharp", ui: { kind: "drop-in" }, hosting: { direct: true, server: false } });
    expect(existsSync(at("my-game"))).toBe(false);
    expect(fetched).toBe(0);
  });

  it("writes the project: the file plan and the text of project.godot, the .csproj and nuget.config", async () => {
    const r = await j(["my-game", "--template", "godot-csharp", ...FROM, ...GODOT_FLAG]);
    expect(r.code).toBe(0);
    expect(tree(at("my-game"))).toEqual([...NEW_FILES, ...NATIVE_FILES].sort());
    expect(text("my-game/project.godot")).toBe(`; Engine configuration file. Made by create-onelobby; Godot may rewrite it when you open the project in the editor.

config_version=5

[application]

config/name="my-game"
run/main_scene="res://Main.tscn"
config/features=PackedStringArray("4.5", "C#")

[dotnet]

project/assembly_name="MyGame"
`);
    expect(text("my-game/MyGame.csproj")).toBe(`<Project Sdk="Godot.NET.Sdk/4.7.2">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <EnableDynamicLoading>true</EnableDynamicLoading>
    <RootNamespace>MyGame</RootNamespace>
    <AssemblyName>MyGame</AssemblyName>
    <Nullable>enable</Nullable>
    <LangVersion>latest</LangVersion>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="OneLobby.Core" Version="0.7.2-dev.9" />
    <PackageReference Include="OneLobby.Godot" Version="0.7.2-dev.9" />
    <PackageReference Include="OneLobby.Direct" Version="0.7.2-dev.9" />
  </ItemGroup>
</Project>
`);
    expect(text("my-game/nuget.config")).toContain('<add key="onelobby-local" value="../feed" />');
    expect(text("my-game/nuget.config")).toContain('<package pattern="OneLobby.*" />');
    expect(text("my-game/.gitignore")).toContain("addons/godot_webrtc/\n.godot/\n.onelobby/\nbin/\nobj/");
    expect(text("my-game/.gitattributes")).toContain("addons/onelobby_menu/** text eol=lf");
    expect(text("my-game/Main.tscn")).toContain("BootFlags = false");
    expect(text("my-game/Main.cs")).toContain("namespace MyGame;");
    expect(text("my-game/Main.cs")).toContain("OneLobbyNet.Wire(menu, args)");
    expect(text("my-game/tests/MultiplayerTest.cs")).toContain("MULTIPLAYER_OK");
    expect(text("my-game/AGENTS.md")).not.toContain("{{");
    expect(text("my-game/AGENTS.md")).toContain("res://tests/MultiplayerTest.tscn");
    expect(JSON.parse(text("my-game/onelobby.json"))).toMatchObject({ engine: "godot-csharp", ui: { kind: "drop-in" } });
    expect(verifyPin(at("my-game"), MENU_DIR)).toMatchObject({ ok: true });
    expect(JSON.parse(text("my-game/addons/onelobby_menu/PIN.json")).files).toHaveProperty("OneLobbyMenu.tscn");
    for (const f of tree(at("my-game"))) if (!f.includes("godot_webrtc")) expect(readFileSync(at("my-game", f)).includes(13), `${f} has a CR`).toBe(false);
  });

  it("the play entry has the GDScript template's flags and port, and builds first", async () => {
    await j(["my-game", "--template", "godot-csharp", ...FROM]);
    const entries = JSON.parse(text("my-game/.olc/my-game.json")).entries;
    const bash = entries.find((e) => e.shell === "bash").command;
    expect(bash).toBe('dotnet build -nologo -v q || exit 1; G="${GODOT:-godot}"; "$G" --path . -- --host --local --name=Host & sleep 4; "$G" --path . --resolution 640x360 -- --join=127.0.0.1:47810 --local --name=Joiner');
    expect(entries.find((e) => e.shell === "powershell").command).toContain("-- --join=127.0.0.1:47810 --local --name=Joiner");
    expect(text("my-game/AGENTS.md")).toContain("-- --host --local --name=Sam");
  });

  it("without --packages-from the project references the registry version and writes no nuget.config", async () => {
    const r = await j(["my-game", "--template", "godot-csharp", "--addon-from", "checkout", "--webrtc-zip", "natives.zip", "--yes", "--no-git"]);
    expect(r.json.packages).toEqual({ version: "0.7.2", from: "registry" });
    expect(existsSync(at("my-game/nuget.config"))).toBe(false);
    expect(text("my-game/MyGame.csproj")).toContain('Include="OneLobby.Godot" Version="0.7.2"');
  });

  it("a voice game gets the microphone setting in project.godot", async () => {
    await j(["my-game", "--template", "godot-csharp", ...FROM, "--voice"]);
    expect(text("my-game/project.godot")).toContain("[audio]\n\ndriver/enable_input=true\n\n[dotnet]");
  });

  it("refuses a bad --packages-from before writing anything", async () => {
    const r = await j(["my-game", "--template", "godot-csharp", "--addon-from", "checkout", "--webrtc-zip", "natives.zip", "--packages-from", "nope", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("bad_packages_from");
    expect(existsSync(at("my-game"))).toBe(false);
  });

  it("--no-natives leaves the natives out and says how to fetch them", async () => {
    const r = await j(["my-game", "--template", "godot-csharp", ...FROM, "--no-natives"]);
    expect(r.json.natives.status).toBe("skipped");
    expect(r.json.next.join("\n")).toContain("npx create-onelobby update");
    expect(existsSync(at("my-game/addons/godot_webrtc"))).toBe(false);
  });
});

describe("godot-csharp: the Godot.NET.Sdk version", () => {
  const sdk = (version, opts = { godot: process.execPath }) => chooseSdk({ opts, env: {}, run: () => version });
  it("follows the .NET Godot that was named", () => {
    expect(sdk(GODOT_ANSWER)).toMatchObject({ version: "4.7.2", from: "--godot" });
    expect(sdk("4.5.stable.mono.official.abc\n").version).toBe("4.5.0");
    expect(sdk("4.6.1.stable.mono.official.abc\n").version).toBe("4.6.1");
  });
  it("falls back to 4.5.1 when there is no Godot, a standard build, a dev build or an old one", () => {
    expect(chooseSdk({ opts: {}, env: {}, run: () => "" })).toMatchObject({ version: "4.5.1", from: "default" });
    expect(sdk("4.7.2.stable.official.abc\n")).toMatchObject({ version: "4.5.1", from: "default" });
    expect(sdk("4.8.dev7.mono.official.abc\n").version).toBe("4.5.1");
    expect(sdk("4.4.1.stable.mono.official.abc\n").version).toBe("4.5.1");
    expect(sdk("garbage").version).toBe("4.5.1");
  });
  it("the project file says which one a run picked", async () => {
    const r = await j(["my-game", "--template", "godot-csharp", ...FROM, "--dry-run"], { godotVersion: () => "" });
    expect(r.json.sdk).toMatchObject({ version: "4.5.1", from: "default" });
  });
  it("names are made into C# identifiers", () => {
    expect([identifierOf("my-game"), identifierOf("3d fun"), identifierOf("___"), identifierOf("Already_Ok")]).toEqual(["MyGame", "Game3dFun", "Game", "AlreadyOk"]);
  });
});

const GAME_CSPROJ = `<Project Sdk="Godot.NET.Sdk/4.5.1">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <RootNamespace>Existing.Game</RootNamespace>
  </PropertyGroup>
</Project>
`;
function emptyCsharpGame(name = "Into") {
  mkdirSync(at("into"), { recursive: true });
  writeFileSync(at("into/project.godot"), `config_version=5\n\n[application]\n\nconfig/name="${name}"\n\n[dotnet]\n\nproject/assembly_name="${name}"\n`);
  writeFileSync(at(`into/${name}.csproj`), GAME_CSPROJ);
  writeFileSync(at(`into/${name}.sln`), "Microsoft Visual Studio Solution File\n");
}
const INTO = ["--into", "into", ...FROM, ...GODOT_FLAG];

describe("godot-csharp: --into an existing project", () => {
  it("adds the pieces, edits the .csproj in place, leaves the scenes alone and prints the wiring lines", async () => {
    emptyCsharpGame();
    const before = text("into/project.godot");
    const r = await j(INTO);
    expect(r.code).toBe(0);
    expect(r.json.files.sort()).toEqual([".gitattributes", ".gitignore", ".olc/into.json", "Into.csproj", "OneLobbyNet.cs", "addons/onelobby_menu/OneLobbyMenu.cs", "addons/onelobby_menu/OneLobbyMenu.cs.uid", "addons/onelobby_menu/OneLobbyMenu.tscn", "addons/onelobby_menu/PIN.json", "nuget.config", "onelobby.json", "tests/MultiplayerTest.cs", "tests/MultiplayerTest.tscn"]);
    expect(text("into/project.godot")).toBe(before);
    expect(text("into/Into.csproj")).toBe(GAME_CSPROJ.replace("</Project>", `  <ItemGroup>
    <PackageReference Include="OneLobby.Core" Version="0.7.2-dev.9" />
    <PackageReference Include="OneLobby.Godot" Version="0.7.2-dev.9" />
    <PackageReference Include="OneLobby.Direct" Version="0.7.2-dev.9" />
  </ItemGroup>
</Project>`));
    expect(text("into/OneLobbyNet.cs")).toContain("namespace Existing.Game;".replace("Existing.Game", "ExistingGame"));
    expect(r.json.csproj).toMatchObject({ file: "Into.csproj", added: ["OneLobby.Core", "OneLobby.Godot", "OneLobby.Direct"] });
    const next = r.json.next.join("\n");
    expect(next).toContain("res://addons/onelobby_menu/OneLobbyMenu.tscn");
    expect(next).toContain("OneLobbyNet.Wire(menu, OS.GetCmdlineUserArgs())");
    expect(next).toContain("menu.GameStarted +=");
    expect(existsSync(at("into/Main.cs"))).toBe(false);
    expect(existsSync(at("into/AGENTS.md"))).toBe(false);
  });

  it("a second run changes nothing", async () => {
    emptyCsharpGame();
    await j(INTO);
    const files = tree(at("into")).map((f) => [f, readFileSync(at("into", f)).toString("hex")]);
    const again = await j(INTO);
    expect(again.json).toMatchObject({ ok: true, changed: false, files: [], skipped: [] });
    expect(tree(at("into")).map((f) => [f, readFileSync(at("into", f)).toString("hex")])).toEqual(files);
  });

  it("is implied by project.godot with a .csproj next to it, and a GDScript project still gets the GDScript template", async () => {
    emptyCsharpGame();
    const r = await j(["--into", "into", "--addon-from", "checkout", "--webrtc-zip", "natives.zip", "--yes", "--dry-run"]);
    expect(r.json.template).toBe("godot-csharp");
    mkdirSync(at("gd"));
    writeFileSync(at("gd/project.godot"), "config_version=5\n");
    const g = await j(["--into", "gd", "--addon-from", "checkout", "--webrtc-zip", "natives.zip", "--yes", "--dry-run"]);
    expect(g.json.ok).toBe(false); // the stand-in checkout has no GDScript add-on; what matters is that it did not pick C#
    expect(g.json.error.code).toBe("bad_addon_from");
  });

  it("refuses a project without C#, with a .sln but no .csproj, a project file it cannot edit, and a GDScript template on a C# folder", async () => {
    mkdirSync(at("gd"));
    writeFileSync(at("gd/project.godot"), "config_version=5\n");
    expect((await j(["--into", "gd", "--template", "godot-csharp", ...FROM])).json.error.code).toBe("not_csharp_project");
    mkdirSync(at("sln"));
    writeFileSync(at("sln/project.godot"), "config_version=5\n");
    writeFileSync(at("sln/x.sln"), "x\n");
    const sln = await j(["--into", "sln", ...FROM]);
    expect(sln.json.error).toMatchObject({ code: "bad_csproj" });
    expect(sln.json.error.message).toContain("Create C# solution");
    emptyCsharpGame();
    writeFileSync(at("into/Into.csproj"), "<Project Sdk=\"Godot.NET.Sdk/4.5.1\"><ItemGroup>");
    const before = tree(at("into"));
    const bad = await j(INTO);
    expect(bad.json.error.code).toBe("bad_csproj");
    expect(bad.json.error.message).toContain("Into.csproj");
    expect(tree(at("into"))).toEqual(before); // nothing was written
    emptyCsharpGame();
    expect((await j(["--into", "into", "--template", "godot-gdscript", ...FROM])).json.error.code).toBe("wrong_template");
  });

  it("with several .csproj files it takes the one project.godot names, else refuses", async () => {
    emptyCsharpGame("Into");
    writeFileSync(at("into/Tools.csproj"), GAME_CSPROJ);
    expect((await j([...INTO, "--dry-run"])).json.csproj.file).toBe("Into.csproj");
    writeFileSync(at("into/project.godot"), "config_version=5\n");
    expect((await j([...INTO, "--dry-run"])).json.error.code).toBe("bad_csproj");
  });

  it("notes an existing OneLobby reference at another version and a nuget.config of the game's own", async () => {
    emptyCsharpGame();
    writeFileSync(at("into/Into.csproj"), GAME_CSPROJ.replace("</Project>", `  <ItemGroup>\n    <PackageReference Include="OneLobby.Core" Version="0.6.0" />\n  </ItemGroup>\n</Project>`));
    writeFileSync(at("into/nuget.config"), "<configuration />\n");
    const r = await j(INTO);
    expect(r.json.notes.join("\n")).toContain("OneLobby.Core 0.6.0");
    expect(r.json.notes.join("\n")).toContain("nuget.config already exists");
    expect(r.json.skipped).toEqual(["nuget.config"]);
    expect(text("into/nuget.config")).toBe("<configuration />\n");
    expect(text("into/Into.csproj")).toContain('Include="OneLobby.Core" Version="0.6.0"');
  });

  it("a game's own tests/MultiplayerTest.cs is not overwritten without --force", async () => {
    emptyCsharpGame();
    mkdirSync(at("into/tests"));
    writeFileSync(at("into/tests/MultiplayerTest.cs"), "mine\n");
    const r = await j(INTO);
    expect(r.json.skipped).toContain("tests/MultiplayerTest.cs");
    expect(text("into/tests/MultiplayerTest.cs")).toBe("mine\n");
  });
});

/** A scaffolded game whose menu is older / newer than the stand-in checkout's. */
async function gameAtOldVersion() {
  await j(["my-game", "--template", "godot-csharp", "--addon-from", "checkout", "--webrtc-zip", "natives.zip", "--yes", "--no-git", "--packages-from", "feed"]);
  writeFileSync(at("checkout/clients/dotnet/demo-godot/addons/onelobby_menu/OneLobbyMenu.cs"), "public partial class OneLobbyMenu { int v2; }\n");
  mkdirSync(at("feed2"));
  for (const id of ["OneLobby.Core", "OneLobby.Godot", "OneLobby.Direct"]) writeFileSync(at(`feed2/${id}.0.7.3-dev.1.nupkg`), "x");
}

describe("godot-csharp: update", () => {
  it("re-vendors the menu, moves only the OneLobby version attributes, refreshes nuget.config and prints the build and import commands", async () => {
    await gameAtOldVersion();
    const csprojBefore = text("my-game/MyGame.csproj");
    const r = await j(["update", "my-game", "--addon-from", "checkout", "--packages-from", "feed2", "--no-natives"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, template: "godot-csharp", changed: true, files: { changed: ["OneLobbyMenu.cs"], added: [], removed: [] }, pin: "rewritten", nugetConfig: "update", packages: { version: "0.7.3-dev.1" } });
    expect(r.json.csproj.moved.map((m) => `${m.id} ${m.from} -> ${m.to}`)).toEqual(["OneLobby.Core 0.7.2-dev.9 -> 0.7.3-dev.1", "OneLobby.Godot 0.7.2-dev.9 -> 0.7.3-dev.1", "OneLobby.Direct 0.7.2-dev.9 -> 0.7.3-dev.1"]);
    expect(text("my-game/MyGame.csproj")).toBe(csprojBefore.replace(/0\.7\.2-dev\.9/g, "0.7.3-dev.1"));
    expect(text("my-game/addons/onelobby_menu/OneLobbyMenu.cs")).toContain("v2");
    expect(verifyPin(at("my-game"), MENU_DIR).ok).toBe(true);
    expect(r.json.next[0]).toContain("dotnet build");
    expect(r.json.next[1]).toContain("godot --headless --import");
  });

  it("--dry-run shows the csproj edit and writes nothing", async () => {
    await gameAtOldVersion();
    const files = tree(at("my-game")).map((f) => [f, readFileSync(at("my-game", f)).toString("hex")]);
    const r = await cli(["update", "my-game", "--addon-from", "checkout", "--packages-from", "feed2", "--no-natives", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Dry run: nothing written");
    expect(r.out).toContain("MyGame.csproj: OneLobby.Core 0.7.2-dev.9 -> 0.7.3-dev.1");
    expect(tree(at("my-game")).map((f) => [f, readFileSync(at("my-game", f)).toString("hex")])).toEqual(files);
  });

  it("with nothing to do it says so and writes nothing", async () => {
    await j(["my-game", "--template", "godot-csharp", ...FROM]);
    const r = await j(["update", "my-game", "--addon-from", "checkout", "--packages-from", "feed", "--no-natives"]);
    expect(r.json).toMatchObject({ ok: true, current: true, changed: false, next: [] });
  });

  it("an edited menu file stops it (exit 1, local_changes) and --force goes on", async () => {
    await gameAtOldVersion();
    writeFileSync(at("my-game/addons/onelobby_menu/OneLobbyMenu.tscn"), "[gd_scene format=3]\n; mine\n");
    const csproj = text("my-game/MyGame.csproj");
    const r = await j(["update", "my-game", "--addon-from", "checkout", "--packages-from", "feed2", "--no-natives"]);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("local_changes");
    expect(r.json.error.message).toContain("edited   addons/onelobby_menu/OneLobbyMenu.tscn");
    expect(text("my-game/MyGame.csproj")).toBe(csproj);
    const forced = await j(["update", "my-game", "--addon-from", "checkout", "--packages-from", "feed2", "--no-natives", "--force"]);
    expect(forced.code).toBe(0);
    expect(forced.json.overwritten).toEqual(["OneLobbyMenu.tscn"]);
    expect(text("my-game/addons/onelobby_menu/OneLobbyMenu.tscn")).toBe("[gd_scene format=3]\n");
  });

  it("an added and a missing file stop it too, and a game with no pin is no_pin", async () => {
    await gameAtOldVersion();
    writeFileSync(at("my-game/addons/onelobby_menu/Extra.cs"), "x\n");
    expect((await j(["update", "my-game", "--addon-from", "checkout", "--no-natives"])).json.error.message).toContain("added    addons/onelobby_menu/Extra.cs");
    rmSync(at("my-game/addons/onelobby_menu/Extra.cs"));
    rmSync(at("my-game/addons/onelobby_menu/OneLobbyMenu.tscn"));
    expect((await j(["update", "my-game", "--addon-from", "checkout", "--no-natives"])).json.error.message).toContain("missing  addons/onelobby_menu/OneLobbyMenu.tscn");
    rmSync(at("my-game/addons/onelobby_menu/PIN.json"));
    expect((await j(["update", "my-game", "--addon-from", "checkout", "--no-natives"])).json.error.code).toBe("no_pin");
  });

  it("leaves a version written as a property alone and says so; refuses a .csproj it cannot edit before writing the menu", async () => {
    await gameAtOldVersion();
    writeFileSync(at("my-game/MyGame.csproj"), text("my-game/MyGame.csproj").replace('Include="OneLobby.Direct" Version="0.7.2-dev.9"', 'Include="OneLobby.Direct" Version="$(OneLobbyVersion)"'));
    const r = await j(["update", "my-game", "--addon-from", "checkout", "--packages-from", "feed2", "--no-natives"]);
    expect(r.json.csproj.skipped).toEqual([{ id: "OneLobby.Direct", why: expect.stringContaining("not a plain number") }]);
    expect(text("my-game/MyGame.csproj")).toContain('Version="$(OneLobbyVersion)"');
    writeFileSync(at("my-game/MyGame.csproj"), "<Project");
    const menu = text("my-game/addons/onelobby_menu/OneLobbyMenu.cs");
    writeFileSync(at("checkout/clients/dotnet/demo-godot/addons/onelobby_menu/OneLobbyMenu.cs"), "public partial class OneLobbyMenu { int v3; }\n");
    const bad = await j(["update", "my-game", "--addon-from", "checkout", "--no-natives"]);
    expect(bad.json.error.code).toBe("bad_csproj");
    expect(text("my-game/addons/onelobby_menu/OneLobbyMenu.cs")).toBe(menu);
  });
});

describe("godot-csharp: pin keys that try to leave addons/onelobby_menu/", () => {
  const BAD = ["../outside.txt", "/abs", "a\\b", "C:/x", "a/../../outside.txt", "a//b", "./x", "x\0y"];
  for (const key of BAD) {
    it(`update (also --force) refuses ${JSON.stringify(key)} with bad_pin and touches nothing; the menu-pin check FAILs instead of throwing`, async () => {
      await gameAtOldVersion();
      writeFileSync(at("my-game/addons/outside.txt"), "precious\n");
      const pinFile = at("my-game/addons/onelobby_menu/PIN.json");
      const pin = JSON.parse(readFileSync(pinFile, "utf8"));
      pin.files[key] = sha256(Buffer.from("precious\n"));
      writeFileSync(pinFile, JSON.stringify(pin));
      const snapshot = () => tree(at("my-game")).map((f) => [f, readFileSync(at("my-game", f)).toString("hex")]);
      const before = snapshot();
      for (const extra of [[], ["--force"], ["--dry-run"]]) {
        const r = await j(["update", "my-game", "--addon-from", "checkout", "--no-natives", ...extra]);
        expect(r.code).toBe(1);
        expect(r.json.error.code).toBe("bad_pin");
        expect(r.json.error.message).toContain(JSON.stringify(key));
        expect(snapshot()).toEqual(before);
      }
      expect(() => verifyPin(at("my-game"), MENU_DIR)).toThrowError(expect.objectContaining({ code: "bad_pin" }));
      const check = csharpChecks().find((c) => c.name === "menu-pin");
      const res = await check.run({ dir: at("my-game") });
      expect(res.status).toBe("fail");
      expect(res.detail).toContain("not a plain relative path");
      expect(text("my-game/addons/outside.txt")).toBe("precious\n");
    });
  }
});

describe("godot-csharp: verify", () => {
  const ok = (detail) => ({ status: "ok", detail });
  const fakeCtx = (answers) => ({
    dir: at("g"),
    opts: { godot: process.execPath },
    env: {},
    services: {},
    run: async (cmd, args) => {
      const key = [cmd.endsWith("node.exe") || cmd === process.execPath ? "godot" : cmd, ...args].join(" ");
      const hit = Object.entries(answers).find(([k]) => key.includes(k));
      return hit ? { code: 0, timedOut: false, out: "", ...hit[1] } : { code: 1, timedOut: false, out: `unexpected: ${key}` };
    },
  });

  it("runs the checks in the documented order, with the same names as GDScript where they apply", () => {
    expect(csharpChecks().map((c) => c.name)).toEqual(["godot", "dotnet", "menu-pin", "natives", "blueprint", "direct", "nostr", "turn", "server"]);
    expect(csharpChecks().filter((c) => c.blocking).map((c) => c.name)).toEqual(["godot", "dotnet", "menu-pin", "natives", "blueprint"]);
  });

  it("a standard build of Godot is a FAIL that names the .NET download, and later checks are skipped", async () => {
    mkdirSync(at("g"));
    const ctx = fakeCtx({ godot: { out: "4.7.2.stable.official.ed1daf0bf\n" } });
    const r = await runChecks(csharpChecks(), ctx);
    expect(r.ok).toBe(false);
    expect(r.verdict).toMatch(/^VERIFY_FAIL godot: .*standard build of Godot.*cannot run C# code\. Download the \.NET build of the same version from https:\/\/godotengine\.org\/download/);
    expect(r.results.slice(1).every((c) => c.status === "skipped")).toBe(true);
    expect(r.verdict.split("\n")).toHaveLength(1);
  });

  it("an older Godot, no answer, and a .NET build are told apart; a project on another SDK version gets a warning", async () => {
    mkdirSync(at("g"));
    writeFileSync(at("g/project.godot"), 'config/name="g"\n');
    writeFileSync(at("g/g.csproj"), GAME_CSPROJ);
    const godot = csharpChecks()[0];
    expect((await godot.run(fakeCtx({ godot: { out: "4.3.stable.mono.official.x\n" } }))).detail).toContain("older than 4.5");
    expect((await godot.run(fakeCtx({ godot: { code: 1, out: "boom" } }))).status).toBe("fail");
    const good = await godot.run(fakeCtx({ godot: { out: "4.7.2.stable.mono.official.x\n" } }));
    expect(good).toMatchObject({ status: "ok", detail: expect.stringContaining(".NET build") });
    expect(good.warning).toContain("Godot.NET.Sdk 4.5");
  });

  it("dotnet: no SDK, an old SDK and a failed build are FAILs with a next step; a missing package points at --packages-from", async () => {
    mkdirSync(at("g"));
    writeFileSync(at("g/project.godot"), 'config/name="g"\n');
    writeFileSync(at("g/g.csproj"), GAME_CSPROJ);
    const dotnet = csharpChecks()[1];
    expect((await dotnet.run(fakeCtx({ "--version": { code: 1, out: "" } }))).next).toContain("Install the .NET 8 SDK");
    expect((await dotnet.run(fakeCtx({ "--version": { out: "7.0.100\n" } }))).detail).toContain("need 8 or newer");
    const built = fakeCtx({ "dotnet --version": { out: "8.0.100\n" }, "dotnet build g.csproj": { code: 1, out: "error NU1101: Unable to find package OneLobby.Core\n" } });
    const r = await dotnet.run(built);
    expect(r).toMatchObject({ status: "fail", detail: expect.stringContaining("NU1101") });
    expect(r.next).toContain("--packages-from");
    const fine = await dotnet.run(fakeCtx({ "dotnet --version": { out: "8.0.100\n" }, "dotnet build g.csproj": { code: 0 } }));
    expect(fine.status).toBe("ok");
  });

  it("a game without tests/MultiplayerTest.cs fails the route checks with the command that writes it, and the blueprint check only warns", async () => {
    mkdirSync(at("g"));
    writeFileSync(at("g/onelobby.json"), JSON.stringify({ game: { id: "com.example.g" }, engine: "godot-csharp", hosting: { direct: true, server: false } }));
    const ctx = fakeCtx({});
    const checks = csharpChecks();
    const bp = await checks.find((c) => c.name === "blueprint").run(ctx);
    expect(bp.status).toBe("ok");
    expect(bp.warning).toContain("tests/MultiplayerTest.cs");
    const direct = await checks.find((c) => c.name === "direct").run(ctx);
    expect(direct).toMatchObject({ status: "fail", next: expect.stringContaining("npx create-onelobby --into .") });
  });

  it("the route results are read from the test's last lines", () => {
    expect(testLine("x\nMULTIPLAYER_OK\n", "direct")).toEqual({ ok: true, detail: "" });
    expect(testLine("MULTIPLAYER_FAIL the two peers never linked\r\n", "direct")).toEqual({ ok: false, why: "the two peers never linked" });
    expect(testLine("MULTIPLAYER_OK nostr code=ABC\n", "nostr")).toEqual({ ok: true, detail: "code=ABC" });
    expect(testLine("MULTIPLAYER_FAIL turn timed out after 60 s\n", "turn")).toEqual({ ok: false, why: "timed out after 60 s" });
    expect(testLine("MULTIPLAYER_OK\n", "nostr")).toBe(null);
    expect(testLine("nothing\n", "direct")).toBe(null);
  });

  it("through the CLI: a C# game runs csharpChecks, prints one verdict line and exits 1 on a fail", async () => {
    mkdirSync(at("g"));
    writeFileSync(at("g/project.godot"), "config_version=5\n");
    writeFileSync(at("g/g.csproj"), GAME_CSPROJ);
    writeFileSync(at("g/onelobby.json"), "{}");
    const fake = (name, result, extra = {}) => ({ name, run: async () => result, ...extra });
    let out = "";
    const io = { stdout: { write: (s) => (out += s) }, stderr: { write() {} }, stdin: Readable.from([""]), stdinIsTTY: false, env: {}, cwd, verifyChecks: (kind) => (kind === "godot-csharp" ? [fake("godot", ok("x")), fake("dotnet", { status: "fail", detail: "it broke.", next: "Do this." })] : []) };
    expect(await main(["verify", "g"], io)).toBe(1);
    expect(out.trim().split("\n").at(-1)).toBe("VERIFY_FAIL dotnet: it broke. Do this.");
  });
});

describe("godot-csharp: the buildPin is the same one GDScript uses", () => {
  it("pins every file by SHA-256, with the natives version", () => {
    const pin = JSON.parse(buildPin({ files: [{ path: "A.cs", content: Buffer.from("a") }], commit: "abc" }));
    expect(pin.files["A.cs"]).toBe(sha256(Buffer.from("a")));
    expect(pin.webrtcNative.version).toBe("1.2.2-stable");
  });
});
