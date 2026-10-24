# Publishing @keepalive/client to npm

Not shipped in the tarball (only `dist/`, `README.md`, `LICENSE`, `package.json` are). Version stays `0.1.0` until the
first publish.

## Names (checked 2026-10-24)

| Name | Status |
|---|---|
| `keepalive` | taken (unrelated package) |
| `@keepalive/client` | unpublished; needs the npm **organization** `keepalive`, which may already belong to someone |
| `keepalive-lobby` | free: the fallback |
| `keepalive-client` | free: second fallback |

## Once: before the first publish

1. Replace the placeholders. `package.json` (`homepage`, `repository.url`, `bugs.url`) and `README.md` (two docs links)
   contain `REPLACE-ME.example`. Put in the real repo URL (the docs mention `https://github.com/ParkerTonra/keepalive`),
   or delete those three package.json fields if there is no public repo. `prepublishOnly` refuses to publish while any
   `REPLACE-ME` is left.
2. Log in: `npm login` (your account; turn on 2FA, npm asks for the code on publish).
3. Claim the scope: go to https://www.npmjs.com/org/create and create the organization `keepalive` (the free plan is
   enough for public packages). If npm says the name is taken, use the fallback below.

## Publish

```
cd clients/js
npm ci
cd packages/client
npm publish --dry-run      # runs prepublishOnly: typecheck, build, tests, metadata check; prints the file list
npm publish                # access is public via publishConfig
```

Then check: https://www.npmjs.com/package/@keepalive/client and
https://cdn.jsdelivr.net/npm/@keepalive/client@0.1.0/dist/keepalive.global.min.js (CDNs pick it up within minutes).

## Fallback: scope taken -> `keepalive-lobby`

1. In `package.json`, set `"name": "keepalive-lobby"`.
2. In `README.md`, replace `@keepalive/client` with `keepalive-lobby` (install line, imports, both CDN URLs).
3. Optional: `LIB_NAME` in `src/keepalive.ts` is only sent to the lobby server as an informational client name;
   `prepublish-check` prints a note if it differs, which is fine.
4. `cd clients/js && npm install` (refreshes the workspace name in `package-lock.json`), then the Publish steps above.
5. Tell the docs that `npm install @keepalive/client` became `npm install keepalive-lobby` (root README, `docs/recipes/js-web.md`).

## Later releases

Bump `version` in `package.json` **and** `LIB_VERSION` in `src/keepalive.ts` (prepublish-check fails if they differ),
commit, then `npm publish`. The script-tag URL `.../@keepalive/client@0.1/...` follows patch releases automatically.
