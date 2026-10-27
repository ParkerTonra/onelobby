// Publish readiness: what `npm pack` would ship, the <script src> bundle, and the public export surface.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import * as root from "../src/index.js";
import * as internals from "../src/internals.js";
import * as ui from "../src/ui/index.js";

/** What the single-file bundles expose: the root API plus the drop-in UI. */
const bundleNames = [...new Set([...Object.keys(root), ...Object.keys(ui)])].sort();

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (f: string) => join(pkgDir, "dist", f);

beforeAll(() => {
  // `npm test` alone (no build yet) still checks the real artifacts.
  if (!existsSync(dist("onelobby.global.js")) || !existsSync(dist("internals.js"))) {
    execSync("npm run build", { cwd: pkgDir, stdio: "pipe" });
  }
}, 120_000);

describe("npm pack", () => {
  it("ships bundles, types, README and LICENSE and nothing else", () => {
    const out = execSync("npm pack --dry-run --json --ignore-scripts", { cwd: pkgDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path.replace(/\\/g, "/"));
    for (const f of [
      "package.json", "README.md", "LICENSE", "blueprint.schema.json",
      "dist/index.js", "dist/index.d.ts", "dist/internals.js", "dist/internals.d.ts", "dist/testing.js", "dist/testing.d.ts",
      "dist/onelobby.global.js", "dist/onelobby.global.js.map", "dist/onelobby.global.min.js", "dist/onelobby.global.min.js.map",
      "dist/onelobby.bundle.mjs", "dist/onelobby.bundle.mjs.map", "dist/onelobby.bundle.js", "dist/onelobby.bundle.js.map", "dist/global.d.ts", "dist/ui/index.js", "dist/ui/index.d.ts",
    ]) expect(files, f).toContain(f);
    const bad = files.filter((f) => /node_modules|(^|\/)test\/|\.test\.|^src\/|^scripts\/|tsconfig|\.tsbuildinfo$|\.tgz$/.test(f));
    expect(bad).toEqual([]);
    for (const f of files) expect(f, f).toMatch(/^(package\.json|README\.md|LICENSE|blueprint\.schema\.json|dist\/)/);
  }, 60_000);

  it("every exports target exists", () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const targets: string[] = [];
    const walk = (v: unknown) => (typeof v === "string" ? targets.push(v) : v && typeof v === "object" && Object.values(v).forEach(walk));
    walk(pkg.exports);
    targets.push(pkg.main, pkg.types, pkg.unpkg, pkg.jsdelivr);
    for (const t of targets) expect(existsSync(join(pkgDir, t)), t).toBe(true);
  });
});

describe("script-tag bundle", () => {
  for (const file of ["onelobby.global.js", "onelobby.global.min.js"]) {
    it(`${file} sets window.OneLobby in a bare sandbox`, () => {
      // No DOM, no WebSocket, no RTCPeerConnection: loading must not touch browser APIs beyond TextEncoder/Decoder.
      const sandbox: Record<string, unknown> = { TextEncoder, TextDecoder };
      sandbox.window = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(readFileSync(dist(file), "utf8"), sandbox, { filename: file });
      const K = (sandbox.window as { OneLobby: Record<string, unknown> }).OneLobby;
      expect(typeof K.OneLobby).toBe("function");
      expect(typeof K.Lobby).toBe("function");
      expect((K.normalizeCode as (s: string) => string | null)("7hq-4k2")).toBe("7HQ4K2");
      expect(Object.keys(K).sort()).toEqual(bundleNames);
      expect(typeof K.defineLobbyElement).toBe("function");
    });
  }

  it("bundle.mjs exports the same names", async () => {
    const mod = await import(/* @vite-ignore */ "file://" + dist("onelobby.bundle.mjs").replace(/\\/g, "/"));
    expect(Object.keys(mod).sort()).toEqual(bundleNames);
  });
});

describe("export surface", () => {
  it("root is the small public API", () => {
    expect(Object.keys(root).sort()).toEqual([
      "CHAT_MAX_BYTES", "Chat", "DEFAULT_READY_TIMEOUT_MS", "OneLobby", "OneLobbyError", "LIB_NAME", "LIB_VERSION", "Pause",
      "Lobby", "Lockstep", "Voice", "codeFromUrl", "describeError", "directJoinInfo", "formatCode", "normalizeCode", "shareUrl",
      "webCodecsOpusAvailable", "decodeJoinCode", "looksLikeJoinCode", "webRtcLinkFactoryFor",
      "MIN_PEER_TIMEOUT_MS", "closeCodeFor", "ErrorCodes",
      "checkNostrRelays", "DEFAULT_NOSTR_RELAYS", "DEFAULT_NOSTR_STUN", "encodeRoomCode",
      "parseBlueprint", "defineBlueprint", "BlueprintError", "Keepalive", "KeepaliveError", // deprecated pre-rename aliases, one version
    ].sort());
  });

  it("deprecated Keepalive names are the OneLobby classes", () => {
    expect(root.Keepalive).toBe(root.OneLobby);
    expect(root.KeepaliveError).toBe(root.OneLobbyError);
  });

  it("internals keeps everything the root used to export", () => {
    const before = [
      "OneLobby", "LIB_NAME", "LIB_VERSION", "Lobby", "Lockstep", "MAX_DESYNCS", "HOST_SILENCE_MS", "Chat", "ChatLimiter",
      "sanitizeChat", "CHAT_MAX_BYTES", "CHAT_HISTORY_LINES", "Voice", "JitterBuffer", "VoiceGate", "VoicePacketizer",
      "VoiceRelayPolicy", "FRAME_SAMPLES", "SAMPLE_RATE", "MAX_SPEAKERS", "webCodecsOpus", "webCodecsOpusAvailable",
      "WorkletMic", "WebAudioSink", "pickNewHost", "claimWins", "claimWinsWrapped", "normalizeCode", "formatCode",
      "decodeCrockford", "encodeCrockford", "CROCKFORD_ALPHABET", "encodeMessage", "decodeMessage", "CodecError",
      "MAX_FRAME_BYTES", "MsgType", "splitChunks", "Reassembler", "CHUNK_PAYLOAD", "OneLobbyError", "SignalingClient",
      "WebRtcLink", "webRtcLinkFactory", "systemClock", "Gridpaint", "paintCmd", "colourOf", "PALETTE", "GRID_W", "GRID_H",
      "seedFromCode", "fnv1a64",
    ];
    for (const name of before) expect(internals, name).toHaveProperty(name);
    for (const name of Object.keys(root)) expect((internals as Record<string, unknown>)[name]).toBe((root as Record<string, unknown>)[name]);
  });
});
