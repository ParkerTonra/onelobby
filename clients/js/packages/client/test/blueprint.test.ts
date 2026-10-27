import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ManualClock, MemoryNetwork, MemoryServer, settle } from "../src/testing.js";
import { BlueprintError, ErrorCodes, OneLobby, OneLobbyError, defineBlueprint, describeError, parseBlueprint } from "../src/index.js";
import { hostDirect } from "../src/direct/index.js";
import { FakeCodec, RecordingSink, ToneMic, freePort } from "./helpers.js";
import { specJson } from "./spec.js";

const vectors = specJson("vectors/blueprint.json");

function lookup(o: any, dotted: string): unknown {
  let cur = o;
  for (const k of dotted.split(".")) {
    if (cur === undefined || cur === null) return null;
    cur = cur[k];
  }
  return cur === undefined ? null : cur;
}

describe("parseBlueprint vs spec/vectors/blueprint.json (valid)", () => {
  for (const v of vectors.valid) {
    it(v.name, () => {
      const bp = parseBlueprint(structuredClone(v.input));
      for (const [path, want] of Object.entries(v.expect)) expect(lookup(bp, path), path).toEqual(want);
    });
  }
});

describe("parseBlueprint vs spec/vectors/blueprint.json (invalid)", () => {
  for (const v of vectors.invalid) {
    it(`${v.name}: ${v.error.rule} at "${v.error.path}"`, () => {
      let err: unknown;
      try {
        parseBlueprint(structuredClone(v.input));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(OneLobbyError);
      const e = err as BlueprintError;
      expect(e.code).toBe("bad_config");
      expect({ path: e.path, rule: e.rule }).toEqual(v.error);
    });
  }
});

describe("parseBlueprint result", () => {
  it("is deeply frozen and the input is left alone", () => {
    const input = { game: { id: "a" }, lobby: { meta: { k: "v" } } };
    const bp = parseBlueprint(input);
    expect(Object.isFrozen(bp)).toBe(true);
    expect(Object.isFrozen(bp.lobby.meta)).toBe(true);
    expect(Object.isFrozen(bp.hosting.allowedOrigins)).toBe(true);
    expect(Object.isFrozen(input.lobby)).toBe(false);
  });
  it("error message names the file, path and problem", () => {
    expect(() => parseBlueprint({ game: { id: "a" }, hosting: { direct: false, server: false } })).toThrow(
      "onelobby.json: hosting: at least one of direct, server must be true",
    );
  });
  it("defineBlueprint returns its argument", () => {
    const x = defineBlueprint({ game: { id: "a" } });
    expect(parseBlueprint(x).game.id).toBe("a");
  });
  it("matches the schema file shipped in the package (same top-level keys)", () => {
    const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../../spec/blueprint.schema.json"), "utf8"));
    const bp = parseBlueprint({ game: { id: "a" } });
    for (const k of Object.keys(schema.properties)) if (!k.startsWith("$") && k !== "engine") expect(Object.keys(bp)).toContain(k);
  });
});

function world() {
  const clock = new ManualClock();
  const server = new MemoryServer();
  const net = new MemoryNetwork();
  const advanced = (owner: string) => ({
    socketFactory: server.socketFactory,
    linkFactory: net.factoryFor(owner),
    clock,
    wallClock: () => 1_700_000_000_000 + clock.now(),
    voiceCodec: new FakeCodec(),
    createMic: () => new ToneMic(),
    createSink: () => new RecordingSink(),
    storage: null,
  });
  return { clock, server, net, advanced };
}

describe("OneLobby.fromConfig", () => {
  it("an empty lobby server fails with no_server and plain words", async () => {
    const w = world();
    const { socketFactory: _memory, ...rest } = w.advanced("ann"); // the real socket factory, which needs an address
    const kit = OneLobby.fromConfig({ game: { id: "com.example.ttt" } }, { advanced: rest });
    const err = await kit.host().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneLobbyError);
    expect((err as OneLobbyError).code).toBe(ErrorCodes.NoServer);
    expect(describeError(err).message).toMatch(/no lobby server/i);
  });

  it("maps the file onto the kit", () => {
    const w = world();
    const kit = OneLobby.fromConfig(
      {
        game: { id: "com.example.ants", netVersion: "3" },
        engine: "web",
        hosting: { lobbyServer: "wss://file.example.org/ws", relayOnly: true },
        sync: { mode: "lockstep", tickRate: 30 },
        session: { readyTimeoutMs: 5000, peerTimeoutMs: 8000 },
      },
      { displayName: " Ann ", advanced: w.advanced("ann") },
    );
    expect(kit.options).toMatchObject({
      gameId: "com.example.ants",
      netVersion: "3",
      lobbyServer: "wss://file.example.org/ws",
      mode: "lockstep",
      tickRate: 30,
      hashEveryTicks: 30,
      displayName: "Ann",
      relayOnly: true,
      readyTimeoutMs: 5000,
      peerTimeoutMs: 8000,
    });
    expect(kit.blueprint?.game.id).toBe("com.example.ants");
    expect(Object.isFrozen(kit.blueprint)).toBe(true);
  });

  it("override lobbyServer wins over the file; raw is the default mode; replication runs as raw", () => {
    const kit = OneLobby.fromConfig({ game: { id: "a" }, engine: "dotnet", sync: { mode: "replication" }, hosting: { lobbyServer: "wss://file/ws" } }, { lobbyServer: "wss://cli/ws" });
    expect(kit.options.lobbyServer).toBe("wss://cli/ws");
    expect(kit.options.mode).toBe("raw");
    expect(OneLobby.fromConfig({ game: { id: "a" } }).options.mode).toBe("raw");
  });

  it("kits built with new OneLobby have no blueprint", () => {
    expect(new OneLobby({ gameId: "a", netVersion: "1", lobbyServer: "" }).blueprint).toBeUndefined();
  });

  it("an invalid file throws bad_config with path and rule", () => {
    try {
      OneLobby.fromConfig({ game: { id: "a" }, lobby: { maxPlayers: 99 } });
      throw new Error("should throw");
    } catch (e) {
      expect(e).toMatchObject({ code: "bad_config", path: "lobby.maxPlayers", rule: "range" });
    }
  });
});

