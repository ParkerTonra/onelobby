/**
 * Diagnostics, the pure part (spec/diagnostics.md, vectors in spec/vectors/diagnostics.json): the cause table, `diagnose`,
 * the host's one-line view, the joiner-to-host report and the connection check's verdict. Nothing here touches the network
 * or any clock; the net log is in `netlog.ts` and the measurements are in `connection-check.ts`.
 */

/** The step a failed attempt stopped at. */
export type Stage = "signaling" | "join" | "offer" | "ice" | "channels" | "handshake";
/** How far an attempt got (the last step it completed). */
export type Reached = "none" | "signaling" | "joined" | "offer" | "ice" | "channels";
/** What a TURN allocation did on a link ("none": no TURN entry; "failed": gathering ended with no relay, reason unknown). */
export type RelayState = "none" | "pending" | "ok" | "refused" | "unreachable" | "failed";
/** Candidate types that cross the wire. */
export type CandidateType = "host" | "srflx" | "relay";
/** The connection check's NAT reading as `diagnose` takes it (`blocked` = UDP does not get out). */
export type NatFact = "unknown" | "open" | "cone" | "symmetric" | "blocked";

/** The causes of a failed connection. A newer peer may report a code this client does not list: treat it as `timeout_unknown`. */
export const Causes = {
  NatBlocked: "nat_blocked",
  RelayRefused: "relay_refused",
  RelayUnreachable: "relay_unreachable",
  UdpBlocked: "udp_blocked",
  Firewall: "firewall",
  VersionMismatch: "version_mismatch",
  HostUnreachable: "host_unreachable",
  SignalingUnreachable: "signaling_unreachable",
  TimeoutUnknown: "timeout_unknown",
} as const;
export type Cause = (typeof Causes)[keyof typeof Causes];

/** Everything a client can observe about one connection attempt (spec/diagnostics.md s.2). */
export interface DiagnoseFacts {
  side: "joiner" | "host";
  route: "server" | "ip" | "nostr";
  /** The error code that ended the attempt (`ice_failed`, `timeout`, `version_mismatch`, `connect_failed`, ...), or null. */
  error: string | null;
  reached: Reached;
  elapsedMs: number;
  versions: { mine: string; theirs: string } | null;
  /** Route nostr: at least one relay connected; null otherwise or unknown. */
  relaysUp: boolean | null;
  /** A `stun:` server was in the link's ICE list. */
  stun: boolean;
  relay: RelayState;
  /** Candidate types this side sent / received (unique, sorted). */
  local: CandidateType[];
  remote: CandidateType[];
  retried: boolean;
  nat: NatFact;
  /** Host side: any ICE traffic from this joiner reached the listener; null when the platform cannot tell. */
  heard: boolean | null;
}

/** What `diagnose` says. */
export interface Diagnosis {
  cause: string;
  /** What happened, one sentence a player follows. */
  message: string;
  /** The one concrete next step, for the failing player. */
  hint: string;
  stage: Stage;
}

interface CauseText {
  message: string;
  hint: string;
  hostHint: string;
  short: string;
}

