// `create-onelobby --recommend "<one-line game description>"`: a deterministic matcher over one sentence (no network, no model, no
// dependency) that proposes the multiplayer setup. Every rule is data in recommend-data.js; this file only reads it.
//   recommend({ description, engine })  -> the facts (the --json object)
//   renderText(rec)                      -> the same for a person
//   recommendedRows(rec)                 -> [key, value, why] rows a scaffold run can use as answers
import { ANSWER_FLAGS, CliError } from "./flags.js";
import {
  ADVICE,
  DENIED_WORDS,
  DETERMINISM_WORD,
  DUEL_TERMS,
  ENGINES,
  ENGINE_TERMS,
  MIN_MARGIN,
  MIN_SCORE,
  NEGATION_FILLERS,
  NEGATORS,
  NOT_PLAYERS_AFTER_FOR,
  NUMBER_WORDS,
  PAUSE_MODIFIERS,
  QUESTIONS,
  SHAPES,
  SPECTATOR_DEFAULT,
  SPECTATOR_TERMS,
  VETOES,
} from "./recommend-data.js";

// ---- reading the sentence ----------------------------------------------------------------------------------------------

/** Words of the description with their place in it: [{ w (lower case), start, end }]. Letters, digits, `#` and `'` make a word. */
export function tokenize(text) {
  const out = [];
  for (const m of text.matchAll(/[\p{L}\p{N}#']+/gu)) out.push({ w: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return out;
}

const words = (term) => term.split(" ");
/** Does `word` equal `base` or its plain plural? */
const sameWord = (word, base) => word === base || word === `${base}s` || word === `${base}es`;

/** Is the word at `i` denied by the words before it ("no physics", "non-deterministic", "not a shooter")? */
const negated = (tokens, i) => (i > 0 && NEGATORS.includes(tokens[i - 1].w)) || (i > 1 && NEGATION_FILLERS.includes(tokens[i - 1].w) && NEGATORS.includes(tokens[i - 2].w));

/** Join a denied word that has a meaning of its own with its denial: "not fully deterministic" becomes the one word "nondeterministic". */
function joinDenied(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const joined = DENIED_WORDS[tokens[i].w];
    if (joined && negated(tokens, i)) {
      const back = NEGATORS.includes(tokens[i - 1].w) ? 1 : 2;
      out.splice(out.length - back, back);
      out.push({ w: joined, start: tokens[i - back].start, end: tokens[i].end });
    } else out.push(tokens[i]);
  }
  return out;
}

/**
 * First place the term's words appear in a row (the last word may be plural) that no `claimed` token covers and that is not denied
 * by the words before it; -1 if none.
 */
function findTerm(tokens, term, claimed) {
  const ws = words(term);
  for (let i = 0; i + ws.length <= tokens.length; i++) {
    let ok = !negated(tokens, i);
    for (let k = 0; k < ws.length && ok; k++) {
      if (claimed.has(i + k)) ok = false;
      else ok = k === ws.length - 1 ? sameWord(tokens[i + k].w, ws[k]) : tokens[i + k].w === ws[k];
    }
    if (ok) return i;
  }
  return -1;
}

const has = (tokens, term) => findTerm(tokens, term, new Set()) >= 0;
const hasAny = (tokens, terms) => terms.some((t) => has(tokens, t));

/** The matches of a term list: longest terms first, a word counts once. Returns [{ term, weight, from, to }] sorted by place. */
function matchTerms(tokens, list) {
  const claimed = new Set();
  const found = [];
  const ordered = [...list].sort((a, b) => words(b[0]).length - words(a[0]).length);
  for (const [term, weight] of ordered) {
    const at = findTerm(tokens, term, claimed);
    if (at < 0) continue;
    const n = words(term).length;
    for (let k = 0; k < n; k++) claimed.add(at + k);
    found.push({ term, weight, from: at, to: at + n - 1 });
  }
  return found.sort((a, b) => a.from - b.from);
}

const slice = (text, tokens, m) => text.slice(tokens[m.from].start, tokens[m.to].end);

/** The engine a description names: { id, words, settled } or null. */
export function detectEngine(text) {
  const tokens = tokenize(text);
  const ws = tokens.map((t) => t.w);
  for (const row of ENGINE_TERMS) {
    if (row.allOf) {
      const picks = row.allOf.map((group) => ws.findIndex((w) => group.includes(w)));
      if (picks.every((i) => i >= 0)) return { id: row.engine, words: picks.map((i) => text.slice(tokens[i].start, tokens[i].end)), settled: true };
    } else {
      const at = ws.findIndex((w, i) => row.anyOf.includes(w) && !row.notBefore?.[w]?.includes(ws[i + 1]));
      if (at >= 0) return { id: row.engine, words: [text.slice(tokens[at].start, tokens[at].end)], settled: !row.settledBy || ws.some((w) => row.settledBy.includes(w)) };
    }
  }
  return null;
}

const numberOf = (raw) => (/^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw]);
const NUM = `(\\d+|${Object.keys(NUMBER_WORDS).join("|")})`;

/** The player count the description gives: { max, text } or null. */
export function readPlayers(text) {
  const lower = text.toLowerCase();
  const tries = [
    [new RegExp(`\\b${NUM}\\s*(?:-|to|or)\\s*${NUM}\\s*(?:players?|people|persons?|friends)\\b`), (m) => Math.max(numberOf(m[1]), numberOf(m[2]))],
    [new RegExp(`\\bup to ${NUM}\\b`), (m) => numberOf(m[1])],
    [/\b(\d+)\s*v\s*(\d+)\b/, (m) => Number(m[1]) + Number(m[2])],
    [new RegExp(`\\b${NUM}[\\s-]*(?:players?|people|persons?|friends)\\b`), (m) => numberOf(m[1])],
    [new RegExp(`\\bfor ${NUM}\\b(?!\\s*(?:${NOT_PLAYERS_AFTER_FOR.join("|")})\\b)`), (m) => numberOf(m[1])],
  ];
  for (const [re, pick] of tries) {
    const m = re.exec(lower);
    if (!m) continue;
    const n = pick(m);
    if (Number.isInteger(n) && n >= 2) return { max: Math.min(n, 64), text: text.slice(m.index, m.index + m[0].length) };
  }
  const tokens = tokenize(text);
  const duel = DUEL_TERMS.find((t) => has(tokens, t) || lower.includes(t));
  return duel ? { max: 2, text: duel } : null;
}

/** The tick rate in Hz the description gives, or null. */
export function readTickRate(text) {
  const m = /\b(\d+)\s*(?:hz|ticks?\s*(?:per|a|\/)\s*(?:second|s|sec)|tps)\b/i.exec(text) ?? /\b(\d+)[\s-]*ticks?\b/i.exec(text);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 120 ? n : null;
}

// ---- choosing the shape ------------------------------------------------------------------------------------------------

/** Score every shape. Returns [{ id, score, matched: [{ term, weight, from, to }], banned?, notes: [] }] in table order. */
function scoreShapes(tokens, engineId) {
  return SHAPES.map((shape) => {
    const matched = matchTerms(tokens, shape.terms);
    let score = matched.reduce((n, m) => n + m.weight, 0);
    const notes = [];
    let banned = false;
    for (const v of VETOES.filter((x) => x.shape === shape.id && (!x.engine || x.engine === engineId))) {
      if (!hasAny(tokens, v.terms)) continue;
      if (v.unless && hasAny(tokens, v.unless)) continue;
      if (v.ban) {
        banned = true;
        score = 0;
      } else score = Math.max(0, score - v.penalty);
      notes.push(v.note);
    }
    return { id: shape.id, score, matched, banned, notes };
  });
}

function pickShape(scores) {
  const ranked = [...scores].sort((a, b) => b.score - a.score);
  const [best, next] = ranked;
  if (best.score >= MIN_SCORE && best.score - (next?.score ?? 0) >= MIN_MARGIN) return best;
  return null;
}

// ---- building the proposal ---------------------------------------------------------------------------------------------

const engineData = (id) => (id ? ENGINES[id] : null);

/** The mode to propose: the first the template writes; a `limit` row when the best one is refused. */
function chooseMode(shape, engineId) {
  const engine = engineData(engineId);
  const [best] = shape.modes;
  if (!engine || engine.modes.includes(best.mode)) return { row: best, limit: null };
  const row = shape.modes.find((m) => engine.modes.includes(m.mode)) ?? shape.modes[shape.modes.length - 1];
  const refusal = engine.modeRefusal?.[best.mode] ?? `the ${engineId} template cannot write ${best.mode} yet`;
  return {
    row: { ...row, why: `${row.why}; the template cannot write ${best.mode} yet` },
    limit: { key: "sync.mode", wanted: best.mode, got: row.mode, why: `${refusal}. Nearest mode it can write: ${row.mode}. The ${best.mode} setup is by hand: ${best.why}.` },
  };
}

function pauseFor(shape, tokens) {
  if (shape.pauseModifiers !== false) for (const mod of PAUSE_MODIFIERS) if (hasAny(tokens, mod.terms)) return { value: mod.value, why: mod.why };
  return shape.pause;
}

function hostingRows(engineId) {
  const engine = engineData(engineId);
  if (!engine) return [];
  if (!engine.canListen)
    return [
      ["hosting.direct", false, "a browser page cannot listen on a port, so direct hosting is off for a browser game"],
      ["hosting.server", true, "a browser game gets its join codes from a lobby server (point hosting.lobbyServer at yours); the lobby server is optional wherever the engine can listen"],
    ];
  return [
    ["hosting.direct", true, "the engine can listen, so players share a join code and one of them hosts: the game outlives any server"],
    ["hosting.server", false, "a lobby server is optional here; switch it on if you also want a public list"],
  ];
}

function adviceFor(shapeId, engineId) {
  const engine = engineData(engineId);
  return ADVICE.filter((a) => a.shapes.includes(shapeId)).map((a) => {
    let status;
    if (a.status.fixed) status = a.status.fixed;
    else if (!engine) status = "depends";
    else status = engine.features[a.status.feature] ? "built-in" : "by-hand";
    let how;
    if (status === "built-in") how = a.how.builtIn;
    else if (status === "by-hand") how = a.how.byHand;
    else {
      const yes = Object.keys(ENGINES).filter((id) => ENGINES[id].features[a.status.feature]);
      how = `built in for ${yes.join(", ")}; by hand elsewhere. ${a.how.byHand}`;
    }
    return { id: a.id, text: a.text, why: a.why, status, how, doc: a.doc };
  });
}

const flagOf = new Map(ANSWER_FLAGS.map((f) => [f.key, f]));

/** The create-onelobby flags that apply the rows (only flags that exist; keys without one go through --set). */
export function flagsForRows(rows) {
  const flags = [];
  const direct = rows.find((r) => r[0] === "hosting.direct");
  const server = rows.find((r) => r[0] === "hosting.server");
  if (direct && server) flags.push("--hosting", direct[1] && server[1] ? "both" : direct[1] ? "direct" : "server");
  for (const [key, value] of rows) {
    if (key === "hosting.direct" || key === "hosting.server") continue;
    const def = flagOf.get(key);
    if (def && (def.type === "int" || def.type === "enum")) flags.push(`--${def.flag}`, String(value));
    else flags.push("--set", `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  return flags;
}

const shell = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);

/**
 * The facts for one description. `engine`: { id, from } with from "template" (--template), "default" (the scaffolder's own default)
 * or omitted (then the sentence is read: from "text", or id null / from "none"). Throws bad_flag for an empty description.
 */
export function recommend({ description, engine } = {}) {
  if (typeof description !== "string" || description.trim() === "") throw new CliError("bad_flag", '--recommend: needs a one-line description of the game, e.g. --recommend "4 player party minigames in Godot"');
  const text = description.trim();
  const tokens = joinDenied(tokenize(text));

  let eng = engine?.id ? { id: engine.id, from: engine.from ?? "template", words: [] } : null;
  let assumedLanguage = false;
  if (!eng) {
    const d = detectEngine(text);
    if (d) {
      eng = { id: d.id, from: "text", words: d.words };
      assumedLanguage = !d.settled;
    } else eng = { id: null, from: "none", words: [] };
  }

  const scores = scoreShapes(tokens, eng.id);
  const best = pickShape(scores);
  const shape = best ? SHAPES.find((s) => s.id === best.id) : null;
  const engineInfo = {
    id: eng.id,
    from: eng.from,
    ...(eng.words.length ? { words: eng.words } : {}),
    label: eng.id ? ENGINES[eng.id].label : null,
    template: eng.id ? ENGINES[eng.id].template : null,
  };

  const rec = {
    ok: true,
    command: "recommend",
    description: text,
    shape: shape?.id ?? null,
    shapeName: shape?.name ?? null,
    matched: best ? best.matched.map((m) => slice(text, tokens, m)) : [],
    engine: engineInfo,
    answers: [],
    advice: [],
    limits: [],
    notes: [],
    questions: [],
    flags: [],
    runCommand: null,
    shapes: SHAPES.map((s) => ({ id: s.id, name: s.name, summary: s.summary })),
  };
  if (!shape) rec.candidates = scores.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => ({ shape: s.id, score: s.score, matched: s.matched.map((m) => slice(text, tokens, m)) }));
  for (const s of scores) if (s.id === rec.shape || (!shape && s.score > 0) || s.banned) rec.notes.push(...s.notes.filter((n) => !rec.notes.includes(n)));

  const ask = (id) => rec.questions.push({ id, question: QUESTIONS[id].question, add: QUESTIONS[id].add });
  if (!eng.id) ask("engine");
  if (assumedLanguage) ask("godotLanguage");

  if (!shape) {
    ask("shape");
    if (!readPlayers(text)) ask("players");
    finish(rec, eng);
    return rec;
  }

  // ---- the answers, in schema order ----
  const rows = rec.answers;
  const mode = chooseMode(shape, eng.id);
  rows.push(["sync.mode", mode.row.mode, mode.row.why]);
  if (mode.limit) rec.limits.push(mode.limit);
  if (shape.tickRate) {
    const given = readTickRate(text);
    rows.push(["sync.tickRate", given ?? shape.tickRate.value, given && shape.tickRate.fromText ? shape.tickRate.fromText : shape.tickRate.why]);
    if (shape.id === "lockstep" && !given) ask("tickRate");
  }
  if (shape.hashEveryTicks && mode.row.mode === "lockstep") rows.push(["sync.hashEveryTicks", shape.hashEveryTicks.value, shape.hashEveryTicks.why]);

  const read = readPlayers(text);
  const fixed = shape.players.fixedByTerms?.find((f) => hasAny(tokens, f.terms));
  const party = shape.players.partyTerms && hasAny(tokens, shape.players.partyTerms);
  if (read) rows.push(["lobby.maxPlayers", read.max, `your description says "${read.text}"`]);
  else if (fixed) rows.push(["lobby.maxPlayers", fixed.value, fixed.why]);
  else if (party) rows.push(["lobby.maxPlayers", shape.players.partyValue, shape.players.partyWhy]);
  else {
    rows.push(["lobby.maxPlayers", shape.players.value, shape.players.why]);
    ask("players");
  }

  if (hasAny(tokens, SPECTATOR_TERMS)) {
    const m = /\b(\d+)\s*(?:spectators?|watchers?|observers?)\b/i.exec(text);
    const n = m ? Math.min(Number(m[1]), 64) : SPECTATOR_DEFAULT.value;
    rows.push(["room.spectators", n, m ? `your description says "${m[0]}"; spectators do not count against lobby.maxPlayers` : SPECTATOR_DEFAULT.why]);
  }
  const pause = pauseFor(shape, tokens);
  if (pause) rows.push(["session.pause", pause.value, pause.why]);
  rows.push(...hostingRows(eng.id));

  rec.advice = adviceFor(shape.id, eng.id);
  if (shape.id === "lockstep" && !has(tokens, DETERMINISM_WORD)) ask("determinism");
  if (shape.id === "coop-snapshots") ask("stateSize");
  if (!eng.id) rec.differences = differences(shape, rec.advice);
  finish(rec, eng);
  return rec;
}

/** Without an engine: what would differ per engine, from the engine table. */
function differences(shape, advice) {
  const out = [];
  const none = Object.keys(ENGINES).filter((id) => !ENGINES[id].canListen);
  out.push({ topic: "hosting", text: `${Object.keys(ENGINES).filter((id) => ENGINES[id].canListen).join(", ")} can listen, so direct hosting with join codes is the default there; ${none.join(", ")} cannot (a browser page), so it uses a lobby server (hosting.direct false, hosting.server true).` });
  const best = shape.modes[0].mode;
  const refused = Object.keys(ENGINES).filter((id) => !ENGINES[id].modes.includes(best));
  if (refused.length) out.push({ topic: "sync.mode", text: `the ${refused.join(", ")} template cannot write ${best} today; the nearest mode it can write is ${(shape.modes.find((m) => ENGINES[refused[0]].modes.includes(m.mode)) ?? shape.modes.at(-1)).mode}.` });
  for (const a of advice.filter((x) => x.status === "depends")) out.push({ topic: a.id, text: `${a.text}: ${a.how.split(". ")[0]}.` });
  return out;
}

function finish(rec, eng) {
  rec.flags = flagsForRows(rec.answers);
  const built = eng.id && ENGINES[eng.id].template === "built";
  if (eng.id && !built) {
    rec.runCommand = null;
    rec.notes.push(`the ${eng.id} template is planned: create-onelobby stops with template_planned for it today, so there is no command to run yet. Follow ${ENGINES[eng.id].recipe} and put these answers in onelobby.json (the flags list says which).`);
  } else if (!eng.id && rec.shape) {
    // without an engine the scaffolder would build its default (web), which refuses some of these answers: name the engine first
    rec.runCommand = null;
    rec.notes.push("no engine is known, so there is no command to run yet: add the engine to the description (see the first question), or pass --template <engine>; the flags list says which flags apply the answers.");
  } else rec.runCommand = ["npx", "create-onelobby", "my-game", ...(built ? ["--template", eng.id] : []), ...rec.flags, "--yes"].map(shell).join(" ");
}

/** The rows a scaffold run uses as answers: [[key, value, why]]. */
export const recommendedRows = (rec) => rec.answers;

// ---- text for a person -------------------------------------------------------------------------------------------------

const show = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const wrap = (text, indent, width = 110) => {
  const lines = [];
  let line = "";
  for (const w of text.split(" ")) {
    if (line && indent.length + line.length + 1 + w.length > width) {
      lines.push(indent + line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(indent + line);
  return lines.join("\n");
};

/** The proposal table as text: key, value, why. */
export function table(rows) {
  const kw = Math.max(...rows.map((r) => r[0].length));
  const vw = Math.max(...rows.map((r) => show(r[1]).length));
  return rows.map(([k, v, why]) => `  ${k.padEnd(kw)}  ${show(v).padEnd(vw)}  ${why}`).join("\n");
}

export function renderText(rec) {
  const out = [`create-onelobby --recommend: ${JSON.stringify(rec.description)}`, ""];
  const e = rec.engine;
  if (rec.shape) {
    out.push(`Game shape: ${rec.shape} (${rec.shapeName})`, `  matched: ${rec.matched.map((m) => JSON.stringify(m)).join(", ")}`);
  } else {
    out.push("Game shape: unknown. The description does not clearly match one shape, so nothing is proposed beyond the scaffolder's normal defaults.");
    if (rec.candidates?.length) out.push(`  weak hints: ${rec.candidates.map((c) => `${c.shape} (${c.matched.map((m) => JSON.stringify(m)).join(", ")})`).join("; ")}`);
  }
  out.push(
    e.id
      ? `Engine: ${e.id} (${e.label}), from ${e.from === "template" ? "--template" : e.from === "text" ? `the description${e.words?.length ? ` ("${e.words.join(" ")}")` : ""}` : "the scaffolder's default"}${e.template === "planned" ? "; its template is planned, not built yet" : ""}`
      : "Engine: unknown (not given by --template or the description)",
    "",
  );
  if (!rec.shape) {
    out.push("The five shapes (add words from one to the description):");
    for (const s of rec.shapes) out.push(`  ${s.id.padEnd(15)} ${s.name}: ${s.summary}`);
    out.push("");
  } else {
    out.push("Proposal (blueprint key, proposed value, why):", table(rec.answers), "");
    for (const l of rec.limits) out.push(`Template limit: ${l.key} would be ${l.wanted}; ${l.why}`, "");
    if (rec.advice.length) {
      out.push("Advice that is not a blueprint key yet:");
      for (const a of rec.advice) out.push(`  [${a.status}] ${a.text}`, wrap(`why: ${a.why}.`, "      "), wrap(`how: ${a.how}${a.how.includes(a.doc) ? "" : ` (${a.doc})`}`, "      "));
      out.push("");
    }
  }
  if (rec.differences?.length) {
    out.push("What would differ per engine:");
    for (const d of rec.differences) out.push(wrap(`- ${d.text}`, "  "));
    out.push("");
  }
  for (const n of rec.notes) out.push(wrap(`Note: ${n}`, ""), "");
  if (rec.questions.length) {
    out.push("Open questions (add the words to the description and run again):");
    for (const q of rec.questions) out.push(wrap(`- ${q.question}`, "  "), `    add: "${q.add}"`);
    out.push("");
  }
  if (rec.runCommand) out.push("Run it:", `  ${rec.runCommand}`);
  else if (rec.flags.length) out.push(`Flags for these answers: ${rec.flags.join(" ")}`);
  return out.join("\n") + "\n";
}

/** The part of a scaffold run's text that names the keys that came from the recommendation. */
export function renderApplied(applied, overridden, shape, dropped = []) {
  const out = [`From the recommendation (${shape ?? "no shape matched"}):`];
  if (applied.length) out.push(table(applied));
  else out.push("  nothing: every key it proposes was already set by a flag or --from.");
  for (const o of overridden) out.push(`  kept ${o.key} = ${show(o.value)} from ${o.by} (the recommendation said ${show(o.recommended)})`);
  for (const d of dropped) out.push(`  left out ${d.key} = ${show(d.recommended)}: ${d.why}`);
  return out.join("\n");
}
