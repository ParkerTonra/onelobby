/**
 * The drop-in menu's brain (LobbyController) driven with no DOM, on the in-memory network: host, a second player joins by code,
 * roster, ready, start with the countdown, back to lobby, kick with a reason, ban and a refused rejoin, unban, wrong password,
 * a bad code, an old host, saved name and last code as defaults, the relay line never being shown, the invite sentence and its
 * parser, cancel while connecting, browse, settings and the connection check. The same cases as the C# `MenuModelTests`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OneLobby, memoryStore, PlayerSettings, type Lobby } from "../src/internals.js";
import { encodeJoinCode } from "../src/joincode.js";
import { checkVerdict } from "../src/diagnose.js";
import { parseBlueprint } from "../src/blueprint.js";
import { describeError } from "../src/friendly.js";
import { removalReason } from "../src/room-rules.js";
import { LobbyController, type ControllerOptions, type KitLike } from "../src/ui/controller.js";
import { cleanJoinText, parseJoin } from "../src/ui/menu-join.js";
import { MENU_TEXT, MENU_TEXT_SHARED, MENU_TEXT_WEB, MenuTexts } from "../src/ui/menu-text.js";
import type { Rig } from "./helpers.js";
import { flush, newRig, wait } from "./room-helpers.js";

const RELAY = "turn:127.0.0.1:9 samuser sampass77";

interface Person {
  c: LobbyController;
  events: [string, unknown][];
  copied: string[];
  settings: PlayerSettings;
  kits: OneLobby[];
  /** What this player's browser would have downloaded or copied is in `copied`; the kit behind the newest action. */
  kit(): OneLobby;
}

/** A player with a controller, its own id, ban and settings stores (so a rejoin is the same player), and a recording clipboard. */
function person(r: Rig, label: string, o: { blueprint?: unknown; server?: boolean; countdown?: number; extra?: Partial<ControllerOptions> } = {}): Person {
  const idStore = memoryStore();
  const banStore = memoryStore();
  const settingsStore = memoryStore();
  const settings = new PlayerSettings(settingsStore, "gridpaint", null);
  const kits: OneLobby[] = [];
  const advanced = {
    playerIdStore: idStore, banStore, settingsStore, env: null, socketFactory: r.server.socketFactory, linkFactory: r.net.factoryFor(label), clock: r.clock,
    wallClock: () => 1_700_000_000_000 + r.clock.now(), voiceCodec: null, createMic: null, createSink: null, storage: null,
  };
  const makeKit = (name: string): OneLobby => {
    const k = o.blueprint
      ? OneLobby.fromConfig(o.blueprint, { displayName: name, advanced })
      : r.make(label, { mode: "raw", extra: { displayName: name, advanced, room: { countdownSeconds: o.countdown ?? 1 } } });
    kits.push(k);
    return k;
  };
  const copied: string[] = [];
  const events: [string, unknown][] = [];
  const c = new LobbyController({
    makeKit: makeKit as ControllerOptions["makeKit"],
    maxPlayers: 4,
    settings: () => settings,
    clipboard: (t) => {
      copied.push(t);
      return true;
    },
    ...o.extra,
  });
  c.onEvent = (t, d) => events.push([t, d]);
  return { c, events, copied, settings, kits, kit: () => kits[kits.length - 1] };
}

async function hosting(r: Rig, label: string, o: Parameters<typeof person>[2] = {}): Promise<Person> {
  const p = person(r, label, o);
  await p.c.host(label);
  await flush();
  return p;
}

async function joinedBy(r: Rig, host: Person, label: string, o: Parameters<typeof person>[2] = {}): Promise<Person> {
  const p = person(r, label, o);
  await p.c.join(host.c.codeText().toLowerCase(), label);
  await wait(r, 500);
  return p;
}

const row = (p: Person, who: string) => p.c.roster().find((x) => x.name === who);
const names = (p: Person) => p.c.roster().map((x) => x.name);
const raw = (l: Lobby | null) => l as unknown as { emit(ev: string, ...a: unknown[]): void };

// ---- the text table ---------------------------------------------------------------------------------------------------

/** `const TABLE := { "key": "text", ... }` out of menu_text.gd. */
function readGdTable(source: string): Record<string, string> {
  const start = source.indexOf("const TABLE := {");
  const end = source.indexOf("\n}", start);
  expect(start >= 0 && end > start, "TABLE not found in menu_text.gd").toBe(true);
  const out: Record<string, string> = {};
  for (const m of source.slice(start, end).matchAll(/^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)) out[m[1]] = JSON.parse(`"${m[2]}"`) as string;
  return out;
}

/** The keys only the web element has; a key outside this list that the Godot table lacks fails the test below. */
const WEB_ONLY_KEYS = [
  "status_idle", "status_joining", "status_resuming", "status_creating", "status_error", "status_waiting", "status_players_here", "status_linking",
  "status_connected", "status_playing", "status_host_fallback", "start_invited_noname", "join_or", "copy_link", "link_copied", "start_need_players",
  "back_to_lobby", "chat_label", "retry", "logs_downloaded", "no_server_status", "no_server_hint", "server_page_note",
];

