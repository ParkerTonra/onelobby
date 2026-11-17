import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { NetLog, OneLobby, describeError } from "../src/index.js";
import { netLogEnvPath } from "../src/netlog.js";
import type { PeerDiagnosis } from "../src/lobby.js";
import type { LinkFactory, PeerLink } from "../src/transport.js";
import { ManualClock, MemoryNetwork, MemoryServer, settle } from "../src/testing.js";

const tmp: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "onelobby-netlog-"));
  tmp.push(d);
  return d;
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A link whose ICE never completes: it never opens, and tells nothing about itself. */
class DeadLink implements PeerLink {
  isOpen = false;
  onSignal: PeerLink["onSignal"] = null;
  onOpen: PeerLink["onOpen"] = null;
  onClose: PeerLink["onClose"] = null;
  onMessage: PeerLink["onMessage"] = null;
  constructor(readonly remoteId: number) {}
  startOffer() {}
  handleSignal() {}
  send() {}
  close() {}
}

function world() {
  const clock = new ManualClock();
  const server = new MemoryServer();
  server.features = ["set_name", "room", "diag"];
  const net = new MemoryNetwork();
  const make = (name: string, extra: Partial<ConstructorParameters<typeof OneLobby>[0]> = {}, links?: LinkFactory) =>
    new OneLobby({
      gameId: "gridpaint", netVersion: "1", lobbyServer: "mem://server", mode: "raw", displayName: name, ...extra,
      advanced: { socketFactory: server.socketFactory, linkFactory: links ?? net.factoryFor(name), clock, wallClock: () => 0, voiceCodec: null, createMic: null, createSink: null, storage: null },
    });
  return { clock, server, net, make };
}

