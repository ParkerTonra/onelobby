// @vitest-environment happy-dom
/**
 * `<one-lobby>` itself, in a DOM emulation (happy-dom, a dev dependency of this package only): each screen draws its controls,
 * Escape goes back, the relay line is in no node after saving, texts can be reworded, every control has a part. The lobby runs
 * on the in-memory network (the element's kit is swapped for one on the rig): no socket, no server. It is not a browser: layout,
 * focus rings, real clipboard and real downloads are not covered.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { OneLobby, memoryStore } from "../src/internals.js";
import { checkVerdict } from "../src/diagnose.js";
import { LobbyController, type ControllerOptions } from "../src/ui/controller.js";
import "../src/ui/index.js";
import type { OneLobbyElement } from "../src/ui/element.js";
import type { Rig } from "./helpers.js";
import { flush, newRig, wait } from "./room-helpers.js";

type El = OneLobbyElement & { _controller: LobbyController };

function rigKit(r: Rig, label: string): (name: string) => OneLobby {
  const stores = { playerIdStore: memoryStore(), banStore: memoryStore(), settingsStore: memoryStore() };
  return (name) =>
    r.make(label, {
      mode: "raw",
      extra: {
        displayName: name,
        room: { countdownSeconds: 0 },
        advanced: { ...stores, env: null, socketFactory: r.server.socketFactory, linkFactory: r.net.factoryFor(label), clock: r.clock, wallClock: () => 1_700_000_000_000 + r.clock.now(), voiceCodec: null, createMic: null, createSink: null, storage: null },
      },
    });
}

/** Every element in this file gets a counted fake check runner: the check on open never reaches a socket here. */
let checkRuns = 0;
const fakeCheck = (kind: "cone" | "symmetric" = "cone", gate?: Promise<void>): ControllerOptions["checkRunner"] => async () => {
  checkRuns++;
  if (gate) await gate;
  const f = { udp: "ok", natType: kind, relay: "none" } as const;
  return { ...f, ...checkVerdict(f) };
};

function mount(attrs: Record<string, string> = {}, r?: Rig, label = "el", setup?: (el: El) => void): El {
  const el = document.createElement("one-lobby") as El;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  const opts = (el._controller as unknown as { opts: ControllerOptions }).opts;
  if (r) opts.makeKit = rigKit(r, label) as ControllerOptions["makeKit"];
  opts.checkRunner = fakeCheck();
  setup?.(el);
  document.body.append(el);
  return el;
}

const sr = (el: Element) => el.shadowRoot!;
const q = <T extends HTMLElement = HTMLElement>(el: Element, id: string) => sr(el).getElementById(id) as T;
const shown = (el: Element, id: string) => !q(el, id).hidden;
const key = (target: Element, k: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true }));

/** Everything a person or a script could read back from the element: markup, text, attributes, input values. */
function everything(el: Element): string {
  const parts = [sr(el).innerHTML, el.outerHTML, el.textContent ?? ""];
  for (const n of sr(el).querySelectorAll("input,textarea,select")) parts.push((n as HTMLInputElement).value);
  for (const n of sr(el).querySelectorAll("*")) for (const a of Array.from(n.attributes)) parts.push(a.name + "=" + a.value);
  return parts.join("\n");
}

beforeEach(() => {
  checkRuns = 0;
  document.body.replaceChildren();
  localStorage.clear();
});

