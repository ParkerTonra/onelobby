/// <reference types="node" />
/**
 * `onelobby/direct` (Node only): host a direct-IP lobby from a Node process, with no server of anyone's
 * (docs/direct-ip.md). The process runs the signaling hub, listens on TCP `port`, binds its peer links to UDP `port`,
 * asks the router to forward both (UPnP, then NAT-PMP) and hands out a join code. Joiners use `kit.joinDirect(code)`
 * from `onelobby` (Node or browser) or `JoinDirectAsync` in C#; the wire protocol is the same, so they mix.
 *
 * WebRTC in Node needs an RTCPeerConnection: `npm install node-datachannel`, then
 * `advanced: { linkFactory: webRtcLinkFactoryFor(RTCPeerConnection) }` with
 * `import { RTCPeerConnection } from "node-datachannel/polyfill"`. Its libdatachannel honours the port pin.
 */
import type { HostOptions, OneLobby } from "../onelobby.js";
import type { Lobby, RateLimit } from "../lobby.js";
import type { LinkFactory } from "../transport.js";
import { encodeJoinCode } from "../joincode.js";
import { DEFAULT_DIRECT_PORT } from "../direct-address.js";
import { DirectHubHost, PortInUseError, portFailureHint, type HttpHandler } from "./hub-host.js";
import { directHubOptions } from "./hub.js";
import { isPublicIPv4, lanIPv4, localAddresses, type PortMapper, type PortMapResult, type PortMapperOptions } from "./portmap.js";
import { OneLobbyError } from "../signaling.js";

export { DirectHubHost, LocalHubSocket, PortInUseError, originAllowed } from "./hub-host.js";
export type { HttpHandler, HttpReply, DirectJoinInfo } from "./hub-host.js";
export { SignalingHub, Session, RateWindow, sanitize, defaultHubOptions, directHubOptions, PROTO } from "./hub.js";
export type { HubOptions, HubDeps } from "./hub.js";
export { PortMapper, isPublicIPv4, lanIPv4, localAddresses } from "./portmap.js";
export type { PortMapResult, PortMapperOptions, PortMapMethod } from "./portmap.js";
export { webRtcLinkFactoryFor } from "../webrtc.js";

export interface DirectHostOptions {
  /**
   * TCP and UDP port to listen on (default 47810). When it is busy (another program holds it) the next free one of the
   * following `fallbackPorts` is used; the join code carries the port, so friends never type it.
   */
  port?: number;
  /** How many ports after `port` to try when it is busy; default 9 with `port` left out, else 0. */
  fallbackPorts?: number;
  /** Optional; joiners must send the same one or get `bad_password`. */
  password?: string;
  maxPlayers?: number;
  /** Lobby name; default "<displayName>'s game". */
  name?: string;
  lateJoin?: boolean;
  meta?: Record<string, string>;
  /** Ask the router to forward the port so the code works from the internet (s.2a). The host-menu toggle; default on. */
  openPort?: boolean;
  /**
   * This machine's public IPv4 address when the player forwarded the port by hand (no UPnP): the join code and
   * `joinUrl` carry it and `joinCodeKind` is "internet". Default: the `ONELOBBY_PUBLIC_IP` environment variable. With it
   * set the router is not asked unless `openPort: true` is passed.
   */
  publicAddress?: string;
  /** Test seam and knobs for the router request (description defaults to "OneLobby <gameId>"). */
  portMapping?: PortMapperOptions;
  /**
   * Serves plain-HTTP `GET`s on the same port, typically a join page for browsers (recipe s.4b). The page joins with
   * `kit.joinDirect(location.host)`; the lobby's `joinUrl` is then the link to share.
   */
  http?: HttpHandler;
  /**
   * Browser `Origin` values allowed to open a signaling socket (exact match, e.g. "https://play.example"; "*" allows
   * every origin). Native clients send no Origin and are always allowed, as are pages served from the host's own address
   * (`http`) and localhost pages, so this is only for a web game hosted somewhere else that joins players to this host.
   */
  allowedOrigins?: string[];
  /** Per-joiner cap on incoming raw messages, e.g. `{ messages: 60, perMs: 1000 }`; the excess is dropped. */
  rateLimit?: RateLimit;
  /** Receives the startup line (`lobby.directHostLog`) once the host is up. Default `console.log`; `false` prints nothing. */
  log?: ((line: string) => void) | false;
}

