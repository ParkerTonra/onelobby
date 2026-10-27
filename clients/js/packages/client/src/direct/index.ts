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
import { encodeJoinCode, encodeRoomCode } from "../joincode.js";
import { NostrHostBridge } from "../nostr/host.js";
import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_STUN } from "../nostr/relays.js";
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
export { NostrHostBridge } from "../nostr/host.js";

export interface DirectHostOptions {
  /**
   * TCP and UDP port to listen on (default 47810). When it is busy (another program holds it) the next free one of the
   * following `fallbackPorts` is used; the join code carries the port, so friends never type it.
   */
  port?: number;
  /** Test seam: listen on this one local address (e.g. "127.0.0.1") instead of every interface. Default: every interface. */
  bindHost?: string;
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
   * Nostr signaling (spec/nostr-signaling.md), default on: `lobby.joinCode` is a version 1 code that joiners reach through
   * public Nostr relays, so it works with no port forwarded; the IP code moves to `lobby.directCode`. `false`: IP codes
   * only (`joinCode === directCode`). An object picks the relays (default: the blueprint's `hosting.nostrRelays`, else the
   * library list) and the STUN servers (default Google's and Cloudflare's public ones).
   */
  nostr?: boolean | { relays?: string[]; stun?: string[] };
  /**
   * This machine's public IPv4 address when the player forwarded the port by hand (no UPnP): the join code and
   * `joinUrl` carry it and `joinCodeKind` is "internet". Default: the `ONELOBBY_PUBLIC_IP` environment variable (then `portMapping` reads "manual (ONELOBBY_PUBLIC_IP)"). With it
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
export function formatHostLog(
  requested: number,
  bound: number,
  code: string,
  kind: "nostr" | "internet" | "same_network" | "none",
  mapping: string,
  /** With Nostr on: the IP code and how many relays are connected ("4/5", or "" for none reachable). */
  nostr?: { directCode: string; directCodeKind: "internet" | "same_network" | "none"; relays: string },
): string {
  let line = `OneLobby: direct host listening on TCP+UDP :${bound}`;
  if (bound !== requested) line += ` (${bound - requested === 1 ? requested : `${requested}-${bound - 1}`} busy)`;
  const name = (k: string) => (k === "internet" ? "Internet" : k === "same_network" ? "SameNetwork" : k === "nostr" ? "Nostr" : "None");
  line += code ? `; code ${code} (${name(kind)})` : "; no join code (no IPv4 address)";
  if (nostr) line += nostr.directCode ? `; ip code ${nostr.directCode} (${name(nostr.directCodeKind)})` : "; no ip code (no IPv4 address)";
  line += `; port mapping ${mapping || "off"}`;
  if (nostr) line += nostr.relays ? `; nostr ${nostr.relays} relays` : "; nostr: no relay reachable";
  return line;
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
        nostr: bp.hosting.nostr ? { relays: [...bp.hosting.nostrRelays] } : false,
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
  const nostrOn = o.nostr !== false;
  const nostrCfg = typeof o.nostr === "object" ? o.nostr : {};
  const stunUrls = nostrOn ? (nostrCfg.stun ?? [...DEFAULT_NOSTR_STUN]) : [];
  let hub: DirectHubHost | undefined;
  let anyBusy = false;
  let anyReserved = false;
  for (let p = port; !hub; p++) {
    try {
      hub = await DirectHubHost.listen(p, { ...directHubOptions(maxPlayers, o.password), stunUrls }, o.bindHost ? { host: o.bindHost } : undefined);
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
    // Nostr joiners have no address to dial: the host needs STUN too (the UDP port pin stays)
    create: (lo) => inner.create({ ...lo, iceServers: nostrOn ? lo.iceServers : [], portRange: { begin: hub.port, end: hub.port } }),
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
  lobby.linkAddressSink = (peerId, ip) => hub.hub.reportLinkAddress(peerId, ip);
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
  // Nostr: the room code is ready at once; relays connect while the router answers
  let relaysNote = "";
  let nostrUp = false;
  let nostrCode = "";
  let onRelays: (() => void) | null = null;
  if (nostrOn) {
    const env = kit.nostrHostEnv();
    nostrCode = encodeRoomCode();
    try {
      const bridge = await NostrHostBridge.start(hub.hub, {
        code: nostrCode,
        relays: nostrCfg.relays && nostrCfg.relays.length > 0 ? nostrCfg.relays : [...DEFAULT_NOSTR_RELAYS],
        connect: env.connect,
        clock: env.clock,
        wall: env.wall,
        onChange: () => onRelays?.(),
      });
      hub.nostr = bridge;
      lobby.on("sessionEnded", () => bridge.close());
      nostrUp = await settleRelays(bridge);
      relaysNote = nostrUp ? `${bridge.relaysConnected}/${bridge.relaysTotal}` : "";
    } catch {
      nostrCode = ""; // no WebSocket in this runtime, say: the host keeps hosting by IP
    }
  }
  const map = await mapping;
  const direct = Object.assign(lobby, { directHub: hub, joinUrl: null as string | null });
  direct.directAddresses = localAddresses(hub.port);
  const log = o.log === false ? null : (o.log ?? console.log);
  // Sets joinCode / joinCodeKind / directCode / joinUrl / portMapping / directHostLog and what GET /joininfo answers.
  let lastIp: [string | null, "internet" | "same_network", string] = [null, "same_network", "off"];
  const applyCode = (ip: string | null, kind: "internet" | "same_network", mappingNote: string) => {
    lastIp = [ip, kind, mappingNote];
    direct.portMapping = mappingNote;
    direct.directCode = ip ? encodeJoinCode(ip, hub.port) : "";
    direct.directCodeKind = ip ? kind : "none";
    if (nostrOn && nostrCode && nostrUp) {
      direct.joinCode = nostrCode;
      direct.joinCodeKind = "nostr";
    } else {
      // Nostr off, or no relay reachable (yet): the IP code is the code; it turns Nostr when a relay connects
      direct.joinCode = direct.directCode;
      direct.joinCodeKind = direct.directCodeKind;
    }
    direct.joinUrl = o.http && ip ? `http://${ip}:${hub.port}/` : null;
    direct.directHostLog = formatHostLog(port, hub.port, direct.joinCode, direct.joinCodeKind, direct.portMapping, nostrOn ? { directCode: direct.directCode, directCodeKind: direct.directCodeKind, relays: relaysNote } : undefined);
    hub.joinInfo = { joinCode: direct.joinCode, joinCodeKind: direct.joinCodeKind, directCode: direct.directCode, directCodeKind: direct.directCodeKind, joinUrl: direct.joinUrl, port: hub.port };
    log?.(direct.directHostLog);
  };
  if (manual) applyCode(manual, "internet", map?.mapped ? map.detail : o.publicAddress ? "manual" : "manual (ONELOBBY_PUBLIC_IP)");
  else if (map?.mapped && isPublicIPv4(map.externalIPv4)) applyCode(map.externalIPv4, "internet", map.detail);
  else {
    applyCode(map?.localIPv4 ?? (await lanIPv4()), "same_network", map ? map.detail : "off");
    if (map && !map.mapped && hub.portMapper) retryMapping(hub.portMapper, o.portMapping?.retryMs ?? 30000, (r) => {
      if (!isPublicIPv4(r.externalIPv4)) return;
      applyCode(r.externalIPv4, "internet", r.detail);
      direct.notifyJoinCodeChanged();
    });
  }
  // a relay answering after the 10 s wait: the Nostr code becomes the joinCode
  onRelays = () => {
    const b = hub.nostr;
    if (!b || b.relaysConnected === 0 || nostrUp) return;
    nostrUp = true;
    relaysNote = `${b.relaysConnected}/${b.relaysTotal}`;
    applyCode(...lastIp);
    direct.notifyJoinCodeChanged();
  };
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

/** Waits for the relays to connect: true once at least one has (then up to 1.5 s more for the rest), false after 10 s. */
async function settleRelays(bridge: NostrHostBridge): Promise<boolean> {
  if (!(await bridge.whenUp(10_000))) return false;
  for (let i = 0; i < 30 && bridge.relaysConnected < bridge.relaysTotal; i++) await new Promise((r) => setTimeout(r, 50));
  return true;
}

function isIPv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  return !!m && m.slice(1).every((x) => Number(x) <= 255);
}
