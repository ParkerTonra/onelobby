// A tiny static server for development: `npm start`. No dependencies.
// It serves the page, src/, onelobby.json (never cached: edit it and reload) and the built onelobby library.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".map": "application/json" };
const allowed = (p) => p === "/" || p === "/index.html" || p === "/onelobby.json" || p.startsWith("/src/") || p.startsWith("/node_modules/onelobby/dist/");

/** Start the server; resolves to { server, port, url }. port 0 picks a free one. */
export async function startServer({ port = 5173, host = "127.0.0.1", root = defaultRoot } = {}) {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p === "/") p = "/index.html";
      const file = normalize(join(root, p));
      if (!allowed(p) || p.includes("..") || !file.startsWith(root + sep)) throw new Error("not served");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, host, resolve));
  const actual = server.address().port;
  return { server, port: actual, url: `http://${host}:${actual}/` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { url } = await startServer({ port: Number(process.env.PORT ?? 5173) });
  console.log(`Serving ${url}\nLobby server: type its address in the page, set hosting.lobbyServer in onelobby.json, or open ${url}?lobby=ws://127.0.0.1:8080/ws`);
}
