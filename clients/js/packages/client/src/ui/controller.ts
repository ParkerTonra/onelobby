/**
 * The DOM-free brain of `<one-lobby>`: a small state machine over OneLobby + Lobby (raw mode) that the element
 * renders, plus the JSON message envelope and the host-authoritative shared state. Unit-tested without a browser.
 *
 * It also holds what the Godot menu's `MenuModel` has (docs/recipes/menu.md): the roster with ready and kick/ban, the start
 * countdown, host settings, join requests, chat, the removed/error screen with logs, the settings screen and the lobby
 * browser. Everything past the first version is additive: the old members behave as they did.
 */
import { OneLobbyError, type LobbySummary } from "../signaling.js";
import type { Lobby, Peer } from "../lobby.js";
import type { HostOptions, JoinOptions, JoinDirectOptions } from "../onelobby.js";
import { describeError, shareUrl, type FriendlyError } from "../friendly.js";
import { formatCode, normalizeCode } from "../crockford.js";
import type { Blueprint } from "../blueprint.js";
import type { PlayerSettings } from "../settings.js";
import type { NetLog } from "../netlog.js";
import type { CheckOptions, CheckResult } from "../connection-check.js";
import type { RemovalInfo } from "../room.js";
import { MenuTexts } from "./menu-text.js";
import { cleanJoinText, parseJoin } from "./menu-join.js";

export type UiState = "idle" | "connecting" | "lobby" | "playing" | "error";
/** The screens of the drop-in menu: `state` plus the two screens that sit on top of the start screen (`state` stays "idle" there). */
export type UiScreen = "start" | "connecting" | "lobby" | "playing" | "error" | "settings" | "browse";

export interface Player {
  id: number;
  name: string;
  isHost: boolean;
  isMe: boolean;
}

/** What the controller needs from `OneLobby` (so tests can pass the in-memory rig). Everything after `rememberedCode` is optional. */
export interface KitLike {
  host(h: HostOptions): Promise<Lobby>;
  join(code: string, o?: JoinOptions): Promise<Lobby>;
  /** Take back the seat this tab held before a reload (OneLobby `rememberSeat`); null when there is none. */
  resume?(): Promise<Lobby | null>;
  readonly rememberedCode?: string | null;
  /** The saved name, relay line, last code and lobby server (the settings screen reads and writes it). */
  readonly settings?: PlayerSettings;
  /** The net log behind "Copy logs" and "Save logs". */
  readonly netLog?: NetLog;
  /** The onelobby.json this kit was built from, when it has one: it switches chat, join approval, names and the connection check. */
  readonly blueprint?: Blueprint;
  /** The lobby browser. */
  list?(): Promise<LobbySummary[]>;
  /** A direct join code or address in the Join box. */
  joinDirect?(codeOrAddress: string, o?: JoinDirectOptions): Promise<Lobby>;
  /** The connection check button. */
  checkConnection?(o?: CheckOptions): Promise<CheckResult>;
}

/** What the removed / error screen shows. `reason` is the host's own words for a kick or ban (or the default sentence of the code). */
export interface MenuError {
  title: string;
  message: string;
  hint: string;
  /** The stable code (`bad_code`, `kicked`, ...). */
  code: string;
  removed: boolean;
  ban: boolean;
  reason: string;
}

/** One row of the roster. */
export interface RosterRow {
  id: number;
  name: string;
  me: boolean;
  host: boolean;
  ready: boolean;
  spectator: boolean;
  reconnecting: boolean;
  /** Round trip in ms where this client measures one (a joiner's own link to the host), else 0. */
  pingMs: number;
  /** The host can remove this row. */
  canKick: boolean;
}

/** A line of the lobby's chat. */
export interface ChatLine {
  peerId: number;
  name: string;
  text: string;
}

/** A player asking to join a lobby that approves joins. */
export interface JoinRequest {
  peerId: number;
  name: string;
}

/** One line of the ban list; `key` is what `unban` takes. */
export interface BanRow {
  key: string;
  text: string;
}

/** What the room layer lets the host change. */
export interface LobbySettingsView {
  autoStart: "off" | "all_ready" | "players";
  minPlayers: number;
  countdownSeconds: number;
  lateJoin: boolean;
}

/** The chat keeps this many lines. */
export const CHAT_KEEP = 100;

export interface ControllerEvents {
  message: { from: Player | null; data: unknown };
  "player-joined": { player: Player };
  "player-left": { player: Player; reason: string };
  start: Record<string, never>;
  error: FriendlyError;
  "shared-change": { key: string; value: unknown; from: Player | null };
  /** A chat line arrived (text chat is on). */
  chat: { from: Player | null; text: string };
  /** The host removed this player (kick or ban); `error` follows. */
  removed: { code: string; reason: string; ban: boolean };
  /** The host sent everyone back to the lobby after a game. */
  "lobby-return": Record<string, never>;
}

