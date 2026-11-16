import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZip, safeEntryName } from "../src/zip.js";
import { addAutoload } from "../src/godot-project.js";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  GITATTRIBUTES_LINES,
  GITIGNORE_LINES,
  WEBRTC_NATIVE_ZIP_SHA256,
  addonSource,
  applyBlock,
  buildPin,
  downloadNatives,
  nativesFromZip,
  normalizeBytes,
  sha256,
  verifyPin,
} from "../src/vendor.js";
import { fixtureNativesZip, makeZip } from "./helpers/zip.js";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "create-onelobby-vendor-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("zip reader", () => {
  it("reads stored and deflate entries and folders", () => {
    const es = readZip(makeZip([{ name: "a/" }, { name: "a/one.txt", data: "hello" }, { name: "a/two.txt", data: "x".repeat(5000), deflate: true }]));
    expect(es.map((e) => e.name)).toEqual(["a", "a/one.txt", "a/two.txt"]);
    expect(es[0].dir).toBe(true);
    expect(es[1].data().toString()).toBe("hello");
    expect(es[2].data().toString()).toBe("x".repeat(5000));
  });

  it("rejects every entry that could land outside the target folder", () => {
    for (const bad of ["../evil.txt", "a/../../evil.txt", "/etc/passwd", "C:/x.txt", "a\\..\\b.txt", "a//b.txt", "a/./b.txt", "x\0y"]) {
      expect(() => readZip(makeZip([{ name: bad, data: "x" }])), bad).toThrowError(/unsafe|escapes|absolute/);
    }
    expect(() => safeEntryName("ok/fine.txt")).not.toThrow();
  });

  it("checks the CRC-32 and the size of an entry", () => {
    const z = makeZip([{ name: "a.txt", data: "hello" }]);
    z[30 + "a.txt".length] ^= 1; // flip one byte of the stored data
    expect(() => readZip(z)[0].data()).toThrowError(/CRC-32/);
  });

  it("is not fooled by junk, a truncated file or an unsupported method", () => {
    expect(() => readZip(Buffer.from("not a zip"))).toThrowError(/end-of-archive/);
    const z = makeZip([{ name: "a.txt", data: "hello" }]);
    expect(() => readZip(z.subarray(0, z.length - 30))).toThrow();
    const m = makeZip([{ name: "a.txt", data: "hello" }]);
    m.writeUInt16LE(12, m.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10); // bzip2
    expect(() => readZip(m)[0].data()).toThrowError(/compression method 12/);
  });

  it("an error from the reader is a CliError with the bad_zip code", () => {
    expect.assertions(1);
    try {
      readZip(Buffer.from("nope"));
    } catch (e) {
      expect(e.code).toBe("bad_zip");
    }
  });
});

