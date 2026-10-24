// Tiny dev server for the demo: node demo/serve.mjs [--port 5173] [--lobby ws://localhost:8080/ws]
// Serves demo/ at / and the built library (packages/client/dist) at /lib/. Rewrites the lobby-server <meta> tag.
// getUserMedia needs a secure context: http://localhost counts.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "../packages/client");
const dist = join(pkg, "dist");
const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const port = Number(arg("port", process.env.PORT ?? 5173));
const lobby = arg("lobby", process.env.KEEPALIVE_LOBBY ?? "ws://localhost:8080/ws");

if (!existsSync(join(dist, "internals.js")) || process.argv.includes("--build")) {
  console.log("building @keepalive/client ...");
  execSync("npx tsc -p tsconfig.build.json", { cwd: pkg, stdio: "inherit" });
}

const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".map": "application/json", ".css": "text/css" };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";
    const base = path.startsWith("/lib/") ? dist : here;
    const rel = normalize(path.startsWith("/lib/") ? path.slice(5) : path.slice(1));
    if (rel.startsWith("..")) throw new Error("bad path");
    let body = await readFile(join(base, rel));
    if (rel === "index.html") {
      body = Buffer.from(body.toString().replace(/(name="keepalive-lobby-server" content=")[^"]*/, `$1${lobby}`));
    }
    res.writeHead(200, { "content-type": types[extname(rel)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => console.log(`demo on http://localhost:${port}/  (lobby server ${lobby})`));