export interface ControllerOptions {
  /** `intent` is "direct" when the Join box held a direct code or an address (no lobby server needed), else "server". */
  makeKit: (name: string, intent?: "server" | "direct") => KitLike;
  /** A number, or a function read each time a game is hosted. */
  maxPlayers: number | (() => number);
  /** Lobby name shown to the server (not to players). */
  lobbyName?: string;
  /** The saved settings, for the start and settings screens when no kit exists yet. Default: the newest kit's. */
  settings?: () => PlayerSettings | null;
  /** The onelobby.json of the page, when it has one. Default: the newest kit's. */
  blueprint?: () => Blueprint | undefined;
  /** True when a lobby server address is known (the page's own or a saved one): the lobby browser needs it. Default: true. */
  serverKnown?: () => boolean;
  /** The lobby server the page sets for itself, shown on the settings screen. Default: "". */
  pageServer?: () => string;
  /** True when each join needs the host's approval (a private lobby). A blueprint's `lobby.approveJoins` does the same. */
  approveJoins?: () => boolean;
  /** Base address of an invite link. With it, the copied invite sentence ends with the link. Default: none. */
  inviteBase?: () => string | undefined;
  /** The query key of an invite link. Default "join". */
  inviteParam?: () => string;
  /** Puts text on the clipboard; true when it worked. Default: nothing is copied. */
  clipboard?: (text: string) => Promise<boolean> | boolean;
  /** Runs the connection check. Default: the kit's `checkConnection`. */
  checkRunner?: (o: CheckOptions) => Promise<CheckResult>;
  /** True when nothing may leave this page's machine: the check then never runs by itself (the button still works). Default: false. */
  localOnly?: () => boolean;
}

/** The check verdicts (spec/diagnostics.md s.8) that put a line on the start screen. */
const WARNING_VERDICTS = ["likely_fail", "blocked", "relay_refused", "relay_unreachable"];

/** Wire envelope inside raw frames. Kept tiny and versioned by key names only. */
type Wire =
  | { k: "m"; d: unknown } // game message
  | { k: "set"; key: string; v: unknown } // joiner -> host: please set
  | { k: "add"; key: string; n: number } // joiner -> host: please add
  | { k: "S"; key: string; v: unknown; by: number; q: number } // host -> all: value changed (q = host change counter)
  | { k: "SS"; all: Record<string, unknown>; q: number }; // host -> one: full state as of change q

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBytes = (w: Wire) => enc.encode(JSON.stringify(w));

export class SharedState {
  /** @internal */ values = new Map<string, unknown>();
  constructor(private c: LobbyController) {}
  get(key: string): unknown {
    return this.values.get(key);
  }
  /** Set a value for everyone. The host decides the order; everyone gets `shared-change`. */
  set(key: string, value: unknown): void {
    this.c._sharedOp({ k: "set", key: String(key), v: value === undefined ? null : value });
  }
  /** Add `n` (default 1) to a number, safely even when several players click at once. */
  add(key: string, n = 1): void {
    this.c._sharedOp({ k: "add", key: String(key), n: Number(n) || 0 });
  }
  /** A plain copy of every value. */
  all(): Record<string, unknown> {
    return Object.fromEntries(this.values);
  }
  keys(): string[] {
    return [...this.values.keys()];
  }
}

export class LobbyController {
  state: UiState = "idle";
  lobby: Lobby | null = null;
  error: FriendlyError | null = null;
  /** True while a joiner waits for its direct link to the host. */
  linking = false;
  name = "";
  readonly shared = new SharedState(this);

  /** Every string the menu shows; reword with `texts.override({...})`. */
  readonly texts = new MenuTexts();
  /** The error screen (title, plain sentence, hint, stable code); null when there is none. `error` keeps the plain `FriendlyError`. */
  menuError: MenuError | null = null;
  /** Why the host removed this player, once it has. */
  removal: RemovalInfo | null = null;
  /** What the Join box holds (kept tidy as typed). */
  joinText = "";
  /** The password typed for hosting or joining; never stored, never in an event. */
  password = "";
  /** One line under the lobby: why the last click did nothing (not enough players, chat off, ...). */
  note = "";
  /** The start screen's one-liner: "You're invited!". */
  startNote = "";
  chatLines: ChatLine[] = [];
  requests: JoinRequest[] = [];
  browseItems: LobbySummary[] = [];
  browseStatus = "";
  settingsNote = "";
  relayNote = "";
  /** The lobby server in use: the page's own when it sets one, else the saved one. */
  serverText = "";
  /** One line, "" before a check. */
  checkVerdict = "";
  /** Three lines (UDP, network type, relay), empty before a check. */
  checkFacts: string[] = [];
  checkRunning = false;
  /** The verdict word of the last finished check ("good", "blocked", ...); "" before one and while it runs. */
  checkVerdictId = "";
  private opened = false;
  /** What the last Copy / Save logs did. */
  logNote = "";
  /** What the last Copy code / invite did ("Copied!"). */
  copyNote = "";

  onChange: () => void = () => {};
  onEvent: <K extends keyof ControllerEvents>(type: K, detail: ControllerEvents[K]) => void = () => {};

  private lastAction: { kind: "host" } | { kind: "join"; code: string } | { kind: "resume" } | null = null;
  private unsub: Array<() => void> = [];
  private gen = 0;
  private overlay: "settings" | "browse" | null = null;
  private kit: KitLike | null = null;
  private direct = false;
  private browseGen = 0;
  /** Host: changes made so far. Joiner: the newest change applied (older queued ones are skipped). */
  private seq = 0;

  constructor(private opts: ControllerOptions) {}

  get isHost(): boolean {
    return !!this.lobby && this.lobby.isHost;
  }
  get code(): string | null {
    return this.lobby?.code ?? null;
  }
  get players(): Player[] {
    const l = this.lobby;
    if (!l) return [];
    const list = l.peers.map((p) => this.toPlayer(p));
    if (!list.some((p) => p.isMe)) list.push({ id: l.localPeerId, name: this.name || `Player ${l.localPeerId}`, isHost: l.isHost, isMe: true });
    return list.sort((a, b) => a.id - b.id);
  }

