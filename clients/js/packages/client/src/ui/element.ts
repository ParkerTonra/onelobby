/**
 * `<one-lobby>`: a drop-in lobby (host, join by code or invite link, player list, ready, start with a countdown, kick and ban,
 * host settings, join requests, chat, a settings screen and a lobby browser) for people who paste HTML rather than write code.
 * Zero dependencies; shadow DOM; themed with CSS custom properties; every control has a `part` name.
 *
 *   <one-lobby server="https://your-name.onrender.com" game="my-game" max-players="4">fallback text</one-lobby>
 *
 * Game API: el.send(data), el.shared.set/add/get, el.isHost, el.players, events message / player-joined /
 * player-left / start / error / shared-change / chat / removed / lobby-return (all bubble, `event.detail` carries the data).
 * The screens and their texts are in docs/recipes/menu.md ("Web").
 */
import { formatCode } from "../crockford.js";
import { OneLobby, type OneLobbyOptions } from "../onelobby.js";
import { OneLobbyError } from "../signaling.js";
import { parseBlueprint, type Blueprint } from "../blueprint.js";
import { LobbyController, type Player, type SharedState, type UiScreen, type UiState } from "./controller.js";
import { codeFromUrl } from "../friendly.js";
import { LOBBY_CSS } from "./styles.js";
import { lobbyServerUrl } from "./server-url.js";
import { PlayerSettings } from "../settings.js";
import { localStore, memoryStore } from "../storage.js";

export const LOBBY_TAG = "one-lobby";
/** Where versions before the settings store kept the name; read once and moved into `kit.settings` (spec/settings.md). */
const NAME_KEY = "onelobby-name";
const gameOf = (el: Element) => el.getAttribute("game") || "onelobby-drop-in";

/**
 * Every visible string carries `data-t` (text) or `data-ph` (placeholder): the key of the text table. The element fills them
 * on every draw, so a reworded table (`el.texts = {...}`) shows at once.
 */
