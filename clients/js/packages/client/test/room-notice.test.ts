import { describe, expect, it } from "vitest";
import { removalReason } from "../src/room-rules.js";
import { flush, hostWith, joiner, newRig } from "./room-helpers.js";

type Inner = { onSignaling(m: unknown): void };
const notice = (code: string, extra: Record<string, unknown> = {}) => ({
  t: "error", code: "kicked", msg: "kicked", data: { code, closeReason: removalReason(code, ""), ...extra },
});

describe("room: the hub's kick notice arrives before the host's deny frame (forced order)", () => {
  for (const code of ["bad_password", "banned"]) {
    it(`a joiner the host has not answered yet is refused (${code}): ban false, the error names the code, the session ends once`, async () => {
      const r = newRig();
      const { lobby: host } = await hostWith(r);
      const a = await joiner(r, host, "Ann");
      const errors: string[] = [];
      a.k.on("error", (e) => errors.push((e as { code?: string }).code ?? e.message));
      const ended: string[] = [];
      a.lobby.on("sessionEnded", (why: string) => ended.push(why));
      let removed = 0;
      a.lobby.room.on("removed", () => removed++);
      (a.lobby.room as unknown as { supported: boolean | undefined }).supported = undefined; // the host's answer has not arrived
      (a.lobby as unknown as Inner).onSignaling(notice(code, { ban: false }));
      await flush();
      expect(a.lobby.removal).toEqual({ code, reason: removalReason(code, ""), ban: false });
      expect(errors).toContain(code);
      expect(ended).toHaveLength(1);
      expect(removed).toBe(1);
    });
  }

  it("a joiner already in the room that is kicked with ban true still reads ban true", async () => {
    const r = newRig();
    const { lobby: host } = await hostWith(r);
    const a = await joiner(r, host, "Ann");
    expect(a.lobby.room.supported).toBe(true);
    (a.lobby as unknown as Inner).onSignaling(notice("banned"));
    await flush();
    expect(a.lobby.removal).toEqual({ code: "banned", reason: removalReason("banned", ""), ban: true });
  });
});