  /** The screen to draw: `state`, or "settings" / "browse" on top of the start screen. */
  get screen(): UiScreen {
    if (this.state === "idle") return this.overlay ?? "start";
    return this.state;
  }

  /** One line of plain language for the status area. */
  get statusText(): string {
    const t = this.texts;
    switch (this.state) {
      case "idle":
        return t.t("status_idle");
      case "connecting":
        return this.lastAction?.kind === "join" ? t.t("status_joining") : this.lastAction?.kind === "resume" ? t.t("status_resuming") : t.t("status_creating");
      case "error":
        return (this.menuError?.removed ? this.menuError.message : this.error?.message) ?? t.t("status_error");
      case "lobby": {
        if (this.linking) return t.t("status_linking", this.hostName);
        if (this.isHost) {
          const n = this.players.length;
          return n <= 1 ? t.t("status_waiting") : t.t("status_players_here", n);
        }
        return t.t("status_connected", this.hostName);
      }
      case "playing":
        return this.linking ? t.t("status_linking", this.hostName) : t.t("status_playing");
    }
  }

  private get hostName(): string {
    const l = this.lobby;
    if (!l) return this.texts.t("status_host_fallback");
    return l.peer(l.hostPeerId)?.name || this.texts.t("status_host_fallback");
  }

  private toPlayer(p: Peer | undefined, id?: number): Player {
    const l = this.lobby!;
    const pid = p?.peerId ?? id ?? 0;
    return { id: pid, name: p?.name || (pid === l.localPeerId && this.name) || `Player ${pid}`, isHost: pid === l.hostPeerId, isMe: pid === l.localPeerId };
  }

  // ---- what the blueprint (or its absence) switches --------------------------------------------------------------------

  /** The onelobby.json in force: the page's, else the newest kit's. */
  get blueprint(): Blueprint | undefined {
    return this.opts.blueprint?.() ?? this.kit?.blueprint;
  }
  /** False for a blueprint with `players.identity` "anonymous": no name field. */
  get namesAllowed(): boolean {
    return this.blueprint?.players.identity !== "anonymous";
  }
  get maxNameLength(): number {
    return Math.min(24, this.blueprint?.players.maxNameLength ?? 24);
  }
  /** The lobby browser needs a lobby server address (and a blueprint that uses one). */
  get canBrowse(): boolean {
    const bp = this.blueprint;
    return (!bp || bp.hosting.server) && (this.opts.serverKnown?.() ?? true);
  }
  get connectionCheckShown(): boolean {
    return this.blueprint?.diagnostics.showConnectionCheck !== false;
  }
  /** The menu runs the connection check once when it opens: on unless `diagnostics.checkOnOpen` is false ("button only"), `showConnectionCheck` is false, or the page says nothing may leave the machine. */
  get checkOnOpenEnabled(): boolean {
    return this.connectionCheckShown && this.blueprint?.diagnostics.checkOnOpen !== false && !(this.opts.localOnly?.() ?? false);
  }
  /**
   * The element calls this whenever it shows the start screen. The first call that finds the start screen up starts the check (when
   * `checkOnOpenEnabled`); later calls (the way back from a lobby or from Settings) change nothing. A check that is running is never
   * started twice. Hosting and joining never wait for it. Resolves when the check ends.
   */
  startShown(): Promise<void> {
    if (this.opened || this.screen !== "start") return Promise.resolve();
    this.opened = true;
    return this.checkOnOpenEnabled && !this.checkRunning ? this.runCheck() : Promise.resolve();
  }
  /** The one line the start screen shows: the verdict sentence when the check found a problem (direct connections likely to fail, UDP blocked, a relay that refuses the login or does not answer), else "". */
  get startCheckLine(): string {
    return !this.checkRunning && WARNING_VERDICTS.includes(this.checkVerdictId) ? this.checkVerdict : "";
  }
  /** Text chat shows while a lobby is open and the blueprint has it on. */
  get chatShown(): boolean {
    return !!this.lobby && this.blueprint?.chat.text !== false;
  }
  get approveJoinsOn(): boolean {
    return this.blueprint?.lobby.approveJoins === true || this.opts.approveJoins?.() === true;
  }
  /** True when the host answered with the room layer (ready, countdown, kick and ban work). False for an old host or before its answer. */
  get roomActive(): boolean {
    return !!this.lobby && this.lobby.room.supported === true;
  }
  /** True when the host's game is older than the room layer: the roster is a plain list. */
  get plainList(): boolean {
    return !!this.lobby && this.lobby.room.supported === false;
  }

  // ---- the start screen ------------------------------------------------------------------------------------------------

  /** The saved name and last code, as the start screen's defaults. */
  defaults(): { name: string; lastCode: string } {
    const s = this.settingsStore()?.effective();
    const last = s?.lastCode ?? "";
    return { name: s?.name ?? "", lastCode: last.length === 6 ? formatCode(last) : last };
  }

  /** Keeps what is typed in the Join box tidy; returns the cleaned text. */
  setJoinText(text: string): string {
    this.joinText = cleanJoinText(text);
    return this.joinText;
  }

  setPassword(text: string): void {
    this.password = text.length > 64 ? text.slice(0, 64) : text;
  }

  noteInvited(withName: boolean): void {
    this.startNote = this.texts.t(withName ? "start_invited" : "start_invited_noname");
    this.onChange();
  }