describe("menu text table", () => {
  it("matches the Godot menu's menu_text.gd key for key and word for word", () => {
    const gd = readGdTable(readFileSync(new URL("../../../../gdscript/addons/onelobby/menu/menu_text.gd", import.meta.url), "utf8"));
    expect(Object.keys(gd).length, "menu_text.gd parsed to too few keys").toBeGreaterThan(100);
    expect(Object.keys(gd).filter((k) => !(k in MENU_TEXT_SHARED))).toEqual([]); // a key only the Godot table has
    expect(Object.keys(MENU_TEXT_SHARED).filter((k) => !(k in gd))).toEqual([]); // a key only the web table's shared part has
    for (const [k, v] of Object.entries(gd)) expect(MENU_TEXT_SHARED[k], k).toBe(v);
  });

  it("names every web-only key (none is skipped silently, none shadows a shared key)", () => {
    expect(Object.keys(MENU_TEXT_WEB).sort()).toEqual([...WEB_ONLY_KEYS].sort());
    for (const k of WEB_ONLY_KEYS) expect(k in MENU_TEXT_SHARED, k).toBe(false);
  });

  it("fills placeholders, rewords by override and shows a missing key as the key", () => {
    const t = new MenuTexts();
    expect(t.t("players_header", 2, 4)).toBe("Players 2/4");
    expect(t.t("browse_row", "Sam's game", "Sam", 1, 4)).toBe("Sam's game (Sam) 1/4");
    t.override({ host: "Create game", invite_sentence_untitled: "Come play: code %s", bogus: 5 });
    expect(t.t("host")).toBe("Create game");
    expect(t.t("join")).toBe("Join");
    expect(t.t("invite_sentence_untitled", "7HQ 4K2")).toBe("Come play: code 7HQ 4K2");
    expect(t.t("bogus")).toBe("bogus");
    expect(t.t("no_such_key")).toBe("no_such_key");
    t.override(null);
    expect(t.t("host")).toBe("Host a game");
    expect(new MenuTexts().t("a%%b %d", 5)).toBe("a%b 5");
  });

  it("keeps the sentences the element has always shown", () => {
    expect(MENU_TEXT.status_idle).toBe("Host a game, or type a code to join one.");
    expect(MENU_TEXT.status_waiting).toBe("Waiting for players… Share the code with your friends.");
  });
});

// ---- the join box ------------------------------------------------------------------------------------------------------

describe("the Join box", () => {
  it("cleans as typed and parses codes, addresses and links", () => {
    expect(cleanJoinText("7hq-4k2 !!")).toBe("7HQ-4K2 ");
    expect(cleanJoinText("127.0.0.1:47810")).toBe("127.0.0.1:47810");
    expect(cleanJoinText("https://g.example/?join=7hq4k2")).toBe("https://g.example/?join=7hq4k2");
    expect(parseJoin("7hq 4k2")).toEqual({ kind: "lobby", value: "7HQ4K2" });
    expect(parseJoin("https://g.example/play?join=7HQ-4K2")).toEqual({ kind: "lobby", value: "7HQ4K2" });
    expect(parseJoin("192.168.1.20:47810").kind).toBe("address");
    expect(parseJoin("192.168.1.20").kind).toBe("address");
    expect(parseJoin(encodeJoinCode("10.1.2.3", 47810)).kind).toBe("direct");
    expect(parseJoin("hello").kind).toBe("none");
    expect(parseJoin("").kind).toBe("none");
    expect(parseJoin(null).kind).toBe("none");
  });

  it("a pasted invite sentence yields its code, never the game title", () => {
    const code = { kind: "lobby", value: "7HQ4K2" };
    expect(parseJoin("Join my game in Fortress: code 7HQ 4K2")).toEqual(code); // "Fortress" is eight valid code letters
    expect(parseJoin("Join my game in Castle: code 7HQ-4K2")).toEqual(code); // "Castle" is a whole valid lobby code
    expect(parseJoin("Join my game: code 7HQ-4K2")).toEqual(code);
    expect(parseJoin("Join my game: code 7HQ 4K2.")).toEqual(code); // a trailing full stop
    expect(parseJoin('"Join my game in Fortress: code 7HQ-4K2"')).toEqual(code);
    expect(parseJoin("code '7HQ-4K2'!")).toEqual(code);
    expect(parseJoin("Join my game in Fortress: code 7HQ 4K2 https://g.example/play?join=7HQ-4K2")).toEqual(code);
    expect(parseJoin("Come play Fortress 7HQ-4K2")).toEqual(code); // reworded, no marker: scanned from the end
    expect(parseJoin("Rejoins ma partie Castle : 7HQ 4K2")).toEqual(code);
    expect(parseJoin("Join my game: code 192.168.1.20:47810").kind).toBe("address");
    const dc = encodeJoinCode("10.1.2.3", 47810);
    expect(parseJoin("Join my game in Fortress: code " + dc)).toEqual({ kind: "direct", value: dc });
    expect(parseJoin("Join my game in Fortress").kind).toBe("none");
  });
});