/** The cause table (spec/diagnostics.md s.4). `{mine}`, `{theirs}`, `{stage_text}` and `{elapsed}` are filled in by `explainCause`. */
export const CAUSE_TEXT: Record<Cause, CauseText> = {
  nat_blocked: {
    message: "Your network blocks direct connections (strict NAT) and no relay is set.",
    hint: "Paste a relay line in the game's settings, ask the host for one, or try another network such as a phone hotspot.",
    hostHint: "A relay (TURN) set on your side, or a forwarded game port, would let this player in.",
    short: "strict NAT, no relay set",
  },
  relay_refused: {
    message: "The relay rejected the login.",
    hint: "Check the relay line in the settings; it may have been typed wrong or expired.",
    hostHint: "Their relay line may be wrong or expired.",
    short: "the relay rejected the login",
  },
  relay_unreachable: {
    message: "The relay could not be used: it did not answer.",
    hint: "Check the relay line for typos and that the relay is online; some networks block relays.",
    hostHint: "Their relay is down or their network blocks it.",
    short: "the relay did not answer",
  },
  udp_blocked: {
    message: "Your network blocks UDP, the kind of traffic games use to connect.",
    hint: "Try another network, such as a phone hotspot, or a relay that can be reached from this network.",
    hostHint: "Their network blocks UDP. Ask them to try another network.",
    short: "UDP blocked",
  },
  firewall: {
    message: "A firewall may be blocking the game on the host's computer: nothing from the player ever reached it.",
    hint: "Allow the game in the firewall (on Windows, tick Private networks when asked), then try again.",
    hostHint: "Allow the game in your firewall (on Windows, tick Private networks when asked), then ask them to try again.",
    short: "nothing reached the host (firewall?)",
  },
  version_mismatch: {
    message: "You have version {mine}, the host has {theirs}.",
    hint: "Update the game on the older side, then try again.",
    hostHint: "Make sure you both have the same version of the game.",
    short: "different game version",
  },
  host_unreachable: {
    message: "The host did not answer.",
    hint: "Check the code or address, and that the host is online with the game open.",
    hostHint: "They could not reach you. Check that your game is open and the code is current.",
    short: "the host did not answer",
  },
  signaling_unreachable: {
    message: "Could not reach the lobby server or any relay that introduces players.",
    hint: "Check your internet connection; if it works elsewhere, try again in a few minutes.",
    hostHint: "Their internet connection or the lobby service may be down.",
    short: "no lobby server or relay reachable",
  },
  timeout_unknown: {
    message: "The connection did not finish. It stopped at {stage_text} after {elapsed}.",
    hint: "Try again. If it keeps happening, copy the log and send it to the host.",
    hostHint: "Ask them to copy their log and send it to you.",
    short: "unknown cause",
  },
};

/** The same sentence with no versions (a report carries none). */
const VERSION_MISMATCH_PLAIN = "You and the host have different versions of the game.";

/** How a stage reads in a sentence. */
export const STAGE_TEXT: Record<Stage, string> = {
  signaling: "reaching the lobby",
  join: "joining the lobby",
  offer: "waiting for the host to start the connection",
  ice: "the connection check",
  channels: "opening the game connection",
  handshake: "the final hello with the host",
};

const STAGE_OF: Record<Reached, Stage> = { none: "signaling", signaling: "join", joined: "offer", offer: "ice", ice: "channels", channels: "handshake" };

/** The stage a failed attempt stopped at, from how far it got. */
export function stageOf(reached: Reached): Stage {
  return STAGE_OF[reached] ?? "ice";
}

/** `under 1 s` below a second, else whole seconds rounded to nearest (halves up) and ` s`. */
export function elapsedText(ms: number): string {
  if (!(ms >= 1000)) return "under 1 s";
  return `${Math.floor(ms / 1000 + 0.5)} s`;
}

function stageText(stage: string): string {
  return (STAGE_TEXT as Record<string, string>)[stage] ?? STAGE_TEXT.ice;
}

/** The sentence, next step and host-side step for a cause code (an unknown code reads as `timeout_unknown`). */
export function explainCause(
  cause: string,
  vars: { stage?: string; elapsedMs?: number; mine?: string; theirs?: string } = {},
): { cause: string; message: string; hint: string; hostHint: string; short: string } {
  const known = Object.prototype.hasOwnProperty.call(CAUSE_TEXT, cause);
  const t = CAUSE_TEXT[(known ? cause : "timeout_unknown") as Cause];
  let message = t.message;
  if (cause === "version_mismatch" && !(vars.mine && vars.theirs)) message = VERSION_MISMATCH_PLAIN;
  message = message
    .replace("{mine}", vars.mine ?? "")
    .replace("{theirs}", vars.theirs ?? "")
    .replace("{stage_text}", stageText(vars.stage ?? "ice"))
    .replace("{elapsed}", elapsedText(vars.elapsedMs ?? 0));
  return { cause: known ? cause : "timeout_unknown", message, hint: t.hint, hostHint: t.hostHint, short: t.short };
}

const UNREACHED_CODES = new Set(["direct_unreachable", "connect_failed", "no_server", "server_closed", "closed"]);

