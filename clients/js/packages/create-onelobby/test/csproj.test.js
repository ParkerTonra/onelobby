// The in-place .csproj edit and the local package folder. No network, no Godot, no dotnet.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ONELOBBY_PACKAGES, addReferences, inspectCsproj, moveReferences, newCsproj, oneLobbyRefs } from "../src/csproj.js";
import { nugetConfig, readFeed, sourcePath } from "../src/packages.js";

const WANT = ONELOBBY_PACKAGES.map((id) => ({ id, version: "0.7.2" }));
const ADDED = ['<PackageReference Include="OneLobby.Core" Version="0.7.2" />', '<PackageReference Include="OneLobby.Godot" Version="0.7.2" />', '<PackageReference Include="OneLobby.Direct" Version="0.7.2" />'];

const GODOT = (body = "") => `<Project Sdk="Godot.NET.Sdk/4.5.1">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <EnableDynamicLoading>true</EnableDynamicLoading>
  </PropertyGroup>${body}
</Project>
`;
const WITH_ITEMS = GODOT(`
  <!-- a comment with <PackageReference Include="OneLobby.Core" Version="9.9.9" /> inside -->
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
  <ItemGroup Condition=" '$(Configuration)' == 'ExportDebug' ">
    <PackageReference Include="Other" Version="1.0.0" />
  </ItemGroup>`);

