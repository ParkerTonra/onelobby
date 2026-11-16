/**
 * What the Join box holds, as a pure function: a lobby code, a direct join code, an `ip:port` address, an invite link, or a
 * pasted invite sentence ("Join my game in Fortress: code 7HQ 4K2"). A port of `MenuModel.ParseJoin` (C#) and the Godot menu
 * model, so the three clients read the same text the same way.
 */
import { formatCode, normalizeCode } from "../crockford.js";
import { codeFromUrl } from "../friendly.js";
import { normalizeJoinCode } from "../joincode.js";

export type MenuJoinKind = "none" | "lobby" | "direct" | "address";

/** For a lobby code the canonical 6 characters; otherwise the text as typed. */
export interface MenuJoinParse {
  kind: MenuJoinKind;
  value: string;
}

/**
 * Keeps what is typed in the Join box tidy: a code is upper-cased and stripped of stray characters; an address or a link is
 * kept as typed.
 */
export function cleanJoinText(text: string): string {
  const t = text.replace(/^[ \t\r\n]+/, "");
  for (const ch of [":", "/", ".", "?", "#", "=", "@"]) if (t.includes(ch)) return t;
  let out = "";
  for (const ch of t.toUpperCase()) if (ch === " " || ch === "-" || (ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z")) out += ch;
  return out.length > 40 ? out.slice(0, 40) : out;
}

/** An IPv4 address with an optional port (`192.168.1.20:47810`). */
function isAddress(input: string): boolean {
  let s = input.trim();
  let port = 47810;
  if (s.includes(":")) {
    const halves = s.split(":");
    if (halves.length !== 2 || !/^\d+$/.test(halves[1])) return false;
    port = Number(halves[1]);
    s = halves[0];
  }
  if (port < 1 || port > 65535) return false;
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d+$/.test(p) && Number(p) <= 255);
}

const EDGE = "\"'`()[]{}<>.,;:!“”‘’";

/** Strips quotes, brackets and trailing punctuation around a word of a pasted sentence (a link keeps its inner marks). */
function trimToken(w: string): string {
  let a = 0;
  let b = w.length;
  while (a < b && EDGE.includes(w[a])) a++;
  while (b > a && EDGE.includes(w[b - 1])) b--;
  return w.slice(a, b);
}

/** Two words shaped like the lobby screen's grouping ("7HQ" "4K2"): three characters each, so ordinary words are not taken. */
const isGroupPair = (a: string, b: string) => a.length === 3 && b.length === 3;

function parseOne(t: string): MenuJoinParse {
  if (t.includes("?") || t.includes("://") || t.includes("#")) {
    const fromLink = codeFromUrl(t);
    if (fromLink) return { kind: "lobby", value: fromLink };
  }
  const six = normalizeCode(t);
  if (six) return { kind: "lobby", value: six };
  if (normalizeJoinCode(t) !== null) return { kind: "direct", value: t };
  if (isAddress(t)) return { kind: "address", value: t };
  return { kind: "none", value: t };
}

function afterMarker(words: string[], at: number): MenuJoinParse {
  const one = parseOne(words[at]);
  if (one.kind !== "none") return one;
  if (at + 1 < words.length && isGroupPair(words[at], words[at + 1])) {
    const two = parseOne(words[at] + " " + words[at + 1]);
    if (two.kind === "lobby") return two;
  }
  return { kind: "none", value: "" };
}

/**
 * What a join field holds. A link yields its lobby code. A pasted invite sentence yields its code: the words after its
 * "code" marker first, then the whole text as one code, then the words scanned from the END (a game title can look like a
 * code, so the title is never tried first). A bare code, an `ip:port`, a direct code and a link work as ever.
 */
export function parseJoin(text: string | null | undefined): MenuJoinParse {
  const t = (text ?? "").trim();
  if (t.length === 0) return { kind: "none", value: "" };
  const words: string[] = [];
  for (const w of t.split(/\s+/)) {
    const c = trimToken(w);
    if (c.length > 0) words.push(c);
  }
  if (words.length > 1) {
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i].toLowerCase() !== "code") continue;
      const got = afterMarker(words, i + 1);
      if (got.kind !== "none") return got;
      break;
    }
  }
  const whole = parseOne(t);
  if (whole.kind !== "none" || words.length < 2) return whole;
  for (let i = words.length - 1; i >= 0; i--) {
    if (i >= 1 && isGroupPair(words[i - 1], words[i])) {
      const pair = parseOne(words[i - 1] + " " + words[i]);
      if (pair.kind === "lobby") return pair;
    }
    const one = parseOne(words[i]);
    if (one.kind !== "none") return one;
  }
  return whole;
}

/** The lobby screen's grouped form of a code ("7HQ 4K2"); anything else as it is. */
export const displayCode = (code: string): string => formatCode(code);