describe("natives", () => {
  it("unpacks the folder with the .gdextension file as addons/godot_webrtc/ (the layout fetch-webrtc.sh makes)", () => {
    const files = nativesFromZip(fixtureNativesZip());
    expect(files.map((f) => f.path)).toEqual([
      "addons/godot_webrtc/LICENSE.webrtc-native",
      "addons/godot_webrtc/lib/libwebrtc_native.windows.template_release.x86_64.dll",
      "addons/godot_webrtc/webrtc_native.gdextension",
    ]);
    expect(files[1].content.length).toBe(4096);
  });

  it("a zip with no .gdextension is refused", () => {
    expect(() => nativesFromZip(makeZip([{ name: "x/readme.txt", data: "hi" }]))).toThrowError(/no \.gdextension/);
  });

  it("the download is checked against the pinned SHA-256 and nothing else is accepted", async () => {
    const zip = fixtureNativesZip();
    const fake = (buf, ok = true, status = 200) => async () => ({ ok, status, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });
    expect((await downloadNatives({ fetchImpl: fake(zip), sha: sha256(zip) })).equals(zip)).toBe(true);
    await expect(downloadNatives({ fetchImpl: fake(zip) })).rejects.toMatchObject({ code: "bad_download" }); // the fixture is not the pinned build
    await expect(downloadNatives({ fetchImpl: fake(zip, false, 404), sha: sha256(zip) })).rejects.toMatchObject({ code: "download_failed" });
    await expect(
      downloadNatives({
        fetchImpl: async () => {
          throw new Error("offline");
        },
        sha: "x",
      }),
    ).rejects.toMatchObject({ code: "download_failed" });
    expect(WEBRTC_NATIVE_ZIP_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the add-on source and the pin", () => {
  const fakeAddon = (root) => {
    mkdirSync(join(root, "clients/gdscript/addons/onelobby/menu"), { recursive: true });
    writeFileSync(join(root, "clients/gdscript/addons/onelobby/client.gd"), "class_name OneLobbyClient\r\nextends Node\r\n");
    writeFileSync(join(root, "clients/gdscript/addons/onelobby/menu/menu.gd"), "extends Control\n");
    writeFileSync(join(root, "clients/gdscript/addons/onelobby/PIN.json"), "{}"); // a stray pin in the source is never vendored
  };

  it("--addon-from reads a checkout (LF-normalised text, sorted, no PIN.json)", () => {
    fakeAddon(dir);
    const src = addonSource({ addonFrom: dir });
    expect(src.files.map((f) => f.path)).toEqual(["client.gd", "menu/menu.gd"]);
    expect(src.files[0].content.toString()).toBe("class_name OneLobbyClient\nextends Node\n");
    expect(src.from).toBe("local");
    expect(addonSource({ addonFrom: join(dir, "clients/gdscript") }).files).toHaveLength(2); // also a clients/gdscript folder
    expect(addonSource({ addonFrom: join(dir, "clients/gdscript/addons/onelobby") }).files).toHaveLength(2); // or the add-on folder
    expect(() => addonSource({ addonFrom: join(dir, "nope") })).toThrowError(/no OneLobby GDScript add-on/);
  });

  it("the pin is deterministic, sorted and LF, with a SHA-256 per file", () => {
    fakeAddon(dir);
    const { files } = addonSource({ addonFrom: dir });
    const a = buildPin({ files, commit: "c".repeat(40), version: "1.2.3" });
    const b = buildPin({ files: [...files].reverse(), commit: "c".repeat(40), version: "1.2.3" });
    expect(a).toBe(b);
    expect(a.endsWith("}\n")).toBe(true);
    expect(a).not.toContain("\r");
    const pin = JSON.parse(a);
    expect(Object.keys(pin)).toEqual(["createOnelobby", "files", "source", "webrtcNative"]);
    expect(pin.createOnelobby).toBe("1.2.3");
    expect(pin.source.commit).toBe("c".repeat(40));
    expect(pin.files["client.gd"]).toBe(sha256(Buffer.from("class_name OneLobbyClient\nextends Node\n")));
  });

  it("verifyPin tells an untouched add-on from an edited, a deleted and an extended one", () => {
    fakeAddon(dir);
    const { files } = addonSource({ addonFrom: dir });
    const proj = join(dir, "game");
    mkdirSync(join(proj, "addons/onelobby/menu"), { recursive: true });
    for (const f of files) writeFileSync(join(proj, "addons/onelobby", ...f.path.split("/")), f.content);
    writeFileSync(join(proj, "addons/onelobby/PIN.json"), buildPin({ files, commit: "c".repeat(40) }));
    expect(verifyPin(proj)).toMatchObject({ ok: true, edited: [], missing: [], added: [] });
    // a CRLF checkout of the same text still counts as untouched
    writeFileSync(join(proj, "addons/onelobby/client.gd"), "class_name OneLobbyClient\r\nextends Node\r\n");
    expect(verifyPin(proj).ok).toBe(true);
    writeFileSync(join(proj, "addons/onelobby/client.gd"), "class_name OneLobbyClient\nextends Node\n# mine\n");
    writeFileSync(join(proj, "addons/onelobby/extra.gd"), "extends Node\n");
    rmSync(join(proj, "addons/onelobby/menu/menu.gd"));
    expect(verifyPin(proj)).toMatchObject({ ok: false, edited: ["client.gd"], missing: ["menu/menu.gd"], added: ["extra.gd"] });
    expect(verifyPin(join(dir, "clients"))).toMatchObject({ ok: false, error: "no_pin" });
  });

  it("normalizeBytes only touches text files", () => {
    expect(normalizeBytes("a.gd", Buffer.from("a\r\nb")).toString()).toBe("a\nb");
    const bin = Buffer.from([1, 13, 10, 2]);
    expect(normalizeBytes("lib/x.dll", bin)).toBe(bin);
  });
});

describe(".gitignore and .gitattributes blocks", () => {
  it("makes the block for a missing or empty file", () => {
    expect(applyBlock(undefined, GITIGNORE_LINES)).toBe(`${BLOCK_BEGIN}\naddons/godot_webrtc/\n.godot/\n.onelobby/\n${BLOCK_END}\n`);
    expect(applyBlock("", GITATTRIBUTES_LINES)).toContain("addons/onelobby/** text eol=lf");
  });

  it("appends once after the file's own lines, and is idempotent", () => {
    const once = applyBlock("node_modules/\n*.log", GITIGNORE_LINES);
    expect(once.startsWith("node_modules/\n*.log\n\n" + BLOCK_BEGIN)).toBe(true);
    expect(applyBlock(once, GITIGNORE_LINES)).toBe(once);
    expect(once.split(BLOCK_BEGIN)).toHaveLength(2);
  });

  it("replaces a changed block in place and keeps what is around it", () => {
    const text = `before\n${BLOCK_BEGIN}\nold line\n${BLOCK_END}\nafter\n`;
    expect(applyBlock(text, ["new line"])).toBe(`before\n${BLOCK_BEGIN}\nnew line\n${BLOCK_END}\nafter\n`);
  });

  it("keeps CRLF files CRLF", () => {
    const out = applyBlock("a\r\nb\r\n", ["x"]);
    expect(out).toBe(`a\r\nb\r\n\r\n${BLOCK_BEGIN}\r\nx\r\n${BLOCK_END}\r\n`);
    expect(applyBlock(out, ["x"])).toBe(out);
  });

  it("a begin marker with no end marker is left alone and one fresh block is added", () => {
    const out = applyBlock(`${BLOCK_BEGIN}\nhalf\n`, ["x"]);
    expect(out.split(BLOCK_END)).toHaveLength(2);
  });
});

describe("project.godot autoload editor", () => {
  const ENTRY = 'Net="*res://net.gd"';

  it("appends an [autoload] section when there is none and keeps every other byte", () => {
    const src = 'config_version=5\n\n[application]\n\nconfig/name="x"\n';
    const r = addAutoload(src, "Net", "res://net.gd");
    expect(r.changed).toBe(true);
    expect(r.text).toBe(`${src}\n[autoload]\n\n${ENTRY}\n`);
  });

  it("a file with no final newline still gets a clean section", () => {
    expect(addAutoload('[application]\nconfig/name="x"', "Net", "res://net.gd").text).toBe(`[application]\nconfig/name="x"\n\n[autoload]\n\n${ENTRY}\n`);
  });

  it("fills an empty [autoload] section", () => {
    const r = addAutoload("[application]\n\n[autoload]\n\n[display]\nx=1\n", "Net", "res://net.gd");
    expect(r.text).toBe(`[application]\n\n[autoload]\n${ENTRY}\n\n[display]\nx=1\n`);
  });

  it("adds after the other entries of the section", () => {
    const src = '[autoload]\n\nGlobals="*res://globals.gd"\nAudio="*res://audio.gd"\n\n[display]\nx=1\n';
    const r = addAutoload(src, "Net", "res://net.gd");
    expect(r.text).toBe(`[autoload]\n\nGlobals="*res://globals.gd"\nAudio="*res://audio.gd"\n${ENTRY}\n\n[display]\nx=1\n`);
  });

  it("adds to a section that ends the file with no final newline", () => {
    expect(addAutoload('[autoload]\nA="*res://a.gd"', "Net", "res://net.gd").text).toBe(`[autoload]\nA="*res://a.gd"\n${ENTRY}`);
  });

  it("CRLF files stay CRLF everywhere", () => {
    const src = '[application]\r\nconfig/name="x"\r\n\r\n[autoload]\r\n\r\nA="*res://a.gd"\r\n\r\n[display]\r\nx=1\r\n';
    const r = addAutoload(src, "Net", "res://net.gd");
    expect(r.text).toBe('[application]\r\nconfig/name="x"\r\n\r\n[autoload]\r\n\r\nA="*res://a.gd"\r\n' + ENTRY + "\r\n\r\n[display]\r\nx=1\r\n");
    expect(r.text.replace(/\r\n/g, "")).not.toContain("\n");
    const none = addAutoload('[application]\r\nconfig/name="x"\r\n', "Net", "res://net.gd");
    expect(none.text).toBe(`[application]\r\nconfig/name="x"\r\n\r\n[autoload]\r\n\r\n${ENTRY}\r\n`);
  });

  it("does nothing when the entry is already there", () => {
    const src = `[autoload]\n\n${ENTRY}\n`;
    expect(addAutoload(src, "Net", "res://net.gd")).toEqual({ text: src, changed: false });
    const again = addAutoload(addAutoload("a=1\n", "Net", "res://net.gd").text, "Net", "res://net.gd");
    expect(again.changed).toBe(false);
  });

  it("accepts the same file written as a uid:// path", () => {
    const src = '[autoload]\n\nNet="*uid://b8abc"\n';
    expect(addAutoload(src, "Net", "res://net.gd", { resolveUid: (u) => (u === "uid://b8abc" ? "res://net.gd" : undefined) }).changed).toBe(false);
    expect(() => addAutoload(src, "Net", "res://net.gd")).toThrowError(/already has an autoload named Net/);
  });

  it("refuses with autoload_taken when the name points elsewhere", () => {
    for (const v of ['"*res://other/net.gd"', '"res://net.gd"']) {
      let err;
      try {
        addAutoload(`[autoload]\nNet=${v}\n`, "Net", "res://net.gd");
      } catch (e) {
        err = e;
      }
      expect(err?.code).toBe("autoload_taken");
      expect(err.message).toContain("Net");
    }
  });

  it("an entry in another section with the same name does not count", () => {
    expect(addAutoload('[other]\nNet="x"\n', "Net", "res://net.gd").changed).toBe(true);
  });
});
