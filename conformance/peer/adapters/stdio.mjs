// Harness-side stdio adapter: spawns the library-under-test's adapter process and speaks JSON lines to it.
// Works for any language; see conformance/peer/README.md for the contract.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function createStdioAdapter(command, { cwd, env, log = null } = {}) {
  const child = spawn(command, { shell: true, cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let nextId = 1, handler = () => {}, dead = null;
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { log?.(`adapter stdout (not JSON): ${line.slice(0, 120)}`); return; }
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
      if (m.ok === false) p.reject(new Error(`adapter error: ${m.error}`)); else p.resolve(m.result ?? {});
    } else if (m.ev) handler(m);
  });
  child.on('exit', (code) => { dead = `adapter process exited (${code})`; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(dead)); } pending.clear(); });
  child.on('error', (e) => { dead = `adapter failed to start: ${e.message}`; });
  return {
    set onevent(h) { handler = h; },
    call(op, args = {}) {
      if (dead) return Promise.reject(new Error(dead));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`adapter did not answer ${op} within 10 s`)); }, 10_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
      });
    },
    async dispose() { try { child.stdin.end(); } catch { /* gone */ } setTimeout(() => child.kill(), 500).unref(); },
  };
}
