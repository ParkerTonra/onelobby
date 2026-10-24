/**
 * Stand-in for `src/friendly.ts` (the "api" lane) with the same signatures. Integration: delete this file and import
 * from "../friendly.js" in controller.ts / element.ts.
 */
import { normalizeCode } from "../crockford.js";

export interface FriendlyError {
  code: string;
  message: string;
  hint?: string;
}

const TEXT: Record<string, [string, string?]> = {
  connect_failed: ["Couldn't reach the lobby server.", "Check your internet connection, or ask whoever set up the game if the server is running."],
  closed: ["Lost the connection to the lobby server.", "Check your internet connection and try again."],
  bad_code: ["That code doesn't look right.", "Codes are 6 letters and numbers, like K7M2QX."],
  unknown_code: ["No game with that code.", "Check the code, or ask the host to send it again. Games end when the host leaves."],
  lobby_full: ["That game is full.", "Ask the host to start a bigger game."],
  in_game: ["That game has already started.", "Ask the host to start a new one."],
  version_mismatch: ["You and the host have different versions of the game.", "Both of you reload the page and try again."],
  game_not_allowed: ["This lobby server doesn't host this game.", "The server address or the game name is wrong."],
  server_full: ["The lobby server is busy.", "Wait a minute and try again."],
  rate_limited: ["Too many tries in a row.", "Wait a few seconds and try again."],
  join_timeout: ["Couldn't connect to the host.", "Some networks block direct connections. Try again, or try another network."],
  kicked: ["The host removed you from the game."],
  server_lost: ["Lost the connection to the lobby server.", "Try again in a moment."],
};

export function describeError(err: unknown): FriendlyError {
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "unknown";
  const t = TEXT[code];
  if (t) return { code, message: t[0], ...(t[1] ? { hint: t[1] } : {}) };
  return { code, message: "Something went wrong.", hint: "Try again. If it keeps happening, reload the page." };
}

export function shareUrl(code: string, base?: string, param = "join"): string {
  const u = new URL(base ?? (typeof location !== "undefined" ? location.href : "http://localhost/"));
  u.searchParams.set(param, code);
  u.hash = "";
  return u.toString();
}

export function codeFromUrl(url?: string, param = "join"): string | null {
  const href = url ?? (typeof location !== "undefined" ? location.href : "");
  if (!href) return null;
  try {
    const v = new URL(href).searchParams.get(param);
    return v ? normalizeCode(v) : null;
  } catch {
    return null;
  }
}
