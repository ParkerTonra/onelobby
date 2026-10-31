// conformance/peer adapter for the GDScript client. Run from the repo root:
//   GODOT=/path/to/godot node conformance/peer/run.mjs --adapter=clients/gdscript/conformance-adapter.mjs
// Starts headless Godot on tests/conformance_adapter.gd, which connects back over TCP and speaks the same JSON lines
// as a --stdio adapter (Godot has no non-blocking stdin). GODOT defaults to `godot` on PATH.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const godot = process.env.GODOT || "godot";

export default function createAdapter() {
  let handler = () => {};
  const pending = new Map();
  let nextId = 1;
  let sock = null;
  let dead = null;
  let buf = "";
  let onConnect;
  const connected = new Promise((r) => { onConnect = r; });

  const server = createServer((s) => {
    sock = s;
    s.setEncoding("utf8");
    s.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== undefined && pending.has(m.id)) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          if (m.ok === false) p.reject(new Error(`adapter error: ${m.error}`)); else p.resolve(m.result ?? {});
        } else if (m.ev) handler(m);
      }
    });
    s.on("close", () => fail("godot closed the connection"));
    onConnect();
  });
  let child = null;
  server.listen(0, "127.0.0.1", () => {
    const args = ["--headless", "--audio-driver", "Dummy", "--path", here, "-s", "res://tests/conformance_adapter.gd",
      "--", `--adapter-port=${server.address().port}`];
    child = spawn(godot, args, { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", (e) => { fail(`could not start Godot (${godot}): ${e.message}; set GODOT`); onConnect(); });
    child.on("exit", (code) => { fail(`godot exited (${code})`); onConnect(); });
  });

  function fail(why) {
    if (dead) return;
    dead = why;
    for (const p of pending.values()) p.reject(new Error(why));
    pending.clear();
  }

  return {
    set onevent(h) { handler = h; },
    async call(op, args = {}) {
      await connected;
      if (dead) throw new Error(dead);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        sock.write(JSON.stringify({ id, op, ...args }) + "\n");
      });
    },
    async dispose() {
      dead = dead ?? "disposed";
      sock?.end();
      server.close();
      if (child && child.exitCode === null) setTimeout(() => child.kill(), 500).unref();
    },
  };
}
