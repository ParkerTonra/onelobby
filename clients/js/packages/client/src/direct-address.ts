/**
 * A direct-IP host address as a player types it (docs/design/direct-ip.md s.3): `ip`, `ip:port`, `[v6]:port`, a bare IPv6
 * address or a host name (a virtual-LAN name, say). Same rules as OneLobby.Direct's `DirectAddress` in C#.
 */
export interface DirectAddress {
  host: string;
  port: number;
  isIPv6: boolean;
  /** `host:port`, with brackets for IPv6. */
  display: string;
  /** The joiner's signaling URL: `ws://host:port/`. */
  url: string;
  /**
   * The address as a remote ICE host candidate (UDP, same port number as the TCP listener). Without it a joiner on the
   * internet only learns the host's private LAN addresses (docs/design/direct-ip.md s.2).
   */
  candidate: string;
}

export const DEFAULT_DIRECT_PORT = 47810;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function isIPv4(s: string): boolean {
  const m = IPV4.exec(s);
  return !!m && m.slice(1).every((x) => Number(x) <= 255);
}

function isIPv6(s: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(s) || s.split("::").length > 2 || !s.includes(":")) return false;
  const tail = s.split(":").pop() ?? "";
  const groups = s.split(":").filter((g, i, a) => g !== "" || (i > 0 && i < a.length - 1));
  if (tail.includes(".") && !isIPv4(tail)) return false;
  return groups.every((g) => g === "" || g.includes(".") || /^[0-9A-Fa-f]{1,4}$/.test(g));
}

export function parseDirectAddress(input: string, defaultPort = DEFAULT_DIRECT_PORT): DirectAddress | null {
  let s = input.trim();
  if (/^ws:\/\//i.test(s)) s = s.slice(5);
  s = s.replace(/\/+$/, "");
  if (!s) return null;
  let host: string;
  let portText: string | null = null;
  if (s[0] === "[") {
    const close = s.indexOf("]");
    if (close < 0) return null;
    host = s.slice(1, close);
    const rest = s.slice(close + 1);
    if (rest) {
      if (rest[0] !== ":") return null;
      portText = rest.slice(1);
    }
  } else {
    const first = s.indexOf(":");
    if (first >= 0 && first === s.lastIndexOf(":")) {
      host = s.slice(0, first);
      portText = s.slice(first + 1);
    } else host = s; // no colon, or several (a bare IPv6 address)
  }
  let port = defaultPort;
  if (portText !== null) {
    if (!/^\d{1,5}$/.test(portText)) return null;
    port = Number(portText);
    if (port < 1 || port > 65535) return null;
  }
  const v6 = isIPv6(host);
  if (!v6 && !isIPv4(host) && !HOSTNAME.test(host)) return null;
  const display = (v6 ? `[${host}]` : host) + `:${port}`;
  return { host, port, isIPv6: v6, display, url: `ws://${display}/`, candidate: `candidate:1 1 UDP 2122317823 ${host} ${port} typ host` };
}