describe("kit.host() defaults from the blueprint", () => {
  it("sends lobby.* to the server; explicit options win", async () => {
    const w = world();
    const file = {
      game: { id: "g" },
      engine: "web",
      lobby: { maxPlayers: 6, listed: true, lateJoin: false, meta: { map: "forest" } },
      session: { rateLimit: { messages: 5, perMs: 1000 } },
    };
    const a = OneLobby.fromConfig(file, { displayName: "Ann", advanced: w.advanced("ann") });
    await a.host();
    const b = OneLobby.fromConfig({ ...file, lobby: { approveJoins: true } }, { advanced: w.advanced("bob") });
    await b.host();
    const c = OneLobby.fromConfig(file, { displayName: "Cy", advanced: w.advanced("cy") });
    await c.host({ name: "mine", maxPlayers: 2, visibility: "unlisted" });
    const d = OneLobby.fromConfig({ game: { id: "g" }, engine: "web" }, { advanced: w.advanced("dee") });
    await d.host();
    const creates = w.server.received.filter((m) => m.t === "create");
    expect(creates[0]).toMatchObject({ name: "Ann's game", maxPlayers: 6, visibility: "public", lateJoin: false, meta: { map: "forest" } });
    expect(creates[1]).toMatchObject({ name: "Game", maxPlayers: 4, visibility: "private", lateJoin: true });
    expect(creates[2]).toMatchObject({ name: "mine", maxPlayers: 2, visibility: "unlisted", lateJoin: false });
    expect(creates[3]).toMatchObject({ visibility: "unlisted" });
  });

  it("a plain kit still needs name and maxPlayers semantics unchanged", async () => {
    const w = world();
    const kit = new OneLobby({ gameId: "g", netVersion: "1", lobbyServer: "mem://x", mode: "raw", socketFactory: w.server.socketFactory, linkFactory: w.net.factoryFor("p"), clock: w.clock });
    await kit.host({ name: "x", maxPlayers: 3 });
    expect(w.server.received.find((m) => m.t === "create")).toMatchObject({ name: "x", maxPlayers: 3, visibility: "unlisted" });
  });
});

describe("hostDirect defaults from the blueprint", () => {
  it("takes the port, maxPlayers and meta from the file", async () => {
    const port = await freePort();
    const kit = OneLobby.fromConfig(
      { game: { id: "g" }, engine: "node-browser", hosting: { directPort: Math.max(port, 1024), openPort: false, nostr: false }, lobby: { meta: { map: "m" } } },
      { displayName: "Ann", rememberSeat: false },
    );
    const lobby = await hostDirect(kit, { bindHost: "127.0.0.1" });
    try {
      expect(lobby.directHub.port).toBe(Math.max(port, 1024));
      expect(lobby.portMapping).toBe("off");
      expect(lobby.meta).toEqual({ map: "m" });
    } finally {
      await lobby.leave();
    }
  });
});

