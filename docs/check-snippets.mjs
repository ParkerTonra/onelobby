#!/usr/bin/env node
// Extracts every fenced snippet tagged `ts compile`, `csharp compile` or `gdscript compile` from AGENTS.md and
// docs/recipes/*.md and type-checks it against the real client code.
//   ```ts compile file=net.ts        -> tsc --noEmit with "onelobby" mapped to clients/js/packages/client/src/index.ts
//   ```csharp compile file=Net.cs    -> temp csproj with ProjectReferences to clients/dotnet/OneLobby.Core (+ OneLobby.Replication, OneLobby.DataChannel, OneLobby.Direct)
//   ```gdscript compile file=net.gd  -> temp Godot project with clients/gdscript/addons/onelobby, parsed headless by the
//                                      Godot at $GODOT (WAITING when GODOT is unset)
// Snippets of one markdown file share a folder, so ts snippets can import each other ("./settings"). Untagged fences and
// ```csharp godot fences are documentation only. Flags: --strict (a missing client counts as a failure).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const lf = (s) => s.replace(/\r\n/g, "\n");

const docs = [path.join(root, "AGENTS.md")];
const rdir = path.join(root, "docs", "recipes");
if (fs.existsSync(rdir)) for (const f of fs.readdirSync(rdir).sort()) if (f.endsWith(".md")) docs.push(path.join(rdir, f));

const snippets = []; // { doc, lang, file, code, line }
for (const doc of docs) {
  if (!fs.existsSync(doc)) continue;
  const lines = lf(fs.readFileSync(doc, "utf8")).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^```(\w+)\s+compile\b(.*)$/.exec(lines[i]);
    if (!m) continue;
    const fm = /file=(\S+)/.exec(m[2]);
    const start = i + 1;
    let j = start;
    while (j < lines.length && !lines[j].startsWith("```")) j++;
    snippets.push({
      doc: path.relative(root, doc).replace(/\\/g, "/"), lang: m[1].toLowerCase(),
      file: fm ? fm[1] : `snippet${snippets.length}.${{ csharp: "cs", gdscript: "gd" }[m[1]] ?? "ts"}`,
      code: lines.slice(start, j).join("\n") + "\n", line: start + 1,
    });
    i = j;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ka-snip-"));
let failed = 0, waiting = 0, checked = 0;
const fwd = (p) => p.replace(/\\/g, "/");
const mapBack = (text, dirs) => {
  for (const [dir, mapping] of dirs) text = text.split(fwd(dir)).join(mapping);
  return text;
};

// ---- TypeScript ----
const ts = snippets.filter((s) => s.lang === "ts" || s.lang === "typescript");
if (ts.length) {
  const entry = path.join(root, "clients", "js", "packages", "client", "src", "index.ts");
  const tsc = path.join(root, "clients", "js", "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(entry) || !fs.existsSync(tsc)) {
    waiting += ts.length;
    console.warn(`WAITING ${ts.length} ts snippets: ${!fs.existsSync(entry) ? "clients/js/packages/client/src/index.ts has not landed" : "typescript is not installed in clients/js (npm ci)"}`);
  } else {
    const dir = path.join(tmp, "ts");
    const files = [];
    for (const s of ts) {
      const f = path.join(dir, s.doc.replace(/[\\/]/g, "_").replace(/\.md$/, ""), s.file);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, s.code);
      files.push(fwd(f));
    }
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2022", "DOM", "DOM.Iterable"],
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        baseUrl: fwd(dir), paths: { "onelobby": [fwd(entry)] },
      },
      files,
    }, null, 1));
    try {
      execFileSync(process.execPath, [tsc, "-p", path.join(dir, "tsconfig.json")], { stdio: "pipe" });
      checked += ts.length;
      console.log(`ok   ${ts.length} ts snippets`);
    } catch (e) {
      const out = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
      const mine = out.split("\n").filter((l) => fwd(l).startsWith(fwd(dir)));
      if (mine.length === 0 && out.trim()) { // errors only inside the client: not the docs' fault
        waiting += ts.length;
        console.warn("WAITING ts snippets: clients/js has its own type errors:\n" + out.split("\n").slice(0, 5).join("\n"));
      } else {
        failed += ts.length;
        console.error("FAIL ts snippets:\n" + mapBack(mine.join("\n"), [[dir + path.sep, ""], [dir + "/", ""]]));
      }
    }
  }
}

