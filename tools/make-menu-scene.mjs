#!/usr/bin/env node
// Writes the Godot C# menu scene from the GDScript one, so the layout has ONE source of truth:
//   clients/gdscript/addons/onelobby/menu/menu.tscn  ->  clients/dotnet/demo-godot/addons/onelobby_menu/OneLobbyMenu.tscn
// The two scenes differ only in the root node's script (menu.gd / OneLobbyMenu.cs). The dotnet tests
// (MenuSceneTests) read both files and fail when their node trees differ, so a change to one cannot leave the other behind.
//
//   node tools/make-menu-scene.mjs          write the C# scene
//   node tools/make-menu-scene.mjs --check  exit 1 when the C# scene on disk is not what would be written
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "clients/gdscript/addons/onelobby/menu/menu.tscn");
const to = join(root, "clients/dotnet/demo-godot/addons/onelobby_menu/OneLobbyMenu.tscn");

const gd = readFileSync(from, "utf8").replace(/\r\n/g, "\n");
const scriptLine = /^\[ext_resource type="Script" path="res:\/\/addons\/onelobby\/menu\/menu\.gd" id="([^"]+)"\]$/m;
if (!scriptLine.test(gd)) throw new Error("menu.tscn: the root script's ext_resource line was not found");
const cs = gd.replace(scriptLine, (_m, id) => `[ext_resource type="Script" path="res://addons/onelobby_menu/OneLobbyMenu.cs" id="${id}"]`);

if (process.argv.includes("--check")) {
  const now = existsSync(to) ? readFileSync(to, "utf8").replace(/\r\n/g, "\n") : "";
  if (now !== cs) {
    console.error("OneLobbyMenu.tscn is out of date: run node tools/make-menu-scene.mjs");
    process.exit(1);
  }
  console.log("OneLobbyMenu.tscn matches menu.tscn");
} else {
  writeFileSync(to, cs);
  console.log("wrote " + to);
}