describe("addReferences", () => {
  it("adds the three lines after the last package reference of an unconditional ItemGroup, changing nothing else", () => {
    const r = addReferences(WITH_ITEMS, WANT, "g.csproj");
    expect(r.changed).toBe(true);
    expect(r.added).toEqual(ONELOBBY_PACKAGES);
    const expected = WITH_ITEMS.replace('<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />', `<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />\n    ${ADDED.join("\n    ")}`);
    expect(r.text).toBe(expected);
  });

  it("makes a new ItemGroup before </Project> when there is none, in the file's own indentation", () => {
    const r = addReferences(GODOT(), WANT, "g.csproj");
    expect(r.text).toBe(`<Project Sdk="Godot.NET.Sdk/4.5.1">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <EnableDynamicLoading>true</EnableDynamicLoading>
  </PropertyGroup>
  <ItemGroup>
    ${ADDED.join("\n    ")}
  </ItemGroup>
</Project>
`);
    const tabbed = GODOT().replace(/ {2}/g, "\t");
    expect(addReferences(tabbed, WANT, "g.csproj").text).toContain(`\t<ItemGroup>\n\t\t${ADDED[0]}`);
  });

  it("is safe to run twice: the second run changes nothing", () => {
    const once = addReferences(WITH_ITEMS, WANT, "g.csproj").text;
    const twice = addReferences(once, WANT, "g.csproj");
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once);
    expect(twice.added).toEqual([]);
  });

  it("adds only what is missing and leaves an existing version alone", () => {
    const text = GODOT(`\n  <ItemGroup>\n    <PackageReference Include="OneLobby.Core" Version="0.6.0" />\n  </ItemGroup>`);
    const r = addReferences(text, WANT, "g.csproj");
    expect(r.added).toEqual(["OneLobby.Godot", "OneLobby.Direct"]);
    expect(r.present).toEqual([{ id: "OneLobby.Core", version: "0.6.0" }]);
    expect(r.text).toContain('Include="OneLobby.Core" Version="0.6.0"');
    expect(r.text).not.toContain('Include="OneLobby.Core" Version="0.7.2"');
  });

  it("an element-form reference (<Version> child) counts as there", () => {
    const text = GODOT(`\n  <ItemGroup>\n    <PackageReference Include="OneLobby.Core">\n      <Version>0.7.2</Version>\n    </PackageReference>\n  </ItemGroup>`);
    expect(addReferences(text, WANT, "g.csproj").present).toEqual([{ id: "OneLobby.Core", version: "0.7.2" }]);
  });

  for (const eol of ["\n", "\r\n"]) {
    it(`keeps ${eol === "\n" ? "LF" : "CRLF"} line endings, with no stray other kind`, () => {
      const text = WITH_ITEMS.replace(/\n/g, eol);
      const r = addReferences(text, WANT, "g.csproj");
      expect(r.changed).toBe(true);
      if (eol === "\r\n") expect(r.text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
      else expect(r.text).not.toContain("\r");
      expect(r.text.replace(/\r?\n {4}<PackageReference Include="OneLobby\.[A-Za-z]+" Version="0\.7\.2" \/>/g, "")).toBe(text);
    });
  }

  it("keeps a BOM and the XML declaration", () => {
    const text = `﻿<?xml version="1.0" encoding="utf-8"?>\n${GODOT()}`;
    const r = addReferences(text, WANT, "g.csproj");
    expect(r.text.startsWith('﻿<?xml version="1.0" encoding="utf-8"?>\n<Project')).toBe(true);
  });

  const refuse = (name, text, message) =>
    it(`refuses ${name} with bad_csproj and names the file`, () => {
      expect(() => addReferences(text, WANT, "Game.csproj")).toThrowError(expect.objectContaining({ code: "bad_csproj", message: expect.stringContaining(message) }));
    });
  refuse("a file that is not XML", "this is not a project", "Game.csproj");
  refuse("an unclosed element", GODOT().replace("</PropertyGroup>", ""), "does not match");
  refuse("an element left open at the end", "<Project Sdk=\"Godot.NET.Sdk/4.5.1\"><ItemGroup>", "never closed");
  refuse("a mismatched closing tag", GODOT().replace("</PropertyGroup>", "</ItemGroup>"), "does not match");
  refuse("a stray <", GODOT().replace("net8.0", "net8.0 < 9"), "stray <");
  refuse("a root that is not <Project>", "<Foo></Foo>", "not <Project>");
  refuse("an empty <Project />", '<Project Sdk="Godot.NET.Sdk/4.5.1" />', "empty");
  refuse("two roots", GODOT() + "<Project></Project>", "after the root");
  refuse("a project that does not use Godot.NET.Sdk", GODOT().replace("Godot.NET.Sdk/4.5.1", "Microsoft.NET.Sdk"), "does not use Godot.NET.Sdk");
  refuse("a project older than net8.0", GODOT().replace("net8.0", "net6.0"), "net8.0 or newer");

  it("a refused file is not changed (the input string is what the caller still has)", () => {
    const text = "<Project";
    expect(() => addReferences(text, WANT, "g.csproj")).toThrow();
    expect(text).toBe("<Project");
  });

  it("an SDK given as <Sdk Name=...> or <Import Sdk=...> counts", () => {
    const viaImport = `<Project>\n  <Import Project="Sdk.props" Sdk="Godot.NET.Sdk" Version="4.5.1" />\n  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n</Project>\n`;
    expect(addReferences(viaImport, WANT, "g.csproj").changed).toBe(true);
  });

  it("an element a comment hides is not seen", () => {
    expect(oneLobbyRefs(WITH_ITEMS, "g.csproj")).toEqual([]);
  });
});

describe("moveReferences", () => {
  const text = GODOT(`
  <ItemGroup>
    <PackageReference Include="OneLobby.Core" Version="0.6.0" />
    <PackageReference Include='OneLobby.Godot' Version='0.6.0' />
    <PackageReference Include="OneLobby.Replication"><Version>0.6.0</Version></PackageReference>
    <PackageReference Include="OneLobby.Direct" Version="$(OneLobbyVersion)" />
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>`);

  it("moves only the Version values of OneLobby.* references and says what it skipped", () => {
    const r = moveReferences(text, "0.7.2", "g.csproj");
    expect(r.moved).toEqual([
      { id: "OneLobby.Core", from: "0.6.0", to: "0.7.2" },
      { id: "OneLobby.Godot", from: "0.6.0", to: "0.7.2" },
      { id: "OneLobby.Replication", from: "0.6.0", to: "0.7.2" },
    ]);
    expect(r.skipped).toEqual([{ id: "OneLobby.Direct", why: expect.stringContaining("$(OneLobbyVersion)") }]);
    expect(r.text).toBe(text.replace(/0\.6\.0/g, "0.7.2"));
    expect(r.text).toContain("Version='0.7.2'");
    expect(r.text).toContain('Version="13.0.3"');
  });

  it("changes nothing when every reference is already at that version", () => {
    const once = moveReferences(text, "0.7.2", "g.csproj").text;
    const again = moveReferences(once, "0.7.2", "g.csproj");
    expect(again.changed).toBe(false);
    expect(again.moved).toEqual([]);
    expect(again.text).toBe(once);
  });

  it("works on CRLF input and refuses a file it cannot read", () => {
    const crlf = text.replace(/\n/g, "\r\n");
    expect(moveReferences(crlf, "0.7.2", "g.csproj").text).toBe(crlf.replace(/0\.6\.0/g, "0.7.2"));
    expect(() => moveReferences("<Project><ItemGroup></Project>", "0.7.2", "g.csproj")).toThrowError(expect.objectContaining({ code: "bad_csproj" }));
  });
});

