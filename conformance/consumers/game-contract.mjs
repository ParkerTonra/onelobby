// Runs a real game's OneLobby contract test against THIS OneLobby checkout, so a OneLobby change that breaks a game
// fails here before it ships. Point ONELOBBY_GAME_DIR at a game folder that has tests/onelobby.test.js and
// onelobby-sync.js (a script that builds ONELOBBY_DIR's client package and vendors it into the game's vendor/onelobby,
// installed as "onelobby": "file:vendor/onelobby"). The sync rewrites the game's tracked vendor/, so the test runs in
// a scratch copy, never in place. Skips (exit 0) when ONELOBBY_GAME_DIR is unset, so it never blocks OneLobby-only setups.
//   ONELOBBY_GAME_DIR=path/to/game node conformance/consumers/game-contract.mjs
import { existsSync, cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const onelobbyDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST = join('tests', 'onelobby.test.js');
const game = process.env.ONELOBBY_GAME_DIR;
if (!game || !existsSync(join(game, TEST)) || !existsSync(join(game, 'onelobby-sync.js'))) {
  console.log('game-contract consumer: skipped (set ONELOBBY_GAME_DIR to a game folder with tests/onelobby.test.js and onelobby-sync.js)');
  process.exit(0);
}
if (!existsSync(join(game, 'node_modules'))) spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: game, stdio: 'inherit', shell: true });

// Copy everything but the vendored OneLobby (and its installed link), sync this checkout into the copy, link it in.
const scratch = mkdtempSync(join(tmpdir(), 'onelobby-game-'));
const skip = new Set(['vendor', join('node_modules', 'onelobby'), '.git']);
const run = (args, opts) => spawnSync(process.execPath, args, { cwd: scratch, stdio: 'inherit', ...opts }).status ?? 1;
let status = 1;
try {
  cpSync(game, scratch, { recursive: true, filter: src => !skip.has(relative(game, src)) });
  status = run(['onelobby-sync.js'], { env: { ...process.env, ONELOBBY_DIR: onelobbyDir } });
  if (status === 0) {
    symlinkSync(join(scratch, 'vendor', 'onelobby'), join(scratch, 'node_modules', 'onelobby'), 'junction');
    status = run([TEST]);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(status);
