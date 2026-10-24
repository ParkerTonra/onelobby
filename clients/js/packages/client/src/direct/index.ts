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
import type { Lobby } from "../lobby.js";
import type { LinkFactory } from "../transport.js";
import { encodeJoinCode } from "../joincode.js";
import { DEFAULT_DIRECT_PORT } from "../direct-address.js";
import { DirectHubHost, PortInUseError } from "./hub-host.js";
import { directHubOptions } from "./hub.js";
import { isPublicIPv4, lanIPv4, localAddresses, type PortMapResult, type PortMapperOptions } from "./portmap.js";
import { OneLobbyError } from "../signaling.js";

export { DirectHubHost, LocalHubSocket, PortInUseError } from "./hub-host.js";
export { SignalingHub, Session, RateWindow, sanitize, defaultHubOptions, directHubOptions, PROTO } from "./hub.js";
export type { HubOptions, HubDeps } from "./hub.js";
export { PortMapper, isPublicIPv4, lanIPv4, localAddresses } from "./portmap.js";
export type { PortMapResult, PortMapperOptions, PortMapMethod } from "./portmap.js";
export { webRtcLinkFactoryFor } from "../webrtc.js";

export interface DirectHostOptions {
  /** TCP and UDP port to listen on (default 47810). */
  port?: number;
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
}

/** A direct host lobby: the normal Lobby, plus the hub behind it. Leaving or ending the lobby stops the hub. */
export type DirectLobby = Lobby & { directHub: DirectHubHost };

/**
 * Hosts a direct-IP lobby (docs/direct-ip.md s.3): starts the hub and listener on `port`, opens the router port
 * (unless `openPort: false`), connects `kit` to the hub in memory and creates the lobby. Resolves with the lobby;
 * show `lobby.joinCode` with `lobby.joinCodeKind` ("internet" or "same_network"). Rejects with `port_in_use`.
 * When the lobby ends (leave, or the process exits) the listener closes and the router mapping is removed; joiners
 * get `sessionEnded("host_left")`.
 */
export async function hostDirect(kit: OneLobby, o: DirectHostOptions = {}): Promise<DirectLobby> {
  const port = o.port ?? DEFAULT_DIRECT_PORT;
  const maxPlayers = o.maxPlayers ?? 4;
  let hub: DirectHubHost;
  try {
    hub = await DirectHubHost.listen(port, directHubOptions(maxPlayers, o.password));
  } catch (e) {
    if (e instanceof PortInUseError) throw new OneLobbyError("port_in_use", e.message.replace(/^port_in_use: /, ""));
    throw e;
  }
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
    const h: HostOptions = { name, maxPlayers, lateJoin: o.lateJoin ?? true, meta: o.meta };
    lobby = await kit.hostDirectWith(h, { socketFactory: () => hub.connectLocal(), wrapLinks });
  } catch (e) {
    await mapping;
    await hub.close();
    throw e;
  }
  lobby.on("sessionEnded", () => void hub.close());
  const map = await mapping;
  lobby.directAddresses = localAddresses(hub.port);
  lobby.portMapping = map ? map.detail : "off";
  if (map?.mapped && isPublicIPv4(map.externalIPv4)) {
    lobby.joinCode = encodeJoinCode(map.externalIPv4!, hub.port);
    lobby.joinCodeKind = "internet";
  } else {
    const lan = map?.localIPv4 ?? (await lanIPv4());
    if (lan) {
      lobby.joinCode = encodeJoinCode(lan, hub.port);
      lobby.joinCodeKind = "same_network";
    }
  }
  return Object.assign(lobby, { directHub: hub });
}
