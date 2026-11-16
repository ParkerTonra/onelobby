// Editing a Godot C# project file (.csproj) in place, with no XML library: add the OneLobby package references, or move their
// versions, and keep every other byte (formatting, comments, line endings, a BOM, content this code does not know).
// A file it cannot read as well-formed MSBuild XML with a Godot.NET.Sdk project is refused (bad_csproj) before anything is written.
import { CliError } from "./flags.js";

/** The packages a Godot C# game references: the core, the Godot transport and the hosting without a server. */
export const ONELOBBY_PACKAGES = ["OneLobby.Core", "OneLobby.Godot", "OneLobby.Direct"];

/** Blank out comments and CDATA with spaces (same length, same line breaks), so tag positions in the result are positions in the text. */
const mask = (t) => t.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => m.replace(/[^\r\n]/g, " "));

const TAG = /<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

/** The element tree of a .csproj: { root, nodes }. Throws bad_csproj when it is not well-formed. */
function parse(text, file) {
  const m = mask(text);
  const bad = (why) => new CliError("bad_csproj", `${file} is not a project file this tool can edit safely (${why}); nothing was changed. Add the package references by hand (docs/recipes/godot-csharp.md, section 1)`);
  const nodes = [];
  const stack = [];
  let root = null;
  let last = 0;
  let after = false;
  for (const t of m.matchAll(TAG)) {
    const between = m.slice(last, t.index);
    if (between.includes("<")) throw bad("a stray < outside any tag");
    last = t.index + t[0].length;
    if (t[0].startsWith("<?")) {
      if (root) throw bad("content after the root element");
      continue;
    }
    if (after) throw bad("content after the root element");
    const [whole, closing, name, attrs, selfClose] = t;
    if (closing) {
      const top = stack.pop();
      if (!top || top.name !== name) throw bad(`</${name}> does not match ${top ? `<${top.name}>` : "any open element"}`);
      top.closeStart = t.index;
      top.closeEnd = last;
      if (!stack.length) after = true;
      continue;
    }
    const node = { name, attrs, selfClose: selfClose === "/", start: t.index, openEnd: last, closeStart: -1, closeEnd: last, children: [], parent: stack[stack.length - 1] ?? null, text };
    if (!node.parent) {
      if (root) throw bad("more than one root element");
      root = node;
    } else node.parent.children.push(node);
    nodes.push(node);
    if (!node.selfClose) stack.push(node);
    else if (!stack.length) after = true;
    void whole;
  }
  if (stack.length) throw bad(`<${stack[stack.length - 1].name}> is never closed`);
  if (m.slice(last).includes("<")) throw bad("a stray < after the last tag");
  if (!root) throw bad("no element at all");
  if (root.name !== "Project") throw bad(`the root element is <${root.name}>, not <Project>`);
  if (root.selfClose) throw bad("<Project /> is empty");
  return { root, nodes, masked: m };
}

const attr = (node, name) => {
  const r = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(node.attrs);
  if (!r) return null;
  const quote = r[1][0];
  const valueStart = node.start + 1 + node.name.length + r.index + r[0].length - r[1].length + 1;
  const value = r[2] ?? r[3];
  return { value, quote, start: valueStart, end: valueStart + value.length };
};

/** Everything an edit needs to know about a project file; throws bad_csproj for one it must not touch. */
export function inspectCsproj(text, file = "the project file") {
  const { root, nodes, masked } = parse(text, file);
  const hasGodotSdk = /Godot\.NET\.Sdk/.test(masked.slice(0, root.openEnd)) || nodes.some((n) => (n.name === "Sdk" || n.name === "Import") && /Godot\.NET\.Sdk/.test(n.attrs));
  if (!hasGodotSdk) throw new CliError("bad_csproj", `${file} does not use Godot.NET.Sdk (a Godot C# project file starts with <Project Sdk="Godot.NET.Sdk/4.x">); nothing was changed`);
  const tf = nodes.find((n) => n.name === "TargetFramework" && !n.selfClose);
  const framework = tf ? masked.slice(tf.openEnd, tf.closeStart).trim() : null;
  const major = framework ? /^net(\d+)\.\d+/.exec(framework) : null;
  if (major && Number(major[1]) < 8) throw new CliError("bad_csproj", `${file} targets ${framework}; the OneLobby packages need net8.0 or newer (Godot 4.5 and later use net8.0); nothing was changed`);
  const sdkText = /Godot\.NET\.Sdk\/([\w.+-]+)/.exec(masked)?.[1] ?? null;
  const refs = nodes
    .filter((n) => n.name === "PackageReference")
    .map((n) => {
      const id = attr(n, "Include") ?? attr(n, "Update");
      let version = attr(n, "Version");
      let form = "attribute";
      if (!version && !n.selfClose) {
        const child = n.children.find((c) => c.name === "Version" && !c.selfClose);
        if (child) {
          version = { value: masked.slice(child.openEnd, child.closeStart).trim(), start: child.openEnd, end: child.closeStart, raw: true };
          form = "element";
        }
      }
      return { id: id?.value ?? null, version: version?.value ?? null, versionAt: version ? { start: version.start, end: version.end } : null, form, node: n };
    });
  const rootChild = root.children[0];
  return { root, nodes, refs, framework, sdkVersion: sdkText, rootChild, masked };
}