const TEMPLATE = `
<div class="card" part="card">
  <h2 class="title" id="title" part="title" hidden></h2>
  <p class="status" id="status" part="status" role="status" aria-live="polite"></p>
  <p class="hint" id="hint" part="hint" hidden></p>

  <div id="v-idle" class="view">
    <p class="hint" id="startCheck" part="start-check" role="status" hidden></p>
    <div class="row">
      <label id="nameLabel" part="name-label"><span data-t="name_label"></span>
        <input id="name" part="name-input" maxlength="24" autocomplete="nickname" data-ph="name_placeholder">
      </label>
    </div>
    <div class="row" style="margin-top:.75rem">
      <button id="host" part="host-button" class="primary" type="button" data-t="host"></button>
    </div>
    <p class="or" data-t="join_or"></p>
    <form id="joinForm" class="row" part="join-form">
      <label><span data-t="join_label"></span>
        <input id="code" part="join-input" maxlength="200" autocomplete="off" autocapitalize="characters" spellcheck="false" data-ph="join_placeholder">
      </label>
      <label id="passwordLabel" part="password-label"><span data-t="password_label"></span>
        <input id="password" part="password-input" type="password" maxlength="64" autocomplete="off" data-ph="password_placeholder">
      </label>
      <button id="join" part="join-button" type="submit" data-t="join"></button>
    </form>
    <div class="row" style="margin-top:.75rem">
      <button id="browse" part="browse-button" type="button" data-t="browse"></button>
      <button id="settings" part="settings-button" type="button" data-t="settings"></button>
    </div>
  </div>

  <div id="v-busy" class="view" hidden>
    <button id="cancel" part="cancel-button" type="button" data-t="cancel"></button>
  </div>

  <div id="v-lobby" class="view" hidden>
    <div class="codebox" part="codebox">
      <h3 data-t="code_caption"></h3>
      <span class="code" id="codeText" part="code"></span>
      <div class="row">
        <button id="copyCode" part="copy-code-button" type="button" data-t="copy_code"></button>
        <button id="copyInvite" part="copy-invite-button" type="button" data-t="copy_invite"></button>
        <button id="copyLink" part="copy-link-button" type="button" data-t="copy_link"></button>
      </div>
      <span class="sr" id="copied" aria-live="polite"></span>
    </div>
    <p class="countdown" id="countdown" part="countdown" role="status" hidden></p>
    <h3 id="playersTitle" part="players-title" style="margin-top:.75rem"></h3>
    <ul id="players" part="roster" aria-labelledby="playersTitle"></ul>
    <label id="reasonLabel" part="reason-label" hidden><span class="sr" data-t="reason_placeholder"></span>
      <input id="reason" part="reason-input" maxlength="120" autocomplete="off" data-ph="reason_placeholder">
    </label>
    <div id="requestsBox" hidden>
      <h3 data-t="requests_header"></h3>
      <ul id="requests" part="requests"></ul>
    </div>
    <p class="hint" id="plainNote" part="plain-note" data-t="plain_list_note" hidden></p>
    <p class="hint" id="note" part="note" role="status" hidden></p>
    <div class="bar" style="margin-top:.75rem">
      <button id="ready" part="ready-button" type="button" aria-pressed="false" hidden></button>
      <button id="start" part="start-button" class="primary" type="button" data-t="start"></button>
      <button id="cancelStart" part="cancel-start-button" type="button" data-t="cancel_countdown" hidden></button>
      <button id="backToLobby" part="back-to-lobby-button" type="button" data-t="back_to_lobby" hidden></button>
      <button id="leave" part="leave-button" type="button" data-t="leave"></button>
    </div>
    <details id="settingsBox" part="lobby-settings" class="box" hidden>
      <summary data-t="lobby_settings"></summary>
      <div class="fields">
        <label><span data-t="setting_auto_start"></span>
          <select id="setAuto" part="setting-input">
            <option value="off" data-t="auto_start_off"></option>
            <option value="all_ready" data-t="auto_start_all_ready"></option>
            <option value="players" data-t="auto_start_players"></option>
          </select>
        </label>
        <label><span data-t="setting_min_players"></span><input id="setMin" part="setting-input" type="number" min="1" max="64" step="1" inputmode="numeric"></label>
        <label><span data-t="setting_countdown"></span><input id="setCountdown" part="setting-input" type="number" min="0" max="60" step="1" inputmode="numeric"></label>
        <label class="check"><input id="setLate" part="setting-input" type="checkbox"><span data-t="setting_late_join"></span></label>
      </div>
    </details>
    <div id="bansBox" hidden>
      <h3 data-t="bans_header"></h3>
      <ul id="bans" part="bans"></ul>
    </div>
    <div id="chatBox" class="box" part="chat" hidden>
      <h3 data-t="chat_label"></h3>
      <ul id="chatLog" part="chat-log" role="log" aria-live="polite" tabindex="0"></ul>
      <form id="chatForm" class="row" part="chat-form">
        <label class="grow"><span class="sr" data-t="chat_placeholder"></span><input id="chatInput" part="chat-input" maxlength="256" autocomplete="off" data-ph="chat_placeholder"></label>
        <button id="chatSend" part="chat-send-button" type="submit" data-t="chat_send"></button>
      </form>
    </div>
  </div>

  <div id="v-error" class="view" hidden>
    <p class="hint" id="errCode" part="error-code"></p>
    <div class="row">
      <button id="retry" part="retry-button" class="primary" type="button" data-t="retry"></button>
      <button id="back" part="back-button" type="button" data-t="back"></button>
    </div>
    <div class="row" style="margin-top:.5rem" id="logRow">
      <button id="copyLogs" part="copy-logs-button" type="button" data-t="copy_logs"></button>
      <button id="saveLogs" part="save-logs-button" type="button" data-t="save_logs"></button>
    </div>
    <p class="hint" id="logNote" part="log-note" role="status"></p>
  </div>

  <div id="v-settings" class="view" hidden>
    <form id="relayForm" class="box" part="relay-form">
      <label><span data-t="relay_label"></span>
        <input id="relay" part="relay-input" type="password" autocomplete="off" spellcheck="false" data-ph="relay_placeholder">
      </label>
      <p class="hint" id="relayStatus" part="relay-status"></p>
      <div class="row">
        <button id="saveRelay" part="save-relay-button" type="submit" data-t="relay_save"></button>
        <button id="clearRelay" part="clear-relay-button" type="button" data-t="relay_clear"></button>
      </div>
      <p class="hint" id="relayNote" part="relay-note" role="status"></p>
    </form>
    <form id="serverForm" class="box" part="server-form">
      <label><span data-t="server_label"></span>
        <input id="server" part="server-input" autocomplete="off" spellcheck="false" data-ph="server_placeholder">
      </label>
      <div class="row"><button id="saveServer" part="save-server-button" type="submit" data-t="server_save"></button></div>
      <p class="hint" id="serverNote" part="server-note" role="status"></p>
    </form>
    <div class="box" id="checkBox" part="check">
      <div class="row"><button id="check" part="check-button" type="button" data-t="check"></button></div>
      <p class="hint" id="checkVerdict" part="check-verdict" role="status"></p>
      <ul id="checkFacts" part="check-facts"></ul>
    </div>
    <div class="row">
      <button id="settingsCopyLogs" part="copy-logs-button" type="button" data-t="copy_logs"></button>
      <button id="settingsBack" part="back-button" type="button" data-t="back"></button>
    </div>
    <p class="hint" id="settingsLogNote" part="log-note" role="status"></p>
  </div>

  <div id="v-browse" class="view" hidden>
    <p class="hint" id="browseStatus" part="browse-status" role="status"></p>
    <ul id="browseList" part="browse-list"></ul>
    <div class="row">
      <button id="refresh" part="refresh-button" type="button" data-t="browse_refresh"></button>
      <button id="browseBack" part="back-button" type="button" data-t="back"></button>
    </div>
  </div>
</div>
`;
// No <slot>: text placed inside <one-lobby> is a fallback that shows only while the script has not loaded.

