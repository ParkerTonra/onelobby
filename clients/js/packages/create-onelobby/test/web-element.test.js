// The `<one-lobby>` element's newer attributes (countdown, approve-joins, invite-base, invite-param; docs/recipes/menu.md, "Web") and the web
// template. The template's page is hand-wired (ui.kind "generated": its own Host / Join / Start controls over src/session.js), so it holds
// no <one-lobby> element and there is no attribute to write. These tests pin that fact and which attributes have a blueprint key, so
// the gap list in the docs stays true; when the page gains the element, they fail and say what to write.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { webProjectFiles } from "../src/files.js";
import { buildBlueprint } from "../src/blueprint.js";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(pkg, "vendor/blueprint.schema.json"), "utf8"));
const keys = (node, prefix = "") => Object.entries(node.properties ?? {}).flatMap(([k, v]) => [`${prefix}${k}`, ...keys(v, `${prefix}${k}.`)]);

describe("web template and the <one-lobby> attributes", () => {
  it("the page is hand-wired: no <one-lobby> element, so no attribute is written", async () => {
    const bp = await buildBlueprint({ game: { id: "com.example.g" }, engine: "web", sync: { mode: "lockstep" }, ui: { kind: "generated", entry: "Main page" }, lobby: { approveJoins: true }, room: { countdownSeconds: 5 } });
    const page = webProjectFiles({ blueprint: bp, dirName: "g" }).find((f) => f.path === "index.html").content;
    expect(page).not.toContain("<one-lobby");
    for (const attr of ["countdown=", "approve-joins", "invite-base", "invite-param"]) expect(page).not.toContain(attr);
  });

  it("two of the four attributes have a blueprint key (lobby.approveJoins, room.countdownSeconds); invite-base and invite-param have none", () => {
    const all = keys(schema);
    expect(all).toContain("lobby.approveJoins");
    expect(all).toContain("room.countdownSeconds");
    expect(all.filter((k) => /invite/i.test(k))).toEqual([]);
  });
});
