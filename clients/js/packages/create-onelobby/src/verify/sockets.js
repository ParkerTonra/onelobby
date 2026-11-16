// What a process `verify` starts listens on, seen from the operating system's socket table while the check runs.
// `verify` is a this-PC-only run: a host that listens on 0.0.0.0, `::` or a LAN address (a game that never put its `BindAddress`
// / `listen_address` on 127.0.0.1) is a check that must fail, even when every route test is green and nothing on the network ever
// reached it (a Windows firewall prompt is the first symptom a person gets). The route tests of the scaffolder bind loopback by
// construction, so this check is the one that catches a game's own host start-up.
//
// How: every ~1 s while a spawned process runs, read the socket table (Windows `netstat -ano`, Linux `ss -H -lntup`) and the
// process table (to take the spawned process and every child of it), keep the listening TCP sockets and the bound UDP sockets of those
// pids. A listener that lives shorter than the sample interval is not seen: the result says how many samples and listeners it did see,
// and a run that saw none says so (it never passes silently as "all loopback").
import { execFile } from "node:child_process";

/** The `watch` option of a route run: the routes that start a host are watched (not `config`, which hosts nothing, nor `server`); `ctx.watchSockets === false` switches it off (tests). */
export const watchOption = (ctx, route) => (ctx.watchSockets === false || route === "config" || route === "server" ? undefined : ctx.watchSockets && typeof ctx.watchSockets === "object" ? ctx.watchSockets : {});

/** True for an address that stays on this PC: 127.x.x.x, ::1 (also written [::1]), localhost, an IPv4-mapped 127.x. */
export function isLoopbackAddress(addr) {
  const a = String(addr).trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  return a === "::1" || a === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(a) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(a);
}

/** `addr:port`, `[addr]:port`, `addr%scope:port` and `*:*` of a socket table: { addr, port } (port 0 for `*`). */
function splitEndpoint(text) {
  const t = text.trim();
  const m = /^(\[[^\]]+\]|[^:]+|[0-9a-f:.]+?):(\d+|\*)$/i.exec(t);
  if (!m) return null;
  return { addr: m[1].replace(/^\[|\]$/g, "").replace(/%.*$/, ""), port: m[2] === "*" ? 0 : Number(m[2]) };
}

/** `netstat -ano` text (Windows) -> [{ proto: "tcp"|"udp", addr, port, pid }]: LISTENING TCP sockets and every bound UDP socket. */
export function parseNetstat(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === "TCP" && cols.length >= 5 && cols[3] === "LISTENING") {
      const e = splitEndpoint(cols[1]);
      if (e) out.push({ proto: "tcp", ...e, pid: Number(cols[4]) });
    } else if (cols[0] === "UDP" && cols.length >= 4) {
      const e = splitEndpoint(cols[1]);
      if (e) out.push({ proto: "udp", ...e, pid: Number(cols[cols.length - 1]) });
    }
  }
  return out.filter((l) => Number.isFinite(l.pid));
}

/** `ss -H -lntup` text (Linux) -> the same rows (a socket whose process `ss` may not name is left out: it is not ours to see). */
export function parseSs(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^(tcp|udp)/.test(cols[0])) continue;
    const e = splitEndpoint(cols[4]);
    const pid = /pid=(\d+)/.exec(line)?.[1];
    if (e && pid) out.push({ proto: cols[0].startsWith("tcp") ? "tcp" : "udp", ...e, pid: Number(pid) });
  }
  return out;
}

/** `<pid> <ppid>` per line -> [{ pid, ppid }]. */
export function parseProcesses(text) {
  return text
    .split(/\r?\n/)
    .map((l) => /^\s*(\d+)\s+(\d+)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]) }));
}

/** `root` and every process below it in `procs` ([{ pid, ppid }]), as a Set of pids. */
export function pidTree(procs, root) {
  const tree = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) if (!tree.has(p.pid) && tree.has(p.ppid)) (tree.add(p.pid), (grew = true));
  }
  return tree;
}

