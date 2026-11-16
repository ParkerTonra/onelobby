// Editing a Unity Packages/manifest.json in place, with no JSON library for the writing: add dependencies, or move the value of one,
// and keep every other byte (formatting, key order, line endings, a BOM, keys this code does not know). The text is checked with
// JSON.parse before and after; a file it cannot read as a plain manifest object with a "dependencies" object is refused
// (bad_manifest) before anything is written.
import { CliError } from "./flags.js";

/** The one package a Unity game takes OneLobby from. */
export const PACKAGE_NAME = "com.onelobby.unity";

const bad = (file, why) => new CliError("bad_manifest", `${file} is not a manifest this tool can edit safely (${why}); nothing was changed. Add the dependencies by hand (docs/recipes/unity.md, section 1)`);

/** The index after the JSON string that starts at `i` (text[i] is a quote). */
function skipString(t, i) {
  for (i++; i < t.length; i++) {
    if (t[i] === "\\") i++;
    else if (t[i] === '"') return i + 1;
  }
  return i;
}

/** The index after the JSON value that starts at `i`. */
function skipValue(t, i) {
  if (t[i] === '"') return skipString(t, i);
  if (t[i] === "{" || t[i] === "[") {
    let depth = 0;
    for (; i < t.length; i++) {
      if (t[i] === '"') i = skipString(t, i) - 1;
      else if (t[i] === "{" || t[i] === "[") depth++;
      else if (t[i] === "}" || t[i] === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return i;
  }
  while (i < t.length && !/[\s,}\]]/.test(t[i])) i++;
  return i;
}

const skipSpace = (t, i) => {
  while (i < t.length && /\s/.test(t[i])) i++;
  return i;
};

/** The members of the object whose `{` is at `open`: [{ key, keyStart, colon, valueStart, valueEnd }] and the index of its `}`. */
function members(t, open) {
  const out = [];
  let i = skipSpace(t, open + 1);
  while (t[i] !== "}") {
    const keyStart = i;
    const keyEnd = skipString(t, i);
    const key = JSON.parse(t.slice(keyStart, keyEnd));
    const colon = skipSpace(t, keyEnd);
    const valueStart = skipSpace(t, colon + 1);
    const valueEnd = skipValue(t, valueStart);
    out.push({ key, keyStart, colon, valueStart, valueEnd });
    i = skipSpace(t, valueEnd);
    if (t[i] === ",") i = skipSpace(t, i + 1);
  }
  return { list: out, close: i };
}

/** What an edit needs to know about a manifest; throws bad_manifest for one it must not touch. */
export function inspectManifest(text, file = "Packages/manifest.json") {
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw bad(file, `it is not valid JSON: ${e.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw bad(file, "the top level is not an object");
  if (typeof parsed.dependencies !== "object" || parsed.dependencies === null || Array.isArray(parsed.dependencies)) throw bad(file, 'it has no "dependencies" object');
  const start = skipSpace(text, text.charCodeAt(0) === 0xfeff ? 1 : 0);
  const top = members(text, start);
  const dep = top.list.find((m) => m.key === "dependencies");
  if (!dep || text[dep.valueStart] !== "{") throw bad(file, 'it has no "dependencies" object');
  const deps = members(text, dep.valueStart);
  const dupes = deps.list.map((m) => m.key).filter((k, i, a) => a.indexOf(k) !== i);
  if (dupes.length) throw bad(file, `"dependencies" names ${dupes[0]} twice`);
  return { parsed, deps: parsed.dependencies, open: dep.valueStart, close: deps.close, members: deps.list, depKeyStart: dep.keyStart };
}

const lineStart = (text, i) => text.lastIndexOf("\n", i - 1) + 1;
const indentOf = (text, i) => /^[ \t]*/.exec(text.slice(lineStart(text, i)))[0];
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const quote = (s) => JSON.stringify(s);

/**
 * Add the `wanted` [{ name, value }] dependencies the file does not mention yet (a name that is already there keeps its value).
 * Returns { text, changed, added: [name], present: [{ name, value }] }. The new lines follow the last entry, in its indentation.
 */
export function addDependencies(text, wanted, file) {
  const info = inspectManifest(text, file);
  const have = new Map(Object.entries(info.deps));
  const missing = wanted.filter((w) => !have.has(w.name));
  const present = wanted.filter((w) => have.has(w.name)).map((w) => ({ name: w.name, value: have.get(w.name) }));
  if (!missing.length) return { text, changed: false, added: [], present };
  const eol = eolOf(text);
  const last = info.members[info.members.length - 1];
  let out;
  if (last) {
    const multiline = text.slice(info.open, last.keyStart).includes("\n");
    const sep = /^"[^"]*"\s*:(\s*)/.exec(text.slice(last.keyStart, last.valueStart + 1))?.[1] ?? " "; // the whitespace after the colon, kept
    const after = text.slice(last.valueEnd, info.close);
    const join = multiline ? `,${eol}${indentOf(text, last.keyStart)}` : ", ";
    const items = missing.map((w) => `${quote(w.name)}:${sep}${quote(w.value)}`).join(join);
    out = text.slice(0, last.valueEnd) + join + items + after + text.slice(info.close);
  } else {
    const base = indentOf(text, info.depKeyStart);
    const unit = base.includes("\t") ? "\t" : "  ";
    const body = missing.map((w) => `${base}${unit}${quote(w.name)}: ${quote(w.value)}`).join(`,${eol}`);
    out = text.slice(0, info.open + 1) + eol + body + eol + base + text.slice(info.close);
  }
  // what was written must read back as the old file plus exactly the added entries
  const back = inspectManifest(out, file);
  const expected = { ...info.parsed, dependencies: { ...info.deps, ...Object.fromEntries(missing.map((w) => [w.name, w.value])) } };
  if (JSON.stringify(back.parsed) !== JSON.stringify(expected)) throw new CliError("internal", `editing ${file} did not read back as the old file plus the added dependencies; nothing was changed`);
  return { text: out, changed: true, added: missing.map((w) => w.name), present };
}

/** The value of one dependency, or null. */
export function readDependency(text, name, file) {
  const d = inspectManifest(text, file).deps[name];
  return typeof d === "string" ? d : null;
}

/** Move the value of one dependency (only that string). Returns { text, changed, from }; a name that is not there: { changed: false, from: null }. */
export function moveDependency(text, name, value, file) {
  const info = inspectManifest(text, file);
  const m = info.members.find((x) => x.key === name);
  if (!m || text[m.valueStart] !== '"') return { text, changed: false, from: null };
  const from = JSON.parse(text.slice(m.valueStart, m.valueEnd));
  if (from === value) return { text, changed: false, from };
  const out = text.slice(0, m.valueStart) + quote(value) + text.slice(m.valueEnd);
  const back = inspectManifest(out, file);
  if (back.deps[name] !== value) throw new CliError("internal", `editing ${file} did not read back; nothing was changed`);
  return { text: out, changed: true, from };
}

/** The text of a new project's manifest: the OneLobby package, the test framework and the built-in modules the menu needs. */
export function newManifest(deps) {
  return JSON.stringify({ dependencies: Object.fromEntries(deps.map((d) => [d.name, d.value])) }, null, 2) + "\n";
}
