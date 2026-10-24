/**
 * `<keepalive-lobby>`: a drop-in lobby (host, join by code or invite link, player list, start) for people who paste
 * HTML rather than write code. Zero dependencies; shadow DOM; themed with CSS custom properties.
 *
 *   <keepalive-lobby server="wss://lobby.example.com" game="my-game" max-players="4"></keepalive-lobby>
 *
 * Game API: el.send(data), el.shared.set/add/get, el.isHost, el.players, events message / player-joined /
 * player-left / start / error / shared-change (all bubble, `event.detail` carries the data).
 */
import { formatCode } from "../crockford.js";
import { Keepalive } from "../keepalive.js";
import { KeepaliveError } from "../signaling.js";
import { LobbyController, type Player, type SharedState, type UiState } from "./controller.js";
import { codeFromUrl, shareUrl } from "../friendly.js";
import { LOBBY_CSS } from "./styles.js";

export const LOBBY_TAG = "keepalive-lobby";
const NAME_KEY = "keepalive-name";

const TEMPLATE = `
<div class="card" part="card">
  <p class="status" id="status" role="status" aria-live="polite"></p>
  <p class="hint" id="hint" hidden></p>

  <div id="v-idle" class="view">
    <div class="row">
      <label id="nameLabel">Your name
        <input id="name" maxlength="24" autocomplete="nickname" placeholder="e.g. Sam">
      </label>
    </div>
    <div class="row" style="margin-top:.75rem">
      <button id="host" class="primary" type="button">Host a game</button>
    </div>
    <p class="or">or join a friend</p>
    <form id="joinForm" class="row">
      <label>Game code
        <input id="code" maxlength="9" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC 123">
      </label>
      <button id="join" type="submit">Join</button>
    </form>
  </div>

  <div id="v-busy" class="view" hidden>
    <button id="cancel" type="button">Cancel</button>
  </div>

  <div id="v-lobby" class="view" hidden>
    <div class="codebox">
      <h3>Game code</h3>
      <span class="code" id="codeText"></span>
      <div class="row">
        <button id="copyCode" type="button">Copy code</button>
        <button id="copyLink" type="button">Copy invite link</button>
      </div>
      <span class="sr" id="copied" aria-live="polite"></span>
    </div>
    <h3 id="playersTitle" style="margin-top:.75rem">Players</h3>
    <ul id="players" aria-labelledby="playersTitle"></ul>
    <div class="bar" style="margin-top:.75rem">
      <button id="start" class="primary" type="button">Start</button>
      <button id="leave" type="button">Leave</button>
    </div>
  </div>

  <div id="v-error" class="view" hidden>
    <div class="row">
      <button id="retry" class="primary" type="button">Try again</button>
      <button id="back" type="button">Back</button>
    </div>
  </div>
</div>
<slot></slot>
`;

/** The element's public surface (for TypeScript users). */
export interface KeepaliveLobbyElement extends HTMLElement {
  readonly isHost: boolean;
  readonly players: Player[];
  readonly code: string | null;
  readonly state: UiState;
  readonly shared: SharedState;
  send(data: unknown): void;
  host(): Promise<void>;
  join(code: string): Promise<void>;
  start(): Promise<void>;
  leave(): Promise<void>;
}

function wsUrl(raw: string): string {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) return s.replace(/^http/i, "ws");
  if (!/^wss?:\/\//i.test(s)) return "wss://" + s;
  return s;
}

function readStored(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}
function store(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private window */
  }
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