const exec = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );

/** The listening sockets of this machine now, or throws (the caller reports "not observed"). */
async function readListeners(platform) {
  if (platform === "win32") return parseNetstat(await exec("netstat", ["-ano"]));
  if (platform === "linux") return parseSs(await exec("ss", ["-H", "-lntup"]));
  throw new Error(`no socket table reader for ${platform}`);
}

/** The process table now ([{ pid, ppid }]). On Windows this is a PowerShell call (about 0.7 s): the watcher asks for it only now and then. */
async function readProcs(platform) {
  if (platform === "win32")
    return parseProcesses(await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }"]));
  if (platform === "linux") return parseProcesses(await exec("ps", ["-eo", "pid=,ppid="]));
  throw new Error(`no socket table reader for ${platform}`);
}

/** One reading of both tables: { listeners, procs }, or throws. */
export async function systemSampler(platform = process.platform) {
  const [listeners, procs] = await Promise.all([readListeners(platform), readProcs(platform)]);
  return { listeners, procs };
}

/**
 * The sampler a watch uses: the socket table every call (fast, so a host that lives for half a second is still caught) and the process
 * table in the background every 1.5 s (slow on Windows), handed out as last read. The watcher joins the tables when it stops.
 */
export function createSystemSampler(platform = process.platform) {
  let procs = [];
  let lastAt = 0;
  let inflight = null;
  return async () => {
    if (Date.now() - lastAt > 1500 && !inflight) {
      lastAt = Date.now();
      inflight = readProcs(platform).then((p) => (procs = p), () => {}).finally(() => (inflight = null));
    }
    const listeners = await readListeners(platform);
    return { listeners, procs };
  };
}

/**
 * Watch the sockets of `pid` and its children until `stop()`. `sampler`: a test seam ({ listeners, procs } per call); the default reads the
 * socket table every ~150 ms. A listener is kept with its pid whoever owns it, and which pids are `pid`'s children is decided when `stop()`
 * joins every process table seen, so a child that exits before the table lists it is still counted when any sample listed it.
 * `stop()` resolves { samples, listeners (every distinct one seen), wide (the ones beyond this PC), error }.
 */
export function watchSockets(pid, { sampler = createSystemSampler(), intervalMs = 150 } = {}) {
  const seen = new Map();
  const parent = new Map();
  let samples = 0;
  let error = null;
  let stopped = false;
  let timer = null;
  let inflight = Promise.resolve();
  const once = async () => {
    try {
      const { listeners, procs } = await sampler();
      samples++;
      for (const p of procs) parent.set(p.pid, p.ppid);
      for (const l of listeners) seen.set(`${l.proto} ${l.addr} ${l.port} ${l.pid}`, l);
    } catch (e) {
      error = e?.message ?? String(e);
    }
  };
  const tick = () => {
    if (stopped) return;
    inflight = once().finally(() => {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    });
  };
  tick();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inflight;
      await once(); // one last look
      const tree = pidTree([...parent].map(([p, ppid]) => ({ pid: p, ppid })), pid);
      const listeners = [...seen.values()].filter((l) => tree.has(l.pid));
      return { samples, listeners, wide: listeners.filter((l) => !isLoopbackAddress(l.addr)), error: samples === 0 ? (error ?? "no sample") : null };
    },
  };
}

/** The wide listeners that are OneLobby's own host: a TCP socket and a UDP socket of one process on the same port (the direct host's hub opens both). */
export function twinListeners(wide) {
  return wide.filter((l) => l.proto === "tcp" && wide.some((u) => u.proto === "udp" && u.pid === l.pid && u.port === l.port)).flatMap((l) => [l, ...wide.filter((u) => u.proto === "udp" && u.pid === l.pid && u.port === l.port)]);
}

const show = (l) => `${l.proto.toUpperCase()} ${l.addr.includes(":") ? `[${l.addr}]` : l.addr}:${l.port} (pid ${l.pid})`;