  // ---- actions -----------------------------------------------------------------------------------------------------

  host(name: string): Promise<void> {
    this.lastAction = { kind: "host" };
    const bp = this.blueprint;
    const visibility = this.approveJoinsOn ? "private" : bp?.lobby.listed ? "public" : "unlisted";
    const password = this.password;
    return this.run(name, (kit) =>
      kit.host({
        name: this.opts.lobbyName ?? "game",
        maxPlayers: typeof this.opts.maxPlayers === "function" ? this.opts.maxPlayers() : this.opts.maxPlayers,
        visibility,
        lateJoin: true,
        ...(password ? { password } : {}),
      }),
    );
  }

  join(code: string, name: string): Promise<void> {
    const p = parseJoin(code);
    this.lastAction = { kind: "join", code };
    if (p.kind === "none") {
      this.fail(new OneLobbyError("bad_code"));
      return Promise.resolve();
    }
    const password = this.password;
    const o = password ? { password } : undefined;
    if (p.kind === "lobby") return this.run(name, (kit) => kit.join(p.value, o));
    return this.run(
      name,
      (kit) => {
        if (!kit.joinDirect) throw new OneLobbyError("bad_address");
        return kit.joinDirect(p.value, o);
      },
      false,
      "direct",
    );
  }

  /** Join what the Join box holds (see `setJoinText`). */
  joinTyped(name: string): Promise<void> {
    return this.join(this.joinText, name);
  }

  /**
   * Take back this tab's seat after a page reload, if the kit remembers one (host or joiner). Quietly stays on the
   * start screen when there is nothing to resume or the seat is gone. Resolves true when back in a game.
   */
  async resume(name: string): Promise<boolean> {
    const kit = this.opts.makeKit(name);
    if (!kit.resume || !kit.rememberedCode) return false;
    this.lastAction = { kind: "resume" };
    await this.run(
      name,
      () => {
        this.kit = kit;
        return kit.resume!();
      },
      true,
    );
    return !!this.lobby;
  }

  /** Repeat whatever failed last (host or join). */
  retry(): Promise<void> {
    const a = this.lastAction;
    if (!a || a.kind === "resume") {
      this.reset();
      return Promise.resolve();
    }
    return a.kind === "host" ? this.host(this.name) : this.join(a.code, this.name);
  }

  /** Start the game at once (the host). The element's Start button uses `startGame`, which honours the countdown. */
  async start(): Promise<void> {
    if (!this.lobby || !this.isHost || this.state === "playing") return;
    await this.lobby.start();
  }

  async leave(): Promise<void> {
    const l = this.lobby;
    this.detach();
    await l?.leave();
    this.reset();
  }

  /** Back to the start screen (after an error, or to cancel). */
  reset(): void {
    this.detach();
    this.state = "idle";
    this.overlay = null;
    this.error = null;
    this.menuError = null;
    this.onChange();
  }

  /** Send any JSON-able value to everyone else. */
  send(data: unknown): void {
    if (!this.lobby) return;
    this.lobby.broadcast(toBytes({ k: "m", d: data === undefined ? null : data }));
  }

  /**
   * ui_cancel and the Back buttons: one screen back. Returns false when there was nothing to go back from (the start screen,
   * a game running).
   */
  back(): boolean {
    switch (this.screen) {
      case "settings":
      case "browse":
        this.browseGen++;
        this.overlay = null;
        this.onChange();
        return true;
      case "error":
      case "connecting":
        this.reset();
        return true;
      case "lobby":
        void this.leave();
        return true;
      default:
        return false;
    }
  }

  // ---- the lobby ---------------------------------------------------------------------------------------------------

  /** Roster rows (a plain peer list against a host with no room layer). */
  roster(): RosterRow[] {
    const l = this.lobby;
    if (!l) return [];
    const active = this.roomActive;
    return l.room.entries.map((e) => {
      const me = e.id === l.localPeerId;
      return {
        id: e.id,
        name: e.name,
        me,
        host: e.id === l.hostPeerId,
        ready: active && e.ready && e.role === "player",
        spectator: e.role === "spectator",
        reconnecting: e.status === "reconnecting",
        pingMs: me ? 0 : !l.isHost && e.id === l.hostPeerId ? l.rtt : 0,
        canKick: active && l.isHost && !me,
      };
    });
  }

  /** "Players 2/4", or "Players 2" when the lobby has no cap or the host is old. */
  playersHeader(): string {
    const l = this.lobby;
    if (!l) return "";
    if (!this.roomActive) return this.texts.t("players_header_plain", l.room.entries.length);
    const cap = l.room.settings.maxPlayers;
    const n = l.room.players.length;
    return cap > 0 ? this.texts.t("players_header", n, cap) : this.texts.t("players_header_plain", n);
  }

  /** The marks of a row as one line ("Host, Ready"). */
  rowMarks(row: RosterRow): string {
    const marks: string[] = [];
    if (row.host) marks.push(this.texts.t("mark_host"));
    if (row.spectator) marks.push(this.texts.t("mark_spectator"));
    if (row.ready) marks.push(this.texts.t("mark_ready"));
    if (row.reconnecting) marks.push(this.texts.t("mark_reconnecting"));
    return marks.join(", ");
  }

  /** The code the lobby screen shows: a direct host's grouped code, else the lobby-server code as "7HQ 4K2". */
  codeText(): string {
    const l = this.lobby;
    if (!l) return "";
    if (this.direct && l.joinCode) return l.joinCode;
    return formatCode(l.code);
  }