// ---- host, join, roster, ready, countdown, start, back to lobby --------------------------------------------------------

describe("menu controller: the lobby", () => {
  it("host, a second player joins by code, roster, ready, chat, settings, countdown, start, back to lobby, leave", async () => {
    const r = newRig();
    const H = await hosting(r, "Sam");
    expect(H.c.screen).toBe("lobby");
    expect(H.c.isHost).toBe(true);
    expect(H.c.roomActive).toBe(true);
    const code = H.c.codeText();
    expect(code).toMatch(/^[0-9A-Z]{3} [0-9A-Z]{3}$/);
    expect(await H.c.copyCode()).toBe(true);
    expect(H.copied.at(-1)).toBe(code);
    expect(H.settings.effective().lastCode).toBe(code.replace(" ", ""));

    const G = await joinedBy(r, H, "Ann");
    expect(G.c.screen).toBe("lobby");
    expect(names(G)).toEqual(["Sam", "Ann"]);
    expect(names(H)).toEqual(["Sam", "Ann"]);
    expect(row(H, "Sam")).toMatchObject({ host: true, canKick: false });
    expect(row(H, "Ann")).toMatchObject({ host: false, canKick: true });
    expect(row(G, "Ann")!.canKick).toBe(false);
    expect(H.c.playersHeader()).toBe("Players 2/4");

    G.c.toggleReady();
    await wait(r, 300);
    expect(row(H, "Ann")!.ready).toBe(true);
    expect(H.c.rowMarks(row(H, "Ann")!)).toBe("Ready");
    expect(H.c.rowMarks(row(H, "Sam")!)).toBe("Host");
    expect(G.c.meReady).toBe(true);

    H.c.sendChat("hi there");
    await wait(r, 300);
    expect(G.c.chatLines).toEqual([{ peerId: H.c.lobby!.localPeerId, name: "Sam", text: "hi there" }]);
    expect(G.events.filter((e) => e[0] === "chat")).toHaveLength(1);

    expect(H.c.lobbySettings()).toEqual({ autoStart: "off", minPlayers: 1, countdownSeconds: 1, lateJoin: true });
    H.c.setLobbySetting("min_players", 2);
    await wait(r, 300);
    expect(G.c.lobbySettings()!.minPlayers).toBe(2);
    H.c.setLobbySetting("min_players", 1);
    H.c.setLobbySetting("late_join", false);
    H.c.setLobbySetting("auto_start", "all_ready");
    H.c.setLobbySetting("countdown_seconds", 2);
    await wait(r, 300);
    expect(G.c.lobbySettings()).toEqual({ autoStart: "all_ready", minPlayers: 1, countdownSeconds: 2, lateJoin: false });
    H.c.setLobbySetting("auto_start", "off");
    H.c.setLobbySetting("countdown_seconds", 1);
    await wait(r, 200);

    G.c.startGame(); // a joiner's Start does nothing
    expect(G.c.counting).toBe(false);
    expect(H.c.canStart).toBe(true);
    H.c.startGame();
    await wait(r, 300);
    expect(H.c.counting && G.c.counting).toBe(true);
    expect(H.c.countdownText()).toMatch(/^Starting in \d+\.\.\.$/);
    expect(G.c.countdownText()).not.toBe("");
    expect(H.c.canStart).toBe(false);
    await wait(r, 1500);
    expect(H.c.state).toBe("playing");
    expect(G.c.state).toBe("playing");
    expect(H.events.filter((e) => e[0] === "start")).toHaveLength(1);
    expect(G.events.filter((e) => e[0] === "start")).toHaveLength(1);

    H.c.backToLobby();
    await wait(r, 300);
    expect(H.c.state).toBe("lobby");
    expect(G.c.state).toBe("lobby");
    expect(G.events.filter((e) => e[0] === "lobby-return")).toHaveLength(1);
    expect(row(H, "Ann")!.ready).toBe(false); // ready flags reset

    await G.c.leave();
    expect(G.c.screen).toBe("start");
    expect(G.c.lobby).toBeNull();
    await wait(r, 300);
    // the JS room keeps a player whose link closed in a "reconnecting" seat for the rejoin window (the C# client drops a
    // polite leave at once): the row says so, then the seat goes
    expect(H.c.rowMarks(row(H, "Ann")!)).toBe("Reconnecting");
    await wait(r, 62_000);
    expect(names(H)).toEqual(["Sam"]);
    await H.c.leave();
  });

  it("the host can cancel a running countdown", async () => {
    const r = newRig();
    const H = await hosting(r, "Sam", { countdown: 5 });
    const G = await joinedBy(r, H, "Ann", { countdown: 5 });
    H.c.startGame();
    await wait(r, 300);
    expect(H.c.counting && G.c.counting).toBe(true);
    H.c.cancelCountdown();
    await wait(r, 300);
    expect(H.c.counting || G.c.counting).toBe(false);
    expect(H.c.state).toBe("lobby");
  });

  it("start() still starts at once (the method the element has always had)", async () => {
    const r = newRig();
    const H = await hosting(r, "Sam", { countdown: 5 });
    await joinedBy(r, H, "Ann", { countdown: 5 });
    await H.c.start();
    await wait(r, 100);
    expect(H.c.state).toBe("playing");
  });

  it("a refused click says why in one plain sentence (not enough players)", async () => {
    const r = newRig();
    const H = await hosting(r, "Sam");
    H.c.setLobbySetting("min_players", 2);
    H.c.startGame();
    expect(H.c.note).toMatch(/\S/);
    expect(H.c.counting).toBe(false);
  });
});

