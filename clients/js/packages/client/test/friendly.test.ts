import { describe, expect, it } from "vitest";
import { OneLobbyError, codeFromUrl, describeError, shareUrl } from "../src/index.js";

const SERVER_CODES = ["bad_request", "game_not_allowed", "in_game", "kicked", "lobby_full", "not_host", "rate_limited", "server_full", "unknown_code", "version_mismatch"];
const CLIENT_CODES = ["bad_code", "closed", "connect_failed", "invalid_token", "ice_failed", "timeout", "server_lost"];

describe("describeError", () => {
  it("has specific text for every server and client error code", () => {
    const generic = describeError(new Error("x")).message;
    for (const code of [...SERVER_CODES, ...CLIENT_CODES]) {
      const d = describeError(new OneLobbyError(code, "technical detail"));
      expect(d.code).toBe(code);
      expect(d.message).not.toBe(generic);
      expect(d.message).not.toContain("technical detail");
    }
  });

  it("lobby_full example", () => {
    expect(describeError(new OneLobbyError("lobby_full", "lobby is full"))).toEqual({
      code: "lobby_full",
      message: "That lobby is full.",
      hint: "Ask the host to make room, or start your own lobby.",
    });
  });

  it("uses error data: denied, max_lobbies, retryAfterMs", () => {
    expect(describeError(new OneLobbyError("kicked", "", { reason: "denied" })).message).toMatch(/didn't let you in/);
    expect(describeError(new OneLobbyError("rate_limited", "", { reason: "max_lobbies" })).message).toMatch(/most lobbies/);
    expect(describeError(new OneLobbyError("rate_limited", "", { retryAfterMs: 2500 })).hint).toBe("Wait 3 seconds, then try again.");
  });

  it("accepts plain objects, code strings and 'code: msg' errors", () => {
    expect(describeError({ code: "in_game" }).code).toBe("in_game");
    expect(describeError("unknown_code").code).toBe("unknown_code");
    expect(describeError(new Error("lobby_full: lobby is full")).code).toBe("lobby_full");
    expect(describeError(new TypeError("Failed to fetch")).code).toBe("connect_failed");
  });

  it("unknown input never leaks technical text", () => {
    for (const e of [new Error("TypeError at foo.js:12\n    at bar"), null, undefined, 42, {}, { code: "weird_thing" }]) {
      const d = describeError(e);
      expect(d.message).toBe("Something went wrong.");
      expect(d.message + (d.hint ?? "")).not.toMatch(/foo\.js|at bar/);
    }
    expect(describeError({ code: "weird_thing" }).code).toBe("weird_thing");
  });
});

describe("shareUrl / codeFromUrl", () => {
  it("builds a link with the formatted code and replaces an existing param", () => {
    expect(shareUrl("7hq4k2", "https://g.example/play?x=1")).toBe("https://g.example/play?x=1&join=7HQ-4K2");
    expect(shareUrl("7HQ 4K2", "https://g.example/?join=AAAAAA&x=1")).toBe("https://g.example/?x=1&join=7HQ-4K2");
    expect(shareUrl("7HQ4K2", "https://g.example/", "room")).toBe("https://g.example/?room=7HQ-4K2");
    expect(() => shareUrl("nope", "https://g.example/")).toThrow();
  });

  it("round-trips and rejects junk", () => {
    expect(codeFromUrl(shareUrl("7HQ4K2", "https://g.example/a#top"))).toBe("7HQ4K2");
    expect(codeFromUrl("https://g.example/?join=7hq+4k2")).toBe("7HQ4K2");
    expect(codeFromUrl("https://g.example/#join=7HQ-4K2")).toBe("7HQ4K2");
    expect(codeFromUrl("https://g.example/?room=7HQ4K2", "room")).toBe("7HQ4K2");
    expect(codeFromUrl("https://g.example/?join=hello")).toBeNull();
    expect(codeFromUrl("https://g.example/")).toBeNull();
  });
});
