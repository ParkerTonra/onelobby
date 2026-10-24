// Drop-in for the OneLobby repo: conformance/consumers/ant-arena.mjs
// Runs Ant Arena's OneLobby contract test (tests/onelobby.test.js: real hostDirect, joiners by address and by code,
// the game page on the host's port) against THIS OneLobby checkout, so a OneLobby change that breaks a real game
// fails here before it ships. Ant Arena is found via ANT_ARENA_DIR (its ants/ folder), or a sibling parkwow/ants.
// Ant Arena's sync rewrites its tracked vendor/onelobby, so the test runs in a scratch copy, never in place.
// Skips (exit 0) when Ant Arena isn't on this machine, so it never blocks OneLobby-only setups.
//   node conformance/consumers/ant-arena.mjs
import { existsSync, cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const onelobbyDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST = join('tests', 'onelobby.test.js');
const candidates = [process.env.ANT_ARENA_DIR, join(onelobbyDir, '..', 'parkwow', 'ants')].filter(Boolean);
const antArena = candidates.find(d => existsSync(join(d, TEST)) && existsSync(join(d, 'onelobby-sync.js')));
if (!antArena) {
  console.log('ant-arena consumer: skipped (set ANT_ARENA_DIR to an Ant Arena checkout\'s ants/ folder)');
  process.exit(0);
}
if (!existsSync(join(antArena, 'node_modules'))) spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: antArena, stdio: 'inherit', shell: true });

// Copy everything but the vendored OneLobby (and its installed link), sync this checkout into the copy, link it in.
const scratch = mkdtempSync(join(tmpdir(), 'ant-arena-'));
const skip = new Set(['vendor', join('node_modules', 'onelobby'), '.git']);
const run = (args, opts) => spawnSync(process.execPath, args, { cwd: scratch, stdio: 'inherit', ...opts }).status ?? 1;
let status = 1;
try {
  cpSync(antArena, scratch, { recursive: true, filter: src => !skip.has(relative(antArena, src)) });
  status = run(['onelobby-sync.js'], { env: { ...process.env, ONELOBBY_DIR: onelobbyDir } });
  if (status === 0) {
    symlinkSync(join(scratch, 'vendor', 'onelobby'), join(scratch, 'node_modules', 'onelobby'), 'junction');
    status = run([TEST]);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(status);