// ---- kick, ban, unban ----------------------------------------------------------------------------------------------------

describe("menu controller: kick, ban and unban", () => {
  it("kick with a reason, a kick without one, a ban, a refused rejoin and unban", async () => {
    const r = newRig();
    const H = await hosting(r, "Sam");
    const G = await joinedBy(r, H, "Ann");
    H.c.kick(row(H, "Ann")!.id, "afk too long");
    await wait(r, 300);
    expect(G.c.screen).toBe("error");
    expect(G.c.menuError).toMatchObject({ removed: true, ban: false, message: "afk too long", reason: "afk too long", code: "kicked", title: "You were removed" });
    expect(G.c.removal).toMatchObject({ code: "kicked", reason: "afk too long" });
    expect(G.events.find((e) => e[0] === "removed")![1]).toMatchObject({ code: "kicked", reason: "afk too long" });
    expect(G.events.find((e) => e[0] === "error")![1]).toMatchObject({ code: expect.any(String), message: expect.any(String) }); // the old event, same shape
    expect(G.c.statusText).toBe("afk too long");
    expect(G.c.back()).toBe(true);
    expect(G.c.screen).toBe("start");

    // a kick without a reason says the default sentence of the code
    await G.c.join(H.c.codeText(), "Ann");
    await wait(r, 500);
    expect(G.c.screen).toBe("lobby");
    H.c.kick(row(H, "Ann")!.id);
    await wait(r, 300);
    expect(G.c.menuError!.message).toBe(removalReason("kicked"));

    // ban with a reason, then a refused rejoin
    G.c.back();
    await G.c.join(H.c.codeText(), "Ann");
    await wait(r, 500);
    H.c.ban(row(H, "Ann")!.id, "no spoilers");
    await wait(r, 300);
    expect(G.c.screen).toBe("error");
    expect(G.c.menuError).toMatchObject({ ban: true, removed: true, message: "no spoilers", title: "You were banned" });
    const rows = H.c.banRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain("no spoilers");
    expect(rows[0].text).toContain("Ann");

    G.c.back();
    await G.c.join(H.c.codeText(), "Ann");
    await wait(r, 300);
    expect(G.c.screen).toBe("error");
    expect(G.c.menuError!.code).toBe("banned");
    expect(G.c.menuError!.message.length).toBeGreaterThan(10);

    // Unban lifts it
    H.c.unban(rows[0].key);
    expect(H.c.banRows()).toEqual([]);
    G.c.back();
    await G.c.join(H.c.codeText(), "Ann");
    await wait(r, 500);
    expect(G.c.screen).toBe("lobby");
  });

  it("only the host can kick, and only with the room layer", async () => {
    const r = newRig();
    const H = await hosting(r, "Sam");
    const G = await joinedBy(r, H, "Ann");
    G.c.kick(row(G, "Sam")!.id);
    await wait(r, 300);
    expect(H.c.screen).toBe("lobby");
    expect(G.c.banRows()).toEqual([]);
  });
});

// ---- errors the player reads -----------------------------------------------------------------------------------------------

