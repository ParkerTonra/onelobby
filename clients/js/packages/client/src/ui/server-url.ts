/**
 * The `server="..."` attribute of `<one-lobby>` as a WebSocket URL, or null when it is missing, still the placeholder
 * from the guide, or not an address at all. Null makes the element say "This page is missing its lobby server
 * address" instead of the less helpful "Couldn't reach the game server".
 *
 * Accepts what people paste: `https://name.onrender.com` (the address Render shows), `wss://host/ws`, or a bare host.
 * http(s) becomes ws(s); the server answers on `/` and `/ws`, so no path is needed.
 */
export function lobbyServerUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s || /\s/.test(s)) return null;
  // the guide's and example's placeholders: YOUR-LOBBY-SERVER, YOUR-SERVER, REPLACE-ME ...
  if (/your[-_ ]?(lobby[-_ ]?)?server|replace[-_ ]?me|<|>/i.test(s)) return null;
  let url = s;
  if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, "ws");
  else if (!/^wss?:\/\//i.test(url)) url = "wss://" + url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!host) return null;
  // documentation-only names (RFC 2606): example.com/.net/.org and *.example never reach a real server
  if (/(^|\.)example\.(com|net|org)$/.test(host) || /\.example$/.test(host) || host === "example") return null;
  // a single word that is not localhost is a typo, not a server (e.g. server="lobby")
  if (!host.includes(".") && !host.includes(":") && host !== "localhost") return null;
  return url;
}