describe("newCsproj", () => {
  it("is a project file the editor accepts as it is, and one inspect reads back", () => {
    const text = newCsproj({ sdkVersion: "4.7.2", assembly: "MyGame", rootNamespace: "MyGame", refs: WANT });
    expect(text).toBe(`<Project Sdk="Godot.NET.Sdk/4.7.2">
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
    <PackageReference Include="OneLobby.Core" Version="0.7.2" />
    <PackageReference Include="OneLobby.Godot" Version="0.7.2" />
    <PackageReference Include="OneLobby.Direct" Version="0.7.2" />
  </ItemGroup>
</Project>
`);
    expect(inspectCsproj(text).sdkVersion).toBe("4.7.2");
  });
});

describe("the local package folder (--packages-from)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "create-onelobby-feed-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const pack = (id, v) => writeFileSync(join(dir, `${id}.${v}.nupkg`), "x");

  it("reads the version the three packages share from the file names", () => {
    for (const id of ONELOBBY_PACKAGES) pack(id, "0.7.2-dev.5");
    pack("OneLobby.Opus", "0.7.2-dev.5");
    writeFileSync(join(dir, "OneLobby.Core.0.7.2-dev.5.snupkg"), "x");
    expect(readFeed(dir)).toMatchObject({ version: "0.7.2-dev.5" });
  });

  it("refuses a missing folder, a folder without the set, and a folder with two versions", () => {
    expect(() => readFeed(join(dir, "nope"))).toThrowError(expect.objectContaining({ code: "bad_packages_from" }));
    pack("OneLobby.Core", "1.0.0");
    expect(() => readFeed(dir)).toThrowError(expect.objectContaining({ code: "bad_packages_from", message: expect.stringContaining("OneLobby.Godot none") }));
    for (const id of ONELOBBY_PACKAGES) {
      pack(id, "1.0.0");
      pack(id, "1.0.1");
    }
    expect(() => readFeed(dir)).toThrowError(expect.objectContaining({ code: "bad_packages_from", message: expect.stringContaining("1.0.0, 1.0.1") }));
  });

  it("does not take OneLobby.Core.Tests for a version of OneLobby.Core", () => {
    writeFileSync(join(dir, "OneLobby.Core.Tests.1.0.0.nupkg"), "x");
    expect(() => readFeed(dir)).toThrowError(expect.objectContaining({ code: "bad_packages_from" }));
  });

  it("writes a nuget.config with OneLobby.* from the folder and everything else from nuget.org", () => {
    expect(nugetConfig("../feed")).toBe(`<?xml version="1.0" encoding="utf-8"?>
<!-- managed by create-onelobby: the OneLobby packages come from this folder until they are released -->
<configuration>
  <packageSources>
    <clear />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="onelobby-local" value="../feed" />
  </packageSources>
  <packageSourceMapping>
    <packageSource key="onelobby-local">
      <package pattern="OneLobby.*" />
    </packageSource>
    <packageSource key="nuget.org">
      <package pattern="*" />
    </packageSource>
  </packageSourceMapping>
</configuration>
`);
  });

  it("writes the folder relative to the project with forward slashes", () => {
    const proj = join(dir, "game");
    mkdirSync(proj);
    expect(sourcePath(proj, dir)).toBe("..");
    expect(sourcePath(proj, join(dir, "feed"))).toBe("../feed");
    expect(sourcePath(dir, dir)).toBe(".");
  });
});
