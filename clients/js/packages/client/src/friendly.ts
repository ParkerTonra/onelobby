/**
 * Player-facing helpers: plain-language error text and shareable join links.
 * Nothing here talks to the network; it is safe to call from any UI code.
 */
import { formatCode, normalizeCode } from "./crockford.js";

export interface FriendlyError {
  /** Stable machine code (the KeepaliveError code, or "unknown"). */
  code: string;
  /** One short sentence a player can read. */
  message: string;
  /** What the player can do about it, when there is something. */
  hint?: string;
}

type Entry = { message: string; hint?: string };

const TEXT: Record<string, Entry> = {
  // server errors (spec/signaling.md)
  unknown_code: { message: "We couldn't find a lobby with that code.", hint: "Check the code with the host. Codes stop working once everyone leaves." },
  bad_code: { message: "That doesn't look like a lobby code.", hint: "Codes are 6 letters and numbers, like 7HQ 4K2." },
  lobby_full: { message: "That lobby is full.", hint: "Ask the host to make room, or start your own lobby." },
  version_mismatch: { message: "You and the host are running different versions of the game.", hint: "Reload the page (or update the game) on both sides, then try again." },
  in_game: { message: "That game has already started.", hint: "Ask the host to let people join mid-game, or wait for the next round." },
  kicked: { message: "The host removed you from the lobby." },
  denied: { message: "The host didn't let you in this time.", hint: "Ask the host to approve you, then try again." },
  not_host: { message: "Only the host can do that." },
  rate_limited: { message: "Slow down a little: too many tries in a short time.", hint: "Wait a moment, then try again." },
  max_lobbies: { message: "You already have the most lobbies open that this server allows.", hint: "Close one of your other lobbies, then try again." },
  server_full: { message: "The game server is full right now.", hint: "Try again in a few minutes." },
  game_not_allowed: { message: "This game server doesn't host this game.", hint: "The game's server setting may be wrong; let the game's owner know." },
  bad_request: { message: "The game sent something the server didn't understand.", hint: "Reload the page and try again. If it keeps happening, the game may need an update." },
  // client errors
  connect_failed: { message: "Couldn't reach the game server.", hint: "Check your internet connection, then try again." },
  closed: { message: "Lost the connection to the game server.", hint: "Check your internet connection, then try again." },
  server_lost: { message: "Lost the connection to the game server.", hint: "Your game may keep going; new players can't join until it's back." },
  invalid_token: { message: "Your old seat in that lobby is no longer available.", hint: "Join again with the lobby code." },
  ice_failed: { message: "Couldn't connect to the other players.", hint: "Some networks (school, work, public Wi-Fi) block game connections. Try another network or a phone hotspot." },
  timeout: { message: "The connection took too long.", hint: "Check your internet connection, then try again." },
  left: { message: "You left the lobby." },
  unknown: { message: "Something went wrong.", hint: "Try again. If it keeps happening, reload the page." },
};

const CODE_RE = /^[a-z][a-z0-9_]*$/;

function codeOf(err: unknown): { code: string | null; data?: Record<string, unknown> } {
  if (typeof err === "string") {
    const m = /^([a-z][a-z0-9_]*)(?::|$)/.exec(err.trim());
    return { code: m ? m[1] : null };
  }
  if (err && typeof err === "object") {
    const o = err as { code?: unknown; data?: unknown; message?: unknown; name?: unknown };
    const data = o.data && typeof o.data === "object" ? (o.data as Record<string, unknown>) : undefined;
    if (typeof o.code === "string" && CODE_RE.test(o.code)) return { code: o.code, data };
    if (typeof o.message === "string") {
      const m = /^([a-z][a-z0-9_]*):/.exec(o.message);
      if (m && TEXT[m[1]]) return { code: m[1], data };
      // browser network failures (fetch/WebSocket) surface as TypeError / NetworkError
      if (o.name === "NetworkError" || /network|failed to fetch|websocket/i.test(o.message)) return { code: "connect_failed" };
      if (o.name === "TimeoutError" || /timed? ?out/i.test(o.message)) return { code: "timeout" };
    }
  }
  return { code: null };
}

/**
 * Plain-language, player-facing text for any error the kit (or its server) can produce.
 * Never returns a stack trace or raw technical message; unknown errors get a generic friendly line.
 */
export function describeError(err: unknown): FriendlyError {
  const { code, data } = codeOf(err);
  if (!code) return { code: "unknown", ...TEXT.unknown };
  let key = code;
  if (code === "kicked" && data?.reason === "denied") key = "denied";
  if (code === "rate_limited" && data?.reason === "max_lobbies") key = "max_lobbies";
  const e = TEXT[key];
  if (!e) return { code, ...TEXT.unknown };
  const out: FriendlyError = { code, message: e.message };
  if (e.hint) out.hint = e.hint;
  if (code === "rate_limited" && typeof data?.retryAfterMs === "number" && key === "rate_limited") {
    const s = Math.max(1, Math.ceil(data.retryAfterMs / 1000));
    out.hint = `Wait ${s} second${s === 1 ? "" : "s"}, then try again.`;
  }
  return out;
}

function currentHref(): string | undefined {
  try {
    return typeof location !== "undefined" ? location.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A link that opens the game straight into lobby `code`, e.g. `https://game.example/?join=7HQ-4K2`.
 * `base` defaults to the current page; any existing `param` is replaced. Throws on an invalid code.
 */
export function shareUrl(code: string, base?: string, param = "join"): string {
  const norm = normalizeCode(code);
  if (!norm) throw new Error(`"${code}" is not a valid lobby code`);
  const b = base ?? currentHref();
  if (!b) throw new Error("shareUrl needs a base URL outside the browser");
  const u = new URL(b);
  u.searchParams.delete(param);
  // URLSearchParams would encode the display space as "+": use a hyphen, which normalizeCode also accepts
  u.searchParams.set(param, formatCode(norm).replace(" ", "-"));
  return u.toString();
}

/** The lobby code carried by a share link (see shareUrl), or null when there is none or it is not a valid code. */
export function codeFromUrl(url?: string, param = "join"): string | null {
  const href = url ?? currentHref();
  if (!href) return null;
  let u: URL;
  try {
    u = new URL(href, "http://localhost/");
  } catch {
    return null;
  }
  const v = u.searchParams.get(param) ?? new URLSearchParams(u.hash.replace(/^#/, "")).get(param);
  return v ? normalizeCode(v) : null;
}