function makeClass(): CustomElementConstructor {
  class KeepaliveLobby extends HTMLElement implements KeepaliveLobbyElement {
    static observedAttributes = ["name", "theme"];
    /** @internal exposed for debugging and tests */
    readonly _controller: LobbyController;
    private root: ShadowRoot;
    private $ = (id: string) => this.root.getElementById(id) as HTMLElement;
    private autoJoined = false;
    private copiedTimer: ReturnType<typeof setTimeout> | undefined;

    constructor() {
      super();
      this.root = this.attachShadow({ mode: "open" });
      this.root.innerHTML = `<style>${LOBBY_CSS}</style>${TEMPLATE}`;
      this._controller = new LobbyController({ makeKit: (name) => this.makeKit(name), maxPlayers: () => this.maxPlayers });
      this._controller.onChange = () => this.render();
      this._controller.onEvent = (type, detail) => this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
      this.wire();
    }

    // ---- public API ----------------------------------------------------------------------------------------------

    get isHost(): boolean { return this._controller.isHost; }
    get players(): Player[] { return this._controller.players; }
    get code(): string | null { return this._controller.code; }
    get state(): UiState { return this._controller.state; }
    get shared(): SharedState { return this._controller.shared; }
    send(data: unknown): void { this._controller.send(data); }
    host(): Promise<void> { return this._controller.host(this.playerName()); }
    join(code: string): Promise<void> { return this._controller.join(code, this.playerName()); }
    start(): Promise<void> { return this._controller.start(); }
    leave(): Promise<void> { return this._controller.leave(); }

    // ---- lifecycle -----------------------------------------------------------------------------------------------

    connectedCallback(): void {
      const name = this.getAttribute("name");
      const input = this.$("name") as HTMLInputElement;
      if (!input.value) input.value = name ?? readStored();
      this.$("nameLabel").hidden = !!name;
      this.render();
      if (!this.autoJoined) {
        this.autoJoined = true;
        const code = codeFromUrl();
        if (code && this._controller.state === "idle") {
          (this.$("code") as HTMLInputElement).value = formatCode(code);
          if (input.value.trim()) void this.join(code);
          else {
            this.$("status").textContent = "You're invited! Type your name, then press Join.";
            input.focus();
          }
        } else if (!code && this._controller.state === "idle" && this.getAttribute("server")) {
          // A reload in the middle of a game: quietly take this tab's seat back (Keepalive rememberSeat).
          void this._controller.resume(input.value.trim());
        }
      }
    }

    disconnectedCallback(): void {
      // Leaving the page section (or the page) ends this player's session.
      if (this._controller.lobby) void this._controller.leave();
    }

    attributeChangedCallback(attr: string): void {
      if (attr === "name" && this.isConnected) {
        const v = this.getAttribute("name");
        if (v) (this.$("name") as HTMLInputElement).value = v;
        this.$("nameLabel").hidden = !!v;
      }
    }

    // ---- internals -----------------------------------------------------------------------------------------------

    private get maxPlayers(): number {
      const n = parseInt(this.getAttribute("max-players") ?? "", 10);
      return Number.isFinite(n) && n >= 2 ? Math.min(n, 250) : 8;
    }

    private playerName(): string {
      // empty is fine: other players then see "Player 2" and so on
      const v = (this.$("name") as HTMLInputElement).value.trim() || this.getAttribute("name") || "";
      if (!this.getAttribute("name") && v) store(v);
      return v;
    }

    private makeKit(name: string): Keepalive {
      const server = this.getAttribute("server");
      if (!server) throw new KeepaliveError("no_server", "the <keepalive-lobby> tag has no server attribute");
      return new Keepalive({
        gameId: this.getAttribute("game") || "keepalive-drop-in",
        netVersion: this.getAttribute("version") || "1",
        lobbyServer: wsUrl(server),
        mode: "raw",
        displayName: name,
        // joiners give up (with a friendly "couldn't connect" and a retry button) after this long
        readyTimeoutMs: 15_000,
        advanced: { createMic: null, createSink: null, voiceCodec: null },
      });
    }

    private wire(): void {
      const on = (id: string, ev: string, fn: (e: Event) => void) => this.$(id).addEventListener(ev, fn);
      on("host", "click", () => void this.host());
      on("joinForm", "submit", (e) => {
        e.preventDefault();
        void this.join((this.$("code") as HTMLInputElement).value);
      });
      on("cancel", "click", () => this._controller.reset());
      on("start", "click", () => void this.start());
      on("leave", "click", () => void this.leave());
      on("retry", "click", () => void this._controller.retry());
      on("back", "click", () => this._controller.reset());
      on("copyCode", "click", () => void this.copy(this.code ?? "", "copyCode", "Copied!"));
      on("copyLink", "click", () => void this.copy(this.code ? shareUrl(this.code) : "", "copyLink", "Link copied!"));
    }

    private async copy(text: string, id: string, done: string): Promise<void> {
      if (!text) return;
      const ok = await copyText(text);
      const btn = this.$(id);
      const label = id === "copyCode" ? "Copy code" : "Copy invite link";
      btn.textContent = ok ? done : "Couldn't copy, select it by hand";
      this.$("copied").textContent = ok ? done : "";
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => {
        btn.textContent = label;
        this.$("copied").textContent = "";
      }, 2000);
    }

    private render(): void {
      const c = this._controller;
      const s = c.state;
      const status = this.$("status");
      status.textContent = s === "error" && c.error?.code === "no_server"
        ? "This page is missing its lobby server address."
        : c.statusText;
      status.classList.toggle("error", s === "error");
      const hint = this.$("hint");
      const hintText = s === "error"
        ? (c.error?.code === "no_server" ? 'Add server="…" to the <keepalive-lobby> tag. See the guide for where to get one.' : c.error?.hint ?? "")
        : "";
      hint.textContent = hintText;
      hint.hidden = !hintText;

      this.$("v-idle").hidden = s !== "idle";
      this.$("v-busy").hidden = s !== "connecting";
      this.$("v-lobby").hidden = s !== "lobby" && s !== "playing";
      this.$("v-error").hidden = s !== "error";
      this.setAttribute("state", s);

      if (s === "lobby" || s === "playing") {
        this.$("codeText").textContent = formatCode(c.code ?? "");
        const ul = this.$("players");
        ul.replaceChildren(
          ...c.players.map((p) => {
            const li = document.createElement("li");
            const nm = document.createElement("span");
            nm.textContent = p.name;
            li.append(nm);
            if (p.isHost) li.append(Object.assign(document.createElement("span"), { className: "tag", textContent: "host" }));
            if (p.isMe) li.append(Object.assign(document.createElement("span"), { className: "tag", textContent: "you" }));
            return li;
          }),
        );
        const start = this.$("start") as HTMLButtonElement;
        start.hidden = !c.isHost || s === "playing";
        start.disabled = c.players.length < 2;
        start.title = start.disabled ? "Wait for at least one more player" : "";
      }
    }
  }
  return KeepaliveLobby;
}

/** Register `<keepalive-lobby>` (safe to call more than once; a no-op outside a browser). */
export function defineLobbyElement(tag = LOBBY_TAG): void {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;
  customElements.define(tag, makeClass());
}

declare global {
  interface HTMLElementTagNameMap {
    "keepalive-lobby": KeepaliveLobbyElement;
  }
}
