// Where a Godot C# game gets the OneLobby NuGet packages: the public registry at the version this create-onelobby targets, or a local
// folder of .nupkg files (`--packages-from <folder>`: before a release, in CI and for tests), written as a nuget.config.
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { CliError } from "./flags.js";
import { ONELOBBY_VERSION } from "./blueprint.js";
import { ONELOBBY_PACKAGES } from "./csproj.js";

export const NUGET_CONFIG_MARK = "managed by create-onelobby: the OneLobby packages come from this folder until they are released";

const SEMVER = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";

/**
 * The versions of `ids` found as `<id>.<version>.nupkg` in `dir`: { version, files }. The three referenced packages must exist
 * at one common version. Throws bad_packages_from when the folder is missing, holds no such set, or holds several (name one).
 */
export function readFeed(dir, cwd = process.cwd(), ids = ONELOBBY_PACKAGES) {
  const abs = resolve(cwd, dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new CliError("bad_packages_from", `--packages-from: ${abs} is not a folder`);
  const names = readdirSync(abs);
  const found = new Map(); // id -> Set(version)
  for (const id of ids) {
    const re = new RegExp(`^${id.replace(/\./g, "\\.")}\\.(${SEMVER})\\.nupkg$`, "i");
    found.set(id, new Set(names.map((n) => re.exec(n)?.[1]).filter(Boolean)));
  }
  const common = [...found.get(ids[0])].filter((v) => ids.every((id) => found.get(id).has(v)));
  if (!common.length)
    throw new CliError(
      "bad_packages_from",
      `--packages-from: ${abs} has no version of ${ids.join(", ")} that all of them share (found: ${ids.map((id) => `${id} ${[...found.get(id)].join("/") || "none"}`).join("; ")}). Pack them with clients/dotnet/pack.sh <version> <folder>.`,
    );
  if (common.length > 1) throw new CliError("bad_packages_from", `--packages-from: ${abs} has several versions (${common.join(", ")}); NuGet would not know which to take. Use a folder with one.`);
  return { version: common[0], dir: abs };
}

/** The folder as a nuget.config source value: relative to the project when it is on the same drive, else absolute; forward slashes. */
export function sourcePath(projectDir, feedDir) {
  const rel = relative(projectDir, feedDir);
  const p = rel === "" ? "." : !isAbsolute(rel) ? rel : feedDir;
  return p.replace(/\\/g, "/");
}

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** nuget.config for a local feed: OneLobby.* from the folder, everything else (Godot.NET.Sdk, GodotSharp, ...) from nuget.org. */
export function nugetConfig(source) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<!-- ${NUGET_CONFIG_MARK} -->`,
    "<configuration>",
    "  <packageSources>",
    "    <clear />",
    '    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />',
    `    <add key="onelobby-local" value="${xml(source)}" />`,
    "  </packageSources>",
    "  <packageSourceMapping>",
    '    <packageSource key="onelobby-local">',
    '      <package pattern="OneLobby.*" />',
    "    </packageSource>",
    '    <packageSource key="nuget.org">',
    '      <package pattern="*" />',
    "    </packageSource>",
    "  </packageSourceMapping>",
    "</configuration>",
    "",
  ].join("\n");
}

/** The package version a run targets: the feed's with --packages-from, else this create-onelobby's (the version of its published packages). */
export function targetVersion(opts, cwd) {
  if (opts.packagesFrom !== undefined) return { ...readFeed(opts.packagesFrom, cwd), from: "feed" };
  return { version: ONELOBBY_VERSION, dir: null, from: "registry" };
}

export const hasMark = (text) => text.includes(NUGET_CONFIG_MARK);
