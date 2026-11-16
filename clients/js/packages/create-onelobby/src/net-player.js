// The networked player in the two Godot templates: when does a game get it, and the small text tools that write its files.
// A game gets the player pieces when the blueprint has `sync.mode` "replication" AND the person asked for `sync.player` (a flag, `--set
// sync.player.authority=...`, a `--from` file, or the recommendation). The loader fills `sync.player` with defaults for every replication
// blueprint, so the written file cannot tell "asked" from "defaulted": the question is asked of the answers, before the loader runs.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPath } from "./flags.js";

/** True when these answers (before the loader fills defaults) ask for players in the world. */
export function answersWantNetPlayer(answers) {
  return getPath(answers, "sync.mode") === "replication" && getPath(answers, "sync.player") !== undefined;
}

/** `{ authority, space }` of a loaded or hand-written blueprint, with the schema's defaults (owner, 3d). */
export function playerSettings(blueprint) {
  const p = blueprint?.sync?.player ?? {};
  return { authority: p.authority === "host" ? "host" : "owner", space: p.space === "2d" ? "2d" : "3d" };
}

/**
 * What the template should write for this run: `{ authority, space }`, or null for a game without the player pieces.
 * `wanted`: the answers asked for it (answersWantNetPlayer). `--into` with an existing onelobby.json that this run will keep (it differs
 * and there is no --force) is decided by that file: replication and a `sync.player` section in it.
 */
export function resolveNetPlayer({ wanted, blueprint, target, into, force }) {
  let want = wanted;
  let bp = blueprint;
  const file = join(target, "onelobby.json");
  if (into && existsSync(file)) {
    const text = readFileSync(file, "utf8");
    let kept = false;
    try {
      kept = !force && text.replace(/\r\n/g, "\n") !== JSON.stringify(blueprint, null, 2) + "\n";
      if (kept) {
        bp = JSON.parse(text);
        want = bp?.sync?.mode === "replication" && bp?.sync?.player !== undefined;
      }
    } catch {
      kept = false; // unreadable: the plan reports it as it always did; no player pieces
      want = false;
    }
  }
  if (!want || bp?.sync?.mode !== "replication") return null;
  return playerSettings(bp);
}

/**
 * Keep or drop blocks of a template. A block is `#@if <flag>` ... `#@end` (GDScript) or `//@if <flag>` ... `//@end` (C#) on lines of their
 * own (leading tabs or spaces allowed); its lines are kept (marker lines removed) when `flags[flag]` is true and dropped otherwise.
 * Blocks may nest: a line is kept when every block around it is on.
 */
export function pickBlocks(text, flags) {
  const out = [];
  const open = []; // one boolean per open block
  for (const line of text.split("\n")) {
    const m = /^\s*(?:#|\/\/)@(if\s+(\w+)|end)\s*$/.exec(line);
    if (!m) {
      if (open.every(Boolean)) out.push(line);
    } else if (m[2] !== undefined) open.push(Boolean(flags[m[2]]));
    else if (open.pop() === undefined) throw new Error("net-player template: #@end without #@if");
  }
  if (open.length) throw new Error("net-player template: #@if without #@end");
  return out.join("\n");
}

/** The flags a GDScript template block is picked with. */
export const playerFlags = ({ authority, space }) => ({ owner: authority === "owner", host: authority === "host", "3d": space === "3d", "2d": space === "2d" });
