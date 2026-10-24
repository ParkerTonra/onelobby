# Publishing onelobby to npm

Not shipped in the tarball (only `dist/`, `README.md`, `LICENSE`, `package.json` are). Version stays `0.1.0` until the
first publish.

## Name

`onelobby`, unscoped (checked free on npm 2026-10-24). No npm organization is needed. If someone takes it before the
first publish, fallbacks: `one-lobby`, `onelobby-client`.

## Once: before the first publish

1. Create the GitHub repo `https://github.com/ParkerTonra/onelobby` (package.json `homepage`, `repository.url` and
   `bugs.url` and the README docs links point there), and push this code to it. Without a public repo, delete those
   three package.json fields and the README links instead.
2. Log in: `npm login` (your account; turn on 2FA, npm asks for the code on publish).

## Publish

```
cd clients/js
npm ci
cd packages/client
npm publish --dry-run      # runs prepublishOnly: typecheck, build, tests, metadata check; prints the file list
npm publish                # access is public via publishConfig
```

Then check: https://www.npmjs.com/package/onelobby and
https://cdn.jsdelivr.net/npm/onelobby@0.1.0/dist/onelobby.global.min.js (CDNs pick it up within minutes).

## Fallback: name taken -> `one-lobby`

1. In `package.json`, set `"name": "one-lobby"`.
2. In `README.md`, replace `onelobby` with `one-lobby` in the install line, imports and CDN URLs (not the file names
   `dist/onelobby.*`, which stay).
3. Optional: `LIB_NAME` in `src/onelobby.ts` is only sent to the lobby server as an informational client name;
   `prepublish-check` prints a note if it differs, which is fine.
4. `cd clients/js && npm install` (refreshes the workspace name in `package-lock.json`), then the Publish steps above.
5. Update the docs that say `npm install onelobby` and the unpkg/jsdelivr URLs (root README, AGENTS.md, llms.txt,
   `docs/recipes/js-web.md`, `docs/no-code.md`, `examples/drop-in/index.html`).

## Later releases

Bump `version` in `package.json` **and** `LIB_VERSION` in `src/onelobby.ts` (prepublish-check fails if they differ),
commit, then `npm publish`. The script-tag URL `.../onelobby@0.1/...` follows patch releases automatically. The
deprecated `Keepalive` / `KeepaliveError` aliases can be dropped in the next minor release once Ant Arena imports
`OneLobby`.
