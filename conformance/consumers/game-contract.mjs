// Runs a real game's OneLobby contract test against THIS OneLobby checkout, so a OneLobby change that breaks a game
// fails here before it ships. Point ONELOBBY_GAME_DIR at a game folder that depends on "onelobby" and has
// tests/onelobby.test.js. The game is copied to a scratch folder (never touched in place), this checkout's client
// package is built and linked in as node_modules/onelobby, and the test runs there.
// Skips (exit 0) when ONELOBBY_GAME_DIR is unset, so it never blocks OneLobby-only setups.
//   ONELOBBY_GAME_DIR=path/to/game node conformance/consumers/game-contract.mjs
import { existsSync, cpSync, mkdtempSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const onelobbyDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkgDir = join(onelobbyDir, 'clients', 'js', 'packages', 'client');
const TEST = join('tests', 'onelobby.test.js');
const game = process.env.ONELOBBY_GAME_DIR;
if (!game || !existsSync(join(game, TEST))) {
  console.log('game-contract consumer: skipped (set ONELOBBY_GAME_DIR to a game folder with tests/onelobby.test.js)');
  process.exit(0);
}
const npm = (args, cwd) => spawnSync('npm', args, { cwd, stdio: 'inherit', shell: true }).status ?? 1;
if (!existsSync(join(game, 'node_modules')) && npm(['install', '--no-audit', '--no-fund'], game) !== 0) process.exit(1);
if (npm(['run', 'build'], pkgDir) !== 0) process.exit(1);

// Copy the game without its installed onelobby, then link this checkout's package in its place.
const scratch = mkdtempSync(join(tmpdir(), 'onelobby-game-'));
const skip = new Set(['.git', join('node_modules', 'onelobby')]);
let status = 1;
try {
  cpSync(game, scratch, { recursive: true, filter: src => !skip.has(relative(game, src)) });
  mkdirSync(join(scratch, 'node_modules'), { recursive: true });
  symlinkSync(pkgDir, join(scratch, 'node_modules', 'onelobby'), 'junction');
  status = spawnSync(process.execPath, [TEST], { cwd: scratch, stdio: 'inherit' }).status ?? 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(status);