const lineStart = (text, i) => text.lastIndexOf("\n", i - 1) + 1;
const indentOf = (text, i) => /^[ \t]*/.exec(text.slice(lineStart(text, i)))[0];
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");

const line = (id, version) => `<PackageReference Include="${id}" Version="${version}" />`;

/**
 * Add `PackageReference` entries for the `wanted` [{ id, version }] that the file does not mention yet (an `Include` of the same id in any
 * form counts as there; its version is left alone). Returns { text, changed, added: [id], present: [{ id, version }] }.
 * The new lines go after the last package reference of an unconditional ItemGroup, or in a new ItemGroup before </Project>.
 */
export function addReferences(text, wanted, file) {
  const info = inspectCsproj(text, file);
  const have = new Map(info.refs.filter((r) => r.id).map((r) => [r.id, r.version]));
  const missing = wanted.filter((w) => !have.has(w.id));
  const present = wanted.filter((w) => have.has(w.id)).map((w) => ({ id: w.id, version: have.get(w.id) }));
  if (!missing.length) return { text, changed: false, added: [], present };
  const eol = eolOf(text);
  const groups = info.nodes.filter((n) => n.name === "ItemGroup" && !n.selfClose && !/Condition\s*=/.test(n.attrs) && n.children.some((c) => c.name === "PackageReference"));
  let out;
  if (groups.length) {
    const g = groups[groups.length - 1];
    const prev = [...g.children].reverse().find((c) => c.name === "PackageReference");
    const indent = indentOf(text, prev.start);
    out = text.slice(0, prev.closeEnd) + missing.map((w) => `${eol}${indent}${line(w.id, w.version)}`).join("") + text.slice(prev.closeEnd);
  } else {
    const first = info.root.children[0];
    const unit = first ? (indentOf(text, first.start) || "  ") : "  ";
    const close = info.root.closeStart;
    const own = /^[ \t]*$/.test(text.slice(lineStart(text, close), close));
    const block = [`${unit}<ItemGroup>`, ...missing.map((w) => `${unit}${unit}${line(w.id, w.version)}`), `${unit}</ItemGroup>`].join(eol) + eol;
    out = own ? text.slice(0, lineStart(text, close)) + block + text.slice(lineStart(text, close)) : text.slice(0, close) + eol + block + text.slice(close);
  }
  inspectCsproj(out, file); // what was written must read back
  return { text: out, changed: true, added: missing.map((w) => w.id), present };
}

/**
 * Move every `OneLobby.*` package reference to `version` (only the Version value: an attribute or a <Version> element).
 * A version that is a property (`$(OneLobbyVersion)`) is left and listed in `skipped`. Returns { text, changed, moved: [{ id, from, to }], skipped: [{ id, why }], refs }.
 */
export function moveReferences(text, version, file) {
  const info = inspectCsproj(text, file);
  const ours = info.refs.filter((r) => r.id?.startsWith("OneLobby."));
  const moved = [];
  const skipped = [];
  const edits = [];
  for (const r of ours) {
    if (!r.versionAt || r.version === null) {
      skipped.push({ id: r.id, why: "it has no Version value in the file (central package management or a property)" });
      continue;
    }
    if (/\$\(|\*/.test(r.version)) {
      skipped.push({ id: r.id, why: `its Version is ${r.version}, not a plain number; edit it yourself` });
      continue;
    }
    if (r.version !== version) {
      moved.push({ id: r.id, from: r.version, to: version });
      edits.push({ ...r.versionAt, to: version });
    }
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.to + out.slice(e.end);
  if (edits.length) inspectCsproj(out, file);
  return { text: out, changed: edits.length > 0, moved, skipped, refs: ours.map((r) => ({ id: r.id, version: r.version })) };
}

/** The OneLobby references a project file has, [{ id, version }]. */
export function oneLobbyRefs(text, file) {
  return inspectCsproj(text, file)
    .refs.filter((r) => r.id?.startsWith("OneLobby."))
    .map((r) => ({ id: r.id, version: r.version }));
}

/** The text of a new project's .csproj. */
export function newCsproj({ sdkVersion, assembly, rootNamespace, refs }) {
  return [
    `<Project Sdk="Godot.NET.Sdk/${sdkVersion}">`,
    "  <PropertyGroup>",
    "    <TargetFramework>net8.0</TargetFramework>",
    "    <EnableDynamicLoading>true</EnableDynamicLoading>",
    `    <RootNamespace>${rootNamespace}</RootNamespace>`,
    `    <AssemblyName>${assembly}</AssemblyName>`,
    "    <Nullable>enable</Nullable>",
    "    <LangVersion>latest</LangVersion>",
    "    <InvariantGlobalization>true</InvariantGlobalization>",
    "  </PropertyGroup>",
    "  <ItemGroup>",
    ...refs.map((r) => `    ${line(r.id, r.version)}`),
    "  </ItemGroup>",
    "</Project>",
    "",
  ].join("\n");
}