/** The element's public surface (for TypeScript users). */
export interface OneLobbyElement extends HTMLElement {
  readonly isHost: boolean;
  readonly players: Player[];
  readonly code: string | null;
  readonly state: UiState;
  /** The screen showing: `state`, or "settings" / "browse" on top of the start screen. */
  readonly screen: UiScreen;
  readonly shared: SharedState;
  /** Reword the menu: a table of text keys (see docs/recipes/menu.md); `null` puts the defaults back. */
  texts: Record<string, string> | null;
  /** The game's onelobby.json (parsed): it switches chat, join approval, names, the connection check and the title in the invite. */
  blueprint: unknown;
  send(data: unknown): void;
  host(): Promise<void>;
  join(code: string): Promise<void>;
  start(): Promise<void>;
  leave(): Promise<void>;
  /** One screen back (what Escape does); false when there is nothing to go back from. */
  back(): boolean;
}


function settingsFor(game: string): PlayerSettings {
  return new PlayerSettings(localStore() ?? memoryStore(), game, null);
}

/** The saved name; a name kept by an older version under its own key moves into the settings once. */
/** @internal */
export function readStored(game: string): string {
  const settings = settingsFor(game);
  const saved = settings.load().name;
  if (saved) return saved;
  try {
    const ls = localStore();
    const old = ls?.getItem(NAME_KEY);
    if (ls && old) {
      settings.save({ name: old });
      ls.removeItem(NAME_KEY);
      return settings.load().name;
    }
  } catch {
    /* unreadable: no name */
  }
  return "";
}
function store(game: string, name: string): void {
  settingsFor(game).save({ name });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

type Props = Record<string, string | undefined>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === "text") el.textContent = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
}

