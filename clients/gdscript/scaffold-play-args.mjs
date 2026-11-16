// Used by scaffold-test.sh: read the host and joiner arguments of a scaffolded project's play entry (.olc/<slug>.json, both
// shells) and check that AGENTS.md shows the same command lines. Prints two lines: the host's arguments, the joiner's.
//   node scaffold-play-args.mjs <project dir>
import { readFileSync } from "node:fs";
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
const join = /-- (--join=\S+[^;&]*)$/.exec(bash)?.[1];
if (!host || !join) fail(`cannot read the host and joiner arguments from .olc/${basename(dir)}.json`);
const quoted = (a) => a.split(" ").map((x) => `'${x}'`).join(",");
if (!ps.includes(quoted(host)) || !ps.includes(`-- ${join}`)) fail("the powershell task has other arguments than the bash task");
const agents = readFileSync(`${dir}/AGENTS.md`, "utf8");
for (const a of [host, join]) {
  const flags = a.replace(/--name=\S+/, "").trim();
  if (!agents.includes(`-- ${flags}`)) fail(`AGENTS.md does not show "-- ${flags}"`);
}
console.log(host);
console.log(join);
