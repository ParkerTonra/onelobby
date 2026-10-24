import { describe, expect, it } from "vitest";
import { lobbyServerUrl } from "../src/ui/server-url.js";

describe("<one-lobby server> address", () => {
  it("accepts what people paste and turns it into a WebSocket URL", () => {
    expect(lobbyServerUrl("https://onelobby-server-ab12.onrender.com")).toBe("wss://onelobby-server-ab12.onrender.com");
    expect(lobbyServerUrl(" wss://lobby.mygame.net/ws ")).toBe("wss://lobby.mygame.net/ws");
    expect(lobbyServerUrl("http://localhost:8080")).toBe("ws://localhost:8080");
    expect(lobbyServerUrl("ws://127.0.0.1:18555/ws")).toBe("ws://127.0.0.1:18555/ws");
    expect(lobbyServerUrl("lobby.mygame.net")).toBe("wss://lobby.mygame.net");
  });

  it("treats empty, placeholder and non-addresses as missing", () => {
    for (const bad of [
      null, undefined, "", "   ",
      "https://YOUR-LOBBY-SERVER.onrender.com", "wss://YOUR-LOBBY-SERVER.example.com", "wss://your-server/ws",
      "wss://lobby.example.com", "https://example.org", "wss://lobby.onelobby.example/ws", "REPLACE-ME",
      "<your server>", "my lobby server", "lobby", "https://",
    ]) expect(lobbyServerUrl(bad), String(bad)).toBeNull();
  });
});