/**
 * Fold what a spawned process's sockets showed into a check result `res` (`{ status, detail, next?, warning? }`).
 * `engine` (the project kind): "unity" judges only a TCP+UDP pair on one port (the editor itself opens wide sockets of its own, which are not the
 * game's host); "godot-gdscript" and "godot-csharp" judge every TCP listener and a TCP+UDP pair: Godot's WebRTC extension binds its ICE UDP sockets
 * on every interface whatever the host asks for (it has no bind setting, a design limit of the engine), so a lone wide UDP socket is counted and said,
 * not judged; any other engine judges every listener of the process tree. A failed result stays failed (a wide listener is added to its text).
 * Never passes silently: a run that could not read the socket table, or saw no listener at all, carries a warning that says so.
 */
export function judgeSockets(res, sockets, { engine } = {}) {
  if (!sockets) return res;
  const godot = typeof engine === "string" && engine.startsWith("godot");
  const twins = twinListeners(sockets.wide);
  const judged = engine === "unity" ? twins : godot ? [...new Set([...sockets.wide.filter((l) => l.proto === "tcp"), ...twins])] : sockets.wide;
  if (judged.length) {
    const named = judged.map(show).join(", ");
    const why = `a host started by this check listened beyond 127.0.0.1: ${named} (it should only be reachable from this PC; another machine on the network could connect)`;
    const next = "Bind the host to loopback in this run: Unity runner `BindAddress = \"127.0.0.1\"` (or --bind-address=127.0.0.1), C# `DirectHostOptions.BindAddress = IPAddress.Loopback`, GDScript `listen_address: \"127.0.0.1\"` (the menu's --local does it), JS `hostDirect(kit, { local: true })`.";
    return res.status === "fail" ? { ...res, detail: `${res.detail}; also ${why}` } : { status: "fail", detail: why, next };
  }
  if (res.status !== "ok") return res;
  if (sockets.error) return { ...res, warning: [res.warning, `bound addresses NOT checked: the socket table could not be read (${sockets.error})`].filter(Boolean).join("; ") };
  const mine = sockets.listeners.length;
  if (mine === 0) return { ...res, warning: [res.warning, `bound addresses NOT checked: no listening socket of the started process was caught in ${sockets.samples} samples (it listens for less than a second, or too late)`].filter(Boolean).join("; ") };
  const engineUdp = sockets.wide.filter((l) => !judged.includes(l));
  const scope =
    engine === "unity"
      ? "no TCP+UDP host pair beyond 127.0.0.1 (the editor's own sockets are not judged)"
      : godot
        ? `no TCP listener or TCP+UDP pair beyond 127.0.0.1${engineUdp.length ? `; ${engineUdp.length} UDP socket${engineUdp.length === 1 ? "" : "s"} of Godot's WebRTC extension listen on every interface and are not judged (the extension has no bind setting: a limit of the engine)` : ""}`
        : "no listener beyond 127.0.0.1";
  const plural = mine === 1 ? "listener" : "listeners";
  return { ...res, detail: `${res.detail ? `${res.detail}; ` : ""}${scope} (${mine} ${plural} in ${sockets.samples} samples)` };
}

/** A run's socket findings go on the check's context (`ctx.watched`), where `runChecks` picks them up when the check ends. Returns `r`. */
export function record(ctx, r) {
  if (r?.sockets) (ctx.watched ??= []).push(r.sockets);
  return r;
}

/** Several runs of one check (a retry, a second process) as one finding: samples add up, an error only counts when no run was seen. */
export function mergeSockets(list) {
  const seen = new Map();
  for (const s of list) for (const l of s.listeners) seen.set(`${l.proto} ${l.addr} ${l.port} ${l.pid}`, l);
  const listeners = [...seen.values()];
  const samples = list.reduce((n, s) => n + s.samples, 0);
  return { samples, listeners, wide: listeners.filter((l) => !isLoopbackAddress(l.addr)), error: samples === 0 ? (list.find((s) => s.error)?.error ?? "no sample") : null };
}
