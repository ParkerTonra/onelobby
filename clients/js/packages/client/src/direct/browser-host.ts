/**
 * `kit.hostNostr()`: host a direct lobby from a browser tab (or any runtime with WebSocket + WebRTC), with no Node process
 * and no listening port. The signaling hub runs inside the page, the host's own socket is wired to it in memory, and
 * joiners reach it through public Nostr relays with a normal dc1 version 1 code (spec/nostr-signaling.md). There is no IP
 * fallback: with no relay reachable it rejects with `direct_unreachable`. Nothing here imports a Node module.
 */
import type { HostOptions, OneLobby } from "../onelobby.js";
import type { Lobby, RateLimit } from "../lobby.js";
import { encodeRoomCode } from "../joincode.js";
import { NostrHostBridge } from "../nostr/host.js";
import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_STUN } from "../nostr/relays.js";
import { OneLobbyError } from "../signaling.js";
import { SignalingHub, directHubOptions } from "./hub.js";
import { LocalHubSocket } from "./hub-local.js";

/** The slice of `document` the visibility watcher uses (a test seam; default `globalThis.document`). */
export interface VisibilityDoc {
  visibilityState?: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface BrowserHostOptions {
  /** Optional; joiners must send the same one or get `bad_password`. */
  password?: string;
  maxPlayers?: number;
  /** Lobby name; default "<displayName>'s game". */
  name?: string;
  lateJoin?: boolean;
  meta?: Record<string, string>;
  /** Per-joiner cap on incoming raw messages, e.g. `{ messages: 60, perMs: 1000 }`; the excess is dropped. */
  rateLimit?: RateLimit;
  /** Relays (default: the blueprint's `hosting.nostrRelays`, else the library list) and STUN servers (default Google's and Cloudflare's). */
  nostr?: { relays?: string[]; stun?: string[] };
  /** Receives the startup line (`lobby.directHostLog`). Default `console.log`; `false` prints nothing. */
  log?: ((line: string) => void) | false;
  /** Receives the warning printed when the host tab goes hidden. Default `console.warn`; `false` prints nothing. */
  warn?: ((line: string) => void) | false;
  /** How long to wait for a first relay before rejecting with `direct_unreachable` (default 10000). */
  relayTimeoutMs?: number;
  /** Test seam: the document whose `visibilityState` is watched. Default `globalThis.document`. */
  document?: VisibilityDoc | null;
}

/** A browser host lobby: the normal Lobby (`hostHidden` / `hostHiddenChanged` tell when the tab is throttled). */
export type BrowserHostLobby = Lobby;

/**
 * The startup line of a browser host, same family as `formatHostLog`:
 * `OneLobby: browser host (no port); code 7HQ-4K2-... (Nostr); nostr 4/5 relays`.
 */
export function formatBrowserHostLog(code: string, relays: string): string {
  return `OneLobby: browser host (no port); code ${code} (Nostr); nostr ${relays} relays`;
}

const RELAY_WAIT_MS = 10_000;

export async function hostNostr(kit: OneLobby, opts: BrowserHostOptions = {}): Promise<BrowserHostLobby> {
  const bp = kit.blueprint;
  if (bp && !bp.hosting.nostr) {
    throw new OneLobbyError("nostr_disabled", "this game has Nostr signaling turned off (hosting.nostr is false), and a browser host has no other way to be reached");
  }
  const defined = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as BrowserHostOptions;
  const o: BrowserHostOptions = bp
    ? {
        maxPlayers: bp.lobby.maxPlayers,
        lateJoin: bp.lobby.lateJoin,
        meta: { ...bp.lobby.meta },
        ...(bp.session.rateLimit ? { rateLimit: { ...bp.session.rateLimit } } : {}),
        ...defined,
        nostr: { ...defined.nostr, relays: defined.nostr?.relays ?? [...bp.hosting.nostrRelays] },
      }
    : defined;
  const maxPlayers = o.maxPlayers ?? 4;
  const relays = o.nostr?.relays && o.nostr.relays.length > 0 ? o.nostr.relays : [...DEFAULT_NOSTR_RELAYS];
  const stunUrls = o.nostr?.stun ?? [...DEFAULT_NOSTR_STUN];

  const hub = new SignalingHub({ ...directHubOptions(maxPlayers, o.password), stunUrls });
  const ticker = setInterval(() => hub.tick(), 1000);
  (ticker as { unref?: () => void }).unref?.();
  const code = encodeRoomCode();
  const env = kit.nostrHostEnv();
  let bridge: NostrHostBridge | undefined;
  const teardown = () => {
    clearInterval(ticker);
    bridge?.close();
  };
  try {
    try {
      bridge = await NostrHostBridge.start(hub, { code, relays, connect: env.connect, clock: env.clock, wall: env.wall });
    } catch (e) {
      throw new OneLobbyError("direct_unreachable", `cannot reach any Nostr relay (${e instanceof Error ? e.message : String(e)}); a browser host has no other way to be reached`);
    }
    if (!(await bridge.whenUp(o.relayTimeoutMs ?? RELAY_WAIT_MS))) {
      throw new OneLobbyError("direct_unreachable", `no Nostr relay reachable (tried ${bridge.relaysTotal}); a browser host has no IP fallback, check the connection or pass other relays`);
    }
    for (let i = 0; i < 30 && bridge.relaysConnected < bridge.relaysTotal; i++) await new Promise((r) => setTimeout(r, 50));

    const name = o.name ?? `${kit.options.displayName || "Player"}'s game`;
    const h: HostOptions = { name, maxPlayers, lateJoin: o.lateJoin ?? true, meta: o.meta, rateLimit: o.rateLimit };
    // joiners have no address to dial: links use the hub's STUN list, no port pin
    const lobby = await kit.hostDirectWith(h, { socketFactory: () => new LocalHubSocket(hub), wrapLinks: (inner) => inner });
    lobby.linkAddressSink = (peerId, ip) => hub.reportLinkAddress(peerId, ip);
    lobby.on("sessionEnded", teardown);

    lobby.joinCode = code;
    lobby.joinCodeKind = "nostr";
    lobby.directCode = "";
    lobby.directCodeKind = "none";
    lobby.portMapping = "off";
    lobby.directHostLog = formatBrowserHostLog(code, `${bridge.relaysConnected}/${bridge.relaysTotal}`);
    watchVisibility(lobby, o);
    if (o.log !== false) (o.log ?? console.log)(lobby.directHostLog);
    return lobby;
  } catch (e) {
    teardown();
    throw e;
  }
}

/** Sets `lobby.hostHidden` and warns when the tab goes hidden: browsers throttle timers there (about 1/s, ~1/min after 5 min). */
function watchVisibility(lobby: Lobby, o: BrowserHostOptions): void {
  const doc: VisibilityDoc | null | undefined = o.document !== undefined ? o.document : (globalThis as { document?: VisibilityDoc }).document;
  if (!doc || typeof doc.addEventListener !== "function") return;
  const warn = o.warn === false ? null : (o.warn ?? ((s: string) => console.warn(s)));
  const check = () => {
    const hidden = doc.visibilityState === "hidden";
    const changed = hidden !== lobby.hostHidden;
    lobby.setHostHidden(hidden);
    if (changed && hidden) warn?.("OneLobby: the host tab is hidden; the browser slows its timers, so players may lag or drop. Keep this tab visible while hosting.");
  };
  doc.addEventListener("visibilitychange", check);
  lobby.on("sessionEnded", () => doc.removeEventListener("visibilitychange", check));
  check();
}