describe("the kit's net log", () => {
  it("records the connection steps with timings, codes and the client line, and no address", async () => {
    const w = world();
    const la = await w.make("alice").host({ name: "t", maxPlayers: 4 });
    const kb = w.make("bob");
    const lb = await kb.join(la.code);
    await lb.ready;
    await settle();
    const kinds = new Set(kb.netLog.entries.map((e) => e.kind));
    for (const k of ["info", "sig", "lobby", "chan"]) expect(kinds.has(k as never), k).toBe(true);
    const text = kb.netLog.export();
    const lines = text.trimEnd().split("\n");
    expect(lines.slice(0, 4)).toEqual([
      "# onelobby netlog v1",
      expect.stringMatching(/^# client onelobby-js 0\.8\.1 protocol lk1 platform (node .+|browser)$/),
      expect.stringMatching(/^# entries \d+ dropped 0$/),
      "# addresses masked",
    ]);
    for (const l of lines.slice(4)) expect(l).toMatch(/^#\d+ \+\d+ms (sig|lobby|sdp|cand|ice|chan|route|retry|error|diag|info) /);
    expect(text).toMatch(/sig welcome features=set_name,room,diag ice=/);
    // monotonic timings
    const ts = kb.netLog.entries.map((e) => e.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("logSize sets the ring, and an error shows with its code", async () => {
    const w = world();
    const k = w.make("bob", { diagnostics: { logSize: 50 }, lobbyServer: "mem://server" });
    for (let i = 0; i < 80; i++) k.netLog.add("info", `n${i}`);
    expect(k.netLog.entries.length).toBe(50);
    const err = await w.make("zed").join("ZZZZZZ").catch((e: unknown) => e);
    expect(describeError(err).code).toBe("unknown_code");
    const e = w.make("zed2");
    await e.join("ZZZZZZ").catch(() => {});
    expect(e.netLog.export()).toMatch(/error unknown_code/);
  });

  it("a join code the hub refuses for another version names both versions", async () => {
    const w = world();
    const la = await w.make("alice", { netVersion: "1.5" }).host({ name: "t", maxPlayers: 4 });
    const kb = w.make("bob", { netVersion: "1.4" });
    const err = await kb.join(la.code).catch((e: unknown) => e);
    expect(describeError(err)).toMatchObject({ code: "version_mismatch", cause: "version_mismatch", message: "You have version 1.4, the host has 1.5." });
    expect(kb.netLog.export()).toMatch(/diag cause version_mismatch stage join/);
  });
});

describe("the host's event for a joiner's diagnosis", () => {
  it("fires with the roster name, the joiner's own sentence, the host hint and a line", async () => {
    const w = world();
    const la = await w.make("alice").host({ name: "t", maxPlayers: 4 });
    const seen: PeerDiagnosis[] = [];
    la.on("peerDiagnosis", (d) => seen.push(d));
    const dead: LinkFactory = { create: (o) => new DeadLink(o.remoteId) };
    const kb = w.make("bob", { readyTimeoutMs: 5000 }, dead);
    kb.on("error", () => {});
    const lb = await kb.join(la.code);
    let rejected: unknown = null;
    lb.ready.catch((e) => (rejected = e));
    await w.clock.run(5200, 100);
    await settle();
    const shown = describeError(rejected);
    expect(shown).toMatchObject({ code: "ice_failed", cause: "timeout_unknown", stage: "ice" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: "bob", cause: "timeout_unknown", stage: "ice", relaySet: false, message: shown.message, hint: "Ask them to copy their log and send it to you.", clientVersion: "0.8.1" });
    expect(seen[0].line).toBe("bob: unknown cause, stopped at the connection check after 5 s.");
    expect(seen[0].peer.peerId).toBe(2);
    expect(la.peers.map((p) => p.peerId)).toEqual([1]);
  });

  it("an old hub (no diag feature) or reportToHost false sends nothing", async () => {
    for (const mode of ["old hub", "switched off"]) {
      const w = world();
      if (mode === "old hub") w.server.features = ["set_name", "room"];
      const la = await w.make("alice").host({ name: "t", maxPlayers: 4 });
      const seen: PeerDiagnosis[] = [];
      la.on("peerDiagnosis", (d) => seen.push(d));
      const dead: LinkFactory = { create: (o) => new DeadLink(o.remoteId) };
      const kb = w.make("bob", { readyTimeoutMs: 3000, diagnostics: { reportToHost: mode !== "switched off" } }, dead);
      kb.on("error", () => {});
      const lb = await kb.join(la.code);
      lb.ready.catch(() => {});
      await w.clock.run(3200, 100);
      await settle();
      expect(seen, mode).toEqual([]);
      expect(kb.netLog.export(), mode).not.toMatch(/report sent/);
    }
  });

  it("the host keeps one report per peer per 10 s and ignores peers it does not know", async () => {
    const w = world();
    const la = await w.make("alice").host({ name: "t", maxPlayers: 4 });
    const lb = await w.make("bob").join(la.code);
    await lb.ready;
    const seen: PeerDiagnosis[] = [];
    la.on("peerDiagnosis", (d) => seen.push(d));
    const push = (from: number, cause = "nat_blocked") =>
      (la as unknown as { onDiag(m: object): void }).onDiag({ t: "diag", from, report: { cause, stage: "ice", elapsedMs: 15000, relaySet: false, candidateTypes: { local: [], remote: [] }, clientVersion: "0.7.2" } });
    push(2);
    push(2);
    push(9); // not in the roster
    push(2, "Bad Cause"); // not a valid report
    expect(seen.map((s) => s.peer.peerId)).toEqual([2]);
    await w.clock.run(10_500, 100);
    push(2, "relay_refused");
    expect(seen.map((s) => s.cause)).toEqual(["nat_blocked", "relay_refused"]);
    // a joiner never gets the event
    expect(typeof (lb as unknown as { onDiag: unknown }).onDiag).toBe("function");
    const got: unknown[] = [];
    lb.on("peerDiagnosis", (d) => got.push(d));
    (lb as unknown as { onDiag(m: object): void }).onDiag({ t: "diag", from: 1, report: {} });
    expect(got).toEqual([]);
  });
});

describe("saving and flushing the log", () => {
  it("save() writes the masked export, include-addresses on request, and the path comes from diagnostics.logPath", async () => {
    const d = dir();
    const path = join(d, "sub", "net.log");
    const k = new OneLobby({ gameId: "g", netVersion: "1", lobbyServer: "", rememberSeat: false, diagnostics: { logPath: path } });
    k.netLog.add("info", "peer 203.0.113.9:4000 reached", { addr: "203.0.113.9:4000" });
    expect(await k.netLog.save()).toBe(path);
    const masked = readFileSync(path, "utf8");
    expect(masked).toMatch(/info peer <ip4> reached\n$/);
    expect(masked).not.toContain("203.0.113.9");
    await k.netLog.save(join(d, "full.log"), { includeAddresses: true });
    expect(readFileSync(join(d, "full.log"), "utf8")).toMatch(/addr=203\.0\.113\.9:4000/);
    await expect(new NetLog().save()).rejects.toThrow(/no log path/);
  });

  it("a live log has every line on disk as it is added (no save, no exit); a plain one does not; the env variable asks for it", () => {
    const d = dir();
    const path = join(d, "sub", "live.log");
    const live = new NetLog({ path, live: true });
    expect(existsSync(path)).toBe(false);
    live.add("info", "first");
    live.add("sig", "dial 203.0.113.9:4000");
    const t = readFileSync(path, "utf8");
    expect(t).toMatch(/^# onelobby netlog v1/);
    expect(t).toContain("info first");
    expect(t).toContain("sig dial <ip4>");
    expect(t).not.toContain("203.0.113.9");
    const quiet = join(d, "quiet.log");
    new NetLog({ path: quiet }).add("info", "first");
    expect(existsSync(quiet)).toBe(false);
    expect(netLogEnvPath({ ONELOBBY_NETLOG: " x.log " })).toBe("x.log");
    expect(netLogEnvPath({ ONELOBBY_NETLOG: "  " })).toBeNull();
    expect(netLogEnvPath({})).toBeNull();
    // a kit built with the variable set writes its own file line by line
    const envFile = join(d, "kit.log");
    vi.stubEnv("ONELOBBY_NETLOG", envFile);
    new OneLobby({ gameId: "g", netVersion: "1", lobbyServer: "", rememberSeat: false });
    expect(readFileSync(envFile, "utf8")).toContain("client onelobby-js");
  });

  /** Runs `body` in a fresh Node process that has the log module bundled in. */
  function child(body: string, logPath: string) {
    const d = dir();
    const out = buildSync({ entryPoints: [join(__dirname, "../src/netlog.ts")], bundle: true, format: "esm", platform: "node", write: false });
    const file = join(d, "netlog.mjs");
    execFileSync(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(out.outputFiles[0].text)})`]);
    const code = `import { NetLog } from ${JSON.stringify("file:///" + file.replace(/\\/g, "/"))};
      const log = new NetLog({ path: ${JSON.stringify(logPath)} }); log.flushOnExit();
      log.add("info", "before the end 192.168.0.9"); ${body}`;
    return spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  }

  it("flushes on a normal exit", () => {
    const path = join(dir(), "exit.log");
    const r = child('process.exit(0);', path);
    expect(r.status).toBe(0);
    expect(existsSync(path)).toBe(true);
    const t = readFileSync(path, "utf8");
    expect(t).toMatch(/info before the end <ip4>/);
  });

  it("flushes on an uncaught error and the process still crashes", () => {
    const path = join(dir(), "crash.log");
    const r = child('setTimeout(() => { throw new Error("boom"); }, 5);', path);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("boom");
    expect(readFileSync(path, "utf8")).toMatch(/info before the end <ip4>/);
  });
});

describe("browsers: the last session survives a reload", () => {
  it("pagehide stores the entries in session storage and the next log can export them", () => {
    const store = new Map<string, string>();
    const handlers: Record<string, () => void> = {};
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    vi.stubGlobal("addEventListener", (e: string, f: () => void) => (handlers[e] = f));
    const a = new NetLog({ storageKey: "onelobby.netlog.g", meta: { client: "onelobby-js 0.7.2", platform: "browser" } });
    a.add("sig", "open route=server", { addr: "198.51.100.7:8080" });
    a.add("error", "ice_failed", { code: "ice_failed" });
    expect(a.exportLastSession()).toBeNull();
    handlers.pagehide();
    expect(store.get("onelobby.netlog.g")).toContain("ice_failed");

    const b = new NetLog({ storageKey: "onelobby.netlog.g", meta: { client: "onelobby-js 0.7.2", platform: "browser" } });
    const last = b.exportLastSession()!;
    expect(last).toMatch(/#1 \+\d+ms sig open route=server\n#2 \+\d+ms error ice_failed/);
    expect(last).not.toContain("198.51.100.7");
    expect(b.exportLastSession({ includeAddresses: true })).toContain("addr=198.51.100.7:8080");
    expect(b.entries).toEqual([]); // this session's log starts empty
  });

  it("download() hands the text to an anchor and returns it", () => {
    const clicks: string[] = [];
    vi.stubGlobal("document", { createElement: () => ({ set href(v: string) { clicks.push(v); }, set download(v: string) { clicks.push(v); }, click: () => clicks.push("click") }) });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    const log = new NetLog();
    log.add("info", "x");
    const text = log.download("my.log");
    expect(text).toContain("#1 ");
    expect(clicks).toEqual(["blob:x", "my.log", "click"]);
  });
});