/** The cause code for these facts (spec/diagnostics.md s.2 rules, first match wins). */
function causeOf(f: DiagnoseFacts): Cause {
  if (f.error === "version_mismatch") return Causes.VersionMismatch;
  if ((f.reached === "none" || f.reached === "signaling") && f.error !== null && UNREACHED_CODES.has(f.error)) {
    if (f.route === "server") return Causes.SignalingUnreachable;
    if (f.route === "nostr") return f.relaysUp === false ? Causes.SignalingUnreachable : Causes.HostUnreachable;
    return Causes.HostUnreachable;
  }
  if (f.error === "ice_failed" || f.error === "timeout") {
    if (f.relay === "refused") return Causes.RelayRefused;
    if (f.relay === "unreachable" || f.relay === "failed") return Causes.RelayUnreachable;
    const negotiated = f.reached === "offer";
    if (negotiated && f.relay === "none") {
      if (f.nat === "blocked") return Causes.UdpBlocked;
      if (f.stun && f.local.length > 0 && !f.local.includes("srflx")) return Causes.UdpBlocked;
      if (f.nat === "symmetric") return Causes.NatBlocked;
      if (f.side === "host" && f.heard === false) return Causes.Firewall;
      if (f.side === "joiner" && f.local.length > 0 && f.remote.length > 0) return Causes.NatBlocked;
    }
  }
  return Causes.TimeoutUnknown;
}

/**
 * The cause of a failed connection, from what the client observed: `{ cause, message, hint, stage }`. Pure: every client
 * gives the same answer for the same facts (vectors `diagnose`).
 */
export function diagnose(facts: DiagnoseFacts): Diagnosis {
  const stage = stageOf(facts.reached);
  const cause = causeOf(facts);
  const e = explainCause(cause, { stage, elapsedMs: facts.elapsedMs, mine: facts.versions?.mine, theirs: facts.versions?.theirs });
  return { cause, message: e.message, hint: e.hint, stage };
}

/** The line a host shows for a joiner's failure: `Sam: strict NAT, no relay set, stopped at the connection check after 15 s.` */
export function hostLine(name: string, cause: string, stage: string, elapsedMs: number): string {
  return `${name}: ${explainCause(cause).short}, stopped at ${stageText(stage)} after ${elapsedText(elapsedMs)}.`;
}

// ---- the joiner's report to the host (spec/diagnostics.md s.7) -----------------------------------------------------

/** What a joiner tells the host it dialed. Fixed, typed fields: never an address, a name, free text or a credential. */
export interface DiagnosisReport {
  cause: string;
  stage: string;
  elapsedMs: number;
  /** A relay was in the joiner's ICE list. */
  relaySet: boolean;
  /** The joiner's connection check result, when it ran one. */
  natType?: "open" | "cone" | "symmetric" | "blocked";
  candidateTypes: { local: CandidateType[]; remote: CandidateType[] };
  clientVersion: string;
}

/** The largest `diag` frame a hub accepts, in bytes of JSON text. */
export const REPORT_MAX_BYTES = 1024;
/** Reports a hub forwards per peer in `REPORT_WINDOW_MS`. */
export const REPORTS_PER_WINDOW = 3;
export const REPORT_WINDOW_MS = 60_000;
/** The host keeps at most one report per peer in this long. */
export const REPORT_HOST_GAP_MS = 10_000;

const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const VERSION_RE = /^[A-Za-z0-9._+-]{1,32}$/;
const CAND_TYPES = ["host", "srflx", "relay"];
const NAT_TYPES = ["open", "cone", "symmetric", "blocked"];

function typeList(v: unknown): CandidateType[] | null {
  if (!Array.isArray(v) || v.length > 3) return null;
  const out: CandidateType[] = [];
  for (const x of v) {
    if (typeof x !== "string" || !CAND_TYPES.includes(x) || out.includes(x as CandidateType)) return null;
    out.push(x as CandidateType);
  }
  return out;
}

/**
 * The report rebuilt from the known fields (anything else is dropped), or null when it is not a valid report. Hubs and
 * hosts use this on everything that arrives; a sender builds with it too.
 */
