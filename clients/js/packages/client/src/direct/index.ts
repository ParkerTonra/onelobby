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
import { isPublicIPv4, lanIPv4, localAddresses, type PortMapResult, type PortMapperOptions } from "./portmap.js";
import { OneLobbyError } from "../signaling.js";

export { DirectHubHost, LocalHubSocket, PortInUseError, originAllowed } from "./hub-host.js";
export type { HttpHandler, HttpReply } from "./hub-host.js";
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
  // The router request runs alongside lobby creation; it takes up to a few seconds when nothing answers.
  const mapping: Promise<PortMapResult | null> =
    o.openPort === false
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
  lobby.directAddresses = localAddresses(hub.port);
  lobby.portMapping = map ? map.detail : "off";
  let codeIp: string | null = null;
  if (map?.mapped && isPublicIPv4(map.externalIPv4)) {
    codeIp = map.externalIPv4!;
    lobby.joinCode = encodeJoinCode(codeIp, hub.port);
    lobby.joinCodeKind = "internet";
  } else {
    codeIp = map?.localIPv4 ?? (await lanIPv4());
    if (codeIp) {
      lobby.joinCode = encodeJoinCode(codeIp, hub.port);
      lobby.joinCodeKind = "same_network";
    }
  }
  const joinUrl = o.http && codeIp ? `http://${codeIp}:${hub.port}/` : null;
  return Object.assign(lobby, { directHub: hub, joinUrl });
}
