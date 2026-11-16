// Used by scaffold-test.sh: read the host and joiner arguments of a scaffolded project's play entry (.olc/<slug>.json, both
// shells) and (when the project has an AGENTS.md) check that it shows the same command lines. Prints two lines: the host's arguments, the joiner's.
//   node scaffold-play-args.mjs <project dir>
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const dir = resolve(process.argv[2]);
const fail = (why) => {
  console.error(why);
  process.exit(1);
};
const entries = JSON.parse(readFileSync(`${dir}/.olc/${basename(dir)}.json`, "utf8")).entries;
const bash = entries.find((e) => e.shell === "bash")?.command ?? "";
const ps = entries.find((e) => e.shell === "powershell")?.command ?? "";
const host = /-- (--host[^&;]*?) *&/.exec(bash)?.[1];
const join = /-- (--local --name=Joiner)$/.exec(bash)?.[1]; // no --join: the joiner takes the host's printed code, not a fixed port
if (!host || !join) fail(`cannot read the host and joiner arguments from .olc/${basename(dir)}.json`);
const quoted = (a) => a.split(" ").map((x) => `'${x}'`).join(",");
if (!ps.includes(quoted(host)) || !ps.includes(`-- ${join}`)) fail("the powershell task has other arguments than the bash task");
// a game the scaffolder was added to (--into) has no AGENTS.md of the scaffolder's: only a new project is matched against it
const agents = existsSync(`${dir}/AGENTS.md`) ? readFileSync(`${dir}/AGENTS.md`, "utf8") : null;
for (const a of agents === null ? [] : [host, join]) {
  const flags = a.replace(/--name=\S+/, "").trim();
  if (!agents.includes(`-- ${flags}`)) fail(`AGENTS.md does not show "-- ${flags}"`);
}
console.log(host);
console.log(join);
