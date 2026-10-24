// Drop-in for the Keepalive repo: conformance/consumers/ant-arena.mjs
// Runs Ant Arena's contract test against THIS Keepalive checkout, so a Keepalive change that breaks a real
// game fails here before it ships. Ant Arena is found via ANT_ARENA_DIR, or a sibling parkwow/ants folder.
// Skips (exit 0) when Ant Arena isn't on this machine, so it never blocks Keepalive-only setups.
//   node conformance/consumers/ant-arena.mjs
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const keepaliveDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const candidates = [process.env.ANT_ARENA_DIR, join(keepaliveDir, '..', 'parkwow', 'ants')].filter(Boolean);
const antArena = candidates.find(d => existsSync(join(d, 'tests', 'keepalive-contract.test.js')));
if (!antArena) {
  console.log('ant-arena consumer: skipped (set ANT_ARENA_DIR to an Ant Arena checkout\'s ants/ folder)');
  process.exit(0);
}
if (!existsSync(join(antArena, 'node_modules'))) spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: antArena, stdio: 'inherit', shell: true });
const r = spawnSync(process.execPath, ['tests/keepalive-contract.test.js'], { cwd: antArena, stdio: 'inherit', env: { ...process.env, KEEPALIVE_DIR: keepaliveDir } });
process.exit(r.status ?? 1);