function makeClass(): CustomElementConstructor {
  class OneLobbyBox extends HTMLElement implements OneLobbyElement {
    static observedAttributes = ["name", "theme"];
    /** @internal exposed for debugging and tests */
    readonly _controller: LobbyController;
    private root: ShadowRoot;
    private $ = (id: string) => this.root.getElementById(id) as HTMLElement;
    private autoJoined = false;
    private flash: { id: string; text: string } | null = null;
    private flashTimer: ReturnType<typeof setTimeout> | undefined;
    private lastScreen: UiScreen | null = null;
    private bpJson: unknown = null;
    private bpParsed: Blueprint | undefined;

    constructor() {
      super();
      this.root = this.attachShadow({ mode: "open" });
      this.root.innerHTML = `<style>${LOBBY_CSS}</style>${TEMPLATE}`;
      this._controller = new LobbyController({
        makeKit: (name, intent) => this.makeKit(name, intent),
        maxPlayers: () => this.maxPlayers,
        settings: () => settingsFor(gameOf(this)),
        blueprint: () => this.parsedBlueprint(),
        serverKnown: () => this.serverKnown(),
        pageServer: () => lobbyServerUrl(this.getAttribute("server")) ?? "",
        approveJoins: () => this.hasAttribute("approve-joins"),
        inviteBase: () => this.getAttribute("invite-base") ?? undefined,
        inviteParam: () => this.getAttribute("invite-param") || "join",
        clipboard: copyText,
      });
      this._controller.onChange = () => this.render();
      this._controller.onEvent = (type, detail) => this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
      this.wire();
    }

    // ---- public API ----------------------------------------------------------------------------------------------

    get isHost(): boolean { return this._controller.isHost; }
    get players(): Player[] { return this._controller.players; }
    get code(): string | null { return this._controller.code; }
    get state(): UiState { return this._controller.state; }
    get screen(): UiScreen { return this._controller.screen; }
    get shared(): SharedState { return this._controller.shared; }
    get texts(): Record<string, string> | null {
      const o = this._controller.texts.overrides;
      return Object.keys(o).length ? o : null;
    }
    set texts(v: Record<string, string> | null) {
      this._controller.texts.override(v);
      if (this.isConnected) this.render();
    }
    get blueprint(): unknown { return this.bpJson; }
    set blueprint(v: unknown) {
      this.bpJson = v ?? null;
      this.bpParsed = undefined;
      if (this.isConnected) this.render();
    }
    send(data: unknown): void { this._controller.send(data); }
    host(): Promise<void> { return this._controller.host(this.playerName()); }
    join(code: string): Promise<void> { return this._controller.join(code, this.playerName()); }
    start(): Promise<void> { return this._controller.start(); }
    leave(): Promise<void> { return this._controller.leave(); }
    back(): boolean { return this._controller.back(); }

    // ---- lifecycle -----------------------------------------------------------------------------------------------

    connectedCallback(): void {
      const name = this.getAttribute("name");
      const input = this.$("name") as HTMLInputElement;
      if (!input.value) input.value = name ?? readStored(gameOf(this));
      this.$("nameLabel").hidden = !!name || !this._controller.namesAllowed;
      this.render();
      if (!this.autoJoined) {
        this.autoJoined = true;
        const code = codeFromUrl();
        const joinInput = this.$("code") as HTMLInputElement;
        if (code && this._controller.state === "idle") {
          joinInput.value = formatCode(code);
          if (input.value.trim()) void this.join(code);
          else {
            this._controller.noteInvited(false);
            input.focus();
          }
        } else if (!code && this._controller.state === "idle") {
          // the last code this player used, as the Join box's default
          const last = this._controller.defaults().lastCode;
          if (last && !joinInput.value) joinInput.value = last;
          if (lobbyServerUrl(this.getAttribute("server"))) {
            // A reload in the middle of a game: quietly take this tab's seat back (OneLobby rememberSeat).
            void this._controller.resume(input.value.trim());
          }
        }
      }
      // The check on open: once, when the start screen is first up (after a join link or a resume has had its say).
      queueMicrotask(() => {
        if (this.isConnected) void this._controller.startShown();
      });
    }

    disconnectedCallback(): void {
      // Leaving the page section (or the page) ends this player's session.
      if (this._controller.lobby) void this._controller.leave();
      clearTimeout(this.flashTimer);
    }

    attributeChangedCallback(attr: string): void {
      if (attr === "name" && this.isConnected) {
        const v = this.getAttribute("name");
        if (v) (this.$("name") as HTMLInputElement).value = v;
        this.$("nameLabel").hidden = !!v || !this._controller.namesAllowed;
      }
    }

    // ---- internals -----------------------------------------------------------------------------------------------

    private get maxPlayers(): number {
      const n = parseInt(this.getAttribute("max-players") ?? "", 10);
      return Number.isFinite(n) && n >= 2 ? Math.min(n, 250) : 8;
    }

    /** Seconds of countdown between Start and the game; 0 (the default) starts at once, as the element always did. */
    private get countdownSeconds(): number {
      const n = parseInt(this.getAttribute("countdown") ?? "", 10);
      return Number.isFinite(n) ? Math.min(60, Math.max(0, n)) : 0;
    }

    private parsedBlueprint(): Blueprint | undefined {
      if (!this.bpJson) return undefined;
      if (!this.bpParsed) {
        try {
          this.bpParsed = parseBlueprint(this.bpJson);
        } catch {
          return undefined;
        }
      }
      return this.bpParsed;
    }

    private savedServer(): string {
      return settingsFor(gameOf(this)).effective().server;
    }

    private serverKnown(): boolean {
      return !!lobbyServerUrl(this.getAttribute("server")) || !!this.savedServer() || !!this.parsedBlueprint()?.hosting.lobbyServer;
    }

    private playerName(): string {
      // empty is fine: other players then see "Player 2" and so on
      const v = (this.$("name") as HTMLInputElement).value.trim() || this.getAttribute("name") || "";
      if (!this.getAttribute("name") && v && this._controller.namesAllowed) store(gameOf(this), v);
      return v;
    }

    private makeKit(name: string, intent: "server" | "direct" = "server"): OneLobby {
      // missing, still the guide's placeholder, or not an address: say so instead of "couldn't reach the server"
      // (a server the player saved on the settings screen counts; a direct code needs none)
      const server = lobbyServerUrl(this.getAttribute("server"));
      const bp = this.parsedBlueprint();
      if (!server && intent !== "direct" && !this.savedServer() && !bp?.hosting.lobbyServer)
        throw new OneLobbyError("no_server", "the <one-lobby> tag has no usable server address");
      const advanced: NonNullable<OneLobbyOptions["advanced"]> = { createMic: null, createSink: null, voiceCodec: null };
      if (this.bpJson) {
        parseBlueprint(this.bpJson); // throws bad_config with the reason when the file is not valid
        return OneLobby.fromConfig(this.bpJson, { displayName: name, ...(server ? { lobbyServer: server } : {}), advanced });
      }
      return new OneLobby({
        gameId: gameOf(this),
        netVersion: this.getAttribute("version") || "1",
        // "" lets the kit use the lobby server the player saved on the settings screen
        lobbyServer: server ?? "",
        mode: "raw",
        displayName: name,
        // joiners give up (with a friendly "couldn't connect" and a retry button) after this long
        readyTimeoutMs: 15_000,
        // the start countdown is the host's to raise (lobby settings) or the page's (countdown="3"); 0 starts at once
        room: { countdownSeconds: this.countdownSeconds },
        advanced,
      });
    }

    private wire(): void {
      const c = this._controller;
      const on = (id: string, ev: string, fn: (e: Event) => void) => this.$(id).addEventListener(ev, fn);
      const val = (id: string) => (this.$(id) as HTMLInputElement).value;
      on("host", "click", () => {
        c.setPassword(val("password"));
        void this.host();
      });
      on("joinForm", "submit", (e) => {
        e.preventDefault();
        c.setPassword(val("password"));
        void this.join(val("code"));
      });
      on("code", "input", () => {
        const input = this.$("code") as HTMLInputElement;
        const tidy = c.setJoinText(input.value);
        if (tidy !== input.value) input.value = tidy;
        input.classList.toggle("plain", /[:/.?#=@]/.test(tidy));
      });
      on("browse", "click", () => void c.openBrowse());
      on("settings", "click", () => c.openSettings());
      on("cancel", "click", () => c.reset());
      on("start", "click", () => c.startGame());
      on("cancelStart", "click", () => c.cancelCountdown());
      on("backToLobby", "click", () => c.backToLobby());
      on("ready", "click", () => c.toggleReady());
      on("leave", "click", () => void this.leave());
      on("retry", "click", () => void c.retry());
      on("back", "click", () => c.reset());
      on("copyCode", "click", () => void this.copy("copyCode", () => c.copyCode(), "copied"));
      on("copyInvite", "click", () => void this.copy("copyInvite", () => c.copyInvite(), "copied"));
      on("copyLink", "click", () => void this.copy("copyLink", () => c.copyLink(), "link_copied"));
      on("copyLogs", "click", () => void c.copyLogs());
      on("saveLogs", "click", () => c.saveLogs());
      on("settingsCopyLogs", "click", () => void c.copyLogs());
      on("settingsBack", "click", () => c.back());
      on("browseBack", "click", () => c.back());
      on("refresh", "click", () => void c.refreshBrowse());
      on("chatForm", "submit", (e) => {
        e.preventDefault();
        const input = this.$("chatInput") as HTMLInputElement;
        c.sendChat(input.value);
        input.value = "";
      });
      on("relayForm", "submit", (e) => {
        e.preventDefault();
        const input = this.$("relay") as HTMLInputElement;
        if (c.saveRelay(input.value)) input.value = ""; // saved: the line is not shown again, only its masked form
      });
      on("clearRelay", "click", () => {
        (this.$("relay") as HTMLInputElement).value = "";
        c.clearRelay();
      });
      on("serverForm", "submit", (e) => {
        e.preventDefault();
        c.saveServer(val("server"));
      });
      on("check", "click", () => void c.runCheck());
      on("setAuto", "change", () => c.setLobbySetting("auto_start", val("setAuto")));
      on("setMin", "change", () => c.setLobbySetting("min_players", val("setMin")));
      on("setCountdown", "change", () => c.setLobbySetting("countdown_seconds", val("setCountdown")));
      on("setLate", "change", () => c.setLobbySetting("late_join", (this.$("setLate") as HTMLInputElement).checked));
      // one listener for the buttons that rows draw (kick, ban, unban, let in, refuse, browse join)
      this.root.addEventListener("click", (e) => {
        const b = (e.target as Element).closest?.("button[data-act]") as HTMLElement | null;
        if (!b) return;
        const id = Number(b.dataset.id);
        const reason = (this.$("reason") as HTMLInputElement).value;
        switch (b.dataset.act) {
          case "kick": c.kick(id, reason); break;
          case "ban": c.ban(id, reason); break;
          case "unban": c.unban(b.dataset.arg ?? ""); break;
          case "letin": c.approve(id, true); break;
          case "refuse": c.approve(id, false); break;
          case "joinlisted": void c.joinListed(b.dataset.arg ?? "", this.playerName()); break;
        }
      });
      // Escape goes back one screen (ui_cancel). A chat or reason line with text clears first.
      this.root.addEventListener("keydown", (e) => {
        const k = e as KeyboardEvent;
        if (k.key !== "Escape" || k.defaultPrevented || k.isComposing) return;
        const t = k.target as HTMLInputElement | null;
        if (t && (t.id === "chatInput" || t.id === "reason") && t.value) {
          t.value = "";
          k.preventDefault();
          return;
        }
        if (c.back()) k.preventDefault();
      });
    }

    private async copy(id: string, run: () => Promise<boolean>, doneKey: string): Promise<void> {
      const ok = await run();
      const text = ok ? this.t(doneKey) : this.t("copy_failed");
      this.flash = { id, text };
      this.$("copied").textContent = ok ? text : "";
      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => {
        this.flash = null;
        this.$("copied").textContent = "";
        this.render();
      }, 2000);
      this.render();
    }

    private t(key: string, ...args: unknown[]): string {
      return this._controller.texts.t(key, ...args);
    }

    /** Fills every `data-t` and `data-ph` from the text table (and the flash text of a copy button). */
    private applyTexts(): void {
      for (const el of this.root.querySelectorAll<HTMLElement>("[data-t]")) el.textContent = this.t(el.dataset.t!);
      for (const el of this.root.querySelectorAll<HTMLElement>("[data-ph]")) el.setAttribute("placeholder", this.t(el.dataset.ph!));
      if (this.flash) this.$(this.flash.id).textContent = this.flash.text;
    }

    /** True when keyboard focus is in this element, or nowhere (a button that was just hidden), so moving it is not stealing it. */
    private ownsFocus(): boolean {
      if (this.root.activeElement) return true;
      const a = document.activeElement;
      return !a || a === document.body || a === this;
    }

    private findByKey(key: string): HTMLElement | null {
      for (const el of this.root.querySelectorAll<HTMLElement>("[data-key]")) if (el.dataset.key === key) return el;
      return this.root.getElementById(key);
    }

    private render(): void {
      // A check that ends after the element left the page only fills the controller's lines: nothing is drawn on a detached element.
      if (!this.isConnected) return;
      const c = this._controller;
      const s = c.state;
      const screen = c.screen;
      const t = (k: string, ...a: unknown[]) => this.t(k, ...a);
      const changed = screen !== this.lastScreen;
      const active = this.root.activeElement as HTMLElement | null;
      const focusKey = active?.dataset?.key ?? active?.id ?? "";
      const mayMoveFocus = changed && this.lastScreen !== null && this.ownsFocus();

      this.applyTexts();
      const noServer = s === "error" && c.error?.code === "no_server";
      const status = this.$("status");
      status.textContent = noServer ? t("no_server_status") : screen === "start" && c.startNote ? c.startNote : c.statusText;
      status.classList.toggle("error", s === "error");
      status.hidden = screen === "settings" || screen === "browse";
      const hint = this.$("hint");
      const hintText = s === "error" ? (noServer ? t("no_server_hint") : c.menuError?.hint ?? c.error?.hint ?? "") : "";
      hint.textContent = hintText;
      hint.hidden = !hintText;
      const title = this.$("title");
      title.textContent = screen === "error" ? c.menuError?.title ?? "" : screen === "settings" ? t("settings_title") : screen === "browse" ? t("browse_title") : "";
      title.hidden = !title.textContent;

      this.$("v-idle").hidden = screen !== "start";
      this.$("v-busy").hidden = screen !== "connecting";
      this.$("v-lobby").hidden = screen !== "lobby" && screen !== "playing";
      this.$("v-error").hidden = screen !== "error";
      this.$("v-settings").hidden = screen !== "settings";
      this.$("v-browse").hidden = screen !== "browse";
      this.setAttribute("state", s);
      this.setAttribute("screen", screen);

      if (screen === "start") this.renderStart();
      if (screen === "lobby" || screen === "playing") this.renderLobby(screen === "playing");
      if (screen === "error") this.renderError();
      if (screen === "settings") this.renderSettings(changed);
      if (screen === "browse") this.renderBrowse();
      if (changed && screen !== "settings") (this.$("relay") as HTMLInputElement).value = "";

      this.lastScreen = screen;
      if (mayMoveFocus) this.focusFor(screen);
      else if (focusKey && !changed && !this.root.activeElement) {
        const again = this.findByKey(focusKey);
        if (again && !again.hidden) again.focus();
      }
    }

    /** A sensible control on each screen. */
    private focusFor(screen: UiScreen): void {
      const pick = (...ids: string[]) => {
        for (const id of ids) {
          const el = this.$(id);
          if (el && !el.hidden && !(el as HTMLButtonElement).disabled && !el.closest("[hidden]")) return el;
        }
        return null;
      };
      let el: HTMLElement | null = null;
      switch (screen) {
        case "start": el = (this.$("name") as HTMLInputElement).value ? pick("host") : pick("name", "host"); break;
        case "connecting": el = pick("cancel"); break;
        case "lobby": el = pick("ready", "start", "copyCode"); break;
        case "playing": el = pick("backToLobby", "leave"); break;
        case "error": el = pick("retry", "back"); break;
        case "settings": el = pick("relay"); break;
        case "browse": el = this.root.querySelector<HTMLElement>("#browseList button") ?? pick("refresh"); break;
      }
      el?.focus();
    }

    private renderStart(): void {
      const c = this._controller;
      this.$("nameLabel").hidden = !c.namesAllowed || !!this.getAttribute("name");
      (this.$("name") as HTMLInputElement).maxLength = c.maxNameLength;
      this.$("browse").hidden = !c.canBrowse;
      const line = c.startCheckLine; // the connection check's warning, only when it found one
      this.$("startCheck").textContent = line;
      this.$("startCheck").hidden = !line;
    }

    private renderLobby(playing: boolean): void {
      const c = this._controller;
      const t = (k: string, ...a: unknown[]) => this.t(k, ...a);
      const l = c.lobby;
      this.$("codeText").textContent = c.codeText();
      this.$("playersTitle").textContent = c.playersHeader();
      const host = c.isHost;
      const active = c.roomActive;
      const counting = c.counting;
      const cd = this.$("countdown");
      cd.textContent = counting ? c.countdownText() : "";
      cd.hidden = !counting;

      // roster
      const rows = c.roster();
      this.$("players").replaceChildren(
        ...rows.map((p) => {
          const li = h("li", { part: "roster-row", "data-peer": String(p.id) });
          li.append(h("span", { part: "roster-name", class: "name", text: p.name }));
          const marks: [string, string][] = [];
          if (p.host) marks.push(["host", t("mark_host")]);
          if (p.spectator) marks.push(["spectator", t("mark_spectator")]);
          if (p.ready) marks.push(["ready", t("mark_ready")]);
          if (p.reconnecting) marks.push(["reconnecting", t("mark_reconnecting")]);
          if (p.me) marks.push(["you", t("you")]);
          for (const [kind, text] of marks) li.append(h("span", { class: "tag", part: `mark mark-${kind}`, text }));
          if (p.pingMs > 0) li.append(h("span", { class: "tag", part: "ping", text: t("ping", p.pingMs) }));
          if (p.canKick) {
            li.append(
              h("button", { type: "button", part: "kick-button", "data-act": "kick", "data-id": String(p.id), "data-key": `kick${p.id}`, "aria-label": `${t("kick")} ${p.name}`, text: t("kick") }),
              h("button", { type: "button", part: "ban-button", "data-act": "ban", "data-id": String(p.id), "data-key": `ban${p.id}`, "aria-label": `${t("ban")} ${p.name}`, text: t("ban") }),
            );
          }
          return li;
        }),
      );
      this.$("reasonLabel").hidden = !(host && active && rows.some((p) => p.canKick));

      // join requests, ban list
      const reqs = host ? c.requests : [];
      this.$("requestsBox").hidden = reqs.length === 0;
      this.$("requests").replaceChildren(
        ...reqs.map((q) =>
          h("li", { part: "request-row" },
            h("span", { class: "name", text: q.name }),
            h("button", { type: "button", part: "let-in-button", class: "primary", "data-act": "letin", "data-id": String(q.peerId), "data-key": `letin${q.peerId}`, "aria-label": `${t("let_in")} ${q.name}`, text: t("let_in") }),
            h("button", { type: "button", part: "refuse-button", "data-act": "refuse", "data-id": String(q.peerId), "data-key": `refuse${q.peerId}`, "aria-label": `${t("refuse")} ${q.name}`, text: t("refuse") }),
          ),
        ),
      );
      const bans = host ? c.banRows() : [];
      this.$("bansBox").hidden = bans.length === 0;
      this.$("bans").replaceChildren(
        ...bans.map((b, i) =>
          h("li", { part: "ban-row" },
            h("span", { class: "name", text: b.text }),
            h("button", { type: "button", part: "unban-button", "data-act": "unban", "data-arg": b.key, "data-key": `unban${i}`, "aria-label": `${t("unban")} ${b.text}`, text: t("unban") }),
          ),
        ),
      );

      // buttons
      const ready = this.$("ready") as HTMLButtonElement;
      ready.hidden = !(active && c.meIsPlayer) || playing;
      ready.textContent = c.meReady ? t("not_ready") : t("ready");
      ready.setAttribute("aria-pressed", String(c.meReady));
      const start = this.$("start") as HTMLButtonElement;
      start.hidden = !host || playing || counting;
      start.disabled = c.players.length < 2;
      start.title = start.disabled ? t("start_need_players") : "";
      this.$("cancelStart").hidden = !(host && counting && active);
      this.$("backToLobby").hidden = !(host && playing && active);

      // host settings
      const ls = host && !playing ? c.lobbySettings() : null;
      this.$("settingsBox").hidden = !ls;
      if (ls) {
        const set = (id: string, fn: (el: HTMLInputElement) => void) => {
          const el = this.$(id) as HTMLInputElement;
          if (this.root.activeElement !== el) fn(el);
        };
        set("setAuto", (el) => (el.value = ls.autoStart));
        set("setMin", (el) => {
          el.value = String(ls.minPlayers);
          el.max = String(Math.max(1, l?.room.settings.maxPlayers ?? 64));
        });
        set("setCountdown", (el) => (el.value = String(ls.countdownSeconds)));
        set("setLate", (el) => (el.checked = ls.lateJoin));
      }

      // notes
      this.$("plainNote").hidden = !c.plainList;
      const note = this.$("note");
      note.textContent = c.note;
      note.hidden = !c.note;

      // chat
      const chat = this.$("chatBox");
      chat.hidden = !c.chatShown || !l;
      if (!chat.hidden) {
        const log = this.$("chatLog");
        const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
        log.replaceChildren(...c.chatLines.map((m) => h("li", { part: "chat-line", text: t("chat_line", m.name || `Player ${m.peerId}`, m.text) })));
        if (atEnd) log.scrollTop = log.scrollHeight;
      }
    }

    private renderError(): void {
      const c = this._controller;
      const e = c.menuError;
      const code = this.$("errCode");
      code.textContent = e?.code ? this.t("error_code", e.code) : "";
      code.hidden = !code.textContent;
      this.$("retry").hidden = !!e?.removed;
      const note = this.$("logNote");
      note.textContent = c.logNote;
      note.hidden = !c.logNote;
    }

    private renderSettings(opened: boolean): void {
      const c = this._controller;
      this.$("relayStatus").textContent = c.relayStatusText();
      const rn = this.$("relayNote");
      rn.textContent = c.relayNote;
      rn.hidden = !c.relayNote;
      if (opened) (this.$("server") as HTMLInputElement).value = c.serverText;
      const sn = this.$("serverNote");
      sn.textContent = [c.settingsNote, c.pageSetsServer ? this.t("server_page_note") : ""].filter(Boolean).join(" ");
      sn.hidden = !sn.textContent;
      this.$("checkBox").hidden = !c.connectionCheckShown;
      (this.$("check") as HTMLButtonElement).disabled = c.checkRunning;
      const cv = this.$("checkVerdict");
      cv.textContent = c.checkVerdict;
      cv.hidden = !c.checkVerdict;
      this.$("checkFacts").replaceChildren(...c.checkFacts.map((f) => h("li", { part: "check-fact", text: f })));
      const ln = this.$("settingsLogNote");
      ln.textContent = c.logNote;
      ln.hidden = !c.logNote;
    }

    private renderBrowse(): void {
      const c = this._controller;
      const st = this.$("browseStatus");
      st.textContent = c.browseStatus;
      st.hidden = !c.browseStatus;
      this.$("browseList").replaceChildren(
        ...c.browseItems.map((it, i) =>
          h("li", { part: "browse-row" },
            h("span", { class: "name", text: c.browseRowText(it) }),
            h("button", { type: "button", part: "browse-join-button", class: "primary", "data-act": "joinlisted", "data-arg": it.code, "data-key": `join${i}`, "aria-label": `${this.t("browse_join")} ${it.name}`, text: this.t("browse_join") }),
          ),
        ),
      );
    }
  }
  return OneLobbyBox;
}

/** Register `<one-lobby>` (safe to call more than once; a no-op outside a browser). */
export function defineLobbyElement(tag = LOBBY_TAG): void {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;
  customElements.define(tag, makeClass());
}

declare global {
  interface HTMLElementTagNameMap {
    "one-lobby": OneLobbyElement;
  }
}