describe("enforcement", () => {
  it("voice_disabled: voice.enabled = true throws when chat.voice is false; plain kits are unchanged", async () => {
    const w = world();
    const kit = OneLobby.fromConfig({ game: { id: "g" }, engine: "web" }, { advanced: w.advanced("a") });
    const lobby = await kit.host();
    expect(() => (lobby.voice.enabled = true)).toThrowError(expect.objectContaining({ code: "voice_disabled" }));
    expect(lobby.voice.enabled).toBe(false);
    lobby.voice.enabled = false;

    const on = OneLobby.fromConfig({ game: { id: "g" }, engine: "web", chat: { voice: true } }, { advanced: w.advanced("b") });
    const l2 = await on.host();
    l2.voice.enabled = true;
    await settle();
    expect(l2.voice.enabled).toBe(true);

    const plain = new OneLobby({ gameId: "g", netVersion: "1", lobbyServer: "mem://x", socketFactory: w.server.socketFactory, linkFactory: w.net.factoryFor("c"), clock: w.clock, voiceCodec: new FakeCodec(), createMic: () => new ToneMic(), createSink: () => new RecordingSink() });
    const l3 = await plain.host({ name: "p", maxPlayers: 2 });
    l3.voice.enabled = true;
    await settle();
    expect(l3.voice.enabled).toBe(true);
  });

  it("chat.voiceMode sets the lobby's starting voice mode", async () => {
    const w = world();
    const va = OneLobby.fromConfig({ game: { id: "g" }, engine: "web", chat: { voice: true, voiceMode: "voiceActivity" } }, { advanced: w.advanced("a") });
    expect((await va.host()).voice.mode).toBe("voiceActivity");
    const ptt = OneLobby.fromConfig({ game: { id: "g" }, engine: "web" }, { advanced: w.advanced("b") });
    expect((await ptt.host()).voice.mode).toBe("pushToTalk");
  });

  it("chat_disabled: chat.send throws when chat.text is false", async () => {
    const w = world();
    const kit = OneLobby.fromConfig({ game: { id: "g" }, engine: "web", chat: { text: false } }, { advanced: w.advanced("a") });
    const lobby = await kit.host();
    expect(() => lobby.chat.send("hi")).toThrowError(expect.objectContaining({ code: "chat_disabled" }));
    const ok = OneLobby.fromConfig({ game: { id: "g" }, engine: "web" }, { advanced: w.advanced("b") });
    const l2 = await ok.host();
    expect(() => l2.chat.send("hi")).not.toThrow();
  });

  it("pause_disabled: pause.request throws when session.pause is off (the default); host makes pausing host-only; anyone opens it", async () => {
    const w = world();
    const off = OneLobby.fromConfig({ game: { id: "g" }, engine: "web" }, { advanced: w.advanced("a") });
    const lobby = await off.host();
    expect(() => lobby.pause.request(true)).toThrowError(expect.objectContaining({ code: "pause_disabled" }));
    expect(ErrorCodes.PauseDisabled).toBe("pause_disabled");
    expect(describeError(ErrorCodes.PauseDisabled).message).toBeTruthy();

    const host = OneLobby.fromConfig({ game: { id: "g" }, engine: "web", session: { pause: "host" } }, { advanced: w.advanced("b") });
    const hl = await host.host();
    const joiner = OneLobby.fromConfig({ game: { id: "g" }, engine: "web", session: { pause: "anyone" } }, { advanced: w.advanced("c") });
    const jl = await joiner.join(hl.code);
    await settle();
    await hl.start();
    await settle();
    jl.pause.request(true);
    await settle();
    expect(hl.pause.state.paused).toBe(false);
    hl.pause.request(true);
    await settle();
    expect(jl.pause.state.paused).toBe(true);
    expect(jl.pause.canResume).toBe(false);
    expect(hl.pause.canResume).toBe(true);
  });

  it("listing_disabled: list() rejects when hosting.server is false", async () => {
    const w = world();
    const kit = OneLobby.fromConfig({ game: { id: "g" }, engine: "dotnet" }, { advanced: w.advanced("a") });
    await expect(kit.list()).rejects.toMatchObject({ code: "listing_disabled" });
    const srv = OneLobby.fromConfig({ game: { id: "g" }, engine: "web" }, { advanced: w.advanced("b") });
    await expect(srv.list()).resolves.toEqual([]);
  });

  it("identity_anonymous: a name with anonymous players throws; an empty name is fine", () => {
    const file = { game: { id: "g" }, players: { identity: "anonymous" } };
    expect(() => OneLobby.fromConfig(file, { displayName: "Ann" })).toThrowError(expect.objectContaining({ code: "identity_anonymous" }));
    expect(() => OneLobby.fromConfig(file, { displayName: "  " })).not.toThrow();
    expect(() => OneLobby.fromConfig(file)).not.toThrow();
  });

  it("a name longer than players.maxNameLength is bad_config at displayName", () => {
    try {
      OneLobby.fromConfig({ game: { id: "g" }, players: { maxNameLength: 5 } }, { displayName: "Alexandra" });
      throw new Error("should throw");
    } catch (e) {
      expect(e).toMatchObject({ code: "bad_config", path: "displayName" });
    }
    expect(() => OneLobby.fromConfig({ game: { id: "g" }, players: { maxNameLength: 5 } }, { displayName: "Alexa" })).not.toThrow();
  });

  it("describeError has plain text for the new codes", () => {
    for (const code of [ErrorCodes.VoiceDisabled, ErrorCodes.ChatDisabled, ErrorCodes.ListingDisabled, ErrorCodes.IdentityAnonymous, ErrorCodes.BadConfig]) {
      const d = describeError(new OneLobbyError(code, "x"));
      expect(d.code).toBe(code);
      expect(d.message).not.toBe(describeError("???").message);
    }
  });
});