export function cleanReport(input: unknown): DiagnosisReport | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const { cause, stage, elapsedMs, relaySet, natType, candidateTypes, clientVersion } = r;
  if (typeof cause !== "string" || !NAME_RE.test(cause)) return null;
  if (typeof stage !== "string" || !NAME_RE.test(stage)) return null;
  if (typeof elapsedMs !== "number" || !Number.isInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 3_600_000) return null;
  if (typeof relaySet !== "boolean") return null;
  if (natType !== undefined && (typeof natType !== "string" || !NAT_TYPES.includes(natType))) return null;
  if (!candidateTypes || typeof candidateTypes !== "object") return null;
  const local = typeList((candidateTypes as Record<string, unknown>).local);
  const remote = typeList((candidateTypes as Record<string, unknown>).remote);
  if (!local || !remote) return null;
  if (typeof clientVersion !== "string" || !VERSION_RE.test(clientVersion)) return null;
  const out: DiagnosisReport = { cause, stage, elapsedMs, relaySet, candidateTypes: { local, remote }, clientVersion };
  if (natType !== undefined) out.natType = natType as DiagnosisReport["natType"];
  // key order is the spec's (cause, stage, elapsedMs, relaySet, natType?, candidateTypes, clientVersion)
  return natType !== undefined
    ? { cause, stage, elapsedMs, relaySet, natType: out.natType, candidateTypes: out.candidateTypes, clientVersion }
    : out;
}

// ---- the connection check's verdict and NAT classification (spec/diagnostics.md s.8) --------------------------------

export interface CheckFindings {
  udp: "ok" | "blocked" | "unknown";
  natType: "open" | "cone" | "symmetric" | "unknown";
  relay: "ok" | "refused" | "unreachable" | "unknown" | "none";
}

export type CheckVerdict = "good" | "likely_fail" | "relay_works" | "blocked" | "relay_refused" | "relay_unreachable" | "unknown";

/** The one line a menu shows for a check (first match wins, see spec/diagnostics.md s.8). */
export function checkVerdict(r: CheckFindings): { verdict: CheckVerdict; message: string } {
  if (r.relay === "refused") return { verdict: "relay_refused", message: "The relay rejected the login. Check the relay line; it may have expired." };
  if (r.relay === "unreachable") return { verdict: "relay_unreachable", message: "The relay did not answer. Check the relay line and your network." };
  if (r.udp === "blocked" && r.relay === "ok") return { verdict: "relay_works", message: "Direct connections will fail, but your relay works." };
  if (r.udp === "blocked")
    return { verdict: "blocked", message: "Direct connections: will fail. Your network blocks UDP (or the test servers could not be reached). A relay or another network is needed." };
  if (r.natType === "symmetric" && r.relay === "ok") return { verdict: "relay_works", message: "Direct connections may fail, but your relay works." };
  if (r.natType === "symmetric") return { verdict: "likely_fail", message: "Direct connections: likely to fail. A relay is recommended." };
  if (r.natType === "open" || r.natType === "cone") return { verdict: "good", message: "Direct connections: likely to work." };
  return { verdict: "unknown", message: "Could not tell how your network handles direct connections." };
}

export interface MappedAddress {
  ip: string;
  port: number;
}

/**
 * `udp` and `natType` from what the STUN servers saw: `asked` servers were queried from one socket, `answers` are the mapped
 * addresses that came back, `local` the socket's own address and port when known (it decides `open`).
 */
export function classifyNat(asked: number, answers: MappedAddress[], local: MappedAddress | null): Pick<CheckFindings, "udp" | "natType"> {
  if (answers.length === 0) return { udp: asked > 0 ? "blocked" : "unknown", natType: "unknown" };
  if (answers.length === 1) return { udp: "ok", natType: "unknown" };
  const first = answers[0];
  if (answers.some((a) => a.ip !== first.ip || a.port !== first.port)) return { udp: "ok", natType: "symmetric" };
  if (local && local.ip === first.ip && local.port === first.port) return { udp: "ok", natType: "open" };
  return { udp: "ok", natType: "cone" };
}

/** The `nat` fact a `diagnose` call takes from a check result. */
export function natFact(r: Pick<CheckFindings, "udp" | "natType"> | null | undefined): NatFact {
  if (!r) return "unknown";
  if (r.udp === "blocked") return "blocked";
  return r.natType;
}