// ---- C# ----
const cs = snippets.filter((s) => s.lang === "csharp" || s.lang === "cs");
if (cs.length) {
  const proj = path.join(root, "clients", "dotnet", "OneLobby.Core", "OneLobby.Core.csproj");
  const dcProj = path.join(root, "clients", "dotnet", "OneLobby.DataChannel", "OneLobby.DataChannel.csproj");
  const directProj = path.join(root, "clients", "dotnet", "OneLobby.Direct", "OneLobby.Direct.csproj");
  if (!fs.existsSync(proj)) {
    waiting += cs.length;
    console.warn(`WAITING ${cs.length} csharp snippets: OneLobby.Core.csproj has not landed`);
  } else {
    const dir = path.join(tmp, "cs");
    for (const s of cs) {
      const f = path.join(dir, s.doc.replace(/[\\/]/g, "_").replace(/\.md$/, ""), s.file);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, s.code);
    }
    const repl = path.join(root, "clients", "dotnet", "OneLobby.Replication", "OneLobby.Replication.csproj");
    const refs = [proj, ...[repl, dcProj, directProj].filter((p) => fs.existsSync(p))].map((p) => `<ProjectReference Include="${fwd(p)}" />`).join("");
    let tfm = "net8.0";
    try { tfm = "net" + execFileSync("dotnet", ["--version"], { encoding: "utf8" }).trim().split(".")[0] + ".0"; } catch { /* keep default */ }
    fs.writeFileSync(path.join(dir, "Snippets.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>${tfm}</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
    <EnableDefaultCompileItems>true</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup>${refs}</ItemGroup>
</Project>
`);
    try {
      execFileSync("dotnet", ["build", path.join(dir, "Snippets.csproj"), "-nologo", "-v", "q", "-clp:ErrorsOnly", "-m:1",
        "-p:UseSharedCompilation=false"], { stdio: "pipe", encoding: "utf8", maxBuffer: 1 << 24 });
      checked += cs.length;
      console.log(`ok   ${cs.length} csharp snippets`);
    } catch (e) {
      const out = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
      const errs = [...new Set(out.split("\n").filter((l) => /error [A-Z]+\d+/.test(l)))];
      const mine = errs.filter((l) => fwd(l).includes(fwd(dir)) && !fwd(l).includes("/clients/dotnet/"));
      if (mine.length === 0) {
        waiting += cs.length;
        console.warn("WAITING csharp snippets: OneLobby.Core does not build yet:\n" + errs.slice(0, 5).join("\n"));
      } else {
        failed += cs.length;
        console.error("FAIL csharp snippets:\n" + mapBack(mine.join("\n"), [[dir + path.sep, ""], [dir + "/", ""]]));
      }
    }
  }
}

// ---- GDScript ----
const gd = snippets.filter((s) => s.lang === "gdscript" || s.lang === "gd");
if (gd.length) {
  const addon = path.join(root, "clients", "gdscript", "addons", "onelobby");
  const godot = process.env.GODOT;
  if (!fs.existsSync(addon)) {
    waiting += gd.length;
    console.warn(`WAITING ${gd.length} gdscript snippets: clients/gdscript/addons/onelobby has not landed`);
  } else if (!godot) {
    waiting += gd.length;
    console.warn(`WAITING ${gd.length} gdscript snippets: set GODOT to a Godot 4.4+ executable`);
  } else {
    const dir = path.join(tmp, "gd");
    fs.mkdirSync(path.join(dir, "addons"), { recursive: true });
    fs.cpSync(addon, path.join(dir, "addons", "onelobby"), { recursive: true });
    // unsafe access counts as an error, so a misspelled addon member in a snippet fails (the addon itself is excluded)
    fs.writeFileSync(path.join(dir, "project.godot"), fs.readFileSync(path.join(root, "clients", "gdscript", "project.godot"), "utf8")
      .replace(/\[debug\]\r?\n/, "[debug]\n\ngdscript/warnings/unsafe_property_access=2\ngdscript/warnings/unsafe_method_access=2\n"));
    const files = [];
    for (const s of gd) {
      const rel = `snippets/${s.doc.replace(/[\/]/g, "_").replace(/\.md$/, "")}/${s.file}`;
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), s.code);
      files.push({ rel, s });
    }
    // loads every snippet; a parse error makes load() fail and Godot print the file and line
    fs.writeFileSync(path.join(dir, "check.gd"), `extends SceneTree
func _init() -> void:
	var bad := 0
	for p: String in ${JSON.stringify(files.map((f) => "res://" + f.rel))}:
		var s := ResourceLoader.load(p, "", ResourceLoader.CACHE_MODE_IGNORE) as GDScript
		if s == null or not s.can_instantiate():
			bad += 1
			print("SNIPPET-FAIL ", p)
	print("SNIPPETS-DONE ", bad)
	quit(1 if bad > 0 else 0)
`);
    const run = (args) => {
      try { return execFileSync(godot, ["--headless", "--audio-driver", "Dummy", "--path", dir, ...args], { encoding: "utf8", stdio: "pipe", timeout: 180000 }); }
      catch (e) { return (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? ""); }
    };
    run(["--import"]); // registers the addon's class_names; the headless editor may crash on exit, which is harmless
    const out = run(["-s", "res://check.gd"]);
    const done = /SNIPPETS-DONE (\d+)/.exec(out);
    if (done && done[1] === "0") {
      checked += gd.length;
      console.log(`ok   ${gd.length} gdscript snippets`);
    } else {
      failed += gd.length;
      const lines = out.split("\n").filter((l) => /SNIPPET-FAIL|ERROR|Parse Error|at: /.test(l)).slice(0, 20);
      console.error("FAIL gdscript snippets:\n" + (lines.length ? lines.join("\n") : out.slice(-2000)).split("res://snippets/").join(""));
    }
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`snippets: ${snippets.length} tagged, ${checked} checked, ${waiting} waiting, ${failed} failed`);
process.exit(failed > 0 || (strict && waiting > 0) ? 1 : 0);
