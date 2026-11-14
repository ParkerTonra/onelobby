import { describe, expect, it } from "vitest";
import { OneLobby, OneLobbyError } from "../src/index.js";
import { FakeCodec, RecordingSink, ToneMic, rig } from "./helpers.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("rename", () => {
  it("renames a member for everyone and fires peerRenamed on each, once", async () => {
    const r = rig();
    const host = await r.make("Host", { mode: "raw" }).host({ maxPlayers: 4 });
    const joiner = await r.make("Joe", { mode: "raw" }).join(host.code);
    await flush();
    const onHost: [number, string, string][] = [];
    const onJoiner: [number, string, string][] = [];
    host.on("peerRenamed", (p, old) => onHost.push([p.peerId, p.name, old]));
    joiner.on("peerRenamed", (p, old) => onJoiner.push([p.peerId, p.name, old]));

    await joiner.rename("Joanna");
    await flush();
    expect(onHost).toEqual([[joiner.localPeerId, "Joanna", "Joe"]]);
    expect(onJoiner).toEqual([[joiner.localPeerId, "Joanna", "Joe"]]);
    expect(host.peer(joiner.localPeerId)?.name).toBe("Joanna");

    await joiner.rename("Joanna");
    await flush();
    expect(onHost).toHaveLength(1);
  });

  it("throws unsupported on a hub without the feature", async () => {
    const r = rig();
    r.server.features = [];
    const host = await r.make("Host", { mode: "raw" }).host({ maxPlayers: 4 });
    await expect(host.rename("X")).rejects.toMatchObject({ code: "unsupported" });
  });

  it("follows the blueprint: anonymous games take no names, and names stay within maxNameLength", async () => {
    const r = rig();
    const advanced = (owner: string) => ({
      socketFactory: r.server.socketFactory,
      linkFactory: r.net.factoryFor(owner),
      clock: r.clock,
      voiceCodec: new FakeCodec(),
      createMic: () => new ToneMic(),
      createSink: () => new RecordingSink(),
      storage: null,
    });
    const file = (identity: string) => ({ game: { id: "gridpaint" }, players: { identity, maxNameLength: 8 }, hosting: { lobbyServer: "mem://server" } });
    const named = await OneLobby.fromConfig(file("name"), { advanced: advanced("n") }).host();
    await expect(named.rename("x".repeat(9))).rejects.toMatchObject({ code: "bad_config" });
    const anon = await OneLobby.fromConfig(file("anonymous"), { advanced: advanced("a") }).host();
    await expect(anon.rename("Bob")).rejects.toBeInstanceOf(OneLobbyError);
    await expect(anon.rename("Bob")).rejects.toMatchObject({ code: "identity_anonymous" });
  });
});