  /** `Join my game in <title>: code 7HQ 4K2` (no title: `Join my game: code 7HQ 4K2`), then the invite link when the page has a base. */
  inviteText(): string {
    const l = this.lobby;
    if (!l) return "";
    const title = this.blueprint?.game.title ?? "";
    const code = this.codeText();
    let text = title ? this.texts.t("invite_sentence", title, code) : this.texts.t("invite_sentence_untitled", code);
    const link = this.inviteLink();
    if (link) text += " " + link;
    return text;
  }

  /** The link that opens the page into this lobby, or "" (a direct lobby, or no usable base). */
  inviteLink(): string {
    const l = this.lobby;
    if (!l || this.direct || !normalizeCode(l.code)) return "";
    try {
      return shareUrl(l.code, this.opts.inviteBase?.(), this.opts.inviteParam?.() ?? "join");
    } catch {
      return "";
    }
  }

  get counting(): boolean {
    return !!this.lobby && this.lobby.room.countdown !== null;
  }

  /** "Starting in 3...", or "". */
  countdownText(): string {
    const cd = this.lobby?.room.countdown;
    return cd ? this.texts.t("countdown", Math.ceil(cd.remaining() / 1000)) : "";
  }

  get meReady(): boolean {
    return !!this.lobby?.room.me?.ready;
  }
  get meIsPlayer(): boolean {
    return (this.lobby?.room.me?.role ?? "player") === "player";
  }
  /** The host's Start is offered: the lobby is up, no game running, no countdown, and at least one other player is here. */
  get canStart(): boolean {
    return this.isHost && this.state === "lobby" && !this.counting && this.players.length >= 2;
  }

  toggleReady(): void {
    if (this.roomActive) this.attempt(() => this.lobby!.room.toggleReady());
  }

  /** Host: start. With the room layer: the countdown, then everyone's phase changes. An old host (no room layer) starts at once. */
  startGame(): void {
    const l = this.lobby;
    if (!l || !l.isHost || this.state === "playing") return;
    if (this.roomActive) this.attempt(() => l.room.start());
    else void l.start().catch(() => {});
  }

  cancelCountdown(): void {
    if (this.roomActive && this.lobby!.isHost) this.attempt(() => this.lobby!.room.cancelCountdown());
  }

  /** Host: everyone back to the lobby after a game. */
  backToLobby(): void {
    if (this.roomActive && this.lobby!.isHost) this.attempt(() => this.lobby!.room.backToLobby());
  }

  kick(peerId: number, reason = ""): void {
    if (this.roomActive && this.lobby!.isHost) this.attempt(() => this.lobby!.room.kick(peerId, reason.trim() ? { reason } : {}));
  }

  ban(peerId: number, reason = ""): void {
    if (this.roomActive && this.lobby!.isHost) this.attempt(() => this.lobby!.room.ban(peerId, reason.trim() ? { reason } : {}));
  }

  unban(key: string): void {
    const l = this.lobby;
    if (!l || !l.isHost) return;
    l.room.unban(key);
    this.onChange();
  }

  /** The ban list (the host's); the key is what `unban` takes. */
  banRows(): BanRow[] {
    const l = this.lobby;
    if (!l || !l.isHost) return [];
    return l.room.bans.list().map((e) => {
      const who = e.name ? e.name : this.texts.t("ban_unknown");
      const reason = e.reason ?? "";
      return { key: e.id ?? e.ip ?? "", text: reason ? this.texts.t("ban_row_reason", who, reason) : who };
    });
  }

  /** The settings the room layer lets the host change; null without the room layer. */
  lobbySettings(): LobbySettingsView | null {
    const l = this.lobby;
    if (!l || !this.roomActive) return null;
    const s = l.room.settings;
    return { autoStart: s.autoStart, minPlayers: s.minPlayers, countdownSeconds: Math.round(s.countdownMs / 1000), lateJoin: s.lateJoin !== "refuse" };
  }

