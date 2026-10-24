# OneLobby "friendly" round: handoff (2026-10-24)

**Goal (Parker):** put OneLobby on npm, give it a quickstart, make it friendlier for players, and make it usable by any non-developer.

## Where things are

- **Branch:** `friendly/integration`, in the worktree `C:\Users\parke\ClaudeCode\keepalive-friendly-integration`.
  - It is NOT yet merged into `dev`.
  - Keepalive has no git remote yet.
- **Lane branches:** `friendly/{api,npm,dropin,docs}`, each in `C:\Users\parke\ClaudeCode\keepalive-friendly-<lane>`. All are merged into the integration branch, so their worktrees can be deleted after `dev` has it.
- **Commits on top of `dev` (`a8c34f7`):**
  - lane merges;
  - `37d6a0c`: docs and exports;
  - `bbbf7e0` and `4ab0194`: drop-in element merged and wired in;
  - `46354c1`: Keepalive renamed to OneLobby;
  - `8d3bdfd`: fixes from the non-developer test.

## What was built

- **api:**
  - `describeError(err)` gives plain-language `{code, message, hint}`.
  - `shareUrl(code)` and `codeFromUrl()` make and read `?join=7HQ-4K2` links.
  - `readyTimeoutMs` (15 s) makes a joiner fail with `ice_failed` instead of hanging. When the server offers a relay, it retries once relay-only first.
  - `rememberSeat`, `resume()` and `rememberedCode` let a page reload rejoin its seat.
  - Lobbies are `unlisted` by default, and unnamed players show as "Player N".
  - Test hooks moved under `advanced`; the old top-level keys still work.
- **npm:**
  - The package is `onelobby` (unscoped; free on 2026-10-24).
  - Bundles:
    - `dist/onelobby.global(.min).js` for a script tag (sets `window.OneLobby`);
    - `onelobby.bundle.mjs` for ESM imports;
    - sourcemaps for both.
  - The root export is small; internals moved to `onelobby/internals`.
  - Tests check what goes into the package and that the bundles load. The steps are in `clients/js/packages/client/PUBLISHING.md`.
- **dropin:**
  - The `<one-lobby>` element (`src/ui`, export `onelobby/ui`, also inside the global bundle).
  - It has Host, join by code, a big code with copy-code and copy-invite-link buttons, a player list, Start, plain status text, and friendly errors with retry.
  - `el.shared.set/add/get` is host-authoritative shared state.
  - Fallback text inside the tag shows if the script fails to load.
  - Also: `examples/drop-in/` and `docs/no-code.md`.
- **docs:**
  - The README has three paths: "I don't code", a quickstart, and "run a server".
  - `deploy/EASY_SERVER.md` and `render.yaml` add a one-click Render deploy on the free tier. The catch: a free server sleeps after 15 idle minutes, and the first player then waits about a minute.
  - The server honors `PORT`, and `.dockerignore` was added.
  - Stale docs were fixed: early sends are queued, not dropped, and `peerReady`/`ready` are documented.
- **Rename:**
  - Keepalive became OneLobby in the JS, the C# server (`OneLobby.Server`), Godot and the docs.
  - Kept for compatibility:
    - deprecated JS aliases `Keepalive` and `KeepaliveError` (in `src/deprecated.ts`), which Ant Arena still uses;
    - the server reads `KEEPALIVE_*` env vars when `ONELOBBY_*` is unset.
  - The wire protocol (`lk1`) is unchanged.
  - The 43 remaining "keepalive" hits are deliberate: the aliases, the env fallback, frozen test vectors, and WebSocket keep-alive.

## Verified (at 8d3bdfd)

| Check | Result |
|---|---|
| Typecheck and build | Pass |
| Vitest | 203 passed, 1 skipped (the real-server test) |
| `npm run e2e:dropin` | 20/20 (C# server plus headless Edge) |
| `check-snippets` | 10/10 |
| Peer conformance | 28/28 for JS and for .NET |
| Server conformance | 54 passed, 2 skipped |
| `dotnet test` | server 52/52, .NET client 58/58 |
| Godot library and demo | Build |
| Ant Arena contract | Passes |
| Docker image | Builds and serves `/healthz` on `PORT` |

**Not run:** the Lowkey codec tests, which need `integrations/lowkey/build-sim.sh` first (this was already the case before this round), and a real deploy on Render.

**Non-developer test ("Dana"):** a fresh agent played a hobbyist who has never coded. Using only README → `docs/no-code.md` → `deploy/EASY_SERVER.md`, it built a working two-browser Tug of War. All 8 doc problems it hit are fixed in `8d3bdfd`. Its page and screenshots: `C:\Users\parke\.claude\jobs\8b49e3b9\tmp\dana` (a temp folder, deleted with the job).

## Next steps

**For Parker** (the non-developer path stays blocked until 1 and 2 are done):
1. Approve merging `friendly/integration` into `dev`. Other sessions use the `dev` checkout, so coordinate.
2. Create the public GitHub repo `ParkerTonra/onelobby` and push to it. The Deploy button, clone lines and package `repository` all point there.
3. Run `npm login`, then `npm publish` from `clients/js/packages/client`, following `PUBLISHING.md`. Every CDN link is pinned to `onelobby@0.1.0`.
4. Make a Render account, click Deploy once, and check that `/healthz` works.
5. Optional: rename the folder `C:\Users\parke\ClaudeCode\keepalive` to `onelobby`, then set `KEEPALIVE_DIR` for Ant Arena's `keepalive-sync.js`.
6. Optional: run a public lobby server for everyone, so non-developers don't need step 4 at all.

**For Claude, after the merge:**
1. Switch Ant Arena (parkwow `ants/`) to `OneLobby`:
   - import `OneLobby`;
   - use `describeError` in `ka-boot.mjs`;
   - drop the 300 ms join-resend workaround in `public/net/keepalive.mjs` (sends are now queued until the link opens);
   - optionally rename the `keepalive*` files and env names, then remove the deprecated aliases in a later version.
2. Once the package is published, re-run the Dana test against the real CDN and the Render server.
3. Delete the lane worktrees and branches once `dev` has everything.