/**
 * The one startup line for a direct host, character for character as C#'s `DirectLobby.FormatHostLog`, e.g.
 * `OneLobby: direct host listening on TCP+UDP :47811 (47810 busy); code 0A00-0BSE-P3S (SameNetwork); port mapping off`.
 */
export function formatHostLog(requested: number, bound: number, code: string, kind: "internet" | "same_network" | "none", mapping: string): string {
  let line = `OneLobby: direct host listening on TCP+UDP :${bound}`;
  if (bound !== requested) line += ` (${bound - requested === 1 ? requested : `${requested}-${bound - 1}`} busy)`;
  const kindName = kind === "internet" ? "Internet" : kind === "same_network" ? "SameNetwork" : "None";
  line += code ? `; code ${code} (${kindName}); port mapping ` : "; no join code (no IPv4 address); port mapping ";
  return line + (mapping || "off");
}

/** A direct host lobby: the normal Lobby, plus the hub behind it. Leaving or ending the lobby stops the hub. */
export type DirectLobby = Lobby & {
  directHub: DirectHubHost;
  /** With the `http` option: `http://<the code's address>:<port>/`, the link a browser opens to join. Else null. */
  joinUrl: string | null;
};

/**
 * Hosts a direct-IP lobby (docs/direct-ip.md s.3): starts the hub and listener on `port`, opens the router port
 * (unless `openPort: false`), connects `kit` to the hub in memory and creates the lobby. Resolves with the lobby;
 * show `lobby.joinCode` with `lobby.joinCodeKind` ("internet" or "same_network"). Rejects with `port_in_use`.
 * When the lobby ends (leave, or the process exits) the listener closes and the router mapping is removed; joiners
 * get `sessionEnded("host_left")`.
 */
/** With `port` left out, how many ports after the default `hostDirect` tries when it is busy. */
export const DEFAULT_FALLBACK_PORTS = 9;