  /** Host: changes `auto_start` ("off", "all_ready", "players"), `min_players`, `countdown_seconds` or `late_join` (boolean). */
  setLobbySetting(key: string, value: unknown): void {
    const l = this.lobby;
    if (!l || !this.roomActive || !l.isHost) return;
    const num = (lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(Number(value) || 0)));
    switch (key) {
      case "auto_start":
        this.attempt(() => l.room.configure({ autoStart: value === "all_ready" || value === "players" ? value : "off" }));
        break;
      case "min_players":
        this.attempt(() => l.room.configure({ minPlayers: num(1, Math.max(1, l.room.settings.maxPlayers)) }));
        break;
      case "countdown_seconds":
        this.attempt(() => l.room.configure({ countdownMs: num(0, 60) * 1000 }));
        break;
      case "late_join":
        this.attempt(() => l.room.configure({ lateJoin: value ? "allow" : "refuse" }));
        break;
    }
  }

  /** Host: let a player in (or refuse them). */
  approve(peerId: number, ok: boolean): void {
    const l = this.lobby;
    if (l && l.isHost) void l.approve(peerId, ok).catch(() => {});
    this.requests = this.requests.filter((r) => r.peerId !== peerId);
    this.onChange();
  }

  sendChat(text: string): void {
    const l = this.lobby;
    if (!l || !this.chatShown || !text.trim()) return;
    try {
      l.chat.send(text);
    } catch {
      /* chat switched off by the blueprint */
    }
  }

  // ---- copy and logs -------------------------------------------------------------------------------------------------

  private async copy(text: string): Promise<boolean> {
    if (!text || !this.opts.clipboard) return false;
    try {
      return !!(await this.opts.clipboard(text));
    } catch {
      return false;
    }
  }

  async copyCode(): Promise<boolean> {
    const ok = await this.copy(this.codeText());
    this.copyNote = ok ? this.texts.t("copied") : this.texts.t("copy_failed");
    this.onChange();
    return ok;
  }

  /** Copies the invite sentence (with the link when the page has a base). */
  async copyInvite(): Promise<boolean> {
    const ok = await this.copy(this.inviteText());
    this.copyNote = ok ? this.texts.t("copied") : this.texts.t("copy_failed");
    this.onChange();
    return ok;
  }

  /** Copies only the invite link (the element's old "Copy invite link"). */
  async copyLink(): Promise<boolean> {
    const ok = await this.copy(this.inviteLink());
    this.copyNote = ok ? this.texts.t("link_copied") : this.texts.t("copy_failed");
    this.onChange();
    return ok;
  }

  async copyLogs(): Promise<void> {
    const log = this.netLog();
    const ok = !!log && (await this.copy(log.export()));
    this.logNote = ok ? this.texts.t("logs_copied") : this.texts.t("copy_failed");
    this.onChange();
  }

  /** Save logs: a file download in a browser. */
  saveLogs(): void {
    const log = this.netLog();
    let ok = false;
    try {
      if (log) {
        log.download();
        ok = true;
      }
    } catch {
      ok = false;
    }
    this.logNote = ok ? this.texts.t("logs_downloaded") : this.texts.t("logs_not_saved");
    this.onChange();
  }

  private netLog(): NetLog | undefined {
    return this.probeKit()?.netLog;
  }

  // ---- settings ------------------------------------------------------------------------------------------------------

  openSettings(): void {
    if (this.screen !== "start") return;
    this.settingsNote = "";
    this.relayNote = "";
    this.serverText = this.effectiveServer();
    this.overlay = "settings";
    this.onChange();
  }

  /** The lobby server in use: the page's own when it sets one, else the saved one. */
  effectiveServer(): string {
    return this.opts.pageServer?.() || this.settingsStore()?.effective().server || "";
  }

  /** True when the page sets its own lobby server (a saved one is then only a fallback). */
  get pageSetsServer(): boolean {
    return !!this.opts.pageServer?.();
  }

  /** "Relay in use: turn:host:3478 <hidden> <hidden>", or the plain sentence when there is none or it does not parse. */
  relayStatusText(): string {
    const s = this.settingsStore();
    if (!s) return this.texts.t("relay_none");
    if (s.relayStatus().invalid) return this.texts.t("relay_invalid");
    const masked = s.maskedRelay();
    return masked ? this.texts.t("relay_set", masked) : this.texts.t("relay_none");
  }

  /** Saves a pasted relay line. The line is never shown again, only its masked form. */
  saveRelay(line: string): boolean {
    const s = this.settingsStore();
    if (!line.trim() || !s) return false;
    const r = s.save({ relay: line });
    this.relayNote = this.texts.t(r.ok ? "relay_saved" : "relay_bad_input");
    this.onChange();
    return r.ok;
  }

  clearRelay(): void {
    this.settingsStore()?.save({ relay: "" });
    this.relayNote = this.texts.t("relay_cleared");
    this.onChange();
  }

  saveServer(text: string): boolean {
    const s = this.settingsStore();
    const r = s ? s.save({ server: text }) : { ok: false };
    if (r.ok) this.serverText = this.effectiveServer();
    this.settingsNote = this.texts.t(r.ok ? "server_saved" : "server_bad_input");
    this.onChange();
    return r.ok;
  }

  /** Runs the connection check and keeps its one-line verdict and three facts. */
  async runCheck(): Promise<void> {
    if (this.checkRunning) return;
    this.checkRunning = true;
    this.checkVerdict = this.texts.t("check_running");
    this.checkVerdictId = "";
    this.checkFacts = [];
    this.onChange();
    let r: CheckResult | null = null;
    let failed = "";
    try {
      const entry = this.settingsStore()?.relayStatus().entry;
      const o: CheckOptions = entry ? { iceServers: [entry] } : {};
      const kit = this.probeKit();
      if (this.opts.checkRunner) r = await this.opts.checkRunner(o);
      else if (kit?.checkConnection) r = await kit.checkConnection(o);
      else throw new OneLobbyError("unsupported");
    } catch (e) {
      failed = describeError(e).message;
    }
    this.checkRunning = false;
    if (!r) {
      this.checkVerdict = failed;
      this.checkFacts = [];
    } else {
      const t = this.texts;
      const fact = (prefix: string, value: string, fallback: string) => t.t(t.has(prefix + value) ? prefix + value : fallback);
      this.checkVerdict = r.message;
      this.checkVerdictId = r.verdict ?? "";
      const relay = r.relay ?? "none";
      this.checkFacts = [
        t.t("check_udp", fact("udp_", r.udp ?? "unknown", "udp_unknown")),
        t.t("check_nat", fact("nat_", r.natType ?? "unknown", "nat_unknown")),
        t.t("check_relay", relay !== "none" ? fact("relay_", relay, "relay_unknown") : t.t("relay_none_fact")),
      ];
    }
    this.onChange();
  }

  // ---- browse --------------------------------------------------------------------------------------------------------

  async openBrowse(): Promise<void> {
    if (this.screen !== "start" || !this.canBrowse) return;
    this.overlay = "browse";
    await this.refreshBrowse();
  }

  async refreshBrowse(): Promise<void> {
    const mine = ++this.browseGen;
    this.browseStatus = this.texts.t("browse_loading");
    this.browseItems = [];
    this.onChange();
    let items: LobbySummary[] = [];
    let failed = "";
    try {
      const kit = this.opts.makeKit(this.name);
      this.kit = kit;
      if (!kit.list) throw new OneLobbyError("listing_disabled");
      items = await kit.list();
    } catch (e) {
      failed = describeError(e).message;
    }
    if (mine !== this.browseGen || this.overlay !== "browse") return;
    this.browseStatus = failed || (items.length > 0 ? "" : this.texts.t("browse_empty"));
    this.browseItems = items;
    this.onChange();
  }

  /** The text of a browse row: "Name (Host) 2/4". */
  browseRowText(s: LobbySummary): string {
    return this.texts.t("browse_row", s.name, s.hostName, s.players, s.maxPlayers);
  }

  /** Joins a listed lobby. */
  async joinListed(code: string, name: string): Promise<void> {
    if (this.overlay !== "browse") return;
    this.browseGen++;
    this.overlay = null;
    this.setJoinText(code);
    await this.join(this.joinText, name);
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  private settingsStore(): PlayerSettings | null {
    return this.opts.settings?.() ?? this.probeKit()?.settings ?? null;
  }

  /** The newest kit, or one made now for the settings and logs screens (null when the page cannot make one). */
  private probeKit(): KitLike | null {
    if (this.kit) return this.kit;
    try {
      this.kit = this.opts.makeKit(this.name);
    } catch {
      this.kit = null;
    }
    return this.kit;
  }

  /** Runs a room call; a refusal becomes the plain sentence under the lobby. */
  private attempt(call: () => void): void {
    this.note = "";
    try {
      call();
    } catch (e) {
      const d = describeError(e);
      this.note = d.message + (d.hint ? " " + d.hint : "");
    }
    this.onChange();
  }

  private async run(name: string, go: (kit: KitLike) => Promise<Lobby | null>, quiet = false, intent: "server" | "direct" = "server"): Promise<void> {
    this.detach();
    const gen = ++this.gen;
    this.name = (name || "").trim().slice(0, 24); // empty: other players see "Player N"
    this.state = "connecting";
    this.overlay = null;
    this.error = null;
    this.menuError = null;
    this.removal = null;
    this.startNote = "";
    this.note = "";
    this.onChange();
    let lobby: Lobby | null;
    try {
      const kit = this.opts.makeKit(this.name, intent);
      this.kit = kit;
      lobby = await go(kit);
    } catch (e) {
      if (gen !== this.gen) return;
      if (quiet) this.reset();
      else this.fail(e);
      return;
    }
    if (gen !== this.gen) {
      void lobby?.leave();
      return;
    }
    this.direct = intent === "direct";
    if (lobby) this.attach(lobby);
    else this.reset();
  }

  private attach(l: Lobby): void {
    this.lobby = l;
    // A joiner takes the host's values; a host keeps anything the page set up front (defaults).
    if (!l.isHost) this.shared.values.clear();
    this.seq = 0;
    this.chatLines = [];
    this.requests = [];
    this.removal = null;
    this.state = l.phase === "in_game" ? "playing" : "lobby";
    this.linking = !l.isHost;
    const on = this.unsub;
    on.push(l.on("ready", () => this.linked()));
    on.push(l.on("peerJoined", (p) => {
      this.onEvent("player-joined", { player: this.toPlayer(p) });
      this.onChange();
    }));
    on.push(l.on("peerLeft", (p, reason) => {
      this.onEvent("player-left", { player: this.toPlayer(p), reason });
      this.onChange();
    }));
    on.push(l.on("peerReady", (p) => {
      if (l.isHost && p.peerId !== l.localPeerId) l.send(p.peerId, toBytes({ k: "SS", all: this.shared.all(), q: this.seq }));
    }));
    on.push(l.on("hostChanged", () => this.onChange()));
    on.push(l.on("phase", (ph) => {
      if (ph === "in_game" && this.state !== "playing") {
        this.state = "playing";
        this.onChange();
        this.onEvent("start", {});
      } else if (ph === "lobby" && this.state === "playing") {
        this.state = "lobby";
        this.note = "";
        this.onChange();
        this.onEvent("lobby-return", {});
      }
    }));
    on.push(l.on("message", (from, bytes) => this.onRaw(from, bytes)));
    on.push(l.on("sessionEnded", (reason) => {
      if (this.lobby !== l) return;
      if (reason === "left") return;
      this.fail(new OneLobbyError(reason), true);
    }));
    // The room layer: anything that changes a roster row, the countdown, the settings or the ban list draws again.
    const r = l.room;
    for (const ev of ["changed", "bansChanged", "supported", "unsupported", "countdown", "countdownCancelled", "stateChanged", "settingsChanged"] as const) {
      on.push(r.on(ev, () => this.onChange()));
    }
    on.push(r.on("removed", (info) => {
      this.removal = info;
      this.onEvent("removed", { code: info.code, reason: info.reason, ban: info.ban });
    }));
    on.push(l.on("joinRequested", (peer) => {
      this.requests = [...this.requests, { peerId: peer.peerId, name: peer.name }];
      this.onChange();
    }));
    on.push(l.on("peerRenamed", () => this.onChange()));
    const lines = (list: readonly { peerId: number; text: string }[]): ChatLine[] =>
      list.slice(-CHAT_KEEP).map((m) => ({ peerId: m.peerId, name: l.room.player(m.peerId)?.name ?? l.peer(m.peerId)?.name ?? "", text: m.text }));
    this.chatLines = lines(l.chat.history);
    on.push(l.chat.on("message", (m) => {
      this.chatLines = lines([...this.chatLines, m]);
      this.onEvent("chat", { from: this.playerById(m.peerId), text: m.text });
      this.onChange();
    }));
    on.push(l.chat.on("history", (h) => {
      this.chatLines = lines(h);
      this.onChange();
    }));
    // A joiner that cannot reach the host: the kit gives up after its readyTimeoutMs, leaves, and ends the session
    // with "ice_failed", which lands in the sessionEnded handler above.
    l.ready.then(() => { if (this.lobby === l) this.linked(); }, () => {});
    this.onChange();
    if (this.state === "playing" && !this.linking) this.onEvent("start", {});
  }

  private linked(): void {
    if (!this.linking) return;
    this.linking = false;
    this.onChange();
    if (this.state === "playing") this.onEvent("start", {});
  }

  private detach(): void {
    this.gen++;
    for (const u of this.unsub.splice(0)) u();
    this.lobby = null;
    this.linking = false;
  }

  /** `ended`: a lobby that was up has ended (sessionEnded), as opposed to a Host or Join that failed. */
  private fail(e: unknown, ended = false): void {
    const l = this.lobby;
    const removal = l ? this.removal ?? l.removal : null;
    this.detach();
    if (l) void l.leave();
    this.state = "error";
    this.overlay = null;
    this.error = describeError(e);
    this.menuError = this.menuErrorFor(this.error, removal, ended);
    this.logNote = "";
    this.onChange();
    this.onEvent("error", this.error);
  }

  /** The screen's title, sentence, hint and code: a kick or ban shows the host's reason (or the default sentence of the code). */
  private menuErrorFor(d: FriendlyError, removal: RemovalInfo | null, ended: boolean): MenuError {
    const t = this.texts;
    if (removal) {
      const code = removal.code || "kicked";
      const banned = removal.ban || code === "banned";
      const base = describeError(code);
      return {
        title: t.t(banned ? "banned_title" : "removed_title"),
        message: removal.reason || base.message,
        hint: base.hint ?? "",
        code,
        removed: true,
        ban: removal.ban,
        reason: removal.reason,
      };
    }
    if (ended && d.code === "host_left")
      return { title: t.t("ended_title"), message: t.t("host_left"), hint: t.t("host_left_hint"), code: d.code, removed: false, ban: false, reason: "" };
    return { title: t.t(ended ? "ended_title" : "error_title"), message: d.message, hint: d.hint ?? "", code: d.code, removed: false, ban: false, reason: "" };
  }

  private playerById(id: number): Player | null {
    const l = this.lobby;
    if (!l || !id) return null;
    return this.toPlayer(l.peer(id), id);
  }

  private onRaw(from: number, bytes: Uint8Array): void {
    let w: Wire;
    try {
      w = JSON.parse(dec.decode(bytes)) as Wire;
    } catch {
      return; // not ours
    }
    if (!w || typeof w !== "object") return;
    const l = this.lobby!;
    switch (w.k) {
      case "m":
        this.onEvent("message", { from: this.playerById(from), data: w.d });
        break;
      case "set":
      case "add":
        if (l.isHost) this.applyHost(w, from);
        break;
      case "S":
        if (!l.isHost && from === l.hostPeerId && !(w.q <= this.seq)) {
          this.seq = w.q;
          this.applyValue(w.key, w.v, w.by);
        }
        break;
      case "SS":
        if (!l.isHost && from === l.hostPeerId && w.all && typeof w.all === "object" && !(w.q < this.seq)) {
          this.seq = w.q;
          for (const k of [...this.shared.values.keys()]) if (!(k in w.all)) this.applyValue(k, null, 0);
          for (const [k, v] of Object.entries(w.all)) this.applyValue(k, v, 0);
        }
        break;
    }
  }

  /** @internal from SharedState */
  _sharedOp(op: Extract<Wire, { k: "set" } | { k: "add" }>): void {
    const l = this.lobby;
    if (!l) {
      // Not in a game yet: keep it local, so a page can set defaults up front.
      const v = op.k === "set" ? op.v : (Number(this.shared.values.get(op.key)) || 0) + op.n;
      this.applyValue(op.key, v, 0);
      return;
    }
    if (l.isHost) this.applyHost(op, l.localPeerId);
    else l.send(l.hostPeerId, toBytes(op));
  }

  private applyHost(op: Extract<Wire, { k: "set" } | { k: "add" }>, by: number): void {
    const l = this.lobby!;
    if (typeof op.key !== "string") return;
    const v = op.k === "set" ? op.v : (Number(this.shared.values.get(op.key)) || 0) + (Number(op.n) || 0);
    this.applyValue(op.key, v, by);
    l.broadcast(toBytes({ k: "S", key: op.key, v, by, q: ++this.seq }));
  }

  private applyValue(key: string, v: unknown, by: number): void {
    if (v === null) this.shared.values.delete(key);
    else this.shared.values.set(key, v);
    this.onEvent("shared-change", { key, value: v, from: this.playerById(by) });
  }
}
