// verify: a host it starts for a this-PC-only check must not listen beyond 127.0.0.1 (sockets.js). The parsers get canned socket tables;
// the judge gets a negative control for every verdict; the real sampler is checked against a loopback listener this test opens itself
// (a listener on all interfaces is never opened by a test: it would raise the firewall prompt this check exists to prevent).
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { isLoopbackAddress, judgeSockets, parseNetstat, parseProcesses, parseSs, pidTree, systemSampler, twinListeners, watchOption, watchSockets } from "../src/verify/sockets.js";

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1100
  TCP    127.0.0.1:41000        0.0.0.0:0              LISTENING       7000
  TCP    127.0.0.1:41000        127.0.0.1:50000        ESTABLISHED     7000
  TCP    [::]:54233             [::]:0                 LISTENING       7000
  TCP    [::1]:42000            [::]:0                 LISTENING       7001
  UDP    0.0.0.0:5353           *:*                                    1200
  UDP    127.0.0.1:41000        *:*                                    7000
  UDP    [fe80::1%12]:1900      *:*                                    1300
`;

const SS = `tcp LISTEN 0 4096 127.0.0.1:41000 0.0.0.0:* users:(("godot",pid=7000,fd=9))
tcp LISTEN 0 4096 0.0.0.0:54233 0.0.0.0:* users:(("godot",pid=7000,fd=10))
udp UNCONN 0 0 [::]:54233 [::]:* users:(("godot",pid=7000,fd=11))
udp UNCONN 0 0 0.0.0.0:68 0.0.0.0:*
`;

describe("socket tables", () => {
  it("netstat -ano: listening TCP and every bound UDP socket, with their pid; established rows and headers are left out", () => {
    const rows = parseNetstat(NETSTAT);
    expect(rows).toEqual([
      { proto: "tcp", addr: "0.0.0.0", port: 135, pid: 1100 },
      { proto: "tcp", addr: "127.0.0.1", port: 41000, pid: 7000 },
      { proto: "tcp", addr: "::", port: 54233, pid: 7000 },
      { proto: "tcp", addr: "::1", port: 42000, pid: 7001 },
      { proto: "udp", addr: "0.0.0.0", port: 5353, pid: 1200 },
      { proto: "udp", addr: "127.0.0.1", port: 41000, pid: 7000 },
      { proto: "udp", addr: "fe80::1", port: 1900, pid: 1300 },
    ]);
  });
  it("ss -lntup: the same rows; a socket whose process ss does not name is left out", () => {
    expect(parseSs(SS)).toEqual([
      { proto: "tcp", addr: "127.0.0.1", port: 41000, pid: 7000 },
      { proto: "tcp", addr: "0.0.0.0", port: 54233, pid: 7000 },
      { proto: "udp", addr: "::", port: 54233, pid: 7000 },
    ]);
  });
  it("the process table: a process and every child below it, not a sibling", () => {
    const procs = parseProcesses("1 0\n7000 1\n7001 7000\n7002 7001\n8000 1\nnot a row\n");
    expect([...pidTree(procs, 7000)].sort()).toEqual([7000, 7001, 7002]);
  });
  it("loopback means 127.x, ::1, localhost and the mapped form; 0.0.0.0, :: and a LAN address are beyond this PC", () => {
    for (const a of ["127.0.0.1", "127.9.9.9", "::1", "[::1]", "localhost", "::ffff:127.0.0.1", "::1%1"]) expect(isLoopbackAddress(a), a).toBe(true);
    for (const a of ["0.0.0.0", "::", "[::]", "192.168.1.20", "fe80::1", "*", ""]) expect(isLoopbackAddress(a), a).toBe(false);
  });
});

const sockets = (listeners, extra = {}) => ({ samples: 4, listeners, wide: listeners.filter((l) => !isLoopbackAddress(l.addr)), error: null, ...extra });
const loop = { proto: "tcp", addr: "127.0.0.1", port: 41000, pid: 7000 };
const wide = { proto: "tcp", addr: "::", port: 54233, pid: 7000 };

describe("judging what a started host listened on", () => {
  it("negative control: a listener on all interfaces fails an otherwise passing check, names the address and says how to bind loopback", () => {
    const res = judgeSockets({ status: "ok", detail: "two peers on 127.0.0.1" }, sockets([loop, wide]));
    expect(res.status).toBe("fail");
    expect(res.detail).toContain("listened beyond 127.0.0.1: TCP [::]:54233 (pid 7000)");
    expect(res.next).toContain("BindAddress");
    expect(res.next).toContain("listen_address");
  });
  it("loopback only passes, and the passing line says what was seen", () => {
    const res = judgeSockets({ status: "ok", detail: "two peers on 127.0.0.1" }, sockets([loop, { ...loop, proto: "udp" }]));
    expect(res).toEqual({ status: "ok", detail: "two peers on 127.0.0.1; no listener beyond 127.0.0.1 (2 listeners in 4 samples)" });
  });
  it("an unreadable socket table is said, not passed: the result stays ok but carries a warning", () => {
    const res = judgeSockets({ status: "ok", detail: "d" }, sockets([], { samples: 0, error: "no socket table reader for darwin" }));
    expect(res.status).toBe("ok");
    expect(res.warning).toContain("bound addresses NOT checked");
    expect(res.warning).toContain("darwin");
    expect(res.detail).toBe("d");
  });
  it("a run that caught no listener at all is said too (it never reads as all loopback)", () => {
    const res = judgeSockets({ status: "ok", detail: "d", warning: "w" }, sockets([]));
    expect(res.warning).toMatch(/^w; bound addresses NOT checked: no listening socket of the started process was caught in 4 samples/);
    expect(res.detail).toBe("d");
  });
  it("a check that already failed stays failed, and a wide listener is added to its text", () => {
    const res = judgeSockets({ status: "fail", detail: "never linked", next: "n" }, sockets([wide]));
    expect(res).toMatchObject({ status: "fail", next: "n" });
    expect(res.detail).toMatch(/^never linked; also a host started by this check listened beyond 127\.0\.0\.1: TCP \[::\]:54233/);
    expect(judgeSockets({ status: "fail", detail: "x", next: "n" }, sockets([loop]))).toEqual({ status: "fail", detail: "x", next: "n" });
  });
  it("no sockets object (a fake run in a test) changes nothing", () => {
    const res = { status: "ok", detail: "d" };
    expect(judgeSockets(res, undefined)).toBe(res);
  });
  it("Unity: the editor's own sockets on all interfaces are not judged; a TCP and UDP pair on one port (the direct host) is", () => {
    const editor = [{ proto: "tcp", addr: "0.0.0.0", port: 34999, pid: 7000 }, { proto: "udp", addr: "0.0.0.0", port: 54997, pid: 7000 }, loop];
    const ok = judgeSockets({ status: "ok", detail: "d" }, sockets(editor), { engine: "unity" });
    expect(ok.status).toBe("ok");
    expect(ok.detail).toContain("the editor's own sockets are not judged");
    const host = [...editor, { proto: "tcp", addr: "0.0.0.0", port: 47810, pid: 7000 }, { proto: "udp", addr: "0.0.0.0", port: 47810, pid: 7000 }];
    const bad = judgeSockets({ status: "ok", detail: "d" }, sockets(host), { engine: "unity" });
    expect(bad.status).toBe("fail");
    expect(bad.detail).toContain("TCP 0.0.0.0:47810 (pid 7000), UDP 0.0.0.0:47810 (pid 7000)");
    expect(bad.detail).not.toContain("34999");
    expect(twinListeners(host.filter((l) => !isLoopbackAddress(l.addr))).map((l) => l.port)).toEqual([47810, 47810]);
  });
  it("Godot: its WebRTC extension binds the ICE UDP sockets on every interface (seen in a real --local run), so a lone wide UDP socket is said, not judged; a wide TCP listener or a TCP+UDP pair fails", () => {
    const ice = [{ proto: "udp", addr: "0.0.0.0", port: 52458, pid: 7000 }, { proto: "udp", addr: "::", port: 52458, pid: 7000 }, { proto: "udp", addr: "0.0.0.0", port: 52459, pid: 7000 }];
    const ok = judgeSockets({ status: "ok", detail: "d" }, sockets([loop, ...ice]), { engine: "godot-gdscript" });
    expect(ok.status).toBe("ok");
    expect(ok.detail).toContain("no TCP listener or TCP+UDP pair beyond 127.0.0.1; 3 UDP sockets of Godot's WebRTC extension listen on every interface and are not judged");
    // negative controls: the same engine still fails on what OneLobby's own host opens
    const tcp = judgeSockets({ status: "ok", detail: "d" }, sockets([...ice, { proto: "tcp", addr: "::", port: 47810, pid: 7000 }]), { engine: "godot-csharp" });
    expect(tcp.status).toBe("fail");
    expect(tcp.detail).toContain("TCP [::]:47810 (pid 7000)");
    expect(tcp.detail).not.toContain("52458");
    const pair = judgeSockets({ status: "ok", detail: "d" }, sockets([{ proto: "tcp", addr: "0.0.0.0", port: 47810, pid: 7000 }, { proto: "udp", addr: "0.0.0.0", port: 47810, pid: 7000 }]), { engine: "godot-gdscript" });
    expect(pair.status).toBe("fail");
    expect(pair.detail).toContain("UDP 0.0.0.0:47810 (pid 7000)");
    // any other engine judges everything
    expect(judgeSockets({ status: "ok", detail: "d" }, sockets(ice), { engine: "dotnet" }).status).toBe("fail");
  });
  it("only the routes that start a host are watched, and a test can switch the watch off", () => {
    expect(watchOption({}, "direct")).toEqual({});
    expect(watchOption({}, "nostr")).toEqual({});
    expect(watchOption({}, "config")).toBeUndefined();
    expect(watchOption({}, "server")).toBeUndefined();
    expect(watchOption({ watchSockets: false }, "direct")).toBeUndefined();
  });
});

describe("watching a process", () => {
  it("keeps the listeners of the process and its children, not of anything else, and reports a wide one", async () => {
    const tables = [
      { listeners: [{ proto: "tcp", addr: "0.0.0.0", port: 135, pid: 1100 }], procs: [{ pid: 7000, ppid: 1 }, { pid: 1100, ppid: 1 }] },
      { listeners: [{ proto: "tcp", addr: "127.0.0.1", port: 41000, pid: 7001 }, { proto: "udp", addr: "0.0.0.0", port: 41001, pid: 7001 }], procs: [{ pid: 7000, ppid: 1 }, { pid: 7001, ppid: 7000 }] },
    ];
    let i = 0;
    const w = watchSockets(7000, { sampler: async () => tables[Math.min(i++, tables.length - 1)], intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 60));
    const out = await w.stop();
    expect(out.error).toBeNull();
    expect(out.listeners.map((l) => l.port).sort()).toEqual([41000, 41001]);
    expect(out.wide.map((l) => `${l.proto} ${l.addr}:${l.port}`)).toEqual(["udp 0.0.0.0:41001"]);
  });
  it("a sampler that always fails ends as an error, not as a clean pass", async () => {
    const w = watchSockets(7000, { sampler: async () => { throw new Error("boom"); }, intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    const out = await w.stop();
    expect(out).toMatchObject({ samples: 0, error: "boom", listeners: [], wide: [] });
    expect(judgeSockets({ status: "ok", detail: "d" }, out).warning).toContain("NOT checked");
  });
  it.runIf(process.platform === "win32" || process.platform === "linux")("the real sampler sees a loopback listener of this very process and calls it loopback", async () => {
    // a machine without `ss` or `ps` (a bare container) cannot show it: that is what the "NOT checked" warning is for, not a failure of this test
    if (!(await systemSampler().then(() => true, () => false))) return;
    const server = createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const w = watchSockets(process.pid, { intervalMs: 100 });
      await new Promise((r) => setTimeout(r, 1500));
      const out = await w.stop();
      expect(out.error).toBeNull();
      expect(out.listeners.some((l) => l.proto === "tcp" && l.addr === "127.0.0.1" && l.port === port && l.pid === process.pid)).toBe(true);
      expect(out.wide.some((l) => l.port === port)).toBe(false);
      expect(judgeSockets({ status: "ok", detail: "d" }, out).status).toBe("ok");
    } finally {
      server.close();
    }
  }, 30000);
  it("the real sampler refuses a platform it cannot read, by name", async () => {
    await expect(systemSampler("darwin")).rejects.toThrow("no socket table reader for darwin");
  });
});