describe("<one-lobby> screens", () => {
  it("the start screen draws its controls, and Browse only where a lobby server is known", () => {
    const el = mount({ server: "wss://lobby.mygame.test/ws", game: "t1" });
    expect(el.screen).toBe("start");
    for (const id of ["name", "host", "code", "password", "join", "browse", "settings"]) expect(q(el, id), id).toBeTruthy();
    expect(shown(el, "v-idle")).toBe(true);
    expect(shown(el, "browse")).toBe(true);
    expect(q(el, "host").textContent).toBe("Host a game");
    expect(q(el, "status").textContent).toBe("Host a game, or type a code to join one.");
    const bare = mount({ game: "t2" });
    expect(shown(bare, "browse")).toBe(false);
  });

  it("the saved last code is the Join box's default", () => {
    localStorage.setItem("onelobby.settings.t3", JSON.stringify({ v: 1, lastCode: "7HQ4K2", name: "Sam" }));
    const el = mount({ server: "wss://lobby.mygame.test/ws", game: "t3" });
    expect((q(el, "code") as HTMLInputElement).value).toBe("7HQ 4K2");
    expect((q(el, "name") as HTMLInputElement).value).toBe("Sam");
  });

  it("a missing server address still reads as before", async () => {
    const el = mount({ game: "t4" });
    await el.host();
    expect(el.state).toBe("error");
    expect(q(el, "status").textContent).toBe("This page is missing its lobby server address.");
    expect(shown(el, "v-error")).toBe(true);
    expect(shown(el, "retry")).toBe(true);
    expect(shown(el, "copyLogs") && shown(el, "saveLogs")).toBe(true);
    expect(q(el, "errCode").textContent).toBe("Code: no_server");
  });

  it("the settings screen: saves a relay line, never shows it again, and Escape goes back", () => {
    const el = mount({ server: "wss://lobby.mygame.test/ws", game: "t5" });
    (q(el, "settings") as HTMLButtonElement).click();
    expect(el.screen).toBe("settings");
    expect(shown(el, "v-settings") && !shown(el, "v-idle")).toBe(true);
    for (const id of ["relay", "saveRelay", "clearRelay", "server", "saveServer", "check", "settingsCopyLogs", "settingsBack"]) expect(q(el, id), id).toBeTruthy();
    const relay = q<HTMLInputElement>(el, "relay");
    relay.value = "turn:127.0.0.1:9 samuser sampass77";
    const events: string[] = [];
    for (const t of ["message", "player-joined", "player-left", "start", "error", "shared-change", "chat", "removed", "lobby-return"]) el.addEventListener(t, (e) => events.push(JSON.stringify((e as CustomEvent).detail)));
    q(el, "relayForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(relay.value).toBe("");
    expect(q(el, "relayStatus").textContent).toBe("Relay in use: turn:127.0.0.1:9 <hidden> <hidden>");
    expect(q(el, "relayNote").textContent).toBe("Relay saved.");
    expect(everything(el)).not.toMatch(/samuser|sampass77/);
    expect(events.join("")).not.toMatch(/samuser|sampass77/);
    expect(JSON.stringify(Array.from(sr(el).querySelectorAll("*")).map((n) => n.outerHTML))).not.toMatch(/sampass77/);
    key(relay, "Escape");
    expect(el.screen).toBe("start");
    expect(el.back()).toBe(false);
    // a relay line typed and left unsaved is gone when the screen is left
    (q(el, "settings") as HTMLButtonElement).click();
    q<HTMLInputElement>(el, "relay").value = "typed but not saved";
    (q(el, "settingsBack") as HTMLButtonElement).click();
    expect(q<HTMLInputElement>(el, "relay").value).toBe("");
  });

  it("the lobby: roster, ready, start, copy buttons, chat, host settings, kick with Escape and error screens", async () => {
    const r = newRig();
    const el = mount({ server: "wss://lobby.mygame.test/ws", game: "t6", "max-players": "4" }, r, "host");
    (q(el, "name") as HTMLInputElement).value = "Sam";
    await el.host();
    await flush();
    expect(el.screen).toBe("lobby");
    for (const id of ["codeText", "copyCode", "copyInvite", "copyLink", "players", "ready", "start", "leave", "chatForm", "chatInput", "settingsBox"]) expect(q(el, id), id).toBeTruthy();
    expect(shown(el, "v-lobby")).toBe(true);
    expect(q(el, "codeText").textContent).toMatch(/^[0-9A-Z]{3} [0-9A-Z]{3}$/);
    expect(q(el, "playersTitle").textContent).toBe("Players 1/4");
    expect(shown(el, "ready")).toBe(true);
    expect((q(el, "start") as HTMLButtonElement).disabled).toBe(true); // alone: Start waits for a second player
    expect(shown(el, "chatBox")).toBe(true);
    expect(shown(el, "settingsBox")).toBe(true);
    expect(q(el, "plainNote").hidden).toBe(true);

    // a second player, driven through its own controller on the same network
    const guest = new LobbyController({ makeKit: rigKit(r, "guest") as ControllerOptions["makeKit"], maxPlayers: 4 });
    await guest.join(el.code!, "Ann");
    await wait(r, 500);
    const rows = Array.from(sr(el).querySelectorAll("#players li"));
    expect(rows.map((x) => x.querySelector(".name")!.textContent)).toEqual(["Sam", "Ann"]);
    expect(rows[0].textContent).toContain("Host");
    expect(rows[0].textContent).toContain("(you)");
    expect(rows[1].querySelector("button[data-act=kick]")).toBeTruthy();
    expect(rows[1].querySelector("button[data-act=ban]")).toBeTruthy();
    expect(rows[0].querySelector("button")).toBeNull();
    expect((q(el, "start") as HTMLButtonElement).disabled).toBe(false);
    guest.toggleReady();
    await wait(r, 300);
    expect(sr(el).querySelector("#players li:nth-child(2)")!.textContent).toContain("Ready");

    // chat from the guest shows in the log; the host's own line goes out through the form
    guest.sendChat("hello host");
    await wait(r, 300);
    expect(q(el, "chatLog").textContent).toContain("Ann: hello host");
    const chat = q<HTMLInputElement>(el, "chatInput");
    chat.value = "hi Ann";
    q(el, "chatForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await wait(r, 300);
    expect(chat.value).toBe("");
    expect(guest.chatLines.map((m) => m.text)).toContain("hi Ann");

    // host settings
    (q(el, "setMin") as HTMLInputElement).value = "2";
    q(el, "setMin").dispatchEvent(new Event("change", { bubbles: true }));
    await wait(r, 300);
    expect(guest.lobbySettings()!.minPlayers).toBe(2);

    // Start: countdown 0 starts at once, the host's buttons change
    (q(el, "start") as HTMLButtonElement).click();
    await wait(r, 500);
    expect(el.state).toBe("playing");
    expect(shown(el, "backToLobby")).toBe(true);
    expect(shown(el, "start")).toBe(false);
    (q(el, "backToLobby") as HTMLButtonElement).click();
    await wait(r, 300);
    expect(el.state).toBe("lobby");

    // kick with a reason: the guest's controller lands on its removed screen
    q<HTMLInputElement>(el, "reason").value = "afk";
    (sr(el).querySelector("button[data-act=kick]") as HTMLButtonElement).click();
    await wait(r, 300);
    expect(guest.menuError).toMatchObject({ removed: true, message: "afk" });
    await wait(r, 100);
    await el.leave();
    expect(el.screen).toBe("start");
  });

  it("a kicked player's element shows the host's reason, the code and no Try again", async () => {
    const r = newRig();
    const host = new LobbyController({ makeKit: rigKit(r, "h") as ControllerOptions["makeKit"], maxPlayers: 4 });
    await host.host("Sam");
    await flush();
    const el = mount({ server: "wss://lobby.mygame.test/ws", game: "t7" }, r, "g");
    (q(el, "name") as HTMLInputElement).value = "Ann";
    await el.join(host.codeText());
    await wait(r, 500);
    expect(el.screen).toBe("lobby");
    host.kick(host.roster().find((x) => x.name === "Ann")!.id, "be nice");
    await wait(r, 300);
    expect(el.screen).toBe("error");
    expect(q(el, "title").textContent).toBe("You were removed");
    expect(q(el, "status").textContent).toBe("be nice");
    expect(q(el, "errCode").textContent).toBe("Code: kicked");
    expect(shown(el, "retry")).toBe(false);
    key(q(el, "back"), "Escape");
    expect(el.screen).toBe("start");
  });

  it("the browse screen lists lobbies with a Join button and Escape goes back", async () => {
    const r = newRig();
    const other = rigKit(r, "other")("Sam");
    const lobby = await other.host({ name: "Sam's game", maxPlayers: 4, visibility: "public" });
    const el = mount({ server: "wss://lobby.mygame.test/ws", game: "t8" }, r, "g");
    (q(el, "browse") as HTMLButtonElement).click();
    await wait(r, 200);
    expect(el.screen).toBe("browse");
    expect(q(el, "title").textContent).toBe("Games to join");
    expect(sr(el).querySelector("#browseList li .name")!.textContent).toBe("Sam's game (Sam) 1/4");
    expect(q(el, "refresh")).toBeTruthy();
    key(q(el, "refresh"), "Escape");
    expect(el.screen).toBe("start");
    (q(el, "browse") as HTMLButtonElement).click();
    await wait(r, 200);
    (sr(el).querySelector("#browseList button") as HTMLButtonElement).click();
    await wait(r, 500);
    expect(el.screen).toBe("lobby");
    await el.leave();
    await lobby.leave();
  });

  it("the texts can be reworded and every control has a part", () => {
    const el = mount({ server: "wss://lobby.mygame.test/ws", game: "t9" });
    el.texts = { host: "Create game", join_label: "Enter a code" };
    expect(q(el, "host").textContent).toBe("Create game");
    expect(sr(el).querySelector("label [data-t=join_label]")!.textContent).toBe("Enter a code");
    expect(el.texts).toEqual({ host: "Create game", join_label: "Enter a code" });
    el.texts = null;
    expect(q(el, "host").textContent).toBe("Host a game");
    const missing = Array.from(sr(el).querySelectorAll("button, input, select, ul, form")).filter((n) => !n.getAttribute("part")).map((n) => n.id || n.tagName);
    expect(missing).toEqual([]);
    expect(sr(el).querySelector("[part=card]")).toBeTruthy(); // the one part the element has always had
  });

  it("Enter in the Join box submits, and a pasted invite sentence is cleaned to its code on Join", async () => {
    const r = newRig();
    const host = new LobbyController({ makeKit: rigKit(r, "h") as ControllerOptions["makeKit"], maxPlayers: 4 });
    await host.host("Sam");
    await flush();
    const el = mount({ server: "wss://lobby.mygame.test/ws", game: "t10" }, r, "g");
    const code = q<HTMLInputElement>(el, "code");
    code.value = host.inviteText();
    code.dispatchEvent(new Event("input", { bubbles: true }));
    q(el, "joinForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await wait(r, 500);
    expect(el.screen).toBe("lobby");
  });
});

// ---- the connection check when the element opens (counted fakes only) ---------------------------------------------------------

describe("<one-lobby> connection check on open", () => {
  const opts = (el: El) => (el._controller as unknown as { opts: ControllerOptions }).opts;
  const line = (el: Element) => q(el, "startCheck");

  it("runs once when the element opens, says nothing while it runs and nothing when all is well; Settings is filled in", async () => {
    const el = mount({ game: "oo1" });
    await flush();
    expect(checkRuns).toBe(1);
    expect(shown(el, "startCheck")).toBe(false);
    el._controller.openSettings();
    expect(q(el, "checkVerdict").textContent).toBe("Direct connections: likely to work.");
    expect(q(el, "checkFacts").children.length).toBe(3);
    el._controller.back();
    await flush();
    expect(checkRuns).toBe(1); // back from Settings: not again
    q(el, "check").click();
    await flush();
    expect(checkRuns).toBe(2); // the button runs it on demand
  });

  it("a warning is one line on the start screen: the verdict sentence", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const el = mount({ game: "oo2" }, undefined, "el", (e) => (opts(e).checkRunner = fakeCheck("symmetric", gate)));
    await flush();
    expect(shown(el, "startCheck")).toBe(false); // while it runs
    release();
    await flush();
    expect(shown(el, "startCheck")).toBe(true);
    expect(line(el).textContent).toBe("Direct connections: likely to fail. A relay is recommended.");
  });

  it("checkOnOpen false and showConnectionCheck false run nothing; the button still works for the first", async () => {
    const off = mount({ game: "oo3" }, undefined, "el", (e) => (e.blueprint = { game: { id: "oo3" }, diagnostics: { checkOnOpen: false } }));
    await flush();
    expect(checkRuns).toBe(0);
    off.shadowRoot!.getElementById("check")!.click();
    await flush();
    expect(checkRuns).toBe(1);
    document.body.replaceChildren();
    checkRuns = 0;
    const hidden = mount({ game: "oo4" }, undefined, "el", (e) => (e.blueprint = { game: { id: "oo4" }, diagnostics: { showConnectionCheck: false } }));
    await flush();
    expect(checkRuns).toBe(0);
    hidden._controller.openSettings();
    expect(q(hidden, "checkBox").hidden).toBe(true);
  });

  it("Host pressed while the check is running works; the late answer only fills the lines", async () => {
    const r = newRig();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const el = mount({ game: "oo5", server: "wss://lobby.mygame.test/ws" }, r, "el", (e) => (opts(e).checkRunner = fakeCheck("symmetric", gate)));
    await flush();
    expect(el._controller.checkRunning).toBe(true);
    await el.host();
    await wait(r, 500);
    expect(el.state).toBe("lobby");
    release();
    await flush();
    expect([el.state, el._controller.checkVerdictId, checkRuns]).toEqual(["lobby", "likely_fail", 1]);
    await el.leave();
    await flush();
    expect(shown(el, "startCheck")).toBe(true);
  });

  it("the start screen first shows later than the element (another screen came first, as after a join link): the check runs then, once", async () => {
    const el = mount({ game: "oo7" }, undefined, "el", (e) => e._controller.openSettings());
    await flush();
    expect([el.screen, checkRuns]).toEqual(["settings", 0]); // the start screen was not up when the element opened
    el._controller.back();
    await flush();
    expect([el.screen, checkRuns]).toEqual(["start", 1]);
    el._controller.openSettings();
    el._controller.back();
    await flush();
    expect(checkRuns).toBe(1); // and not again
  });

  it("the element removed from the page while the check runs: the late answer draws nothing and throws nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const el = mount({ game: "oo6" }, undefined, "el", (e) => (opts(e).checkRunner = fakeCheck("symmetric", gate)));
    await flush();
    expect(el._controller.checkRunning).toBe(true);
    let draws = 0;
    const before = el._controller.onChange;
    el._controller.onChange = () => {
      draws++;
      before();
    };
    el.remove();
    release();
    await flush();
    expect(el._controller.checkRunning).toBe(false);
    expect(shown(el, "startCheck")).toBe(false); // nothing was drawn on the detached element
    expect(draws).toBeGreaterThan(0); // the controller still got its answer
  });
});
