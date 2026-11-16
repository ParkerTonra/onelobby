// Child processes started by `verify`: tracked so none outlives the run (also on a failed check, a timeout or Ctrl+C).
import { execFileSync, spawn } from "node:child_process";

const live = new Set();

/** Kill a process and everything it started. Only ever called on processes this run spawned. */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

export function killAll() {
  for (const c of [...live]) killTree(c);
  live.clear();
}

/**
 * Run a command to its end (or `timeoutMs`), collecting stdout and stderr together.
 * Resolves { code, timedOut, out }; never rejects (a spawn error is { code: null, error }).
 * `onOutput(chunk)` sees the text as it arrives.
 */
export function run(cmd, args, { cwd, env, timeoutMs = 120000, onOutput } = {}) {
  return new Promise((resolve) => {
    let child;
    let out = "";
    let timedOut = false;
    try {
      child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    } catch (e) {
      resolve({ code: null, timedOut: false, out, error: e.message });
      return;
    }
    live.add(child);
    const take = (d) => {
      const s = d.toString("utf8");
      out += s;
      onOutput?.(s);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      live.delete(child);
      resolve({ code: null, timedOut, out, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      killTree(child); // anything the child left behind
      live.delete(child);
      resolve({ code, timedOut, out });
    });
  });
}