export async function hostDirect(kit: OneLobby, opts: DirectHostOptions = {}): Promise<DirectLobby> {
  const bp = kit.blueprint;
  const defined = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as DirectHostOptions;
  // a blueprint supplies hosting.* and lobby.* (explicit options win)
  const o: DirectHostOptions = bp
    ? {
        port: bp.hosting.directPort,
        openPort: bp.hosting.openPort,
        allowedOrigins: [...bp.hosting.allowedOrigins],
        maxPlayers: bp.lobby.maxPlayers,
        lateJoin: bp.lobby.lateJoin,
        meta: { ...bp.lobby.meta },
        ...(bp.session.rateLimit ? { rateLimit: { ...bp.session.rateLimit } } : {}),
        ...defined,
      }
    : defined;
  const port = o.port ?? DEFAULT_DIRECT_PORT;
  // busy (another program holds it): try the next fallbackPorts; the join code carries the port
  const last = port + Math.max(0, o.fallbackPorts ?? (o.port === undefined ? DEFAULT_FALLBACK_PORTS : 0));
  const maxPlayers = o.maxPlayers ?? 4;
  let hub: DirectHubHost | undefined;
  let anyBusy = false;
  let anyReserved = false;
  for (let p = port; !hub; p++) {
    try {
      hub = await DirectHubHost.listen(p, directHubOptions(maxPlayers, o.password));
    } catch (e) {
      if (!(e instanceof PortInUseError)) throw e;
      if (e.reserved) anyReserved = true;
      else anyBusy = true;
      if (p < last) continue;
      const range = last > port ? `ports ${port}-${last}` : `port ${port}`;
      throw new OneLobbyError("port_in_use", `cannot listen on ${range}: ${portFailureHint(anyBusy, anyReserved)}`);
    }
  }
  hub.http = o.http ?? null;
  hub.allowedOrigins = o.allowedOrigins ?? [];
  const manual = (o.publicAddress ?? process.env.ONELOBBY_PUBLIC_IP ?? "").trim() || null;
  if (manual && !isIPv4(manual)) {
    await hub.close();
    throw new OneLobbyError("bad_address", `publicAddress must be an IPv4 address like 203.0.113.7, got "${manual}"`);
  }
  // The router request runs alongside lobby creation; it takes up to a few seconds when nothing answers.
  const mapping: Promise<PortMapResult | null> =
    o.openPort === false || (manual && opts.openPort !== true)
      ? Promise.resolve(null)
      : hub.openPort({ description: `OneLobby ${kit.options.gameId}`, ...o.portMapping }).catch((e: Error) => ({
          mapped: false, method: "none" as const, externalIPv4: null, localIPv4: null, detail: e.message,
        }));
  const wrapLinks = (inner: LinkFactory): LinkFactory => ({
    create: (lo) => inner.create({ ...lo, iceServers: [], portRange: { begin: hub.port, end: hub.port } }),
  });
  let lobby: Lobby;
  try {
    const name = o.name ?? `${kit.options.displayName || "Player"}'s game`;
    const h: HostOptions = { name, maxPlayers, lateJoin: o.lateJoin ?? true, meta: o.meta, rateLimit: o.rateLimit };
    lobby = await kit.hostDirectWith(h, { socketFactory: () => hub.connectLocal(), wrapLinks });
  } catch (e) {
    await mapping;
    await hub.close();
    throw e;
  }
  lobby.on("sessionEnded", () => void hub.close());
  // leave() resolves once the router mapping is deleted, so a host that exits right after it does not leave the port
  // forwarded until the lease runs out (2 h, or never on routers that only grant permanent leases)
  const leave = lobby.leave.bind(lobby);
  lobby.leave = async () => {
    try {
      await leave();
    } finally {
      await hub.close();
    }
  };
  const map = await mapping;
  const direct = Object.assign(lobby, { directHub: hub, joinUrl: null as string | null });
  direct.directAddresses = localAddresses(hub.port);
  const log = o.log === false ? null : (o.log ?? console.log);
  // Sets joinCode / joinCodeKind / joinUrl / portMapping / directHostLog and what GET /joininfo answers.
  const applyCode = (ip: string | null, kind: "internet" | "same_network", mappingNote: string) => {
    direct.portMapping = mappingNote;
    direct.joinCode = ip ? encodeJoinCode(ip, hub.port) : "";
    direct.joinCodeKind = ip ? kind : "none";
    direct.joinUrl = o.http && ip ? `http://${ip}:${hub.port}/` : null;
    direct.directHostLog = formatHostLog(port, hub.port, direct.joinCode, direct.joinCodeKind, direct.portMapping);
    hub.joinInfo = { joinCode: direct.joinCode, joinCodeKind: direct.joinCodeKind, joinUrl: direct.joinUrl, port: hub.port };
    log?.(direct.directHostLog);
  };
  if (manual) applyCode(manual, "internet", map?.mapped ? map.detail : "manual");
  else if (map?.mapped && isPublicIPv4(map.externalIPv4)) applyCode(map.externalIPv4, "internet", map.detail);
  else {
    applyCode(map?.localIPv4 ?? (await lanIPv4()), "same_network", map ? map.detail : "off");
    if (map && !map.mapped && hub.portMapper) retryMapping(hub.portMapper, o.portMapping?.retryMs ?? 30000, (r) => {
      if (!isPublicIPv4(r.externalIPv4)) return;
      applyCode(r.externalIPv4, "internet", r.detail);
      direct.notifyJoinCodeChanged();
    });
  }
  return direct;
}

const MAX_RETRY_MS = 5 * 60_000;

/** Asks the router again after `firstMs`, doubling up to 5 minutes, until a mapping lands or the host quits. */
function retryMapping(mapper: PortMapper, firstMs: number, onMapped: (r: PortMapResult) => void): void {
  if (!(firstMs > 0)) return;
  let wait = firstMs;
  const round = () => {
    const t = setTimeout(async () => {
      if (mapper.closed) return;
      const r = await mapper.open();
      if (mapper.closed) return;
      if (r.mapped) onMapped(r);
      else {
        wait = Math.min(wait * 2, MAX_RETRY_MS);
        round();
      }
    }, wait);
    t.unref?.();
  };
  round();
}

function isIPv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  return !!m && m.slice(1).every((x) => Number(x) <= 255);
}