describe("menu controller: errors", () => {
  it("a wrong password, a bad code and an unknown code each read as a plain sentence", async () => {
    const r = newRig();
    const H = person(r, "Sam");
    H.c.setPassword("pw");
    await H.c.host("Sam");
    await flush();
    const G = person(r, "Ann");
    G.c.setPassword("wrong");
    await G.c.join(H.c.codeText(), "Ann");
    expect(G.c.screen).toBe("error");
    expect(G.c.menuError).toMatchObject({ code: "bad_password", message: "That password isn't right.", title: "Couldn't connect" });
    expect(G.c.menuError!.hint).not.toBe("");
    G.c.back();
    G.c.setPassword("pw");
    await G.c.join(H.c.codeText(), "Ann");
    await wait(r, 500);
    expect(G.c.screen).toBe("lobby");

    const B = person(r, "b");
    await B.c.join("hello world", "");
    expect(B.c.menuError).toMatchObject({ code: "bad_code", message: describeError("bad_code").message });
    expect(B.c.menuError!.hint).not.toBe("");
    expect(B.c.back()).toBe(true);
    expect(B.c.screen).toBe("start");
    await B.c.join("7HQ 4K2", "");
    expect(B.c.screen).toBe("error");
    expect(B.c.menuError!.message).toBe(describeError("unknown_code").message);

    // logs: copy, then save (a download in a browser; here there is no DOM, so only the note)
    await B.c.copyLogs();
    expect(B.copied.at(-1)).toMatch(/^# onelobby netlog/);
    expect(B.c.logNote).toBe(MENU_TEXT.logs_copied);
    B.c.saveLogs();
    expect(B.c.logNote).toBe(MENU_TEXT.logs_downloaded);
  });

  it("a lobby that ends because the host left reads as its own screen", async () => {
    const r = newRig();
    const H = await hosting(r, "Sam");
    const G = await joinedBy(r, H, "Ann");
    (G.c.lobby as unknown as { teardown(reason: string): void }).teardown("host_left");
    await flush();
    expect(G.c.screen).toBe("error");
    expect(G.c.menuError).toMatchObject({ title: "The game ended", message: "The host left, so the game ended.", hint: "Go back and host or join another game.", code: "host_left" });
  });

  it("cancel while connecting goes back and a late answer is not shown", async () => {
    const r = newRig();
    const H = await hosting(r, "Sam");
    const C = person(r, "c");
    const pending = C.c.join(H.c.codeText(), "c");
    expect(C.c.screen).toBe("connecting");
    expect(C.c.back()).toBe(true);
    expect(C.c.screen).toBe("start");
    await pending;
    await wait(r, 1000);
    expect(C.c.screen).toBe("start"); // the lobby that arrived anyway was left, not shown
    expect(C.c.lobby).toBeNull();
    expect(H.c.players.map((p) => p.name)).toEqual(["Sam"]);
  });
});

// ---- an old host ----------------------------------------------------------------------------------------------------------

describe("menu controller: a host with no room layer", () => {
  it("gives a plain peer list with no ready, kick or settings", async () => {
    const r = newRig();
    const H = await hosting(r, "Sam");
    (H.c.lobby!.room as unknown as { handleFrame(): void }).handleFrame = () => {}; // an older host ignores the room frame
    const G = person(r, "Ann");
    await G.c.join(H.c.codeText(), "Ann");
    expect(G.c.screen).toBe("lobby");
    await wait(r, 3200);
    expect(G.c.lobby!.room.supported).toBe(false);
    expect(G.c.plainList).toBe(true);
    const rows = G.c.roster();
    expect(rows).toHaveLength(2);
    expect(rows.every((x) => !x.ready && !x.canKick)).toBe(true);
    expect(G.c.roomActive).toBe(false);
    expect(G.c.playersHeader()).toBe("Players 2");
    G.c.toggleReady();
    expect(G.c.note).toBe("");
    expect(G.c.counting).toBe(false);
    expect(G.c.lobbySettings()).toBeNull();
  });
});

// ---- the start screen, the invite, the settings -------------------------------------------------------------------------------

describe("menu controller: start, invite and settings screens", () => {
  it("the saved name and the last code are the start screen's defaults", async () => {
    const r = newRig();
    const p = person(r, "p");
    expect(p.c.defaults()).toEqual({ name: "", lastCode: "" });
    p.settings.save({ name: "Sam", lastCode: "7HQ4K2" });
    expect(p.c.defaults()).toEqual({ name: "Sam", lastCode: "7HQ 4K2" });
    expect(p.c.canBrowse).toBe(true);
  });

  it("Copy invite copies a sentence with the code (and the link when the page has a base), and the Join box reads it back", async () => {
    const r = newRig();
    let base: string | undefined;
    const H = await hosting(r, "Sam", { extra: { inviteBase: () => base } });
    const code = H.c.codeText();
    expect(await H.c.copyInvite()).toBe(true);
    expect(H.copied.at(-1)).toBe("Join my game: code " + code); // no blueprint, no title, no base
    base = "https://g.example/play";
    expect(H.c.inviteText()).toBe(`Join my game: code ${code} https://g.example/play?join=${code.replace(" ", "-")}`);
    expect(await H.c.copyLink()).toBe(true);
    expect(H.copied.at(-1)).toBe(`https://g.example/play?join=${code.replace(" ", "-")}`);
    expect(parseJoin(H.c.inviteText())).toEqual({ kind: "lobby", value: H.c.code });
    const G = person(r, "Ann");
    await G.c.join(H.c.inviteText(), "Ann");
    await wait(r, 500);
    expect(G.c.screen).toBe("lobby");
    const none = person(r, "n");
    expect(await none.c.copyInvite()).toBe(false); // no lobby: nothing to copy
  });

  for (const title of ["Fortress", "Castle"]) {
    it(`with a game title (${title}) the sentence names the game and the code still wins`, async () => {
      const r = newRig();
      const bp = { game: { id: "gridpaint", title }, sync: { mode: "raw" }, hosting: { server: true, lobbyServer: "mem://server" } };
      const H = await hosting(r, "Sam", { blueprint: bp, extra: { inviteBase: () => "https://g.example/play" } });
      const code = H.c.codeText();
      expect(H.c.inviteText()).toBe(`Join my game in ${title}: code ${code} https://g.example/play?join=${code.replace(" ", "-")}`);
      expect(parseJoin(H.c.inviteText())).toEqual({ kind: "lobby", value: H.c.code });
      const G = person(r, "Ann", { blueprint: bp });
      await G.c.join(H.c.inviteText(), "Ann");
      await wait(r, 500);
      expect(G.c.screen).toBe("lobby");
    });
  }

  it("the relay line is never in any text the controller exposes", async () => {
    const r = newRig();
    const P = person(r, "p", {
      extra: { checkRunner: async () => ({ udp: "ok", natType: "symmetric", relay: "none", ...checkVerdict({ udp: "ok", natType: "symmetric", relay: "none" }) }) },
    });
    const c = P.c;
    c.openSettings();
    expect(c.screen).toBe("settings");
    expect(c.saveRelay("this is not a relay line")).toBe(false);
    expect(c.relayNote).toBe(MENU_TEXT.relay_bad_input);
    expect(c.saveRelay(RELAY)).toBe(true);
    expect(c.relayNote).toBe(MENU_TEXT.relay_saved);
    await c.copyLogs();
    c.saveServer("not a server");
    await c.runCheck();
    await c.host("p"); // a real Host with the saved relay in its ICE list
    await flush();
    const seen = [
      c.relayStatusText(), c.relayNote, c.settingsNote, c.checkVerdict, c.checkFacts.join("|"), c.logNote, c.note, c.startNote, c.serverText, c.copyNote,
      JSON.stringify(c.menuError), P.kit().netLog.export(), P.copied.join("|"), JSON.stringify(P.events), JSON.stringify(c.roster()),
    ];
    for (const s of seen) expect(s).not.toMatch(/samuser|sampass77/);
    expect(c.relayStatusText()).toBe("Relay in use: turn:127.0.0.1:9 <hidden> <hidden>");
    expect(P.settings.effective().relay).toBe(RELAY); // saved, only the controller never shows it
    c.clearRelay();
    expect(c.relayStatusText()).toBe(MENU_TEXT.relay_none);
    expect(c.saveServer("not a server")).toBe(false);
    expect(c.settingsNote).toBe(MENU_TEXT.server_bad_input);
  });

  it("saves the lobby server and shows the page's own when it sets one", async () => {
    const r = newRig();
    let page = "";
    const P = person(r, "p", { extra: { pageServer: () => page } });
    P.c.openSettings();
    expect(P.c.serverText).toBe("");
    expect(P.c.saveServer("wss://lobby.mygame.test/ws")).toBe(true);
    expect(P.c.settingsNote).toBe(MENU_TEXT.server_saved);
    expect(P.c.serverText).toBe("wss://lobby.mygame.test/ws");
    page = "wss://page.example.test/ws";
    expect(P.c.pageSetsServer).toBe(true);
    expect(P.c.effectiveServer()).toBe(page);
  });

  it("the connection check shows the library's verdict and three facts", async () => {
    const r = newRig();
    const findings = { udp: "ok", natType: "symmetric", relay: "none" } as const;
    const P = person(r, "p", { extra: { checkRunner: async () => ({ ...findings, ...checkVerdict(findings) }) } });
    const done = P.c.runCheck();
    expect(P.c.checkRunning).toBe(true);
    expect(P.c.checkVerdict).toBe(MENU_TEXT.check_running);
    await done;
    expect(P.c.checkVerdict).toBe(checkVerdict(findings).message);
    expect(P.c.checkFacts).toEqual(["UDP: gets out", "Network type: strict (symmetric)", "Relay: none set"]);
    expect(P.c.checkRunning).toBe(false);
    P.c.openSettings();
    expect(P.c.back()).toBe(true);
    expect(P.c.screen).toBe("start");
    expect(P.c.back()).toBe(false); // nothing behind the start screen
  });

  it("a failing check says so in a plain sentence", async () => {
    const r = newRig();
    const P = person(r, "p", { extra: { checkRunner: async () => { throw new Error("socket exploded"); } } });
    await P.c.runCheck();
    expect(P.c.checkVerdict).toBe(describeError(new Error("socket exploded")).message);
    expect(P.c.checkFacts).toEqual([]);
  });

  it("the blueprint switches the screens", async () => {
    const r = newRig();
    const a = person(r, "a", { blueprint: { game: { id: "gridpaint" }, diagnostics: { showConnectionCheck: false, logSize: 60, reportToHost: false }, players: { identity: "anonymous" }, chat: { text: false }, lobby: { approveJoins: true }, sync: { mode: "raw" }, hosting: { server: false } } });
    a.c.setJoinText("x"); // reads the blueprint through the newest kit once it exists
    await a.c.host("");
    expect(a.c.connectionCheckShown).toBe(false);
    expect(a.c.namesAllowed).toBe(false);
    expect(a.c.approveJoinsOn).toBe(true);
    expect(a.c.canBrowse).toBe(false);
    expect(a.c.chatShown).toBe(false);
    const b = person(r, "b", { blueprint: { game: { id: "gridpaint" }, players: { maxNameLength: 5 } } });
    await b.c.host("");
    expect(b.c.namesAllowed && b.c.connectionCheckShown && b.c.chatShown).toBe(true);
    expect(b.c.maxNameLength).toBe(5);
  });

  it("start() on a page with chat off does nothing for sendChat", async () => {
    const r = newRig();
    const H = await hosting(r, "Sam", { blueprint: { game: { id: "gridpaint" }, chat: { text: false }, sync: { mode: "raw" }, hosting: { server: true, lobbyServer: "mem://server" } } });
    const G = await joinedBy(r, H, "Ann");
    H.c.sendChat("hello");
    await wait(r, 300);
    expect(G.c.chatLines).toEqual([]);
  });
});

// ---- join requests, chat length, browse ----------------------------------------------------------------------------------------

describe("menu controller: join requests, chat and browse", () => {
  it("join requests are kept until answered", async () => {
    const r = newRig();
    const H = await hosting(r, "Sam", { extra: { approveJoins: () => true } });
    expect(H.c.approveJoinsOn).toBe(true);
    // the in-memory server has no join approval, so the hub's request is delivered by hand
    raw(H.c.lobby).emit("joinRequested", { peerId: 7, name: "Bob" });
    expect(H.c.requests).toEqual([{ peerId: 7, name: "Bob" }]);
    const answers: [number, boolean][] = [];
    H.c.lobby!.approve = async (id: number, ok: boolean) => void answers.push([id, ok]);
    H.c.approve(7, true);
    expect(H.c.requests).toEqual([]);
    raw(H.c.lobby).emit("joinRequested", { peerId: 8, name: "Cy" });
    H.c.approve(8, false);
    expect(answers).toEqual([[7, true], [8, false]]);
  });

  it("the chat keeps the last 100 lines", async () => {
    const r = newRig();
    const H = await hosting(r, "Sam");
    const me = H.c.lobby!.localPeerId;
    for (let i = 0; i < 130; i++) raw(H.c.lobby!.chat as unknown as Lobby).emit("message", { peerId: me, id: i, ts: 0, text: `line ${i}` });
    expect(H.c.chatLines).toHaveLength(100);
    expect(H.c.chatLines[0].text).toBe("line 30");
    expect(H.c.chatLines.at(-1)).toEqual({ peerId: me, name: "Sam", text: "line 129" });
  });

  it("browse lists public lobbies, joins one, and says so when there are none", async () => {
    const r = newRig();
    const hostKit = r.make("Sam", { mode: "raw", extra: { advanced: { socketFactory: r.server.socketFactory, linkFactory: r.net.factoryFor("Sam"), clock: r.clock, voiceCodec: null, createMic: null, createSink: null, storage: null } } });
    const lobby = await hostKit.host({ name: "Sam's game", maxPlayers: 4, visibility: "public" });
    const G = person(r, "g");
    expect(G.c.canBrowse).toBe(true);
    await G.c.openBrowse();
    expect(G.c.screen).toBe("browse");
    expect(G.c.browseItems).toHaveLength(1);
    expect(G.c.browseStatus).toBe("");
    expect(G.c.browseRowText(G.c.browseItems[0])).toBe("Sam's game (Sam) 1/4");
    expect(G.c.back()).toBe(true);
    expect(G.c.screen).toBe("start");
    await G.c.openBrowse();
    await G.c.joinListed(G.c.browseItems[0].code, "Ann");
    await wait(r, 500);
    expect(G.c.screen).toBe("lobby");
    await G.c.leave();
    await lobby.leave();
    await flush();
    const E = person(r, "e");
    await E.c.openBrowse();
    expect(E.c.browseStatus).toBe(MENU_TEXT.browse_empty);
  });

  it("browse is not offered without a known lobby server", () => {
    const r = newRig();
    const P = person(r, "p", { extra: { serverKnown: () => false } });
    expect(P.c.canBrowse).toBe(false);
  });

  it("a Join box with a direct code goes to the kit's joinDirect, and says so when the kit has none", async () => {
    const dc = encodeJoinCode("10.1.2.3", 47810);
    const seen: string[] = [];
    const stub = (direct: boolean): KitLike => ({
      host: async () => null as never,
      join: async () => null as never,
      ...(direct ? { joinDirect: async (code: string) => { seen.push(code); throw new Error("direct_unreachable"); } } : {}),
    });
    const c = new LobbyController({ makeKit: (_n, intent) => (seen.push(intent ?? "server"), stub(true)), maxPlayers: 4 });
    await c.join("Join my game in Fortress: code " + dc, "x");
    expect(seen).toEqual(["direct", dc]);
    expect(c.screen).toBe("error");
    const bare = new LobbyController({ makeKit: () => stub(false), maxPlayers: 4 });
    await bare.join("192.168.1.20:47810", "x");
    expect(bare.menuError!.code).toBe("bad_address");
  });
});

// ---- the connection check when the menu opens (every runner here is a counted fake: nothing touches the network) ---------------

describe("the connection check when the menu opens", () => {
  const found = (kind: "cone" | "symmetric" | "blocked" | "refused" | "relay_works") => {
    const f =
      kind === "symmetric" ? { udp: "ok", natType: "symmetric", relay: "none" }
      : kind === "blocked" ? { udp: "blocked", natType: "unknown", relay: "none" }
      : kind === "refused" ? { udp: "ok", natType: "cone", relay: "refused" }
      : kind === "relay_works" ? { udp: "blocked", natType: "unknown", relay: "ok" }
      : { udp: "ok", natType: "cone", relay: "none" };
    return { ...f, ...checkVerdict(f as never) } as never;
  };
  const rigged = (diagnostics?: unknown, kind: Parameters<typeof found>[0] = "cone", gate?: Promise<void>, extra: Partial<ControllerOptions> = {}) => {
    const r = newRig();
    const state = { runs: 0 };
    const P = person(r, "p", {
      extra: {
        blueprint: () => parseBlueprint(diagnostics === undefined ? { game: { id: "gridpaint" } } : { game: { id: "gridpaint" }, diagnostics }),
        checkRunner: async () => {
          state.runs++;
          if (gate) await gate;
          return found(kind);
        },
        ...extra,
      },
    });
    return { r, P, state };
  };

  it("the default runs it once when the start screen first shows, and not again on the way back", async () => {
    const { r, P, state } = rigged();
    expect(P.c.checkOnOpenEnabled).toBe(true);
    expect(state.runs).toBe(0);
    await P.c.startShown();
    expect([state.runs, P.c.checkVerdictId, P.c.checkRunning]).toEqual([1, "good", false]);
    expect(P.c.checkFacts.length).toBe(3);
    expect(P.c.startCheckLine).toBe("");
    P.c.openSettings();
    P.c.back();
    await P.c.startShown();
    await P.c.host("Sam");
    await wait(r, 500);
    await P.c.leave();
    await P.c.startShown();
    expect(state.runs).toBe(1);
    await P.c.runCheck();
    expect(state.runs).toBe(2); // the button still runs it
  });

  it("the start screen line is the verdict sentence for a warning and empty otherwise", async () => {
    for (const [kind, id, warns] of [["symmetric", "likely_fail", true], ["blocked", "blocked", true], ["refused", "relay_refused", true], ["cone", "good", false], ["relay_works", "relay_works", false]] as const) {
      const { P } = rigged(undefined, kind);
      await P.c.startShown();
      expect(P.c.checkVerdictId, kind).toBe(id);
      expect(P.c.startCheckLine, kind).toBe(warns ? P.c.checkVerdict : "");
      if (kind === "symmetric") expect(P.c.startCheckLine).toBe("Direct connections: likely to fail. A relay is recommended.");
    }
  });

  it("checkOnOpen false, showConnectionCheck false and a local page run nothing until the button", async () => {
    const off = rigged({ checkOnOpen: false });
    await off.P.c.startShown();
    expect([off.P.c.checkOnOpenEnabled, off.P.c.connectionCheckShown, off.state.runs]).toEqual([false, true, 0]);
    await off.P.c.runCheck();
    expect(off.state.runs).toBe(1);
    const hidden = rigged({ showConnectionCheck: false });
    await hidden.P.c.startShown();
    expect([hidden.P.c.checkOnOpenEnabled, hidden.state.runs]).toEqual([false, 0]);
    const local = rigged(undefined, "cone", undefined, { localOnly: () => true });
    await local.P.c.startShown();
    expect(local.state.runs).toBe(0);
  });

  it("only the start screen counts as opening: the first time it is shown, it runs", async () => {
    const { P, state } = rigged();
    P.c.openSettings();
    await P.c.startShown();
    expect(state.runs).toBe(0);
    P.c.back();
    await P.c.startShown();
    expect(state.runs).toBe(1);
  });

  it("a run in progress is never started twice, and Host works while it runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const { r, P, state } = rigged(undefined, "symmetric", gate);
    const first = P.c.runCheck();
    const open = P.c.startShown();
    const again = P.c.runCheck();
    await flush();
    expect(state.runs).toBe(1);
    expect(P.c.checkRunning).toBe(true);
    expect(P.c.startCheckLine).toBe("");
    await P.c.host("Sam");
    await wait(r, 500);
    expect(P.c.state).toBe("lobby");
    expect(P.c.checkRunning).toBe(true);
    release();
    await Promise.all([first, open, again]);
    expect([P.c.state, P.c.checkVerdictId, state.runs]).toEqual(["lobby", "likely_fail", 1]);
    expect(P.c.error).toBeNull();
    await P.c.leave();
    expect(P.c.startCheckLine).toBe(P.c.checkVerdict);
  });
});
